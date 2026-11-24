
import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as http from 'http';
import { PlatformDetector } from './platformDetector';
import { IPlatformStrategy } from './types';
import { versionInfo } from './versionInfo';
import { LocalizationManager } from '../l10n/localizationManager';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface AntigravityProcessInfo {
    extensionPort: number;
    connectPort: number;
    csrfToken: string;
    protocol?: 'https' | 'http';
}

export class ProcessPortDetector {
    private platformDetector: PlatformDetector;
    private platformStrategy: IPlatformStrategy;
    private processName: string;
    private processNames: string[];

    constructor() {
        this.platformDetector = new PlatformDetector();
        this.platformStrategy = this.platformDetector.getStrategy();
        this.processName = this.platformDetector.getProcessName();
        this.processNames = this.platformDetector.getProcessNames();
    }

    private redactSensitive(text: string): string {
        return text.replace(/(--csrf[_-]token[=\s]+"?)[^\s"]+/gi, '$1<REDACTED>');
    }

    private async detectFromEnvironment(): Promise<AntigravityProcessInfo | null> {
        const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS?.trim();
        if (!lsAddr) {
            return null;
        }

        const portMatch = lsAddr.match(/:(\d+)$/);
        if (!portMatch || !portMatch[1]) {
            return null;
        }

        const port = parseInt(portMatch[1], 10);
        if (isNaN(port) || port <= 0) {
            return null;
        }

        const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim() || '';
        console.log('PortDetector', `Checking environment ANTIGRAVITY_LS_ADDRESS port=${port} (csrfToken=${csrfToken ? 'present' : 'absent'})`);
        const protocol = await this.testPortConnectivity(port, csrfToken);
        if (protocol) {
            console.log('PortDetector', `Environment detection succeeded: connectPort=${port} (${protocol})`);
            return {
                extensionPort: port,
                connectPort: port,
                csrfToken,
                protocol
            };
        }

        return null;
    }

    async detectProcessInfo(maxRetries: number = 3, retryDelay: number = 2000, silent: boolean = false): Promise<AntigravityProcessInfo | null> {
        const envInfo = await this.detectFromEnvironment();
        if (envInfo) {
            return envInfo;
        }

        const platformName = this.platformDetector.getPlatformName();
        let fallbackUsed = false; // Track if we already tried fallback to prevent infinite loop

        console.log('PortDetector', `Starting port detection on ${platformName}, processName=${this.processName}`);

        if (platformName === 'Windows') {
            const windowsStrategy = this.platformStrategy as any;
            const mode = windowsStrategy.isUsingPowerShell?.() ? 'PowerShell' : 'WMIC';
            console.log('PortDetector', `Windows detection mode: ${mode}`);
        }

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log('PortDetector', `Attempt ${attempt}/${maxRetries}: Detecting Antigravity process...`);

                let stdout: string;
                const parts = this.platformStrategy.getProcessListCommandParts?.(this.processName);
                if (parts) {
                    // Direct call via execFile — bypasses cmd.exe, no quoting issues
                    const result = await execFileAsync(parts.file, parts.args, { timeout: 15000 });
                    stdout = result.stdout;
                } else {
                    const command = this.platformStrategy.getProcessListCommand(this.processName);
                    const result = await execAsync(command, { timeout: 15000 });
                    stdout = result.stdout;
                }

                console.log('PortDetector', `Process list stdout (${stdout.length} chars): ${this.redactSensitive(stdout.substring(0, 500))}`);

                let processInfo = this.platformStrategy.parseProcessInfo(stdout);

                // Fallback: try alternative process names (fixes #12 — ARM64 Windows, Antigravity 2.0 agy.exe --hub)
                if (!processInfo && this.processNames.length > 1) {
                    for (const altName of this.processNames) {
                        if (altName === this.processName) continue;
                        console.log('PortDetector', `Primary process '${this.processName}' not found, trying '${altName}'...`);
                        try {
                            let altStdout: string;
                            const altParts = this.platformStrategy.getProcessListCommandParts?.(altName);
                            if (altParts) {
                                const altResult = await execFileAsync(altParts.file, altParts.args, { timeout: 15000 });
                                altStdout = altResult.stdout;
                            } else {
                                const altCommand = this.platformStrategy.getProcessListCommand(altName);
                                const altResult = await execAsync(altCommand, { timeout: 15000 });
                                altStdout = altResult.stdout;
                            }
                            console.log('PortDetector', `Fallback '${altName}' stdout (${altStdout.length} chars): ${this.redactSensitive(altStdout.substring(0, 500))}`);
                            processInfo = this.platformStrategy.parseProcessInfo(altStdout);
                            if (processInfo) {
                                console.log('PortDetector', `Found process using fallback name '${altName}'`);
                                break;
                            }
                        } catch {
                            // Continue to next alternative
                        }
                    }
                }

                if (!processInfo) {
                    throw new Error('language_server / agy process not found');
                }

                const { pid, extensionPort } = processInfo;
                const csrfToken = processInfo.csrfToken || process.env.ANTIGRAVITY_CSRF_TOKEN?.trim() || '';

                if (!csrfToken) {
                    console.log('PortDetector', `Attempt ${attempt}: No CSRF token in process arguments; probing local endpoint without CSRF header`);
                }

                console.log('PortDetector', `Found process: PID=${pid}, extensionPort=${extensionPort || 'N/A'}, csrfToken=${csrfToken ? 'present' : 'absent'}`);

                const listeningPorts = await this.getProcessListeningPorts(pid);
                const candidatePorts: number[] = [];
                if (extensionPort > 0) {
                    candidatePorts.push(extensionPort);
                }
                for (const p of listeningPorts) {
                    if (!candidatePorts.includes(p)) {
                        candidatePorts.push(p);
                    }
                }

                if (candidatePorts.length === 0) {
                    throw new Error('Process is not listening on any ports');
                }

                console.log('PortDetector', `Found ${candidatePorts.length} candidate ports: ${candidatePorts.join(', ')}`);

                const workingEndpoint = await this.findWorkingPort(candidatePorts, csrfToken);

                if (!workingEndpoint) {
                    throw new Error(
                        csrfToken
                            ? 'Unable to find a working API port'
                            : 'Unable to find a working API port (no CSRF token in process arguments)'
                    );
                }

                console.log('PortDetector', `Detection succeeded: connectPort=${workingEndpoint.port} (${workingEndpoint.protocol}), extensionPort=${extensionPort}`);

                return {
                    extensionPort,
                    connectPort: workingEndpoint.port,
                    csrfToken,
                    protocol: workingEndpoint.protocol
                };

            } catch (error: any) {
                const errorMsg = error?.message || String(error);
                if (!silent && attempt >= maxRetries) {
                    // Show error to user only on final attempt when not in silent fallback mode
                    const lm = LocalizationManager.getInstance();
                    vscode.window.showErrorMessage(lm.t('PortDetector: Attempt {0} failed ({1})', attempt, errorMsg));
                } else {
                    console.warn('PortDetector', `Attempt ${attempt}/${maxRetries} failed: ${errorMsg}`);
                }

                // Only switch PS↔WMIC on actual command failure, NOT on 'process not found'
                if (errorMsg.includes('Command failed') || errorMsg.includes('unavailable')) {
                    if (this.platformDetector.getPlatformName() === 'Windows' && !fallbackUsed) {
                        const windowsStrategy = this.platformStrategy as any;
                        const isUsingPowerShell = windowsStrategy.isUsingPowerShell?.();

                        if (windowsStrategy.setUsePowerShell) {
                            // Toggle between PowerShell and WMIC
                            if (isUsingPowerShell) {
                                console.warn('PortDetector', 'PowerShell command failed. Switching to WMIC mode and retrying...');
                                windowsStrategy.setUsePowerShell(false);
                            } else {
                                console.warn('PortDetector', 'WMIC command is unavailable. Switching to PowerShell mode and retrying...');
                                windowsStrategy.setUsePowerShell(true);
                            }
                            fallbackUsed = true;
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
            let stdout = '';

            try {
                const result = await execAsync(command, { timeout: 3000 });
                stdout = result.stdout;
            } catch (error) {
                // Try fallback if available
                if (this.platformStrategy.getFallbackPortListCommand) {
                    console.warn('PortDetector', `Primary command failed, trying fallback... (${error})`);
                    const fallbackCmd = this.platformStrategy.getFallbackPortListCommand(pid);
                    const result = await execAsync(fallbackCmd, { timeout: 3000 });
                    stdout = result.stdout;
                } else {
                    throw error;
                }
            }

            const ports = this.platformStrategy.parseListeningPorts(stdout, pid);
            return ports;
        } catch (error: any) {
            console.warn('PortDetector', `Failed to fetch listening ports: ${error.message}`);
            return [];
        }
    }

    private async findWorkingPort(ports: number[], csrfToken: string): Promise<{ port: number; protocol: 'https' | 'http' } | null> {
        for (const port of ports) {
            const protocol = await this.testPortConnectivity(port, csrfToken);
            if (protocol) {
                return { port, protocol };
            }
        }
        return null;
    }

    private async testPortConnectivity(port: number, csrfToken: string): Promise<'https' | 'http' | null> {
        const probes: Array<{ path: string; body: object }> = [
            {
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                body: {
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
                }
            },
            {
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                body: {
                    metadata: {
                        ideName: 'antigravity',
                        extensionName: 'antigravity',
                        ideVersion: versionInfo.getIdeVersion(),
                        locale: 'en'
                    }
                }
            },
            {
                path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
                body: {}
            }
        ];

        for (const protocol of ['https', 'http'] as const) {
            for (const probe of probes) {
                const status = await this.probeEndpoint(port, csrfToken, protocol, probe.path, probe.body);
                if (status === 'ok') {
                    return protocol;
                }
                if (status === 'network_error') {
                    // Protocol mismatch or port unreachable on this scheme; try next protocol
                    break;
                }
                // On HTTP 404/405/501/etc., try next probe endpoint on the same protocol
            }
        }

        return null;
    }

    private probeEndpoint(
        port: number,
        csrfToken: string,
        protocol: 'https' | 'http',
        endpointPath: string,
        body: object
    ): Promise<'ok' | 'http_error' | 'network_error'> {
        return new Promise((resolve) => {
            const requestBody = JSON.stringify(body);

            const headers: Record<string, string | number> = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Connect-Protocol-Version': '1'
            };
            if (csrfToken) {
                headers['X-Codeium-Csrf-Token'] = csrfToken;
                headers['x-antigravity-csrf-token'] = csrfToken;
            }

            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port: port,
                path: endpointPath,
                method: 'POST',
                headers,
                rejectUnauthorized: false,
                timeout: 2000
            };

            const client = protocol === 'https' ? https : http;
            const req = client.request(options, (res) => {
                const success = res.statusCode === 200;
                if (!success) {
                    console.log('PortDetector', `Probe ${protocol}://127.0.0.1:${port}${endpointPath} returned HTTP ${res.statusCode}`);
                }
                res.resume();
                resolve(success ? 'ok' : 'http_error');
            });

            req.on('error', () => {
                resolve('network_error');
            });

            req.on('timeout', () => {
                req.destroy();
                resolve('network_error');
            });

            req.write(requestBody);
            req.end();
        });
    }
}
