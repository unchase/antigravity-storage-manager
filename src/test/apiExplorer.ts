
import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Simplified Antigravity API Client for probing
 */
class ApiProber {
    private port: number = 0;
    private token: string = '';

    async initialize() {
        console.log('Detecting Antigravity process...');

        // Windows-specific logic (matching USER's system)
        const processName = 'language_server_windows_x64.exe';
        const psCommand = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;

        try {
            const { stdout } = await execAsync(psCommand);
            let data = JSON.parse(stdout);
            if (Array.isArray(data)) data = data[0];

            if (!data || !data.CommandLine) {
                throw new Error('Process not found or command line inaccessible');
            }

            const pid = data.ProcessId;
            const tokenMatch = data.CommandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
            if (!tokenMatch) throw new Error('CSRF token not found');
            this.token = tokenMatch[1];

            console.log(`Found PID: ${pid}, Token: ${this.token.substring(0, 5)}...`);

            // Find listening port
            const netstatCommand = `netstat -ano | findstr "${pid}" | findstr "LISTENING"`;
            const { stdout: netstatOut } = await execAsync(netstatCommand);
            const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?]):(\d+)\s+\S+\s+LISTENING/gi;

            let match;
            const ports: number[] = [];
            while ((match = portRegex.exec(netstatOut)) !== null) {
                ports.push(parseInt(match[1], 10));
            }

            if (ports.length === 0) throw new Error('No listening ports found');

            // Test ports
            for (const p of ports) {
                const ok = await this.testPort(p);
                if (ok) {
                    this.port = p;
                    console.log(`Working port found: ${p}`);
                    break;
                }
            }

            if (!this.port) throw new Error('Could not find a working API port');

        } catch (err: any) {
            console.error('Initialization failed:', err.message);
            process.exit(1);
        }
    }

    private async testPort(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const requestBody = JSON.stringify({
                context: {
                    properties: {
                        ide: "antigravity",
                        os: "windows"
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
                    'X-Codeium-Csrf-Token': this.token
                },
                rejectUnauthorized: false,
                timeout: 2000
            };
            const req = https.request(options, (res) => {
                const ok = res.statusCode === 200;
                res.resume();
                resolve(ok);
            });
            req.on('error', () => resolve(false));
            req.write(requestBody);
            req.end();
        });
    }

    async call(method: string, body: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const requestBody = JSON.stringify(body);
            const options = {
                hostname: '127.0.0.1',
                port: this.port,
                path: `/exa.language_server_pb.LanguageServerService/${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': this.token
                },
                rejectUnauthorized: false
            };

            const req = https.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () => {
                    const responseBody = Buffer.concat(chunks).toString();
                    if (res.statusCode === 200) {
                        try {
                            resolve(JSON.parse(responseBody));
                        } catch {
                            resolve({ _raw: responseBody });
                        }
                    } else {
                        resolve({ _error: res.statusCode, _body: responseBody });
                    }
                });
            });

            req.on('error', (e) => reject(e));
            req.write(requestBody);
            req.end();
        });
    }
}

async function run() {
    const prober = new ApiProber();
    await prober.initialize();

    const methods = [
        'GetAllCascadeTrajectories',
        'GetCascadeTrajectory', // Needs cascadeId
        'GetUserTrajectory',    // Needs trajectoryId?
        'GetCascadeTrajectoryGeneratorMetadata', // Needs cascadeId?
        'GetAvailableCascadePlugins',
        'GetCascadeMemories',
        'GetUserMemories',
        'GetConversationTags',
        'GetAllWorkflows',
        'GetAllRules',
        'GetUserSettings',
        'GetBrainStatus',
        'GetModelStatuses',
        'GetRepoInfos',
        'GetWorkspaceInfos',
        'GetUserAnalyticsSummary'
    ];

    const results: any = {};

    // 1. Get Trajectories first to find an ID to use for specific methods
    console.log('Probing GetAllCascadeTrajectories...');
    const trajectories = await prober.call('GetAllCascadeTrajectories');
    results['GetAllCascadeTrajectories'] = trajectories;

    let targetId = '';
    if (trajectories.trajectorySummaries) {
        targetId = Object.keys(trajectories.trajectorySummaries)[0];
    } else if (Array.isArray(trajectories.cascadeTrajectories) && trajectories.cascadeTrajectories.length > 0) {
        targetId = trajectories.cascadeTrajectories[0].cascadeId;
    }

    console.log(`Using target instance ID: ${targetId || 'None found'}`);

    for (const method of methods) {
        if (method === 'GetAllCascadeTrajectories') continue;

        console.log(`Probing ${method}...`);
        let body: any = {};
        if (method.includes('CascadeTrajectory') || method === 'GetConversationTags') {
            if (!targetId) {
                results[method] = { _skipped: 'No targetId found' };
                continue;
            }
            body = { cascadeId: targetId };
        }

        try {
            results[method] = await prober.call(method, body);
        } catch (err: any) {
            results[method] = { _error: err.message };
        }
    }

    const outputPath = path.join(process.cwd(), 'api_probe_results.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`Done! Results saved to ${outputPath}`);
}

run().catch(console.error);
