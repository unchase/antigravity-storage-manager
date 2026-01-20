import * as vscode from 'vscode';
import { QuotaSnapshot } from './types';
import { getModelAbbreviation, formatResetTime } from './utils';
import { LocalizationManager } from '../l10n/localizationManager';

export class QuotaStatusBar {
    private item: vscode.StatusBarItem;
    private lastSnapshot: QuotaSnapshot | undefined;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'antigravity-storage-manager.showQuota';
        this.item.text = '🚀 AGQ';
        this.item.tooltip = 'Antigravity Quota';
    }

    public update(snapshot: QuotaSnapshot, pinnedOverride?: string[]): void {
        this.lastSnapshot = snapshot;
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
                let statusIcon = '🟢';
                if (m.isExhausted) {
                    statusIcon = '🔴';
                } else if (pct < 20) {
                    statusIcon = '🟡';
                }

                const abbrev = getModelAbbreviation(m.label);
                parts.push(`${statusIcon} ${abbrev}: ${pct.toFixed(0)}%`);
            }
            this.item.text = parts.join('  ');

            // Build rich tooltip
            const md = new vscode.MarkdownString('', true);
            md.isTrusted = true;
            md.supportThemeIcons = true;

            md.appendMarkdown('### Pinned Models Quota\n\n');

            for (const m of pinnedModels) {
                const pct = m.remainingPercentage ?? 0;
                let statusIcon = '🟢';
                if (m.isExhausted) {
                    statusIcon = '🔴';
                } else if (pct < 20) {
                    statusIcon = '🟡';
                }

                md.appendMarkdown(`**${statusIcon} ${m.label}**\n\n`);
                md.appendMarkdown(`- Remaining: **${pct.toFixed(1)}%**\n`);
                if (m.resetTime) {
                    md.appendMarkdown(`- Resets: ${formatResetTime(m.resetTime)}\n`);

                    // Visual Scale for Pro and Ultra
                    if (m.label.includes('Pro') || m.label.includes('Ultra')) {
                        const now = new Date();
                        const reset = new Date(m.resetTime);
                        const msUntilReset = reset.getTime() - now.getTime();

                        // Assume 24h cycle for Pro, 4h for Ultra (adjust if detailed specs confirm otherwise)
                        // Defaulting to 24h generally safe for "daily" quotas, but high-tier might be shorter.
                        // User mentioned "known", implying they care about the wait.
                        // Let's use 24h as the base denominator.
                        const cycleDuration = m.label.includes('Ultra') ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

                        if (msUntilReset > 0) {
                            const progress = Math.max(0, Math.min(1, 1 - (msUntilReset / cycleDuration)));
                            const bars = 10;
                            const filled = Math.round(progress * bars);
                            const empty = bars - filled;
                            const progressBar = '█'.repeat(filled) + '░'.repeat(empty);

                            const cycleText = LocalizationManager.getInstance().t('Cycle');
                            const leftText = LocalizationManager.getInstance().t('left');
                            md.appendMarkdown(`- ${cycleText}: \`${progressBar}\` (${this.formatDuration(msUntilReset)} ${leftText})\n`);
                        }
                    }
                }
                md.appendMarkdown('\n---\n');
            }
            md.appendMarkdown('\n🚀 [Show Dashboard](command:antigravity-storage-manager.showQuota)');

            this.item.tooltip = md;
        }

        this.item.show();
    }

    public showLoading(): void {
        this.item.text = '$(sync~spin) AGQ';
        this.item.show();
    }

    public showError(msg: string): void {
        this.item.text = '🔴 AGQ';
        this.item.tooltip = `Error fetching quota: ${msg}`;
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
            pinned.push(modelId);
        }

        await config.update('quota.pinnedModels', pinned, vscode.ConfigurationTarget.Global);

        // Force update if we have a snapshot
        if (this.lastSnapshot) {
            this.update(this.lastSnapshot, pinned);
        }
    }

    public getLatestSnapshot(): QuotaSnapshot | undefined {
        return this.lastSnapshot;
    }

    private formatDuration(ms: number): string {
        const h = Math.floor(ms / (1000 * 60 * 60));
        const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

        const hText = LocalizationManager.getInstance().t('h');
        const mText = LocalizationManager.getInstance().t('m');

        if (h > 0) {
            return `${h}${hText} ${m}${mText}`;
        }
        return `${m}${mText}`;
    }

    public dispose(): void {
        this.item.dispose();
    }
}
