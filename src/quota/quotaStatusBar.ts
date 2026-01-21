import * as vscode from 'vscode';
import { QuotaSnapshot } from './types';
import { getModelAbbreviation, formatResetTime, drawProgressBar, formatDuration as formatDurationCommon } from './utils';
import { LocalizationManager } from '../l10n/localizationManager';
import { QuotaUsageTracker } from './quotaUsageTracker';

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
                let statusIcon = '🟢';
                if (m.isExhausted || pct === 0) {
                    statusIcon = '🔴';
                } else if (pct < 30) {
                    statusIcon = '🟠';
                } else if (pct < 50) {
                    statusIcon = '🟡';
                }

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
            const md = new vscode.MarkdownString('', true);
            md.isTrusted = true;
            md.supportThemeIcons = true;

            const lm = LocalizationManager.getInstance();

            md.appendMarkdown(`### ${lm.t('Pinned Models Quota')}\n\n`);

            for (const m of pinnedModels) {
                const pct = m.remainingPercentage ?? 0;
                let statusIcon = '🟢';
                if (m.isExhausted || pct === 0) {
                    statusIcon = '🔴';
                } else if (pct < 30) {
                    statusIcon = '🟠';
                } else if (pct < 50) {
                    statusIcon = '🟡';
                }

                md.appendMarkdown(`**${statusIcon} ${m.label}**\n\n`);

                const bar = drawProgressBar(pct);
                md.appendMarkdown(`- ${lm.t('Remaining')}: \`${bar}\` **${pct.toFixed(1)}%**\n`);

                // Add Speed / Estimation
                if (this.lastTracker) {
                    const est = this.lastTracker.getEstimation(m.modelId);
                    if (!(m.isExhausted || pct === 0) && est && est.speedPerHour > 0.1) {
                        md.appendMarkdown(`- ${lm.t('Speed')}: ~${est.speedPerHour.toFixed(1)}%${lm.t('/h')}\n`);
                        if (est.estimatedTimeRemainingMs) {
                            md.appendMarkdown(`- ${lm.t('Estimated Remaining Time')}: ~${this.formatDuration(est.estimatedTimeRemainingMs)}\n`);
                        }
                    }
                }

                if (m.resetTime) {
                    const now = new Date();
                    const reset = new Date(m.resetTime);
                    const msUntilReset = reset.getTime() - now.getTime();

                    // Only show reset time if it's in the future
                    if (msUntilReset > 0) {
                        // Show countdown timer if less than 1 hour
                        if (msUntilReset < 60 * 60 * 1000) {
                            const mins = Math.floor(msUntilReset / 60000);
                            const secs = Math.floor((msUntilReset % 60000) / 1000);
                            const countdown = `⏱️ ${mins}:${secs.toString().padStart(2, '0')}`;
                            md.appendMarkdown(`- ${lm.t('Resets')}: ${formatResetTime(m.resetTime)} ${countdown}\n`);
                        } else {
                            md.appendMarkdown(`- ${lm.t('Resets')}: ${formatResetTime(m.resetTime)}\n`);
                        }

                        // Visual Scale for Pro and Ultra models
                        const isHighTier = m.label.includes('Pro') || m.label.includes('Ultra') || m.label.includes('Thinking') || m.label.includes('Opus');
                        if (isHighTier) {
                            // Heuristic for cycle duration
                            let cycleDuration = 24 * 60 * 60 * 1000; // Default 24h
                            if (m.label.includes('Ultra') || m.label.includes('Opus') || m.label.includes('Thinking')) {
                                cycleDuration = 6 * 60 * 60 * 1000; // 6h cycle
                            } else if (m.label.includes('Pro')) {
                                cycleDuration = 8 * 60 * 60 * 1000; // 8h cycle
                            }

                            const progress = Math.max(0, Math.min(1, 1 - (msUntilReset / cycleDuration)));
                            const progressBar = drawProgressBar(progress * 100);

                            const cycleText = lm.t('Cycle');
                            const leftText = lm.t('left');
                            md.appendMarkdown(`- ${cycleText}: \`${progressBar}\` (${this.formatDuration(msUntilReset)} ${leftText})\n`);
                        }
                    }
                    // If reset time has passed, don't show it (quota should refresh soon)
                }

                // Request/Token Stats
                if (m.requestLimit && m.requestUsage !== undefined) {
                    const reqText = lm.t('Requests');
                    md.appendMarkdown(`- ${reqText}: \`${m.requestUsage} / ${m.requestLimit}\`\n`);
                }
                if (m.tokenLimit && m.tokenUsage !== undefined) {
                    const tokText = lm.t('Tokens');
                    md.appendMarkdown(`- ${tokText}: \`${m.tokenUsage} / ${m.tokenLimit}\`\n`);
                }

                md.appendMarkdown('\n---\n');
            }

            // Global Plan Info
            if (snapshot.planName || snapshot.promptCredits) {
                md.appendMarkdown(`\n### ${lm.t('Plan')}: ${snapshot.planName || 'Free'}\n\n`);
                if (snapshot.promptCredits) {
                    const cred = snapshot.promptCredits;
                    const credText = lm.t('Credits');
                    const availText = lm.t('available');
                    md.appendMarkdown(`- ${credText}: **${cred.available} / ${cred.monthly}** (${cred.remainingPercentage.toFixed(1)}% ${availText})\n`);
                }
            }

            // Last Update Time
            if (snapshot.timestamp) {
                const dateStr = formatResetTime(new Date(snapshot.timestamp));
                md.appendMarkdown(`\n---\n${lm.t('Last updated: {0}', dateStr)}\n`);
            }

            md.appendMarkdown(`\n🚀 [${lm.t('Show Dashboard')}](command:antigravity-storage-manager.showQuota)`);

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
        this.item.tooltip = `${LocalizationManager.getInstance().t('Sync Error')}: ${msg}`;
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
