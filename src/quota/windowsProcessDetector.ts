
import { IPlatformStrategy } from './types';
import { SafePowerShellPath } from './safePowerShellPath';
import { LocalizationManager } from '../l10n/localizationManager';

export class WindowsProcessDetector implements IPlatformStrategy {
    private static readonly SYSTEM_ROOT: string = process.env.SystemRoot || 'C:\\Windows';
    private static readonly WMIC_PATH: string = `"${WindowsProcessDetector.SYSTEM_ROOT}\\System32\\wbem\\wmic.exe"`;
    private static readonly NETSTAT_PATH: string = `"${WindowsProcessDetector.SYSTEM_ROOT}\\System32\\netstat.exe"`;
    private static readonly FINDSTR_PATH: string = `"${WindowsProcessDetector.SYSTEM_ROOT}\\System32\\findstr.exe"`;

    private usePowerShell: boolean = true;

    setUsePowerShell(value: boolean): void {
        this.usePowerShell = value;
    }

    isUsingPowerShell(): boolean {
        return this.usePowerShell;
    }

    private buildPowerShellProcessScript(procNameNoExt: string): string {
        return `$procs = @(Get-Process -Name '${procNameNoExt}' -ErrorAction SilentlyContinue); if ($procs.Count -gt 0) { $result = @(); foreach ($p in $procs) { $cmd = $null; try { $wmi = [System.Management.ManagementObject]::new("Win32_Process.Handle='$($p.Id)'"); $cmd = $wmi['CommandLine'] } catch { try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine } catch {} }; if ($cmd) { $result += @{ProcessId=$p.Id; CommandLine=$cmd} } }; if ($result.Count -gt 0) { $result | ConvertTo-Json } else { Write-Output '[]' } } else { Write-Output '[]' }`;
    }

    getProcessListCommand(processName: string): string {
        if (this.usePowerShell) {
            const psPath = SafePowerShellPath.getSafePath();
            // Two-step approach: Get-Process (fast, no WMI) + ManagementObject (direct WMI by PID, with CIM fallback)
            const procNameNoExt = processName.replace(/\.exe$/i, '');
            const script = this.buildPowerShellProcessScript(procNameNoExt);
            const encoded = Buffer.from(script, 'utf16le').toString('base64');
            return `${psPath} -NoProfile -EncodedCommand ${encoded}`;
        } else {
            return `${WindowsProcessDetector.WMIC_PATH} process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
        }
    }

    getProcessListCommandParts(processName: string): { file: string; args: string[] } | undefined {
        if (this.usePowerShell) {
            // Direct call via execFile — bypasses cmd.exe entirely, no quoting issues
            const psPath = SafePowerShellPath.getSafePath().replace(/"/g, '');
            const procNameNoExt = processName.replace(/\.exe$/i, '');
            const script = this.buildPowerShellProcessScript(procNameNoExt);
            return { file: psPath, args: ['-NoProfile', '-Command', script] };
        }
        return undefined;
    }

    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        if (/--app_data_dir[=\s]+"?[^"\s]*antigravity(?:-ide)?/i.test(commandLine)) {
            return true;
        }
        if (
            lowerCmd.includes('\\antigravity\\') ||
            lowerCmd.includes('/antigravity/') ||
            lowerCmd.includes('\\antigravity ide\\') ||
            lowerCmd.includes('/antigravity ide/') ||
            lowerCmd.includes('antigravity-ide')
        ) {
            return true;
        }
        // Antigravity 2.0 / CLI hub process: agy.exe --hub ...
        if (/(?:^|[\\/\s"])agy(?:\.exe)?(?:["\s]|$)/i.test(commandLine) && /--hub(?:[-_]port)?\b/i.test(commandLine)) {
            return true;
        }
        return false;
    }

    private extractCandidate(pid: number, commandLine: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
        isHub: boolean;
    } | null {
        if (!pid || !this.isAntigravityProcess(commandLine)) {
            return null;
        }

        const portMatch = commandLine.match(/--(?:extension_server_port|hub[-_]port)[=\s]+(\d+)/i);
        const tokenMatch = commandLine.match(/--csrf[_-]token[=\s]+"?([^\s"]+)"?/i);
        const isHub = /--hub\b/i.test(commandLine);
        const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
        const csrfToken = tokenMatch && tokenMatch[1] ? tokenMatch[1] : '';

        // Accept if process has CSRF token, or is an agy --hub / server process with a port
        if (!csrfToken && !isHub && extensionPort === 0) {
            return null;
        }

        return { pid, extensionPort, csrfToken, isHub };
    }

    private pickBestCandidate(candidates: Array<{
        pid: number;
        extensionPort: number;
        csrfToken: string;
        isHub: boolean;
    }>): { pid: number; extensionPort: number; csrfToken: string } | null {
        if (candidates.length === 0) {
            return null;
        }

        const score = (c: { extensionPort: number; csrfToken: string; isHub: boolean }): number => {
            let s = 0;
            if (c.csrfToken) s += 4;
            if (c.isHub) s += 2;
            if (c.extensionPort > 0) s += 1;
            return s;
        };

        const best = [...candidates].sort((a, b) => score(b) - score(a))[0];
        return { pid: best.pid, extensionPort: best.extensionPort, csrfToken: best.csrfToken };
    }

    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        if (this.usePowerShell || stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
            try {
                const parsed = JSON.parse(stdout.trim());
                const items = Array.isArray(parsed) ? parsed : [parsed];
                const candidates: Array<{ pid: number; extensionPort: number; csrfToken: string; isHub: boolean }> = [];

                for (const item of items) {
                    if (!item?.CommandLine || !item?.ProcessId) continue;
                    const candidate = this.extractCandidate(Number(item.ProcessId), String(item.CommandLine));
                    if (candidate) {
                        candidates.push(candidate);
                    }
                }

                return this.pickBestCandidate(candidates);
            } catch (e) {
                console.debug('WindowsDetector', `JSON parse failed, trying WMIC format: ${e}`);
            }
        }

        const blocks = stdout.split(/\n\s*\n/).filter(block => block.trim().length > 0);
        const candidates: Array<{ pid: number; extensionPort: number; csrfToken: string; isHub: boolean }> = [];

        for (const block of blocks) {
            const pidMatch = block.match(/ProcessId=(\d+)/);
            const commandLineMatch = block.match(/CommandLine=(.+)/);

            if (!pidMatch || !commandLineMatch) {
                continue;
            }

            const candidate = this.extractCandidate(parseInt(pidMatch[1], 10), commandLineMatch[1].trim());
            if (candidate) {
                candidates.push(candidate);
            }
        }

        return this.pickBestCandidate(candidates);
    }

    async ensurePortCommandAvailable(): Promise<void> {
        return;
    }

    getPortListCommand(_pid: number): string {
        return `${WindowsProcessDetector.NETSTAT_PATH} -ano`;
    }

    getFallbackPortListCommand(pid: number): string {
        const netstat = WindowsProcessDetector.NETSTAT_PATH;
        const findstr = WindowsProcessDetector.FINDSTR_PATH;
        return `${netstat} -ano | ${findstr} "${pid}" | ${findstr} "LISTENING"`;
    }

    parseListeningPorts(stdout: string, targetPid: number): number[] {
        const ports: number[] = [];
        // Regex to match lines like:
        //   TCP    127.0.0.1:51212        0.0.0.0:0              LISTENING       25324
        // Group 1: IP:Port, Group 2: PID (at end of line)

        const lines = stdout.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Check if line contains LISTENING (case insensitive)
            if (!/LISTENING/i.test(trimmed)) continue;

            // Extract PID from end of line
            const pidMatch = trimmed.match(/\s+(\d+)$/);
            if (!pidMatch) continue;

            const pid = parseInt(pidMatch[1], 10);
            if (pid !== targetPid) continue;

            // Extract Port
            const portMatch = trimmed.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?]):(\d+)/);
            if (portMatch && portMatch[1]) {
                const port = parseInt(portMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
        }

        return ports.sort((a, b) => a - b);
    }

    getErrorMessages(): {
        processNotFound: string;
        commandNotAvailable: string;
        requirements: string[];
    } {
        const lm = LocalizationManager.getInstance();
        return {
            processNotFound: lm.t('language_server process not found'),
            commandNotAvailable: this.usePowerShell
                ? lm.t('PowerShell command failed; please check system permissions')
                : lm.t('wmic/PowerShell command unavailable; please check the system environment'),
            requirements: [
                lm.t('Antigravity is running'),
                lm.t('language_server process is running'),
                this.usePowerShell
                    ? lm.t('The system has permission to run PowerShell and netstat commands')
                    : lm.t('The system has permission to run wmic/PowerShell and netstat commands (auto-fallback supported)')
            ]
        };
    }
}
