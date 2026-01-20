
import * as vscode from 'vscode';
import { ProcessPortDetector } from './processPortDetector';
import { QuotaService } from './quotaService';
import { QuotaSnapshot } from './types';
import { versionInfo } from './versionInfo';

import { QuotaStatusBar } from './quotaStatusBar';
import { drawProgressBar, formatResetTime, compareModels } from './utils';

export class QuotaManager {
    private context: vscode.ExtensionContext;
    private portDetector: ProcessPortDetector;
    private quotaService: QuotaService | null = null;
    private statusBar: QuotaStatusBar;
    private isEnabled: boolean = true;
    private pollingTimer: NodeJS.Timeout | undefined;
    private readonly POLLING_INTERVAL = 60 * 1000; // 1 minute
    private sortMethod: 'quota' | 'time' = 'quota';
    private lastNotifiedModels: Map<string, boolean> = new Map(); // modelId -> wasExhausted

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.portDetector = new ProcessPortDetector();
        this.statusBar = new QuotaStatusBar();
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
            this.checkAndNotifyResets(snapshot);
            this.statusBar.update(snapshot);
            return snapshot;
        } catch (error: any) {
            console.error('QuotaManager', `Fetch failed: ${error.message}`);
            if (isInitial) {
                this.statusBar.showError('Fetch failed');
            }
            return null;
        }
    }

    public async showQuota(): Promise<void> {
        if (!this.isEnabled) {
            vscode.window.showInformationMessage(vscode.l10n.t('Quota feature is disabled in settings.'));
            return;
        }

        let snapshot = this.statusBar.getLatestSnapshot();

        // If no data yet, fetch with progress
        if (!snapshot) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Fetching Antigravity quota...'),
                cancellable: false
            }, async () => {
                snapshot = await this.fetchAndUpdate(true) || undefined;
            });
        }

        if (snapshot) {
            await this.displayQuota(snapshot);
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
                vscode.window.showInformationMessage(`Antigravity Quota: Limit for ${model.label} has been reset!`);
            }

            this.lastNotifiedModels.set(model.modelId, isExhausted);
        }
    }

    private async displayQuota(snapshot: QuotaSnapshot): Promise<void> {
        const picker = vscode.window.createQuickPick();
        picker.title = vscode.l10n.t('Antigravity Quota Usage');
        picker.placeholder = vscode.l10n.t('Click a model to pin/unpin it from status bar');
        picker.matchOnDetail = true;

        const updateItems = () => {
            const items: vscode.QuickPickItem[] = [];

            // Sort Options
            const sortIcon = this.sortMethod === 'quota' ? '$(list-ordered)' : '$(clock)';
            const sortText = this.sortMethod === 'quota' ? 'Sort by Reset Time' : 'Sort by Quota Remaining';

            // Action button to change sort
            items.push({
                label: `${sortIcon} ${sortText}`,
                detail: 'CHANGE_SORT',
                description: `Current: ${this.sortMethod === 'quota' ? 'Quota' : 'Reset Time'}`,
                alwaysShow: true
            });

            // Plan Info
            if (snapshot.planName) {
                items.push({
                    label: `$(star) Plan: ${snapshot.planName}`,
                    // kind: vscode.QuickPickItemKind.Separator // Separators don't support icons
                    alwaysShow: true,
                    description: 'Current Subscription'
                });
            }

            // Prompt Credits
            if (snapshot.promptCredits) {
                const credits = snapshot.promptCredits;
                const percent = credits.remainingPercentage.toFixed(1);
                items.push({
                    label: `$(graph) Credits: ${credits.available} / ${credits.monthly}`,
                    description: `${percent}% available`,
                    detail: 'Monthly Usage Limit',
                    alwaysShow: true
                });
            }

            // Models
            if (snapshot.models && snapshot.models.length > 0) {
                items.push({
                    label: 'Models (Click to Pin/Unpin)',
                    kind: vscode.QuickPickItemKind.Separator
                });

                const pinned = this.statusBar.getPinnedModels();

                // Sort models
                const models = [...snapshot.models];
                models.sort((a, b) => compareModels(a, b, this.sortMethod));

                for (const model of models) {
                    const isPinned = pinned.includes(model.modelId) || pinned.includes(model.label);
                    const pinIcon = isPinned ? '$(pin)' : '$(circle-outline)';
                    const status = model.isExhausted ? '$(error)' : '$(check)';

                    const pct = model.remainingPercentage ?? 0;
                    const bar = drawProgressBar(pct);

                    let desc = `${bar} ${pct.toFixed(1)}%`;
                    if (model.timeUntilReset > 0) {
                        desc += ` • Resets ${formatResetTime(model.resetTime)}`;
                    }

                    items.push({
                        label: `${pinIcon} ${status} ${model.label}`,
                        description: desc,
                        detail: model.modelId
                    });
                }
            }
            picker.items = items;
        };

        updateItems();

        picker.onDidAccept(async () => {
            const selected = picker.selectedItems[0];
            if (!selected) return;

            // Handle Sort
            if (selected.detail === 'CHANGE_SORT') {
                this.sortMethod = this.sortMethod === 'quota' ? 'time' : 'quota';
                updateItems();
                picker.selectedItems = []; // Clear selection to avoid confusion
                return;
            }

            // Handle Pinning (Item with detail=modelId)
            // Ignore Plan/Credits items which don't have modelId as detail or CHANGE_SORT
            if (selected.detail && !selected.detail.includes('CHANGE_SORT') && selected.detail !== 'Monthly Usage Limit') {
                const model = snapshot.models.find(m => m.modelId === selected.detail);
                if (model) {
                    await this.statusBar.togglePinnedModel(model.modelId, model.label);
                } else {
                    // Fallback using detail as ID
                    await this.statusBar.togglePinnedModel(selected.detail);
                }
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
