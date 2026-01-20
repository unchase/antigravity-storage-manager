
import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import { PlatformDetector } from './platformDetector';
import { IPlatformStrategy } from './types';
import { versionInfo } from './versionInfo';

const execAsync = promisify(exec);

export interface AntigravityProcessInfo {
    extensionPort: number;
    connectPort: number;
    csrfToken: string;
}

export class ProcessPortDetector {
    private platformDetector: PlatformDetector;
    private platformStrategy: IPlatformStrategy;
    private processName: string;

    constructor() {
        this.platformDetector = new PlatformDetector();
        this.platformStrategy = this.platformDetector.getStrategy();
        this.processName = this.platformDetector.getProcessName();
    }

    async detectProcessInfo(maxRetries: number = 3, retryDelay: number = 2000): Promise<AntigravityProcessInfo | null> {
        const platformName = this.platformDetector.getPlatformName();

        console.log('PortDetector', `Starting port detection on ${platformName}, processName=${this.processName}`);

        if (platformName === 'Windows') {
            const windowsStrategy = this.platformStrategy as any;
            const mode = windowsStrategy.isUsingPowerShell?.() ? 'PowerShell' : 'WMIC';
            console.log('PortDetector', `Windows detection mode: ${mode}`);
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log('PortDetector', `Attempt ${attempt}/${maxRetries}: Detecting Antigravity process...`);

                const command = this.platformStrategy.getProcessListCommand(this.processName);
                const { stdout } = await execAsync(command, { timeout: 15000 });

                const processInfo = this.platformStrategy.parseProcessInfo(stdout);

                if (!processInfo) {
                    throw new Error('language_server process not found');
                }

                const { pid, extensionPort, csrfToken } = processInfo;

                if (!csrfToken) {
                    console.warn('PortDetector', `Attempt ${attempt}: CSRF token missing`);
                    throw new Error('CSRF token not found in process arguments');
                }

                console.log('PortDetector', `Found process: PID=${pid}, extensionPort=${extensionPort || 'N/A'}`);

                const listeningPorts = await this.getProcessListeningPorts(pid);

                if (listeningPorts.length === 0) {
                    throw new Error('Process is not listening on any ports');
                }

                console.log('PortDetector', `Found ${listeningPorts.length} listening ports: ${listeningPorts.join(', ')}`);

                const connectPort = await this.findWorkingPort(listeningPorts, csrfToken);

                if (!connectPort) {
                    throw new Error('Unable to find a working API port');
                }

                console.log('PortDetector', `Detection succeeded: connectPort=${connectPort}, extensionPort=${extensionPort}`);

                return { extensionPort, connectPort, csrfToken };

            } catch (error: any) {
                const errorMsg = error?.message || String(error);
                console.error('PortDetector', `Attempt ${attempt} failed: ${errorMsg}`);

                if (errorMsg.includes('not found') || errorMsg.includes('unavailable')) {
                    if (this.platformDetector.getPlatformName() === 'Windows') {
                        const windowsStrategy = this.platformStrategy as any;
                        if (windowsStrategy.setUsePowerShell && !windowsStrategy.isUsingPowerShell()) {
                            console.warn('PortDetector', 'WMIC command is unavailable. Switching to PowerShell mode and retrying...');
                            windowsStrategy.setUsePowerShell(true);
                            attempt--;
                            continue;
                        }
                    }
                }
            }

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }

        // Windows Fallback Logic if loop finishes without success but maybe logic required it within loop?
        // The previous logic had fallback inside the catch block helper.
        // If we are here, we failed all retries.

        return null;
    }

    private async getProcessListeningPorts(pid: number): Promise<number[]> {
        try {
            await this.platformStrategy.ensurePortCommandAvailable();

            const command = this.platformStrategy.getPortListCommand(pid);
            const { stdout } = await execAsync(command, { timeout: 3000 });

            const ports = this.platformStrategy.parseListeningPorts(stdout);
            return ports;
        } catch (error: any) {
            console.error('PortDetector', `Failed to fetch listening ports: ${error.message}`);
            return [];
        }
    }

    private async findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
        for (const port of ports) {
            const isWorking = await this.testPortConnectivity(port, csrfToken);
            if (isWorking) {
                return port;
            }
        }
        return null;
    }

    private async testPortConnectivity(port: number, csrfToken: string): Promise<boolean> {
        return new Promise((resolve) => {
            const requestBody = JSON.stringify({
                context: {
                    properties: {
                        devMode: "false",
                        extensionVersion: versionInfo.getExtensionVersion(),
                        hasAnthropicModelAccess: "true",
                        ide: "antigravity",
                        ideVersion: versionInfo.getIdeVersion(),
                        installationId: "test-detection",
                        language: "UNSPECIFIED",
                        os: versionInfo.getOs(),
                        requestedModelId: "MODEL_UNSPECIFIED"
                    }
                }
            });

            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrfToken
                },
                rejectUnauthorized: false,
                timeout: 2000
            };

            const req = https.request(options, (res) => {
                const success = res.statusCode === 200;
                res.resume();
                resolve(success);
            });

            req.on('error', (_err) => {
                // logger.debug('ProcessPortDetector', `Port ${port} connection error: ${err.code || err.message}`);
                resolve(false);
            });

            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });

            req.write(requestBody);
            req.end();
        });
    }
}
