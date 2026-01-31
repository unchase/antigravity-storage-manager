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
    'Gemini 3 Pro (High)': 'Gemini 3 Pro (H)',
    'Gemini 3 Pro (Low)': 'Gemini 3 Pro (L)',
    'Gemini 3 Flash': 'Gemini 3 Flash',
    'Claude Sonnet 4.5': 'Claude S4.5',
    'Claude Sonnet 4.5 (Thinking)': 'Claude S4.5T',
    'Claude Opus 4.5 (Thinking)': 'Claude O4.5T',
    'GPT-OSS 120B (Medium)': 'GPT-OSS (M)',
};

/**
 * Gets a short abbreviation for a model label.
 */
export function getModelAbbreviation(label: string): string {
    if (MODEL_ABBREVIATIONS[label]) {
        return MODEL_ABBREVIATIONS[label];
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
    // Gemini 3 Pro, Opus, and Thinking seem to have a 5h cycle
    if (label.includes('Gemini 3 Pro') || label.includes('Opus') || label.includes('Thinking')) {
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
