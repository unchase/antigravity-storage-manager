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
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 30000;

// Scopes for Google Drive access
const SCOPES = [
    DRIVE_FILE_SCOPE, // Access only files created by this app
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
];

const EXT_NAME = 'antigravity-storage-manager';

const PERMANENT_AUTH_ERRORS = new Set([
    'invalid_grant',
    'unauthorized_client',
    'invalid_client'
]);

export interface StoredTokens {
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
 * Escape text for safe interpolation into HTML.
 */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Constant-time string comparison for OAuth CSRF state validation.
 */
export function safeEqualString(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check whether an OAuth token refresh error indicates permanent session revocation
 * (as opposed to a transient network/server error).
 */
export function isPermanentAuthError(error: any): boolean {
    if (!error) return false;
    const responseError = error?.response?.data?.error;
    if (typeof responseError === 'string' && PERMANENT_AUTH_ERRORS.has(responseError)) {
        return true;
    }
    const msg = typeof error.message === 'string' ? error.message : '';
    for (const code of PERMANENT_AUTH_ERRORS) {
        if (msg.includes(code)) {
            return true;
        }
    }
    return false;
}

/**
 * Manages Google OAuth2 authentication for the extension
 */
export class GoogleAuthProvider implements vscode.Disposable {
    private oauth2Client!: InstanceType<typeof google.auth.OAuth2>;
    private context: vscode.ExtensionContext;
    private tokens: StoredTokens | null = null;
    private server: http.Server | null = null;
    private authTimeout: NodeJS.Timeout | null = null;
    private currentAccountId: string | null = null;
    private loadedClientId: string = '';
    private loadedClientSecret: string = '';
    private refreshPromise: Promise<void> | null = null;
    private _onDidChangeSessions = new vscode.EventEmitter<void>();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        if (typeof google?.options === 'function') {
            google.options({ timeout: API_TIMEOUT_MS });
        }
        this.loadCredentials(true);
    }

    dispose(): void {
        this.closeServer();
        this._onDidChangeSessions.dispose();
    }

    private attachTokenListener(client: InstanceType<typeof google.auth.OAuth2>): void {
        client.on('tokens', (tokens) => {
            const targetAccountId = this.currentAccountId;
            if (!targetAccountId) {
                return;
            }
            const current = this.tokens;
            const nextTokens: StoredTokens = {
                accessToken: tokens.access_token ?? current?.accessToken ?? '',
                refreshToken: tokens.refresh_token ?? current?.refreshToken ?? '',
                expiryDate: tokens.expiry_date ?? current?.expiryDate ?? 0
            };
            if (!nextTokens.refreshToken && !nextTokens.accessToken) {
                return;
            }
            this.tokens = nextTokens;
            this.saveTokensForAccount(targetAccountId, nextTokens).catch(err => {
                console.error('GoogleAuthProvider: Failed to persist refreshed tokens:', err);
            });
        });
    }

    /**
     * Load or reload credentials from configuration
     */
    public loadCredentials(force: boolean = false): void {
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const clientId = (config.get<string>('google.clientId') || '').trim();
        const clientSecret = (config.get<string>('google.clientSecret') || '').trim();

        if (!force && this.oauth2Client && clientId === this.loadedClientId && clientSecret === this.loadedClientSecret) {
            return;
        }

        this.loadedClientId = clientId;
        this.loadedClientSecret = clientSecret;

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

        this.attachTokenListener(this.oauth2Client);

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
                const legacyTokens = JSON.parse(legacyTokensStr) as StoredTokens;
                this.tokens = legacyTokens;
                this.oauth2Client.setCredentials({
                    access_token: legacyTokens.accessToken,
                    refresh_token: legacyTokens.refreshToken,
                    expiry_date: legacyTokens.expiryDate
                });

                let userInfo = await this.getUserInfo();
                if (!userInfo) {
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
        return crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
    }

    async getAccounts(): Promise<StoredAccount[]> {
        const accountsStr = await this.context.secrets.get(`${EXT_NAME}.google.accounts`);
        if (!accountsStr) {
            return [];
        }
        try {
            const parsed = JSON.parse(accountsStr);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            console.error('GoogleAuthProvider: Corrupted accounts JSON in SecretStorage:', err);
            return [];
        }
    }

    private async saveAccountList(accounts: StoredAccount[]): Promise<void> {
        await this.context.secrets.store(`${EXT_NAME}.google.accounts`, JSON.stringify(accounts));
    }

    private async saveTokensForAccount(accountId: string, tokens: StoredTokens): Promise<void> {
        await this.context.secrets.store(`${EXT_NAME}.google.tokens.${accountId}`, JSON.stringify(tokens));
    }

    private async loadTokensForAccount(accountId: string): Promise<StoredTokens | null> {
        const tokenStr = await this.context.secrets.get(`${EXT_NAME}.google.tokens.${accountId}`);
        if (!tokenStr) {
            return null;
        }
        try {
            const parsed = JSON.parse(tokenStr);
            if (!parsed || typeof parsed !== 'object') {
                return null;
            }
            return parsed as StoredTokens;
        } catch (err) {
            console.error(`GoogleAuthProvider: Corrupted tokens JSON for account ${accountId}:`, err);
            return null;
        }
    }

    /**
     * Switch active account
     */
    async switchAccount(accountId: string): Promise<void> {
        const accounts = await this.getAccounts();
        const account = accounts.find(a => a.id === accountId);
        if (!account) {
            throw new Error('Account not found');
        }

        await this.loadAccount(accountId);

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
            this.tokens = null;
            this.currentAccountId = null;
            this.oauth2Client.setCredentials({});
            await this.context.secrets.delete(`${EXT_NAME}.google.currentAccountId`);
        }
    }

    private async clearActiveSessionState(revoke: boolean = true): Promise<void> {
        const hadCredentials = this.tokens !== null;
        this.tokens = null;
        this.currentAccountId = null;
        if (revoke && hadCredentials && typeof this.oauth2Client.revokeCredentials === 'function') {
            this.oauth2Client.revokeCredentials().catch(() => { });
        }
        this.oauth2Client.setCredentials({});
        await this.context.secrets.delete(`${EXT_NAME}.google.currentAccountId`);
    }

    async removeAccount(accountId: string): Promise<void> {
        let accounts = await this.getAccounts();
        accounts = accounts.filter(a => a.id !== accountId);
        await this.saveAccountList(accounts);
        await this.context.secrets.delete(`${EXT_NAME}.google.tokens.${accountId}`);

        if (this.currentAccountId === accountId) {
            if (accounts.length > 0) {
                // switchAccount already fires _onDidChangeSessions once
                await this.switchAccount(accounts[0].id);
                return;
            }
            // Directly clear active session without recursing into signOut()
            await this.clearActiveSessionState(true);
            await this.context.secrets.delete(`${EXT_NAME}.google.tokens`);
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
        if (this.tokens && (!this.oauth2Client.credentials || !this.oauth2Client.credentials.refresh_token)) {
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

        // Refresh if expiryDate is missing/0, expired, or expiring within 60s
        const now = Date.now();
        if (!this.tokens.expiryDate || this.tokens.expiryDate < now + 60000) {
            await this.refreshToken();
        }

        return this.tokens?.accessToken || null;
    }

    /**
     * Refresh the access token using the refresh token (single-flight)
     */
    async refreshToken(): Promise<void> {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        const task = this.doRefreshToken();
        this.refreshPromise = task;
        try {
            await task;
        } finally {
            if (this.refreshPromise === task) {
                this.refreshPromise = null;
            }
        }
    }

    private async doRefreshToken(): Promise<void> {
        // Reload credentials only if settings changed
        this.loadCredentials();

        if (!this.tokens?.refreshToken) {
            throw new Error('No refresh token available');
        }

        const targetAccountId = this.currentAccountId;

        try {
            const { credentials } = await this.oauth2Client.refreshAccessToken();
            const updated: StoredTokens = {
                accessToken: credentials.access_token ?? this.tokens.accessToken,
                refreshToken: credentials.refresh_token ?? this.tokens.refreshToken,
                expiryDate: credentials.expiry_date ?? this.tokens.expiryDate
            };
            this.tokens = updated;
            if (targetAccountId) {
                await this.saveTokensForAccount(targetAccountId, updated);
            } else {
                await this.saveTokens(updated);
            }
        } catch (error: any) {
            const lm = LocalizationManager.getInstance();

            if (isPermanentAuthError(error)) {
                console.warn(lm.t('GoogleAuthProvider: Invalid grant detected. Signing out.'));

                // Invalidate only the revoked account's session; never silently switch to another account
                if (targetAccountId) {
                    await this.context.secrets.delete(`${EXT_NAME}.google.tokens.${targetAccountId}`);
                }
                await this.clearActiveSessionState(false);
                this._onDidChangeSessions.fire();

                const signIn = lm.t('Sign In');
                const selection = await vscode.window.showWarningMessage(
                    lm.t('Google Drive session expired. Please sign in again.'),
                    signIn
                );

                if (selection === signIn) {
                    this.signIn().catch(err => console.error('GoogleAuthProvider: Re-sign-in failed:', err));
                }
                throw new Error(lm.t('Session expired. Please sign in again.'));
            }

            // Transient network/server error — preserve stored tokens and propagate error
            console.warn('GoogleAuthProvider: Transient error refreshing token (keeping session):', error?.message);
            throw error;
        }
    }

    /**
     * Start the OAuth2 sign-in flow
     */
    async signIn(): Promise<void> {
        await this.startAuthFlow(false);
    }

    /**
     * Add a new account (same as sign in, but appends)
     */
    async addAccount(): Promise<void> {
        await this.startAuthFlow(true);
    }

    private async startAuthFlow(isAdd: boolean = false): Promise<void> {
        const lm = LocalizationManager.getInstance();
        this.loadCredentials();

        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const clientId = (config.get<string>('google.clientId') || '').trim();
        const clientSecret = (config.get<string>('google.clientSecret') || '').trim();

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

        // Close any leftover callback server before starting a new flow
        this.closeServer();

        // Generate CSRF state and PKCE verifier/challenge
        const expectedState = crypto.randomBytes(32).toString('hex');
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

        // Use an isolated temporary OAuth2 client so an aborted/failed flow never corrupts the active session
        const tempOAuth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

        return new Promise((resolve, reject) => {
            let settled = false;
            const settleResolve = () => {
                if (!settled) {
                    settled = true;
                    this.closeServer();
                    resolve();
                }
            };
            const settleReject = (err: Error) => {
                if (!settled) {
                    settled = true;
                    this.closeServer();
                    reject(err);
                }
            };

            this.server = http.createServer(async (req, res) => {
                try {
                    const parsedUrl = url.parse(req.url || '', true);

                    if (parsedUrl.pathname !== '/callback') {
                        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('Not Found');
                        return;
                    }

                    const returnedState = typeof parsedUrl.query.state === 'string' ? parsedUrl.query.state : '';
                    if (!returnedState || !safeEqualString(returnedState, expectedState)) {
                        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('Invalid OAuth state parameter');
                        return;
                    }

                    const code = typeof parsedUrl.query.code === 'string' ? parsedUrl.query.code : '';
                    const error = typeof parsedUrl.query.error === 'string' ? parsedUrl.query.error : '';

                    if (error) {
                        let hint = '';
                        let vscodeHint = '';
                        if (error === 'access_denied') {
                            hint = '<p style="text-align:left;font-size:0.85em;opacity:0.85;margin-top:20px;"><strong>Troubleshooting:</strong><br>• Make sure you click <strong>"Allow"</strong> on the Google consent screen.<br>• The extension requires the <em>"See, edit, create, and delete only the specific Google Drive files you use with this app"</em> permission.<br>• If your Google account is managed by an organization, your admin may need to approve this app.</p>';
                            vscodeHint = lm.t('You must grant the Google Drive file access permission. Please try again and click "Allow" on the consent screen.');
                        } else if (error === 'invalid_client') {
                            hint = '<p style="text-align:left;font-size:0.85em;opacity:0.85;margin-top:20px;"><strong>Troubleshooting:</strong><br>• Check your <strong>Client ID</strong> and <strong>Client Secret</strong> in VS Code Settings → Antigravity Storage Manager.<br>• Ensure the OAuth credentials are for a <em>Desktop App</em> type in Google Cloud Console.<br>• Verify the Google Drive API is enabled in your Google Cloud project.</p>';
                            vscodeHint = lm.t('Invalid OAuth credentials. Please verify your Client ID and Client Secret in Settings.');
                        } else if (error === 'redirect_uri_mismatch') {
                            hint = `<p style="text-align:left;font-size:0.85em;opacity:0.85;margin-top:20px;"><strong>Troubleshooting:</strong><br>• In Google Cloud Console → Credentials, add <code>http://localhost:${REDIRECT_PORT}/callback</code> as an Authorized redirect URI.<br>• Make sure the OAuth credential type is <em>Desktop App</em>.</p>`;
                            vscodeHint = lm.t('Redirect URI mismatch. Please add http://localhost:{0}/callback to your OAuth credentials in Google Cloud Console.', REDIRECT_PORT);
                        } else {
                            hint = '<p style="text-align:left;font-size:0.85em;opacity:0.85;margin-top:20px;"><strong>Troubleshooting:</strong><br>• Remove and re-add your account in VS Code.<br>• Check the <a href="https://github.com/unchase/antigravity-storage-manager/blob/master/SYNC_SETUP.md" style="color:#58a6ff;">Sync Setup Guide</a> for detailed instructions.</p>';
                            vscodeHint = lm.t('Authentication error: {0}. Please check the Sync Setup Guide for help.', error);
                        }

                        const safeErrorHtml = escapeHtml(error);
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
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
                                            max-width: 480px;
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
                                        a { color: #58a6ff; }
                                        code { background: rgba(110,118,129,0.2); padding: 2px 6px; border-radius: 3px; font-size: 0.85em; }
                                    </style>
                                </head>
                                <body>
                                    <div class="card">
                                        <div class="icon">❌</div>
                                        <h1>Authentication Failed</h1>
                                        <p>Something went wrong during the sign-in process.</p>
                                        <p><span class="error-code">${safeErrorHtml}</span></p>
                                        ${hint}
                                        <p style="font-size: 0.9em; opacity: 0.6; margin-top: 20px;">You can close this window and try again from VS Code.</p>
                                    </div>
                                </body>
                                </html>
                            `);

                        const setupGuide = lm.t('Open Setup Guide');
                        const retryAction = lm.t('Retry');
                        vscode.window.showErrorMessage(
                            vscodeHint || lm.t('Authentication failed: {0}', error),
                            setupGuide,
                            retryAction
                        ).then(selection => {
                            if (selection === setupGuide) {
                                vscode.env.openExternal(vscode.Uri.parse('https://github.com/unchase/antigravity-storage-manager/blob/master/SYNC_SETUP.md'));
                            } else if (selection === retryAction) {
                                this.signIn().catch(err => console.error('GoogleAuthProvider: Retry sign-in failed:', err));
                            }
                        });

                        settleReject(new Error(`OAuth error: ${error}`));
                        return;
                    }

                    if (!code) {
                        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('Missing authorization code');
                        return;
                    }

                    // Exchange code for tokens using the isolated temp client + PKCE verifier
                    const { tokens } = await tempOAuth2Client.getToken({ code, codeVerifier });
                    tempOAuth2Client.setCredentials(tokens);
                    console.log('Scopes granted:', tokens.scope);

                    // Verify exact drive.file scope
                    if (tokens.scope) {
                        const grantedScopes = tokens.scope.split(/\s+/).filter(Boolean);
                        if (!grantedScopes.includes(DRIVE_FILE_SCOPE)) {
                            throw new Error(lm.t('You must grant the "See, edit, create, and delete only the specific Google Drive files you use with this app" permission to use this extension.'));
                        }
                    }

                    // Fetch User Info with the temporary client before touching active session
                    const oauth2 = google.oauth2({ version: 'v2', auth: tempOAuth2Client });
                    const { data: userData } = await oauth2.userinfo.get();
                    const userEmail = (userData.email || '').trim();
                    if (!userEmail) {
                        throw new Error('Failed to retrieve user info');
                    }
                    const userInfo = {
                        email: userEmail,
                        name: userData.name || userEmail
                    };

                    const accountId = this.generateAccountId(userInfo.email);
                    const previousTokens = await this.loadTokensForAccount(accountId);
                    const effectiveRefreshToken = tokens.refresh_token || previousTokens?.refreshToken || '';
                    if (!effectiveRefreshToken) {
                        throw new Error('Google did not return a refresh token. Please revoke app access in your Google Account and try signing in again.');
                    }

                    const newTokens: StoredTokens = {
                        accessToken: tokens.access_token || '',
                        refreshToken: effectiveRefreshToken,
                        expiryDate: tokens.expiry_date || 0
                    };

                    const newAccount: StoredAccount = {
                        id: accountId,
                        email: userInfo.email,
                        name: userInfo.name,
                        lastActive: Date.now()
                    };

                    // Persist account and tokens, then commit to live OAuth2 client
                    const existingAccounts = await this.getAccounts();
                    const existingIdx = existingAccounts.findIndex(a => a.id === accountId);
                    if (existingIdx >= 0) {
                        existingAccounts[existingIdx] = newAccount;
                    } else {
                        existingAccounts.push(newAccount);
                    }
                    await this.saveAccountList(existingAccounts);
                    await this.saveTokensForAccount(accountId, newTokens);
                    await this.setCurrentAccount(accountId);

                    this.tokens = newTokens;
                    this.oauth2Client.setCredentials({
                        access_token: newTokens.accessToken,
                        refresh_token: newTokens.refreshToken,
                        expiry_date: newTokens.expiryDate
                    });

                    this._onDidChangeSessions.fire();

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
                    settleResolve();
                } catch (err: any) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Authentication failed');
                    settleReject(err instanceof Error ? err : new Error(String(err)));
                }
            });

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    settleReject(new Error(lm.t('Port {0} is already in use. Please close any other authentication attempts.', REDIRECT_PORT)));
                } else {
                    settleReject(err);
                }
            });

            this.server.listen(REDIRECT_PORT, '127.0.0.1', () => {
                const authUrl = tempOAuth2Client.generateAuthUrl({
                    access_type: 'offline',
                    scope: SCOPES,
                    prompt: isAdd ? 'consent select_account' : 'consent',
                    state: expectedState,
                    code_challenge: codeChallenge,
                    code_challenge_method: 'S256' as any
                });

                vscode.env.openExternal(vscode.Uri.parse(authUrl));

                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: lm.t('Signing in to Google...'),
                    cancellable: true
                }, async (progress, token) => {
                    progress.report({ message: lm.t('Please authorize access in the browser window') });

                    return new Promise<void>((resolveProgress) => {
                        const checkInterval = setInterval(() => {
                            if (!this.server || settled) {
                                clearInterval(checkInterval);
                                resolveProgress();
                            }
                        }, 500);

                        token.onCancellationRequested(() => {
                            clearInterval(checkInterval);
                            if (!settled) {
                                settleReject(new Error(lm.t('Authentication cancelled by user')));
                            }
                            resolveProgress();
                        });
                    });
                });
            });

            this.authTimeout = setTimeout(() => {
                if (!settled) {
                    settleReject(new Error(lm.t('Authentication timed out')));
                }
            }, AUTH_TIMEOUT_MS);
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
            await this.clearActiveSessionState(true);
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
            await this.context.secrets.store(
                `${EXT_NAME}.google.tokens`,
                JSON.stringify(tokens)
            );
        }
    }

    /**
     * Close the local callback server and clear pending auth timeout
     */
    private closeServer(): void {
        if (this.authTimeout) {
            clearTimeout(this.authTimeout);
            this.authTimeout = null;
        }
        if (this.server) {
            const srv = this.server;
            this.server = null;
            try {
                srv.close();
                if (typeof (srv as any).closeAllConnections === 'function') {
                    (srv as any).closeAllConnections();
                }
            } catch { /* ignore */ }
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
