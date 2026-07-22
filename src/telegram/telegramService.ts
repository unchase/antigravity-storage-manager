import * as https from 'https';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as os from 'os';
import { LocalizationManager } from '../l10n/localizationManager';

interface PendingLink {
    chatId: string;
    code: string;
    expiresAt: number;
}

export class TelegramService {
    private botToken: string | undefined;
    private userIds: string[] = [];
    private usernames: string[] = [];
    private usernameToChatId: Map<string, string> = new Map();
    // Pending username -> {chatId, one-time code} awaiting user confirmation in Telegram.
    // Prevents an attacker who sets their Telegram profile username to a configured
    // value from silently hijacking the authorized chatId mapping (CWE-287).
    private pendingLinks: Map<string, PendingLink> = new Map();
    private static readonly LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
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

    private generateLinkCode(): string {
        // 6-digit numeric code, generated with a CSPRNG.
        const n = crypto.randomInt(0, 1_000_000);
        return n.toString().padStart(6, '0');
    }

    /**
     * Initiate an out-of-band confirmation to link a Telegram chatId to a
     * configured username. The code is shown to the VS Code user (who controls
     * the extension host); the sender in Telegram must reply with the same code
     * to be authorized. This prevents a Telegram user who merely sets their
     * profile @username to a configured value from being silently trusted.
     */
    private beginUsernameLinkChallenge(username: string, chatId: string) {
        const existing = this.pendingLinks.get(username);
        if (existing && existing.chatId === chatId && existing.expiresAt > Date.now()) {
            // Re-send the same active challenge instead of issuing a new code.
            void this.sendMessage(chatId, this.formatChallengePrompt(username));
            return;
        }

        const code = this.generateLinkCode();
        this.pendingLinks.set(username, {
            chatId,
            code,
            expiresAt: Date.now() + TelegramService.LINK_CODE_TTL_MS
        });

        // Show the code to the VS Code user out-of-band.
        const lm = LocalizationManager.getInstance();
        void vscode.window.showInformationMessage(
            lm.t('Telegram link request from @{0} (Chat ID {1}). Confirmation code: {2}. Reply with this code in Telegram within 10 minutes to authorize.',
                username, chatId, code)
        );

        // Ask the sender in Telegram to reply with the code.
        void this.sendMessage(chatId, this.formatChallengePrompt(username));
    }

    private formatChallengePrompt(username: string): string {
        const lm = LocalizationManager.getInstance();
        return `🔐 ${lm.t('Confirmation required to link @{0}. Reply with the 6-digit code shown in VS Code within 10 minutes.', username)}`;
    }

    /**
     * If `text` looks like a confirmation code and matches a pending challenge
     * for `username`/`chatId`, complete the link. Returns true if the message
     * was consumed as a confirmation attempt.
     */
    private tryConsumeLinkConfirmation(username: string, chatId: string, text: string): boolean {
        const pending = this.pendingLinks.get(username);
        if (!pending) return false;

        const trimmed = text.trim();
        // Only intercept messages that look like a code (6 digits, optional leading /).
        if (!/^\/?\d{6}$/.test(trimmed)) return false;

        if (pending.expiresAt <= Date.now()) {
            this.pendingLinks.delete(username);
            void this.sendMessage(chatId, `⌛ ${LocalizationManager.getInstance().t('Confirmation code expired. Send any command to request a new code.')}`);
            return true;
        }

        const supplied = trimmed.replace(/^\//, '');
        // Constant-time compare to avoid trivial timing leak on the 6-digit code.
        const a = Buffer.from(supplied);
        const b = Buffer.from(pending.code);
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b) && pending.chatId === chatId;

        if (!ok) {
            void this.sendMessage(chatId, `❌ ${LocalizationManager.getInstance().t('Invalid confirmation code.')}`);
            return true;
        }

        this.pendingLinks.delete(username);
        this.usernameToChatId.set(username, chatId);
        this.saveUsernameMapping();
        void this.sendMessage(chatId, `✅ ${LocalizationManager.getInstance().t('Linked. You are now authorized.')}`);
        return true;
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

                                    // Check username match. The Telegram-supplied
                                    // `username` is attacker-controllable: any
                                    // Telegram account can set its profile
                                    // @username to a configured value once the
                                    // original owner changes theirs. We therefore
                                    // require an out-of-band confirmation code
                                    // (shown in VS Code) before persisting the
                                    // username -> chatId mapping or granting
                                    // authorization for this chat.
                                    if (!authorized && username && this.usernames.includes(username)) {
                                        const knownChatId = this.usernameToChatId.get(username);
                                        if (knownChatId === chatId) {
                                            // Previously confirmed link.
                                            authorized = true;
                                        } else {
                                            // Either the mapping is new or the
                                            // chatId claimed for this username
                                            // has changed. Never silently trust
                                            // or persist — require confirmation.
                                            const consumed = this.tryConsumeLinkConfirmation(username, chatId, update.message.text);
                                            if (!consumed) {
                                                this.beginUsernameLinkChallenge(username, chatId);
                                            }
                                            // Do not authorize this message.
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
