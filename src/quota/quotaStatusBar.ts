import * as vscode from 'vscode';
import { QuotaSnapshot } from './types';
import { generateQuotaReportMarkdown } from './reportGenerator';
import { LocalizationManager } from '../l10n/localizationManager';
import { QuotaUsageTracker } from './quotaUsageTracker';
import { getModelAbbreviation, formatDuration as formatDurationCommon, getModelStatusIcon } from './utils';

export class QuotaStatusBar {
    private item: vscode.StatusBarItem;
    private lastSnapshot: QuotaSnapshot | undefined;
    private lastTracker: QuotaUsageTracker | undefined;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'antigravity-storage-manager.showQuota';
        this.item.text = '🚀 AGQ';
        this.item.tooltip = 'Antigravity Quota';
    }

    public update(snapshot: QuotaSnapshot, pinnedOverride?: string[], tracker?: QuotaUsageTracker): void {
        this.lastSnapshot = snapshot;
        if (tracker) this.lastTracker = tracker;

        const pinned = pinnedOverride || this.getPinnedModels();
        const parts: string[] = [];

        const pinnedModels = snapshot.models.filter(m => pinned.includes(m.modelId) || pinned.includes(m.label));

        if (pinnedModels.length === 0) {
            this.item.text = '🚀 AGQ';
            this.item.tooltip = 'Antigravity Quota (Click to view)';
        } else {
            console.log('QuotaStatusBar', `Updating status bar with ${pinnedModels.length} pinned models`);
            for (const m of pinnedModels) {
                const pct = m.remainingPercentage ?? 0;
                const statusIcon = getModelStatusIcon(m.remainingPercentage, m.isExhausted);

                const abbrev = getModelAbbreviation(m.label);
                let text = `${statusIcon} ${abbrev}: ${pct.toFixed(0)}%`;

                if ((m.isExhausted || pct === 0) && m.resetTime) {
                    const now = new Date();
                    const reset = new Date(m.resetTime);
                    const msUntilReset = reset.getTime() - now.getTime();
                    if (msUntilReset > 0) {
                        text += ` (${this.formatDuration(msUntilReset)})`;
                    }
                }

                parts.push(text);
            }
            this.item.text = parts.join('  ');

            // Build rich tooltip
            const reportMarkdown = generateQuotaReportMarkdown(snapshot, pinned, this.lastTracker);
            const md = new vscode.MarkdownString(reportMarkdown, true);
            md.isTrusted = true;
            md.supportThemeIcons = true;
            md.appendMarkdown(`\n🚀 [${LocalizationManager.getInstance().t('Show Dashboard')}](command:antigravity-storage-manager.showQuota)`);
            this.item.tooltip = md;
        }

        this.item.show();
    }

    public showLoading(): void {
        this.item.text = '$(sync~spin) AGQ';
        this.item.show();
    }

    public showError(msg: string): void {
        const lm = LocalizationManager.getInstance();
        this.item.text = '🔴 AGQ';
        this.item.tooltip = `${lm.t('Sync Error')}: ${msg}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.item.show();
    }

    public hide(): void {
        this.item.hide();
    }

    public getPinnedModels(): string[] {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        return config.get<string[]>('quota.pinnedModels') || [];
    }

    public async togglePinnedModel(modelId: string, modelLabel?: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const pinned = [...(config.get<string[]>('quota.pinnedModels') || [])];

        const idIndex = pinned.indexOf(modelId);
        const labelIndex = modelLabel ? pinned.indexOf(modelLabel) : -1;

        if (idIndex >= 0) {
            pinned.splice(idIndex, 1);
        } else if (labelIndex >= 0) {
            pinned.splice(labelIndex, 1);
        } else {
            // Prefer saving label if valid, otherwise ID
            pinned.push(modelLabel || modelId);
        }

        await config.update('quota.pinnedModels', pinned, vscode.ConfigurationTarget.Global);

        // Force update if we have a snapshot
        if (this.lastSnapshot) {
            this.update(this.lastSnapshot, pinned, this.lastTracker);
        }
    }

    public getLatestSnapshot(): QuotaSnapshot | undefined {
        return this.lastSnapshot;
    }

    private formatDuration(ms: number): string {
        return formatDurationCommon(ms);
    }

    public dispose(): void {
        this.item.dispose();
    }
}
