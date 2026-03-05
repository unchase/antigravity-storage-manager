import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as https from 'https';
import * as nodeCrypto from 'crypto';
import extract from 'extract-zip';
import { LocalizationManager } from '../l10n/localizationManager';

// Define expected binary names based on platform
const BINARY_MAP: { [key: string]: string } = {
    'win32': 'cliproxy.exe',
    'darwin': 'cliproxy',
    'linux': 'cliproxy'
};

const REPO_OWNER = 'router-for-me';
const REPO_NAME = 'CLIProxyAPIPlus';

export enum ProxyStatus {
    Stopped = 'Stopped',
    Starting = 'Starting',
    Running = 'Running',
    Error = 'Error',
    Installing = 'Installing'
}

export interface AccountDetails {
    fileName: string;
    lastModified: Date;
    email?: string;
    user?: string;
    expired?: string;
}

export class ProxyManager {
    private _process: cp.ChildProcess | null = null;
    private _status: ProxyStatus = ProxyStatus.Stopped;
    private _outputChannel: vscode.OutputChannel;
    private _storageRoot: string;
    private _binDir: string;
    private _statusBarItem: vscode.StatusBarItem;
    private _onDidChangeStatus = new vscode.EventEmitter<ProxyStatus>();
    public readonly onDidChangeStatus = this._onDidChangeStatus.event;

    constructor(private context: vscode.ExtensionContext, storageRoot: string) {
        this._storageRoot = storageRoot;
        this._binDir = path.join(this._storageRoot, 'bin');
        this._outputChannel = vscode.window.createOutputChannel('Antigravity Proxy');

        // Initialize status bar
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        this._statusBarItem.command = 'antigravity-storage-manager.statusAction';
        this.updateStatusBar();

        this.context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-storage-manager.proxy.showLog', () => {
                this._outputChannel.show();
            }),
            vscode.commands.registerCommand('antigravity-storage-manager.proxy.openConfig', async () => {
                const configPath = path.join(this._binDir, 'config.yaml');
                if (fs.existsSync(configPath)) {
                    const document = await vscode.workspace.openTextDocument(configPath);
                    await vscode.window.showTextDocument(document);
                } else {
                    vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Config file not found.'));
                }
            })
        );
    }

    public getDashboardState(): any {
        return this.context.globalState.get('antigravity.dashboardState', {});
    }

    public async updateDashboardState(state: any): Promise<void> {
        await this.context.globalState.update('antigravity.dashboardState', state);
    }

    public get status(): ProxyStatus {
        return this._status;
    }

    public async initialize() {
        // Create bin directory if not exists
        if (!fs.existsSync(this._binDir)) {
            fs.mkdirSync(this._binDir, { recursive: true });
        }

        // Check auto-start
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        if (config.get<boolean>('proxy.enabled', false)) {
            await this.start();
        }
    }

    public async setAutoStart(enabled: boolean) {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        await config.update('proxy.enabled', enabled, vscode.ConfigurationTarget.Global);
    }

    public async start(): Promise<void> {
        if (this._status === ProxyStatus.Running || this._status === ProxyStatus.Starting) {
            return;
        }

        const executablePath = this.getExecutablePath();
        if (!fs.existsSync(executablePath)) {
            const lm = LocalizationManager.getInstance();
            const install = lm.t('Install Proxy');
            const result = await vscode.window.showWarningMessage(
                lm.t('Proxy binary not found. Do you want to install it now?'),
                install,
                lm.t('Cancel')
            );

            if (result === install) {
                await this.install();
                // Try starting again after install
                if (fs.existsSync(this.getExecutablePath())) {
                    return this.start();
                }
            }
            return;
        }

        this._status = ProxyStatus.Starting;
        this.updateStatusBar();
        this._outputChannel.appendLine(`[INFO] Starting proxy with binary: ${executablePath}`);
        this._outputChannel.show(true); // Show output channel on start

        try {
            const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
            const port = config.get<number>('proxy.port', 8317);

            // TODO: Argument handling might need adjustment based on specific proxy binary args
            const args: string[] = []; // Standard args if needed

            // Set environment variables if needed
            const env = { ...process.env, PORT: port.toString() };

            // Ensure config.yaml exists
            this.ensureConfigFile(port);

            // Update configuration dynamically
            const configPath = path.join(this._binDir, 'config.yaml');
            this.replaceDefaultApiKeys(configPath);
            this.updateUpstreamProxyUrl(configPath);

            this._process = cp.spawn(executablePath, args, {
                env,
                cwd: this._binDir // Run in bin dir to keep config/logs there
            });

            this._process.stdout?.on('data', (data) => {
                const str = `${data}`;
                this._outputChannel.append(str);
                this.checkOutputForAuthRequests(str);
            });

            this._process.stderr?.on('data', async (data) => {
                const str = `${data}`;
                this._outputChannel.append(`[ERR] ${str}`);

                // Check if port is in use
                if (str.includes('bind: Only one usage of each socket address') || str.includes('address already in use')) {
                    const lm = LocalizationManager.getInstance();
                    const killAction = lm.t('Kill Process on Port {0}', port);
                    const result = await vscode.window.showWarningMessage(
                        lm.t('Antigravity Proxy failed to start because port {0} is in use.', port),
                        killAction
                    );

                    if (result === killAction) {
                        const killed = await this.killProcessOnPort(port);
                        if (killed) {
                            vscode.window.showInformationMessage(lm.t('Process on port {0} killed. Retrying start...', port));
                            // Wait a bit and retry
                            setTimeout(() => this.checkAndStartProxy(), 1000);
                        } else {
                            vscode.window.showErrorMessage(lm.t('Failed to kill process on port {0}. Please kill it manually.', port));
                        }
                    }
                }
            });

            this._process.on('error', (err) => {
                this._outputChannel.appendLine(`[ERROR] Failed to start proxy: ${err.message}`);
                this._status = ProxyStatus.Error;
                this.updateStatusBar();
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Antigravity Proxy Error: {0}', err.message));
            });

            this._process.on('close', (code) => {
                this._outputChannel.appendLine(`[INFO] Proxy process exited with code ${code}`);
                this._status = ProxyStatus.Stopped;
                this._process = null;
                this.updateStatusBar();
            });

            // Consider it running if no immediate error
            // Ideally we should wait for a "Listening" log or check the port
            setTimeout(() => {
                if (this._process && !this._process.killed) {
                    this._status = ProxyStatus.Running;
                    this.updateStatusBar();
                    this._outputChannel.appendLine(`[INFO] Proxy server presumably running on port ${port}`);

                    // Auto-configure VS Code if enabled
                    if (config.get<boolean>('proxy.autoConfig', true)) {
                        this.configureVsCodeProxy(port);
                    }
                }
            }, 2000);

        } catch (e: any) {
            this._status = ProxyStatus.Error;
            this._outputChannel.appendLine(`[EXCEPTION] ${e.message}`);
            this.updateStatusBar();
        }
    }

    public async stop(): Promise<void> {
        if (this._process) {
            this._outputChannel.appendLine(`[INFO] Stopping proxy server...`);

            return new Promise<void>((resolve) => {
                // Determine if process is already dead?
                if (this._process && this._process.killed) {
                    this._process = null;
                    this._status = ProxyStatus.Stopped;
                    this.updateStatusBar();
                    resolve();
                    return;
                }

                this._process?.kill();

                const safeResolve = () => {
                    if (!this._process) return; // Already resolved
                    this._process = null;
                    this._status = ProxyStatus.Stopped;
                    this.updateStatusBar();
                    // Add a small buffer to allow OS to release port
                    setTimeout(() => resolve(), 500);
                };

                this._process?.once('close', safeResolve);
                this._process?.once('exit', safeResolve);

                // Failsafe timeout
                setTimeout(() => {
                    if (this._process) {
                        this._outputChannel.appendLine(`[WARN] Proxy stop timed out, forcing resolve.`);
                        safeResolve();
                    }
                }, 3000);
            });
        }
        this._status = ProxyStatus.Stopped;
        this.updateStatusBar();
    }

    private ensureConfigFile(port: number, secretKey?: string) {
        const configPath = path.join(this._binDir, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            // Try to find config.example.yaml
            const examplePath = this.findFileRecursively(this._binDir, 'config.example.yaml');

            if (examplePath) {
                try {
                    fs.copyFileSync(examplePath, configPath);
                    // Update port and secret-key in the copied file
                    let content = fs.readFileSync(configPath, 'utf8');
                    // Replace port
                    content = content.replace(/^port:\s*\d+/m, `port: ${port}`);
                    // Replace secret-key if provided
                    if (secretKey) {
                        // Regex matches "secret-key: " followed by quotes or not, inside remote-management block or global?
                        content = content.replace(/secret-key:\s*["']?.*["']?/g, `secret-key: "${secretKey}"`);
                    }
                    fs.writeFileSync(configPath, content);

                    // Replace default API keys
                    this.replaceDefaultApiKeys(configPath);
                } catch (e) {
                    this._outputChannel.appendLine(`[WARN] Failed to copy example config: ${e}`);
                    this.createMinimalConfig(configPath, port, secretKey);
                }
            } else {
                this.createMinimalConfig(configPath, port, secretKey);
            }
        }
    }

    private replaceDefaultApiKeys(configPath: string) {
        try {
            if (!fs.existsSync(configPath)) return;

            let content = fs.readFileSync(configPath, 'utf8');
            let updated = false;

            // Regex to find "your-api-key-X" (in quotes or not)
            // config.yaml example: - "your-api-key-1"
            const regex = /(["']?)(your-api-key-\d+)\1/g;

            if (regex.test(content)) {
                content = content.replace(regex, (_match, quote, _keyName) => {
                    updated = true;
                    // Use nodeCrypto to avoid conflict with Web Crypto API
                    const randomKey = 'sk-antigravity-' + nodeCrypto.randomBytes(8).toString('hex');
                    return `${quote}${randomKey}${quote}`;
                });
            }

            if (updated) {
                fs.writeFileSync(configPath, content);
                this._outputChannel.appendLine('[INFO] Replaced default API keys with random values.');
            }
        } catch (e) {
            this._outputChannel.appendLine(`[WARN] Failed to replace default API keys: ${e}`);
        }
    }

    private updateUpstreamProxyUrl(configPath: string) {
        try {
            if (!fs.existsSync(configPath)) return;

            const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
            const upstream = config.get<string>('proxy.upstreamUrl');

            if (upstream && upstream.trim().length > 0) {
                const content = fs.readFileSync(configPath, 'utf8');
                // Regex to find proxy-url: "" or proxy-url: "..."
                // config.yaml example: proxy-url: ""
                const regex = /proxy-url:\s*["']?.*["']?/g;

                if (regex.test(content)) {
                    // Update only if different to avoid timestamp jitter if we cared, but straightforward verify is ok
                    const newMatch = `proxy-url: "${upstream}"`;
                    if (!content.includes(newMatch)) { // Simple check to avoid write if already set
                        const newContent = content.replace(regex, newMatch);
                        fs.writeFileSync(configPath, newContent);
                        this._outputChannel.appendLine(`[INFO] Updated proxy-url to ${upstream}`);
                    }
                } else {
                    // If key missing, append it? The minimal config doesn't have it explicitly maybe?
                    // The example config has it. 
                    // createMinimalConfig doesn't.
                    // If minimal config, we might want to append.
                    // But let's assume it exists or we append it.
                    // If not found, append to end of file?
                    // Better to adhere to structure.
                    // For now, if not found, we append.
                    if (content.indexOf('proxy-url:') === -1) {
                        fs.appendFileSync(configPath, `\nproxy-url: "${upstream}"\n`);
                        this._outputChannel.appendLine(`[INFO] Appended proxy-url: ${upstream}`);
                    }
                }
            }
        } catch (e) {
            this._outputChannel.appendLine(`[WARN] Failed to update upstream proxy URL: ${e}`);
        }
    }

    private createMinimalConfig(configPath: string, port: number, secretKey?: string) {
        const keyConfig = secretKey ? `  secret-key: "${secretKey}"` : `  secret-key: ""`;
        const content = `port: ${port}
host: "127.0.0.1"
# Antigravity Proxy Configuration
remote-management:
  allow-remote: false
${keyConfig}
`;
        fs.writeFileSync(configPath, content);
    }

    private async askForSecretKey(): Promise<string> {
        const lm = LocalizationManager.getInstance();
        const result = await vscode.window.showInputBox({
            title: lm.t('Set Proxy Web UI Password'),
            prompt: lm.t('Enter a password to secure the Management Dashboard (saved in config.yaml). Leave empty for no password.'),
            password: true,
            ignoreFocusOut: true
        });
        return result || '';
    }



    public getApiKeys(): { key: string, visible: boolean }[] {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) {
                return [];
            }
            const content = fs.readFileSync(configPath, 'utf8');

            const keys: { key: string, visible: boolean }[] = [];
            const lines = content.split('\n');
            let inApiKeys = false;

            for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed.startsWith('api-keys:')) {
                    inApiKeys = true;
                    continue;
                }

                if (inApiKeys) {
                    if (line.match(/^\S/) && !line.startsWith('-') && !line.startsWith('#')) {
                        inApiKeys = false;
                        continue;
                    }

                    // Handle active keys
                    if (trimmed.startsWith('-')) {
                        const val = trimmed.substring(1).trim();
                        const cleanVal = val.replace(/^["']|["']$/g, '');
                        if (cleanVal) keys.push({ key: cleanVal, visible: true });
                    }
                    // Handle commented keys
                    else if (trimmed.startsWith('#')) {
                        // Check if it's a commented list item: # - "key" or #   - "key"
                        const uncommented = trimmed.replace(/^#\s*/, '');
                        if (uncommented.startsWith('-')) {
                            const val = uncommented.substring(1).trim();
                            const cleanVal = val.replace(/^["']|["']$/g, '');
                            if (cleanVal) keys.push({ key: cleanVal, visible: false });
                        }
                    }
                }
            }
            return keys;
        } catch (e) {
            this._outputChannel.appendLine(`[WARN] Failed to parse API keys: ${e}`);
            return [];
        }
    }

    public toggleApiKey(key: string) {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return;

            const content = fs.readFileSync(configPath, 'utf8');
            const lines = content.split('\n');
            const newLines: string[] = [];
            let inApiKeys = false;
            let toggled = false;

            for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed.startsWith('api-keys:')) {
                    inApiKeys = true;
                    newLines.push(line);
                    continue;
                }

                if (inApiKeys) {
                    if (line.match(/^\S/) && !line.startsWith('-') && !line.startsWith('#')) {
                        inApiKeys = false;
                        newLines.push(line);
                        continue;
                    }

                    // Check if this line contains our key
                    if (line.includes(key) && !toggled) {
                        // Toggle logic
                        if (trimmed.startsWith('#')) {
                            // Uncomment
                            // Preserve indentation if possible, usually just remove # and following space
                            newLines.push(line.replace(/^(\s*)#\s*/, '$1'));
                        } else {
                            // Comment
                            newLines.push(line.replace(/^(\s*)/, '$1# '));
                        }
                        toggled = true; // prevent multiple toggles if dupes exist
                        continue;
                    }
                }
                newLines.push(line);
            }

            if (toggled) {
                fs.writeFileSync(configPath, newLines.join('\n'));
                this.updateStatusBar();
            }
        } catch (e) {
            this._outputChannel.appendLine(`[ERROR] Failed to toggle API key: ${e}`);
        }
    }

    public generateApiKey(): string {
        const key = 'sk-' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) {
                this.createMinimalConfig(configPath, 8317);
            }
            let content = fs.readFileSync(configPath, 'utf8');

            if (content.indexOf('api-keys:') !== -1) {
                // Find where the section starts and insert after it
                const lines = content.split('\n');
                let insertIdx = -1;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].trim().startsWith('api-keys:')) {
                        insertIdx = i + 1;
                        break;
                    }
                }
                if (insertIdx !== -1) {
                    lines.splice(insertIdx, 0, `  - "${key}"`);
                    content = lines.join('\n');
                }
            } else {
                // Append to the end
                content += `\napi-keys:\n  - "${key}"\n`;
            }
            fs.writeFileSync(configPath, content);
            this._onDidChangeStatus.fire(this._status);
            this.updateStatusBar();
            return key;
        } catch (e) {
            this._outputChannel.appendLine(`[WARN] Failed to generate API key: ${e}`);
            return '';
        }
    }

    private findFileRecursively(dir: string, filename: string): string | null {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            let stat;
            try {
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }

            if (stat.isDirectory()) {
                const found = this.findFileRecursively(filePath, filename);
                if (found) return found;
            } else if (file === filename) {
                return filePath;
            }
        }
        return null;
    }

    private findExecutableRecursively(dir: string, platform: string): string | null {
        const extension = platform === 'win32' ? '.exe' : '';
        const files = fs.readdirSync(dir);

        for (const file of files) {
            const filePath = path.join(dir, file);
            let stat;
            try {
                stat = fs.statSync(filePath);
            } catch {
                continue; // Skip inaccessible files
            }

            if (stat.isDirectory()) {
                const found = this.findExecutableRecursively(filePath, platform);
                if (found) return found;
            } else if (file.endsWith(extension)) {
                // Check if it matches likely names
                const name = file.toLowerCase();
                if (name.includes('cliproxy') || name.includes('vibe-proxy') || name.includes('proxy')) {
                    // Avoid matching "proxy.zip" or "proxy.tar.gz" if somehow they linger or match extension logic
                    if (name === 'proxy.zip' || name === 'proxy.tar.gz') continue;
                    return filePath;
                }
            }
        }
        return null;
    }

    public async install() {
        this._status = ProxyStatus.Installing;
        this.updateStatusBar();
        const lm = LocalizationManager.getInstance();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: lm.t('Installing Antigravity Proxy...'),
            cancellable: false
        }, async (progress) => {
            try {
                const platform = process.platform;
                const arch = process.arch;

                // 1. Fetch Release Info
                progress.report({ message: lm.t('Check for updates...') });
                const releasesUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
                const release = await this.fetchJson(releasesUrl);

                if (!release || !release.assets) {
                    throw new Error('Failed to fetch release information');
                }

                // 2. Find Asset
                const keywords = this.getAssetKeywords(platform, arch);
                const asset = release.assets.find((a: any) =>
                    keywords.every(k => a.name.toLowerCase().includes(k)) &&
                    (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz'))
                );

                if (!asset) {
                    throw new Error(`No compatible binary found for ${platform}-${arch}`);
                }

                // 3. Download
                progress.report({ message: lm.t('Downloading proxy binary...') });
                const downloadUrl = asset.browser_download_url;
                const isZip = asset.name.endsWith('.zip');
                const downloadDest = path.join(this._binDir, isZip ? 'proxy.zip' : 'proxy.tar.gz');

                await this.downloadFile(downloadUrl, downloadDest);

                // 4. Extract
                progress.report({ message: lm.t('Extracting...') });
                if (isZip) {
                    await extract(downloadDest, { dir: this._binDir });
                } else {
                    if (platform !== 'win32') {
                        try {
                            cp.execSync(`tar -xzf "${downloadDest}" -C "${this._binDir}"`);
                        } catch (tarErr) {
                            throw new Error('Failed to extract tar.gz: ' + tarErr);
                        }
                    }
                }

                // 5. Cleanup and Rename
                fs.unlinkSync(downloadDest);

                // Find the executable in _binDir (recursively)
                const exeFile = this.findExecutableRecursively(this._binDir, platform);

                if (exeFile) {
                    const newPath = this.getExecutablePath();

                    // Stop any running instance before overwriting
                    await this.stop();

                    // Allow file system to release locks
                    await new Promise(r => setTimeout(r, 1000));

                    // If target exists, remove it
                    if (fs.existsSync(newPath)) {
                        try { fs.unlinkSync(newPath); } catch { /* ignore */ }
                    }

                    // Move/Rename
                    // Since it might be in a subdir, we copy it to _binDir root (newPath)
                    fs.copyFileSync(exeFile, newPath);

                    if (platform !== 'win32') {
                        fs.chmodSync(newPath, 0o755);
                    }

                    // Prompt for Secret Key FIRST time installation
                    const configPath = path.join(this._binDir, 'config.yaml');
                    if (!fs.existsSync(configPath)) {
                        const secretKey = await this.askForSecretKey();
                        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                        const port = config.get<number>('proxy.port', 8317);
                        this.ensureConfigFile(port, secretKey);
                    }

                    vscode.window.showInformationMessage(
                        lm.t('Antigravity Proxy installed successfully to {0}!', newPath),
                        lm.t('Open Folder')
                    ).then(selection => {
                        if (selection === lm.t('Open Folder')) {
                            vscode.env.openExternal(vscode.Uri.file(this._binDir));
                        }
                    });
                    this._status = ProxyStatus.Stopped;
                } else {
                    throw new Error('Executable not found in extracted archive');
                }

            } catch (e: any) {
                vscode.window.showErrorMessage(lm.t('Installation failed: {0}', e.message));
                this._status = ProxyStatus.Error;
                this._outputChannel.appendLine(`[INSTALL ERROR] ${e.message}`);
            }
        });

        this.updateStatusBar();
    }

    private getAssetKeywords(platform: string, arch: string): string[] {
        const keywords: string[] = [];
        if (platform === 'win32') keywords.push('windows');
        else if (platform === 'darwin') keywords.push('darwin');
        else keywords.push('linux');

        if (arch === 'x64') keywords.push('amd64');
        else if (arch === 'arm64') keywords.push('arm64');

        return keywords;
    }

    public fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const opts = {
                headers: {
                    'User-Agent': 'VSCode-Antigravity-Extension',
                    ...headers
                }
            };

            const isHttps = url.startsWith('https:');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const requestModule = isHttps ? https : require('http');

            requestModule.get(url, opts, (res: any) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`Request failed with status ${res.statusCode}`));
                }
                let data = '';
                res.on('data', (chunk: any) => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    }

    private downloadFile(url: string, dest: string, token?: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve, reject) => {
            if (token?.isCancellationRequested) {
                return reject(new Error('Cancelled'));
            }

            const file = fs.createWriteStream(dest);
            const opts: https.RequestOptions = {
                headers: {
                    'User-Agent': 'VSCode-Antigravity-Extension'
                }
            };

            const request = https.get(url, opts, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    file.close();
                    fs.unlinkSync(dest);
                    if (response.headers.location) {
                        resolve(this.downloadFile(response.headers.location, dest, token));
                    } else {
                        reject(new Error('Redirect location missing'));
                    }
                    return;
                }

                if (response.statusCode !== 200) {
                    file.close();
                    if (fs.existsSync(dest)) fs.unlinkSync(dest);
                    reject(new Error(`Download failed Status ${response.statusCode}`));
                    return;
                }

                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve();
                });

                file.on('error', (err) => { // Handle file errors during pipe
                    file.close();
                    if (fs.existsSync(dest)) fs.unlinkSync(dest);
                    reject(err);
                });
            });

            request.on('error', (err) => {
                file.close();
                if (fs.existsSync(dest)) fs.unlinkSync(dest);
                reject(err);
            });

            if (token) {
                token.onCancellationRequested(() => {
                    request.destroy();
                    file.close();
                    if (fs.existsSync(dest)) fs.unlinkSync(dest);
                    reject(new Error('Cancelled'));
                });
            }
        });
    }

    public getExecutablePath(): string {
        const platform = process.platform;
        const binName = BINARY_MAP[platform] || 'cliproxy';
        // Allow override via settings
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const customPath = config.get<string>('proxy.binaryPath');
        if (customPath && customPath.trim().length > 0) {
            return customPath;
        }
        return path.join(this._binDir, binName);
    }

    private async checkAndStartProxy(): Promise<boolean> {
        if (this._status === ProxyStatus.Running) return true;

        const lm = LocalizationManager.getInstance();
        const action = await vscode.window.showWarningMessage(
            lm.t('Antigravity Proxy is not running. Would you like to start it?'),
            lm.t('Start Proxy')
        );

        if (action === lm.t('Start Proxy')) {
            await this.start();
            return this.status === ProxyStatus.Running;
        }
        return false;
    }

    private updateStatusBar() {
        const lm = LocalizationManager.getInstance();
        if (this._status === ProxyStatus.Running) {
            this._statusBarItem.text = `$(radio-tower) ${lm.t('AG Proxy: ON')}`;
            this._statusBarItem.backgroundColor = undefined;
            this._statusBarItem.show();
        } else if (this._status === ProxyStatus.Starting) {
            this._statusBarItem.text = `$(sync~spin) ${lm.t('AG Proxy: Starting')}`;
            this._statusBarItem.show();
        } else if (this._status === ProxyStatus.Error) {
            this._statusBarItem.text = `$(error) ${lm.t('AG Proxy: Error')}`;
            this._statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this._statusBarItem.show();
        } else {
            // Stopped
            this._statusBarItem.text = `$(circle-slash) ${lm.t('AG Proxy: OFF')}`;
            // Only show if setting enabled or user manually stopped?
            // Maybe hide when stopped to avoid clutter?
            // Let's show it so they can easily start it.
            // Let's show it so they can easily start it.
            this._statusBarItem.show();
        }

        this._onDidChangeStatus.fire(this._status);
    }

    private async configureVsCodeProxy(_port: number) {
        // Optional: Configure VS Code to use this proxy
        // const config = vscode.workspace.getConfiguration('http');
        // await config.update('proxy', `http://127.0.0.1:${port}`, vscode.ConfigurationTarget.Global);
        // Warning: This affects ALL traffic. Might be aggressive.
    }

    private checkOutputForAuthRequests(log: string) {
        // Broaden check to capture various Device Flow URLs
        // github.com/login/device, google.com/device, or others
        // Pattern: look for a URL and a Code in close proximity

        // GitHub specific
        if (log.includes('github.com/login/device') && log.includes('code')) {
            const codeMatch = log.match(/code\s+([A-Z0-9-]{8,9})/);
            if (codeMatch) {
                this.showAuthNotification('GitHub Copilot', 'https://github.com/login/device', codeMatch[1]);
                return;
            }
        }

        // Generic / Antigravity catch-all (if they use different URL)
        // Example: "Please visit https://... and enter code XXXX"
        // RegExp for URL: https?:\/\/[^\s]+
        // RegExp for Code: [A-Z0-9]{4,9}-[A-Z0-9]{4,9} or similar

        // If "antigravity" provider is active or we see relevant logs
        if (log.toLowerCase().includes('authenticate') || log.toLowerCase().includes('login')) {
            // Try to extract URL and Code if present and not already handled
            const urlMatch = log.match(/(https?:\/\/[^\s]+device[^\s]*)/); // weak heuristic for device url
            const codeMatch = log.match(/code[:\s]+([A-Z0-9-]{4,12})/i);

            if (urlMatch && codeMatch && !log.includes('github.com')) {
                this.showAuthNotification('Antigravity/Provider', urlMatch[1], codeMatch[1]);
            }
        }
    }

    private showAuthNotification(provider: string, url: string, code: string) {
        const lm = LocalizationManager.getInstance();
        vscode.window.showInformationMessage(
            lm.t('{0} Auth Required. Code: {1}', provider, code),
            lm.t('Open URL'),
            lm.t('Copy Code')
        ).then(selection => {
            if (selection === lm.t('Open URL')) {
                vscode.env.openExternal(vscode.Uri.parse(url));
            } else if (selection === lm.t('Copy Code')) {
                vscode.env.clipboard.writeText(code);
            }
        });
    }

    public async addProvider(providerId: string, data: any) {
        const configPath = path.join(this._binDir, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Config file not found. Please start proxy once to generate it.'));
            return;
        }

        try {
            let content = fs.readFileSync(configPath, 'utf8');

            // 1. Ensure "providers:" section exists
            // If completely missing, add it to the end
            if (!content.includes('providers:')) {
                content += '\nproviders:\n';
            }

            // 2. Handle empty array syntax "providers: []"
            // Replace it with "providers:" so we can append items
            content = content.replace(/providers:\s*\[\]/g, 'providers:');

            // 3. Check for duplicates
            if (content.includes(`id: "${providerId}"`)) {
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Provider {0} already configured. Opening config...', providerId));
                vscode.commands.executeCommand('antigravity-storage-manager.proxy.openConfig');
                return;
            }

            // 4. Prepare new config block
            // Handle Z.AI specifically first, as it goes into a different section
            if (providerId === 'z-ai') {
                // OpenAI Compatibility Logic
                if (!data.apiKey) return;

                // Consolidated Z.AI Logic: Remove existing (active/commented) then Append New

                // 1. Remove any existing Z.AI configuration first
                // Use backreference \1 to ensure we only stop at SIBLINGS (same indent), preventing premature stop at nested "- name:"
                // We restrict looking for "#" to having at most ONE space after it, to avoid matching nested indented comments like "#   - name:"
                const purgeRegex = /(\n\s*)(?:#\s*)?(- name: ["']?z-ai["']?[\s\S]*?)(?=\1(?:#[ \t]?)?- name:|\r?\n[a-zA-Z]|\r?\n#[ \t]?[a-zA-Z0-9_-]+:|$)/g;
                content = content.replace(purgeRegex, '');

                // 2. Prepare Block - Register all supported models
                const block = `
  - name: "z-ai"
    prefix: "z-ai"
    base-url: "https://api.z.ai/api/paas/v4/"
    api-key-entries:
      - api-key: "${data.apiKey}"
    models:
      - name: "glm-4-plus"
        alias: "glm-4-plus"
      - name: "glm-4.7"
        alias: "glm-4.7"
      - name: "glm-4.6"
        alias: "glm-4.6"`;
                // 3. Insert Strategy
                // Strategy A: If there is an ACTIVE openai-compatibility section, append to it (respecting YAML)
                // We assume active if we see "openai-compatibility:" at start of line
                const activeSectionRegex = /(^openai-compatibility:\s*)((?:.|\r?\n)*?)(\r?\n[a-zA-Z]|\r?\n#[ \t]?[a-zA-Z0-9_-]+:|$)/m;

                if (activeSectionRegex.test(content)) {
                    // Append to existing active section
                    content = content.replace(activeSectionRegex, `$1$2${block}$3`);
                } else {
                    // Strategy B: No active section? Append NEW active section at the VERY END of file
                    content = content.trimEnd() + `\n\nopenai-compatibility:${block}\n`;
                }

                fs.writeFileSync(configPath, content);
                const action = await vscode.window.showInformationMessage(
                    LocalizationManager.getInstance().t('Z.AI configured. Please reload window to apply changes.'),
                    LocalizationManager.getInstance().t('Reload Window')
                );
                if (action === LocalizationManager.getInstance().t('Reload Window')) {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
                return;
            }

            // Handle Kiro (AWS) specifically
            if (providerId === 'kiro') {
                if (!content.includes('kiro:')) content += '\nkiro:\n';
                content = content.replace('#kiro:', 'kiro:');
                const block = `  - token-file: "~/.aws/sso/cache/kiro-auth-token.json"\n`;
                const regex = /(kiro:.*)/;
                if (regex.test(content)) {
                    content = content.replace(regex, `$1${block}`);
                    fs.writeFileSync(configPath, content);
                    vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Kiro configured. Restarting proxy...'));
                    await this.stop();
                    setTimeout(() => this.start(), 1000);
                    return;
                }
            }

            // Handle Claude specifically
            if (providerId === 'claude') {
                if (!content.includes('claude-api-key:')) content += '\nclaude-api-key:\n';
                content = content.replace('# claude-api-key:', 'claude-api-key:');
                const block = `  - api-key: "${data.apiKey}"\n`;
                const regex = /(claude-api-key:.*)/;
                if (regex.test(content)) {
                    content = content.replace(regex, `$1${block}`);
                    fs.writeFileSync(configPath, content);
                    vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Claude configured. Restarting proxy...'));
                    await this.stop();
                    setTimeout(() => this.start(), 1000);
                    return;
                }
            }

            // Handle Codex specifically
            if (providerId === 'codex') {
                if (!content.includes('codex-api-key:')) content += '\ncodex-api-key:\n';
                content = content.replace('# codex-api-key:', 'codex-api-key:');
                const block = `  - api-key: "${data.apiKey}"\n`;
                const regex = /(codex-api-key:.*)/;
                if (regex.test(content)) {
                    content = content.replace(regex, `$1${block}`);
                    fs.writeFileSync(configPath, content);
                    vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Codex configured. Restarting proxy...'));
                    await this.stop();
                    setTimeout(() => this.start(), 1000);
                    return;
                }
            }

            // Handle Vertex specifically
            if (providerId === 'vertex') {
                if (!content.includes('vertex-api-key:')) content += '\nvertex-api-key:\n';
                content = content.replace('# vertex-api-key:', 'vertex-api-key:');
                const block = `  - api-key: "${data.apiKey}"\n`;
                const regex = /(vertex-api-key:.*)/;
                if (regex.test(content)) {
                    content = content.replace(regex, `$1${block}`);
                    fs.writeFileSync(configPath, content);
                    vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Vertex configured. Restarting proxy...'));
                    await this.stop();
                    setTimeout(() => this.start(), 1000);
                    return;
                }
            }

            // Handle GitHub Copilot specifically
            if (providerId === 'github-copilot') {
                try {
                    // 1. Get auth-dir from config (default to ~/.cli-proxy-api)
                    const authDirMatch = content.match(/auth-dir:\s*["']?([^"'\n\r]+)["']?/);
                    let authDir = authDirMatch ? authDirMatch[1].trim() : path.join(os.homedir(), '.cli-proxy-api');
                    // Expand ~ to home directory
                    authDir = authDir.replace(/^~/, os.homedir());
                    // Handle Windows escaped backslashes
                    authDir = authDir.replace(/\\\\/g, '\\');

                    // 2. Get GitHub OAuth session
                    const session = await vscode.authentication.getSession('github', ['copilot'], { createIfNone: true });
                    if (!session) {
                        vscode.window.showErrorMessage(LocalizationManager.getInstance().t('GitHub Sign In cancelled'));
                        return;
                    }

                    // 3. Ensure auth-dir exists and save token
                    if (!fs.existsSync(authDir)) {
                        fs.mkdirSync(authDir, { recursive: true });
                    }
                    const tokenPath = path.join(authDir, 'github-copilot.json');
                    const tokenData = {
                        access_token: session.accessToken, // Antigravity style
                        oauth_token: session.accessToken,  // GitHub style
                        user: session.account.label,
                        timestamp: Date.now(),
                        type: 'github-copilot'
                    };
                    fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2));

                    // 4. Update config.yaml with github-copilot section (if needed)
                    // Use absolute path to avoid issues with ~ expansion on Windows
                    const tokenAbsPath = tokenPath.replace(/\\/g, '/'); // Ensure forward slashes for YAML
                    // On Windows, drive letter might need handling? NodeJS path.join usually gives backslashes.
                    // Converting to forward slashes is generally safer for YAML/Cross-platform tools if they support it.

                    let configChanged = false;

                    // Regex to find existing github-copilot section
                    const copilotSectionRegex = /github-copilot:\s*\n\s+-\s+token-file:\s*["']?([^"'\n\r]+)["']?/;
                    const match = content.match(copilotSectionRegex);

                    if (match) {
                        // Section exists, check if path matches
                        const currentPath = match[1];
                        if (currentPath !== tokenAbsPath) {
                            // Update path
                            content = content.replace(copilotSectionRegex, `github-copilot:\n  - token-file: "${tokenAbsPath}"`);
                            configChanged = true;
                        }
                    } else {
                        // Insert github-copilot section BEFORE providers: section
                        const providersRegex = /^providers:/m;
                        const newSection = `github-copilot:\n  - token-file: "${tokenAbsPath}"\n\n`;

                        if (providersRegex.test(content)) {
                            content = content.replace(providersRegex, newSection + 'providers:');
                        } else {
                            // No providers section, append to end
                            content += `\n${newSection}`;
                        }
                        configChanged = true;
                    }

                    if (configChanged) {
                        fs.writeFileSync(configPath, content);
                    }

                    const lm = LocalizationManager.getInstance();
                    const openFileAction = lm.t('Open File');
                    vscode.window.showInformationMessage(
                        lm.t('GitHub Copilot signed in successfully! Token saved to {0}', tokenPath),
                        openFileAction
                    ).then(selection => {
                        if (selection === openFileAction) {
                            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(tokenPath));
                        }
                    });

                    // 5. Restart proxy only if config changed
                    if (configChanged) {
                        await this.stop();
                        setTimeout(() => this.start(), 1000);
                    }
                    return;
                } catch (e: any) {
                    vscode.window.showErrorMessage(LocalizationManager.getInstance().t('GitHub Sign In failed: {0}', e.message));
                    return;
                }
            }

            // Handle Antigravity specifically (Model Alias)
            if (providerId === 'antigravity') {
                // Ensure oauth-model-alias section exists
                if (!content.includes('oauth-model-alias:')) {
                    content += '\noauth-model-alias:\n';
                }
                content = content.replace('#oauth-model-alias:', 'oauth-model-alias:');

                // Ensure antigravity subsection exists under oauth-model-alias
                if (!content.includes('  antigravity:')) {
                    // Check if oauth-model-alias is empty or has content
                    const regex = /(oauth-model-alias:)/;
                    content = content.replace(regex, '$1\n  antigravity:');
                }

                // Prepare alias block
                const modelName = data.model || 'gemini-3-pro-high';
                // We add a mapping ensuring the selected model is aliased to itself or a default alias if needed.
                // Here we just map it to itself to ensure it's enabled/visible if that's the channel logic
                const aliasBlock = `    - name: "${modelName}"\n      alias: "${modelName}"\n`;

                const regex = /( {2}antigravity:.*)/;
                if (regex.test(content)) {
                    content = content.replace(regex, `$1\n${aliasBlock}`);
                    fs.writeFileSync(configPath, content);
                    vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Antigravity model {0} configured. Restarting proxy...', modelName));
                    await this.stop();
                    setTimeout(() => this.start(), 1000);
                    return;
                }
            }

            // Now, handle other providers that go into the 'providers:' section
            let newConfigBlock = '';

            // github-copilot removed from here
            // Antigravity is now handled above
            if (providerId === 'gemini') {
                if (data.mode === 'key') {
                    if (!data.apiKey) return;

                    // Use gemini-api-key top-level section
                    if (!content.includes('gemini-api-key:')) content += '\ngemini-api-key:\n';
                    content = content.replace('# gemini-api-key:', 'gemini-api-key:');

                    const block = `  - api-key: "${data.apiKey}"
    models:
      - name: "${data.model || 'gemini-2.0-flash-exp'}"
        alias: "${data.model || 'gemini-2.0-flash-exp'}"
`;
                    const regex = /(gemini-api-key:.*)/;
                    if (regex.test(content)) {
                        content = content.replace(regex, `$1${block}`);
                        fs.writeFileSync(configPath, content);
                        const action = await vscode.window.showInformationMessage(
                            LocalizationManager.getInstance().t('Gemini API Key configured. Please reload window to apply changes.'),
                            LocalizationManager.getInstance().t('Reload Window')
                        );
                        if (action === LocalizationManager.getInstance().t('Reload Window')) {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                        return;
                    }

                } else if (data.mode === 'oauth') {
                    if (!data.clientId || !data.clientSecret) return;
                    newConfigBlock = `
  - id: "gemini"
    provider: "gemini"
    model: "${data.model || 'gemini-2.0-flash-exp'}"
    client_id: "${data.clientId}"
    client_secret: "${data.clientSecret}"
`;
                }
            }


            if (newConfigBlock) {
                // 5. Insert the new block safely
                // We insert it immediately after "providers:" to avoid indentation issues at the end of file
                // Find the index of "providers:"
                // We use a regex to match "providers:" allowing for potential trailing spaces/newlines

                const regex = /(providers:.*)/;
                if (regex.test(content)) {
                    // Replace "providers:" with "providers:" + newConfigBlock
                    // Note: newConfigBlock starts with newline and indentation
                    content = content.replace(regex, `$1${newConfigBlock}`);

                    fs.writeFileSync(configPath, content);

                    const action = await vscode.window.showInformationMessage(
                        LocalizationManager.getInstance().t('Provider {0} added. Please reload window to apply changes.', providerId),
                        LocalizationManager.getInstance().t('Reload Window')
                    );
                    if (action === LocalizationManager.getInstance().t('Reload Window')) {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                } else {
                    throw new Error(LocalizationManager.getInstance().t('Could not find providers section even after ensuring it exists.'));
                }
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to add provider: {0}', e.message));
        }
    }

    public async testProvider(providerId: string, model: string) {
        if (!(await this.checkAndStartProxy())) return;

        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const port = config.get<number>('proxy.port', 8317);

        this._outputChannel.appendLine(`[TEST] Testing provider: ${providerId}, model: ${model}`);

        // Simple test prompt
        // OAuth channels auto-detect from token files in auth-dir, no prefix needed
        // Only openai-compatibility providers (like z-ai) need prefix-based routing
        // Only openai-compatibility providers (like z-ai) need prefix-based routing
        const oauthChannels = ['gemini', 'antigravity', 'kiro', 'claude', 'codex', 'qwen', 'iflow', 'vertex', 'aistudio', 'gemini-cli'];
        let finalModel = model || 'gpt-3.5-turbo';

        // Add providerId prefix ONLY for openai-compatibility providers (not OAuth channels)
        if (providerId && !finalModel.includes('/') && !oauthChannels.includes(providerId)) {
            finalModel = `${providerId}/${finalModel}`;
        }

        const payload = JSON.stringify({
            model: finalModel,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5
        });

        this._outputChannel.appendLine(`[TEST] Sending payload: ${payload}`);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };

        // Add User-Agent for OAuth channel routing
        // The proxy uses User-Agent to identify which OAuth channel to route to
        const userAgentMap: Record<string, string> = {
            'antigravity': 'Antigravity/1.0.0',
            'gemini': 'gemini-cli/1.0.0',
            'gemini-cli': 'gemini-cli/1.0.0',
            'github-copilot': 'GithubCopilot/1.0',
            'claude': 'claude-code/1.0.0',
            'codex': 'codex-cli/1.0.0',
            'kiro': 'kiro-cli/1.0.0',
            'qwen': 'qwen-cli/1.0.0',
            'iflow': 'iflow-cli/1.0.0',
            'vertex': 'vertex-cli/1.0.0',
            'aistudio': 'aistudio-cli/1.0.0'
        };
        if (userAgentMap[providerId]) {
            headers['User-Agent'] = userAgentMap[providerId];
        }

        const keysObj = this.getApiKeys();
        const activeKeys = keysObj.filter(k => k.visible).map(k => k.key);
        if (activeKeys && activeKeys.length > 0) {
            headers['Authorization'] = `Bearer ${activeKeys[0]}`;
            this._outputChannel.appendLine(`[TEST] Using local API key for authorization (Ending in ...${activeKeys[0].slice(-4)})`);
        } else {
            // Fallback for auth-less local access if configured (otherwise will likely fail with 401)
            headers['Authorization'] = 'Bearer test-key';
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for provider tests

            const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
                method: 'POST',
                headers,
                body: payload,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                const data = await response.json() as any;
                const content = data.choices?.[0]?.message?.content || JSON.stringify(data).substring(0, 100) + '...';
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Test connection to {0} successful! Model: {1}. Response: "{2}"', providerId, model, content));
                this._outputChannel.appendLine(`[TEST] ${providerId} success: ${JSON.stringify(data)}`);
            } else {
                const text = await response.text();
                this._outputChannel.appendLine(`[TEST] ${providerId} failed (Status: ${response.status} ${response.statusText}): ${text}`);
                const lm = LocalizationManager.getInstance();
                if (response.status === 401) {
                    vscode.window.showErrorMessage(lm.t('Test failed: 401 Unauthorized. Ensure your local API keys are correct.'));
                } else {
                    vscode.window.showErrorMessage(lm.t('Test failed: {0} {1}. {2}', response.status, response.statusText, text));
                }
            }

        } catch (error: any) {
            let errorMsg = error.message;
            if (error.name === 'AbortError') {
                errorMsg = 'Request timed out (15s)';
            }
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Test request failed: {0}', errorMsg));
            this._outputChannel.appendLine(`[TEST] Error testing ${providerId}: ${errorMsg}`);
        }
    }

    public async initiateOAuthFlow(provider: string) {
        if (this.status !== ProxyStatus.Running) {
            const lm = LocalizationManager.getInstance();
            const startOption = lm.t('Start Proxy');
            const result = await vscode.window.showWarningMessage(lm.t('Proxy is not running'), startOption);
            if (result === startOption) {
                this.start();
            }
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: LocalizationManager.getInstance().t('Initializing Antigravity Login...'),
            cancellable: false
        }, async (progress) => {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) {
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Config file not found.'));
                return;
            }

            try {
                // Helper to get config content
                let content = fs.readFileSync(configPath, 'utf8');
                // Regex to match secret-key with double quotes, single quotes, or no quotes
                const secretKeyMatch = content.match(/secret-key:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))/);
                const secretKey = secretKeyMatch ? (secretKeyMatch[1] || secretKeyMatch[2] || secretKeyMatch[3]) : null;

                if (!secretKey) {
                    vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Could not find secret-key in config.yaml'));
                    return;
                }

                // Check if key is hashed (bcrypt starts with $2a$, $2b$, $2y$)
                const isHashed = secretKey.startsWith('$2');
                let keyToUse = secretKey;

                if (isHashed) {
                    // Try to retrieve stored plaintext key
                    const storedKey = await this.context.secrets.get('antigravity.managementKey');
                    if (storedKey) {
                        keyToUse = storedKey;
                    } else {
                        // No stored key, and file is hashed. We must rotate.
                        progress.report({ message: LocalizationManager.getInstance().t('Securing connection...') });
                        const rotated = await this.rotateManagementKey(configPath, content);
                        if (!rotated) return;
                        keyToUse = rotated;
                    }
                } else {
                    // It is plaintext, ensure we store it for later (when it gets hashed)
                    await this.context.secrets.store('antigravity.managementKey', secretKey);
                }

                const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                const port = config.get<number>('proxy.port', 8317);

                // Fetch auth URL
                let response = await this.fetchAuthUrl(port, keyToUse, provider);

                // If 401 and we were using a stored key (maybe it's stale?), try rotating
                if (response.status === 401) {
                    progress.report({ message: LocalizationManager.getInstance().t('Re-authenticating proxy...') });
                    this._outputChannel.appendLine('[OAuth] 401 Unauthorized using current key. Rotating key...');
                    // Force read content again to be latest
                    content = fs.readFileSync(configPath, 'utf8');
                    const rotated = await this.rotateManagementKey(configPath, content);
                    if (rotated) {
                        keyToUse = rotated;
                        response = await this.fetchAuthUrl(port, keyToUse, provider);
                    } else {
                        vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Authentication failed. Could not rotate management key.'));
                        return;
                    }
                }

                if (response.ok) {
                    const text = await response.text();
                    // Check if it looks like a URL
                    if (text.startsWith('http')) {
                        const action = await vscode.window.showInformationMessage(
                            LocalizationManager.getInstance().t('OAuth URL received. Open to authenticate.'),
                            LocalizationManager.getInstance().t('Open'),
                            LocalizationManager.getInstance().t('Copy')
                        );
                        if (action === LocalizationManager.getInstance().t('Open')) {
                            vscode.env.openExternal(vscode.Uri.parse(text));
                        } else if (action === LocalizationManager.getInstance().t('Copy')) {
                            vscode.env.clipboard.writeText(text);
                        }
                        return;
                    }

                    // Validating if it returns HTML
                    if (text.includes('<!DOCTYPE html>') || text.includes('<html')) {
                        const urlMatch = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^"'\s]+/);
                        if (urlMatch) {
                            const authUrl = urlMatch[0];
                            const action = await vscode.window.showInformationMessage(
                                LocalizationManager.getInstance().t('OAuth URL received. Open to authenticate.'),
                                LocalizationManager.getInstance().t('Open'),
                                LocalizationManager.getInstance().t('Copy')
                            );
                            if (action === LocalizationManager.getInstance().t('Open')) {
                                vscode.env.openExternal(vscode.Uri.parse(authUrl));
                            } else if (action === LocalizationManager.getInstance().t('Copy')) {
                                vscode.env.clipboard.writeText(authUrl);
                            }
                            return;
                        }
                    }

                    // If JSON
                    try {
                        const json = JSON.parse(text);
                        if (json.url) {
                            const action = await vscode.window.showInformationMessage(
                                LocalizationManager.getInstance().t('OAuth URL received. Open to authenticate.'),
                                LocalizationManager.getInstance().t('Open'),
                                LocalizationManager.getInstance().t('Copy')
                            );
                            if (action === LocalizationManager.getInstance().t('Open')) {
                                vscode.env.openExternal(vscode.Uri.parse(json.url));
                            } else if (action === LocalizationManager.getInstance().t('Copy')) {
                                vscode.env.clipboard.writeText(json.url);
                            }
                            return;
                        }
                    } catch {
                        // Ignore JSON parse error if response is not JSON
                    }

                    vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Received unexpected response from auth endpoint.'));
                    this._outputChannel.appendLine(`[OAuth] Unexpected response: ${text}`);

                } else {
                    vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to get OAuth URL: {0} {1}', response.status, response.statusText));
                }

            } catch (e: any) {
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('OAuth Error: {0}', e.message));
            }
        });
    }

    private async fetchAuthUrl(port: number, key: string, provider: string) {
        let endpoint = 'antigravity-auth-url'; // default
        if (provider === 'codex') {
            endpoint = 'codex-auth-url';
        } else if (provider === 'claude') {
            endpoint = 'anthropic-auth-url';
        } else if (provider === 'qwen') {
            endpoint = 'qwen-auth-url';
        } else if (provider === 'kimi') {
            endpoint = 'kimi-auth-url';
        }
        const url = `http://127.0.0.1:${port}/v0/management/${endpoint}?is_webui=true`;
        return await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${key}`
            }
        });
    }

    private async rotateManagementKey(configPath: string, content: string): Promise<string | null> {
        const newKey = nodeCrypto.randomUUID();

        // Regex to match secret-key line to replace it
        // We match strict structure to ensure we replace the right thing
        const regex = /(secret-key:\s*)(?:"[^"]+"|'[^']+'|[^#\s]+)/;
        if (!regex.test(content)) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Could not update config.yaml: secret-key pattern not found.'));
            return null;
        }

        const newContent = content.replace(regex, `$1"${newKey}"`);
        fs.writeFileSync(configPath, newContent);

        // Store new key
        await this.context.secrets.store('antigravity.managementKey', newKey);

        // We don't show separate message here, the Progress indicator will cover it

        await this.stop();
        await this.start();

        // Wait a bit for server to be ready
        await new Promise(resolve => setTimeout(resolve, 3000));

        return newKey;
    }


    public async getManagementKey(): Promise<string | null> {
        const configPath = path.join(this._binDir, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(configPath, 'utf8');
            const secretKeyMatch = content.match(/secret-key:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))/);
            const secretKey = secretKeyMatch ? (secretKeyMatch[1] || secretKeyMatch[2] || secretKeyMatch[3]) : null;

            if (!secretKey) {
                return null;
            }

            const isHashed = secretKey.startsWith('$2');
            if (isHashed) {
                const storedKey = await this.context.secrets.get('antigravity.managementKey');
                return storedKey || null;
            }
            return secretKey;
        } catch {
            return null;
        }
    }

    public isSecretKeyEmpty(): boolean {
        const configPath = path.join(this._binDir, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            return true;
        }
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            // Match secret-key: "" or secret-key: ''
            const emptyMatch = content.match(/secret-key:\s*(?:""|'')/);
            return !!emptyMatch;
        } catch {
            return true;
        }
    }

    public async setSecretKey(key: string): Promise<boolean> {
        const configPath = path.join(this._binDir, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Config file not found.'));
            return false;
        }
        try {
            let content = fs.readFileSync(configPath, 'utf8');
            // Replace secret-key: "" or secret-key: '' with secret-key: "newValue"
            content = content.replace(/secret-key:\s*(?:""|'')/, `secret-key: "${key}"`);
            fs.writeFileSync(configPath, content);
            return true;
        } catch (e: any) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to set secret key: {0}', e.message));
            return false;
        }
    }

    public async updateManagementKey(newKey: string): Promise<boolean> {
        const configPath = path.join(this._binDir, 'config.yaml');
        if (!fs.existsSync(configPath)) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Config file not found.'));
            return false;
        }

        try {
            const content = fs.readFileSync(configPath, 'utf8');
            // Regex to match secret-key line to replace it (existing value or empty)
            const regex = /(secret-key:\s*)(?:"[^"]*"|'[^']*'|[^#\s]*)/;

            if (!regex.test(content)) {
                // If not found, try appending it? Or error out?
                // The key should exist as we initialize it. If not, maybe we just append it.
                // But let's assume it exists or use a loose match.
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Could not find secret-key in config.yaml to update.'));
                return false;
            }

            const newContent = content.replace(regex, `$1"${newKey}"`);
            fs.writeFileSync(configPath, newContent);

            // Store new key in secrets
            await this.context.secrets.store('antigravity.managementKey', newKey);

            // Restart proxy
            await this.stop();
            setTimeout(() => this.start(), 1000);

            return true;
        } catch (e: any) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to update secret key: {0}', e.message));
            return false;
        }
    }

    public async revealSecretKey() {
        const keyToShow = await this.getManagementKey();
        if (!keyToShow) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Could not find secret-key. It might be hashed and not present in secrets storage.'));
            return;
        }

        // Show input box with selection for easy copying
        await vscode.window.showInputBox({
            title: LocalizationManager.getInstance().t('Management Secret Key'),
            value: keyToShow,
            password: false,
            prompt: LocalizationManager.getInstance().t('Copy this key to configure external tools.'),
            ignoreFocusOut: true
        });
    }

    public async testConnection() {
        if (!(await this.checkAndStartProxy())) return;

        try {
            const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
            const port = config.get<number>('proxy.port', 8317);
            const url = `http://127.0.0.1:${port}/v1/models`;

            this._outputChannel.appendLine(`[TEST] Checking reachability: ${url}`);

            const headers: Record<string, string> = {};
            const keysObj = this.getApiKeys();
            const activeKeys = keysObj.filter(k => k.visible).map(k => k.key);
            if (activeKeys && activeKeys.length > 0) {
                headers['Authorization'] = `Bearer ${activeKeys[0]}`;
                this._outputChannel.appendLine(`[TEST] Using first API key for authorization (Ending in ...${activeKeys[0].slice(-4)})`);
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(url, {
                headers,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Antigravity Proxy is reachable and functioning correctly!'));
                this._outputChannel.appendLine(`[TEST] Connection successful (Status: ${response.status})`);
            } else {
                this._outputChannel.appendLine(`[TEST] Connection failed (Status: ${response.status} ${response.statusText})`);
                if (response.status === 401) {
                    vscode.window.showWarningMessage(LocalizationManager.getInstance().t('Antigravity Proxy is reachable but returned 401 Unauthorized. Check your API keys.'));
                } else {
                    vscode.window.showWarningMessage(LocalizationManager.getInstance().t('Antigravity Proxy reachable but returned status: {0} {1}', response.status, response.statusText));
                }
            }
        } catch (e: any) {
            let errorMsg = e.message;
            if (e.name === 'AbortError') {
                errorMsg = 'Request timed out (5s)';
            }
            this._outputChannel.appendLine(`[TEST] Connection error: ${errorMsg}`);
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t(`Failed to connect to Antigravity Proxy: ${errorMsg}`));
        }
    }

    public async testApiKey(key: string) {
        if (!(await this.checkAndStartProxy())) return;
        try {
            const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
            const port = config.get<number>('proxy.port', 8317);
            const url = `http://127.0.0.1:${port}/v1/models`;

            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (response.ok) {
                const data = await response.json() as any;
                const modelCount = data.data?.length || 0;
                vscode.window.showInformationMessage(
                    LocalizationManager.getInstance().t('API Key is valid and working! {0} models available.', [modelCount])
                );
                this._outputChannel.appendLine(`[TEST] API Key success: ${modelCount} models available.`);
            } else {
                vscode.window.showErrorMessage(
                    LocalizationManager.getInstance().t('API Key test failed: {0} {1}', [response.status, response.statusText])
                );
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(
                LocalizationManager.getInstance().t('API Key test error: {0}', [e.message])
            );
        }
    }

    public getMcpCommands(): { name: string, filename: string, allowedModels: string[] }[] {
        const lm = LocalizationManager.getInstance();
        const commands: { name: string, filename: string, allowedModels: string[] }[] = [];
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return commands;
        }

        const workflowsDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.agent', 'workflows');
        if (fs.existsSync(workflowsDir)) {
            try {
                const files = fs.readdirSync(workflowsDir);
                for (const file of files) {
                    if (file.endsWith('.md')) {
                        const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
                        const name = file.replace(/\.md$/, '');
                        let allowedModels: string[] = [];

                        // Parse allowed models from comment: // Allowed models: ["model1", "model2"]
                        const match = content.match(/\/\/ Allowed models: (\[.*?\])/);
                        if (match && match[1]) {
                            try {
                                allowedModels = JSON.parse(match[1]);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(
                                    lm.t('Failed to parse allowed models for {0}: {1}', [file, e.message])
                                );
                            }
                        }

                        commands.push({ name, filename: file, allowedModels });
                    }
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(
                    lm.t('Error reading workflows directory: {0}', [e.message])
                );
            }
        }
        return commands;
    }

    public getProviderAuthInfo(provider: string): { filePath: string, fileName: string, lastModified: Date } | null {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return null;
            const content = fs.readFileSync(configPath, 'utf8');

            let authDir = path.join(os.homedir(), '.cli-proxy-api');
            const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
            if (authDirMatch) {
                authDir = authDirMatch[1];
                if (authDir.startsWith('~')) {
                    authDir = path.join(os.homedir(), authDir.slice(1));
                }
            }

            if (!fs.existsSync(authDir)) return null;

            let filePattern: RegExp | null = null;
            if (provider === 'antigravity') filePattern = /^antigravity-.*\.json$/;
            else if (provider === 'codex') filePattern = /^codex-.*\.json$/;
            else if (provider === 'github-copilot') filePattern = /^github-copilot\.json$/;
            else if (provider === 'qwen') filePattern = /^qwen-.*\.json$/;
            else if (provider === 'kimi') filePattern = /^kimi-.*\.json$/;
            else if (provider === 'claude') filePattern = /^claude-.*\.json$/;
            else if (provider === 'gemini-cli') filePattern = /^gemini-.*\.json$/;

            if (!filePattern) return null;

            const files = fs.readdirSync(authDir)
                .filter(f => filePattern!.test(f))
                .map(f => path.join(authDir, f))
                .map(f => ({ file: f, stat: fs.statSync(f) }))
                .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

            if (files.length > 0) {
                return {
                    filePath: files[0].file,
                    fileName: path.basename(files[0].file),
                    lastModified: files[0].stat.mtime
                };
            }
        } catch { /* ignore */ }
        return null;
    }

    /**
     * Get the auth directory path
     */
    /**
     * Get the auth directory path
     */
    public getAuthDir(): string {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf8');
                const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                if (authDirMatch) {
                    let authDir = authDirMatch[1];
                    if (authDir.startsWith('~')) {
                        authDir = path.join(os.homedir(), authDir.slice(1));
                    }
                    return authDir;
                }
            }
        } catch { /* ignore */ }
        return path.join(os.homedir(), '.cli-proxy-api');
    }

    /**
     * Get all auth files for a provider (supports multiple accounts)
     */
    public getAllProviderAuthInfos(provider: string): { filePath: string, fileName: string, lastModified: Date }[] {
        try {
            const authDir = this.getAuthDir();
            if (!fs.existsSync(authDir)) return [];

            let filePattern: RegExp | null = null;
            if (provider === 'antigravity') filePattern = /^antigravity-.*\.json$/;
            else if (provider === 'codex') filePattern = /^codex-.*\.json$/;
            else if (provider === 'github-copilot') filePattern = /^github-copilot\.json$/;
            else if (provider === 'qwen') filePattern = /^qwen-.*\.json$/;
            else if (provider === 'kimi') filePattern = /^kimi-.*\.json$/;
            else if (provider === 'claude') filePattern = /^claude-.*\.json$/;
            else if (provider === 'gemini-cli') filePattern = /^gemini-.*\.json$/;

            if (!filePattern) return [];

            const files = fs.readdirSync(authDir)
                .filter(f => filePattern!.test(f))
                .map(f => path.join(authDir, f))
                .map(f => ({ file: f, stat: fs.statSync(f) }))
                .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

            return files.map(f => ({
                filePath: f.file,
                fileName: path.basename(f.file),
                lastModified: f.stat.mtime
            }));
        } catch { /* ignore */ }
        return [];
    }

    public deleteProviderAuth(provider: string) {
        try {
            const info = this.getProviderAuthInfo(provider);
            if (info && fs.existsSync(info.filePath)) {
                fs.unlinkSync(info.filePath);
                this._onDidChangeStatus.fire(this._status);
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Auth file {0} deleted.', info.fileName));
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to delete auth file: {0}', e.message));
        }
    }

    /**
     * Delete a specific auth file by filename
     */
    public deleteSpecificAuthFile(provider: string, fileName: string) {
        try {
            const allInfos = this.getAllProviderAuthInfos(provider);
            const info = allInfos.find(i => i.fileName === fileName);
            if (info && fs.existsSync(info.filePath)) {
                fs.unlinkSync(info.filePath);
                this._onDidChangeStatus.fire(this._status);
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Auth file {0} deleted.', info.fileName));
            } else {
                vscode.window.showWarningMessage(LocalizationManager.getInstance().t('Auth file not found: {0}', fileName));
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to delete auth file: {0}', e.message));
        }
    }


    public getZaiKey(): string | null {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return null;
            const content = fs.readFileSync(configPath, 'utf8');

            // Simple approach: find active z-ai block then look for api-key
            // Match the entire z-ai configuration section
            const match = content.match(/^\s+- name: ["']?z-ai["']?[\s\S]*?api-key:\s*["']?([^"'\n]+)["']?/m);
            if (match) return match[1];
        } catch { /* ignore */ }
        return null;
    }

    public getZaiModel(): string {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return 'glm-4-plus';
            const content = fs.readFileSync(configPath, 'utf8');

            // First try active block
            const activeMatch = content.match(/(?:^|\n)\s*- name: ["']?z-ai["']?[\s\S]*?models:\s*\n\s*-\s*name:\s*["']?([^"'\n]+)["']?/);
            if (activeMatch) return activeMatch[1];

            // Fallback to commented block
            const commentedMatch = content.match(/#\s*- name: ["']?z-ai["']?[\s\S]*?#\s*-\s*name:\s*["']?([^"'\n]+)["']?/);
            if (commentedMatch) return commentedMatch[1];
        } catch { /* ignore */ }
        return 'glm-4-plus';
    }

    // Get Z.AI key from commented block (for re-enabling)
    public getZaiKeyFromCommented(): string | null {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return null;
            const content = fs.readFileSync(configPath, 'utf8');

            // Match commented z-ai block and extract api-key
            const match = content.match(/#\s*- name: ["']?z-ai["']?[\s\S]*?#\s*-?\s*api-key:\s*["']?([^"'\n]+)["']?/);
            if (match) return match[1];
        } catch { /* ignore */ }
        return null;
    }

    // Get Z.AI model from commented block (for re-enabling)
    public getZaiModelFromCommented(): string {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return 'glm-4-plus';
            const content = fs.readFileSync(configPath, 'utf8');

            // Match commented z-ai block and extract model
            const match = content.match(/#\s*- name: ["']?z-ai["']?[\s\S]*?models:[\s\S]*?#\s*-\s*name:\s*["']?([^"'\n]+)["']?/);
            if (match) return match[1];
        } catch { /* ignore */ }
        return 'glm-4-plus';
    }

    public isZaiEnabled(): boolean {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return false;
            const content = fs.readFileSync(configPath, 'utf8');
            // If we find un-commented z-ai block start
            // We search for a line starting with (whitespace only) "- name: 'z-ai'"
            // The presence of commented blocks elsewhere doesn't matter.
            // Z.AI is under openai-compatibility so check for indented block without # prefix
            return /^\s+- name: ["']?z-ai["']?/m.test(content);
        } catch { return false; }
    }

    public async toggleZai(enabled: boolean) {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return;
            let content = fs.readFileSync(configPath, 'utf8');

            if (enabled) {
                // Enable: Use addProvider to reconstruct the block safely
                // First try active block, then fallback to commented block
                let key = this.getZaiKey();
                let model = this.getZaiModel();

                // If no active key, try commented block
                if (!key) {
                    key = this.getZaiKeyFromCommented();
                    model = this.getZaiModelFromCommented();
                }

                if (key) {
                    await this.addProvider('z-ai', { apiKey: key, model: model });
                    // Fire status change to update dashboard UI
                    this._onDidChangeStatus.fire(this._status);
                } else {
                    vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Cannot enable Z.AI: API Key not found in config.'));
                }
            } else {
                // Disable: Comment out the block
                // Use backreference \1 to match the exact same indent as the start of the block
                // This reliably stops at the next sibling provider (same indent) while consuming nested children (deeper indent)
                // Disable: Remove existing then Append Commented Block
                const key = this.getZaiKey() || '';
                // Use backreference \1 to ensure we only stop at SIBLINGS
                const purgeRegex = /(\n\s*)(?:#\s*)?(- name: ["']?z-ai["']?[\s\S]*?)(?=\1(?:#[ \t]?)?- name:|\r?\n[a-zA-Z]|\r?\n#[ \t]?[a-zA-Z0-9_-]+:|$)/g;
                content = content.replace(purgeRegex, '');

                // Prepare Commented Block - Include all supported models
                const block = `
#   - name: "z-ai"
#     prefix: "z-ai"
#     base-url: "https://api.z.ai/api/paas/v4/"
#     api-key-entries:
#       - api-key: "${key}"
#     models:
#       - name: "glm-4-plus"
#         alias: "glm-4-plus"
#       - name: "glm-4.7"
#         alias: "glm-4.7"
#       - name: "glm-4.6"
#         alias: "glm-4.6"`;

                // Insert Strategy (Same as Add)
                const activeSectionRegex = /(^openai-compatibility:\s*)((?:.|\r?\n)*?)(\r?\n[a-zA-Z]|\r?\n#[ \t]?[a-zA-Z0-9_-]+:|$)/m;

                if (activeSectionRegex.test(content)) {
                    content = content.replace(activeSectionRegex, `$1$2${block}$3`);
                } else {
                    content = content.trimEnd() + `\n\nopenai-compatibility:${block}\n`;
                }

                fs.writeFileSync(configPath, content);
                this._onDidChangeStatus.fire(this._status);
                const action = await vscode.window.showInformationMessage(
                    LocalizationManager.getInstance().t('Z.AI configuration disabled. Please reload window to apply changes.'),
                    LocalizationManager.getInstance().t('Reload Window')
                );
                if (action === LocalizationManager.getInstance().t('Reload Window')) {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to toggle Z.AI: {0}', e.message));
        }
    }

    public deleteZai() {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return;
            let content = fs.readFileSync(configPath, 'utf8');

            // Remove z-ai block (commented or not)
            // Remove z-ai block (active or commented) robustly
            const regex = /(\n\s*)(?:#\s*)?(- name: ["']?z-ai["']?[\s\S]*?)(?=\1(?:#[ \t]?)?- name:|\r?\n[a-zA-Z]|\r?\n#[ \t]?[a-zA-Z0-9_-]+:|$)/g;
            if (regex.test(content)) {
                content = content.replace(regex, '');
                fs.writeFileSync(configPath, content);
                this._onDidChangeStatus.fire(this._status);
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Z.AI configuration removed.'));
            }
        } catch { /* ignore */ }
    }

    public async getAccountDetails(provider: string, fileName: string): Promise<AccountDetails | null> {
        try {
            const authDir = this.getAuthDir();
            if (!fs.existsSync(authDir)) return null;

            const filePath = path.join(authDir, fileName);
            if (!fs.existsSync(filePath)) return null;

            const stats = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);

            const details: AccountDetails = {
                fileName: fileName,
                lastModified: stats.mtime
            };

            // Extract fields based on provider
            if (provider === 'antigravity') {
                details.email = data.email || data.user_email || data.account_email;
                details.expired = data.expired;
            } else if (provider === 'codex') {
                details.email = data.email;
                details.expired = data.expired;
            } else if (provider === 'kimi') {
                details.expired = data.expired;
            } else if (provider === 'qwen') {
                details.expired = data.expired;
            } else if (provider === 'github-copilot') {
                details.user = data.user;
            } else if (provider === 'gemini-cli') {
                details.email = data.email;
                // If email is not in JSON, try to parse from filename: gemini-<email>-<project>.json
                if (!details.email && fileName.startsWith('gemini-')) {
                    // Try to extract email: gemini-email@domain.com-project.json
                    // Regex to capture email between 'gemini-' and the last dash-number section or .json
                    const match = fileName.match(/^gemini-(.+?)(?:-antigravity-sync-.*|-.*)?\.json$/);
                    if (match && match[1]) {
                        // The regex might be too greedy or simple, let's try a safer split approach
                        // Expected format: gemini-<email>-<project>.json
                        // But email can contain dashes/dots.
                        // Let's assume the project part is usually appended. 
                        // For the user's specific case: gemini-centurionunchase@gmail.com-antigravity-sync-484813.json
                        details.email = match[1];
                    }
                }
            }

            return details;
        } catch (e) {
            console.error(`Failed to get account details for ${provider}/${fileName}:`, e);
            return null;
        }
    }

    public async getAntigravityEmail(fileName: string): Promise<string | null> {
        try {
            const authDir = this.getAuthDir();
            if (!fs.existsSync(authDir)) return null;

            const filePath = path.join(authDir, fileName);

            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                // Check common email fields based on file structure
                if (data.email) return data.email;
                if (data.user_email) return data.user_email;
                if (data.account_email) return data.account_email;
            }
            return null;
        } catch (e) {
            console.error('Failed to get Antigravity email from file:', e);
            return null;
        }
    }

    public async getAllAntigravityEmails(): Promise<string[]> {
        const infos = this.getAllProviderAuthInfos('antigravity');
        const emails = await Promise.all(infos.map(info => this.getAntigravityEmail(info.fileName)));
        // Filter out nulls and duplicates
        return Array.from(new Set(emails.filter((e): e is string => e !== null)));
    }

    public getConfiguredProviders(): string[] {
        const configPath = path.join(this._binDir, 'config.yaml');
        if (!fs.existsSync(configPath)) return [];

        try {
            const content = fs.readFileSync(configPath, 'utf8');
            const providers: string[] = [];

            // Check for GitHub Copilot (OAuth or Config)
            let copilotConfigured = false;
            // Check for config entry
            if (content.match(/^github-copilot:/m)) {
                copilotConfigured = true;
            } else {
                // Check for auth file
                try {
                    const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                    let authDir = authDirMatch ? authDirMatch[1] : path.join(os.homedir(), '.cli-proxy-api');
                    if (authDir.startsWith('~')) {
                        authDir = path.join(os.homedir(), authDir.slice(1));
                    }
                    if (fs.existsSync(authDir)) {
                        const files = fs.readdirSync(authDir);
                        if (files.some(f => f === 'github-copilot.json')) {
                            copilotConfigured = true;
                        }
                    }
                } catch { /* ignore */ }
            }
            if (copilotConfigured) providers.push('github-copilot');

            // Check for Claude (OAuth)
            let claudeConfigured = false;
            // Check for auth file
            try {
                const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                let authDir = authDirMatch ? authDirMatch[1] : path.join(os.homedir(), '.cli-proxy-api');
                if (authDir.startsWith('~')) {
                    authDir = path.join(os.homedir(), authDir.slice(1));
                }
                if (fs.existsSync(authDir)) {
                    const files = fs.readdirSync(authDir);
                    if (files.some(f => f.startsWith('claude-') && f.endsWith('.json'))) {
                        claudeConfigured = true;
                    }
                }
            } catch { /* ignore */ }
            if (claudeConfigured) providers.push('claude');

            // Check for Codex (OAuth or Key)
            let codexConfigured = false;
            // Check for API key (ensure not commented out)
            if (content.match(/^codex-api-key:/m)) {
                codexConfigured = true;
            } else {
                // Check for auth file
                try {
                    const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                    let authDir = authDirMatch ? authDirMatch[1] : path.join(os.homedir(), '.cli-proxy-api');
                    if (authDir.startsWith('~')) {
                        authDir = path.join(os.homedir(), authDir.slice(1));
                    }
                    if (fs.existsSync(authDir)) {
                        const files = fs.readdirSync(authDir);
                        if (files.some(f => f.startsWith('codex-') && f.endsWith('.json'))) {
                            codexConfigured = true;
                        }
                    }
                } catch { /* ignore */ }
            }
            if (codexConfigured) providers.push('codex');
            if (content.includes('vertex-api-key:') && content.includes('api-key:')) providers.push('vertex');
            // Z.AI is under openai-compatibility - check for active (not commented) block
            if (content.match(/^\s+- name: ["']?z-ai["']?/m)) providers.push('z-ai');

            // Check for Qwen (OAuth)
            let qwenConfigured = false;
            try {
                const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                let authDir = authDirMatch ? authDirMatch[1] : path.join(os.homedir(), '.cli-proxy-api');
                if (authDir.startsWith('~')) {
                    authDir = path.join(os.homedir(), authDir.slice(1));
                }
                if (fs.existsSync(authDir)) {
                    const files = fs.readdirSync(authDir);
                    if (files.some(f => f.startsWith('qwen-') && f.endsWith('.json'))) {
                        qwenConfigured = true;
                    }
                }
            } catch { /* ignore */ }
            if (qwenConfigured) providers.push('qwen');

            // Check for Kimi (OAuth)
            let kimiConfigured = false;
            try {
                const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                let authDir = authDirMatch ? authDirMatch[1] : path.join(os.homedir(), '.cli-proxy-api');
                if (authDir.startsWith('~')) {
                    authDir = path.join(os.homedir(), authDir.slice(1));
                }
                if (fs.existsSync(authDir)) {
                    const files = fs.readdirSync(authDir);
                    if (files.some(f => f.startsWith('kimi-') && f.endsWith('.json'))) {
                        kimiConfigured = true;
                    }
                }
            } catch { /* ignore */ }
            if (kimiConfigured) providers.push('kimi');
            if (content.includes('kiro:')) providers.push('kiro');

            // Antigravity (OAuth or Key)
            let antigravityConfigured = false;
            if (content.includes('antigravity-auth-url') || content.match(/provider:\s*"?antigravity"?/)) {
                antigravityConfigured = true;
            } else {
                // Check if auth file exists in auth-dir
                try {
                    const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                    let authDir = authDirMatch ? authDirMatch[1] : path.join(os.homedir(), '.cli-proxy-api');
                    if (authDir.startsWith('~')) {
                        authDir = path.join(os.homedir(), authDir.slice(1));
                    }

                    if (fs.existsSync(authDir)) {
                        const files = fs.readdirSync(authDir);
                        if (files.some(f => f.startsWith('antigravity-') && f.endsWith('.json'))) {
                            antigravityConfigured = true;
                        }
                    }
                } catch {
                    // ignore error
                }
            }
            if (antigravityConfigured) providers.push('antigravity');

            // Gemini
            let geminiConfigured = false;
            // Check config.yaml
            if (content.match(/provider:\s*"?gemini"?/) || content.match(/provider:\s*"?aistudio"?/)) {
                geminiConfigured = true;
            } else {
                // Check auth-dir
                try {
                    const authDirMatch = content.match(/^auth-dir:\s*"?(.+?)"?\s*$/m);
                    let authDir = authDirMatch ? authDirMatch[1] : path.join(os.homedir(), '.cli-proxy-api');
                    if (authDir.startsWith('~')) {
                        authDir = path.join(os.homedir(), authDir.slice(1));
                    }
                    if (fs.existsSync(authDir)) {
                        const files = fs.readdirSync(authDir);
                        if (files.some(f => f.startsWith('gemini-') && f.endsWith('.json'))) {
                            geminiConfigured = true;
                        }
                    }
                } catch { /* ignore */ }
            }

            if (geminiConfigured) {
                providers.push('gemini-cli');
            }

            return providers;
        } catch {
            return [];
        }
    }

    public async removeApiKey(key: string) {
        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return;

            let content = fs.readFileSync(configPath, 'utf8');
            const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Match the line with the key, including dash and potential quotes
            const regex = new RegExp(`^(\\s*-\\s*["']?)${escapedKey}(["']?\\s*)$`, 'm');

            if (regex.test(content)) {
                content = content.replace(regex, '');
                // Clean up extra newlines if needed
                content = content.replace(/\n\s*\n/g, '\n');
                fs.writeFileSync(configPath, content, 'utf8');
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('API Key removed successfully.'));
                this._onDidChangeStatus.fire(this._status);
            } else {
                vscode.window.showWarningMessage(LocalizationManager.getInstance().t('API Key not found in config.'));
            }
        } catch (e) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to remove API key: {0}', [e]));
        }
    }

    public async editApiKey(oldKey: string) {
        const lm = LocalizationManager.getInstance();
        const newKey = await vscode.window.showInputBox({
            prompt: lm.t('Enter new API Key'),
            value: oldKey,
            ignoreFocusOut: true
        });

        if (!newKey || newKey === oldKey) return;

        try {
            const configPath = path.join(this._binDir, 'config.yaml');
            if (!fs.existsSync(configPath)) return;

            let content = fs.readFileSync(configPath, 'utf8');
            const escapedOldKey = oldKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`^(\\s*-\\s*["']?)${escapedOldKey}(["']?\\s*)$`, 'm');

            if (regex.test(content)) {
                content = content.replace(regex, `$1${newKey}$2`);
                fs.writeFileSync(configPath, content, 'utf8');
                vscode.window.showInformationMessage(lm.t('API Key updated successfully.'));
                this._onDidChangeStatus.fire(this._status);
            } else {
                vscode.window.showWarningMessage(lm.t('API Key not found in config.'));
            }
        } catch (e) {
            vscode.window.showErrorMessage(lm.t('Failed to update API key: {0}', [e]));
        }
    }

    public showLog() {
        this._outputChannel.show();
    }

    public dispose() {
        this.stop();
        this._statusBarItem.dispose();
        this._outputChannel.dispose();
    }

    public async killProcessOnPort(port: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const platform = process.platform;
            if (platform === 'win32') {
                cp.exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
                    if (err || !stdout) {
                        resolve(false);
                        return;
                    }
                    // Typical output: TCP    0.0.0.0:8317           0.0.0.0:0              LISTENING       12345
                    // We need the last token (PID)
                    const lines = stdout.split('\n');
                    let killedAny = false;

                    const pidsToKill = new Set<string>();

                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length > 4) {
                            const pid = parts[parts.length - 1];
                            if (parseInt(pid) > 0) {
                                pidsToKill.add(pid);
                            }
                        }
                    }

                    if (pidsToKill.size === 0) {
                        resolve(false);
                        return;
                    }

                    let processed = 0;
                    for (const pid of pidsToKill) {
                        cp.exec(`taskkill /PID ${pid} /F`, (kErr) => {
                            processed++;
                            if (!kErr) killedAny = true;

                            if (processed === pidsToKill.size) {
                                resolve(killedAny);
                            }
                        });
                    }
                });
            } else {
                // Unix/Linux/Mac
                cp.exec(`lsof -i :${port} -t`, (err, stdout) => {
                    if (err || !stdout) {
                        resolve(false);
                        return;
                    }
                    const pids = stdout.trim().split('\n');
                    let processed = 0;
                    let killedAny = false;

                    if (pids.length === 0) {
                        resolve(false);
                        return;
                    }

                    for (const pid of pids) {
                        cp.exec(`kill -9 ${pid}`, (kErr) => {
                            processed++;
                            if (!kErr) killedAny = true;

                            if (processed === pids.length) {
                                resolve(killedAny);
                            }
                        });
                    }
                });
            }
        });
    }
    public async deployMcpServerScript(extensionUri: vscode.Uri): Promise<string> {
        const binDir = this._binDir; // ~/.antigravity-proxy or similar
        const mcpDir = path.join(binDir, 'mcp');
        if (!fs.existsSync(mcpDir)) {
            fs.mkdirSync(mcpDir, { recursive: true });
        }

        const sourcePath = vscode.Uri.joinPath(extensionUri, 'dist', 'mcp', 'proxyMcpServer.js');
        const destPath = path.join(mcpDir, 'proxyMcpServer.js');

        try {
            const content = await vscode.workspace.fs.readFile(sourcePath);
            fs.writeFileSync(destPath, content);
            return destPath;
        } catch (error) {
            console.error('Failed to deploy MCP server script:', error);
            throw error;
        }
    }
}
