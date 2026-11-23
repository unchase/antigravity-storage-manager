
import * as os from 'os';

import { WindowsProcessDetector } from './windowsProcessDetector';
import { UnixProcessDetector } from './unixProcessDetector';
import { IPlatformStrategy } from './types';

// const execAsync = promisify(cp.exec);

export class PlatformDetector {
    private platform: NodeJS.Platform;
    private strategy: IPlatformStrategy;

    constructor() {
        this.platform = os.platform();
        if (this.platform === 'win32') {
            this.strategy = new WindowsProcessDetector();
        } else {
            this.strategy = new UnixProcessDetector(this.platform);
        }
    }

    getPlatformName(): string {
        return this.platform === 'win32' ? 'Windows' : 'Unix-like';
    }

    getProcessName(): string {
        const arch = os.arch();
        if (this.platform === 'win32') {
            // ARM64 Windows uses native language_server_windows_arm.exe
            return arch === 'arm64' ? 'language_server_windows_arm.exe' : 'language_server_windows_x64.exe';
        } else if (this.platform === 'darwin') {
            return `language_server_macos${arch === 'arm64' ? '_arm' : ''}`;
        } else {
            return `language_server_linux${arch === 'arm64' ? '_arm' : '_x64'}`;
        }
    }

    /**
     * Returns all possible process names for the current platform (primary + fallback).
     * Includes legacy architecture-specific language_server binaries, unified language_server,
     * and the Antigravity 2.0 / CLI hub process (agy).
     */
    getProcessNames(): string[] {
        const arch = os.arch();
        if (this.platform === 'win32') {
            if (arch === 'arm64') {
                // ARM64 primary (arm.exe), arm64.exe alias fallback, x64 under emulation, unified language_server, and agy hub
                return [
                    'language_server_windows_arm.exe',
                    'language_server_windows_arm64.exe',
                    'language_server_windows_x64.exe',
                    'language_server.exe',
                    'agy.exe'
                ];
            }
            return ['language_server_windows_x64.exe', 'language_server.exe', 'agy.exe'];
        } else if (this.platform === 'darwin') {
            if (arch === 'arm64') {
                return ['language_server_macos_arm', 'language_server_macos', 'language_server', 'agy'];
            }
            return ['language_server_macos', 'language_server', 'agy'];
        } else {
            if (arch === 'arm64') {
                return ['language_server_linux_arm', 'language_server_linux_x64', 'language_server', 'agy'];
            }
            return ['language_server_linux_x64', 'language_server', 'agy'];
        }
    }

    getStrategy(): IPlatformStrategy {
        return this.strategy;
    }
}
