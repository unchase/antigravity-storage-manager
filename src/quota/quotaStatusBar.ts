import * as vscode from 'vscode';
import { QuotaSnapshot } from './types';
import { getModelAbbreviation, formatResetTime } from './utils';

export class QuotaStatusBar {
    private item: vscode.StatusBarItem;
    private lastSnapshot: QuotaSnapshot | undefined;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'antigravity-storage-manager.showQuota';
        this.item.text = '$(rocket) AGQ';
        this.item.tooltip = 'Antigravity Quota';
    }

    public update(snapshot: QuotaSnapshot, pinnedOverride?: string[]): void {
        this.lastSnapshot = snapshot;
        const pinned = pinnedOverride || this.getPinnedModels();
        const parts: string[] = [];

        const pinnedModels = snapshot.models.filter(m => pinned.includes(m.modelId) || pinned.includes(m.label));

        if (pinnedModels.length === 0) {
            this.item.text = '$(rocket) AGQ';
            this.item.tooltip = 'Antigravity Quota (Click to view)';
        } else {
            console.log('QuotaStatusBar', `Updating status bar with ${pinnedModels.length} pinned models`);
            for (const m of pinnedModels) {
                const pct = m.remainingPercentage ?? 0;
                let statusIcon = '$(check)';
                if (m.isExhausted) {
                    statusIcon = '$(error)';
                } else if (pct < 20) {
                    statusIcon = '$(warning)';
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
                const statusIcon = m.isExhausted ? '$(error)' : (pct < 20 ? '$(warning)' : '$(check)');

                md.appendMarkdown(`**${statusIcon} ${m.label}**\n\n`);
                md.appendMarkdown(`- Remaining: **${pct.toFixed(1)}%**\n`);
                if (m.resetTime) {
                    md.appendMarkdown(`- Resets: ${formatResetTime(m.resetTime)}\n`);
                }
                md.appendMarkdown('\n---\n');
            }
            md.appendMarkdown('\n$(rocket) [Show Dashboard](command:antigravity-storage-manager.showQuota)');

            this.item.tooltip = md;
        }

        this.item.show();
    }

    public showLoading(): void {
        this.item.text = '$(sync~spin) AGQ';
        this.item.show();
    }

    public showError(msg: string): void {
        this.item.text = '$(error) AGQ';
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

    public dispose(): void {
        this.item.dispose();
    }
}
