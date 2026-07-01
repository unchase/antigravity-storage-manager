import * as vscode from 'vscode';
import { QuotaSnapshot } from './types';
import { formatResetTime, drawProgressBar, formatDuration, getCycleDuration, getModelStatusIcon } from './utils';
import { LocalizationManager } from '../l10n/localizationManager';
import { QuotaUsageTracker } from './quotaUsageTracker';

export function generateQuotaReportMarkdown(snapshot: QuotaSnapshot, pinnedModels: string[], usageTracker?: QuotaUsageTracker, target: 'tooltip' | 'telegram' = 'tooltip'): string {
    const lm = LocalizationManager.getInstance();
    let md = '';

    const isTelegram = target === 'telegram';

    const hasPinned = pinnedModels && pinnedModels.length > 0;

    if (isTelegram) {
        md += `📌 *${lm.t(hasPinned ? 'Pinned Models Quota' : 'Quota')}*\n`;
        if (snapshot.userEmail) {
            md += `👤 _${snapshot.userEmail}_\n`;
        }
        md += `\n`;
    } else {
        md += `### ${lm.t(hasPinned ? 'Pinned Models Quota' : 'Quota')}\n`;
        if (snapshot.userEmail) {
            md += `_${snapshot.userEmail}_\n\n`;
        } else {
            md += `\n`;
        }
    }

    // Plan Info
    if (snapshot.planName || snapshot.promptCredits) {
        const planLabel = lm.t('Plan');
        if (isTelegram) {
            md += `💳 ${planLabel}: *${snapshot.planName || 'Free'}*\n`;
        } else {
            md += `**${planLabel}: ${snapshot.planName || 'Free'}**\n\n`;
        }

        if (snapshot.promptCredits && vscode.workspace.getConfiguration('antigravity-storage-manager').get('showCreditsBalance', false)) {
            const cred = snapshot.promptCredits;
            const credText = lm.t('Credits');
            if (isTelegram) {
                md += `💎 ${credText}: \`${cred.available}/${cred.monthly}\` (${cred.remainingPercentage.toFixed(0)}%)\n`;
            } else {
                const availText = lm.t('available');
                md += `- ${credText}: \`${cred.available} / ${cred.monthly}\` (${cred.remainingPercentage.toFixed(1)}% ${availText})\n\n`;
            }
        }
        if (isTelegram) md += `\n`;
    }

    if (!isTelegram) md += '---\n\n';

    const relevantModels = hasPinned
        ? snapshot.models.filter(m => pinnedModels.includes(m.modelId) || pinnedModels.includes(m.label))
        : snapshot.models;

    // Grouping relevant models
    interface ModelGroup {
        name: string;
        models: typeof snapshot.models;
    }

    const groups: ModelGroup[] = [];
    const processed = new Set<string>();

    const groupDefinitions = [
        { name: 'Gemini', match: (l: string) => l.includes('Gemini') },
        { name: 'Claude & GPT-OSS', match: (l: string) => l.includes('Claude') || l.includes('GPT-OSS') }
    ];

    for (const model of relevantModels) {
        if (processed.has(model.modelId)) continue;

        let groupFound = false;
        for (const def of groupDefinitions) {
            if (def.match(model.label)) {
                const groupModels = relevantModels.filter(m => !processed.has(m.modelId) && def.match(m.label));
                if (groupModels.length > 0) {
                    groups.push({ name: def.name, models: groupModels });
                    groupModels.forEach(m => processed.add(m.modelId));
                    groupFound = true;
                    break;
                }
            }
        }

        if (!groupFound) {
            groups.push({ name: model.label, models: [model] });
            processed.add(model.modelId);
        }
    }

    for (const g of groups) {
        const m = g.models[0];
        const pct = m.remainingPercentage ?? 0;
        const statusIcon = getModelStatusIcon(m.remainingPercentage, m.isExhausted);
        const groupLabel = g.name;

        if (isTelegram) {
            md += `${statusIcon} *${groupLabel}*\n`;
            const bar = drawProgressBar(pct);
            md += `${lm.t('Quota')}: \`${bar}\` ${pct.toFixed(0)}%\n`;
        } else {
            md += `**${statusIcon} ${groupLabel}**\n\n`;
            const bar = drawProgressBar(pct);
            md += `- ${lm.t('Remaining')}: \`${bar}\` **${pct.toFixed(1)}%**\n`;
        }

        // Add Speed / Estimation
        if (usageTracker) {
            let est: any = undefined;
            for (const gm of g.models) {
                const modelEst = usageTracker.getEstimation(gm.modelId);
                if (modelEst && modelEst.speedPerHour > 0.1) {
                    est = modelEst;
                    break;
                }
            }

            if (!(m.isExhausted || pct === 0) && est) {
                if (isTelegram) {
                    md += `${lm.t('Speed')}: ~${est.speedPerHour.toFixed(1)}%${lm.t('/h')}\n`;
                    if (est.estimatedTimeRemainingMs) {
                        md += `${lm.t('Est. Time')}: ~${formatDuration(est.estimatedTimeRemainingMs)}\n`;
                    }
                } else {
                    md += `- ${lm.t('Speed')}: ~${est.speedPerHour.toFixed(1)}%${lm.t('/h')}\n`;
                    if (est.estimatedTimeRemainingMs) {
                        md += `- ${lm.t('Estimated Remaining Time')}: ~${formatDuration(est.estimatedTimeRemainingMs)}\n`;
                    }
                }
            }
        }

        if (m.resetTime) {
            const now = new Date();
            const reset = new Date(m.resetTime);
            const msUntilReset = reset.getTime() - now.getTime();

            if (msUntilReset > 0) {
                if (isTelegram) {
                    if (msUntilReset < 60 * 60 * 1000) {
                        const mins = Math.floor(msUntilReset / 60000);
                        const secs = Math.floor((msUntilReset % 60000) / 1000);
                        const countdown = `${mins}:${secs.toString().padStart(2, '0')}`;
                        md += `${lm.t('Reset at {0}', formatResetTime(m.resetTime))} (⏱️ ${countdown})\n`;
                    } else {
                        md += `${lm.t('Reset at {0}', formatResetTime(m.resetTime))}\n`;
                    }
                } else {
                    if (msUntilReset < 60 * 60 * 1000) {
                        const mins = Math.floor(msUntilReset / 60000);
                        const secs = Math.floor((msUntilReset % 60000) / 1000);
                        const countdown = `⏱️ ${mins}:${secs.toString().padStart(2, '0')}`;
                        md += `- ${lm.t('Reset at {0}', formatResetTime(m.resetTime))} ${countdown}\n`;
                    } else {
                        md += `- ${lm.t('Reset at {0}', formatResetTime(m.resetTime))}\n`;
                    }
                }

                const hasHighTier = g.models.some(gm => gm.label.includes('Pro') || gm.label.includes('Ultra') || gm.label.includes('Thinking') || gm.label.includes('Opus'));
                if (hasHighTier) {
                    const highTierModel = g.models.find(gm => gm.label.includes('Pro') || gm.label.includes('Ultra') || gm.label.includes('Thinking') || gm.label.includes('Opus')) || m;
                    const cycleDuration = getCycleDuration(highTierModel.label);
                    const progress = Math.max(0, Math.min(1, 1 - (msUntilReset / cycleDuration)));
                    const progressBar = drawProgressBar(progress * 100);
                    const cycleText = lm.t('Cycle');

                    if (isTelegram) {
                        md += `${cycleText}: \`${progressBar}\` (${formatDuration(msUntilReset)})\n`;
                    } else {
                        const leftText = lm.t('left');
                        md += `- ${cycleText}: \`${progressBar}\` (${formatDuration(msUntilReset)} ${leftText})\n`;
                    }
                }
            }
        }

        if (m.requestLimit && m.requestUsage !== undefined && !isTelegram) {
            const reqText = lm.t('Requests');
            md += `- ${reqText}: \`${m.requestUsage} / ${m.requestLimit}\`\n`;
        }
        if (m.tokenLimit && m.tokenUsage !== undefined && !isTelegram) {
            const tokText = lm.t('Tokens');
            md += `- ${tokText}: \`${m.tokenUsage} / ${m.tokenLimit}\`\n`;
        }

        if (isTelegram) {
            md += `\n`;
        } else {
            md += '\n---\n';
        }
    }

    if (snapshot.timestamp) {
        const dateStr = formatResetTime(new Date(snapshot.timestamp));
        if (isTelegram) {
            md += `🕒 _${lm.t('Last updated: {0}', dateStr)}_\n`;
        } else {
            md += `\n---\n${lm.t('Last updated: {0}', dateStr)}\n`;
        }
    }

    return md;
}
