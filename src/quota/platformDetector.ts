
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
            return 'language_server_windows_x64.exe';
        } else if (this.platform === 'darwin') {
            return `language_server_macos${arch === 'arm64' ? '_arm' : ''}`;
        } else {
            return `language_server_linux${arch === 'arm64' ? '_arm' : '_x64'}`;
        }
    }

    getStrategy(): IPlatformStrategy {
        return this.strategy;
    }
}
