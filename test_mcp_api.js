/**
 * Simple MCP API Test Script
 * Run with: node test_mcp_api.js
 */

const https = require('https');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);

let PORT = 0;
let TOKEN = '';

async function initialize() {
    console.log('🔍 Detecting Antigravity process...\n');

    const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='language_server_windows_x64.exe'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;

    const { stdout } = await execAsync(psCmd);
    let data = JSON.parse(stdout);
    if (Array.isArray(data)) data = data[0];

    if (!data || !data.CommandLine) {
        throw new Error('Antigravity process not found');
    }

    const pid = data.ProcessId;
    const tokenMatch = data.CommandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
    if (!tokenMatch) throw new Error('CSRF token not found');
    TOKEN = tokenMatch[1];

    console.log(`✅ Found PID: ${pid}`);
    console.log(`✅ Token: ${TOKEN.substring(0, 8)}...`);

    // Find listening port
    const { stdout: ns } = await execAsync(`netstat -ano | findstr "${pid}" | findstr LISTENING`);
    const ports = new Set();
    ns.split('\n').forEach(line => {
        const m = line.match(/:(\d+)\s/);
        if (m) {
            const p = parseInt(m[1], 10);
            if (p > 1000) ports.add(p);
        }
    });

    console.log(`📡 Found ports: ${[...ports].join(', ')}`);

    // Test each port
    for (const p of ports) {
        const ok = await testPort(p);
        if (ok) {
            PORT = p;
            console.log(`✅ Working API port: ${p}\n`);
            break;
        }
    }

    if (!PORT) throw new Error('Could not find working API port');
}

function testPort(port) {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/exa.language_server_pb.LanguageServerService/Heartbeat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': 2,
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': TOKEN
            },
            rejectUnauthorized: false,
            timeout: 3000
        }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write('{}');
        req.end();
    });
}

function callApi(method, body = {}) {
    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify(body);
        const req = https.request({
            hostname: '127.0.0.1',
            port: PORT,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': TOKEN
            },
            rejectUnauthorized: false
        }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString();
                if (res.statusCode === 200) {
                    try {
                        resolve({ ok: true, data: JSON.parse(responseBody) });
                    } catch {
                        resolve({ ok: true, raw: responseBody });
                    }
                } else {
                    resolve({ ok: false, status: res.statusCode, body: responseBody });
                }
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.write(requestBody);
        req.end();
    });
}

async function run() {
    try {
        await initialize();
    } catch (e) {
        console.error('❌ Init failed:', e.message);
        process.exit(1);
    }

    const results = {};

    console.log('='.repeat(60));
    console.log('📋 TESTING MCP-RELATED API ENDPOINTS');
    console.log('='.repeat(60));

    // MCP Endpoints
    const mcpMethods = [
        'GetMcpServerStates',
        'RefreshMcpServers',
        'ListMcpResources',
        'GetMcpServerTemplates',
    ];

    console.log('\n🔌 MCP Endpoints:');
    console.log('-'.repeat(40));

    for (const method of mcpMethods) {
        process.stdout.write(`  ${method}... `);
        const result = await callApi(method);
        if (result.ok) {
            console.log('✅ OK');
            results[method] = result.data;
        } else {
            console.log(`❌ ${result.status || result.error}`);
            results[method] = { error: result.status || result.error };
        }
    }

    // Additional endpoints
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
        'GetUnleashData',
    ];

    for (const method of additionalMethods) {
        process.stdout.write(`  ${method}... `);
        const result = await callApi(method);
        if (result.ok) {
            const keys = Object.keys(result.data || {});
            const hasData = keys.length > 0;
            console.log(hasData ? `✅ (${keys.join(', ')})` : '⚪ Empty');
            results[method] = result.data;
        } else {
            console.log(`❌ ${result.status || result.error}`);
            results[method] = { error: result.status || result.error };
        }
    }

    // Check trajectory for image generation
    console.log('\n🖼️  Image Generation Analysis:');
    console.log('-'.repeat(40));

    const trajResult = await callApi('GetAllCascadeTrajectories');
    if (trajResult.ok && trajResult.data.trajectorySummaries) {
        const ids = Object.keys(trajResult.data.trajectorySummaries);
        console.log(`  Found ${ids.length} conversations`);

        if (ids.length > 0) {
            const targetId = ids[0];
            const detailResult = await callApi('GetCascadeTrajectory', { cascadeId: targetId });
            if (detailResult.ok) {
                const steps = detailResult.data.trajectory?.steps || [];
                const stepTypes = {};
                let imageCount = 0;

                for (const step of steps) {
                    if (step.type) {
                        stepTypes[step.type] = (stepTypes[step.type] || 0) + 1;
                        if (step.type === 'CORTEX_STEP_TYPE_GENERATE_IMAGE') {
                            imageCount++;
                        }
                    }
                }

                console.log(`  ✅ Analyzed: ${targetId.substring(0, 8)}...`);
                console.log(`  ✅ Total steps: ${steps.length}`);
                console.log(`  ✅ Image generations: ${imageCount}`);
                console.log(`  ✅ Step types:`);
                for (const [type, count] of Object.entries(stepTypes)) {
                    console.log(`     - ${type}: ${count}`);
                }

                results['StepTypeAnalysis'] = stepTypes;
            }
        }
    }

    // Check MCP config files
    console.log('\n📁 MCP Config Files:');
    console.log('-'.repeat(40));

    const mcpDir = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp');
    try {
        const files = fs.readdirSync(mcpDir);
        console.log(`  ✅ ${mcpDir}`);
        console.log(`  Files: ${files.join(', ')}`);
        results['McpConfigFiles'] = files;

        // Read config if exists
        const configPath = path.join(mcpDir, 'mcp_config.json');
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            results['McpConfig'] = JSON.parse(content);
            console.log(`  ✅ mcp_config.json loaded`);
        }
    } catch {
        console.log(`  ⚠️ MCP dir not found: ${mcpDir}`);
    }

    // Save results
    const outputPath = path.join(process.cwd(), 'mcp_api_results.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log(`📝 Results saved to: ${outputPath}`);
    console.log('='.repeat(60));
}

run().catch(e => console.error('Fatal:', e));
