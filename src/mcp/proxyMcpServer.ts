#!/usr/bin/env node
/**
 * Antigravity Proxy MCP Server
 * 
 * This MCP server provides tools for interacting with the Antigravity Proxy,
 * allowing AI agents to make HTTP requests through the proxy and manage its state.
 * 
 * Usage:
 *   node proxyMcpServer.js
 * 
 * Environment Variables:
 *   PROXY_PORT     - Proxy port (default: 8317)
 *   PROXY_HOST     - Proxy host (default: 127.0.0.1)
 *   PROXY_API_KEY  - API key for authentication
 *   PROXY_BIN_DIR  - Path to proxy bin directory
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, getProxyBaseUrl, isProxyRunning, McpConfig } from "./config";
import * as fs from 'fs';
import * as path from 'path';

// Load configuration
const config: McpConfig = loadConfig();

// Create MCP server instance
const server = new McpServer({
    name: "antigravity-proxy",
    version: "1.0.0",
});

// ============================================================================
// Static Model Registry
// ============================================================================

interface ModelDef {
    id: string;
    type: string;
    ownedBy?: string;
}

const STATIC_MODEL_REGISTRY: ModelDef[] = [
    // Claude Models
    { id: "claude-haiku-4-5-20251001", type: "claude" },
    { id: "claude-sonnet-4-5-20250929", type: "claude" },
    { id: "claude-opus-4-6", type: "claude" },
    { id: "claude-opus-4-5-20251101", type: "claude" },
    { id: "claude-opus-4-1-20250805", type: "claude" },
    { id: "claude-opus-4-20250514", type: "claude" },
    { id: "claude-sonnet-4-20250514", type: "claude" },
    { id: "claude-3-7-sonnet-20250219", type: "claude" },
    { id: "claude-3-5-haiku-20241022", type: "claude" },

    // Gemini Models (Pro/Flash/Lite/Preview/Image)
    { id: "gemini-2.5-pro", type: "gemini" },
    { id: "gemini-2.5-flash", type: "gemini" },
    { id: "gemini-2.5-flash-lite", type: "gemini" },
    { id: "gemini-3-pro-preview", type: "gemini" },
    { id: "gemini-3-flash-preview", type: "gemini" },
    { id: "gemini-3-pro-image-preview", type: "gemini" },
    { id: "gemini-pro-latest", type: "gemini" },
    { id: "gemini-flash-latest", type: "gemini" },
    { id: "gemini-flash-lite-latest", type: "gemini" },
    { id: "gemini-2.5-flash-image", type: "gemini" },

    // Imagen Models
    { id: "imagen-4.0-generate-001", type: "gemini" },
    { id: "imagen-4.0-ultra-generate-001", type: "gemini" },
    { id: "imagen-3.0-generate-002", type: "gemini" },
    { id: "imagen-3.0-fast-generate-001", type: "gemini" },
    { id: "imagen-4.0-fast-generate-001", type: "gemini" },

    // OpenAI Models
    { id: "gpt-5", type: "openai" },
    { id: "gpt-5-codex", type: "openai" },
    { id: "gpt-5-codex-mini", type: "openai" },
    { id: "gpt-5.1", type: "openai" },
    { id: "gpt-5.1-codex", type: "openai" },
    { id: "gpt-5.1-codex-mini", type: "openai" },
    { id: "gpt-5.1-codex-max", type: "openai" },
    { id: "gpt-5.2", type: "openai" },
    { id: "gpt-5.2-codex", type: "openai" },
    { id: "gpt-5.3-codex", type: "openai" },

    // Qwen Models
    { id: "qwen3-coder-plus", type: "qwen" },
    { id: "qwen3-coder-flash", type: "qwen" },
    { id: "vision-model", type: "qwen" },
    { id: "qwen3-max", type: "qwen" },
    { id: "qwen3-vl-plus", type: "qwen" },
    { id: "qwen3-max-preview", type: "qwen" },
    { id: "qwen3-32b", type: "qwen" },
    { id: "qwen3-235b-a22b-thinking-2507", type: "qwen" },
    { id: "qwen3-235b-a22b-instruct", type: "qwen" },
    { id: "qwen3-235b", type: "qwen" },

    // iFlow Models
    { id: "tstars2.0", type: "iflow" },
    { id: "iflow-rome-30ba3b", type: "iflow" },
    { id: "minimax-m2", type: "iflow" },
    { id: "minimax-m2.1", type: "iflow" },
    { id: "glm-4.6", type: "iflow" },
    { id: "glm-4.7", type: "iflow" },
    { id: "deepseek-v3.2-chat", type: "iflow" },
    { id: "deepseek-v3.2-reasoner", type: "iflow" },
    { id: "deepseek-v3.2", type: "iflow" },
    { id: "deepseek-v3.1", type: "iflow" },
    { id: "deepseek-r1", type: "iflow" },
    { id: "deepseek-v3", type: "iflow" },

    // Kimi Models
    { id: "kimi-k2-0905", type: "iflow" }, // listed in iFlow models in Go file
    { id: "kimi-k2", type: "kimi" }, // listed in GetKimiModels
    { id: "kimi-k2-thinking", type: "kimi" },
    { id: "kimi-k2.5", type: "kimi" },
];

// ============================================================================
// Helper Functions
// ============================================================================

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

interface ModelsResponse {
    object: string;
    data: Array<{
        id: string;
        object: string;
        created: number;
        owned_by: string;
    }>;
}

interface QuotaResponse {
    remaining: number;
    limit: number;
    reset_at: string;
    unit: string;
}

/**
 * Make an authenticated request to the proxy
 */
async function proxyRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    body?: object,
    userAgent?: string
): Promise<T> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    if (config.proxyApiKey) {
        headers['Authorization'] = `Bearer ${config.proxyApiKey}`;
    } else {
        // Fallback for auth-less local access
        headers['Authorization'] = 'Bearer test-key';
    }

    if (userAgent) {
        headers['User-Agent'] = userAgent;
        if (userAgent.includes('GithubCopilot') || userAgent.includes('GitHubCopilot')) {
            headers['X-GitHub-Api-Version'] = '2022-11-28';
        }
    }

    const response = await fetch(`${getProxyBaseUrl(config)}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Proxy request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json() as Promise<T>;
}

/**
 * Get configured providers from config.yaml
 */
function getConfiguredProviders(): string[] {
    const configPath = path.join(config.binDir, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        return [];
    }

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const providers: string[] = [];

        // Check for various provider configurations
        if (content.match(/^github-copilot:/m)) providers.push('github-copilot');
        if (content.includes('claude-api-key:')) providers.push('claude');
        if (content.match(/^codex-api-key:/m)) providers.push('codex');
        if (content.includes('vertex-api-key:')) providers.push('vertex');
        if (content.match(/^\s+- name: ["']?z-ai["']?/m)) providers.push('z-ai');
        if (content.includes('kiro:')) providers.push('kiro');
        if (content.match(/provider:\s*["']?gemini["']?/) || content.match(/provider:\s*["']?aistudio["']?/)) {
            providers.push('gemini');
        }

        // Check for antigravity auth files
        const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
        let authDir = authDirMatch ? authDirMatch[1] : path.join(require('os').homedir(), '.cli-proxy-api'); // eslint-disable-line @typescript-eslint/no-require-imports
        if (authDir.startsWith('~')) {
            authDir = path.join(require('os').homedir(), authDir.slice(1)); // eslint-disable-line @typescript-eslint/no-require-imports
        }
        if (fs.existsSync(authDir)) {
            const files = fs.readdirSync(authDir);
            if (files.some(f => f.startsWith('antigravity-') && f.endsWith('.json'))) {
                providers.push('antigravity');
            }
        }

        return providers;
    } catch {
        return [];
    }
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Tool: proxy_status
 * Get the current status of the Antigravity Proxy
 */
server.tool(
    "proxy_status",
    "Get the current status of the Antigravity Proxy including whether it's running, the port, and configured providers.",
    {},
    async () => {
        const running = await isProxyRunning(config);
        const providers = getConfiguredProviders();

        const result = {
            status: running ? 'running' : 'stopped',
            port: config.proxyPort,
            host: config.proxyHost,
            url: getProxyBaseUrl(config),
            providers: providers,
            hasApiKey: !!config.proxyApiKey,
        };

        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    }
);

/**
 * Tool: list_models
 * Get available AI models from the proxy
 */
server.tool(
    "list_models",
    "Get a list of available AI models from the Antigravity Proxy.",
    {},
    async () => {
        try {
            const running = await isProxyRunning(config);
            if (!running) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Antigravity Proxy is not running. Please start it first.",
                        },
                    ],
                    isError: true,
                };
            }

            const response = await proxyRequest<ModelsResponse>('/v1/models');

            const models = response.data.map(m => ({
                id: m.id,
                owned_by: m.owned_by,
            }));

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({ models, count: models.length }, null, 2),
                    },
                ],
            };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error fetching models: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

// Schema for chat messages - defined separately to avoid deep type instantiation
const chatMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']).describe("Message role"),
    content: z.string().describe("Message content"),
});

/**
 * Tool: chat_completion
 * Send a chat completion request through the proxy
 */
const chatCompletionSchema = {
    model: z.string().describe("Model name (e.g., 'gpt-4o', 'gemini-2.0-flash', 'claude-sonnet-4')"),
    messages: z.array(chatMessageSchema).describe("Array of chat messages"),
    max_tokens: z.number().optional().describe("Maximum tokens in response (optional)"),
    temperature: z.number().min(0).max(2).optional().describe("Sampling temperature 0-2 (optional)"),
};

type ChatCompletionParams = {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    max_tokens?: number;
    temperature?: number;
};

// Using type assertion to avoid "Type instantiation is excessively deep" error
// caused by complex generic inference in MCP SDK with nested Zod schemas
// Using type assertion to avoid "Type instantiation is excessively deep" error
// caused by complex generic inference in MCP SDK with nested Zod schemas
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
(server.tool as Function)(
    "chat_completion",
    "Send a chat completion request to an AI model through the Antigravity Proxy.",
    chatCompletionSchema,
    async (params: ChatCompletionParams) => {
        const { model, messages, max_tokens, temperature } = params;
        try {
            const running = await isProxyRunning(config);
            if (!running) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Antigravity Proxy is not running. Please start it first.",
                        },
                    ],
                    isError: true,
                };
            }

            // --- Request Preparation Helper ---
            const prepareRequest = (modelInput: string) => {
                const modelStr = modelInput;
                let providerId = '';
                let modelName = modelStr;

                if (modelStr.includes('/')) {
                    const parts = modelStr.split('/');
                    providerId = parts[0];
                    modelName = parts.slice(1).join('/');
                }

                const oauthChannels = ['gemini', 'antigravity', 'kiro', 'claude', 'codex', 'qwen', 'iflow', 'vertex', 'aistudio', 'gemini-cli', 'github-copilot', 'kimi'];
                const userAgentMap: Record<string, string> = {
                    'antigravity': 'Antigravity/1.0.0',
                    'gemini': 'gemini-cli/1.0.0',
                    'gemini-cli': 'gemini-cli/1.0.0',
                    'github-copilot': 'GitHubCopilotChat/0.26.7',
                    'claude': 'claude-code/1.0.0',
                    'codex': 'codex-cli/1.0.0',
                    'kiro': 'kiro-cli/1.0.0',
                    'qwen': 'qwen-cli/1.0.0',
                    'iflow': 'iflow-cli/1.0.0',
                    'vertex': 'vertex-cli/1.0.0',
                    'aistudio': 'aistudio-cli/1.0.0',
                    'openai': 'GitHubCopilotChat/0.26.7',
                    'kimi': 'moonshot-cli/1.0.0'
                };

                let userAgent = userAgentMap[providerId];
                if (!userAgent) {
                    // Fallback to substring match
                    const modelLower = modelStr.toLowerCase();
                    if (modelLower.includes('gemini') || modelLower.includes('aistudio')) userAgent = 'gemini-cli/1.0.0';
                    else if (modelLower.includes('claude')) userAgent = 'claude-code/1.0.0';
                    else if (modelLower.includes('codex')) userAgent = 'codex-cli/1.0.0';
                    else if (modelLower.includes('copilot') || modelLower.includes('gpt')) userAgent = 'GitHubCopilotChat/0.26.7';
                    else if (modelLower.includes('qwen')) userAgent = 'qwen-cli/1.0.0';
                }

                let finalModel = modelStr;
                // For OAuth channels, use only the modelName (proxy uses User-Agent for routing)
                if (oauthChannels.includes(providerId)) {
                    finalModel = modelName;
                }

                // If provider is 'openai', strip the prefix as well for proxy compatibility
                if (providerId === 'openai') {
                    finalModel = modelName;
                }

                return { finalModel, userAgentProvider: providerId, userAgent };
            };

            // --- Execute Request with Retry ---
            const executeRequest = async (currentModel: string): Promise<ChatCompletionResponse> => {
                const { finalModel, userAgent } = prepareRequest(currentModel);

                const payload: Record<string, unknown> = {
                    model: finalModel,
                    messages: messages as ChatMessage[],
                };

                if (max_tokens !== undefined) payload.max_tokens = max_tokens;
                if (temperature !== undefined) payload.temperature = temperature;

                try {
                    return await proxyRequest<ChatCompletionResponse>(
                        '/v1/chat/completions',
                        'POST',
                        payload,
                        userAgent
                    );
                } catch (err: unknown) {
                    const errorMsg = String(err);
                    // Check for specific error types to trigger retry
                    // 502: Bad Gateway (often unknown provider/router error)
                    // 404: Not Found (model not found)
                    // 400: Bad Request (invalid model param)
                    if (errorMsg.includes('502') || errorMsg.includes('404') || errorMsg.includes('400')) {
                        throw { isRetryable: true, originalError: err };
                    }
                    throw err;
                }
            };

            // 1. First Attempt
            let response: ChatCompletionResponse;
            try {
                response = await executeRequest(model);
            } catch (err: any) {
                if (err.isRetryable) {
                    // 2. Retry Logic
                    console.error(`Request failed with ${model}. Attempting to recover using Static Registry...`);

                    // Extract potential model ID from input (remove provider prefix)
                    const parts = model.split('/');
                    const searchId = parts.length > 1 ? parts.slice(1).join('/') : model;

                    // Find matching model in registry
                    const match = STATIC_MODEL_REGISTRY.find(m => m.id === searchId || m.id === model);

                    if (match) {
                        const newModelString = `${match.type}/${match.id}`;
                        console.error(`Found match in registry: ${newModelString}. Retrying...`);

                        // Retry with corrected model string (provider/id format to ensure correct UA selection)
                        response = await executeRequest(newModelString);
                    } else {
                        // No match found, rethrow original error
                        throw err.originalError;
                    }
                } else {
                    throw err;
                }
            }

            const result = {
                content: response.choices[0]?.message?.content || '',
                model: response.model,
                finish_reason: response.choices[0]?.finish_reason,
                usage: response.usage,
            };

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error making chat completion request: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

/**
 * Tool: get_quota
 * Get quota information for a specific provider
 */
// Using type assertion to avoid "Type instantiation is excessively deep" error
// Using type assertion to avoid "Type instantiation is excessively deep" error
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
(server.tool as Function)(
    "get_quota",
    "Get quota/usage information for a specific AI provider (antigravity, codex, or gemini-cli).",
    {
        provider: z.enum(['antigravity', 'codex', 'gemini-cli']).describe("Provider name: 'antigravity', 'codex', or 'gemini-cli'"),
        account: z.string().optional().describe("Optional account name or email to filter by. If omitted, the first available account for the provider is used."),
    },
    async ({ provider, account }: { provider: 'antigravity' | 'codex' | 'gemini-cli', account?: string }) => {
        try {
            const running = await isProxyRunning(config);
            if (!running) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Antigravity Proxy is not running. Please start it first.",
                        },
                    ],
                    isError: true,
                };
            }

            // 1. Get Management Key
            // Prioritize environment variable (injected by VS Code) since config might have hash
            let managementKey = process.env.PROXY_MANAGEMENT_KEY;

            if (!managementKey) {
                // Fallback to config file (works only if plaintext key is stored)
                const configPath = path.join(config.binDir, 'config.yaml');
                if (fs.existsSync(configPath)) {
                    const configContent = fs.readFileSync(configPath, 'utf8');
                    const secretKeyMatch = configContent.match(/secret-key:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))/);
                    const secretKey = secretKeyMatch ? (secretKeyMatch[1] || secretKeyMatch[2] || secretKeyMatch[3]) : null;
                    if (secretKey && !secretKey.startsWith('$2')) {
                        managementKey = secretKey;
                    }
                }
            }

            if (!managementKey) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Management key not found or is hashed. Please run this tool via the VS Code Extension's 'Run MCP Server' command.",
                        },
                    ],
                    isError: true,
                };
            }

            // 2. Fetch Auth Files to map account -> authIndex
            const baseUrl = getProxyBaseUrl(config);
            // Base URL usually has /v1, we need to strip it to get root for /v0
            const rootUrl = baseUrl.replace(/\/v1$/, '');

            const authFilesResponse = await fetch(`${rootUrl}/v0/management/auth-files`, {
                headers: {
                    'Authorization': `Bearer ${managementKey}`,
                },
            });

            if (!authFilesResponse.ok) {
                return {
                    content: [{ type: "text" as const, text: `Error fetching auth files: ${authFilesResponse.status} ${authFilesResponse.statusText}` }],
                    isError: true,
                };
            }

            const authFilesData = await authFilesResponse.json() as any;
            const authFiles = Array.isArray(authFilesData) ? authFilesData : (authFilesData.files || []);

            // 3. Find Target Account
            let targetFile: any;
            if (account) {
                targetFile = authFiles.find((f: any) => f.name === account || f.name.includes(account) || (f.email && f.email === account));
            } else {
                // Default selection
                if (provider === 'codex') {
                    targetFile = authFiles.find((f: any) => f.type === 'codex' || f.name.includes('codex'));
                } else if (provider === 'gemini-cli') {
                    // gemini-cli usually starts with gemini- and ends with .json
                    targetFile = authFiles.find((f: any) => f.name.startsWith('gemini-') && !f.name.includes('antigravity'));
                } else {
                    // Antigravity
                    targetFile = authFiles.find((f: any) => f.name.startsWith('antigravity-'));
                }
            }

            if (!targetFile) {
                return {
                    content: [{ type: "text" as const, text: `Error: No account found for provider '${provider}'${account ? ` matching '${account}'` : ''}.` }],
                    isError: true,
                };
            }

            const authIndex = targetFile.authIndex ?? targetFile.auth_index;
            if (!authIndex) {
                return {
                    content: [{ type: "text" as const, text: `Error: No authIndex found for account '${targetFile.name}'.` }],
                    isError: true,
                };
            }

            // 4. Construct Payload
            let payload: any;
            if (provider === 'codex') {
                const chatgptAccountId = targetFile.chatgpt_account_id ?? targetFile.chatgptAccountId ?? targetFile.account_id ?? targetFile.accountId ?? '';
                const headers: Record<string, string> = {
                    'Authorization': 'Bearer $TOKEN$',
                    'Content-Type': 'application/json',
                    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
                };
                if (chatgptAccountId) {
                    headers['Chatgpt-Account-Id'] = chatgptAccountId;
                }
                payload = {
                    authIndex: String(authIndex),
                    method: 'GET',
                    url: 'https://chatgpt.com/backend-api/wham/usage',
                    header: headers
                };
            } else if (provider === 'gemini-cli') {
                let projectId = targetFile.project_id;
                if (!projectId) {
                    const match = targetFile.name.match(/^gemini-(?:.+?)-(.+?)\.json$/);
                    if (match && match[1]) projectId = match[1];
                    else projectId = 'antigravity-sync-484813';
                }
                payload = {
                    authIndex: String(authIndex),
                    method: 'POST',
                    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
                    header: {
                        'Authorization': 'Bearer $TOKEN$',
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify({ project: projectId })
                };
            } else {
                // Antigravity
                payload = {
                    authIndex: String(authIndex),
                    method: 'POST',
                    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
                    header: {
                        'Authorization': 'Bearer $TOKEN$',
                        'Content-Type': 'application/json',
                        'User-Agent': 'antigravity/1.11.5 windows/amd64'
                    },
                    data: JSON.stringify({ project: 'bamboo-precept-lgxtn' })
                };
            }

            // 5. Call API
            const apiCallResponse = await fetch(`${rootUrl}/v0/management/api-call`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${managementKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!apiCallResponse.ok) {
                const text = await apiCallResponse.text();
                return {
                    content: [{ type: "text" as const, text: `Error fetching quota: ${apiCallResponse.status} ${apiCallResponse.statusText} - ${text}` }],
                    isError: true,
                };
            }

            const data = await apiCallResponse.json();

            // 6. Format Result (Basic)
            const result = {
                provider,
                account: targetFile.name,
                data
            };

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2),
                    },
                ],
            };
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error fetching quota: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
);

// ============================================================================
// Server Startup
// ============================================================================

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Antigravity Proxy MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
