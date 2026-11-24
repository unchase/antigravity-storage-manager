
import * as vscode from 'vscode';
import { ProcessPortDetector } from './processPortDetector';
import { QuotaService, fetchQuotaViaAgyCli } from './quotaService';
import { QuotaSnapshot, ModelQuotaInfo } from './types';
import { versionInfo } from './versionInfo';
import { LocalizationManager } from '../l10n/localizationManager';

import { QuotaStatusBar } from './quotaStatusBar';
import { drawProgressBar, formatResetTime, compareModels, formatDuration, isGeminiModel } from './utils';
import { QuotaUsageTracker } from './quotaUsageTracker';
import { AccountInfoWebview } from './accountInfoWebview';
import { GoogleAuthProvider } from '../googleAuth';

import { TelegramService } from '../telegram/telegramService';
import { ProfileManager } from '../profileManager';

export class QuotaManager {
    private context: vscode.ExtensionContext;
    private portDetector: ProcessPortDetector;
    private quotaService: QuotaService | null = null;
    private statusBar: QuotaStatusBar;
    private usageTracker: QuotaUsageTracker;
    private authProvider: GoogleAuthProvider; // New dependency
    private profileManager: ProfileManager | null = null;
    private isEnabled: boolean = true;
    private pollingTimer: NodeJS.Timeout | undefined;
    private readonly POLLING_INTERVAL = 60 * 1000; // 1 minute
    private sortMethod: 'quota' | 'time' = 'quota';
    private lastNotifiedModels: Map<string, boolean> = new Map(); // modelId -> wasExhausted
    private syncManager: any | null = null; // SyncManager type to be imported or use any to avoid cycle if needed. Ideally interface.
    private preferCliFallback: boolean = false;
    private cliFallbackCycles: number = 0;

    constructor(context: vscode.ExtensionContext, authProvider: GoogleAuthProvider, telegramService: TelegramService) {
        this.context = context;
        this.authProvider = authProvider;
        this.portDetector = new ProcessPortDetector();
        this.statusBar = new QuotaStatusBar();
        this.usageTracker = new QuotaUsageTracker(context, telegramService);
        versionInfo.initialize(context);

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-storage-manager.enableQuota')) {
                this.updateEnabledState();
            } else if (e.affectsConfiguration('antigravity-storage-manager.quota.pinnedModels')) {
                // Refresh status bar on pin change if we have data
                const snapshot = this.statusBar.getLatestSnapshot();
                if (snapshot) {
                    this.statusBar.update(snapshot);
                    this.updateWebview(snapshot);
                }
            }
        });

        // Listen for auth changes
        this.authProvider.onDidChangeSessions(() => {
            // Refresh data on account switch
            this.fetchAndUpdate(true);
        });

        this.updateEnabledState();
    }

    public setSyncManager(syncManager: any) {
        this.syncManager = syncManager;
    }

    public setProfileManager(profileManager: ProfileManager) {
        this.profileManager = profileManager;
    }

    public getProfileManager(): ProfileManager | null {
        return this.profileManager;
    }

    private updateEnabledState() {
        this.isEnabled = vscode.workspace.getConfiguration('antigravity-storage-manager').get('enableQuota', true);
        if (this.isEnabled) {
            this.startPolling();
        } else {
            this.stopPolling();
            this.statusBar.hide();
        }
    }

    private startPolling() {
        if (this.pollingTimer) {
            return;
        }

        // Initial fetch
        this.fetchAndUpdate(true);

        this.pollingTimer = setInterval(() => {
            this.fetchAndUpdate(false);
        }, this.POLLING_INTERVAL);
    }

    private stopPolling() {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
        }
    }

    public async refresh(): Promise<void> {
        this.preferCliFallback = false;
        this.cliFallbackCycles = 0;
        await this.fetchAndUpdate(true);
    }

    private async updateWebview(snapshot: QuotaSnapshot) {
        const accounts = await this.authProvider.getAccounts();
        const currentAccountId = this.authProvider.getCurrentAccountId();
        AccountInfoWebview.update(snapshot, this.usageTracker, accounts, currentAccountId);
    }

    private async fetchAndUpdate(isInitial: boolean = false): Promise<QuotaSnapshot | null> {
        if (!this.isEnabled) return null;

        if (isInitial) {
            this.statusBar.showLoading();
        }

        try {
            const snapshot = await this.getQuota();

            // Fetch sync stats if available
            if (this.syncManager) {
                try {
                    const syncStats = await this.syncManager.getSyncUsageStats();
                    snapshot.syncStats = syncStats;
                } catch (e) {
                    console.error('Failed to get sync stats:', e);
                }
            }

            this.usageTracker.track(snapshot);
            this.checkAndNotifyResets(snapshot);
            this.statusBar.update(snapshot, undefined, this.usageTracker);

            await this.updateWebview(snapshot);

            // Update Profile Quota Cache
            if (this.profileManager && this.profileManager.activeProfile) {
                this.profileManager.updateProfileQuota(this.profileManager.activeProfile, snapshot).catch(err => {
                    console.warn('Failed to update profile quota cache:', err);
                });
            }

            return snapshot;
        } catch (error: any) {
            const msg = error?.message || String(error);
            console.error('QuotaManager error:', msg);

            if (isInitial) {
                let userMsg = 'Fetch failed';
                if (msg.includes('Antigravity Language Server not found')) {
                    userMsg = 'Antigravity not found';
                } else if (msg.includes('ECONNREFUSED')) {
                    userMsg = 'Connection refused';
                } else if (msg.includes('HTTP error')) {
                    userMsg = 'Server error';
                } else if (msg.includes('timeout')) {
                    userMsg = 'Timeout';
                }
                this.statusBar.showError(userMsg);
            }
            return null;
        }
    }

    public async showQuota(): Promise<void> {
        if (!this.isEnabled) {
            const lm = LocalizationManager.getInstance();
            vscode.window.showInformationMessage(lm.t('Quota feature is disabled in settings.'));
            return;
        }

        let snapshot = this.statusBar.getLatestSnapshot();

        // If no data yet, fetch with progress
        if (!snapshot) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: LocalizationManager.getInstance().t('Fetching Antigravity quota...'),
                cancellable: false
            }, async () => {
                snapshot = await this.fetchAndUpdate(true) || undefined;
            });
        }

        if (snapshot) {
            await this.displayQuota(snapshot);
        }
    }

    public async showAccountData(): Promise<void> {
        if (!this.isEnabled) {
            const lm = LocalizationManager.getInstance();
            vscode.window.showInformationMessage(lm.t('Quota feature is disabled in settings.'));
            return;
        }

        let snapshot = this.statusBar.getLatestSnapshot();
        if (!snapshot) {
            snapshot = await this.fetchAndUpdate(true) || undefined;
        }

        if (snapshot) {
            const accounts = await this.authProvider.getAccounts();
            const currentAccountId = this.authProvider.getCurrentAccountId();
            AccountInfoWebview.show(this.context, snapshot, this.usageTracker, accounts, currentAccountId, async () => {
                await this.refresh();
            });
        } else {
            const lm = LocalizationManager.getInstance();
            vscode.window.showErrorMessage(lm.t('No account data available.'));
        }
    }

    public getLatestSnapshot(): QuotaSnapshot | undefined {
        return this.statusBar.getLatestSnapshot();
    }

    public getUsageTracker(): QuotaUsageTracker {
        return this.usageTracker;
    }

    public async getProfileQuotas(): Promise<{ profileName: string; email?: string; snapshot: QuotaSnapshot }[]> {
        if (!this.profileManager) return [];
        const profiles = await this.profileManager.loadProfiles();
        const results: { profileName: string; email?: string; snapshot: QuotaSnapshot }[] = [];
        const activeProfile = this.profileManager.activeProfile;

        for (const p of profiles) {
            // Skip the active profile since its current quota is typically fetched live
            if (p.name === activeProfile) continue;

            if (p.quotaCache && p.quotaCache.models && p.quotaCache.models.length > 0) {
                results.push({
                    profileName: p.name,
                    email: p.antigravityEmail,
                    snapshot: {
                        timestamp: new Date(p.quotaCache.timestamp),
                        models: p.quotaCache.models as any[],
                        userEmail: p.antigravityEmail,
                        planName: undefined
                    }
                });
            }
        }
        return results;
    }

    public async getQuota(): Promise<QuotaSnapshot> {
        const shouldProbeLocalServer = !this.preferCliFallback || this.cliFallbackCycles >= 10;
        let localServerError: unknown = null;

        if (shouldProbeLocalServer) {
            this.cliFallbackCycles = 0;
            // 1. Try local language_server / env endpoint silently first
            const processInfo = await this.portDetector.detectProcessInfo(1, 1000, true);
            if (processInfo) {
                try {
                    this.quotaService = new QuotaService(processInfo.connectPort, processInfo.csrfToken, processInfo.extensionPort, processInfo.protocol);
                    const snapshot = await this.quotaService.fetchQuota();
                    this.preferCliFallback = false;
                    return snapshot;
                } catch (err) {
                    localServerError = err;
                    console.warn('QuotaManager', 'Local language server fetch failed, trying agy CLI /usage fallback:', err);
                }
            }
        } else {
            this.cliFallbackCycles++;
        }

        // 2. Fallback to official Antigravity CLI (`agy -p /usage --output-format json`)
        try {
            let fallbackEmail: string | undefined;
            if (this.profileManager && this.profileManager.activeProfile) {
                const profiles = await this.profileManager.loadProfiles();
                const active = profiles.find(p => p.name === this.profileManager?.activeProfile);
                fallbackEmail = active?.antigravityEmail;
            }
            const cliSnapshot = await fetchQuotaViaAgyCli(
                fallbackEmail ? { timestamp: new Date(), models: [], userEmail: fallbackEmail } : undefined
            );
            this.preferCliFallback = true;
            return cliSnapshot;
        } catch (cliError: any) {
            const cliMsg = cliError?.message || String(cliError);
            console.warn('QuotaManager', `agy CLI /usage fallback failed: ${cliMsg}`);
            if (localServerError instanceof Error) {
                throw localServerError;
            }
            throw new Error(`Antigravity Language Server not found and agy CLI fallback failed (${cliMsg}). Please ensure Antigravity is installed and running.`);
        }
    }

    private async checkAndNotifyResets(snapshot: QuotaSnapshot) {
        if (!snapshot.models) return;

        for (const model of snapshot.models) {
            if (model.isDisabled) continue;
            const wasExhausted = this.lastNotifiedModels.get(model.modelId) ?? false;
            const isExhausted = model.isExhausted || (model.remainingPercentage !== undefined && model.remainingPercentage < 5);

            // If it was exhausted and now is NOT exhausted (and has reasonable quota), notify
            if (wasExhausted && !isExhausted && (model.remainingPercentage === undefined || model.remainingPercentage > 20)) {
                const lm = LocalizationManager.getInstance();
                vscode.window.showInformationMessage(lm.t('Antigravity Quota: Limit for {0} has been reset!', model.label));
            }

            this.lastNotifiedModels.set(model.modelId, isExhausted);
        }
    }

    private async displayQuota(snapshot: QuotaSnapshot): Promise<void> {
        const lm = LocalizationManager.getInstance();
        interface QuotaQuickPickItem extends vscode.QuickPickItem {
            model?: ModelQuotaInfo;
            infoTooltip?: string;
            isPlanItem?: boolean;
        }
        const picker = vscode.window.createQuickPick<QuotaQuickPickItem>();
        picker.title = LocalizationManager.getInstance().t('Antigravity Quota Usage');
        picker.placeholder = LocalizationManager.getInstance().t('Click a model to pin/unpin it from status bar');
        picker.matchOnDetail = true;

        const updateSortButton = () => {
            const sortText = this.sortMethod === 'quota' ? lm.t('Sort by Reset Time') : lm.t('Sort by Quota Remaining');
            picker.buttons = [
                {
                    iconPath: new vscode.ThemeIcon('heart'),
                    tooltip: lm.t('Support on Patreon')
                },
                {
                    iconPath: new vscode.ThemeIcon('coffee'),
                    tooltip: lm.t('Buy Me a Coffee')
                },
                {
                    iconPath: new vscode.ThemeIcon('star'),
                    tooltip: lm.t('Star on GitHub')
                },
                {
                    iconPath: new vscode.ThemeIcon(this.sortMethod === 'quota' ? 'list-ordered' : 'clock'),
                    tooltip: `${lm.t('Sort')}: ${sortText}`
                }
            ];
        };

        const updateItems = () => {
            const items: QuotaQuickPickItem[] = [];

            if (this.statusBar) {
                this.statusBar.update(snapshot, undefined, this.usageTracker);
            }

            // Plan Info
            if (snapshot.planName) {
                items.push({
                    label: `$(star) ${lm.t('Plan')}: ${snapshot.planName}`,
                    // kind: vscode.QuickPickItemKind.Separator // Separators don't support icons
                    alwaysShow: true,
                    description: lm.t('Current Subscription'),
                    isPlanItem: true
                });
            }

            // Prompt Credits
            if (snapshot.promptCredits && vscode.workspace.getConfiguration('antigravity-storage-manager').get('showCreditsBalance', false)) {
                const credits = snapshot.promptCredits;
                const percent = credits.remainingPercentage.toFixed(1);
                items.push({
                    label: `$(graph) ${lm.t('Credits')}: ${credits.available} / ${credits.monthly}`,
                    description: `${percent}% ${lm.t('available')}`,
                    detail: lm.t('Monthly Usage Limit'),
                    alwaysShow: true
                });
            }

            // Models
            if (snapshot.models && snapshot.models.length > 0) {
                const models = [...snapshot.models];
                const pinned = this.statusBar.getPinnedModels();

                const groups = [
                    { name: 'Claude & GPT-OSS', models: [] as ModelQuotaInfo[] },
                    { name: 'Gemini', models: [] as ModelQuotaInfo[] }
                ];

                for (const m of models) {
                    if (isGeminiModel(m.label, m.modelId)) {
                        groups[1].models.push(m);
                    } else {
                        groups[0].models.push(m);
                    }
                }

                const buildInfoTooltip = (model: ModelQuotaInfo): string | undefined => {
                    const parts: string[] = [];
                    if (model.isDisabled) {
                        parts.push(model.disabledReason || model.tagDescription || lm.t('This model is currently unavailable.'));
                        if (model.tagTitle && model.tagDescription && model.disabledReason && model.disabledReason !== model.tagDescription) {
                            parts.push(`${model.tagTitle}: ${model.tagDescription}`);
                        }
                    } else if (model.tagDescription) {
                        parts.push(model.tagTitle ? `${model.tagTitle}: ${model.tagDescription}` : model.tagDescription);
                    }
                    return parts.length > 0 ? parts.join(' • ') : undefined;
                };

                const addGroup = (groupName: string, groupModels: ModelQuotaInfo[]) => {
                    if (groupModels.length === 0) return;
                    items.push({ label: groupName, kind: vscode.QuickPickItemKind.Separator });
                    groupModels.sort((a, b) => {
                        if (Boolean(a.isDisabled) !== Boolean(b.isDisabled)) {
                            return a.isDisabled ? 1 : -1;
                        }
                        return compareModels(a, b, this.sortMethod);
                    });
                    for (const model of groupModels) {
                        const infoTooltip = buildInfoTooltip(model);
                        const itemButtons: vscode.QuickInputButton[] | undefined = infoTooltip
                            ? [{
                                iconPath: new vscode.ThemeIcon(model.isDisabled ? 'lock' : 'info'),
                                tooltip: infoTooltip
                            }]
                            : undefined;

                        if (model.isDisabled) {
                            const tagSuffix = model.tagTitle ? ` • ${model.tagTitle}` : '';
                            const reasonText = model.disabledReason || model.tagDescription || lm.t('This model is currently unavailable.');
                            items.push({
                                label: `$(circle-slash) $(lock) ${model.label}`,
                                description: `${lm.t('Unavailable')}${tagSuffix}`,
                                detail: `$(info) ${reasonText}`,
                                buttons: itemButtons,
                                model,
                                infoTooltip
                            });
                            continue;
                        }

                        const isPinned = pinned.includes(model.modelId) || pinned.includes(model.label);
                        const pinIcon = isPinned ? '$(pin)' : '$(circle-outline)';
                        const pct = model.remainingPercentage ?? 0;
                        let status = '$(check)';
                        if (model.isExhausted || pct === 0) status = '$(error)';
                        else if (pct < 30) status = '$(flame)';
                        else if (pct < 50) status = '$(warning)';
                        const bar = drawProgressBar(pct);
                        const tagBadge = model.tagTitle ? ` • [${model.tagTitle}]` : '';
                        let desc = `${bar} ${pct.toFixed(1)}%${tagBadge}`;
                        if (model.timeUntilReset > 0) {
                            const timeUntil = formatDuration(model.timeUntilReset);
                            desc += ` • ${lm.t('Reset at {0}', formatResetTime(model.resetTime))} (${lm.t('in')} ${timeUntil})`;
                        }
                        const detailParts: string[] = [];
                        if (model.requestLimit && model.requestUsage !== undefined) detailParts.push(`${lm.t('Requests')}: ${model.requestUsage} / ${model.requestLimit}`);
                        if (model.tokenLimit && model.tokenUsage !== undefined) detailParts.push(`${lm.t('Tokens')}: ${model.tokenUsage} / ${model.tokenLimit}`);
                        items.push({
                            label: `${pinIcon} ${status} ${model.label}`,
                            description: desc,
                            detail: detailParts.length > 0 ? detailParts.join('  ') : undefined,
                            buttons: itemButtons,
                            model,
                            infoTooltip
                        });
                    }
                };
                const activeGroups = groups.filter(g => g.models.length > 0);
                activeGroups.sort((a, b) => compareModels(a.models[0], b.models[0], this.sortMethod));
                for (const group of activeGroups) addGroup(group.name, group.models);
            }
            picker.items = items;
            updateSortButton();
        };

        updateItems();

        // Handle Button Click (Sort & Support)
        picker.onDidTriggerButton(button => {
            const tooltip = button.tooltip || '';
            if (tooltip.startsWith(lm.t('Sort'))) {
                this.sortMethod = this.sortMethod === 'quota' ? 'time' : 'quota';
                updateItems();
            } else if (tooltip === lm.t('Support on Patreon')) {
                vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
            } else if (tooltip === lm.t('Buy Me a Coffee')) {
                vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
            } else if (tooltip === lm.t('Star on GitHub')) {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/unchase/antigravity-storage-manager'));
            }
        });

        // Handle Item Info Button Click (shows full tooltip text like Antigravity info icon)
        picker.onDidTriggerItemButton(event => {
            const item = event.item;
            if (item.model && item.infoTooltip) {
                vscode.window.showInformationMessage(`${item.model.label}: ${item.infoTooltip}`);
            }
        });

        picker.onDidAccept(async () => {
            const selected = picker.selectedItems[0];
            if (!selected) return;

            // Handle "Plan" click
            if (selected.isPlanItem) {
                const rawStatus = snapshot.rawUserStatus;
                const tierUri = rawStatus?.userStatus?.userTier?.upgradeSubscriptionUri || rawStatus?.userTier?.upgradeSubscriptionUri;
                const targetUrl = typeof tierUri === 'string' && /^https?:\/\//i.test(tierUri)
                    ? tierUri
                    : 'https://one.google.com/ai';
                vscode.env.openExternal(vscode.Uri.parse(targetUrl));
                picker.selectedItems = [];
                return;
            }

            // Disabled / unavailable models cannot be pinned; keep picker open
            if (selected.model?.isDisabled) {
                picker.selectedItems = [];
                return;
            }

            // Handle Pinning
            if (selected.model) {
                await this.statusBar.togglePinnedModel(selected.model.modelId, selected.model.label);
                updateItems();
            }

            // Clear selection for all actions so user can click again
            picker.selectedItems = [];
        });

        picker.onDidHide(() => picker.dispose());
        picker.show();
    }

    public dispose() {
        this.stopPolling();
        this.statusBar.dispose();
    }

    public isFeatureEnabled(): boolean {
        return this.isEnabled;
    }
}
