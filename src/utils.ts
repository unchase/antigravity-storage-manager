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

    if (days > 7) {
        return date.toLocaleDateString();
    } else if (days > 0) {
        return `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
        return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (minutes > 1) {
        return `${minutes} mins ago`;
    } else if (minutes > 0) {
        return `${minutes} min ago`;
    } else {
        return 'Just now';
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
                const taskPath = path.join(dirPath, 'task.md');

                try {
                    const content = await fs.promises.readFile(taskPath, 'utf8');
                    // Match "# Task: Title" OR "# Title"
                    const match = content.match(/^#\s*(?:Task:?\s*)?(.+)$/im);
                    if (match && match[1]) {
                        label = match[1].trim();
                    }
                } catch {
                    // Ignore task.md errors
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

            } catch (e) {
                console.error(`Error processing ${dirPath}:`, e);
                return null;
            }
        });

        const results = await Promise.all(jobs);
        const items = results.filter((i): i is ConversationItem => i !== null);

        // Sort by newer first
        items.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
        return items;

    } catch (e) {
        console.error('Error loading conversations:', e);
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

    const lm = LocalizationManager.getInstance();
    const dText = lm.t('d');
    const hText = lm.t('h');
    const mText = lm.t('m');

    const parts: string[] = [];
    if (d > 0) parts.push(`${d}${dText}`);
    if (h > 0) parts.push(`${h}${hText}`);
    if (m > 0 || parts.length === 0) parts.push(`${m}${mText}`);

    return parts.join(' ');
}
