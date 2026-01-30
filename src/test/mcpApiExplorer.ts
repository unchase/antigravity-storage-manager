/**
 * MCP API Explorer - Testing available MCP-related API endpoints
 * Run with: npx ts-node src/test/mcpApiExplorer.ts
 */

import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

class McpApiExplorer {
    private port: number = 0;
    private token: string = '';

    async initialize() {
        console.log('🔍 Detecting Antigravity process...\n');

        const processName = 'language_server_windows_x64.exe';
        const psCommand = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${processName}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;

        try {
            const { stdout } = await execAsync(psCommand);
            let data = JSON.parse(stdout);
            if (Array.isArray(data)) data = data[0];

            if (!data || !data.CommandLine) {
                throw new Error('Antigravity process not found');
            }

            const pid = data.ProcessId;
            const tokenMatch = data.CommandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
            if (!tokenMatch) throw new Error('CSRF token not found');
            this.token = tokenMatch[1];

            console.log(`✅ Found PID: ${pid}`);
            console.log(`✅ Token: ${this.token.substring(0, 8)}...`);

            // Find listening port
            const netstatCommand = `netstat -ano | findstr "${pid}" | findstr "LISTENING"`;
            const { stdout: netstatOut } = await execAsync(netstatCommand);
            const portRegex = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?]):(\\d+)\s+\S+\s+LISTENING/gi;

            let match;
            const ports: number[] = [];
            while ((match = portRegex.exec(netstatOut)) !== null) {
                ports.push(parseInt(match[1], 10));
            }

            // Alternative parsing
            const lines = netstatOut.split('\n');
            for (const line of lines) {
                const portMatch = line.match(/:(\d+)\s/);
                if (portMatch) {
                    const p = parseInt(portMatch[1], 10);
                    if (!ports.includes(p) && p > 1000) {
                        ports.push(p);
                    }
                }
            }

            console.log(`📡 Found ports: ${ports.join(', ')}`);

            // Test ports
            for (const p of ports) {
                const ok = await this.testPort(p);
                if (ok) {
                    this.port = p;
                    console.log(`✅ Working API port: ${p}\n`);
                    break;
                }
            }

            if (!this.port) throw new Error('Could not find working API port');

        } catch (err: any) {
            console.error('❌ Initialization failed:', err.message);
            process.exit(1);
        }
    }

    private async testPort(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const requestBody = JSON.stringify({});
            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/Heartbeat',
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
                res.resume();
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
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

async function exploreMcpApis() {
    const explorer = new McpApiExplorer();
    await explorer.initialize();

    const results: Record<string, any> = {};

    console.log('='.repeat(60));
    console.log('📋 TESTING MCP-RELATED API ENDPOINTS');
    console.log('='.repeat(60));

    // ========== MCP ENDPOINTS ==========
    const mcpMethods = [
        { name: 'GetMcpServerStates', body: {} },
        { name: 'RefreshMcpServers', body: {} },
        { name: 'ListMcpResources', body: {} },
        { name: 'GetMcpServerTemplates', body: {} },
    ];

    console.log('\n🔌 MCP Endpoints:');
    console.log('-'.repeat(40));

    for (const method of mcpMethods) {
        process.stdout.write(`  ${method.name}... `);
        try {
            const result = await explorer.call(method.name, method.body);
            if (result._error) {
                console.log(`❌ Error ${result._error}`);
                results[method.name] = { status: 'error', code: result._error, body: result._body?.substring(0, 200) };
            } else {
                console.log(`✅ OK`);
                results[method.name] = { status: 'ok', data: result };
            }
        } catch (e: any) {
            console.log(`❌ ${e.message}`);
            results[method.name] = { status: 'exception', message: e.message };
        }
    }

    // ========== IMAGE GENERATION TRACKING ==========
    console.log('\n🖼️  Image Generation (via Trajectory):');
    console.log('-'.repeat(40));

    try {
        // Get first conversation to analyze
        const trajectories = await explorer.call('GetAllCascadeTrajectories', {});
        let targetId = '';

        if (trajectories.trajectorySummaries) {
            targetId = Object.keys(trajectories.trajectorySummaries)[0];
        }

        if (targetId) {
            console.log(`  Analyzing trajectory: ${targetId.substring(0, 8)}...`);
            const trajectory = await explorer.call('GetCascadeTrajectory', { cascadeId: targetId });
            const steps = trajectory.trajectory?.steps || [];

            // Find all unique step types
            const stepTypes = new Set<string>();
            let imageGenCount = 0;

            for (const step of steps) {
                if (step.type) {
                    stepTypes.add(step.type);
                }
                if (step.type === 'CORTEX_STEP_TYPE_GENERATE_IMAGE') {
                    imageGenCount++;
                }
            }

            console.log(`  ✅ Total steps: ${steps.length}`);
            console.log(`  ✅ Image generations: ${imageGenCount}`);
            console.log(`  ✅ Step types found: ${stepTypes.size}`);

            results['ImageGenAnalysis'] = {
                trajectoryId: targetId,
                totalSteps: steps.length,
                imageGenCount: imageGenCount,
                stepTypes: Array.from(stepTypes)
            };
        } else {
            console.log('  ⚠️ No trajectories found');
        }
    } catch (e: any) {
        console.log(`  ❌ ${e.message}`);
    }

    // ========== ADDITIONAL ENDPOINTS ==========
    console.log('\n📊 Additional Endpoints:');
    console.log('-'.repeat(40));

    const additionalMethods = [
        'GetCascadeMemories',
        'GetUserMemories',
        'GetBrainStatus',
        'GetModelStatuses',
        'GetRepoInfos',
        'GetWorkspaceInfos',
        'GetAvailableCascadePlugins',
        'GetAllWorkflows',
        'GetAllRules',
        'GetUserSettings',
        'GetUserAnalyticsSummary',
        'GetConversationTags',
        'GetUnleashData',
    ];

    for (const method of additionalMethods) {
        process.stdout.write(`  ${method}... `);
        try {
            const result = await explorer.call(method, {});
            if (result._error) {
                console.log(`❌ Error ${result._error}`);
                results[method] = { status: 'error', code: result._error };
            } else {
                const keys = Object.keys(result);
                const hasData = keys.length > 0 && !keys.every(k => result[k] === null || result[k] === undefined || (Array.isArray(result[k]) && result[k].length === 0));
                console.log(hasData ? `✅ OK (${keys.join(', ')})` : `⚪ Empty`);
                results[method] = { status: 'ok', data: result };
            }
        } catch (e: any) {
            console.log(`❌ ${e.message}`);
            results[method] = { status: 'exception', message: e.message };
        }
    }

    // ========== CHECK MCP CONFIG FILE ==========
    console.log('\n📁 MCP Configuration Files:');
    console.log('-'.repeat(40));

    const mcpPaths = [
        path.join(os.homedir(), '.gemini', 'antigravity', 'mcp', 'mcp_config.json'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'mcp'),
    ];

    for (const p of mcpPaths) {
        try {
            const stat = fs.statSync(p);
            if (stat.isDirectory()) {
                const files = fs.readdirSync(p);
                console.log(`  ✅ ${p} (${files.length} files: ${files.join(', ')})`);
                results['McpConfigDir'] = files;
            } else {
                const content = fs.readFileSync(p, 'utf-8');
                const json = JSON.parse(content);
                console.log(`  ✅ ${path.basename(p)} found`);
                results['McpConfigFile'] = json;
            }
        } catch {
            console.log(`  ⚠️ ${p} - not found`);
        }
    }

    // ========== SAVE RESULTS ==========
    const outputPath = path.join(process.cwd(), 'mcp_api_results.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log(`📝 Results saved to: ${outputPath}`);
    console.log('='.repeat(60));
}

exploreMcpApis().catch(console.error);
