import { LocalizationManager } from "../l10n/localizationManager";
import { formatDuration } from "../utils";

export { formatDuration };

/**
 * Generates an ASCII progress bar.
 * Example: ▓▓▓▓▓▓░░░░
 */
export function drawProgressBar(percentage: number, length: number = 10): string {
    const filledLength = Math.round((percentage / 100) * length);
    const emptyLength = length - filledLength;
    return '■'.repeat(filledLength) + '□'.repeat(emptyLength);
}

/**
 * Mapping of full model labels to short abbreviations.
 */
const MODEL_ABBREVIATIONS: Record<string, string> = {
    'Gemini 4 Neon (High)': 'Gemini 4 Neon (H)',
    'Gemini 4 Neon (XHigh)': 'Gemini 4 Neon (XH)',
    'Gemini 4 Neon (Medium)': 'Gemini 4 Neon (M)',
    'Gemini 4 Neon (Low)': 'Gemini 4 Neon (L)',
    'Gemini 4 Carbon (High)': 'Gemini 4 Carbon (H)',
    'Gemini 4 Carbon (Medium)': 'Gemini 4 Carbon (M)',
    'Gemini 4 Carbon (Low)': 'Gemini 4 Carbon (L)',
    'Gemini 4 Argon (High)': 'Gemini 4 Argon (H)',
    'Gemini 4 Argon (Medium)': 'Gemini 4 Argon (M)',
    'Gemini 4 Argon (Low)': 'Gemini 4 Argon (L)',
    'Gemini 4 Hydrogen (XHigh)': 'Gemini 4 Hydrogen (XH)',
    'Gemini 4 Hydrogen (High)': 'Gemini 4 Hydrogen (H)',
    'Gemini 4 Hydrogen (Medium)': 'Gemini 4 Hydrogen (M)',
    'Gemini 4 Hydrogen (Low)': 'Gemini 4 Hydrogen (L)',
    'Orchestrator (Neon)': 'Orch (Neon)',
    'Orchestrator (Carbon)': 'Orch (Carbon)',
    'Orchestrator (Argon)': 'Orch (Argon)',
    'Gemini 3.8 Flash (High)': 'Gemini 3.8 Flash (H)',
    'Gemini 3.8 Flash (Medium)': 'Gemini 3.8 Flash (M)',
    'Gemini 3.8 Flash (Low)': 'Gemini 3.8 Flash (L)',
    'Gemini 3.5 Flash (Medium)': 'Gemini 3.5 Flash (M)',
    'Gemini 3.5 Flash (High)': 'Gemini 3.5 Flash (H)',
    'Gemini 3.5 Flash (Low)': 'Gemini 3.5 Flash (L)',
    'Gemini 3.1 Pro (High)': 'Gemini 3.1 Pro (H)',
    'Gemini 3.1 Pro (Low)': 'Gemini 3.1 Pro (L)',
    'Gemini 3.1 Flash': 'Gemini 3.1 Flash',
    'Claude Opus 5.5 (Low)': 'Claude O5.5 (L)',
    'Claude Opus 5.5 (Medium)': 'Claude O5.5 (M)',
    'Claude Opus 5.5 (High)': 'Claude O5.5 (H)',
    'Claude Sonnet 5.5 (Low)': 'Claude S5.5 (L)',
    'Claude Sonnet 5.5 (Medium)': 'Claude S5.5 (M)',
    'Claude Sonnet 5.5 (High)': 'Claude S5.5 (H)',
    'Claude Sonnet 4.6': 'Claude S4.6',
    'Claude Sonnet 4.6 (Thinking)': 'Claude S4.6T',
    'Claude Opus 4.6 (Thinking)': 'Claude O4.6T',
    'GPT-OSS 120B (Medium)': 'GPT-OSS (M)',
};

function formatTierAbbreviation(tier: string): string {
    const normalized = tier.trim().toLowerCase();
    if (normalized === 'xhigh') return 'XH';
    if (normalized === 'max') return 'Max';
    if (normalized === 'low') return 'L';
    if (normalized === 'medium') return 'M';
    if (normalized === 'high') return 'H';
    return tier.trim()[0]?.toUpperCase() || '';
}

/**
 * Checks whether a model belongs to the Gemini / Orchestrator family.
 */
export function isGeminiModel(label: string, modelId?: string): boolean {
    const l = (label || '').toLowerCase();
    const id = (modelId || '').toLowerCase();
    return l.includes('gemini') || l.includes('orchestrator') || id.startsWith('gemini');
}

/**
 * Checks whether a model belongs to the Claude / GPT-OSS (3rd-party) family.
 */
export function isThirdPartyModel(label: string, modelId?: string): boolean {
    const l = (label || '').toLowerCase();
    const id = (modelId || '').toLowerCase();
    return l.includes('claude') || l.includes('gpt-oss') || l.includes('gpt') || id.startsWith('claude') || id.startsWith('gpt') || id.startsWith('3p-');
}

/**
 * Checks whether a model is considered high-tier (used for cycle progress rendering).
 */
export function isHighTierModel(label: string): boolean {
    return (
        label.includes('Pro') ||
        label.includes('Ultra') ||
        label.includes('Thinking') ||
        label.includes('Opus') ||
        label.includes('Gemini 4') ||
        label.includes('Orchestrator') ||
        /5-hour|\b5h\b|weekly/i.test(label)
    );
}

/**
 * Gets a short abbreviation for a model label.
 */
export function getModelAbbreviation(label: string): string {
    if (MODEL_ABBREVIATIONS[label]) {
        return MODEL_ABBREVIATIONS[label];
    }

    // Bucketed quota summary labels (e.g. "Gemini Models (5-Hour Limit)", "Claude and GPT models (Weekly Limit)")
    const bucketMatch = label.match(/^(Gemini(?:\s+Models)?|Claude\s+and\s+GPT(?:\s+models)?)\s*\(([^)]+)\)$/i);
    if (bucketMatch) {
        const family = bucketMatch[1].toLowerCase().includes('gemini') ? 'Gemini' : 'Claude/GPT';
        const windowStr = bucketMatch[2].toLowerCase();
        if (windowStr.includes('5-hour') || windowStr.includes('5h')) return `${family} (5h)`;
        if (windowStr.includes('weekly') || windowStr.includes('7d')) return `${family} (7d)`;
        return `${family} (${bucketMatch[2].trim()})`;
    }

    // Dynamic pattern for Orchestrator models:
    // e.g. "Orchestrator (Neon)" -> "Orch (Neon)"
    // e.g. "Orchestrator Gemini 4 Neon High" -> "Orch G4 Neon (H)"
    const orchGeminiMatch = label.match(/^Orchestrator\s+Gemini\s+(\d+(?:\.\d+)?)\s+([A-Za-z]+)(?:\s*\(([^)]+)\)|\s+(Low|Medium|High|XHigh|Max))?$/i);
    if (orchGeminiMatch) {
        const [, version, variant, parenTier, bareTier] = orchGeminiMatch;
        const tier = parenTier || bareTier;
        if (tier) {
            return `Orch G${version} ${variant} (${formatTierAbbreviation(tier)})`;
        }
        return `Orch G${version} ${variant}`;
    }

    const orchMatch = label.match(/^Orchestrator\s*\(([^)]+)\)$/i);
    if (orchMatch) {
        return `Orch (${orchMatch[1].trim()})`;
    }

    // Dynamic pattern for Gemini models:
    // e.g. "Gemini 4 Neon (High)" / "Gemini 4 Neon High" -> "Gemini 4 Neon (H)"
    // e.g. "Gemini 4 Neon (XHigh)" -> "Gemini 4 Neon (XH)"
    // e.g. "Gemini 3.8 Flash (Medium)" -> "Gemini 3.8 Flash (M)"
    const geminiMatch = label.match(/^Gemini\s+(\d+(?:\.\d+)?)\s+([A-Za-z]+)(?:\s*\(([^)]+)\)|\s+(Low|Medium|High|XHigh|Max|Thinking))?$/i);
    if (geminiMatch) {
        const [, version, variant, parenTier, bareTier] = geminiMatch;
        const tier = parenTier || bareTier;
        if (tier) {
            return `Gemini ${version} ${variant} (${formatTierAbbreviation(tier)})`;
        }
        return `Gemini ${version} ${variant}`;
    }

    // Dynamic pattern for Claude models:
    // e.g. "Claude Sonnet 4.6 (Thinking)" -> "Claude S4.6T"
    // e.g. "Claude Opus 5.5 (Medium)" / "Claude Opus 5.5 Medium" -> "Claude O5.5 (M)"
    const claudeMatch = label.match(/^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)?)(?:\s*\(([^)]+)\)|\s+(Low|Medium|High|XHigh|Max|Thinking))?$/i);
    if (claudeMatch) {
        const [, variant, version, parenExtra, bareExtra] = claudeMatch;
        const extra = parenExtra || bareExtra;
        const vAbbrev = variant[0].toUpperCase();
        if (extra) {
            if (/thinking/i.test(extra)) {
                return `Claude ${vAbbrev}${version}T`;
            }
            return `Claude ${vAbbrev}${version} (${formatTierAbbreviation(extra)})`;
        }
        return `Claude ${vAbbrev}${version}`;
    }

    // Dynamic pattern for GPT-OSS models: e.g. "GPT-OSS 120B (Medium)" -> "GPT-OSS (M)"
    const gptOssMatch = label.match(/^GPT-OSS(?:\s+[^()]+)?\s*\(([^)]+)\)$/i);
    if (gptOssMatch) {
        const tier = formatTierAbbreviation(gptOssMatch[1]);
        return `GPT-OSS (${tier})`;
    }

    // Fallback: generate abbreviation from first letters
    return label
        .split(/[\s\-_()]+/)
        .filter(Boolean)
        .map(word => {
            const match = word.match(/^([A-Za-z]?)(.*)$/);
            if (match) {
                // Keep numbers if present in word (e.g. GPT4 -> G4)
                return match[1].toUpperCase() + (word.match(/\d+/) || [''])[0];
            }
            return word[0]?.toUpperCase() || '';
        })
        .join('')
        .slice(0, 8);
}

/**
 * Formats a date to a friendly string (e.g., "Today 15:30", "Tomorrow 09:00").
 */
export function formatResetTime(date: Date): string {
    const now = new Date();
    const isToday = date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();

    // Check if tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = date.getDate() === tomorrow.getDate() && date.getMonth() === tomorrow.getMonth() && date.getFullYear() === tomorrow.getFullYear();

    const lm = LocalizationManager.getInstance();
    const locale = lm.getLocale();

    const timeStr = new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);

    if (isToday) return `${lm.t('Today')} ${timeStr}`;
    if (isTomorrow) return `${lm.t('Tomorrow')} ${timeStr}`;

    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

/**
 * Compare two models for sorting.
 */

export function compareModels(a: { remainingPercentage?: number, resetTime: Date }, b: { remainingPercentage?: number, resetTime: Date }, sortMethod: 'quota' | 'time'): number {
    const quotaA = a.remainingPercentage ?? 100;
    const quotaB = b.remainingPercentage ?? 100;
    const timeA = a.resetTime.getTime();
    const timeB = b.resetTime.getTime();

    const labelA = (a as any).label || '';
    const labelB = (b as any).label || '';

    if (sortMethod === 'quota') {
        // Highest quota first (100% ... 0%)
        if (quotaA !== quotaB) return quotaB - quotaA;
        // Secondary sort by label (Alphabetical)
        return labelA.localeCompare(labelB);
    } else {
        // Soonest reset first
        if (timeA !== timeB) return timeA - timeB;
        // Secondary sort by quota (Lowest first - most urgent)
        return quotaA - quotaB;
    }
}

/**
 * Estimates the total cycle duration based on the model label.
 */
export function getCycleDuration(label: string): number {
    // Weekly quota windows
    if (/weekly|7d/i.test(label)) {
        return 7 * 24 * 60 * 60 * 1000;
    }

    // 5h cycle models: Gemini 4, Orchestrator, Gemini 3.1 Pro, Gemini 3.8, Opus, Claude 5.x, Thinking, explicit 5-hour buckets
    if (
        /\b5h\b|5-hour/i.test(label) ||
        label.includes('Gemini 4') ||
        label.includes('Orchestrator') ||
        label.includes('Gemini 3.1 Pro') ||
        label.includes('Gemini 3.8') ||
        label.includes('Opus') ||
        label.includes('Sonnet 5') ||
        label.includes('Thinking')
    ) {
        return 5 * 60 * 60 * 1000;
    }

    // 6h cycle models
    if (label.includes('Ultra')) {
        return 6 * 60 * 60 * 1000;
    }

    // 8h cycle models (Legacy Pro?)
    if (label.includes('Pro')) {
        return 8 * 60 * 60 * 1000;
    }

    // Default 24h
    return 24 * 60 * 60 * 1000;
}

/**
 * Gets the status icon based on quota percentage and settings.
 */
import * as vscode from 'vscode';

export function getModelStatusIcon(remainingPercentage: number | undefined, isExhausted: boolean): string {
    const pct = remainingPercentage ?? 0;

    // Strict exhausted check
    if (isExhausted || pct === 0) {
        return '🔴';
    }

    const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
    const warning = config.get<number>('quota.thresholds.warning', 50);
    const critical = config.get<number>('quota.thresholds.critical', 30);
    // danger is usually 0, implied by isExhausted or 0 check above, but let's check config just in case user set it higher
    const danger = config.get<number>('quota.thresholds.danger', 0);

    if (pct <= danger) {
        return '🔴';
    } else if (pct <= critical) {
        return '🟠';
    } else if (pct <= warning) {
        return '🟡';
    }

    return '🟢';
}
