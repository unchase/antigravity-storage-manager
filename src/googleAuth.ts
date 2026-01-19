import * as vscode from 'vscode';
import * as http from 'http';
import * as url from 'url';
import { google } from 'googleapis';

// OAuth2 Configuration
// 1. Create a project in Google Cloud Console
// 2. Enable Google Drive API
// 3. Create OAuth2 credentials (Desktop App type)
// 4. Enter Client ID and Secret in VS Code settings for this extension
const REDIRECT_PORT = 47842;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Scopes for Google Drive access
const SCOPES = [
    'https://www.googleapis.com/auth/drive.file' // Access only files created by this app
];

const EXT_NAME = 'antigravity-storage-manager';

interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    expiryDate: number;
}

/**
 * Manages Google OAuth2 authentication for the extension
 */
export class GoogleAuthProvider {
    private oauth2Client: InstanceType<typeof google.auth.OAuth2>;
    private context: vscode.ExtensionContext;
    private tokens: StoredTokens | null = null;
    private server: http.Server | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

        // Load credentials from configuration
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const clientId = config.get<string>('google.clientId');
        const clientSecret = config.get<string>('google.clientSecret');

        if (!clientId || !clientSecret || clientId.includes('YOUR_CLIENT_ID')) {
            vscode.window.showErrorMessage(
                'Google OAuth2 credentials are missing. Please set "antigravity-storage-manager.google.clientId" and "clientSecret" in VS Code settings.'
            );
            // Initialize with dummy values to prevent crash, checkAuth will fail gracefully
            this.oauth2Client = new google.auth.OAuth2('', '', REDIRECT_URI);
        } else {
            this.oauth2Client = new google.auth.OAuth2(
                clientId,
                clientSecret,
                REDIRECT_URI
            );
        }

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
     * Initialize the auth provider by loading stored tokens
     */
    async initialize(): Promise<void> {
        const storedTokens = await this.context.secrets.get(`${EXT_NAME}.google.tokens`);
        if (storedTokens) {
            try {
                this.tokens = JSON.parse(storedTokens);
                if (this.tokens) {
                    this.oauth2Client.setCredentials({
                        access_token: this.tokens.accessToken,
                        refresh_token: this.tokens.refreshToken,
                        expiry_date: this.tokens.expiryDate
                    });
                }
            } catch (e) {
                console.error('Failed to parse stored tokens:', e);
                this.tokens = null;
            }
        }
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
        } catch (error) {
            console.error('Failed to refresh token:', error);
            // Clear tokens on refresh failure
            await this.signOut();
            throw new Error('Session expired. Please sign in again.');
        }
    }

    /**
     * Start the OAuth2 sign-in flow
     */
    async signIn(): Promise<void> {
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
                                <html>
                                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                                    <h1>❌ Authentication Failed</h1>
                                    <p>Error: ${error}</p>
                                    <p>You can close this window.</p>
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

                            this.tokens = {
                                accessToken: tokens.access_token || '',
                                refreshToken: tokens.refresh_token || '',
                                expiryDate: tokens.expiry_date || 0
                            };
                            await this.saveTokens(this.tokens);

                            res.writeHead(200, { 'Content-Type': 'text/html' });
                            res.end(`
                                <html>
                                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                                    <h1>✅ Authentication Successful</h1>
                                    <p>You can close this window and return to VS Code.</p>
                                    <script>setTimeout(() => window.close(), 2000);</script>
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
                    reject(new Error(`Port ${REDIRECT_PORT} is already in use. Please close any other authentication attempts.`));
                } else {
                    reject(err);
                }
            });

            this.server.listen(REDIRECT_PORT, () => {
                // Generate the authorization URL
                const authUrl = this.oauth2Client.generateAuthUrl({
                    access_type: 'offline',
                    scope: SCOPES,
                    prompt: 'consent' // Force consent to get refresh token
                });

                // Open the browser for authentication
                vscode.env.openExternal(vscode.Uri.parse(authUrl));

                vscode.window.showInformationMessage(
                    'A browser window has opened for Google authentication. Please sign in and authorize access.'
                );
            });

            // Timeout after 5 minutes
            setTimeout(() => {
                if (this.server) {
                    this.closeServer();
                    reject(new Error('Authentication timed out'));
                }
            }, 5 * 60 * 1000);
        });
    }

    /**
     * Sign out and clear stored tokens
     */
    async signOut(): Promise<void> {
        this.tokens = null;
        this.oauth2Client.revokeCredentials().catch(() => { });
        await this.context.secrets.delete(`${EXT_NAME}.google.tokens`);
    }

    /**
     * Save tokens to secure storage
     */
    private async saveTokens(tokens: StoredTokens): Promise<void> {
        this.tokens = tokens;
        await this.context.secrets.store(
            `${EXT_NAME}.google.tokens`,
            JSON.stringify(tokens)
        );
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
        } catch (error) {
            console.error('Failed to get user info:', error);
            return null;
        }
    }
}
