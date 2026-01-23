
import * as vscode from 'vscode';
import { ProcessPortDetector } from './processPortDetector';
import { QuotaService } from './quotaService';
import { QuotaSnapshot } from './types';
import { versionInfo } from './versionInfo';
import { LocalizationManager } from '../l10n/localizationManager';

import { QuotaStatusBar } from './quotaStatusBar';
import { drawProgressBar, formatResetTime, compareModels, formatDuration } from './utils';
import { QuotaUsageTracker } from './quotaUsageTracker';
import { AccountInfoWebview } from './accountInfoWebview';

export class QuotaManager {
    private context: vscode.ExtensionContext;
    private portDetector: ProcessPortDetector;
    private quotaService: QuotaService | null = null;
    private statusBar: QuotaStatusBar;
    private usageTracker: QuotaUsageTracker;
    private isEnabled: boolean = true;
    private pollingTimer: NodeJS.Timeout | undefined;
    private readonly POLLING_INTERVAL = 60 * 1000; // 1 minute
    private sortMethod: 'quota' | 'time' = 'quota';
    private lastNotifiedModels: Map<string, boolean> = new Map(); // modelId -> wasExhausted

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.portDetector = new ProcessPortDetector();
        this.statusBar = new QuotaStatusBar();
        this.usageTracker = new QuotaUsageTracker(context);
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
                    AccountInfoWebview.update(snapshot, this.usageTracker);
                }
            }
        });

        this.updateEnabledState();
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

    private async fetchAndUpdate(isInitial: boolean = false): Promise<QuotaSnapshot | null> {
        if (!this.isEnabled) return null;

        if (isInitial) {
            this.statusBar.showLoading();
        }

        try {
            const snapshot = await this.getQuota();
            this.usageTracker.track(snapshot);
            this.checkAndNotifyResets(snapshot);
            this.statusBar.update(snapshot, undefined, this.usageTracker);
            AccountInfoWebview.update(snapshot, this.usageTracker);
            return snapshot;
        } catch (error: any) {
            const lm = LocalizationManager.getInstance();
            vscode.window.showErrorMessage(lm.t('QuotaManager: Fetch failed ({0})', error.message));
            if (isInitial) {
                this.statusBar.showError('Fetch failed');
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
            AccountInfoWebview.show(this.context, snapshot, this.usageTracker);
        } else {
            const lm = LocalizationManager.getInstance();
            vscode.window.showErrorMessage(lm.t('No account data available.'));
        }
    }

    public async getQuota(): Promise<QuotaSnapshot> {
        // 1. Detect process and port
        const processInfo = await this.portDetector.detectProcessInfo();

        if (!processInfo) {
            throw new Error('Antigravity Language Server not found. Please ensure Antigravity extension is installed and running.');
        }

        // 2. Initialize service if needed
        if (!this.quotaService) {
            this.quotaService = new QuotaService(processInfo.connectPort, processInfo.csrfToken, processInfo.extensionPort);
        }

        // 3. Fetch quota
        return await this.quotaService.fetchQuota();
    }

    private async checkAndNotifyResets(snapshot: QuotaSnapshot) {
        if (!snapshot.models) return;

        for (const model of snapshot.models) {
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
        const picker = vscode.window.createQuickPick();
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
                    iconPath: new vscode.ThemeIcon('gift'),
                    tooltip: lm.t('Buy Me a Coffee')
                },
                {
                    iconPath: new vscode.ThemeIcon(this.sortMethod === 'quota' ? 'list-ordered' : 'clock'),
                    tooltip: `${lm.t('Sort')}: ${sortText}`
                }
            ];
        };

        const updateItems = () => {
            const items: vscode.QuickPickItem[] = [];

            if (this.statusBar) {
                this.statusBar.update(snapshot, undefined, this.usageTracker);
            }

            // Plan Info
            if (snapshot.planName) {
                items.push({
                    label: `$(star) ${lm.t('Plan')}: ${snapshot.planName}`,
                    // kind: vscode.QuickPickItemKind.Separator // Separators don't support icons
                    alwaysShow: true,
                    description: lm.t('Current Subscription')
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
                // ... rest of model rendering logic
                const models = [...snapshot.models];
                const pinned = this.statusBar.getPinnedModels();

                const groups = [
                    { name: 'Claude & GPT-OSS', models: [] as any[] },
                    { name: 'Gemini 3 Pro', models: [] as any[] },
                    { name: 'Gemini 3 Flash', models: [] as any[] }
                ];

                for (const m of models) {
                    if (m.label.includes('Gemini 3 Pro')) {
                        groups[1].models.push(m);
                    } else if (m.label.includes('Gemini 3 Flash')) {
                        groups[2].models.push(m);
                    } else {
                        groups[0].models.push(m);
                    }
                }

                const addGroup = (groupName: string, groupModels: any[]) => {
                    if (groupModels.length === 0) return;
                    items.push({ label: groupName, kind: vscode.QuickPickItemKind.Separator });
                    groupModels.sort((a, b) => compareModels(a, b, this.sortMethod));
                    for (const model of groupModels) {
                        const isPinned = pinned.includes(model.modelId) || pinned.includes(model.label);
                        const pinIcon = isPinned ? '$(pin)' : '$(circle-outline)';
                        const pct = model.remainingPercentage ?? 0;
                        let status = '$(check)';
                        if (model.isExhausted || pct === 0) status = '$(error)';
                        else if (pct < 30) status = '$(flame)';
                        else if (pct < 50) status = '$(warning)';
                        const bar = drawProgressBar(pct);
                        let desc = `${bar} ${pct.toFixed(1)}%`;
                        if (model.timeUntilReset > 0) {
                            const timeUntil = formatDuration(model.timeUntilReset);
                            desc += ` • ${lm.t('Resets')} ${formatResetTime(model.resetTime)} (${lm.t('in')} ${timeUntil})`;
                        }
                        let details = '';
                        if (model.requestLimit && model.requestUsage !== undefined) details += `${lm.t('Requests')}: ${model.requestUsage} / ${model.requestLimit}  `;
                        if (model.tokenLimit && model.tokenUsage !== undefined) details += `${lm.t('Tokens')}: ${model.tokenUsage} / ${model.tokenLimit}`;
                        items.push({ label: `${pinIcon} ${status} ${model.label}`, description: desc, detail: details });
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
            }
        });

        picker.onDidAccept(async () => {
            const selected = picker.selectedItems[0];
            if (!selected) return;

            // Handle "Plan" click
            if (selected.label.includes(lm.t('Plan'))) {
                vscode.env.openExternal(vscode.Uri.parse('https://one.google.com/ai'));
                picker.selectedItems = [];
                return;
            }

            // Handle Pinning
            // We need to find the model corresponding to this item.
            // Since 'detail' might now contain stats strings, we can't trust it as ID directly.
            // We'll iterate models and match by label (removing icons)
            if (snapshot.models) {
                // Label format: "$(pin) $(check) ModelName"
                // Let's strip icons.
                // Or better, let's store the modelId in a custom property?
                // QuickPickItem doesn't allow custom props easily without casting.
                // Let's rely on finding standard separators.

                // Let's try to match by label since we know the label format used in generation.
                // But cleaner is to check if we can identify the model from the list.
                // The iteration order is deterministic if we resort again, but that's risky.

                // Hack: Let's assume detail IS unique enough? No.

                // Let's look for the model in the snapshot
                const targetModel = snapshot.models.find(m => {
                    // Check if selected label contains the model label
                    return selected.label.includes(m.label);
                });

                if (targetModel) {
                    await this.statusBar.togglePinnedModel(targetModel.modelId, targetModel.label);
                    updateItems();
                }
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
