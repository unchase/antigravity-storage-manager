
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

    getProcessListCommand(processName: string): string {
        if (this.usePowerShell) {
            const psPath = SafePowerShellPath.getSafePath();
            return `${psPath} -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
        } else {
            return `${WindowsProcessDetector.WMIC_PATH} process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
        }
    }

    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }
        if (lowerCmd.includes('\\antigravity\\') || lowerCmd.includes('/antigravity/')) {
            return true;
        }
        return false;
    }

    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        if (this.usePowerShell || stdout.trim().startsWith('{') || stdout.trim().startsWith('[')) {
            try {
                let data = JSON.parse(stdout.trim());
                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        return null;
                    }
                    const antigravityProcesses = data.filter((item: any) =>
                        item.CommandLine && this.isAntigravityProcess(item.CommandLine)
                    );
                    if (antigravityProcesses.length === 0) {
                        return null;
                    }
                    data = antigravityProcesses[0];
                } else {
                    if (!data.CommandLine || !this.isAntigravityProcess(data.CommandLine)) {
                        return null;
                    }
                }

                const commandLine = data.CommandLine || '';
                const pid = data.ProcessId;

                if (!pid) {
                    return null;
                }

                const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
                const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

                if (!tokenMatch || !tokenMatch[1]) {
                    return null;
                }

                const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
                const csrfToken = tokenMatch[1];

                return { pid, extensionPort, csrfToken };
            } catch (e) {
                console.debug('WindowsDetector', `JSON parse failed, trying WMIC format: ${e}`);
            }
        }

        const blocks = stdout.split(/\n\s*\n/).filter(block => block.trim().length > 0);

        const candidates: Array<{ pid: number; extensionPort: number; csrfToken: string }> = [];

        for (const block of blocks) {
            const pidMatch = block.match(/ProcessId=(\d+)/);
            const commandLineMatch = block.match(/CommandLine=(.+)/);

            if (!pidMatch || !commandLineMatch) {
                continue;
            }

            const commandLine = commandLineMatch[1].trim();

            if (!this.isAntigravityProcess(commandLine)) {
                continue;
            }

            const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

            if (!tokenMatch || !tokenMatch[1]) {
                continue;
            }

            const pid = parseInt(pidMatch[1], 10);
            const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
            const csrfToken = tokenMatch[1];

            candidates.push({ pid, extensionPort, csrfToken });
        }

        if (candidates.length === 0) {
            return null;
        }

        return candidates[0];
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
                lm.t('language_server_windows_x64.exe process is running'),
                this.usePowerShell
                    ? lm.t('The system has permission to run PowerShell and netstat commands')
                    : lm.t('The system has permission to run wmic/PowerShell and netstat commands (auto-fallback supported)')
            ]
        };
    }
}
