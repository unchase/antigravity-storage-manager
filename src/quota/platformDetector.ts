
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
            // ARM64 Windows may run x64 version via emulation or native ARM version
            return arch === 'arm64' ? 'language_server_windows_arm64.exe' : 'language_server_windows_x64.exe';
        } else if (this.platform === 'darwin') {
            return `language_server_macos${arch === 'arm64' ? '_arm' : ''}`;
        } else {
            return `language_server_linux${arch === 'arm64' ? '_arm' : '_x64'}`;
        }
    }

    /**
     * Returns all possible process names for the current platform (primary + fallback).
     * Useful for ARM64 Windows where x64 may run under emulation.
     */
    getProcessNames(): string[] {
        const arch = os.arch();
        if (this.platform === 'win32') {
            if (arch === 'arm64') {
                // ARM64 primary, x64 fallback (may run under emulation)
                return ['language_server_windows_arm64.exe', 'language_server_windows_x64.exe'];
            }
            return ['language_server_windows_x64.exe'];
        } else if (this.platform === 'darwin') {
            if (arch === 'arm64') {
                return ['language_server_macos_arm', 'language_server_macos'];
            }
            return ['language_server_macos'];
        } else {
            if (arch === 'arm64') {
                return ['language_server_linux_arm', 'language_server_linux_x64'];
            }
            return ['language_server_linux_x64'];
        }
    }

    getStrategy(): IPlatformStrategy {
        return this.strategy;
    }
}
