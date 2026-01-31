import * as https from 'https';
import * as vscode from 'vscode';
import * as os from 'os';
import { LocalizationManager } from '../l10n/localizationManager';

export class TelegramService {
    private botToken: string | undefined;
    private userIds: string[] = [];
    private usernames: string[] = [];
    private usernameToChatId: Map<string, string> = new Map();
    private configChangeListener: vscode.Disposable;
    private pollingTimeout: NodeJS.Timeout | undefined;
    private lastUpdateId: number = 0;
    private _onDidReceiveMessage = new vscode.EventEmitter<{ chatId: string, text: string, username?: string, authorized: boolean }>();
    public readonly onDidReceiveMessage = this._onDidReceiveMessage.event;
    private isPolling: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        // Load persisted username mapping
        const persistedMap = this.context.globalState.get<{ [key: string]: string }>('telegram.usernameToChatId', {});
        this.usernameToChatId = new Map(Object.entries(persistedMap));

        this.updateConfig();
        this.configChangeListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-storage-manager.telegram')) {
                const wasPolling = this.isPolling;
                this.stopPolling();
                this.updateConfig();
                if (wasPolling) {
                    this.startPolling();
                }
            }
        });
        this.startPolling();
    }

    private updateConfig() {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const oldToken = this.botToken;
        this.botToken = config.get<string>('telegram.botToken');
        this.userIds = config.get<string[]>('telegram.userIds') || [];
        this.usernames = config.get<string[]>('telegram.usernames') || [];

        // Filter out empty strings
        this.userIds = this.userIds.filter(id => id && id.trim().length > 0);
        this.usernames = this.usernames.filter(u => u && u.trim().length > 0);

        // Restart polling if token changed
        if (oldToken !== this.botToken && this.isPolling) {
            this.stopPolling();
            this.startPolling();
        }
    }

    public isConfigured(): boolean {
        return !!this.botToken;
    }

    public startPolling() {
        if (this.isPolling || !this.botToken) return;
        this.isPolling = true;
        this.poll();
    }

    public stopPolling() {
        this.isPolling = false;
        if (this.pollingTimeout) {
            clearTimeout(this.pollingTimeout);
            this.pollingTimeout = undefined;
        }
    }

    private saveUsernameMapping() {
        const obj = Object.fromEntries(this.usernameToChatId);
        this.context.globalState.update('telegram.usernameToChatId', obj);
    }

    private poll() {
        if (!this.isPolling || !this.botToken) return;

        const data = JSON.stringify({
            offset: this.lastUpdateId + 1,
            timeout: 30 // Long polling timeout
        });

        const options: https.RequestOptions = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${this.botToken}/getUpdates`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (!this.isPolling) return;

                if (res.statusCode === 200) {
                    try {
                        const result = JSON.parse(body);
                        if (result.ok && Array.isArray(result.result)) {
                            for (const update of result.result) {
                                this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
                                if (update.message && update.message.text) {
                                    const chatId = String(update.message.chat.id);
                                    const username = update.message.from?.username;

                                    let authorized = false;

                                    // Check explicit ID match
                                    if (this.userIds.includes(chatId)) {
                                        authorized = true;
                                    }

                                    // Check username match
                                    if (!authorized && username && this.usernames.includes(username)) {
                                        authorized = true;
                                        // Store mapping if new or changed
                                        if (this.usernameToChatId.get(username) !== chatId) {
                                            this.usernameToChatId.set(username, chatId);
                                            this.saveUsernameMapping();
                                            // console.log(`[Telegram] Linked @${username} to ChatID ${chatId}`);
                                        }
                                    }

                                    if (authorized) {
                                        this._onDidReceiveMessage.fire({
                                            chatId,
                                            text: update.message.text,
                                            username: username,
                                            authorized: true
                                        });
                                    } else {
                                        // For unauthorized users, we still fire the event but mark as unauthorized.
                                        // The controller will decide whether to reply.
                                        // Only fire for commands to avoid spam from random messages
                                        if (update.message.text.startsWith('/')) {
                                            this._onDidReceiveMessage.fire({
                                                chatId,
                                                text: update.message.text,
                                                username: username,
                                                authorized: false
                                            });
                                        }
                                        console.log(`[Telegram] Unauthorized command from: ${chatId} (@${username})`);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse Telegram updates:', e);
                    }
                }

                // Schedule next poll immediately
                this.pollingTimeout = setTimeout(() => this.poll(), 100);
            });
        });

        req.on('error', (error) => {
            console.error('Telegram polling error:', error);
            // Retry after delay
            this.pollingTimeout = setTimeout(() => this.poll(), 5000);
        });

        req.write(data);
        req.end();
    }

    public async sendBroadcast(message: string): Promise<void> {
        if (!this.isConfigured()) {
            return; // Silent fail if not configured
        }

        const machineName = vscode.workspace.getConfiguration('antigravity-storage-manager').get<string>('sync.machineName') || os.hostname();
        const lm = LocalizationManager.getInstance();
        const fullMessage = `📢 *${lm.t('Antigravity Notification')}* [${machineName}]\n\n${message}`;

        // Collect all target Chat IDs
        const targets = new Set<string>(this.userIds);

        // Add Chat IDs resolved from usernames
        for (const username of this.usernames) {
            const chatId = this.usernameToChatId.get(username);
            if (chatId) {
                targets.add(chatId);
            } else {
                // Warning: Cannot send to username without Chat ID (needs interaction first)
                // console.warn(`[Telegram] Cannot broadcast to @${username} - no Chat ID known yet.`);
            }
        }

        await Promise.allSettled(Array.from(targets).map(id => this.sendMessage(id, fullMessage)));
    }

    public sendMessage(chatId: string, message: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.botToken) return reject(new Error('No bot token'));

            const data = JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown'
            });

            const options: https.RequestOptions = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${this.botToken}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = https.request(options, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        console.error(`Telegram API Call Failed: ${res.statusCode} ${body}`);
                        reject(new Error(`Telegram API Error: ${res.statusCode}`));
                    });
                }
            });

            req.on('error', (error) => {
                console.error('Telegram Network Error:', error);
                reject(error);
            });

            req.write(data);
            req.end();
        });
    }

    public dispose() {
        this.stopPolling();
        this.configChangeListener.dispose();
        this._onDidReceiveMessage.dispose();
    }
}
