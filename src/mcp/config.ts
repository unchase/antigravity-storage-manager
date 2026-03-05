/**
 * MCP Server Configuration
 * Loads configuration from environment variables or defaults
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface McpConfig {
    proxyPort: number;
    proxyHost: string;
    proxyApiKey: string | null;
    binDir: string;
}

/**
 * Get the bin directory where cliproxy is installed
 */
function getBinDir(): string {
    // Default to extension's bin directory or a known location
    const extensionBinDir = process.env.PROXY_BIN_DIR;
    if (extensionBinDir && fs.existsSync(extensionBinDir)) {
        return extensionBinDir;
    }

    // Fallback: look in common locations
    const possibleDirs = [
        path.join(os.homedir(), '.vscode', 'extensions', 'unchase.antigravity-storage-manager-*', 'bin'),
        path.join(os.homedir(), '.vscode-insiders', 'extensions', 'unchase.antigravity-storage-manager-*', 'bin'),
    ];

    for (const pattern of possibleDirs) {
        const dir = pattern.replace('*', ''); // Basic check
        if (fs.existsSync(dir)) {
            return dir;
        }
    }

    // Default fallback
    return path.join(os.homedir(), '.antigravity-proxy');
}

/**
 * Read API key from config.yaml
 */
function getApiKeyFromConfig(binDir: string): string | null {
    const configPath = path.join(binDir, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        // Look for api-keys section and extract first key
        const match = content.match(/api-keys:\s*\n\s*-\s*["']?([^"'\n\r]+)["']?/);
        if (match) {
            return match[1].trim();
        }
    } catch {
        // Ignore errors
    }
    return null;
}

/**
 * Load MCP configuration
 */
export function loadConfig(): McpConfig {
    const binDir = getBinDir();

    return {
        proxyPort: parseInt(process.env.PROXY_PORT || '8317', 10),
        proxyHost: process.env.PROXY_HOST || '127.0.0.1',
        proxyApiKey: process.env.PROXY_API_KEY || getApiKeyFromConfig(binDir),
        binDir,
    };
}

/**
 * Get proxy base URL
 */
export function getProxyBaseUrl(config: McpConfig): string {
    return `http://${config.proxyHost}:${config.proxyPort}`;
}

/**
 * Check if proxy is running by pinging /v1/models
 */
export async function isProxyRunning(config: McpConfig): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(`${getProxyBaseUrl(config)}/v1/models`, {
            signal: controller.signal,
            headers: config.proxyApiKey ? { 'Authorization': `Bearer ${config.proxyApiKey}` } : {},
        });

        clearTimeout(timeoutId);
        return response.ok || response.status === 401; // 401 means proxy is running but needs auth
    } catch {
        return false;
    }
}
