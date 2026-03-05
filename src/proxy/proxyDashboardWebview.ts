
/* eslint-disable no-useless-escape */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ProxyManager, ProxyStatus, AccountDetails } from './proxyManager';
import { LocalizationManager } from '../l10n/localizationManager';

export class ProxyDashboardWebview {
    public static readonly viewType = 'antigravity.proxyDashboard';
    private _panel: vscode.WebviewPanel | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _authDirWatcher: vscode.FileSystemWatcher | undefined;
    private _refreshDebounceTimeout: NodeJS.Timeout | undefined;
    private _mcpTerminal: vscode.Terminal | undefined;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _proxyManager: ProxyManager,
        private readonly _profileManager: any // Type 'ProfileManager' but using any to avoid circular dependency issues if not careful with imports, though types should be fine. 
        // Better to import ProfileManager.
    ) { }

    public show() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const lm = LocalizationManager.getInstance();
        this._panel = vscode.window.createWebviewPanel(
            ProxyDashboardWebview.viewType,
            lm.t('Antigravity Proxy Dashboard'),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [this._extensionUri]
            }
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        vscode.window.onDidCloseTerminal(term => {
            if (term === this._mcpTerminal) {
                this._mcpTerminal = undefined;
                this._panel?.webview.postMessage({ command: 'mcpStatus', running: false });
                this.update();
            }
        }, null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'start':
                        await this._proxyManager.start();
                        break;
                    case 'stop':
                        await this._proxyManager.stop();
                        break;
                    case 'install': {
                        const confirmInstall = await vscode.window.showWarningMessage(
                            LocalizationManager.getInstance().t('Are you sure you want to re-install the proxy? This will overwrite the existing binary.'),
                            { modal: true },
                            LocalizationManager.getInstance().t('Re-install')
                        );
                        if (confirmInstall === LocalizationManager.getInstance().t('Re-install')) {
                            await this._proxyManager.install();
                        }
                        break;
                    }
                    case 'openConfig':
                        this.openConfigFile();
                        break;
                    case 'openLogs':
                        vscode.commands.executeCommand('antigravity-storage-manager.proxy.showLog');
                        break;
                    case 'openWebUi':
                        if (message.url) {
                            vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                    case 'openExtensionSettings':
                        vscode.commands.executeCommand('workbench.action.openSettings', 'antigravity-storage-manager.proxy');
                        break;
                    case 'copy':
                        if (message.text) {
                            vscode.env.clipboard.writeText(message.text);
                            vscode.window.showInformationMessage(lm.t('Path copied to clipboard'));
                        }
                        break;
                    case 'copyKey':
                        if (message.text) {
                            vscode.env.clipboard.writeText(message.text);
                            vscode.window.showInformationMessage(lm.t('API Key copied to clipboard'));
                        }
                        break;
                    case 'addProvider':
                        this.handleAddProvider(message.providerId, message.data);
                        break;
                    case 'testProvider':
                        this._proxyManager.testProvider(message.providerId, message.data.model);
                        break;
                    case 'authenticate': {
                        // Generic authentication handler
                        const provider = message.provider;
                        if (provider === 'gemini-cli') {
                            try {
                                const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                                const port = config.get<number>('proxy.port', 8317);
                                const managementKey = await this._proxyManager.getManagementKey();

                                if (!managementKey) {
                                    vscode.window.showErrorMessage(lm.t('Management key is required for Gemini CLI authentication.'));
                                    break;
                                }

                                const response = await fetch(`http://127.0.0.1:${port}/v0/management/gemini-cli-auth-url?management_key=${managementKey}`);
                                if (response.ok) {
                                    const data = await response.json() as any;
                                    if (data && data.url) {
                                        vscode.env.openExternal(vscode.Uri.parse(data.url));
                                    } else {
                                        vscode.window.showErrorMessage(lm.t('Failed to retrieve Gemini CLI auth URL: Invalid response format'));
                                    }
                                } else {
                                    vscode.window.showErrorMessage(lm.t('Failed to retrieve Gemini CLI auth URL: {0}', response.statusText));
                                }
                            } catch (error: any) {
                                vscode.window.showErrorMessage(lm.t('Error retrieving Gemini CLI auth URL: {0}', error.message));
                            }
                        }
                        break;
                    }
                    case 'loginAntigravity': {
                        const initialEmails = await this._proxyManager.getAllAntigravityEmails();
                        await this._proxyManager.initiateOAuthFlow('antigravity');

                        // Poll for new email
                        const lm = LocalizationManager.getInstance();
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: lm.t('Waiting for authentication...'),
                            cancellable: true
                        }, async (progress, token) => {
                            return new Promise<void>((resolve) => {
                                let elapsed = 0;
                                const interval = setInterval(async () => {
                                    if (token.isCancellationRequested) {
                                        clearInterval(interval);
                                        resolve();
                                        return;
                                    }

                                    elapsed += 1000;
                                    if (elapsed > 300000) { // 5 minutes timeout
                                        clearInterval(interval);
                                        resolve();
                                        return;
                                    }

                                    const currentEmails = await this._proxyManager.getAllAntigravityEmails();
                                    const newEmail = currentEmails.find(e => !initialEmails.includes(e));
                                    if (newEmail) {
                                        clearInterval(interval);
                                        this.update(); // Refresh dashboard
                                        vscode.window.showInformationMessage(lm.t('Authenticated as {0}', newEmail));
                                        resolve();
                                    }
                                }, 1000);
                            });
                        });
                        break;
                    }
                    case 'testApiKey':
                        if (message.key) this._proxyManager.testApiKey(message.key);
                        break;
                    case 'editApiKey':
                        if (message.key) this._proxyManager.editApiKey(message.key);
                        break;
                    case 'removeApiKey':
                        if (message.key) {
                            const confirm = await vscode.window.showWarningMessage(
                                lm.t('Are you sure you want to delete this API key?'),
                                { modal: true },
                                lm.t('Delete')
                            );
                            if (confirm === lm.t('Delete')) {
                                this._proxyManager.removeApiKey(message.key);
                            }
                        }
                        break;
                    case 'revealSecret':
                        this._proxyManager.revealSecretKey();
                        break;
                    case 'testProxyConnection':
                        this._proxyManager.testConnection();
                        break;
                    case 'testProviderModel':
                        if (message.providerId && message.model) {
                            this._proxyManager.testProvider(message.providerId, message.model);
                        }
                        break;
                    case 'getSecretKey':
                        this._proxyManager.getManagementKey().then(async key => {
                            if (key) {
                                this._panel?.webview.postMessage({ command: 'secretKey', key });
                            } else {
                                const action = await vscode.window.showWarningMessage(
                                    LocalizationManager.getInstance().t('Could not retrieve management key. It might be hashed and missing from secure storage.'),
                                    LocalizationManager.getInstance().t('Set New Key')
                                );

                                if (action === LocalizationManager.getInstance().t('Set New Key')) {
                                    this.handleChangeManagementKey();
                                }

                                this._panel?.webview.postMessage({ command: 'secretKey', key: '' });
                            }
                        });
                        break;
                    case 'copySecretKey':
                        this._proxyManager.getManagementKey().then(key => {
                            if (key) {
                                vscode.env.clipboard.writeText(key);
                                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Management Key copied to clipboard!'));
                            }
                        });
                        break;
                    case 'changeManagementKey':
                        this.handleChangeManagementKey();
                        break;
                    case 'generateApiKey':
                        this._proxyManager.generateApiKey();
                        break;
                    case 'toggleApiKey':
                        this._proxyManager.toggleApiKey(message.key);
                        break;
                    case 'toggleAutoStart':
                        this._proxyManager.setAutoStart(message.enabled);
                        break;
                    case 'openAuthFile': {
                        const info = this._proxyManager.getProviderAuthInfo(message.provider);
                        if (info) {
                            vscode.workspace.openTextDocument(info.filePath).then(doc => vscode.window.showTextDocument(doc));
                        }
                        break;
                    }
                    case 'deleteAuthFile': {
                        const confirm = await vscode.window.showWarningMessage(
                            LocalizationManager.getInstance().t('Are you sure you want to sign out from {0}? This will delete the authentication file.', message.provider),
                            { modal: true },
                            LocalizationManager.getInstance().t('Sign Out')
                        );
                        if (confirm === LocalizationManager.getInstance().t('Sign Out')) {
                            this._proxyManager.deleteProviderAuth(message.provider);
                        }
                        break;
                    }
                    case 'deleteZai': {
                        const confirmZai = await vscode.window.showWarningMessage(
                            LocalizationManager.getInstance().t('Are you sure you want to remove Z.AI configuration?'),
                            { modal: true },
                            LocalizationManager.getInstance().t('Remove')
                        );
                        if (confirmZai === LocalizationManager.getInstance().t('Remove')) {
                            this._proxyManager.deleteZai();
                        }
                        break;
                    }
                    case 'toggleZai':
                        this._proxyManager.toggleZai(message.enabled);
                        break;
                    case 'loginCodex':
                        this._proxyManager.initiateOAuthFlow('codex');
                        break;
                    case 'loginClaude':
                        this._proxyManager.initiateOAuthFlow('claude');
                        break;
                    case 'loginQwen':
                        this._proxyManager.initiateOAuthFlow('qwen');
                        break;
                    case 'loginKimi':
                        this._proxyManager.initiateOAuthFlow('kimi');
                        break;
                    case 'deleteSpecificAuthFile':
                        if (message.provider && message.fileName) {
                            const confirmSpecific = await vscode.window.showWarningMessage(
                                LocalizationManager.getInstance().t('Are you sure you want to delete this account?'),
                                { modal: true },
                                LocalizationManager.getInstance().t('Delete')
                            );
                            if (confirmSpecific === LocalizationManager.getInstance().t('Delete')) {
                                this._proxyManager.deleteSpecificAuthFile(message.provider, message.fileName);
                            }
                        }
                        break;
                    case 'openSpecificAuthFile':
                        if (message.provider && message.fileName) {
                            const allInfos = this._proxyManager.getAllProviderAuthInfos(message.provider);
                            const fileInfo = allInfos.find(i => i.fileName === message.fileName);
                            if (fileInfo) {
                                vscode.workspace.openTextDocument(fileInfo.filePath).then(doc => vscode.window.showTextDocument(doc));
                            }
                        }
                        break;
                    // MCP Commands
                    case 'installMcpConfig':
                        this.installMcpConfig();
                        break;
                    case 'openMcpConfig':
                        this.openMcpConfig();
                        break;
                    case 'toggleMcpAutoStart':
                        vscode.workspace.getConfiguration('antigravity-storage-manager').update('mcp.autoStart', message.enabled, vscode.ConfigurationTarget.Global);
                        break;
                    case 'runMcpServer':
                        await this.runMcpServer(); // Opens terminal
                        break;
                    case 'stopMcpServer':
                        await this.stopMcpServer();
                        break;
                    case 'testMcpMethod':
                        this.testMcpMethod(message.method, message.args);
                        break;
                    case 'createMcpCommand':
                        this.handleCreateMcpCommand();
                        break;
                    case 'openMcpCommand':
                        this.handleOpenMcpCommand(message.filename);
                        break;
                    case 'editMcpCommand':
                        this.handleEditMcpCommand(message.filename);
                        break;
                    case 'deleteMcpCommand':
                        this.handleDeleteMcpCommand(message.filename);
                        break;
                    case 'showMcpCommandInfo':
                        this._panel?.webview.postMessage({ command: 'openMcpInfo' });
                        break;
                    case 'killPort': {
                        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                        const port = config.get<number>('proxy.port', 8317);
                        const killed = await this._proxyManager.killProcessOnPort(port);
                        if (killed) {
                            vscode.window.showInformationMessage(lm.t('Process on port {0} killed successfully.', port));
                        } else {
                            vscode.window.showWarningMessage(lm.t('No process found on port {0} or failed to kill.', port));
                        }
                        break;
                    }
                    case 'viewQuota': {
                        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                        const port = config.get<number>('proxy.port', 8317);
                        const provider = message.provider as string;
                        const fileName = message.fileName as string;

                        // Get management key
                        const secretKey = await this._proxyManager.getManagementKey();
                        if (!secretKey) {
                            this._panel?.webview.postMessage({
                                command: 'quotaResult',
                                error: lm.t('Management key not found. Please set it first.'),
                                provider,
                                fileName
                            });
                            break;
                        }

                        try {
                            // First, get auth files to find the authIndex
                            const authFilesResponse = await fetch(`http://127.0.0.1:${port}/v0/management/auth-files`, {
                                headers: {
                                    'Authorization': `Bearer ${secretKey}`,
                                },
                            });

                            if (!authFilesResponse.ok) {
                                this._panel?.webview.postMessage({
                                    command: 'quotaResult',
                                    error: lm.t('Failed to get auth files: {0}', `${authFilesResponse.status} ${authFilesResponse.statusText}`),
                                    provider,
                                    fileName
                                });
                                break;
                            }

                            interface AuthFileItem {
                                name: string;
                                authIndex?: string | number;
                                auth_index?: string | number;
                                type?: string;
                                // For Codex: chatgpt account id
                                chatgpt_account_id?: string;
                                chatgptAccountId?: string;
                                account_id?: string;
                                accountId?: string;
                                project_id?: string;
                            }

                            const authFilesData = await authFilesResponse.json() as { files?: AuthFileItem[] } | AuthFileItem[];
                            const authFiles = Array.isArray(authFilesData) ? authFilesData : (authFilesData.files || []);

                            // Find the matching auth file by name
                            const authFile = authFiles.find((f: AuthFileItem) => f.name === fileName);
                            if (!authFile) {
                                this._panel?.webview.postMessage({
                                    command: 'quotaResult',
                                    error: lm.t('Auth file not found: {0}', fileName),
                                    provider,
                                    fileName
                                });
                                break;
                            }

                            if (provider === 'gemini-cli') {
                                // Fallthrough to api-call logic
                            }

                            // Get authIndex from the file object
                            const rawAuthIndex = authFile.authIndex ?? authFile.auth_index;
                            const authIndex = rawAuthIndex !== undefined && rawAuthIndex !== null ? String(rawAuthIndex) : null;

                            if (!authIndex) {
                                this._panel?.webview.postMessage({
                                    command: 'quotaResult',
                                    error: lm.t('No authIndex found for file: {0}', fileName),
                                    provider,
                                    fileName
                                });
                                break;
                            }

                            // Build payload for api-call endpoint
                            let payload: object;
                            if (provider === 'codex') {
                                // For Codex: GET https://chatgpt.com/backend-api/wham/usage
                                // Requires Chatgpt-Account-Id header
                                const chatgptAccountId = authFile.chatgpt_account_id ?? authFile.chatgptAccountId ?? authFile.account_id ?? authFile.accountId ?? '';
                                const headers: Record<string, string> = {
                                    'Authorization': 'Bearer $TOKEN$',
                                    'Content-Type': 'application/json',
                                    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
                                };
                                if (chatgptAccountId) {
                                    headers['Chatgpt-Account-Id'] = chatgptAccountId;
                                }
                                payload = {
                                    authIndex,
                                    method: 'GET',
                                    url: 'https://chatgpt.com/backend-api/wham/usage',
                                    header: headers
                                };
                            } else if (provider === 'gemini-cli') {
                                // For Gemini CLI: POST to Google API with project_id from auth file
                                let projectId = (authFile as any).project_id;
                                if (!projectId) {
                                    // Try to parse from filename: gemini-<email>-<project>.json
                                    const match = fileName.match(/^gemini-(?:.+?)-(.+?)\.json$/);
                                    if (match && match[1]) {
                                        projectId = match[1];
                                    } else {
                                        projectId = 'antigravity-sync-484813'; // Fallback
                                    }
                                }

                                payload = {
                                    authIndex,
                                    method: 'POST',
                                    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
                                    header: {
                                        'Authorization': 'Bearer $TOKEN$',
                                        'Content-Type': 'application/json'
                                    },
                                    data: JSON.stringify({ project: projectId })
                                };
                            } else {
                                // For Antigravity: POST to Google API with project_id
                                payload = {
                                    authIndex,
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

                            const response = await fetch(`http://127.0.0.1:${port}/v0/management/api-call`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${secretKey}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify(payload),
                            });

                            if (!response.ok) {
                                const errorText = await response.text();
                                this._panel?.webview.postMessage({
                                    command: 'quotaResult',
                                    error: `${response.status} ${response.statusText}: ${errorText}`,
                                    provider,
                                    fileName
                                });
                                break;
                            }

                            const data = await response.json();
                            this._panel?.webview.postMessage({
                                command: 'quotaResult',
                                data,
                                provider,
                                fileName
                            });
                        } catch (err: unknown) {
                            const errorMsg = err instanceof Error ? err.message : String(err);
                            this._panel?.webview.postMessage({
                                command: 'quotaResult',
                                error: lm.t('Failed to fetch quota: {0}', errorMsg),
                                provider,
                                fileName
                            });
                        }
                        break;
                    }
                    case 'getMcpStatus':
                        this._panel?.webview.postMessage({ command: 'mcpStatus', running: !!this._mcpTerminal });
                        break;
                    case 'switchProfile':
                        if (message.profile) {
                            if (this._profileManager) {
                                try {
                                    await this._profileManager.switchProfile(message.profile);
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(lm.t('Failed to switch profile: {0}', e.message));
                                }
                            }
                        }
                        break;
                    case 'saveDashboardState': {
                        const currentState = this._proxyManager.getDashboardState();
                        if (message.key) {
                            currentState[message.key] = message.value;
                            await this._proxyManager.updateDashboardState(currentState);
                        }
                        break;
                    }

                }
            },
            null,
            this._disposables
        );

        // Listen for status changes
        this._proxyManager.onDidChangeStatus(() => {
            this.update();
        }, null, this._disposables);

        // Setup file watcher for auth directory to detect new auth files
        this.setupAuthDirWatcher();

        this.update();

        // Prompt for secret key if empty
        this.promptForSecretKeyIfEmpty();
    }

    private setupAuthDirWatcher() {
        // Dispose existing watcher if any
        if (this._authDirWatcher) {
            this._authDirWatcher.dispose();
            this._authDirWatcher = undefined;
        }

        const authDir = this._proxyManager.getAuthDir();
        if (!authDir) return;

        // Watch for .json files in auth directory
        const pattern = new vscode.RelativePattern(authDir, '*.json');
        this._authDirWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const debouncedRefresh = () => {
            // Debounce refresh to avoid rapid updates
            if (this._refreshDebounceTimeout) {
                clearTimeout(this._refreshDebounceTimeout);
            }
            this._refreshDebounceTimeout = setTimeout(() => {
                this.update();
            }, 1000); // 1 second debounce
        };

        this._authDirWatcher.onDidCreate(debouncedRefresh, null, this._disposables);
        this._authDirWatcher.onDidChange(debouncedRefresh, null, this._disposables);
        this._authDirWatcher.onDidDelete(debouncedRefresh, null, this._disposables);

        this._disposables.push(this._authDirWatcher);
    }

    private async promptForSecretKeyIfEmpty() {
        if (!this._proxyManager.isSecretKeyEmpty()) {
            return;
        }
        const lm = LocalizationManager.getInstance();
        const password = await vscode.window.showInputBox({
            title: lm.t('Set Management Key'),
            prompt: lm.t('The secret-key is empty. Please enter a password for the proxy management key.'),
            password: true,
            ignoreFocusOut: true,
            validateInput: value => {
                if (!value || value.length < 4) {
                    return lm.t('Password must be at least 4 characters');
                }
                return null;
            }
        });
        if (password) {
            const success = await this._proxyManager.setSecretKey(password);
            if (success) {
                vscode.window.showInformationMessage(lm.t('Management key has been set.'));
                this.update();
            }
        }
    }

    private async handleAddProvider(providerId: string, data: any) {
        await this._proxyManager.addProvider(providerId, data);
    }

    private async openConfigFile() {
        // Open the actual config.yaml near the executable
        const exePath = this._proxyManager.getExecutablePath();
        const dir = path.dirname(exePath);
        const configPath = path.join(dir, 'config.yaml');

        if (fs.existsSync(configPath)) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
            await vscode.window.showTextDocument(doc);
        } else {
            // Fallback to settings
            vscode.commands.executeCommand('workbench.action.openSettings', 'antigravity-storage-manager.proxy');
        }
    }

    private async handleChangeManagementKey() {
        const lm = LocalizationManager.getInstance();
        const newKey = await vscode.window.showInputBox({
            title: lm.t('Set New Management Key'),
            prompt: lm.t('Enter a new secret key for the proxy management interface.'),
            password: true,
            ignoreFocusOut: true,
            validateInput: value => {
                if (!value || value.length < 4) {
                    return lm.t('Key must be at least 4 characters');
                }
                return null;
            }
        });

        if (newKey) {
            const success = await this._proxyManager.updateManagementKey(newKey);
            if (success) {
                const reload = lm.t('Reload Window');
                const result = await vscode.window.showInformationMessage(
                    lm.t('Management Key updated successfully. Please reload the window to apply changes.'),
                    reload
                );
                if (result === reload) {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
                this.update();
            }
        }
    }

    private async locateMcpConfig(): Promise<vscode.Uri | undefined> {
        const homeDir = os.homedir();
        const platform = process.platform;

        // Potential paths for MCP config (Roo Code, Cline, and specific user path)
        const candidates: string[] = [];

        // 1. Check specific Gemini/Antigravity path (User requested)
        candidates.push(path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json'));

        // 2. Standard Global Storage Paths
        const configFiles = ['cline_mcp_settings.json', 'mcp_config.json'];

        let globalStoragePath = '';
        if (platform === 'win32') {
            globalStoragePath = path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage');
        } else if (platform === 'darwin') {
            globalStoragePath = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
        } else {
            globalStoragePath = path.join(homeDir, '.config', 'Code', 'User', 'globalStorage');
        }

        const extensions = [
            'rooveterinaryinc.roo-cline',
            'saoudrizwan.claude-dev'
        ];

        for (const ext of extensions) {
            for (const file of configFiles) {
                candidates.push(path.join(globalStoragePath, ext, 'settings', file));
            }
        }

        // 3. Check workspace root for local override
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                for (const file of configFiles) {
                    candidates.unshift(path.join(folder.uri.fsPath, file));
                    candidates.unshift(path.join(folder.uri.fsPath, '.vscode', file));
                }
            }
        }

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return vscode.Uri.file(candidate);
            }
        }
        return undefined;
    }

    private async openMcpConfig() {
        const lm = LocalizationManager.getInstance();

        // 1. Try to auto-locate
        const configUri = await this.locateMcpConfig();
        if (configUri) {
            await vscode.window.showTextDocument(configUri);
            return;
        }

        // 2. Ask user to pick file if not found
        const fileUris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'JSON': ['json'] },
            title: lm.t('Select MCP Configuration File to Open')
        });

        if (fileUris && fileUris.length > 0) {
            await vscode.window.showTextDocument(fileUris[0]);
        } else {
            vscode.window.showInformationMessage(lm.t('No MCP config file found or selected.'));
        }
    }

    private async installMcpConfig() {
        const lm = LocalizationManager.getInstance();

        // Target specifically the Antigravity MCP config location
        const homeDir = os.homedir();
        const defaultPath = path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json');
        let uri = vscode.Uri.file(defaultPath);

        try {
            const defaultDir = path.dirname(defaultPath);
            if (!fs.existsSync(defaultDir)) {
                fs.mkdirSync(defaultDir, { recursive: true });
            }
            if (!fs.existsSync(defaultPath)) {
                fs.writeFileSync(defaultPath, '{}');
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Failed to create default MCP config: {0}', e.message));
            // Fallback to dialog if auto-create failed
            const fileUris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'JSON': ['json'] },
                title: lm.t('Select MCP Configuration File to Install/Update')
            });
            if (fileUris && fileUris.length > 0) {
                uri = fileUris[0];
            } else {
                return;
            }
        }

        try {
            // Deploy Script First
            const deployedScriptPath = await this._proxyManager.deployMcpServerScript(this._extensionUri);
            const mcpScriptPath = deployedScriptPath.replace(/\\/g, '/'); // Ensure forward slashes for JSON

            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText();
            let json: any = {};
            try {
                json = JSON.parse(text);
            } catch {
                // If empty or invalid, start fresh if acceptable, but better parsing error handling needed
                json = {};
            }

            if (!json.mcpServers) json.mcpServers = {};

            // Get API Key if available
            const apiKeys = this._proxyManager.getApiKeys();
            const apiKey = apiKeys.length > 0 ? apiKeys[0].key : 'YOUR_API_KEY';

            json.mcpServers['antigravity-proxy'] = {
                command: 'node',
                args: [mcpScriptPath],
                env: {
                    PROXY_API_KEY: apiKey
                },
                disabled: false,
                autoApprove: []
            };

            // 3. Write back
            const newText = JSON.stringify(json, null, 2);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(newText, 'utf8'));

            vscode.window.showInformationMessage(lm.t('Successfully installed antigravity-proxy to {0}', path.basename(uri.fsPath)));
            await vscode.window.showTextDocument(uri);

        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Failed to update config: {0}', e.message));
        }
    }

    private async runMcpServer() {
        // Kill existing terminal if running to force restart
        if (this._mcpTerminal) {
            this._mcpTerminal.dispose();
            this._mcpTerminal = undefined;
        }

        // Also clean up any orphaned terminals
        vscode.window.terminals.forEach(t => {
            if (t.name === 'Antigravity MCP Inspector') {
                t.dispose();
            }
        });

        // Run in terminal
        const deployedScriptPath = await this._proxyManager.deployMcpServerScript(this._extensionUri);

        this._mcpTerminal = vscode.window.createTerminal('Antigravity MCP Inspector');
        const apiKeys = this._proxyManager.getApiKeys();
        const apiKey = apiKeys.length > 0 ? apiKeys[0].key : '';
        const managementKey = await this._proxyManager.getManagementKey();

        if (process.platform === 'win32') {
            this._mcpTerminal.sendText(`$env:PROXY_API_KEY="${apiKey}"`);
            if (managementKey) {
                // Escape double quotes if necessary, though simpler is better for now.
                // PowerShell string interpolation
                this._mcpTerminal.sendText(`$env:PROXY_MANAGEMENT_KEY="${managementKey}"`);
            }
            this._mcpTerminal.sendText(`node "${deployedScriptPath}"`);
        } else {
            this._mcpTerminal.sendText(`export PROXY_API_KEY="${apiKey}"`);
            if (managementKey) {
                this._mcpTerminal.sendText(`export PROXY_MANAGEMENT_KEY="${managementKey}"`);
            }
            this._mcpTerminal.sendText(`node "${deployedScriptPath}"`);
        }
        this._mcpTerminal.show();
        this._panel?.webview.postMessage({ command: 'mcpStatus', running: true });
        this.update();
    }

    private async stopMcpServer() {
        if (this._mcpTerminal) {
            this._mcpTerminal.dispose();
            this._mcpTerminal = undefined;
            this._panel?.webview.postMessage({ command: 'mcpStatus', running: false });
            this.update();
        }
    }

    private async testMcpMethod(method: string, args?: any) {
        const lm = LocalizationManager.getInstance();

        // Handle streaming mode for chat_completion
        if (method === 'chat_completion' && args?.stream === true) {
            return this.testStreamChat(args);
        }
        try {
            const deployedScriptPath = await this._proxyManager.deployMcpServerScript(this._extensionUri);
            const apiKeys = this._proxyManager.getApiKeys();
            const apiKey = apiKeys.length > 0 ? apiKeys[0].key : '';

            // Construct JSON-RPC request
            let rpcReq: any;
            if (method === 'list_tools') {
                rpcReq = { jsonrpc: "2.0", id: 1, method: "tools/list" };
            } else {
                const params: any = { name: method, arguments: {} };
                if (args && Object.keys(args).length > 0) {
                    params.arguments = args;
                }

                rpcReq = {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: params
                };
            }

            // Construct Payload with Handshake (Initialize -> Initialized -> Request)
            const initReq = {
                jsonrpc: "2.0",
                id: 0,
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "antigravity-test-client", version: "1.0" }
                }
            };
            const initializedNotif = { jsonrpc: "2.0", method: "notifications/initialized" };

            const input = JSON.stringify(initReq) + '\n' +
                JSON.stringify(initializedNotif) + '\n' +
                JSON.stringify(rpcReq) + '\n';

            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require('fs');
            if (!fs.existsSync(deployedScriptPath)) {
                throw new Error(`MCP script not found at ${deployedScriptPath}`);
            }

            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const cp = require('child_process');
            const child = cp.spawn('node', [deployedScriptPath], {
                env: { ...process.env, PROXY_API_KEY: apiKey }
            });

            let output = '';
            let error = '';

            child.on('error', (err: any) => {
                error += `Process error: ${err.message}\n`;
            });

            child.stdout.on('data', (data: Buffer) => output += data.toString());
            child.stderr.on('data', (data: Buffer) => error += data.toString());

            child.stdin.end(input);
            // Don't close stdin immediately as server might need it open, but for one-off request it's ok to leave open until kill

            setTimeout(() => {
                child.kill();

                let displayResult = '';
                try {
                    const lines = output.split('\n');
                    // Find response with id: 1 (our target request)
                    const jsonLine = lines.find(l => {
                        try {
                            const p = JSON.parse(l);
                            return p.id === 1;
                        } catch { return false; }
                    });

                    if (jsonLine) {
                        const jsonRes = JSON.parse(jsonLine);
                        if (jsonRes.result) {
                            displayResult = JSON.stringify(jsonRes.result, null, 2);
                        } else if (jsonRes.error) {
                            displayResult = 'Error: ' + JSON.stringify(jsonRes.error, null, 2);
                        } else {
                            displayResult = jsonLine;
                        }
                    } else {
                        // If logic failed, show raw output for debugging
                        displayResult = output || (error ? `Error/Stderr: ${error}` : 'No output from MCP server process (Check logs)');
                    }
                } catch {
                    displayResult = output + (error ? '\nStderr: ' + error : '');
                }

                // Calculate likely headers for display
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'Authorization': apiKey ? `Bearer ${apiKey}` : 'Bearer test-key'
                };

                if (rpcReq.method === 'tools/call' && rpcReq.params?.name === 'chat_completion') {
                    const model = rpcReq.params.arguments?.model || '';
                    const providerId = model.includes('/') ? model.split('/')[0] : '';

                    const userAgentMap: Record<string, string> = {
                        'antigravity': 'Antigravity/1.0.0',
                        'gemini': 'gemini-cli/1.0.0',
                        'github-copilot': 'GitHubCopilotChat/0.26.7',
                        'claude': 'claude-code/1.0.0',
                        'codex': 'codex-cli/1.0.0'
                    };

                    let ua = userAgentMap[providerId];
                    if (!ua) {
                        const m = model.toLowerCase();
                        if (m.includes('gemini')) ua = 'gemini-cli/1.0.0';
                        else if (m.includes('claude')) ua = 'claude-code/1.0.0';
                        else if (m.includes('copilot') || m.includes('gpt')) ua = 'GitHubCopilotChat/0.26.7';
                    }
                    if (ua) {
                        headers['User-Agent'] = ua;
                        if (ua.includes('GitHubCopilot')) {
                            headers['X-GitHub-Api-Version'] = '2022-11-28';
                        }
                    }
                }

                const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                const port = config.get<number>('proxy.port', 8317);
                let baseUrl = `http://127.0.0.1:${port}/v1`;

                // Append endpoint based on method
                if (method === 'chat_completion') {
                    baseUrl += '/chat/completions';
                } else if (method === 'list_models') {
                    baseUrl += '/models';
                } else if (method === 'list_tools') {
                    // This is an MCP system call, but we can show the base v1 if we want, 
                    // or just leave as /v1. Let's keep /v1 for sys calls.
                }

                this._panel?.webview.postMessage({
                    command: 'mcpTestResult',
                    result: displayResult,
                    request: JSON.stringify(rpcReq, null, 2),
                    headers: JSON.stringify(headers, null, 2),
                    baseUrl: baseUrl
                });

            }, 5000);

        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Failed to test MCP: {0}', e.message));
        }
    }

    private async testStreamChat(args: { model: string; messages: { role: string; content: string }[] }) {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const port = config.get<number>('proxy.port', 8317);
        const apiKeys = this._proxyManager.getApiKeys();
        const apiKey = apiKeys.length > 0 ? apiKeys[0].key : '';

        // Prepare model - extract provider from "provider/model" format and set User-Agent
        const prepareModelRequest = (modelInput: string) => {
            let providerId = '';
            let modelName = modelInput;

            if (modelInput.includes('/')) {
                const parts = modelInput.split('/');
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
                const modelLower = modelInput.toLowerCase();
                if (modelLower.includes('gemini') || modelLower.includes('aistudio')) userAgent = 'gemini-cli/1.0.0';
                else if (modelLower.includes('claude')) userAgent = 'claude-code/1.0.0';
                else if (modelLower.includes('codex')) userAgent = 'codex-cli/1.0.0';
                else if (modelLower.includes('copilot') || modelLower.includes('gpt')) userAgent = 'GitHubCopilotChat/0.26.7';
                else if (modelLower.includes('qwen')) userAgent = 'qwen-cli/1.0.0';
            }

            let finalModel = modelInput;
            // For OAuth channels, use only the modelName (proxy uses User-Agent for routing)
            if (oauthChannels.includes(providerId)) {
                finalModel = modelName;
            }
            // If provider is 'openai', strip the prefix as well for proxy compatibility
            if (providerId === 'openai') {
                finalModel = modelName;
            }

            return { finalModel, userAgent };
        };

        const { finalModel, userAgent } = prepareModelRequest(args.model);

        const url = `http://127.0.0.1:${port}/v1/chat/completions`;
        const body = {
            model: finalModel,
            messages: args.messages,
            stream: true
        };

        // Build headers
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };
        if (userAgent) {
            headers['User-Agent'] = userAgent;
            if (userAgent.includes('GithubCopilot') || userAgent.includes('GitHubCopilot')) {
                headers['X-GitHub-Api-Version'] = '2022-11-28';
            }
        }

        // Show output container and prepare for streaming
        this._panel?.webview.postMessage({
            command: 'streamStart',
            baseUrl: url
        });

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                this._panel?.webview.postMessage({
                    command: 'streamEnd',
                    error: `HTTP ${response.status}: ${errorText}`
                });
                return;
            }

            // Read streaming response
            const reader = response.body?.getReader();
            if (!reader) {
                this._panel?.webview.postMessage({
                    command: 'streamEnd',
                    error: 'No response body'
                });
                return;
            }

            const decoder = new TextDecoder();
            let buffer = '';
            let fullContent = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') continue;
                        if (!data) continue;

                        try {
                            const json = JSON.parse(data);
                            const content = json.choices?.[0]?.delta?.content;
                            if (content) {
                                fullContent += content;
                                this._panel?.webview.postMessage({
                                    command: 'streamChunk',
                                    content
                                });
                            }
                        } catch {
                            // Skip malformed JSON
                        }
                    }
                }
            }

            // Send final result
            this._panel?.webview.postMessage({
                command: 'streamEnd',
                fullContent,
                request: JSON.stringify(body, null, 2)
            });

        } catch (e: any) {
            this._panel?.webview.postMessage({
                command: 'streamEnd',
                error: e.message
            });
        }
    }

    private async update() {
        if (this._panel) {
            this._panel.title = LocalizationManager.getInstance().t('Antigravity Proxy Dashboard');

            // Fetch details for all providers
            const providers = ['antigravity', 'codex', 'kimi', 'qwen', 'github-copilot', 'claude', 'gemini-cli'];
            const accountDetails = new Map<string, AccountDetails[]>(); // provider -> details[]

            for (const provider of providers) {
                const accounts = this._proxyManager.getAllProviderAuthInfos(provider);
                const details = await Promise.all(accounts.map(acc => this._proxyManager.getAccountDetails(provider, acc.fileName)));
                const validDetails = details.filter(d => d !== null) as AccountDetails[];
                accountDetails.set(provider, validDetails);
            }

            // Map Antigravity accounts to Profiles
            const antigravityProfiles = new Map<string, string>(); // fileName -> profileName
            if (this._profileManager) {
                const antiDetails = accountDetails.get('antigravity') || [];
                for (const detail of antiDetails) {
                    if (detail.email) {
                        const profile = await this._profileManager.findProfileForAntigravityEmail(detail.email);
                        if (profile) {
                            antigravityProfiles.set(detail.fileName, profile.name);
                        }
                    }
                }
            }

            const mcpCommands = this._proxyManager.getMcpCommands();
            this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, antigravityProfiles, accountDetails, mcpCommands);
        }
    }

    private async handleCreateMcpCommand() {
        const lm = LocalizationManager.getInstance();
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const port = config.get<number>('proxy.port', 8317);

        // Step 1: Command Name
        const commandName = await vscode.window.showInputBox({
            prompt: lm.t('Enter the command name (without slash)'),
            value: 'proxy',
            placeHolder: 'proxy'
        });
        if (!commandName) { return; }

        // Step 2: Filename
        const defaultFilename = `ag-${commandName}.md`;
        const filename = await vscode.window.showInputBox({
            prompt: lm.t('Enter the workflow filename'),
            value: defaultFilename,
            placeHolder: defaultFilename
        });
        if (!filename) { return; }

        // Step 3: Select Models
        interface ModelItem extends vscode.QuickPickItem {
            value: string;
        }

        let models: { id: string; provider: string }[] = [];
        try {
            const apiKeys = this._proxyManager.getApiKeys();
            const apiKey = apiKeys.length > 0 ? apiKeys[0].key : '';
            const headers: Record<string, string> = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

            const response = await this._proxyManager.fetchJson(`http://127.0.0.1:${port}/v1/models`, headers);
            if (response && Array.isArray(response.data)) {

                models = response.data.map((m: any) => ({
                    id: m.id,
                    provider: m.owned_by || 'unknown'
                }));
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(
                lm.t('Failed to fetch models: {0}', [e.message])
            );
        }

        // Group models by provider
        const modelsByProvider = new Map<string, string[]>();
        models.forEach(m => {
            const provider = m.provider;
            if (!modelsByProvider.has(provider)) {
                modelsByProvider.set(provider, []);
            }
            modelsByProvider.get(provider)?.push(m.id);
        });

        // Create QuickPick items
        const quickPickItems: ModelItem[] = [
            { label: lm.t('All Models (Default)'), description: lm.t('Allow all available models'), value: 'all' }
        ];

        // Sort providers for consistent order
        const sortedProviders = Array.from(modelsByProvider.keys()).sort();

        sortedProviders.forEach(provider => {
            quickPickItems.push({
                label: provider,
                kind: vscode.QuickPickItemKind.Separator,
                value: 'separator'
            });

            const providerModels = modelsByProvider.get(provider)?.sort() || [];
            providerModels.forEach(modelId => {
                quickPickItems.push({
                    label: modelId,
                    value: modelId
                });
            });
        });

        const selectedModels = await vscode.window.showQuickPick(
            quickPickItems,
            {
                canPickMany: true,
                placeHolder: lm.t('Select allowed models (optional)')
            }
        );

        if (!selectedModels) { return; }

        const allowedModels = selectedModels
            .filter(m => m.value !== 'all' && m.kind !== vscode.QuickPickItemKind.Separator)
            .map(m => m.value);

        // Step 4: Generate Content
        const workflowContent = this.generateMcpWorkflowContent(commandName, allowedModels);

        // Step 5: Write File
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workflowsDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.agent', 'workflows');
            if (!fs.existsSync(workflowsDir)) {
                fs.mkdirSync(workflowsDir, { recursive: true });
            }

            const finalFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
            const filePath = path.join(workflowsDir, finalFilename);
            fs.writeFileSync(filePath, workflowContent, 'utf8');

            this.update(); // Refresh dashboard to show new command
            vscode.window.showInformationMessage(lm.t('MCP Command "/{0}" created.', commandName)); // Removed filename from message for brevity
        } else {
            vscode.window.showErrorMessage(lm.t('No workspace folder open. Cannot create workflow file.'));
        }
    }

    private async handleOpenMcpCommand(filename: string) {
        const lm = LocalizationManager.getInstance();
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return;
        }
        const workflowsDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.agent', 'workflows');
        const filePath = path.join(workflowsDir, filename);
        if (fs.existsSync(filePath)) {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        } else {
            vscode.window.showErrorMessage(lm.t('Command file not found: {0}', filename));
        }
    }

    private async handleDeleteMcpCommand(filename: string) {
        const lm = LocalizationManager.getInstance();
        const confirm = await vscode.window.showWarningMessage(
            lm.t('Are you sure you want to delete the command "{0}"?', filename),
            { modal: true },
            lm.t('Delete')
        );

        if (confirm === lm.t('Delete')) {
            if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                return;
            }
            const workflowsDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.agent', 'workflows');
            const filePath = path.join(workflowsDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                this.update();
                vscode.window.showInformationMessage(lm.t('Command "{0}" deleted.', filename));
            }
        }
    }

    private async handleEditMcpCommand(filename: string) {
        const lm = LocalizationManager.getInstance();
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return;
        }
        const workflowsDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.agent', 'workflows');
        const filePath = path.join(workflowsDir, filename);

        if (!fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(lm.t('File not found.'));
            return;
        }

        const content = fs.readFileSync(filePath, 'utf8');

        // Parse existing data
        const currentCommandName = filename.replace(/\.md$/, '');

        let currentModels: string[] = [];
        const match = content.match(/\/\/ Allowed models: (\[.*?\])/);
        if (match && match[1]) {
            try {
                currentModels = JSON.parse(match[1]);
            } catch { /* empty */ }
        }

        const newCommandName = await vscode.window.showInputBox({
            title: lm.t('Edit MCP Command Name'),
            value: currentCommandName,
            prompt: lm.t('Enter the slash command name (e.g. "my-command")')
        });

        if (!newCommandName) return;

        // Select Models (reuse logic)
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const port = config.get<number>('proxy.port', 8317);

        interface ModelItem extends vscode.QuickPickItem {
            value: string;
        }

        let allModels: { id: string; provider: string }[] = [];
        try {
            // ... Fetch models logic ...
            const apiKeys = this._proxyManager.getApiKeys();
            const apiKey = apiKeys.length > 0 ? apiKeys[0].key : '';
            const headers: Record<string, string> = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

            const response = await this._proxyManager.fetchJson(`http://127.0.0.1:${port}/v1/models`, headers);
            if (response && Array.isArray(response.data)) {

                allModels = response.data.map((m: any) => ({
                    id: m.id,
                    provider: m.owned_by || 'unknown'
                }));
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(
                lm.t('Failed to fetch models: {0}', [e.message])
            );
        }

        // Group models...
        const modelsByProvider = new Map<string, string[]>();
        allModels.forEach(m => {
            const provider = m.provider;
            if (!modelsByProvider.has(provider)) modelsByProvider.set(provider, []);
            modelsByProvider.get(provider)?.push(m.id);
        });

        const quickPickItems: ModelItem[] = [
            { label: lm.t('All Models (Default)'), description: lm.t('Allow all available models'), value: 'all', picked: currentModels.length === 0 }
        ];

        const sortedProviders = Array.from(modelsByProvider.keys()).sort();
        sortedProviders.forEach(provider => {
            quickPickItems.push({ label: provider, kind: vscode.QuickPickItemKind.Separator, value: 'separator' });
            const providerModels = modelsByProvider.get(provider)?.sort() || [];
            providerModels.forEach(modelId => {
                quickPickItems.push({
                    label: modelId,
                    value: modelId,
                    picked: currentModels.includes(modelId)
                });
            });
        });

        const selectedModels = await vscode.window.showQuickPick(quickPickItems, {
            canPickMany: true,
            placeHolder: lm.t('Select allowed models')
        });

        if (!selectedModels) return;

        const allowedModels = selectedModels
            .filter(m => m.value !== 'all' && m.kind !== vscode.QuickPickItemKind.Separator)
            .map(m => m.value);


        // Generate new content
        const newContent = this.generateMcpWorkflowContent(newCommandName, allowedModels);

        // Write new file
        const newFilename = `${newCommandName}.md`;
        const newFilePath = path.join(workflowsDir, newFilename);

        try {
            if (filename !== newFilename) {
                // Rename scenario: delete old, write new
                fs.unlinkSync(filePath);
            }
            fs.writeFileSync(newFilePath, newContent, 'utf8');
            this.update();
            vscode.window.showInformationMessage(lm.t('Command updated successfully.'));
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Error updating command: {0}', e.message));
        }
    }

    private generateMcpWorkflowContent(commandName: string, allowedModels: string[]): string {
        // Keep description short to fit 250 char limit
        const description = `Delegate requests to the Antigravity Proxy`;

        // Model list in content, not in description
        const modelList = allowedModels.length > 0
            ? `// Allowed models: ${JSON.stringify(allowedModels)}\n\n`
            : '';

        // Using pseudo-code style that is common for workflows
        // Output the result to the conversation, not to console
        return `---
description: ${description}
---

${modelList}## Instructions

When calling \`/${commandName}\`, you must:

1. **Gather context** from the current conversation:
   - Brief description of the current task (1-2 sentences)
   - Relevant code or information discussed earlier
   - Key decisions or constraints

2. **Format the message** as follows:
   \`\`\`
   ## Context
   [Brief task description and relevant information]

   ## Question
   [User's request]
   \`\`\`

3. **Call Antigravity Proxy** via MCP:

\`\`\`javascript
const response = await mcp_antigravity-proxy_chat_completion({
    model: \${input:model?}, // Optional, uses default model from configuration
    messages: [
        { role: 'user', content: \`## Context\\n\${context}\\n\\n## Question\\n\${input:query}\` }
    ]
});
return response.content;
\`\`\`

4. **Return the response** to the user, integrating it into the conversation.

## Usage Examples

- \`/${commandName} model:gpt-5 Explain this code\` — sends request with context
- \`/${commandName} How to optimize this function?\` — uses default model
`;
    }

    public dispose() {
        this._panel?.dispose();
        // Clear debounce timeout
        if (this._refreshDebounceTimeout) {
            clearTimeout(this._refreshDebounceTimeout);
            this._refreshDebounceTimeout = undefined;
        }
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
        this._panel = undefined;
    }

    private _getHtmlForWebview(_webview: vscode.Webview, antigravityProfiles?: Map<string, string>, accountDetails?: Map<string, AccountDetails[]>, mcpCommands: { name: string, filename: string, allowedModels: string[] }[] = []): string {
        const lm = LocalizationManager.getInstance();
        const activeProfile = this._profileManager?.activeProfile;
        const status = this._proxyManager.status;
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const port = config.get<number>('proxy.port', 8317);
        const autoConfig = config.get<boolean>('proxy.autoConfig', true);
        const autoStart = config.get<boolean>('proxy.enabled', false);
        const binaryPath = this._proxyManager.getExecutablePath();
        const binaryPathEscaped = binaryPath.replace(/\\/g, '\\\\');
        const mcpRunning = !!this._mcpTerminal;
        const apiKeys = this._proxyManager.getApiKeys();
        const visibleKeys = apiKeys.filter(k => k.visible).length;
        const totalKeys = apiKeys.length;

        const antigravityAccounts = accountDetails?.get('antigravity') || [];
        const githubAccounts = accountDetails?.get('github-copilot') || [];
        const codexAccounts = accountDetails?.get('codex') || [];
        const claudeAccounts = accountDetails?.get('claude') || [];
        const qwenAccounts = accountDetails?.get('qwen') || [];
        const kimiAccounts = accountDetails?.get('kimi') || [];
        const geminiCliAccounts = accountDetails?.get('gemini-cli') || [];

        // Fetch Dashboard UI State
        const dashboardState = this._proxyManager.getDashboardState() || {};

        // Colors
        const statusColor = status === ProxyStatus.Running ? '#4caf50' :
            status === ProxyStatus.Error ? '#f44336' :
                status === ProxyStatus.Starting ? '#ff9800' : '#757575';

        const webUiUrl = `http://127.0.0.1:${port}/management.html`;

        // SVGs
        const icons = {
            play: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 3L13 8L4 13V3Z" fill="currentColor"/></svg>',
            stop: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="10" height="10" fill="currentColor"/></svg>',
            browser: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2C4.69 2 2 4.69 2 8s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 11c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z" fill="currentColor"/><path d="M8 4C5.79 4 4 5.79 4 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 7c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z" fill="currentColor"/></svg>',
            edit: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.85 2.15c.2-.2.51-.2.71 0l.29.29c.2.2.2.51 0 .71L5.5 11.5 3 12.5l1-2.5 8.35-8.35v.5zM4.4 10.6l.7.7-6.2 6.2-.7-.7 6.2-6.2z" fill="currentColor"/></svg>',
            gear: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.4h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.7 2.4-.5V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM8 11c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z" fill="currentColor"/></svg>',
            install: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 11v2h-2v2h-1v-2H9v-1h2v-2h1v2h2zM10 6.5v3H9v-3H7L10.5 3 14 6.5h-2zM4 3h7v1H4v8h6v1H4a1 1 0 01-1-1V4a1 1 0 011-1z" fill="currentColor"/></svg>',
            logs: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 2H13C13.55 2 14 2.45 14 3V13C14 13.55 13.55 14 13 14H3C2.45 14 2 13.55 2 13V3C2 2.45 2.45 2 3 2ZM11 5H5V6H11V5ZM11 8H5V9H11V8ZM9 11H5V12H9V11Z" fill="currentColor"/></svg>',
            copy: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 4V3H3v7h1v4h7v-1h3V4h-4zm-6 0h5v5H4V4zm6 9H5v-4h5v4zm3-4H9V5h4v4z" fill="currentColor"/></svg>',
            info: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2C4.69 2 2 4.69 2 8s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 11c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-9h-1v2h1V4zm0 3h-1v5h1V7z" fill="currentColor"/></svg>',
            shield: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1L1 4v5c0 3.86 2.97 7.4 7 8.44 4.03-1.04 7-4.58 7-8.44V4l-7-3zm5 8c0 2.97-2.16 5.36-5 6.22-2.84-.86-5-3.25-5-6.22V5.19l5-2.14 5 2.14V9z" fill="currentColor"/></svg>',
            plus: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" fill="currentColor"/></svg>',
            github: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" fill="currentColor"/></svg>',
            sync: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.6 3.4L2.8 5.2h-.4l1.8-1.8.7-.7.9-.9 2.2 2.2-.7.7-1.5-1.5V11h-1V3.4h-.2zM11.4 12.6l1.8-1.8h.4l-1.8 1.8-.7.7-.9.9-2.2-2.2.7-.7 1.5 1.5V5h1v7.6h.2z" fill="currentColor"/></svg>',
            trash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11 1.5v1h3v1h-1v10.5c0 .55-.45 1-1 1H4c-.55 0-1-.45-1-1V3.5H2v-1h3v-1h6zM4.5 13h7V3.5h-7V13zM6 5h1v6H6V5zm3 0h1v6H9V5z" fill="currentColor"/></svg>',
            file: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.71 4.29l-3-3L10 1H4L3 2v12l1 1h9l1-1V5l-.29-.71zM13 14H4V2h5v4h4v8zm-3-9V2l3 3h-3z" fill="currentColor"/></svg>',
            eye: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3C4.5 3 1.5 5.5 1.5 8s3 5 6.5 5 6.5-2.5 6.5-5-3-5-6.5-5zM8 11.5c-1.9 0-3.5-1.6-3.5-3.5S6.1 4.5 8 4.5s3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zM8 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" fill="currentColor"/></svg>',
            eyeOff: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 3C4.5 3 1.5 5.5 1.5 8c0 .8.3 1.6.8 2.3L3.8 8.8C3.6 8.5 3.5 8.3 3.5 8c0-2.5 2-4.5 4.5-4.5.3 0 .5.04.8.1l1.5-1.5C9.6 3.1 8.8 3 8 3zM14.5 8c0-2.5-1.3-4.6-3.3-5.5l-1 1c1.4.7 2.3 2.2 2.3 4 0 .3 0 .6-.1.8l2.2 2.2c.6-1 .9-2.1.9-3.3zM8 11.5c-1.2 0-2.2-.6-2.9-1.5L6.3 8.8c.4.7 1.1 1.2 1.7 1.2 1.1 0 2-.9 2-2 0-.6-.2-1.1-.6-1.5l1.2-1.2C11.2 6 11.5 6.7 11.5 8c0 1.9-1.6 3.5-3.5 3.5zM2.4 2.8L13.2 13.6 12.5 14.3 1.7 3.5 2.4 2.8z" fill="currentColor"/></svg>',
            antigravity: "<svg version='1.1' xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 64 59'><path d='M0,0 L8,0 L14,4 L19,14 L27,40 L32,50 L36,54 L35,59 L30,59 L22,52 L11,35 L6,33 L-1,34 L-6,39 L-14,52 L-22,59 L-28,59 L-27,53 L-22,47 L-17,34 L-10,12 L-5,3 Z ' fill='#3789F9' transform='translate(28,0)'/><path d='M0,0 L8,0 L14,4 L19,14 L25,35 L21,34 L16,29 L11,26 L7,20 L7,18 L2,16 L-3,15 L-8,18 L-12,19 L-9,9 L-4,2 Z ' fill='#6D80D8' transform='translate(28,0)'/><path d='M0,0 L8,0 L14,4 L19,14 L20,19 L13,15 L10,12 L3,10 L-1,8 L-7,7 L-4,2 Z ' fill='#D78240' transform='translate(28,0)'/><path d='M0,0 L5,1 L10,4 L12,9 L1,8 L-5,13 L-10,21 L-13,26 L-16,26 L-9,5 L-4,2 Z M6,7 Z ' fill='#3294CC' transform='translate(25,14)'/><path d='M0,0 L5,2 L10,10 L12,18 L5,14 L1,10 L0,4 L-3,3 L0,2 Z ' fill='#E45C49' transform='translate(36,1)'/><path d='M0,0 L9,1 L12,3 L12,5 L7,6 L4,8 L-1,11 L-5,12 L-2,2 Z ' fill='#90AE64' transform='translate(21,7)'/><path d='M0,0 L5,1 L5,4 L-2,7 L-7,11 L-11,10 L-9,5 L-4,2 Z ' fill='#53A89A' transform='translate(25,14)'/><path d='M0,0 L5,0 L16,9 L17,13 L12,12 L8,9 L8,7 L4,5 L0,2 Z ' fill='#B5677D' transform='translate(33,11)'/><path d='M0,0 L6,0 L14,6 L19,11 L23,12 L22,15 L15,12 L10,8 L10,6 L4,5 Z ' fill='#778998' transform='translate(27,12)'/><path d='M0,0 L4,2 L-11,17 L-12,14 L-5,4 Z ' fill='#3390DF' transform='translate(26,21)'/><path d='M0,0 L2,1 L-4,5 L-9,9 L-13,13 L-14,10 L-13,7 L-6,4 L-3,1 Z ' fill='#3FA1B7' transform='translate(27,18)'/><path d='M0,0 L4,0 L9,5 L13,6 L12,9 L5,6 L0,2 Z ' fill='#8277BB' transform='translate(37,18)'/><path d='M0,0 L5,1 L7,6 L-2,5 Z M1,4 Z ' fill='#4989CF' transform='translate(30,17)'/><path d='M0,0 L5,1 L2,3 L-3,6 L-7,7 L-6,3 Z ' fill='#71B774' transform='translate(23,12)'/><path d='M0,0 L7,1 L9,7 L5,6 L0,1 Z ' fill='#6687E9' transform='translate(44,28)'/><path d='M0,0 L7,0 L5,1 L5,3 L8,4 L4,5 L-2,4 Z ' fill='#C7AF38' transform='translate(23,3)'/><path d='M0,0 L8,0 L8,3 L4,4 L-4,3 Z ' fill='#EF842A' transform='translate(28,0)'/><path d='M0,0 L7,4 L7,6 L10,6 L11,10 L4,6 L0,2 Z ' fill='#CD5D67' transform='translate(37,9)'/><path d='M0,0 L5,2 L9,8 L8,11 L2,3 L0,2 Z ' fill='#F35241' transform='translate(36,1)'/><path d='M0,0 L8,2 L9,6 L4,5 L0,2 Z ' fill='#A667A2' transform='translate(41,18)'/><path d='M0,0 L9,1 L8,3 L-2,3 Z ' fill='#A4B34C' transform='translate(21,7)'/><path d='M0,0 L2,0 L7,5 L8,7 L3,6 L0,2 Z ' fill='#617FCF' transform='translate(35,18)'/><path d='M0,0 L5,2 L8,7 L4,5 L0,2 Z ' fill='#9D7784' transform='translate(33,11)'/><path d='M0,0 L6,2 L6,4 L0,3 Z ' fill='#BC7F59' transform='translate(31,7)'/></svg>",
            z_ai: `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="16" height="16" viewBox="0 0 30 30" style="enable-background:new 0 0 30 30;" xml:space="preserve"><style type="text/css">.zai_st0{opacity:0.3;fill:#E2E4E7;}.zai_st1{opacity:0.8;fill:#E2E4E7;stroke:#FFFFFF;stroke-width:5;stroke-miterlimit:10;}.zai_st2{fill:url(#SVGID_1_);}.zai_st3{fill:none;stroke:#E0E4E9;stroke-width:0.25;stroke-miterlimit:10;}.zai_st4{fill:none;}.zai_st5{fill:#9DA1A5;}.zai_st6{fill-rule:evenodd;clip-rule:evenodd;fill:none;}.zai_st7{fill-rule:evenodd;clip-rule:evenodd;fill:#DFE2E7;}.zai_st8{fill-rule:evenodd;clip-rule:evenodd;fill:#CDD4DA;}.zai_st9{fill-rule:evenodd;clip-rule:evenodd;fill:#B3BCC7;}.zai_st10{fill-rule:evenodd;clip-rule:evenodd;fill:#9DAAB7;}.zai_st11{fill-rule:evenodd;clip-rule:evenodd;fill:#8698A8;}.zai_st12{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_2_);}.zai_st13{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_3_);}.zai_st14{fill:#1F63EC;}.zai_st15{fill:#2D2D2D;}.zai_st16{fill:none;stroke:#E0E4E9;stroke-width:0.5;stroke-miterlimit:10;}.zai_st17{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_4_);}.zai_st18{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_5_);}.zai_st19{fill:none;stroke:#677380;stroke-width:0.5;stroke-miterlimit:10;}.zai_st20{fill:none;stroke:url(#SVGID_6_);stroke-width:2;stroke-miterlimit:10;}.zai_st21{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_7_);}.zai_st22{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_8_);}.zai_st23{fill:#FFFFFF;}.zai_st24{fill-rule:evenodd;clip-rule:evenodd;fill:#2D2D2D;}.zai_st25{clip-path:url(#SVGID_10_);}.zai_st26{clip-path:url(#SVGID_12_);}.zai_st27{fill:url(#SVGID_13_);}.zai_st28{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_14_);}.zai_st29{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_15_);}.zai_st30{clip-path:url(#SVGID_17_);}.zai_st31{clip-path:url(#SVGID_19_);}.zai_st32{fill:url(#SVGID_20_);}.zai_st33{fill:none;stroke:url(#SVGID_21_);stroke-width:2;stroke-miterlimit:10;}.zai_st34{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_22_);}.zai_st35{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_23_);}.zai_st36{clip-path:url(#SVGID_25_);}.zai_st37{clip-path:url(#SVGID_27_);}.zai_st38{fill:url(#SVGID_28_);}.zai_st39{clip-path:url(#SVGID_30_);}.zai_st40{clip-path:url(#SVGID_32_);}.zai_st41{fill:url(#SVGID_33_);}.zai_st42{fill-rule:evenodd;clip-rule:evenodd;fill:#126EF6;}.zai_st43{fill-rule:evenodd;clip-rule:evenodd;fill:#FFFFFF;}.zai_st44{clip-path:url(#SVGID_35_);}.zai_st45{clip-path:url(#SVGID_37_);}.zai_st46{fill:url(#SVGID_38_);}.zai_st47{fill-rule:evenodd;clip-rule:evenodd;fill:#9DA1A5;}.zai_st48{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_39_);}.zai_st49{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_40_);}.zai_st50{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_41_);}.zai_st51{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_42_);}.zai_st52{fill:none;stroke:url(#SVGID_43_);stroke-width:2;stroke-miterlimit:10;}.zai_st53{fill-rule:evenodd;clip-rule:evenodd;fill:none;stroke:#E0E4E9;stroke-width:0.5;stroke-miterlimit:10;}.zai_st54{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_44_);}.zai_st55{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_45_);}.zai_st56{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_46_);}.zai_st57{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_47_);}.zai_st58{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_48_);}.zai_st59{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_49_);}.zai_st60{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_50_);}.zai_st61{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_51_);}.zai_st62{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_52_);}.zai_st63{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_53_);}.zai_st64{clip-path:url(#SVGID_55_);}.zai_st65{clip-path:url(#SVGID_57_);}.zai_st66{fill:url(#SVGID_58_);}.zai_st67{clip-path:url(#SVGID_60_);}.zai_st68{clip-path:url(#SVGID_62_);}.zai_st69{fill:url(#SVGID_63_);}.zai_st70{fill:none;stroke:url(#SVGID_64_);stroke-width:2;stroke-miterlimit:10;}.zai_st71{clip-path:url(#SVGID_66_);}.zai_st72{clip-path:url(#SVGID_68_);}.zai_st73{fill:url(#SVGID_69_);}.zai_st74{clip-path:url(#SVGID_71_);}.zai_st75{clip-path:url(#SVGID_73_);}.zai_st76{fill:url(#SVGID_74_);}.zai_st77{clip-path:url(#SVGID_76_);}.zai_st78{clip-path:url(#SVGID_78_);}.zai_st79{fill:url(#SVGID_79_);}.zai_st80{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_80_);}.zai_st81{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_81_);}.zai_st82{clip-path:url(#SVGID_83_);}.zai_st83{clip-path:url(#SVGID_85_);}.zai_st84{fill:url(#SVGID_86_);}.zai_st85{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_87_);}.zai_st86{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_88_);}.zai_st87{clip-path:url(#SVGID_90_);}.zai_st88{clip-path:url(#SVGID_92_);}.zai_st89{fill:url(#SVGID_93_);}.zai_st90{fill:none;stroke:url(#SVGID_94_);stroke-width:2;stroke-miterlimit:10;}.zai_st91{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_95_);}.zai_st92{fill-rule:evenodd;clip-rule:evenodd;fill:url(#SVGID_96_);}.zai_st93{clip-path:url(#SVGID_98_);}.zai_st94{clip-path:url(#SVGID_100_);}.zai_st95{fill:url(#SVGID_101_);}.zai_st96{clip-path:url(#SVGID_103_);}.zai_st97{clip-path:url(#SVGID_105_);}.zai_st98{fill:url(#SVGID_106_);}.zai_st99{clip-path:url(#SVGID_108_);}.zai_st100{clip-path:url(#SVGID_110_);}.zai_st101{fill:url(#SVGID_111_);}.zai_st102{fill:#FFFFFF;stroke:#B3BCC7;stroke-width:0.275;stroke-miterlimit:10;}.zai_st103{clip-path:url(#SVGID_113_);}.zai_st104{fill:#FDD138;}.zai_st105{fill:#FCA62F;}.zai_st106{fill:#FB7927;}.zai_st107{fill:#F44B22;}.zai_st108{fill:#D81915;}.zai_st109{fill:#2D2D2D;stroke:#FFFFFF;stroke-width:0.3354;stroke-miterlimit:10;}.zai_st110{fill:none;stroke:#65727F;stroke-width:2;stroke-miterlimit:10;}.zai_st111{fill:none;stroke:#65727F;stroke-width:0.75;stroke-miterlimit:10;}.zai_st112{fill:url(#SVGID_114_);}.zai_st113{fill:#D06C50;}.zai_st114{fill:#2D2D2D;stroke:#B3BCC7;stroke-width:0.275;stroke-miterlimit:10;}.zai_st115{opacity:0.2;}.zai_st116{fill:none;stroke:#677380;stroke-width:0.3564;stroke-miterlimit:10;}.zai_st117{fill:none;stroke:#677380;stroke-width:0.3564;stroke-miterlimit:10;stroke-dasharray:1.0212,1.0212;}.zai_st118{fill:none;stroke:#677380;stroke-width:0.3564;stroke-miterlimit:10;stroke-dasharray:1.0205,1.0205;}.zai_st119{opacity:0.2;fill:none;}.zai_st120{fill:none;stroke:#677380;stroke-width:0.3689;stroke-miterlimit:10;}.zai_st121{fill:none;stroke:#677380;stroke-width:0.3689;stroke-miterlimit:10;stroke-dasharray:1.0509,1.0509;}.zai_st122{opacity:0.3;fill:#1F63EC;}.zai_st123{fill:#2D2D2D;stroke:#FFFFFF;stroke-width:0.3162;stroke-miterlimit:10;}.zai_st124{fill:#FFFFFF;stroke:#B3BCC7;stroke-width:0.3162;stroke-miterlimit:10;}.zai_st125{clip-path:url(#SVGID_118_);}.zai_st126{fill:url(#SVGID_119_);}.zai_st127{fill:none;stroke:#DFE2E7;stroke-width:0.75;stroke-miterlimit:10;}.zai_st128{fill:#9DA1A5;stroke:#FFFFFF;stroke-miterlimit:10;}.zai_st129{fill:url(#SVGID_120_);}.zai_st130{fill:none;stroke:#677380;stroke-width:0.75;stroke-miterlimit:10;}.zai_st131{opacity:0.4;}.zai_st132{clip-path:url(#SVGID_122_);}.zai_st133{clip-path:url(#SVGID_124_);}.zai_st134{fill:url(#SVGID_125_);}.zai_st135{fill:none;stroke:#8392A3;stroke-width:0.35;stroke-miterlimit:10;}.zai_st136{fill:none;stroke:#8392A3;stroke-width:0.35;stroke-miterlimit:10;stroke-dasharray:0.9951,0.9951;}.zai_st137{fill:none;stroke:#8392A3;stroke-width:0.35;stroke-miterlimit:10;stroke-dasharray:1.004,1.004;}.zai_st138{fill:none;stroke:url(#SVGID_126_);stroke-width:1.5;stroke-miterlimit:10;}.zai_st139{fill:url(#SVGID_127_);}.zai_st140{fill:none;stroke:#DDE0E4;stroke-width:0.35;stroke-miterlimit:10;}.zai_st141{fill:#2D2D2D;stroke:#A9B3BE;stroke-width:0.275;stroke-miterlimit:10;}.zai_st142{fill-rule:evenodd;clip-rule:evenodd;fill:#126EF4;}.zai_st143{fill:#FFFFFF;stroke:#B1BAC4;stroke-width:0.275;stroke-miterlimit:10;}.zai_st144{fill:#CE6C50;}.zai_st145{fill:#5B5B5B;}.zai_st146{fill:#8392A3;}.zai_st147{fill:none;stroke:url(#SVGID_128_);stroke-width:1.5;stroke-miterlimit:10;}.zai_st148{fill:url(#SVGID_129_);}.zai_st149{fill:none;stroke:#B5BDC4;stroke-width:0.7;stroke-miterlimit:10;}.zai_st150{opacity:0.6;fill:none;stroke:#78838E;stroke-width:0.35;stroke-miterlimit:10;}.zai_st151{opacity:0.2;fill:none;stroke:#8392A3;stroke-width:0.35;stroke-miterlimit:10;stroke-dasharray:1,1;}.zai_st152{fill:none;stroke:#DDE0E4;stroke-width:0.75;stroke-miterlimit:10;}.zai_st153{fill:none;stroke:#8392A3;stroke-width:0.5;stroke-miterlimit:10;}.zai_st154{opacity:0.2;fill:none;stroke:#677380;stroke-width:0.3564;stroke-miterlimit:10;stroke-dasharray:1.0182,1.0182;}.zai_st155{fill:none;stroke:#DDE0E4;stroke-width:0.765;stroke-miterlimit:10;}.zai_st156{fill:url(#SVGID_130_);}.zai_st157{fill:url(#SVGID_131_);}.zai_st158{fill:#B1BAC4;}.zai_st159{fill:#CBD1D8;}.zai_st160{fill:#0B1B2B;}.zai_st161{fill:#91D119;}.zai_st162{opacity:0.7;}.zai_st163{fill:#FFFFFF;stroke:#000000;stroke-width:0.4418;stroke-miterlimit:10;}.zai_st164{fill:none;stroke:#939CAA;stroke-width:0.2209;stroke-miterlimit:10;}.zai_st165{fill:none;stroke:#FFFFFF;stroke-width:3.0924;stroke-miterlimit:10;}.zai_st166{fill:url(#SVGID_132_);}.zai_st167{fill:none;stroke:url(#SVGID_133_);stroke-width:1.714;stroke-miterlimit:10;}.zai_st168{fill:url(#SVGID_134_);}.zai_st169{fill:url(#SVGID_135_);}.zai_st170{fill:url(#SVGID_136_);}.zai_st171{fill:url(#SVGID_137_);}.zai_st172{fill:url(#SVGID_138_);}.zai_st173{fill:url(#SVGID_139_);}.zai_st174{fill:url(#SVGID_140_);}.zai_st175{fill:url(#SVGID_141_);}.zai_st176{fill:url(#SVGID_142_);}.zai_st177{fill:url(#SVGID_143_);}.zai_st178{fill:url(#SVGID_144_);}.zai_st179{fill:none;stroke:#1F63EC;stroke-width:4;stroke-miterlimit:10;}.zai_st180{fill:none;stroke:#0B1B2B;stroke-width:4;stroke-miterlimit:10;}.zai_st181{fill:none;stroke:#677380;stroke-width:0.3989;stroke-miterlimit:10;}.zai_st182{fill:none;stroke:#677380;stroke-width:0.3989;stroke-miterlimit:10;stroke-dasharray:1.14,1.14;}.zai_st183{fill:#257AF1;}.zai_st184{opacity:0.3;fill:#FFFFFF;}.zai_st185{fill:none;stroke:#98A5B2;stroke-width:4;stroke-miterlimit:10;}.zai_st186{fill:none;stroke:#65727F;stroke-width:0.3989;stroke-miterlimit:10;}.zai_st187{fill:none;stroke:#65727F;stroke-width:0.3989;stroke-miterlimit:10;stroke-dasharray:1.14,1.14;}.zai_st188{fill:none;stroke:#DDDFE4;stroke-width:0.75;stroke-miterlimit:10;}.zai_st189{fill:#9A9EA2;}.zai_st190{fill-rule:evenodd;clip-rule:evenodd;fill:#3267AC;}.zai_st191{fill:#FFFFFF;stroke:#AFB8C3;stroke-width:0.275;stroke-miterlimit:10;}.zai_st192{fill:#C5694E;}.zai_st193{fill:#8192A2;}.zai_st194{fill:#2D2D2D;stroke:#FFFFFF;stroke-width:0.6317;stroke-miterlimit:10;}</style><g id="图层_2"></g><g id="图层_1"><path class="zai_st194" d="M24.51,28.51H5.49c-2.21,0-4-1.79-4-4V5.49c0-2.21,1.79-4,4-4h19.03c2.21,0,4,1.79,4,4v19.03C28.51,26.72,26.72,28.51,24.51,28.51z"/><g><g><g><g><path class="zai_st23" d="M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z"/><polygon class="zai_st23" points="24.3,7.1 13.14,22.91 5.7,22.91 16.86,7.1 "/><path class="zai_st23" d="M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z"/></g></g></g></g></g></svg>`,
            chart: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 14h-11C2.22 14 2 13.78 2 13.5V2.5c0-.28.22-.5.5-.5h11c.28 0 .5.22.5.5v11c0 .28-.22.5-.5.5zM3 3v10h10V3H3zm2 9V8h2v4H5zm3 0V5h2v7H8zm3 0v-3h2v3h-2z" fill="currentColor"/></svg>',
            warning: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2L1 14h14L8 2zm0 3.8l4.7 8.2H3.3L8 5.8zM7 7h2v4H7V7zm0 5h2v2H7v-2z" fill="currentColor"/></svg>',
            user: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z" fill="currentColor"/></svg>',
            claude: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fill-rule="nonzero"/></svg>',
            qwen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="lobe-icons-qwen-fill" x1="0%" x2="100%" y1="0%" y2="0%"><stop offset="0%" stop-color="#6336E7" stop-opacity=".84"/><stop offset="100%" stop-color="#6F69F7" stop-opacity=".84"/></linearGradient></defs><path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" fill="url(#lobe-icons-qwen-fill)" fill-rule="nonzero"/></svg>',
            gemini: `<svg height='1em' style='flex:none;line-height:1' viewBox='0 0 24 24' width='1em' xmlns='http://www.w3.org/2000/svg'><title>Gemini</title><path d='M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z' fill='#3186FF'></path><path d='M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z' fill='url(#lobe-icons-gemini-fill-0)'></path><path d='M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z' fill='url(#lobe-icons-gemini-fill-1)'></path><path d='M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z' fill='url(#lobe-icons-gemini-fill-2)'></path><defs><linearGradient gradientUnits='userSpaceOnUse' id='lobe-icons-gemini-fill-0' x1='7' x2='11' y1='15.5' y2='12'><stop stop-color='#08B962'></stop><stop offset='1' stop-color='#08B962' stop-opacity='0'></stop></linearGradient><linearGradient gradientUnits='userSpaceOnUse' id='lobe-icons-gemini-fill-1' x1='8' x2='11.5' y1='5.5' y2='11'><stop stop-color='#F94543'></stop><stop offset='1' stop-color='#F94543' stop-opacity='0'></stop></linearGradient><linearGradient gradientUnits='userSpaceOnUse' id='lobe-icons-gemini-fill-2' x1='3.5' x2='17.5' y1='13.5' y2='12'><stop stop-color='#FABC12'></stop><stop offset='.46' stop-color='#FABC12' stop-opacity='0'></stop></linearGradient></defs></svg>`,
            kimi: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19.738 5.776c.163-.209.306-.4.457-.585.07-.087.064-.153-.004-.244-.655-.861-.717-1.817-.34-2.787.283-.73.909-1.072 1.674-1.145.477-.045.945.004 1.379.236.57.305.902.77 1.01 1.412.086.512.07 1.012-.075 1.508-.257.878-.888 1.333-1.753 1.448-.718.096-1.446.108-2.17.157-.056.004-.113 0-.178 0z" fill="#FFFFFF"/><path d="M17.962 1.844h-4.326l-3.425 7.81H5.369V1.878H1.5V22h3.87v-8.477h6.824a3.025 3.025 0 002.743-1.75V22h3.87v-8.477a3.87 3.87 0 00-3.588-3.86v-.01h-2.125a3.94 3.94 0 002.323-2.12l2.545-5.689z" fill="#FFFFFF"/></svg>'
        };

        const configuredProviders = this._proxyManager.getConfiguredProviders();
        const zaiKey = this._proxyManager.getZaiKey() || '';
        const zaiModel = this._proxyManager.getZaiModel();

        const getProviderStatus = (id: string) => {
            const isConfigured = configuredProviders.includes(id);
            return `<div class="provider-status ${isConfigured ? 'connected' : 'not-connected'}">
                <div class="status-dot"></div>
                ${isConfigured ? lm.t('Connected') : lm.t('Not Configured')}
            </div>`;
        };

        const getGeminiCliHtml = () => {
            const accounts = geminiCliAccounts;

            return `
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                        ${icons.gemini} ${lm.t('Gemini CLI')} <span style="opacity:0.6; margin-left:8px; font-weight:normal;">(${accounts.length})</span>
                    </div>
                     ${getProviderStatus('gemini-cli')}
                </div>
                ${accounts.length > 0 ? `
                    <div class="accounts-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
                        ${accounts.map(info => `
                            <div style="background:var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; font-size:0.85em;">
                                <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                    <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; max-width:140px;" title="${info.fileName}">${info.fileName}</span>
                                    <div style="display:flex; gap:4px;">
                                        <button class="secondary icon-only" style="padding:2px" onclick="viewQuota('gemini-cli', '${info.fileName}')" title="${lm.t('View Quotas')}">${icons.chart}</button>
                                        <button class="secondary icon-only" style="padding:2px" onclick="openSpecificAuthFile('gemini-cli', '${info.fileName}')" title="${lm.t('Open File')}">${icons.file}</button>
                                        <button class="secondary icon-only" style="padding:2px; color:var(--vscode-errorForeground);" onclick="deleteSpecificAuthFile('gemini-cli', '${info.fileName}')" title="${lm.t('Delete')}">${icons.trash}</button>
                                    </div>
                                </div>
                                ${info.email ? `<div style="font-size:0.8em; opacity:0.8; margin-top:4px;">${lm.t('Email')}: ${info.email}</div>` : ''}
                                <div style="font-size:0.75em; opacity:0.7; margin-top:2px;">${lm.formatDateTime(info.lastModified)}</div>
                            </div>
                        `).join('')}
                    </div>
                    <div style="margin-top:auto; display:flex; gap:8px; padding-top:12px;">
                        <button class="secondary" style="flex-grow:1" onclick="authenticate('gemini-cli')">${icons.plus} ${lm.t('Add Account')}</button>
                    </div>`
                    : `
                     <div style="flex-grow:1; display:flex; flex-direction:column; gap:8px;">
                         <div class="code-block" style="font-size:0.8em; margin-bottom:12px; color:var(--vscode-descriptionForeground);">
                            ${lm.t('Authenticate Gemini CLI via Antigravity Proxy.')}
                        </div>
                    <div style="margin-top:auto; display:flex; gap:8px;">
                         <button onclick="authenticate('gemini-cli')" style="flex-grow:1">${lm.t('Login with OAuth')}</button>
                    </div>
                    </div>`}
            </div>`;
        };

        const keysHtml = apiKeys.length > 0 ? apiKeys.map(k => {
            const keyStr = k.key;
            const isVisible = k.visible;
            const masked = keyStr.length > 8 ? keyStr.substring(0, 4) + '...' + keyStr.substring(keyStr.length - 4) : '****';
            return `<div class="key-row" style="${!isVisible ? 'opacity:0.5;' : ''}">
                <div class="key-value" style="text-decoration:${!isVisible ? 'line-through' : 'none'}">${masked}</div>
                <div style="display:flex; gap:4px">
                    <button class="secondary icon-only" onclick="vscode.postMessage({command: 'toggleApiKey', key: '${keyStr}'})" title="${isVisible ? lm.t('Disable Key') : lm.t('Enable Key')}">${isVisible ? icons.eye : icons.eyeOff}</button>
                    <button class="secondary icon-only" onclick="vscode.postMessage({command: 'testApiKey', key: '${keyStr}'})" title="${lm.t('Test API Key')}">${icons.sync}</button>
                    <button class="secondary icon-only" onclick="vscode.postMessage({command: 'copyKey', text: '${keyStr}'})" title="${lm.t('Copy API Key')}">${icons.copy}</button>
                    <button class="secondary icon-only" onclick="vscode.postMessage({command: 'editApiKey', key: '${keyStr}'})" title="${lm.t('Edit API Key')}">${icons.edit}</button>
                    <button class="secondary icon-only" onclick="vscode.postMessage({command: 'removeApiKey', key: '${keyStr}'})" title="${lm.t('Delete API Key')}">${icons.trash}</button>
                </div>
            </div>`;
        }).join('') : `<div class="key-value">${lm.t('No API keys found')}</div>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${_webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; font-src ${_webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${lm.t('Antigravity Proxy Dashboard')}</title>
    <style>
        :root {
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --input-border: var(--vscode-input-border);
            --card-bg: var(--vscode-editor-inactiveSelectionBackground);
            --badge-bg: var(--vscode-activityBarBadge-background);
            --badge-fg: var(--vscode-activityBarBadge-foreground);
        }
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
        }
        .container {
            max-width: 100%;
            margin: 0 auto;
            background: var(--vscode-editor-background); 
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            position: relative;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 20px;
            margin-bottom: 24px;
        }
        h1 { margin: 0; font-size: 1.8em; display: flex; align-items: center; gap: 12px; font-weight: 600; }
        
        /* Glassy Cards */
        .card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }
        
        .status-card {
            background: linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .section-title {
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
            opacity: 0.7;
            margin-bottom: 12px;
            font-weight: 600;
        }

        .provider-status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.8em;
            font-weight: 600;
        }
        .provider-status.connected { color: #4caf50; }
        .provider-status.connected .status-dot { background-color: #4caf50; box-shadow: 0 0 4px #4caf5080; width: 8px; height: 8px; }
        .provider-status.not-connected { color: var(--vscode-descriptionForeground); opacity: 0.8; }
        .provider-status.not-connected .status-dot { background-color: var(--vscode-descriptionForeground); box-shadow: none; width: 8px; height: 8px; }
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .status-text {
            font-size: 1.2em;
            font-weight: 600;
            color: ${statusColor};
        }
        .status-dot {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background-color: ${statusColor};
            box-shadow: 0 0 8px ${statusColor}80;
        }
        .status-text {
            font-weight: 600;
            font-size: 1.2em;
        }

        .actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.95em;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-weight: 500;
            transition: opacity 0.2s;
            white-space: nowrap;
        }
        button:hover { opacity: 0.9; }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.icon-only { padding: 8px; }
        button svg { fill: currentColor; }
        .icon-stroke svg { fill: none; stroke: currentColor; }

        .string { color: #a31515; }
        .number { color: #098658; }
        .boolean { color: #0000ff; }
        .null { color: #0000ff; }
        .key { color: #001080; }

        body.vscode-dark .string { color: #ce9178; }
        body.vscode-dark .number { color: #b5cea8; }
        body.vscode-dark .boolean { color: #569cd6; }
        body.vscode-dark .null { color: #569cd6; }
        body.vscode-dark .key { color: #9cdcfe; }

        /* Provider Card Styles */
        button.btn-generate {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            text-align: left;
            line-height: 1.3;
            font-size: 0.9em;
            height: auto;
            min-height: 44px;
            justify-content: flex-start;
            margin-top: 16px;
            width: 100%;
            white-space: normal;
        }
        button.btn-generate svg {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
        }

        .providers-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 16px;
        }
        .provider-card {
            background: var(--input-bg);
            border: 1px solid var(--input-border);
            border-radius: 6px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            transition: transform 0.2s;
        }
        .provider-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .provider-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: 600;
        }
        .provider-icon {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 1.1em;
        }
        .input-group {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .input-group label {
            font-size: 0.85em;
            opacity: 0.8;
        }
        input[type="text"], input[type="password"] {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            border-radius: 4px;
            width: 100%;
            box-sizing: border-box;
            font-family: monospace;
        }
        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .input-wrapper {
            display: flex;
            gap: 4px;
            align-items: center;
            width: 100%;
        }
        .input-wrapper input {
            flex-grow: 1;
        }
        select {
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 6px 8px;
            border-radius: 4px;
            width: 100%;
            appearance: none;
            cursor: pointer;
            font-family: inherit;
            font-size: 0.9em;
            height: 32px;
        }
        select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .select-wrapper {
            position: relative;
            width: 100%;
        }
        .select-wrapper::after {
            content: "▼";
            font-size: 0.7em;
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            pointer-events: none;
            color: var(--vscode-dropdown-foreground);
            opacity: 0.8;
        }

        /* Server Info Grid */
        .info-grid {
            display: grid;
            grid-template-columns: 140px 1fr;
            gap: 12px;
            font-size: 0.95em;
            align-items: start;
        }
        .label { font-weight: 600; opacity: 0.7; }
        .value-row {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
        }
        .value-row button {
            padding: 3px 8px;
            font-size: 0.85em;
        }
        .value-row button.icon-only {
            padding: 3px;
        }
        .code-block {
            font-family: monospace;
            background: var(--vscode-textCodeBlock-background);
            padding: 4px 8px;
            border-radius: 4px;
            word-break: break-all;
            font-size: 0.9em;
            flex-grow: 1;
        }
        
        .keys-list {
            max-height: 120px;
            overflow-y: auto;
            border: 1px solid var(--vscode-widget-border);
            border-radius: 4px;
            padding: 4px;
            background: var(--vscode-editor-inactiveSelectionBackground);
        }
        .key-row {
            display: flex;
            gap: 8px;
            align-items: center;
            margin-bottom: 4px;
        }
        .key-value {
             font-family: monospace;
             background: var(--vscode-textCodeBlock-background);
             padding: 4px 8px;
             border-radius: 4px;
             font-size: 0.85em;
             flex-grow: 1;
        }

        /* Modal */
        .modal {
            display: none;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 100;
            width: 400px;
        }
        .modal.visible { display: block; }
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6);
            z-index: 99;
            backdrop-filter: blur(2px);
        }
        .modal-overlay.visible { display: block; }
        .modal h2 { margin-top: 0; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 12px; }
        .modal-close { position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 1.5em; opacity: 0.7; cursor: pointer; }
        
        /* Quota Modal */
        .quota-modal { width: 600px; max-height: 80vh; overflow-y: auto; }
        .quota-card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .quota-card-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
        }
        .quota-badge {
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 0.85em;
            font-weight: 600;
        }
        .quota-badge.antigravity { background: #3789F9; color: white; }
        .quota-badge.codex { background: #10a37f; color: white; }
        .quota-item {
            margin-bottom: 12px;
        }
        .quota-item-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }
        .quota-item-name { font-weight: 500; }
        .quota-item-value { display: flex; align-items: center; gap: 8px; }
        .quota-item-percent { font-weight: 600; }
        .quota-item-date { font-size: 0.8em; opacity: 0.7; }
        .quota-bar {
            height: 8px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 4px;
            overflow: hidden;
        }
        .quota-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, #10a37f, #4caf50);
            border-radius: 4px;
            transition: width 0.5s ease;
        }
        .quota-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 40px;
            gap: 12px;
        }
        
        .tabs { display: flex; gap: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
        .tab { 
             cursor: pointer; opacity: 0.6; padding-bottom: 4px; border-bottom: 2px solid transparent; transition: all 0.2s;
        }
        .tab:hover { opacity: 1; }
        .tab.active { opacity: 1; border-bottom-color: var(--vscode-activityBarBadge-background); font-weight: bold; }
        .tab-content { display: none; animation: fadeIn 0.3s ease; }
        .tab-content.active { display: block; }
        
        
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255,255,255,0.3);
            border-radius: 50%;
            border-top-color: var(--vscode-button-background);
            animation: spin 1s ease-in-out infinite;
            margin-right: 8px;
            vertical-align: middle;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .arrow-icon {
            display: inline-block;
            transition: transform 0.2s;
            margin-right: 4px;
            font-size: 0.8em;
            color: var(--vscode-foreground);
            opacity: 0.7;
        }
        .collapsible-header {
            cursor: pointer;
            display: flex;
            align-items: center;
            user-select: none;
        }
        .collapsible-header:hover .arrow-icon {
            opacity: 1;
        }
        
        /* MCP Command Item Styling */
        .mcp-command-item {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 8px 12px;
            margin-bottom: 8px;
            display: flex;
            flex-direction: column;
            gap: 6px;
            transition: border-color 0.2s;
        }
        .mcp-command-item:hover {
            border-color: var(--vscode-focusBorder);
        }
        .mcp-command-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .mcp-command-name {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            font-family: monospace;
            font-size: 1.1em;
        }
        .mcp-command-meta {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 0.85em;
            opacity: 0.8;
        }
        .mcp-badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 0.8em;
        }

        /* Improved Section Header */
        .collapsible-header {
            cursor: pointer;
            display: flex;
            align-items: center;
            user-select: none;
            background: rgba(128, 128, 128, 0.1);
            padding: 8px 12px;
            border-radius: 4px;
            margin-bottom: 8px;
            border: 1px solid transparent;
        }
        .collapsible-header:hover {
            border-color: var(--vscode-widget-border);
            background: rgba(128, 128, 128, 0.15);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span class="icon-stroke">${icons.shield}</span> ${lm.t('Antigravity Proxy Dashboard')}</h1>
            <button class="secondary icon-only" onclick="toggleInfo()" title="${lm.t('Info')}">${icons.info}</button>
        </div>

        <div id="modalOverlay" class="modal-overlay" onclick="toggleInfo()"></div>
        <div id="infoModal" class="modal">
            <button class="modal-close" onclick="toggleInfo()">&times;</button>
            <h2>${lm.t('About Antigravity Proxy')}</h2>
            <p>${lm.t('High-performance local AI proxy supporting multiple providers.')}</p>
            <ul>
                <li>${lm.t('One API key for all providers')}</li>
                <li>${lm.t('Secure local handling')}</li>
                <li>${lm.t('Unified OpenAI-compatible API')}</li>
                <li><strong>${lm.t('Base URL')}:</strong> <code>http://127.0.0.1:${port}/v1</code></li>
                <li><a href="https://github.com/router-for-me/CLIProxyAPIPlus" style="color:var(--vscode-textLink-foreground);">${lm.t('Documentation')}</a></li>
            </ul>
            <div style="margin-top:16px; padding:12px; background:var(--vscode-textBlockQuote-background); border-radius:6px; font-size:0.9em;">
                <strong>${lm.t('Available Endpoints')}:</strong>
                <ul style="margin:8px 0 0 0; padding-left:20px;">
                    <li><code>/v1/chat/completions</code> — ${lm.t('Chat completions (OpenAI format)')}</li>
                    <li><code>/v1/models</code> — ${lm.t('List available models')}</li>
                </ul>
                <div style="margin-top:8px; color:var(--vscode-descriptionForeground);">
                    ${lm.t('Model format')}: <code>provider/model-name</code> (${lm.t('e.g.')} <code>z-ai/glm-4-plus</code>)
                </div>
            </div>
             <div style="margin-top:20px; text-align:right;">
                <button onclick="vscode.postMessage({command: 'testProxyConnection'})" style="font-size:0.9em; padding:6px 12px;">${icons.sync} ${lm.t('Check Connection')}</button>
            </div>
        </div>

        <div id="mcpInfoOverlay" class="modal-overlay" onclick="toggleMcpInfo()"></div>
        <div id="mcpInfoModal" class="modal">
            <button class="modal-close" onclick="toggleMcpInfo()">&times;</button>
            <h2>${lm.t('MCP Commands Info')}</h2>
            <div style="max-height: 400px; overflow-y: auto; padding-right: 8px;">
                <p>${lm.t('The "Create MCP Command" feature generates a workflow file that enables a slash command (e.g., /proxy) to route requests to the Antigravity Proxy.')}</p>
                <ul style="margin: 12px 0; padding-left: 20px;">
                    <li>${lm.t('Customize command name and filename')}</li>
                    <li>${lm.t('Restrict allowed models for the command')}</li>
                    <li>${lm.t('Automatic conversation context inclusion')}</li>
                </ul>
                <div style="margin-top:16px; padding:12px; background:var(--vscode-textBlockQuote-background); border-radius:6px; font-size:0.9em;">
                    <strong>${lm.t('Usage Example')}:</strong>
                    <div style="margin-top:8px; font-family:var(--vscode-editor-font-family); color:var(--vscode-textLink-foreground);">
                        /ag-proxy model:gpt-4o Explain this code
                    </div>
                </div>
            </div>
             <div style="margin-top:20px; text-align:right;">
                <button class="secondary" onclick="toggleMcpInfo()" style="padding:6px 16px;">${lm.t('Close')}</button>
            </div>
        </div>

        <div id="quotaModalOverlay" class="modal-overlay" onclick="closeQuotaModal()"></div>
        <div id="quotaModal" class="modal quota-modal">
            <button class="modal-close" onclick="closeQuotaModal()">&times;</button>
            <h2 id="quotaModalTitle">${lm.t('Quota Information')}</h2>
            <div id="quotaModalContent">
                <div class="quota-loading">
                    <span class="spinner"></span>
                    <span>${lm.t('Loading...')}</span>
                </div>
            </div>
        </div>
        
        <div id="proxy-control" class="card status-card" style="display: flex;">
            <div class="status-indicator">
                <div class="status-dot"></div>
                <div class="status-text">${lm.t(status)}</div>
            </div>
            <div class="actions" style="margin-left:auto;">
                ${status === ProxyStatus.Running
                ? `<button class="secondary" onclick="vscode.postMessage({command: 'openWebUi', url: '${webUiUrl}'})">${icons.browser} ${lm.t('Open Web Manager')}</button>
                   <button onclick="vscode.postMessage({command: 'stop'})">${icons.stop} ${lm.t('Stop')}</button>`
                : `
                    <div style="display:flex; gap:8px;">
                        <button onclick="vscode.postMessage({command: 'start'})">${icons.play} ${lm.t('Start')}</button>
                        <button class="secondary" style="color:var(--vscode-errorForeground);" onclick="vscode.postMessage({command: 'killPort'})" title="${lm.t('Kill any process blocking the proxy port')}">${icons.trash} ${lm.t('Kill')}</button>
                    </div>`
            }
            </div>
        </div>



        <div class="section-title collapsible-header" onclick="toggleSection('server-info', 'serverInfo')" style="margin-top:24px;">
            <span id="server-info-arrow" class="arrow-icon" style="transform: ${dashboardState.serverInfo !== false ? 'rotate(90deg)' : 'rotate(0deg)'}">▶</span>
            ${lm.t('Server Information')}
        </div>
        <div id="server-info" class="card info-grid" style="display: ${dashboardState.serverInfo !== false ? 'grid' : 'none'};">
            <div class="label">${lm.t('Port')}</div>
            <div class="value-row">
                <div class="code-block" style="flex-grow:0; min-width:50px; text-align:center;">${port}</div>
                <div class="actions" style="margin-left:auto; margin-bottom:0; gap:4px">
                    <button class="secondary icon-only" style="font-size:0.8em; padding:2px 8px" onclick="vscode.postMessage({command: 'openExtensionSettings'})" title="${lm.t('Extension Settings')}">${icons.gear}</button>
                    <button class="secondary icon-only" style="font-size:0.8em; padding:2px 8px" onclick="vscode.postMessage({command: 'install'})" title="${lm.t('Re-install Proxy')}">${icons.install}</button>
                    <button class="secondary icon-only" style="font-size:0.8em; padding:2px 8px" onclick="vscode.postMessage({command: 'openConfig'})" title="${lm.t('Edit Config')}">${icons.edit}</button>
                    <button class="secondary icon-only" style="font-size:0.8em; padding:2px 8px" onclick="vscode.postMessage({command: 'openLogs'})" title="${lm.t('View Logs')}">${icons.logs}</button>
                </div>
            </div>
            
            <div class="label">${lm.t('Auto-Config')}</div>
            <div class="value-row">
                <div>${autoConfig ? lm.t('Enabled') : lm.t('Disabled')}</div>
                <div class="actions" style="margin-left:auto; margin-bottom:0; display:flex; align-items:center; gap:8px;">
                    <label for="autoStartCheckbox" style="font-size:0.9em; cursor:pointer;">${lm.t('Auto-Start')}</label>
                    <input type="checkbox" id="autoStartCheckbox" ${autoStart ? 'checked' : ''} onchange="toggleAutoStart(this.checked)">
                </div>
            </div>
            
            <div class="label">${lm.t('Binary Path')}</div>
            <div class="value-row">
                <div class="code-block" title="${binaryPath}">${binaryPath}</div>
                <button class="secondary icon-only" onclick="copyPath()">${icons.copy}</button>
            </div>

            <div class="label">${lm.t('Management Key')}</div>
            <div class="value-row">
                 <div id="mgmt-key-container" class="code-block" style="flex-grow:1; color: var(--vscode-descriptionForeground); font-style: italic;">• • • • • • • • • • • •</div>
                 <div style="display:flex; gap:4px">
                    <button id="toggle-mgmt-btn" class="secondary" onclick="toggleManagementKey()" data-state="hidden">${lm.t('Show')}</button>
                    <button class="secondary icon-only" onclick="changeManagementKey()" title="${lm.t('Change Management Key')}">${icons.edit}</button>
                    <button class="secondary icon-only" onclick="copyManagementKey()" title="${lm.t('Copy Management Key')}">${icons.copy}</button>
                 </div>
            </div>

            <div style="grid-column: 1; display: flex; flex-direction: column; justify-content: space-between; height: 100%;">
                <div class="label" style="display:flex; justify-content:space-between; align-items:center;">
                    ${lm.t('API Keys')}
                    <span style="opacity:0.6; font-weight:normal; font-size:0.9em;">${visibleKeys}/${totalKeys}</span>
                </div>
                <button class="secondary btn-generate" onclick="generateApiKey()" title="${lm.t('Generate a new random API key')}">
                    ${icons.plus}
                    <span>${lm.t('Generate New Key')}</span>
                </button>
            </div>
            <div class="keys-list" style="width:100%">${keysHtml}</div>
        </div>

        <div class="section-title collapsible-header" onclick="toggleSection('providers-config', 'providersConfig')" style="margin-top:24px;">
            <span id="providers-config-arrow" class="arrow-icon" style="transform: ${dashboardState.providersConfig !== false ? 'rotate(90deg)' : 'rotate(0deg)'}">▶</span>
            ${lm.t('Providers Configuration')}
        </div>
        <div id="providers-config" class="card providers-grid" style="display: ${dashboardState.providersConfig !== false ? 'grid' : 'none'};">
            <!-- Antigravity Card -->
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                         <span class="provider-logo" style="display:flex;">${icons.antigravity}</span> Antigravity <span style="opacity:0.6; margin-left:8px; font-weight:normal;">(${antigravityAccounts.length})</span>
                    </div>
                    ${getProviderStatus('antigravity')}
                </div>
                ${(() => {
                const accounts = antigravityAccounts;
                if (accounts.length > 0) {
                    return `
                        <div class="accounts-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
                            ${accounts.map(info => `
                                <div style="background:var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; font-size:0.85em;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                        <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; max-width:140px;" title="${info.fileName}">${info.fileName}</span>
                                        <div style="display:flex; gap:4px;">
                                            <button class="secondary icon-only" style="padding:2px" onclick="viewQuota('antigravity', '${info.fileName}')" title="${lm.t('View Quotas')}">${icons.chart}</button>
                                            <button class="secondary icon-only" style="padding:2px" onclick="openSpecificAuthFile('antigravity', '${info.fileName}')" title="${lm.t('Open File')}">${icons.file}</button>
                                            <button class="secondary icon-only" style="padding:2px; color:var(--vscode-errorForeground);" onclick="deleteSpecificAuthFile('antigravity', '${info.fileName}')" title="${lm.t('Delete')}">${icons.trash}</button>
                                        </div>
                                    </div>
                                    ${info.email ? `<div style="font-size:0.8em; opacity:0.8; margin-top:4px;">${lm.t('Email')}: ${info.email}</div>` : ''}
                                    ${info.expired ? `<div style="font-size:0.8em; opacity:0.8; margin-top:2px;">${lm.t('Expires')}: ${lm.formatDateTime(new Date(info.expired))}</div>` : ''}
                                    <div style="font-size:0.75em; opacity:0.7; margin-top:2px;">${lm.formatDateTime(info.lastModified)}</div>
                                    ${(() => {
                            const profileName = antigravityProfiles?.get(info.fileName);
                            if (profileName) {
                                const isActive = activeProfile === profileName;
                                if (isActive) {
                                    return `<button class="secondary" style="width:100%; margin-top:8px; font-size:0.85em; justify-content:center; background-color:var(--vscode-button-hoverBackground); cursor:default; opacity: 1;" disabled>
                                                ${icons.user} ${lm.t('Current Profile: {0}', profileName)}
                                            </button>`;
                                } else {
                                    return `<button class="secondary" style="width:100%; margin-top:8px; font-size:0.85em; justify-content:center;" onclick="vscode.postMessage({command: 'switchProfile', profile: '${profileName}'})">
                                                ${icons.user} ${lm.t('Switch to Profile: {0}', profileName)}
                                            </button>`;
                                }
                            }
                            return '';
                        })()}
                                </div>
                            `).join('')}
                        </div>
                        <div style="margin-top:auto; display:flex; gap:8px; padding-top:12px;">
                            <button class="secondary" style="flex-grow:1" onclick="loginAntigravity()">${icons.plus} ${lm.t('Add Account')}</button>
                        </div>`;
                }
                return `
                    <p style="font-size:0.85em; opacity:0.8; margin: 0 0 16px 0;">${lm.t('Login with Antigravity OAuth.')}</p>
                    <div style="margin-top:auto; display:flex; gap:8px; padding-top:16px">
                        <button class="secondary" style="flex-grow:1" onclick="loginAntigravity()">${lm.t('Login with OAuth')}</button>
                    </div>`;
            })()}
            </div>


            <!-- GitHub Copilot Card -->
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                         ${icons.github} GitHub Copilot <span style="opacity:0.6; margin-left:8px; font-weight:normal;">(${githubAccounts.length})</span>
                    </div>
                    ${getProviderStatus('github-copilot')}
                </div>
                 ${(() => {
                const accounts = githubAccounts;
                if (accounts.length > 0) {
                    return `
                        <div class="accounts-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
                            ${accounts.map(info => `
                                <div style="background:var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; font-size:0.85em;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                        <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; max-width:140px;" title="${info.fileName}">${info.fileName}</span>
                                        <div style="display:flex; gap:4px;">
                                            <button class="secondary icon-only" style="padding:2px" onclick="openSpecificAuthFile('github-copilot', '${info.fileName}')" title="${lm.t('Open File')}">${icons.file}</button>
                                            <button class="secondary icon-only" style="padding:2px; color:var(--vscode-errorForeground);" onclick="deleteSpecificAuthFile('github-copilot', '${info.fileName}')" title="${lm.t('Delete')}">${icons.trash}</button>
                                        </div>
                                    </div>
                                    ${info.user ? `<div style="font-size:0.8em; opacity:0.8; margin-top:4px;">${lm.t('User')}: ${info.user}</div>` : ''}
                                    <div style="font-size:0.75em; opacity:0.7; margin-top:2px;">${lm.formatDateTime(info.lastModified)}</div>
                                </div>
                            `).join('')}
                        </div>
                        <div style="margin-top:auto; display:flex; gap:8px; padding-top:12px;">
                            <button class="secondary" style="flex-grow:1" onclick="addProvider('github-copilot')">${icons.plus} ${lm.t('Add Account')}</button>
                        </div>`;
                }
                return `
                    <p style="font-size:0.85em; opacity:0.8; margin: 0 0 16px 0;">${lm.t('Use your GitHub Copilot subscription via Antigravity Proxy.')}</p>
                    <div style="margin-top:auto; display:flex; gap:8px;">
                        <button class="secondary" style="flex:1" onclick="addProvider('github-copilot')">${lm.t('Login with OAuth')}</button>
                    </div>`;
            })()}
            </div>


            <!-- Z.AI Card -->
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                         <span class="icon-stroke">${icons.z_ai}</span>
                         ${lm.t('Z.AI')}
                    </div>
                    ${getProviderStatus('z-ai')}
                </div>
                <div class="input-group">
                    <label>${lm.t('API Key')}</label>
                     <div class="input-wrapper">
                        <input type="password" id="zai-key" placeholder="sk-..." value="${zaiKey}">
                         <button class="secondary icon-only" onclick="toggleZaiKeyVisibility()" title="${lm.t('Show/Hide')}">
                            <span id="zai-key-icon">${icons.eye}</span>
                        </button>
                        <button class="secondary icon-only" onclick="copyZaiKey()" title="${lm.t('Copy')}">
                            ${icons.copy}
                        </button>
                    </div>
                </div>
                 <div class="input-group" style="margin-top:12px;">
                    <label>${lm.t('Model')}</label>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <div class="select-wrapper" style="flex-grow:1;">
                            <select id="zai-model">
                                <option value="glm-4-plus" ${zaiModel === 'glm-4-plus' ? 'selected' : ''}>GLM-4-Plus</option>
                                <option value="glm-4.7" ${zaiModel === 'glm-4.7' ? 'selected' : ''}>GLM-4.7</option>
                                <option value="glm-4.6" ${zaiModel === 'glm-4.6' ? 'selected' : ''}>GLM-4.6</option>
                            </select>
                        </div>
                        <button class="secondary icon-only" onclick="testSelectedModel()" title="${lm.t('Run Test')}">${icons.sync}</button>
                    </div>
                </div>
                <div style="margin-top:auto; display:flex; gap:8px; padding-top:16px">
                     <button class="secondary" onclick="openUrl('https://z.ai/manage-apikey/apikey-list')">${lm.t('Get Key')}</button>
                     <button style="flex-grow:1" onclick="addZAI()">${lm.t('Save')}</button>
                        <button class="secondary icon-only" onclick="deleteZai()" title="${lm.t('Remove Configuration')}" style="color:var(--vscode-errorForeground); border-color:var(--vscode-errorForeground)">
                            ${icons.trash}
                        </button>
                </div>
            </div>

            <!-- Codex Card -->
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                        <span class="icon-stroke"><svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256.000000 256.000000" preserveAspectRatio="xMidYMid meet"><g transform="translate(0.000000,256.000000) scale(0.100000,-0.100000)" fill="currentColor" stroke="none"><path d="M1107 2290 c-316 -57 -615 -283 -748 -565 -68 -144 -91 -241 -96 -406 -6 -156 7 -249 49 -374 87 -254 291 -478 542 -596 146 -68 226 -84 426 -84 152 0 186 3 260 23 182 50 327 136 465 277 147 150 245 334 282 529 23 123 14 344 -20 456 -35 116 -69 190 -134 290 -131 200 -340 354 -578 426 -78 23 -111 27 -245 30 -85 1 -177 -1 -203 -6z m362 -216 c91 -21 224 -86 310 -152 133 -101 249 -275 293 -439 16 -60 21 -108 21 -203 0 -152 -21 -240 -88 -368 -130 -253 -350 -407 -634 -443 -393 -50 -777 214 -882 607 -30 110 -30 296 0 408 72 270 282 489 552 576 130 41 287 47 428 14z"/><path d="M849 1637 c-31 -24 -52 -67 -46 -95 3 -15 35 -78 71 -139 36 -61 66 -115 66 -119 0 -5 -30 -58 -66 -119 -36 -60 -68 -123 -70 -140 -7 -42 26 -90 70 -105 31 -10 42 -9 72 7 31 15 51 43 125 173 93 162 101 188 73 243 -50 97 -169 289 -185 297 -25 14 -91 12 -110 -3z"/><path d="M1353 1139 c-42 -12 -73 -53 -73 -96 0 -27 8 -43 35 -70 l34 -34 216 3 217 3 30 34 c26 29 29 40 25 73 -7 49 -29 75 -76 88 -45 12 -364 12 -408 -1z"/></g></svg></span>
                        ${lm.t('Codex')} <span style="opacity:0.6; margin-left:8px; font-weight:normal;">(${codexAccounts.length})</span>
                    </div>
                     ${getProviderStatus('codex')}
                </div>
                 ${(() => {
                const accounts = codexAccounts;
                if (accounts.length > 0) {
                    return `
                        <div class="accounts-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
                            ${accounts.map(info => `
                                <div style="background:var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; font-size:0.85em;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                        <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; max-width:140px;" title="${info.fileName}">${info.fileName}</span>
                                        <div style="display:flex; gap:4px;">
                                            <button class="secondary icon-only" style="padding:2px" onclick="viewQuota('codex', '${info.fileName}')" title="${lm.t('View Quotas')}">${icons.chart}</button>
                                            <button class="secondary icon-only" style="padding:2px" onclick="openSpecificAuthFile('codex', '${info.fileName}')" title="${lm.t('Open File')}">${icons.file}</button>
                                            <button class="secondary icon-only" style="padding:2px; color:var(--vscode-errorForeground);" onclick="deleteSpecificAuthFile('codex', '${info.fileName}')" title="${lm.t('Delete')}">${icons.trash}</button>
                                        </div>
                                    </div>
                                    ${info.email ? `<div style="font-size:0.8em; opacity:0.8; margin-top:4px;">${lm.t('Email')}: ${info.email}</div>` : ''}
                                    ${info.expired ? `<div style="font-size:0.8em; opacity:0.8; margin-top:2px;">${lm.t('Expires')}: ${lm.formatDateTime(new Date(info.expired))}</div>` : ''}
                                    <div style="font-size:0.75em; opacity:0.7; margin-top:2px;">${lm.formatDateTime(info.lastModified)}</div>
                                </div>
                            `).join('')}
                        </div>
                        <div style="margin-top:auto; display:flex; gap:8px; padding-top:12px;">
                            <button class="secondary" style="flex-grow:1" onclick="loginCodex()">${icons.plus} ${lm.t('Add Account')}</button>
                        </div>`;
                }
                return `
                     <div style="flex-grow:1; display:flex; flex-direction:column; gap:8px;">
                         <div class="code-block" style="font-size:0.8em; margin-bottom:12px; color:var(--vscode-descriptionForeground);">
                            ${lm.t('Sign in with OpenAI Account.')}
                        </div>
                    <div style="margin-top:auto; display:flex; gap:8px;">
                         <button onclick="loginCodex()" style="flex-grow:1">${lm.t('Login with OAuth')}</button>
                    </div>
                    </div>`;
            })()}
            </div>

            <!-- Claude Card -->
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                        <span class="icon-stroke">${icons.claude}</span>
                        ${lm.t('Anthropic (Claude)')} <span style="opacity:0.6; margin-left:8px; font-weight:normal;">(${claudeAccounts.length})</span>
                    </div>
                     ${getProviderStatus('claude')}
                </div>
                 ${(() => {
                const accounts = claudeAccounts;
                if (accounts.length > 0) {
                    return `
                        <div class="accounts-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
                            ${accounts.map(info => `
                                <div style="background:var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; font-size:0.85em;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                        <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; max-width:140px;" title="${info.fileName}">${info.fileName}</span>
                                        <div style="display:flex; gap:4px;">
                                            <button class="secondary icon-only" style="padding:2px" onclick="openSpecificAuthFile('claude', '${info.fileName}')" title="${lm.t('Open File')}">${icons.file}</button>
                                            <button class="secondary icon-only" style="padding:2px; color:var(--vscode-errorForeground);" onclick="deleteSpecificAuthFile('claude', '${info.fileName}')" title="${lm.t('Delete')}">${icons.trash}</button>
                                        </div>
                                    </div>
                                    <div style="font-size:0.75em; opacity:0.7; margin-top:2px;">${lm.formatDateTime(info.lastModified)}</div>
                                </div>
                            `).join('')}
                        </div>
                        <div style="margin-top:auto; display:flex; gap:8px; padding-top:12px;">
                            <button class="secondary" style="flex-grow:1" onclick="loginClaude()">${icons.plus} ${lm.t('Add Account')}</button>
                        </div>`;
                }
                return `
                     <div style="flex-grow:1; display:flex; flex-direction:column; gap:8px;">
                         <div class="code-block" style="font-size:0.8em; margin-bottom:12px; color:var(--vscode-descriptionForeground);">
                            ${lm.t('Sign in with Anthropic Account.')}
                        </div>
                    <div style="margin-top:auto; display:flex; gap:8px;">
                         <button onclick="loginClaude()" style="flex-grow:1">${lm.t('Login with OAuth')}</button>
                    </div>
                    </div>`;
            })()}
            </div>

            <!-- Qwen Card -->
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                        <span class="icon-stroke">${icons.qwen}</span>
                        ${lm.t('Qwen')} <span style="opacity:0.6; margin-left:8px; font-weight:normal;">(${qwenAccounts.length})</span>
                    </div>
                     ${getProviderStatus('qwen')}
                </div>
                 ${(() => {
                const accounts = qwenAccounts;
                if (accounts.length > 0) {
                    return `
                        <div class="accounts-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
                            ${accounts.map(info => `
                                <div style="background:var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; font-size:0.85em;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                        <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; max-width:140px;" title="${info.fileName}">${info.fileName}</span>
                                        <div style="display:flex; gap:4px;">
                                            <button class="secondary icon-only" style="padding:2px" onclick="openSpecificAuthFile('qwen', '${info.fileName}')" title="${lm.t('Open File')}">${icons.file}</button>
                                            <button class="secondary icon-only" style="padding:2px; color:var(--vscode-errorForeground);" onclick="deleteSpecificAuthFile('qwen', '${info.fileName}')" title="${lm.t('Delete')}">${icons.trash}</button>
                                        </div>
                                    </div>
                                    ${info.expired ? `<div style="font-size:0.8em; opacity:0.8; margin-top:2px;">${lm.t('Expires')}: ${lm.formatDateTime(new Date(info.expired))}</div>` : ''}
                                    <div style="font-size:0.75em; opacity:0.7; margin-top:2px;">${lm.formatDateTime(info.lastModified)}</div>
                                </div>
                            `).join('')}
                        </div>
                        <div style="margin-top:auto; display:flex; gap:8px; padding-top:12px;">
                            <button class="secondary" style="flex-grow:1" onclick="loginQwen()">${icons.plus} ${lm.t('Add Account')}</button>
                        </div>`;
                }
                return `
                     <div style="flex-grow:1; display:flex; flex-direction:column; gap:8px;">
                         <div class="code-block" style="font-size:0.8em; margin-bottom:12px; color:var(--vscode-descriptionForeground);">
                            ${lm.t('Sign in with Qwen Account.')}
                        </div>
                    <div style="margin-top:auto; display:flex; gap:8px;">
                         <button onclick="loginQwen()" style="flex-grow:1">${lm.t('Login with OAuth')}</button>
                    </div>
                    </div>`;
            })()}
            </div>
            
            <!-- Gemini CLI -->
            ${getGeminiCliHtml()}

            <!-- Kimi Card -->
            <div class="provider-card">
                <div class="provider-header">
                    <div class="provider-icon">
                        <span class="icon-stroke">${icons.kimi}</span>
                        ${lm.t('Kimi (Moonshot)')} <span style="opacity:0.6; margin-left:8px; font-weight:normal;">(${kimiAccounts.length})</span>
                    </div>
                     ${getProviderStatus('kimi')}
                </div>
                 ${(() => {
                const accounts = kimiAccounts;
                if (accounts.length > 0) {
                    return `
                        <div class="accounts-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
                            ${accounts.map(info => `
                                <div style="background:var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; font-size:0.85em;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                        <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; max-width:140px;" title="${info.fileName}">${info.fileName}</span>
                                        <div style="display:flex; gap:4px;">
                                            <button class="secondary icon-only" style="padding:2px" onclick="openSpecificAuthFile('kimi', '${info.fileName}')" title="${lm.t('Open File')}">${icons.file}</button>
                                            <button class="secondary icon-only" style="padding:2px; color:var(--vscode-errorForeground);" onclick="deleteSpecificAuthFile('kimi', '${info.fileName}')" title="${lm.t('Delete')}">${icons.trash}</button>
                                        </div>
                                    </div>
                                    ${info.expired ? `<div style="font-size:0.8em; opacity:0.8; margin-top:2px;">${lm.t('Expires')}: ${lm.formatDateTime(new Date(info.expired))}</div>` : ''}
                                    <div style="font-size:0.75em; opacity:0.7; margin-top:2px;">${lm.formatDateTime(info.lastModified)}</div>
                                </div>
                            `).join('')}
                        </div>
                        <div style="margin-top:auto; display:flex; gap:8px; padding-top:12px;">
                            <button class="secondary" style="flex-grow:1" onclick="loginKimi()">${icons.plus} ${lm.t('Add Account')}</button>
                        </div>`;
                }
                return `
                     <div style="flex-grow:1; display:flex; flex-direction:column; gap:8px;">
                         <div class="code-block" style="font-size:0.8em; margin-bottom:12px; color:var(--vscode-descriptionForeground);">
                            ${lm.t('Sign in with Kimi Account.')}
                        </div>
                    <div style="margin-top:auto; display:flex; gap:8px;">
                         <button onclick="loginKimi()" style="flex-grow:1">${lm.t('Login with OAuth')}</button>
                    </div>
                    </div>`;
            })()}
            </div>

        </div>



    </div>


        <div class="section-title collapsible-header" onclick="toggleSection('mcp-config', 'mcpConfig')" style="margin-top:24px;">
            <span id="mcp-config-arrow" class="arrow-icon" style="transform: ${dashboardState.mcpConfig !== false ? 'rotate(90deg)' : 'rotate(0deg)'}">▶</span>
            ${lm.t('Proxy MCP Configuration')}
        </div>
        <div id="mcp-config" class="card" style="display: ${dashboardState.mcpConfig !== false ? 'block' : 'none'};">
            <div class="status-card" style="background:transparent; padding:0; margin-bottom:12px;">
                 <div class="status-indicator">
                    <div id="mcp-status-dot" class="status-dot" style="background-color:var(--vscode-descriptionForeground); box-shadow:none;"></div>
                    <div id="mcp-status-text" class="status-text" style="color:var(--vscode-descriptionForeground); font-size:1em;">${lm.t('Ready')}</div>
                </div>
                <div class="actions" style="margin-left:auto; display:flex; gap:8px;">
                    <button class="secondary icon-only" onclick="openMcpConfig()" title="${lm.t('Open Existing Config')}">${icons.edit}</button>
                    <button class="secondary icon-only" onclick="installMcpConfig()" title="${lm.t('Install/Update Config')}">${icons.install}</button>
                    <button id="mcp-server-btn" class="secondary" onclick="toggleMcpServer()" title="${lm.t('Launch server in terminal')}">${icons.play} ${lm.t('Run MCP')}</button>
                </div>
            </div>

            <div class="collapsible-header" onclick="toggleSection('mcp-commands', 'mcpCommands')" style="margin-top:16px;">
                <span id="mcp-commands-arrow" class="arrow-icon" style="transform: ${dashboardState.mcpCommands !== false ? 'rotate(90deg)' : 'rotate(0deg)'}">▶</span>
                <span style="flex-grow:1; font-weight:600;">${lm.t('MCP Commands')}</span>
                <div class="actions" style="margin:0; padding:0; gap:4px;" onclick="event.stopPropagation()">
                     <button class="secondary icon-only" style="padding:4px 8px; height:28px;" onclick="vscode.postMessage({command: 'createMcpCommand'})" title="${lm.t('Create a new MCP command')}" ${status !== ProxyStatus.Running ? 'disabled' : ''}>${icons.plus}</button>
                     <button class="secondary icon-only" style="padding:4px 8px; height:28px;" onclick="vscode.postMessage({command: 'showMcpCommandInfo'})" title="${lm.t('Command Info')}">${icons.info}</button>
                </div>
            </div>

            <div id="mcp-commands" class="card" style="display: ${dashboardState.mcpCommands !== false ? 'block' : 'none'}; margin-bottom:16px;">
                ${mcpCommands.length > 0 ? `
                    <div style="max-height: 300px; overflow-y:auto; padding-right:4px;">
                        ${mcpCommands.map(cmd => `
                            <div class="mcp-command-item">
                                <div class="mcp-command-header">
                                    <div style="display:flex; align-items:center; gap:8px;">
                                        <span class="mcp-command-name">/${cmd.name}</span>
                                        <span class="mcp-badge" style="cursor:pointer;" onclick="vscode.postMessage({command: 'openMcpCommand', filename: '${cmd.filename}'})" title="${lm.t('Open Workflow File')}">${cmd.filename}</span>
                                    </div>
                                    <div class="actions" style="gap:4px;">
                                         <button class="secondary icon-only" onclick="vscode.postMessage({command: 'editMcpCommand', filename: '${cmd.filename}'})" title="${lm.t('Edit Command')}">${icons.edit}</button>
                                         <button class="secondary icon-only" style="color:var(--vscode-errorForeground);" onclick="vscode.postMessage({command: 'deleteMcpCommand', filename: '${cmd.filename}'})" title="${lm.t('Delete Command')}">${icons.trash}</button>
                                    </div>
                                </div>
                                <div class="mcp-command-meta">
                                    <span style="display:flex; align-items:center; gap:4px;">
                                        ${icons.shield} 
                                        ${cmd.allowedModels.length > 0
                    ? lm.t('Models: {0}', cmd.allowedModels.join(', '))
                    : lm.t('All Models Allowed')}
                                    </span>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                ` : `
                    <div style="opacity:0.6; font-style:italic; padding:16px; text-align:center; border:1px dashed var(--vscode-widget-border); border-radius:6px;">
                        ${lm.t('No MCP commands configured. Click the + button to create one.')}
                    </div>
                `}
            </div>

            <div class="collapsible-header" onclick="toggleSection('mcp-details', 'mcpDetails')" style="margin-bottom:12px;">
                 <span id="mcp-details-arrow" class="arrow-icon" style="transform: ${dashboardState.mcpDetails !== false ? 'rotate(90deg)' : 'rotate(0deg)'}">▶</span>
                 <span style="font-weight:600;">${lm.t('Configuration & Testing')}</span>
            </div>

            <div id="mcp-details" class="card" style="display: ${dashboardState.mcpDetails !== false ? 'block' : 'none'};">

            ${!mcpRunning ? `
            <div style="background:var(--vscode-notificationsWarning-background); color:var(--vscode-notificationsWarning-foreground); padding:12px; border-radius:6px; margin-bottom:16px; display:flex; align-items:center; gap:8px; border:1px solid var(--vscode-notificationsWarning-border);">
                <span style="color:var(--vscode-notificationsWarningIcon-foreground);">${icons.warning}</span>
                <span>${lm.t('MCP Server is not running. Please start it to use tests.')}</span>
            </div>
            ` : ''}

            <div class="label" style="margin-bottom:8px;">${lm.t('Options')}</div>
            <div class="value-row" style="margin-bottom:12px;">
                 <label for="mcpAutoStart" style="font-size:0.9em; cursor:pointer; flex-grow:1;">${lm.t('Auto-Start with Proxy')}</label>
                 <input type="checkbox" id="mcpAutoStart" ${config.get('mcp.autoStart') ? 'checked' : ''} onchange="toggleMcpAutoStart(this.checked)">
            </div>

            <div class="label" style="margin-bottom:8px;">${lm.t('Test Methods')}</div>
            <div class="actions" style="margin-bottom:16px; flex-wrap:wrap; gap:8px; display:flex;">
                <button class="secondary mcp-test-btn" style="height:32px; padding:0 16px;" onclick="testMcpMethod('list_tools')">${lm.t('CHECK TOOLS')}</button>
                <button class="secondary mcp-test-btn" style="height:32px; padding:0 16px;" onclick="testMcpMethod('list_models')">${lm.t('LIST MODELS')}</button>
            </div>

            <!-- Get Quota Test -->
            <div class="label" style="margin-bottom:8px;">${lm.t('Test Quota')}</div>
            <div class="actions" style="margin-bottom:16px; flex-wrap:wrap; gap:8px; display:flex;">
                <select id="mcp-quota-provider" class="mcp-test-btn" style="padding:0 8px; border:1px solid var(--vscode-dropdown-border); background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); outline:none; border-radius:4px; height:32px; min-width:120px;" onchange="updateQuotaAccounts()">
                    <option value="antigravity">Antigravity</option>
                    <option value="gemini-cli">Gemini CLI</option>
                    <option value="codex">Codex</option>
                </select>
                <select id="mcp-quota-account" class="mcp-test-btn" style="padding:0 8px; border:1px solid var(--vscode-dropdown-border); background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); outline:none; border-radius:4px; height:32px; min-width:150px; flex-grow:1;">
                    <option value="">${lm.t('Select Account...')}</option>
                </select>
                <button class="secondary mcp-test-btn" style="height:32px; padding:0 16px;" onclick="testGetQuota()">${lm.t('GET QUOTA')}</button>
            </div>
            
            <div class="label" style="margin-bottom:8px;">${lm.t('Model Tests')}</div>
            <div class="actions" style="margin-bottom:16px; flex-wrap:wrap; gap:8px; display:flex;">
                <div style="display:flex; height:32px; align-items:stretch; border:1px solid var(--vscode-dropdown-border); border-radius:4px;">
                    <div id="mcp-models-loading" style="display:none; align-items:center; padding:0 12px; background:var(--vscode-dropdown-background);">
                        <span class="spinner" style="margin:0;"></span>
                    </div>
                    <select id="mcp-test-model-select" class="mcp-test-btn" style="padding:0 8px; border:none; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); outline:none; border-radius:4px 0 0 4px; min-width: 150px;">
                        <option value="">${lm.t('(Run LIST MODELS to populate)')}</option>
                    </select>
                    <div style="width:1px; background-color:var(--vscode-widget-border);"></div>
                    <input type="text" id="mcp-test-message" class="mcp-test-btn" placeholder="${lm.t('Enter message...')}" value="${lm.t('Say Hello!')}" style="padding:0 12px; border:none; background:var(--vscode-input-background); color:var(--vscode-input-foreground); outline:none; flex-grow:1; min-width: 200px;">
                    <div style="width:1px; background-color:var(--vscode-widget-border);"></div>
                    <label style="display:flex; align-items:center; gap:4px; padding:0 8px; cursor:pointer; background:var(--vscode-input-background); font-size:0.85em; white-space:nowrap;">
                        <input type="checkbox" id="mcp-stream-toggle" style="margin:0;" onchange="onStreamingToggleChange()">
                        <span>${lm.t('Streaming')}</span>
                    </label>
                    <div style="width:1px; background-color:var(--vscode-widget-border);"></div>
                    <button id="chat-test-btn" class="secondary mcp-test-btn" style="height:100%; border:none; border-radius:0 4px 4px 0; padding:0 16px; display:flex; align-items:center; gap:8px;" onclick="testMcpMethod('chat_completion', { model: document.getElementById('mcp-test-model-select').value, messages: [{role: 'user', content: document.getElementById('mcp-test-message').value}], stream: document.getElementById('mcp-stream-toggle').checked })">
                        <span id="chat-test-spinner" class="spinner" style="display:none; margin:0;"></span>
                        ${lm.t('CHAT TEST')}
                    </button>
                </div>
            </div>
            
            <div id="mcp-output-container" style="display:none;">
                <div class="label" style="margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
                    <span>${lm.t('Test Output')}</span>
                    <span id="mcp-base-url" style="font-size:0.85em; font-weight:normal; opacity:0.7; font-family:var(--vscode-editor-font-family, monospace);"></span>
                </div>
                <div class="output-tabs" style="display:flex; border-bottom:1px solid var(--vscode-widget-border); margin-bottom:0;">
                    <div class="output-tab active" onclick="switchOutputTab(this, 'tab-res')" style="padding:6px 12px; cursor:pointer; font-size:0.9em; border-bottom:2px solid var(--vscode-button-background); font-weight:bold;">${lm.t('Response')}</div>
                    <div class="output-tab" onclick="switchOutputTab(this, 'tab-req')" style="padding:6px 12px; cursor:pointer; font-size:0.9em; border-bottom:2px solid transparent; opacity:0.7;">${lm.t('Request')}</div>
                    <div class="output-tab" onclick="switchOutputTab(this, 'tab-headers')" style="padding:6px 12px; cursor:pointer; font-size:0.9em; border-bottom:2px solid transparent; opacity:0.7;">${lm.t('Headers')}</div>
                </div>
                <div class="code-block" style="min-height:100px; max-height:600px; resize:vertical; overflow:auto; border-top:none; border-top-left-radius:0; border-top-right-radius:0;">
                    <div id="tab-res" class="output-content" style="display:block; white-space:pre-wrap;"></div>
                    <div id="tab-req" class="output-content" style="display:none; white-space:pre-wrap;"></div>
                    <div id="tab-headers" class="output-content" style="display:none; white-space:pre-wrap;"></div>
                </div>
            </div>

            <div id="mcp-disclaimer" style="font-size:0.85em; opacity:0.6; margin-top:16px; border-top:1px solid var(--vscode-widget-border); padding-top:8px;">
                <span style="color:var(--vscode-notificationsWarningIcon-foreground);">${icons.warning}</span> 
                ${lm.t('Note: External agents (Roo Code, Cline, etc.) manage their own MCP instances. The "Run MCP" button above is only for local extension-managed inspection and logging.')}
            </div>
            
            </div> <!-- End of mcp-details -->
        </div>

    <script>
        const vscode = acquireVsCodeApi();
        window.vscode = vscode;
        const currentLocale = '${lm.getLocale()}';
        
        // Inject account details for quota testing
        const accountDetails = ${JSON.stringify(accountDetails ? Object.fromEntries(accountDetails) : {})};

        // --- Helper to safely escape strings for HTML attribute injection ---
        function escapeHtml(unsafe) {
            return unsafe
                 .replace(/&/g, "&amp;")
                 .replace(/</g, "&lt;")
                 .replace(/>/g, "&gt;")
                 .replace(/"/g, "&quot;")
                 .replace(/'/g, "&#039;");
        }

        function formatDate(date, locale) {
            if (!date) return '';
            const d = new Date(date);
            if (isNaN(d.getTime())) return '';
            return d.toLocaleString(locale);
        }


        function toggleInfo() {
            document.getElementById('infoModal').classList.toggle('visible');
            document.getElementById('modalOverlay').classList.toggle('visible');
        }
        window.toggleInfo = toggleInfo;

        function toggleMcpInfo() {
            document.getElementById('mcpInfoModal').classList.toggle('visible');
            document.getElementById('mcpInfoOverlay').classList.toggle('visible');
        }
        window.toggleMcpInfo = toggleMcpInfo;

        function copyPath() {
            vscode.postMessage({command: 'copy', text: '${binaryPathEscaped.replace(/'/g, "\\'")}'});
        }
        window.copyPath = copyPath;
        
        function copyKey(key) {
            vscode.postMessage({command: 'copy', text: key});
        }
        window.copyKey = copyKey;

        function openUrl(url) {
            vscode.postMessage({command: 'openWebUi', url: url});
        }
        window.openUrl = openUrl;

        function switchTab(el, id) {
             const parent = el.parentElement;
             Array.from(parent.children).forEach(c => c.classList.remove('active'));
             el.classList.add('active');
             
             const container = parent.parentElement;
             const contents = container.querySelectorAll('.tab-content');
             contents.forEach(c => c.classList.remove('active'));
             document.getElementById(id).classList.add('active');
        }
        window.switchTab = switchTab;

        function switchOutputTab(el, id) {
            const parent = el.parentElement;
            Array.from(parent.children).forEach(c => {
                c.classList.remove('active');
                c.style.borderBottomColor = 'transparent';
                c.style.opacity = '0.7';
                c.style.fontWeight = 'normal';
            });
            el.classList.add('active');
            el.style.borderBottomColor = 'var(--vscode-button-background)';
            el.style.opacity = '1';
            el.style.fontWeight = 'bold';
            
            // Hide all output contents
            document.querySelectorAll('.output-content').forEach(c => c.style.display = 'none');
            // Show target
            document.getElementById(id).style.display = 'block';
        }
        window.switchOutputTab = switchOutputTab;

        window.switchTab = switchTab;

        function addProvider(id) {
            vscode.postMessage({ command: 'addProvider', providerId: id, data: {} });
        }
        window.addProvider = addProvider;

        function addZAI() {
            const key = document.getElementById('zai-key').value;
            const model = document.getElementById('zai-model').value;
            if(!key) return;
            vscode.postMessage({ command: 'addProvider', providerId: 'z-ai', data: { apiKey: key, model: model } });
        }
        window.addZAI = addZAI;
        
        function deleteZai() {
            vscode.postMessage({ command: 'deleteZai' });
        }
        window.deleteZai = deleteZai;

        function testSelectedModel() {
            const model = document.getElementById('zai-model').value;
            vscode.postMessage({ command: 'testProviderModel', providerId: 'z-ai', model: model });
        }
        window.testSelectedModel = testSelectedModel;

        function toggleZaiConfig() {
             const btn = document.getElementById('zai-toggle-btn');
             if (!btn) return;
             const isEnabled = btn.getAttribute('data-enabled') === 'true';
             vscode.postMessage({ command: 'toggleZai', enabled: !isEnabled });
        }
        window.toggleZaiConfig = toggleZaiConfig;

        function toggleZaiKeyVisibility() {
            const input = document.getElementById('zai-key');
            const icon = document.getElementById('zai-key-icon');
            if (input.type === 'password') {
                input.type = 'text';
                icon.innerHTML = '${icons.eyeOff}';
            } else {
                input.type = 'password';
                icon.innerHTML = '${icons.eye}';
            }
        }
        window.toggleZaiKeyVisibility = toggleZaiKeyVisibility;

        function copyZaiKey() {
            const key = document.getElementById('zai-key').value;
            vscode.postMessage({ command: 'copyKey', text: key });
        }
        window.copyZaiKey = copyZaiKey;

        function openAuthFile(provider) {
            vscode.postMessage({ command: 'openAuthFile', provider: provider });
        }
        window.openAuthFile = openAuthFile;

        function deleteAuthFile(provider) {
            vscode.postMessage({ command: 'deleteAuthFile', provider: provider });
        }
        window.deleteAuthFile = deleteAuthFile;

        function deleteSpecificAuthFile(provider, fileName) {
            vscode.postMessage({ command: 'deleteSpecificAuthFile', provider: provider, fileName: fileName });
        }
        window.deleteSpecificAuthFile = deleteSpecificAuthFile;

        function openSpecificAuthFile(provider, fileName) {
            vscode.postMessage({ command: 'openSpecificAuthFile', provider: provider, fileName: fileName });
        }
        window.openSpecificAuthFile = openSpecificAuthFile;

        function viewQuota(provider, fileName) {
            // Show modal with loading state
            document.getElementById('quotaModalTitle').textContent = provider.charAt(0).toUpperCase() + provider.slice(1) + ' - ${lm.t('Quota')}';
            document.getElementById('quotaModalContent').innerHTML = \`
                <div class="quota-loading">
                    <span class="spinner"></span>
                    <span>${lm.t('Loading...')}</span>
                </div>
            \`;
            document.getElementById('quotaModal').classList.add('visible');
            document.getElementById('quotaModalOverlay').classList.add('visible');
            
            vscode.postMessage({ command: 'viewQuota', provider: provider, fileName: fileName });
        }
        window.viewQuota = viewQuota;

        function closeQuotaModal() {
            document.getElementById('quotaModal').classList.remove('visible');
            document.getElementById('quotaModalOverlay').classList.remove('visible');
        }
        window.closeQuotaModal = closeQuotaModal;

        function toggleSection(elementId, stateKey) {
            const el = document.getElementById(elementId);
            const arrow = document.getElementById(elementId + '-arrow');
            const isVisible = el.style.display !== 'none';
            
            if (isVisible) {
                el.style.display = 'none';
                if (arrow) arrow.style.transform = 'rotate(0deg)';
                vscode.postMessage({ command: 'saveDashboardState', key: stateKey, value: false });
            } else {
                // Restore display type based on element class/id if needed, or just block/grid
                // providers-grid uses grid, info-grid uses grid, status-card uses flex
                if (elementId === 'providers-config' || elementId === 'server-info') {
                     el.style.display = 'grid';
                } else if (elementId === 'proxy-control') {
                     el.style.display = 'flex';
                } else {
                     el.style.display = 'block';
                }
                
                if (arrow) arrow.style.transform = 'rotate(90deg)';
                vscode.postMessage({ command: 'saveDashboardState', key: stateKey, value: true });
            }
        }
        window.toggleSection = toggleSection;

        function loginCodex() {
            vscode.postMessage({ command: 'loginCodex' });
        }
        window.loginCodex = loginCodex;

        function loginClaude() {
            vscode.postMessage({ command: 'loginClaude' });
        }
        window.loginClaude = loginClaude;

        function loginQwen() {
            vscode.postMessage({ command: 'loginQwen' });
        }
        window.loginQwen = loginQwen;

        function loginKimi() {
            vscode.postMessage({ command: 'loginKimi' });
        }
        window.loginKimi = loginKimi;



        function loginAntigravity() {
            vscode.postMessage({ command: 'loginAntigravity' });
        }
        window.loginAntigravity = loginAntigravity;

        function toggleAutoStart(enabled) {
            vscode.postMessage({ command: 'toggleAutoStart', enabled: enabled });
        }
        window.toggleAutoStart = toggleAutoStart;

        function generateApiKey() {
            vscode.postMessage({ command: 'generateApiKey' });
        }
        window.generateApiKey = generateApiKey;

        function testMcpMethod(method, args) {
             const container = document.getElementById('mcp-output-container');
             const resDiv = document.getElementById('tab-res');
             const reqDiv = document.getElementById('tab-req');
             
             if (container && resDiv && reqDiv) {
                 container.style.display = 'block';
                 resDiv.innerHTML = '<div style="padding: 20px; text-align: center; opacity: 0.8;"><span class="spinner"></span> ' + '${lm.t("Running {0}...").replace(/'/g, "\\'")}'.replace('{0}', method) + '</div>';
                 reqDiv.textContent = '${lm.t("Request pending...").replace(/'/g, "\\'")}';
                 
                 // Switch to Response tab immediately
                 const resTab = document.querySelector('.output-tab:nth-child(1)');
                 if (resTab) switchOutputTab(resTab, 'tab-res');
             }

             // For LIST MODELS specifically, clear the dropdown and show spinner
             if (method === 'list_models') {
                  const select = document.getElementById('mcp-test-model-select');
                  const modelSpinner = document.getElementById('mcp-models-loading');
                  const chatBtn = document.getElementById('chat-test-btn');
                  if (select) {
                      select.innerHTML = '<option value="">(Loading...)</option>';
                      select.style.display = 'none';
                  }
                  if (modelSpinner) modelSpinner.style.display = 'flex';
                  if (chatBtn) {
                      chatBtn.disabled = true;
                      chatBtn.style.opacity = '0.5';
                  }
             }
             
             if (method === 'chat_completion') {
                 const btnSpinner = document.getElementById('chat-test-spinner');
                 if (btnSpinner) btnSpinner.style.display = 'inline-block';
             }
             
             vscode.postMessage({ command: 'testMcpMethod', method: method, args: args });
        }
        window.testMcpMethod = testMcpMethod;



        function testProvider(providerId) {
             let model = '';
             if(providerId === 'antigravity') {
                 const el = document.getElementById('antigravity-model');
                 model = el ? el.value : 'gemini-3-pro-high';
             } else if (providerId === 'z-ai') {
                 const el = document.getElementById('zai-model');
                 // Default to glm-4-plus as seen in user config
                 model = el ? el.value : 'glm-4-plus';
             } else if (providerId === 'gemini') {
                 const el = document.getElementById('gemini-model');
                 model = el ? el.value : 'gemini-2.0-flash-exp';
             } else if (providerId === 'github-copilot') {
                 model = 'github-copilot/copilot-chat';
             }
             
             vscode.postMessage({ command: 'testProvider', providerId: providerId, data: { model: model } });
        }
        window.testProvider = testProvider;

        // Defined as window.testSelectedModel above or reused here with different signature?
        // Ah, this overrides 'testSelectedModel' above, but has different arguments.
        // It should be renamed or unified. Since 'testSelectedModel' for z-ai uses the above function,
        // this one is likely for generic provider testing. Let's make it unique.
        /*
        function testSelectedModel(providerId, selectId) {
            const model = document.getElementById(selectId).value;
            vscode.postMessage({ command: 'testProvider', providerId: providerId, data: { model: model } });
        }
        */

        let managementKey = null;
        let mcpRunning = ${mcpRunning};
        

        // Request current status from extension to handle stale HTML state (tab restoration)

        // Request current status from extension to handle stale HTML state (tab restoration)
        vscode.postMessage({ command: 'getMcpStatus' });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'mcpStatus':
                    mcpRunning = message.running;
                    updateMcpUi(mcpRunning);
                    break;
                case 'secretKey':
                    managementKey = message.key;
                    updateManagementKeyDisplay(true);
                    break;
                case 'openMcpInfo':
                    toggleMcpInfo();
                    break;
                        
                case 'mcpTestResult':
                    const outContainer = document.getElementById('mcp-output-container');
                    const baseUrlDiv = document.getElementById('mcp-base-url');
                    if (outContainer) outContainer.style.display = 'block';
                    if (baseUrlDiv && message.baseUrl) {
                        baseUrlDiv.textContent = 'URL: ' + message.baseUrl;
                    }

                    // 1. Handle Request Tab
                    const reqDiv = document.getElementById('tab-req');
                    if (message.request) {
                        try {
                             // try to pretty print
                             const reqObj = JSON.parse(message.request);
                             reqDiv.innerHTML = syntaxHighlight(reqObj);
                        } catch {
                             reqDiv.textContent = message.request;
                        }
                    } else {
                        reqDiv.textContent = 'No request data (message.request is falsy/unknown)';
                    }

                    // 2. Handle Headers Tab
                    const headDiv = document.getElementById('tab-headers');
                    if (message.headers && headDiv) {
                        try {
                             const headObj = JSON.parse(message.headers);
                             headDiv.innerHTML = syntaxHighlight(headObj);
                        } catch {
                             headDiv.textContent = message.headers;
                        }
                    } else if (headDiv) {
                        headDiv.textContent = 'No header data available';
                    }

                    // 3. Handle Response Tab
                    const resDiv = document.getElementById('tab-res');
                    let content = message.result;
                    let parsed = null;
                    
                    try {
                        if (typeof content === 'string' && (content.startsWith('{') || content.startsWith('['))) {
                            parsed = JSON.parse(content);
                        } else if (typeof content === 'object') {
                            parsed = content;
                        }
                    } catch {}

                    if (parsed) {
                        // Advanced Parsing: if content[i].text is a stringified JSON, parse it for display
                        if (parsed.content && Array.isArray(parsed.content)) {
                            parsed.content.forEach(item => {
                                if (typeof item.text === 'string' && (item.text.trim().startsWith('{') || item.text.trim().startsWith('['))) {
                                    try {
                                        item.text = JSON.parse(item.text);
                                    } catch (e) {}
                                }
                            });
                        }
                        resDiv.innerHTML = syntaxHighlight(parsed);
                    } else {
                        resDiv.textContent = content;
                    }

                    // 3. Extract models if present (for list_models)
                    if (parsed) {
                        let models = null;
                        if (parsed.models && Array.isArray(parsed.models)) {
                             models = parsed.models;
                        } else if (parsed.content && Array.isArray(parsed.content)) {
                             // Check MCP content
                             for (const item of parsed.content) {
                                  try {
                                      const inner = typeof item.text === 'string' ? JSON.parse(item.text) : item.text;
                                      if (inner && inner.models) {
                                           models = inner.models;
                                           break;
                                      }
                                  } catch {}
                             }
                        }
                        
                        if (models) {
                             updateMcpModelSelection(models);
                        } else {
                             // Fallback: Ensure spinners are hidden and UI is restored even if no models extracted
                             const modelSpinner = document.getElementById('mcp-models-loading');
                             const select = document.getElementById('mcp-test-model-select');
                             if (modelSpinner) modelSpinner.style.display = 'none';
                             if (select) {
                                 select.style.display = 'block';
                                 select.disabled = !mcpRunning;
                                 select.style.opacity = mcpRunning ? '1' : '0.5';
                             }
                        }
                    }

                    const chatBtn = document.getElementById('chat-test-btn');
                    if (chatBtn) {
                        chatBtn.disabled = !mcpRunning;
                        chatBtn.style.opacity = mcpRunning ? '1' : '0.5';
                        chatBtn.style.cursor = mcpRunning ? 'pointer' : 'not-allowed';
                    }

                    // Switch to Response tab
                    const resTab = document.querySelector('.output-tab:nth-child(1)');
                    if (resTab) switchOutputTab(resTab, 'tab-res');

                    // Hide button spinners
                    const btnSpinner = document.getElementById('chat-test-spinner');
                    if (btnSpinner) btnSpinner.style.display = 'none';
                    break;
                
                case 'streamStart': {
                    const outContainer = document.getElementById('mcp-output-container');
                    const baseUrlDiv = document.getElementById('mcp-base-url');
                    const resDiv = document.getElementById('tab-res');
                    const btnSpinner = document.getElementById('chat-test-spinner');
                    
                    if (outContainer) outContainer.style.display = 'block';
                    if (baseUrlDiv && message.baseUrl) {
                        baseUrlDiv.textContent = 'URL: ' + message.baseUrl;
                    }
                    if (resDiv) {
                        resDiv.innerHTML = '<span class="stream-cursor">▌</span>';
                        resDiv.dataset.streaming = 'true';
                    }
                    if (btnSpinner) btnSpinner.style.display = 'inline-block';
                    
                    // Switch to Response tab
                    const resTab = document.querySelector('.output-tab:nth-child(1)');
                    if (resTab) switchOutputTab(resTab, 'tab-res');
                    break;
                }
                
                case 'streamChunk': {
                    const resDiv = document.getElementById('tab-res');
                    if (resDiv && resDiv.dataset.streaming === 'true') {
                        // Get current content without cursor
                        let current = resDiv.textContent || '';
                        current = current.replace(/▌$/, '');
                        current += message.content;
                        resDiv.textContent = current + '▌';
                    }
                    break;
                }
                
                case 'streamEnd': {
                    const resDiv = document.getElementById('tab-res');
                    const reqDiv = document.getElementById('tab-req');
                    const btnSpinner = document.getElementById('chat-test-spinner');
                    
                    if (resDiv) {
                        resDiv.dataset.streaming = 'false';
                        // Remove cursor
                        let content = resDiv.textContent || '';
                        content = content.replace(/▌$/, '');
                        
                        if (message.error) {
                            resDiv.innerHTML = '<span style="color: var(--vscode-errorForeground);">Error: ' + escapeHtml(message.error) + '</span>';
                        } else {
                            resDiv.textContent = content;
                        }
                    }
                    
                    if (reqDiv && message.request) {
                        try {
                            const reqObj = JSON.parse(message.request);
                            reqDiv.innerHTML = syntaxHighlight(reqObj);
                        } catch {
                            reqDiv.textContent = message.request;
                        }
                    }
                    
                    if (btnSpinner) btnSpinner.style.display = 'none';
                    
                    const chatBtn = document.getElementById('chat-test-btn');
                    if (chatBtn) {
                        chatBtn.disabled = !mcpRunning;
                        chatBtn.style.opacity = mcpRunning ? '1' : '0.5';
                    }
                    break;
                }
                    
                case 'quotaResult': {
                    const contentEl = document.getElementById('quotaModalContent');
                    if (message.error) {
                        contentEl.innerHTML = \`
                            <div style="color: var(--vscode-errorForeground); padding: 16px; text-align: center;">
                                \${escapeHtml(message.error)}
                            </div>
                        \`;
                    } else if (message.data) {
                        const provider = message.provider || 'Unknown';
                        const badgeClass = provider === 'codex' ? 'codex' : 'antigravity';
                        
                        let html = \`<div class="quota-card">
                            <div class="quota-card-header">
                                <span class="quota-badge \${badgeClass}">\${provider.charAt(0).toUpperCase() + provider.slice(1)}</span>
                                <span style="opacity:0.7; font-size:0.85em;">\${message.fileName || ''}</span>
                            </div>\`;
                        
                        // Parse quotas from response
                        // Note: /api-call returns { statusCode, header, bodyText, body }
                        let data = message.data;
                        console.log('[QuotaResult] Raw data:', JSON.stringify(data, null, 2));
                        
                        // Unwrap api-call response - body can be string or object
                        if (data.body !== undefined) {
                            console.log('[QuotaResult] Unwrapping body from api-call response, type:', typeof data.body);
                            if (typeof data.body === 'string') {
                                try {
                                    data = JSON.parse(data.body);
                                    console.log('[QuotaResult] Parsed body string as JSON');
                                } catch (e) {
                                    console.log('[QuotaResult] Failed to parse body string:', e);
                                    data = data.body;
                                }
                            } else {
                                data = data.body;
                            }
                        } else if (data.bodyText && typeof data.bodyText === 'string') {
                            try {
                                data = JSON.parse(data.bodyText);
                                console.log('[QuotaResult] Parsed bodyText as JSON');
                            } catch (e) { 
                                console.log('[QuotaResult] Failed to parse bodyText'); 
                            }
                        }
                        console.log('[QuotaResult] Processed data:', JSON.stringify(data, null, 2));
                        
                        let quotas = [];
                        
                        // Handle Codex format: rate_limit.primary_window, secondary_window
                        const rateLimit = data.rate_limit ?? data.rateLimit;
                        if (rateLimit) {
                            console.log('[QuotaResult] Detected Codex rate_limit format');
                            const addWindow = (name, window) => {
                                if (!window) return;
                                const usedPercent = window.used_percent ?? window.usedPercent;
                                if (usedPercent !== undefined) {
                                    const remainingPercent = 100 - usedPercent;
                                    quotas.push({
                                        name,
                                        usedPercent,
                                        remainingPercent,
                                        isCodex: true,
                                        limitReached: rateLimit.limit_reached ?? rateLimit.limitReached ?? false,
                                        reset: window.reset_at ?? window.resetAt
                                    });
                                }
                            };
                            addWindow('${lm.t('5 Hour Limit')}', rateLimit.primary_window ?? rateLimit.primaryWindow);
                            addWindow('${lm.t('Weekly Limit')}', rateLimit.secondary_window ?? rateLimit.secondaryWindow);
                            addWindow('${lm.t('Weekly code review limit')}', rateLimit.code_review_window ?? rateLimit.codeReviewWindow ?? rateLimit.code_review);
                        }
                        // Handle Antigravity format: models with quotaInfo.remainingFraction
                        else if (data.models && typeof data.models === 'object') {
                            console.log('[QuotaResult] Detected Antigravity models format');
                            for (const modelName in data.models) {
                                const modelData = data.models[modelName];
                                // Skip internal models without displayName
                                if (modelData.isInternal) continue;
                                
                                const quotaInfo = modelData.quotaInfo;
                                if (quotaInfo && quotaInfo.remainingFraction !== undefined) {
                                    const remainingFraction = quotaInfo.remainingFraction ?? quotaInfo.remaining_fraction;
                                    const resetTime = quotaInfo.resetTime ?? quotaInfo.reset_time;
                                    const remainingPercent = Math.round(remainingFraction * 100);
                                    const displayName = modelData.displayName || modelName;
                                    
                                    quotas.push({
                                        name: displayName,
                                        remainingPercent,
                                        usedPercent: 100 - remainingPercent,
                                        isAntigravity: true,
                                        reset: resetTime
                                    });
                                }
                            }
                        }
                        // Handle Gemini CLI format: buckets array
                        else if (data && data.buckets && Array.isArray(data.buckets)) {
                            console.log('[QuotaResult] Detected Gemini CLI buckets format');
                            
                            // Group by series
                            const groups = {};
                            
                            const buckets = data.buckets;
                            if (buckets.length > 0) {
                                buckets.forEach(bucket => {
                                    // Only process REQUESTS type for simplicity or as needed
                                    if (bucket.tokenType !== 'REQUESTS' && bucket.tokenType !== 'TOKENS') return; 

                                    let series = 'Other';
                                    const mId = bucket.modelId || '';
                                    if (mId.includes('flash-lite')) series = 'Gemini Flash Lite Series';
                                    else if (mId.includes('flash')) series = 'Gemini Flash Series';
                                    else if (mId.includes('pro')) series = 'Gemini Pro Series';
                                    else if (mId.includes('ultra')) series = 'Gemini Ultra Series';

                                    if (!groups[series]) groups[series] = [];
                                    groups[series].push(bucket);
                                });

                                for (const series in groups) {
                                    const groupBuckets = groups[series];
                                    const minRemaining = Math.min(...groupBuckets.map(b => b.remainingFraction));
                                    const resetTime = groupBuckets[0].resetTime; 

                                    const remainingPercent = Math.round(minRemaining * 100);

                                    quotas.push({
                                        name: series,
                                        remainingPercent: remainingPercent,
                                        usedPercent: 100 - remainingPercent,
                                        isGemini: true, // Use isGemini to bypass downstream Antigravity grouping
                                        reset: resetTime
                                    });
                                }
                                
                                // If filtering by series resulted in nothing (e.g. unknown models), fallback to raw list
                                if (quotas.length === 0) {
                                    buckets.forEach(b => {
                                         if (b.tokenType !== 'REQUESTS' && b.tokenType !== 'TOKENS') return;
                                         quotas.push({
                                            name: b.modelId,
                                            remainingPercent: Math.round(b.remainingFraction * 100),
                                            usedPercent: 100 - Math.round(b.remainingFraction * 100),
                                            isGemini: true,
                                            reset: b.resetTime
                                         });
                                    });
                                }
                            }
                        }
                        // Fallback: original formats (quotas array, single quota, nested objects)
                        else if (data.quotas && Array.isArray(data.quotas)) {
                            quotas = data.quotas;
                        } else if (data.remaining !== undefined && data.limit !== undefined) {
                            quotas = [{
                                name: data.name || '${lm.t('Usage')}',
                                used: data.limit - data.remaining,
                                limit: data.limit,
                                reset: data.reset_at || data.reset
                            }];
                        } else {
                            for (const key in data) {
                                if (typeof data[key] === 'object' && data[key] !== null && data[key].limit !== undefined) {
                                    quotas.push({
                                        name: key,
                                        used: data[key].used || (data[key].limit - (data[key].remaining || 0)),
                                        limit: data[key].limit,
                                        reset: data[key].reset_at || data[key].reset
                                    });
                                }
                            }
                        }
                        
                        if (quotas.length === 0) {
                            html += '<div style="opacity:0.7; padding:16px; text-align:center;">' + ${JSON.stringify(lm.t('No quota information available'))} + '</div>';
                        } else {
                            // Helper for escaping HTML (client-side)
                            const escapeHtml = (text) => {
                                if (!text) return text;
                                return text.replace(/[&<>"']/g, function(m) {
                                    switch (m) {
                                        case '&': return '&amp;';
                                        case '<': return '&lt;';
                                        case '>': return '&gt;';
                                        case '"': return '&quot;';
                                        case "'": return '&#039;';
                                        default: return m;
                                    }
                                });
                            };

                            // Check if we should group (Antigravity only)
                            const isAntigravity = quotas.some(q => q.isAntigravity);
                            
                            if (isAntigravity) {
                                // Grouping Logic
                                const groups = {
                                    'Gemini 3 Flash': [],
                                    'Gemini 3 Pro': [],
                                    'Gemini 3 Pro Image': [],
                                    'Gemini 2.5 Flash': [],
                                    'Gemini 2.5 Flash Lite': [],
                                    'Claude & GPT-OSS': [],
                                    'Other': []
                                };
                                
                                quotas.forEach(q => {
                                    const name = q.name || '';
                                    if (name.includes('Gemini 2.5 Flash Lite')) {
                                        groups['Gemini 2.5 Flash Lite'].push(q);
                                    } else if (name.includes('Gemini 2.5 Flash')) {
                                        groups['Gemini 2.5 Flash'].push(q);
                                    } else if (name.includes('Gemini 3 Flash')) {
                                        groups['Gemini 3 Flash'].push(q);
                                    } else if (name.includes('Gemini 3 Pro') && (name.includes('Image') || name.includes('Vision'))) {
                                        // Catch "Gemini 3 Pro Image" or similar variations
                                        groups['Gemini 3 Pro Image'].push(q);
                                    } else if (name.includes('Gemini 3 Pro')) {
                                        groups['Gemini 3 Pro'].push(q);
                                    } else if (name.includes('Claude') || name.includes('GPT-OSS')) {
                                        groups['Claude & GPT-OSS'].push(q);
                                    } else {
                                        groups['Other'].push(q);
                                    }
                                });
                                
                                // Render groups
                                const groupNames = [
                                    'Gemini 3 Flash', 
                                    'Gemini 3 Pro', 
                                    'Gemini 3 Pro Image',
                                    'Gemini 2.5 Flash', 
                                    'Gemini 2.5 Flash Lite', 
                                    'Claude & GPT-OSS', 
                                    'Other'
                                ];
                                
                                groupNames.forEach(groupName => {
                                    const groupQuotas = groups[groupName];
                                    if (groupQuotas.length > 0) {
                                        // Take the first item as representative for the group
                                        const representative = groupQuotas[0];
                                        
                                        // Create a display object with the group name
                                        const displayItem = { ...representative, name: groupName };
                                        
                                        // Render single consolidated item
                                        renderQuotaItem(displayItem);
                                    }
                                });
                                
                            } else {
                                // Default flat list
                                quotas.forEach(q => renderQuotaItem(q));
                            }
                            
                            function renderQuotaItem(q) {
                                let barPercent, displayPercent, displayValue;
                                // Fix: use custom formatter to ensure correct locale display
                                const resetTs = q.reset ? (typeof q.reset === 'number' && q.reset < 10000000000 ? q.reset * 1000 : q.reset) : null;
                                const resetDate = resetTs ? formatDate(resetTs, currentLocale) : '';
                                
                                if (q.isAntigravity || q.isGemini) {
                                    const remaining = q.remainingPercent ?? 0;
                                    barPercent = remaining;
                                    displayPercent = remaining;
                                    displayValue = remaining + '% ' + ${JSON.stringify(lm.t('available'))};
                                } else if (q.isCodex) {
                                    const used = q.usedPercent ?? 0;
                                    const remaining = 100 - used;
                                    barPercent = remaining;
                                    displayPercent = remaining;
                                    displayValue = remaining + '% ' + ${JSON.stringify(lm.t('available'))};
                                } else {
                                    const used = q.used || 0;
                                    const limit = q.limit || 100;
                                    barPercent = Math.min(100, Math.round((used / limit) * 100));
                                    displayPercent = 100 - barPercent;
                                    displayValue = used + '/' + limit;
                                }
                                
                                const colorPercent = (q.isAntigravity || q.isCodex || q.isGemini) ? barPercent : (100 - barPercent);
                                const barColor = colorPercent > 50 ? '#4caf50' : colorPercent > 20 ? '#ff9800' : '#f44336';
                                const barColorEnd = colorPercent > 50 ? '#8bc34a' : colorPercent > 20 ? '#ffc107' : '#e91e63';
                                
                                html += '<div class="quota-item">' +
                                        '<div class="quota-item-header">' +
                                            '<span class="quota-item-name">' + escapeHtml(q.name || 'Quota') + '</span>' +
                                            '<span class="quota-item-value">' +
                                                '<span class="quota-item-percent" style="color: ' + (colorPercent > 50 ? '#4caf50' : colorPercent > 20 ? '#ff9800' : 'var(--vscode-errorForeground)') + '">' + displayPercent + '%</span>' +
                                                '<span style="opacity:0.7">' + displayValue + '</span>' +
                                            '</span>' +
                                        '</div>' +
                                        '<div class="quota-bar">' +
                                            '<div class="quota-bar-fill" style="width: ' + (q.isCodex ? barPercent : barPercent) + '%; background: linear-gradient(90deg, ' + barColor + ', ' + barColorEnd + ')"></div>' +
                                        '</div>' +
                                        (resetDate ? '<div class="quota-item-date">' + escapeHtml(lm.t('Reset at {0}', resetDate)) + '</div>' : '') +
                                    '</div>';
                            }
                        }
                        
                        html += '</div>';
                        contentEl.innerHTML = html;
                    }
                    break;    }
            }
        });

function syntaxHighlight(json) {
    if (typeof json !== 'string') {
        json = JSON.stringify(json, undefined, 2);
    }
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    /* eslint-disable no-useless-escape */
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        var cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            } else {
                cls = 'string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
        } else if (/null/.test(match)) {
            cls = 'null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

function addToMcpConfig() {
    vscode.postMessage({ command: 'addToMcpConfig' });
}
window.addToMcpConfig = addToMcpConfig;

function installMcpConfig() {
    vscode.postMessage({ command: 'installMcpConfig' });
}
window.installMcpConfig = installMcpConfig;

function updateMcpModelSelection(models) {
    const select = document.getElementById('mcp-test-model-select');
    const modelSpinner = document.getElementById('mcp-models-loading');
    const chatBtn = document.getElementById('chat-test-btn');
    if (!select) return;

    // Save all models for later filtering
    if (models && models.length > 0) {
        window._allMcpModels = models;
    }

    if (modelSpinner) modelSpinner.style.display = 'none';
    select.style.display = 'block';

    // Respect mcpRunning state
    select.disabled = !mcpRunning;
    select.style.opacity = mcpRunning ? '1' : '0.5';
    select.style.cursor = mcpRunning ? 'pointer' : 'not-allowed';

    if (chatBtn) {
        chatBtn.disabled = !mcpRunning;
        chatBtn.style.opacity = mcpRunning ? '1' : '0.5';
        chatBtn.style.cursor = mcpRunning ? 'pointer' : 'not-allowed';
    }

    // Check if streaming is enabled - if so, filter to only z-ai models
    const streamToggle = document.getElementById('mcp-stream-toggle');
    const isStreaming = streamToggle && streamToggle.checked;
    
    let filteredModels = models;
    if (isStreaming) {
        // Only show z-ai models for streaming (OpenAI-compatible)
        filteredModels = models.filter(m => m.owned_by === 'z-ai');
    }

    // Group models by owned_by
    const groups = {};
    filteredModels.forEach(m => {
        const owner = m.owned_by || 'Other';
        if (!groups[owner]) groups[owner] = [];
        groups[owner].push(m);
    });

    // Sort owners alphabetically
    const owners = Object.keys(groups).sort();

    // Clear and build groups
    select.innerHTML = '';

    // Add a placeholder if no models available after filtering
    if (filteredModels.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = isStreaming ? '${lm.t('(No streaming-compatible models)').replace(/'/g, "\\'")}' : '${lm.t('(Run LIST MODELS to populate)').replace(/'/g, "\\'")}';
        select.appendChild(option);
        return;
    }

    owners.forEach(owner => {
        const optgroup = document.createElement('optgroup');
        // Format owner name for better readability
        optgroup.label = owner.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());

        // Sort models by ID within the group
        groups[owner].sort((a, b) => a.id.localeCompare(b.id)).forEach(m => {
            const option = document.createElement('option');
            // Prefix with provider for better routing in MCP server
            const provider = m.owned_by || '';
            option.value = (provider && !m.id.includes('/')) ? (provider + '/' + m.id) : m.id;
            option.textContent = m.id;
            optgroup.appendChild(option);
        });

        select.appendChild(optgroup);
    });

    // Auto-select first available option if none selected
    if (!select.value && select.options.length > 0) {
        select.selectedIndex = 0;
    }
}

// Handler for streaming toggle - re-filter models when changed
function onStreamingToggleChange() {
    if (window._allMcpModels && window._allMcpModels.length > 0) {
        updateMcpModelSelection(window._allMcpModels);
    }
}
window.onStreamingToggleChange = onStreamingToggleChange;

function openMcpConfig() {
    vscode.postMessage({ command: 'openMcpConfig' });
}
window.openMcpConfig = openMcpConfig;



function toggleMcpServer() {
    if (mcpRunning) {
        vscode.postMessage({ command: 'stopMcpServer' });
    } else {
        vscode.postMessage({ command: 'runMcpServer' });
    }
}
window.toggleMcpServer = toggleMcpServer;

function updateMcpUi(running) {
    const btn = document.getElementById('mcp-server-btn');
    const dot = document.getElementById('mcp-status-dot');
    const text = document.getElementById('mcp-status-text');
    const testButtons = document.querySelectorAll('.mcp-test-btn');

    if (running) {
        btn.innerHTML = '${icons.stop} ${lm.t("Stop MCP").replace(/'/g, "\\'")}' ;
                 btn.title = '${lm.t("Stop server").replace(/'/g, "\\'")}';

    dot.style.backgroundColor = '#4caf50';
    dot.style.boxShadow = '0 0 8px #4caf5080';
    text.style.color = '#4caf50';
                 text.textContent = '${lm.t("Running").replace(/'/g, "\\'")}';

testButtons.forEach(b => {
    b.disabled = false;
    b.style.opacity = '1';
    b.style.cursor = 'pointer';
});

// Auto-refresh models once when server starts, BUT ONLY if we don't have existing output
// This prevents clearing the output if it was restored from state
const mSelect = document.getElementById('mcp-test-model-select');
const resDiv = document.getElementById('tab-res');
const hasOutput = resDiv && resDiv.innerHTML.trim().length > 0 && !resDiv.innerHTML.includes('Running');

if (mSelect && (mSelect.options.length <= 1 || !mSelect.value) && !hasOutput) {
    if (!window._mcpModelsLoading) {
        window._mcpModelsLoading = true;
        setTimeout(() => {
            testMcpMethod('list_models');
            setTimeout(() => { window._mcpModelsLoading = false; }, 5000);
        }, 1000);
    }
}
             } else {
    window._mcpModelsLoading = false;
    btn.innerHTML = '${icons.play} ${lm.t("Run MCP").replace(/'/g, "\\'")}' ;
                 btn.title = '${lm.t("Launch server in terminal").replace(/'/g, "\\'")}';

dot.style.backgroundColor = 'var(--vscode-descriptionForeground)';
dot.style.boxShadow = 'none';
text.style.color = 'var(--vscode-descriptionForeground)';
                 text.textContent = '${lm.t("Ready").replace(/'/g, "\\'")}';

testButtons.forEach(b => {
    b.disabled = true;
    b.style.opacity = '0.5';
    b.style.cursor = 'not-allowed';
});
             }
        }

function updateManagementKeyDisplay(show) {
    const container = document.getElementById('mgmt-key-container');
    const btn = document.getElementById('toggle-mgmt-btn');
    if (show && managementKey) {
        container.textContent = managementKey;
        container.style.fontStyle = 'normal';
                btn.textContent = '${lm.t("Hide").replace(/'/g, "\\'")}';
    btn.setAttribute('data-state', 'visible');
} else {
    container.textContent = '• • • • • • • • • • • •';
    container.style.fontStyle = 'italic';
                btn.textContent = '${lm.t("Show").replace(/'/g, "\\'")}';
btn.setAttribute('data-state', 'hidden');
            }
        }

function toggleManagementKey() {
    const btn = document.getElementById('toggle-mgmt-btn');
    const state = btn.getAttribute('data-state');
    if (state === 'hidden') {
        if (!managementKey) {
            vscode.postMessage({ command: 'getSecretKey' });
        } else {
            updateManagementKeyDisplay(true);
        }
    } else {
        updateManagementKeyDisplay(false);
    }
}
window.toggleManagementKey = toggleManagementKey;

function copyManagementKey() {
    vscode.postMessage({ command: 'copySecretKey' });
}
window.copyManagementKey = copyManagementKey;

function changeManagementKey() {
    vscode.postMessage({ command: 'changeManagementKey' });
}
window.changeManagementKey = changeManagementKey;

function authenticate(provider) {
    vscode.postMessage({ command: 'authenticate', provider: provider });
}
window.authenticate = authenticate;

</script>
    </body>
    </html>`;
    }
}
