import * as vscode from 'vscode';
import * as cron from 'node-cron';
import { TelegramService } from './telegramService';
import { QuotaManager } from '../quota/quotaManager';
import { SyncManager } from '../sync';
import { LocalizationManager } from '../l10n/localizationManager';
// import { drawProgressBar, getCycleDuration, formatDuration, getModelStatusIcon } from '../quota/utils';

import { generateQuotaReportMarkdown } from '../quota/reportGenerator';

export class StatsScheduler {
    private cronTask: cron.ScheduledTask | undefined;
    private configChangeListener: vscode.Disposable;

    constructor(
        private telegramService: TelegramService,
        private quotaManager: QuotaManager,
        private syncManager: SyncManager
    ) {
        this.schedule();
        this.configChangeListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-storage-manager.telegram.statsIntervalCron')) {
                this.schedule();
            }
        });
    }

    private schedule() {
        if (this.cronTask) {
            this.cronTask.stop();
            this.cronTask = undefined;
        }

        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const cronExpression = config.get<string>('telegram.statsIntervalCron', '0 */12 * * *');

        if (!cron.validate(cronExpression)) {
            console.error(`Invalid cron expression: ${cronExpression}`);
            return;
        }

        this.cronTask = cron.schedule(cronExpression, () => {
            this.sendStats();
        });
    }

    public async sendStats() {
        if (!this.telegramService.isConfigured()) return;

        try {
            const lm = LocalizationManager.getInstance();
            const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
            // const showCredits = config.get<boolean>('showCreditsBalance', false);
            const pinnedModels = config.get<string[]>('quota.pinnedModels', []) || [];

            // Collect Quota Stats
            // Use getQuota() to ensure fresh data, logic handles errors inside getQuota or we catch here
            let snapshot: any;
            try {
                snapshot = await this.quotaManager.getQuota();
            } catch {
                // Fallback to cached
                snapshot = this.quotaManager.getLatestSnapshot();
            }

            if (!snapshot) return; // No data available

            // Collect Sync Stats
            const syncConfig = this.syncManager.getConfig();
            const lastSyncDate = syncConfig?.lastSync ? new Date(syncConfig.lastSync) : undefined;
            const lastSyncStr = lastSyncDate ? lm.formatDateTime(lastSyncDate) : lm.t('Never');

            let message = `📊 *${lm.t('Periodic Statistics')}*\n\n`;

            // Sync Section
            message += `*${lm.t('Sync Status')}*:\n`;
            message += `${lm.t('Last Sync')}: \`${lastSyncStr}\`\n`;
            if (syncConfig?.machineName) {
                message += `${lm.t('Device')}: \`${syncConfig.machineName}\`\n`;
            }
            message += `\n`;

            // Use shared report generator for Quota section
            const tracker = this.quotaManager.getUsageTracker();
            const report = generateQuotaReportMarkdown(snapshot, pinnedModels, tracker, 'telegram');

            // Post-processing for Telegram
            const tgReport = report.replace(/\[([^\]]+)\]\(command:[^)]+\)/g, '$1');

            message += tgReport;

            await this.telegramService.sendBroadcast(message);
        } catch (error) {
            console.error('Failed to send periodic stats:', error);
        }
    }

    public dispose() {
        if (this.cronTask) {
            this.cronTask.stop();
        }
        this.configChangeListener.dispose();
    }
}
