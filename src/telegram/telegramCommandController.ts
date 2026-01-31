
import { TelegramService } from './telegramService';
import { QuotaManager } from '../quota/quotaManager';
import { SyncManager } from '../sync';
import { LocalizationManager } from '../l10n/localizationManager';
// import { drawProgressBar, getCycleDuration, formatDuration, getModelStatusIcon } from '../quota/utils';

import { generateQuotaReportMarkdown } from '../quota/reportGenerator';

export class TelegramCommandController {
    constructor(
        private telegramService: TelegramService,
        private quotaManager: QuotaManager,
        private syncManager: SyncManager
    ) {
        this.telegramService.onDidReceiveMessage(e => this.handleMessage(e));
    }

    private async handleMessage(event: { chatId: string, text: string, username?: string, authorized: boolean }) { // Added authorized
        const text = event.text.trim();
        if (!text.startsWith('/')) return;

        // Handle unauthorized
        if (!event.authorized) {
            const lm = LocalizationManager.getInstance();
            await this.telegramService.sendMessage(event.chatId, `⛔ *${lm.t('Access Denied')}*\n${lm.t('Your ID')}: \`${event.chatId}\`\n${lm.t('Please ask the owner to add your ID or Username to the configuration.')}`);
            return;
        }

        const [command] = text.split(' ');

        switch (command.toLowerCase()) {
            case '/start':
            case '/help':
                await this.sendHelp(event.chatId);
                break;
            case '/stats':
                await this.sendStats(event.chatId);
                break;

            case '/sync':
                await this.triggerSync(event.chatId);
                break;
            case '/ping':
                await this.telegramService.sendMessage(event.chatId, '🏓 Pong!');
                break;
            default: {
                const lm = LocalizationManager.getInstance();
                await this.telegramService.sendMessage(event.chatId, `❓ ${lm.t('Unknown command. Try /help')}`);
                break;
            }
        }
    }

    private async sendHelp(chatId: string) {
        const lm = LocalizationManager.getInstance();
        const help = `
🤖 *${lm.t('Antigravity Bot Commands')}*

${lm.t('/stats - Show full system statistics')}

${lm.t('/sync - Trigger a sync now')}
${lm.t('/ping - Check bot connectivity')}
        `;
        await this.telegramService.sendMessage(chatId, help.trim());
    }

    private async sendStats(chatId: string) {
        // Reuse logic similar to Scheduler but replying to specific chat
        const lm = LocalizationManager.getInstance();

        // Collect Quota Stats
        let snapshot: any;
        try {
            snapshot = await this.quotaManager.getQuota();
        } catch {
            snapshot = this.quotaManager.getLatestSnapshot();
        }

        const syncConfig = this.syncManager.getConfig();
        const lastSyncDate = syncConfig?.lastSync ? new Date(syncConfig.lastSync) : undefined;
        const lastSyncStr = lastSyncDate ? lm.formatDateTime(lastSyncDate) : lm.t('Never');

        let message = `📊 *${lm.t('System Statistics')}*\n\n`;
        message += `*${lm.t('Sync Status')}*:\n`;
        message += `${lm.t('Last Sync')}: \`${lastSyncStr}\`\n`;
        if (syncConfig?.machineName) {
            message += `${lm.t('Device')}: \`${syncConfig.machineName}\`\n`;
        }
        message += `\n`;

        if (snapshot) {
            if (snapshot.userEmail) {
                message += `👤 _${snapshot.userEmail}_\n\n`;
            }

            // Use shared report generator
            const pinned = this.quotaManager['statusBar'].getPinnedModels();
            const tracker = this.quotaManager.getUsageTracker();
            const report = generateQuotaReportMarkdown(snapshot, pinned, tracker, 'telegram');

            const tgReport = report.replace(/\[([^\]]+)\]\(command:[^)]+\)/g, '$1');

            message += tgReport;
        } else {
            message += `_${lm.t('Quota information unavailable')}_`;
        }

        await this.telegramService.sendMessage(chatId, message);
    }



    private async triggerSync(chatId: string) {
        const lm = LocalizationManager.getInstance();
        if (!this.syncManager.isReady()) {
            await this.telegramService.sendMessage(chatId, `⚠️ ${lm.t('Sync is not configured on this device.')}`);
            return;
        }

        await this.telegramService.sendMessage(chatId, `🔄 ${lm.t('Starting sync...')}`);

        try {
            // We can't really pass progress or token here easily, or we can mock it.
            // Since syncNow expects VSCode progress, we might need to be careful.
            // But types say optional.
            const result = await this.syncManager.syncNow(undefined, undefined, false);

            if (result.success) {
                const pushed = result.pushed.length;
                const pulled = result.pulled.length;
                await this.telegramService.sendMessage(chatId, `✅ *${lm.t('Sync Complete')}*\n${lm.t('Pushed')}: ${pushed}\n${lm.t('Pulled')}: ${pulled}`);
            } else {
                await this.telegramService.sendMessage(chatId, `❌ *${lm.t('Sync Failed')}*\n${lm.t('Errors')}: ${result.errors.join(', ')}`);
            }
        } catch (e: any) {
            await this.telegramService.sendMessage(chatId, `❌ *${lm.t('Sync Error')}*: ${e.message}`);
        }
    }

    public dispose() {
        // 
    }
}
