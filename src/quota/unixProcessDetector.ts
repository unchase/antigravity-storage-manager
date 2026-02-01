
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { IPlatformStrategy } from './types';

const execAsync = promisify(exec);

import { LocalizationManager } from '../l10n/localizationManager';

export class UnixProcessDetector implements IPlatformStrategy {
    private platform: NodeJS.Platform;
    private availablePortCommand: 'lsof' | 'ss' | 'netstat' | null = null;

    constructor(platform: NodeJS.Platform) {
        this.platform = platform;
        // Check for 'ss' availability on Linux as it is preferred/default on modern distros
        if (platform === 'linux') {
            this.commandExists('ss').then(exists => {
                if (exists) this.availablePortCommand = 'ss';
            });
        }
    }

    private async commandExists(command: string): Promise<boolean> {
        try {
            await execAsync(`which ${command}`, { timeout: 3000 });
            return true;
        } catch {
            return false;
        }
    }

    async ensurePortCommandAvailable(): Promise<void> {
        if (this.availablePortCommand) {
            return;
        }

        const commands = ['lsof', 'ss', 'netstat'] as const;
        const available: string[] = [];

        for (const cmd of commands) {
            if (await this.commandExists(cmd)) {
                available.push(cmd);
                if (!this.availablePortCommand) {
                    this.availablePortCommand = cmd;
                }
            }
        }

        if (!this.availablePortCommand) {
            const lm = LocalizationManager.getInstance();
            const message = this.platform === 'darwin'
                ? lm.t('Port detection command (lsof) is required but missing.')
                : lm.t('Port detection command (lsof/ss/netstat) is required but missing.');

            vscode.window.showErrorMessage(message, { modal: false });
            throw new Error('No port detection command available (lsof/ss/netstat)');
        }
    }

    private isAntigravityProcess(commandLine: string): boolean {
        const lowerCmd = commandLine.toLowerCase();
        if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
            return true;
        }
        if (lowerCmd.includes('/antigravity/') || lowerCmd.includes('\\antigravity\\')) {
            return true;
        }
        return false;
    }

    getProcessListCommand(processName: string): string {
        return `ps -ww -eo pid,ppid,args | grep "${processName}" | grep -v grep | grep -v graftcp`;
    }

    parseProcessInfo(stdout: string): {
        pid: number;
        extensionPort: number;
        csrfToken: string;
    } | null {
        if (!stdout || stdout.trim().length === 0) {
            return null;
        }

        const lines = stdout.trim().split('\n');
        const currentPid = process.pid;
        const candidates: Array<{ pid: number; ppid: number; extensionPort: number; csrfToken: string }> = [];

        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3) {
                continue;
            }

            const pid = parseInt(parts[0], 10);
            const ppid = parseInt(parts[1], 10);

            const cmd = parts.slice(2).join(' ');

            if (isNaN(pid) || isNaN(ppid)) {
                continue;
            }

            const executable = parts[2];
            if (executable.includes('graftcp')) {
                continue;
            }

            const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/);
            const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);

            if (tokenMatch && tokenMatch[1] && this.isAntigravityProcess(cmd)) {
                const extensionPort = portMatch && portMatch[1] ? parseInt(portMatch[1], 10) : 0;
                const csrfToken = tokenMatch[1];
                candidates.push({ pid, ppid, extensionPort, csrfToken });
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        const child = candidates.find(c => c.ppid === currentPid);
        if (child) {
            return child;
        }

        return candidates[0];
    }

    getPortListCommand(pid: number): string {
        switch (this.availablePortCommand) {
            case 'lsof':
                return `lsof -Pan -p ${pid} -i`;
            case 'ss':
                return `ss -tlnp 2>/dev/null | grep "pid=${pid},"`;
            case 'netstat':
                return `netstat -tulpn 2>/dev/null | grep ${pid}`;
            default:
                return `lsof -Pan -p ${pid} -i 2>/dev/null || ss -tlnp 2>/dev/null | grep "pid=${pid}," || netstat -tulpn 2>/dev/null | grep ${pid}`;
        }
    }

    parseListeningPorts(stdout: string, _pid: number): number[] {
        const ports: number[] = [];

        if (!stdout || stdout.trim().length === 0) {
            return ports;
        }

        const lines = stdout.trim().split('\n');

        for (const line of lines) {
            const lsofMatch = line.match(/127\.0\.0\.1:(\d+).*\(LISTEN\)/);
            if (lsofMatch && lsofMatch[1]) {
                const port = parseInt(lsofMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            const ssMatch = line.match(/LISTEN\s+\d+\s+\d+\s+(?:127\.0\.0\.1|\*):(\d+)/);
            if (ssMatch && ssMatch[1]) {
                const port = parseInt(ssMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            const netstatMatch = line.match(/127\.0\.0\.1:(\d+).*LISTEN/);
            if (netstatMatch && netstatMatch[1]) {
                const port = parseInt(netstatMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
                continue;
            }

            const localhostMatch = line.match(/localhost:(\d+).*\(LISTEN\)|localhost:(\d+).*LISTEN/);
            if (localhostMatch) {
                const port = parseInt(localhostMatch[1] || localhostMatch[2], 10);
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
        const processName = this.platform === 'darwin'
            ? 'language_server_macos'
            : 'language_server_linux';

        return {
            processNotFound: 'language_server process not found',
            commandNotAvailable: 'ps/lsof commands are unavailable; please check the system environment',
            requirements: [
                'Antigravity is running',
                `${processName} process is running`,
                'The system has permission to execute ps and lsof commands'
            ]
        };
    }
}
