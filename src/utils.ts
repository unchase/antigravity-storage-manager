import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LocalizationManager } from './l10n/localizationManager';

export interface ConversationItem extends vscode.QuickPickItem {
    id: string;
    lastModified: Date;
    createdAt: Date;
    status?: 'synced' | 'imported' | 'local' | 'conflict';
}

/**
 * Format relative time (e.g. "2 hours ago")
 */
export function formatRelativeTime(dateInput: Date | string): string {
    const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    const lm = LocalizationManager.getInstance();

    if (days > 7) {
        return date.toLocaleDateString(lm.getLocale());
    } else if (days > 1) {
        return lm.t('{0} days ago', days);
    } else if (days > 0) {
        return lm.t('{0} day ago', days);
    } else if (hours > 1) {
        return lm.t('{0} hours ago', hours);
    } else if (hours > 0) {
        return lm.t('{0} hour ago', hours);
    } else if (minutes > 1) {
        return lm.t('{0} mins ago', minutes);
    } else if (minutes > 0) {
        return lm.t('{0} min ago', minutes);
    } else {
        return lm.t('Just now');
    }
}

/**
 * Get conversations asynchronously with metadata
 */
export async function getConversationsAsync(brainDir: string): Promise<ConversationItem[]> {
    if (!fs.existsSync(brainDir)) {
        return [];
    }

    try {
        const entries = await fs.promises.readdir(brainDir);

        const jobs = entries.map(async (id) => {
            const dirPath = path.join(brainDir, id);
            try {
                const stats = await fs.promises.stat(dirPath);
                if (!stats.isDirectory()) return null;

                let label = id;
                const parseTitle = async (filename: string): Promise<string | null> => {
                    try {
                        const filePath = path.join(dirPath, filename);
                        // Check existence first to avoid reading error noise
                        try {
                            await fs.promises.access(filePath);
                        } catch {
                            return null;
                        }

                        const content = await fs.promises.readFile(filePath, 'utf8');
                        // Match "# Task: Title" OR "# Title"
                        // Also cleanup some common suffixes if needed, but keeping it simple for now
                        const match = content.match(/^#\s*(?:Task:?\s*)?(.+)$/im);
                        if (match && match[1]) {
                            return match[1].trim();
                        }
                    } catch {
                        // Ignore errors
                    }
                    return null;
                };

                // Priority 1: .pb file (via heuristic extraction)
                try {
                    const { PbParser } = require('./quota/pbParser');
                    const conversationsDir = path.join(brainDir, '..', 'conversations');
                    const pbPath = path.join(conversationsDir, `${id}.pb`);
                    const pbTitle = await PbParser.extractTitle(pbPath);
                    if (pbTitle) {
                        label = pbTitle;
                    }
                } catch {
                    // Ignore errors from pb parsing or missing files
                }

                // Priority 2: task.md > implementation_plan.md > walkthrough.md (only if label is still UUID)
                if (label === id) {
                    const titleSourceFiles = ['task.md', 'implementation_plan.md', 'walkthrough.md'];

                    for (const file of titleSourceFiles) {
                        const foundTitle = await parseTitle(file);
                        if (foundTitle) {
                            label = foundTitle;
                            break;
                        }
                    }
                }

                const lm = LocalizationManager.getInstance();
                return {
                    label: label,
                    description: id,
                    detail: `${lm.t('Created')}: ${lm.formatDateTime(stats.birthtime)} | ${lm.t('Modified')}: ${lm.formatDateTime(stats.mtime)}`,
                    id: id,
                    lastModified: stats.mtime,
                    createdAt: stats.birthtime
                } as ConversationItem;

            } catch (e: any) {
                const lm = LocalizationManager.getInstance();
                vscode.window.showErrorMessage(lm.t('Error processing {0}: {1}', dirPath, e.message));
                return null;
            }
        });

        const results = await Promise.all(jobs);
        const items = results.filter((i): i is ConversationItem => i !== null);

        // Sort by newer first
        items.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
        return items;

    } catch (e: any) {
        const lm = LocalizationManager.getInstance();
        vscode.window.showErrorMessage(lm.t('Error loading conversations: {0}', e.message));
        return [];
    }
}

/**
 * Run tasks with limited concurrency
 */
export async function limitConcurrency<T>(
    items: T[],
    limit: number,
    task: (item: T) => Promise<void>,
    token?: vscode.CancellationToken
): Promise<void> {
    const workerCount = Math.min(limit, items.length);
    if (workerCount <= 0) return;

    const queue = [...items]; // Clone to consume

    const worker = async () => {
        while (queue.length > 0) {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            const item = queue.shift();
            if (!item) break;

            await task(item);
        }
    };

    // Start workers
    await Promise.all(Array(workerCount).fill(null).map(() => worker()));
}

/**
 * Format duration in ms to a readable string (e.g. "2d 5h 30m")
 */
export function formatDuration(ms: number): string {
    const d = Math.floor(ms / (1000 * 60 * 60 * 24));
    const h = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((ms % (1000 * 60)) / 1000);

    const lm = LocalizationManager.getInstance();
    const dText = lm.t('d');
    const hText = lm.t('h');
    const mText = lm.t('m');
    const sText = lm.t('s');

    const parts: string[] = [];
    if (d > 0) parts.push(`${d}${dText}`);
    if (h > 0) parts.push(`${h}${hText}`);
    if (m > 0) parts.push(`${m}${mText}`);
    if (s > 0 || parts.length === 0) parts.push(`${s}${sText}`);

    return parts.join(' ');
}

/**
 * Format bytes to human readable string
 */
export function formatSize(bytes?: number): string {
    if (bytes === undefined || bytes === null) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Get total size of a directory recursively
 */
export function getDirectorySize(dirPath: string): number {
    let total = 0;
    if (!fs.existsSync(dirPath)) return 0;

    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
                total += getDirectorySize(filePath);
            } else {
                total += stats.size;
            }
        }
    } catch {
        // ignore access errors
    }
    return total;
}
