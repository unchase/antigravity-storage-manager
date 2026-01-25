import * as vscode from 'vscode';
import * as http from 'http';
import * as url from 'url';
import { google } from 'googleapis';
import { LocalizationManager } from './l10n/localizationManager';
import * as crypto from 'crypto';

// OAuth2 Configuration
// 1. Create a project in Google Cloud Console
// 2. Enable Google Drive API
// 3. Create OAuth2 credentials (Desktop App type)
// 4. Enter Client ID and Secret in VS Code settings for this extension
const REDIRECT_PORT = 47842;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Scopes for Google Drive access
const SCOPES = [
    'https://www.googleapis.com/auth/drive.file', // Access only files created by this app
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
];

const EXT_NAME = 'antigravity-storage-manager';

interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    expiryDate: number;
}

export interface StoredAccount {
    id: string;
    email: string;
    name: string;
    lastActive: number;
}

/**
 * Manages Google OAuth2 authentication for the extension
 */
export class GoogleAuthProvider {
    private oauth2Client!: InstanceType<typeof google.auth.OAuth2>;
    private context: vscode.ExtensionContext;
    private tokens: StoredTokens | null = null;
    private server: http.Server | null = null;
    private currentAccountId: string | null = null;
    private _onDidChangeSessions = new vscode.EventEmitter<void>();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadCredentials();

        // Set up token refresh handler
        this.oauth2Client.on('tokens', (tokens) => {
            if (tokens.refresh_token) {
                this.saveTokens({
                    accessToken: tokens.access_token || '',
                    refreshToken: tokens.refresh_token,
                    expiryDate: tokens.expiry_date || 0
                });
            } else if (this.tokens) {
                this.saveTokens({
                    ...this.tokens,
                    accessToken: tokens.access_token || '',
                    expiryDate: tokens.expiry_date || 0
                });
            }
        });
    }

    /**
     * Load or reload credentials from configuration
     */
    public loadCredentials(): void {
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const clientId = config.get<string>('google.clientId');
        const clientSecret = config.get<string>('google.clientSecret');

        // Preserve existing listeners if we are re-creating the client
        const listeners = this.oauth2Client ? this.oauth2Client.listeners('tokens') : [];

        if (!clientId || !clientSecret || clientId.includes('YOUR_CLIENT_ID')) {
            // Initialize with dummy values to prevent crash, checkAuth will fail gracefully
            this.oauth2Client = new google.auth.OAuth2('', '', REDIRECT_URI);
        } else {
            this.oauth2Client = new google.auth.OAuth2(
                clientId,
                clientSecret,
                REDIRECT_URI
            );
        }

        // Restore listeners
        listeners.forEach(listener => {
            this.oauth2Client.on('tokens', listener as any);
        });

        // Restore credentials if we have them
        if (this.tokens) {
            this.oauth2Client.setCredentials({
                access_token: this.tokens.accessToken,
                refresh_token: this.tokens.refreshToken,
                expiry_date: this.tokens.expiryDate
            });
        }
    }

    /**
     * Initialize the auth provider by loading stored tokens
     */
    async initialize(): Promise<void> {
        // Migration logic: check if there are legacy tokens but no accounts list
        const legacyTokensStr = await this.context.secrets.get(`${EXT_NAME}.google.tokens`);
        const accountsStr = await this.context.secrets.get(`${EXT_NAME}.google.accounts`);

        if (legacyTokensStr && !accountsStr) {
            console.log('GoogleAuthProvider: Migrating legacy tokens...');
            try {
                const legacyTokens = JSON.parse(legacyTokensStr);
                // Attempt to get user info to build account profile
                this.tokens = legacyTokens;
                this.oauth2Client.setCredentials({
                    access_token: legacyTokens.accessToken,
                    refresh_token: legacyTokens.refreshToken,
                    expiry_date: legacyTokens.expiryDate
                });

                let userInfo = await this.getUserInfo();
                if (!userInfo) {
                    // Fallback
                    userInfo = { email: 'Legacy User', name: 'Legacy User' };
                }

                const accountId = this.generateAccountId(userInfo.email);
                const account: StoredAccount = {
                    id: accountId,
                    email: userInfo.email,
                    name: userInfo.name,
                    lastActive: Date.now()
                };

                await this.saveAccountList([account]);
                await this.setCurrentAccount(accountId);
                await this.saveTokensForAccount(accountId, legacyTokens);

                // Cleanup legacy key
                await this.context.secrets.delete(`${EXT_NAME}.google.tokens`);

                console.log('GoogleAuthProvider: Migration complete.');
            } catch (e) {
                console.error('Migration failed', e);
            }
        }

        // Load current active account
        this.currentAccountId = await this.context.secrets.get(`${EXT_NAME}.google.currentAccountId`) || null;
        if (this.currentAccountId) {
            await this.loadAccount(this.currentAccountId);
        }
    }

    private generateAccountId(email: string): string {
        return crypto.createHash('md5').update(email).digest('hex');
    }

    async getAccounts(): Promise<StoredAccount[]> {
        const accountsStr = await this.context.secrets.get(`${EXT_NAME}.google.accounts`);
        return accountsStr ? JSON.parse(accountsStr) : [];
    }

    private async saveAccountList(accounts: StoredAccount[]): Promise<void> {
        await this.context.secrets.store(`${EXT_NAME}.google.accounts`, JSON.stringify(accounts));
    }

    private async saveTokensForAccount(accountId: string, tokens: StoredTokens): Promise<void> {
        await this.context.secrets.store(`${EXT_NAME}.google.tokens.${accountId}`, JSON.stringify(tokens));
    }

    private async loadTokensForAccount(accountId: string): Promise<StoredTokens | null> {
        const tokenStr = await this.context.secrets.get(`${EXT_NAME}.google.tokens.${accountId}`);
        return tokenStr ? JSON.parse(tokenStr) : null;
    }

    /**
     * Switch active account
     */
    async switchAccount(accountId: string): Promise<void> {
        const accounts = await this.getAccounts();
        const account = accounts.find(a => a.id === accountId);
        if (!account) throw new Error('Account not found');

        await this.loadAccount(accountId);

        // Update last active
        account.lastActive = Date.now();
        await this.saveAccountList(accounts);

        this._onDidChangeSessions.fire();
    }

    private async loadAccount(accountId: string): Promise<void> {
        const tokens = await this.loadTokensForAccount(accountId);
        if (tokens) {
            this.tokens = tokens;
            this.currentAccountId = accountId;
            this.oauth2Client.setCredentials({
                access_token: this.tokens.accessToken,
                refresh_token: this.tokens.refreshToken,
                expiry_date: this.tokens.expiryDate
            });
            await this.context.secrets.store(`${EXT_NAME}.google.currentAccountId`, accountId);
        } else {
            // Handle stale account entry?
            this.tokens = null;
            this.currentAccountId = null;
        }
    }

    async removeAccount(accountId: string): Promise<void> {
        let accounts = await this.getAccounts();
        accounts = accounts.filter(a => a.id !== accountId);
        await this.saveAccountList(accounts);
        await this.context.secrets.delete(`${EXT_NAME}.google.tokens.${accountId}`);

        if (this.currentAccountId === accountId) {
            // If removed active account, switch to another or logout
            if (accounts.length > 0) {
                await this.switchAccount(accounts[0].id);
            } else {
                await this.signOut();
            }
        }
        this._onDidChangeSessions.fire();
    }

    getCurrentAccountId(): string | null {
        return this.currentAccountId;
    }

    get onDidChangeSessions(): vscode.Event<void> {
        return this._onDidChangeSessions.event;
    }

    /**
     * Check if user is authenticated
     */
    isAuthenticated(): boolean {
        return this.tokens !== null && this.tokens.refreshToken !== '';
    }

    /**
     * Get the OAuth2 client for API calls
     */
    getOAuth2Client(): InstanceType<typeof google.auth.OAuth2> {
        // Safety check: Ensure client has credentials if we have tokens
        if (this.tokens && (!this.oauth2Client.credentials || !this.oauth2Client.credentials.access_token)) {
            console.log('GoogleAuthProvider: Restoring credentials to OAuth2Client');
            this.oauth2Client.setCredentials({
                access_token: this.tokens.accessToken,
                refresh_token: this.tokens.refreshToken,
                expiry_date: this.tokens.expiryDate
            });
        }
        return this.oauth2Client;
    }

    /**
     * Get a valid access token, refreshing if necessary
     */
    async getAccessToken(): Promise<string | null> {
        if (!this.tokens) {
            return null;
        }

        // Check if token is expired or will expire in the next minute
        const now = Date.now();
        if (this.tokens.expiryDate && this.tokens.expiryDate < now + 60000) {
            await this.refreshToken();
        }

        return this.tokens?.accessToken || null;
    }

    /**
     * Refresh the access token using the refresh token
     */
    async refreshToken(): Promise<void> {
        // Ensure we have the latest client secret
        this.loadCredentials();

        if (!this.tokens?.refreshToken) {
            throw new Error('No refresh token available');
        }

        try {
            const { credentials } = await this.oauth2Client.refreshAccessToken();
            this.tokens = {
                accessToken: credentials.access_token || '',
                refreshToken: credentials.refresh_token || this.tokens.refreshToken,
                expiryDate: credentials.expiry_date || 0
            };
            await this.saveTokens(this.tokens);
        } catch (error: any) {
            const lm = LocalizationManager.getInstance();
            vscode.window.showErrorMessage(lm.t('Failed to refresh token: {0}', error.message));
            // Clear tokens on refresh failure
            await this.signOut();
            throw new Error(lm.t('Session expired. Please sign in again.'));
        }
    }

    /**
     * Start the OAuth2 sign-in flow
     */
    async signIn(): Promise<void> {
        await this.startAuthFlow();
    }

    /**
     * Add a new account (same as sign in, but appends)
     */
    async addAccount(): Promise<void> {
        await this.startAuthFlow(true);
    }

    private async startAuthFlow(isAdd: boolean = false): Promise<void> {
        const lm = LocalizationManager.getInstance();
        // Reload credentials just in case they were updated
        this.loadCredentials();

        // Check for client ID/Secret
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const clientId = config.get<string>('google.clientId');
        const clientSecret = config.get<string>('google.clientSecret');

        if (!clientId || !clientSecret || clientId.includes('YOUR_CLIENT_ID')) {
            const openSettings = lm.t('Open Settings');
            const selection = await vscode.window.showErrorMessage(
                lm.t('Google Drive OAuth credentials are missing. Please configure them in settings to enable sync.'),
                openSettings
            );
            if (selection === openSettings) {
                await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:unchase.${EXT_NAME}`);
            }
            throw new Error(lm.t('Missing OAuth credentials'));
        }

        return new Promise((resolve, reject) => {
            // Create a local HTTP server to receive the OAuth callback
            this.server = http.createServer(async (req, res) => {
                try {
                    const parsedUrl = url.parse(req.url || '', true);

                    if (parsedUrl.pathname === '/callback') {
                        const code = parsedUrl.query.code as string;
                        const error = parsedUrl.query.error as string;

                        if (error) {
                            res.writeHead(400, { 'Content-Type': 'text/html' });
                            res.end(`
                                <!DOCTYPE html>
                                <html>
                                <head>
                                    <meta charset="UTF-8">
                                    <title>Authentication Failed</title>
                                    <style>
                                        :root {
                                            --bg: #0d1117;
                                            --fg: #c9d1d9;
                                            --danger: #f85149;
                                            --card-bg: #161b22;
                                            --border: #30363d;
                                        }
                                        body {
                                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                                            background-color: var(--bg);
                                            color: var(--fg);
                                            display: flex;
                                            align-items: center;
                                            justify-content: center;
                                            height: 100vh;
                                            margin: 0;
                                        }
                                        .card {
                                            background: var(--card-bg);
                                            border: 1px solid var(--border);
                                            border-radius: 12px;
                                            padding: 40px;
                                            max-width: 400px;
                                            width: 90%;
                                            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                                            text-align: center;
                                            animation: fadeIn 0.5s ease-out;
                                        }
                                        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                                        h1 { color: var(--danger); margin-top: 0; font-size: 24px; }
                                        p { line-height: 1.6; opacity: 0.9; }
                                        .error-code { font-family: monospace; background: rgba(248,81,73,0.1); padding: 4px 8px; border-radius: 4px; color: var(--danger); }
                                        .icon { font-size: 48px; margin-bottom: 20px; }
                                    </style>
                                </head>
                                <body>
                                    <div class="card">
                                        <div class="icon">❌</div>
                                        <h1>Authentication Failed</h1>
                                        <p>Something went wrong during the sign-in process.</p>
                                        <p><span class="error-code">${error}</span></p>
                                        <p style="font-size: 0.9em; opacity: 0.6; margin-top: 30px;">You can close this window and try again from VS Code.</p>
                                    </div>
                                </body>
                                </html>
                            `);
                            this.closeServer();
                            reject(new Error(`OAuth error: ${error}`));
                            return;
                        }

                        if (code) {
                            // Exchange code for tokens
                            const { tokens } = await this.oauth2Client.getToken(code);
                            this.oauth2Client.setCredentials(tokens);
                            console.log('Scopes granted:', tokens.scope);

                            // Verify scopes
                            if (tokens.scope && !tokens.scope.includes('drive.file')) {
                                throw new Error(lm.t('You must grant the "See, edit, create, and delete only the specific Google Drive files you use with this app" permission to use this extension.'));
                            }

                            const tempTokens = {
                                accessToken: tokens.access_token || '',
                                refreshToken: tokens.refresh_token || '',
                                expiryDate: tokens.expiry_date || 0
                            };

                            // Temporarily set tokens to fetch user info
                            this.tokens = tempTokens;

                            // Fetch User Info
                            const userInfo = await this.getUserInfo();
                            if (!userInfo) {
                                throw new Error('Failed to retrieve user info');
                            }

                            // Create Account Record
                            const accountId = this.generateAccountId(userInfo.email);
                            const newAccount: StoredAccount = {
                                id: accountId,
                                email: userInfo.email,
                                name: userInfo.name,
                                lastActive: Date.now()
                            };

                            // Check if account already exists
                            const existingAccounts = await this.getAccounts();
                            if (!existingAccounts.find(a => a.id === accountId)) {
                                existingAccounts.push(newAccount);
                                await this.saveAccountList(existingAccounts);
                            }

                            // Save tokens specifically for this account
                            await this.saveTokensForAccount(accountId, tempTokens);
                            await this.setCurrentAccount(accountId);

                            this._onDidChangeSessions.fire();

                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(`
                                <!DOCTYPE html>
                                <html>
                                <head>
                                    <meta charset="UTF-8">
                                    <title>Authentication Successful</title>
                                    <style>
                                        :root {
                                            --bg: #0d1117;
                                            --fg: #c9d1d9;
                                            --success: #3fb950;
                                            --card-bg: #161b22;
                                            --border: #30363d;
                                        }
                                        body {
                                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                                            background-color: var(--bg);
                                            color: var(--fg);
                                            display: flex;
                                            align-items: center;
                                            justify-content: center;
                                            height: 100vh;
                                            margin: 0;
                                        }
                                        .card {
                                            background: var(--card-bg);
                                            border: 1px solid var(--border);
                                            border-radius: 12px;
                                            padding: 40px;
                                            max-width: 400px;
                                            width: 90%;
                                            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                                            text-align: center;
                                            animation: fadeIn 0.5s ease-out;
                                        }
                                        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                                        h1 { color: var(--success); margin-top: 0; font-size: 24px; }
                                        p { line-height: 1.6; opacity: 0.9; }
                                        .icon { font-size: 48px; margin-bottom: 20px; }
                                        .status { 
                                            display: inline-block; 
                                            margin-top: 20px; 
                                            padding: 8px 16px; 
                                            background: rgba(63,185,80,0.1); 
                                            color: var(--success); 
                                            border-radius: 20px; 
                                            font-size: 0.9em; 
                                            font-weight: 600;
                                        }
                                    </style>
                                </head>
                                <body>
                                    <div class="card">
                                        <div class="icon">✅</div>
                                        <h1>Authentication Successful</h1>
                                        <p>Your Google account has been successfully linked with Antigravity Storage Manager.</p>
                                        <div class="status">You can close this window now</div>
                                        
                                        <div style="margin-top: 30px; display: flex; gap: 10px; justify-content: center;">
                                            <a href="https://www.patreon.com/unchase" target="_blank" style="text-decoration: none; padding: 8px 16px; background: rgba(255,255,255,0.05); border-radius: 6px; color: var(--fg); font-size: 12px; transition: 0.2s;">🧡 Support on Patreon</a>
                                            <a href="https://www.buymeacoffee.com/nikolaychebotov" target="_blank" style="text-decoration: none; padding: 8px 16px; background: rgba(255,255,255,0.05); border-radius: 6px; color: var(--fg); font-size: 12px; transition: 0.2s;">☕ Buy Me a Coffee</a>
                                            <a href="https://github.com/unchase/antigravity-storage-manager" target="_blank" style="text-decoration: none; padding: 8px 16px; background: rgba(255,255,255,0.05); border-radius: 6px; color: var(--fg); font-size: 12px; transition: 0.2s;">⭐ Star on GitHub</a>
                                        </div>

                                        <p style="font-size: 0.8em; opacity: 0.5; margin-top: 30px;">Redirecting back to VS Code...</p>
                                    </div>
                                    <script>setTimeout(() => window.close(), 5000);</script>
                                </body>
                                </html>
                            `);
                            this.closeServer();
                            resolve();
                        }
                    }
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Authentication failed');
                    this.closeServer();
                    reject(err);
                }
            });

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(lm.t('Port {0} is already in use. Please close any other authentication attempts.', REDIRECT_PORT)));
                } else {
                    reject(err);
                }
            });

            this.server.listen(REDIRECT_PORT, () => {
                // Generate the authorization URL
                const authUrl = this.oauth2Client.generateAuthUrl({
                    access_type: 'offline',
                    scope: SCOPES,
                    prompt: isAdd ? 'consent select_account' : 'consent' // Force consent to get refresh token, select_account if adding
                });

                // Open the browser for authentication
                vscode.env.openExternal(vscode.Uri.parse(authUrl));

                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: lm.t('Signing in to Google...'),
                    cancellable: true
                }, async (progress, token) => {
                    progress.report({ message: lm.t('Please authorize access in the browser window') });

                    // Wait for server to close (which happens on success or timeout)
                    return new Promise<void>((resolveProgress) => {
                        const checkInterval = setInterval(() => {
                            if (!this.server) {
                                clearInterval(checkInterval);
                                resolveProgress();
                            }
                        }, 1000);

                        token.onCancellationRequested(() => {
                            if (this.server) {
                                this.closeServer();
                                reject(new Error(lm.t('Authentication cancelled by user')));
                            }
                            clearInterval(checkInterval);
                            resolveProgress();
                        });
                    });
                });
            });

            // Timeout after 5 minutes
            setTimeout(() => {
                if (this.server) {
                    this.closeServer();
                    reject(new Error(lm.t('Authentication timed out')));
                }
            }, 5 * 60 * 1000);
        });
    }

    private async setCurrentAccount(accountId: string): Promise<void> {
        this.currentAccountId = accountId;
        await this.context.secrets.store(`${EXT_NAME}.google.currentAccountId`, accountId);
    }

    /**
     * Sign out active account
     */
    async signOut(): Promise<void> {
        if (this.currentAccountId) {
            await this.removeAccount(this.currentAccountId);
        } else {
            // Fallback classic signout
            this.tokens = null;
            this.oauth2Client.revokeCredentials().catch(() => { });
            await this.context.secrets.delete(`${EXT_NAME}.google.tokens`);
            this._onDidChangeSessions.fire();
        }
    }

    /**
     * Save tokens to secure storage (current account)
     */
    private async saveTokens(tokens: StoredTokens): Promise<void> {
        this.tokens = tokens;
        if (this.currentAccountId) {
            await this.saveTokensForAccount(this.currentAccountId, tokens);
        } else {
            // Fallback for before-migration or edge cases
            await this.context.secrets.store(
                `${EXT_NAME}.google.tokens`,
                JSON.stringify(tokens)
            );
        }
    }

    /**
     * Close the local callback server
     */
    private closeServer(): void {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    /**
     * Get user info for display
     */
    async getUserInfo(): Promise<{ email: string; name: string } | null> {
        if (!this.isAuthenticated()) {
            return null;
        }

        try {
            const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
            const { data } = await oauth2.userinfo.get();
            return {
                email: data.email || '',
                name: data.name || data.email || ''
            };
        } catch (error: any) {
            const lm = LocalizationManager.getInstance();
            vscode.window.showErrorMessage(lm.t('Failed to get user info: {0}', error.message));
            return null;
        }
    }
}
