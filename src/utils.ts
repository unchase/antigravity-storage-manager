import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalizationManager } from './l10n/localizationManager';

export interface StoragePaths {
    storageRoot: string;
    brainDir: string;
    convDir: string;
}

/**
 * Get resolved storage paths for Antigravity data.
 * Checks user setting first, then detects Antigravity IDE (~/.gemini/antigravity-ide),
 * and falls back to standard directory (~/.gemini/antigravity).
 */
export function getStoragePaths(): StoragePaths {
    const config = vscode.workspace?.getConfiguration?.('antigravity-storage-manager');
    const customPath = config?.get<string>('storagePath')?.trim();
    if (customPath && customPath.length > 0) {
        return {
            storageRoot: customPath,
            brainDir: path.join(customPath, 'brain'),
            convDir: path.join(customPath, 'conversations')
        };
    }

    const homedir = os.homedir();
    const ideDir = path.join(homedir, '.gemini', 'antigravity-ide');
    const standardDir = path.join(homedir, '.gemini', 'antigravity');

    const appName = vscode.env?.appName || '';
    const appRoot = vscode.env?.appRoot || '';
    const isAntigravityIDE =
        appName.toLowerCase().includes('antigravity') ||
        appRoot.toLowerCase().includes('antigravity');

    let chosenRoot = standardDir;
    if (isAntigravityIDE) {
        if (fs.existsSync(ideDir) || !fs.existsSync(standardDir)) {
            chosenRoot = ideDir;
        }
    } else if (fs.existsSync(ideDir)) {
        chosenRoot = ideDir;
    }

    return {
        storageRoot: chosenRoot,
        brainDir: path.join(chosenRoot, 'brain'),
        convDir: path.join(chosenRoot, 'conversations')
    };
}

export interface ConversationItem extends vscode.QuickPickItem {
    id: string;
    lastModified: Date;
    createdAt: Date;
    status?: 'synced' | 'imported' | 'local' | 'conflict';
    text?: string;
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
    const conversationsDir = path.join(brainDir, '..', 'conversations');
    const brainExists = fs.existsSync(brainDir);
    const convExists = fs.existsSync(conversationsDir);

    if (!brainExists && !convExists) {
        return [];
    }

    try {
        const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        const convIds = new Set<string>();

        if (brainExists) {
            const entries = await fs.promises.readdir(brainDir);
            for (const id of entries) {
                if (isUuid(id)) {
                    try {
                        const stats = await fs.promises.stat(path.join(brainDir, id));
                        if (stats.isDirectory()) {
                            convIds.add(id);
                        }
                    } catch {
                        // ignore
                    }
                }
            }
        }

        if (convExists) {
            const convEntries = await fs.promises.readdir(conversationsDir);
            for (const entry of convEntries) {
                const match = entry.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:db|pb)$/i);
                if (match) {
                    convIds.add(match[1]);
                }
            }
        }

        // Read concurrency limit from settings (reuse sync.concurrency)
        const concurrencyLimit = Math.max(1, vscode.workspace.getConfiguration('antigravity-storage-manager').get<number>('sync.concurrency', 3) || 3);

        const jobFactories = Array.from(convIds).map((id) => async (): Promise<ConversationItem | null> => {
            const dirPath = path.join(brainDir, id);
            try {
                let hasBrainDir = false;
                let dirStats: fs.Stats | null = null;
                try {
                    dirStats = await fs.promises.stat(dirPath);
                    hasBrainDir = dirStats.isDirectory();
                } catch {
                    hasBrainDir = false;
                }

                let label = id;
                const parseTitle = async (filename: string): Promise<string | null> => {
                    if (!hasBrainDir) return null;
                    try {
                        const filePath = path.join(dirPath, filename);
                        // Check existence first to avoid reading error noise
                        try {
                            await fs.promises.access(filePath);
                        } catch {
                            return null;
                        }

                        const content = await fs.promises.readFile(filePath, 'utf8');
                        // Match "# Task: Title", "# Plan: Title", "# Implementation Plan: Title" OR "# Title"
                        // Also cleanup some common suffixes if needed, but keeping it simple for now
                        const match = content.match(/^#\s*(?:Task:?\s*|Plan:?\s*|Implementation Plan:?\s*)?(.+)$/im);
                        if (match && match[1]) {
                            return match[1].trim().replace(/^\[.*?\]\s*/, ''); // Remove leading badges like [Draft]
                        }
                    } catch {
                        // Ignore errors
                    }
                    return null;
                };

                // Priority 1: .db/.pb file (via heuristic extraction and for timestamps)
                let modDate = dirStats ? dirStats.mtime : new Date();
                let birthDate = dirStats ? dirStats.birthtime : new Date();
                try {
                    const { PbParser } = await import('./quota/pbParser');
                    const conversationsDir = path.join(brainDir, '..', 'conversations');
                    const dbPath = path.join(conversationsDir, `${id}.db`);
                    const pbPath = path.join(conversationsDir, `${id}.pb`);
                    const activePath = fs.existsSync(dbPath) ? dbPath : (fs.existsSync(pbPath) ? pbPath : null);

                    if (activePath) {
                        const fileStats = fs.statSync(activePath);
                        modDate = fileStats.mtime;
                        birthDate = fileStats.birthtime;

                        const pbTitle = await PbParser.extractTitle(activePath);
                        if (pbTitle && !pbTitle.startsWith('SQLite format') && pbTitle.trim().length > 0) {
                            label = pbTitle.trim();
                        }
                    }
                } catch {
                    // Ignore errors from pb parsing or missing files
                }

                // Priority 2: task.md > implementation_plan.md > walkthrough.md (only if label is still UUID)
                if (label === id) {
                    const titleSourceFiles = ['task.md', 'implementation_plan.md', 'walkthrough.md'];

                    for (const file of titleSourceFiles) {
                        const foundTitle = await parseTitle(file);
                        if (foundTitle && !foundTitle.startsWith('SQLite format') && foundTitle.trim().length > 0) {
                            label = foundTitle.trim();
                            break;
                        }
                    }
                }

                // Priority 3: First user prompt from transcript.jsonl (only if label is still UUID)
                if (label === id) {
                    try {
                        const transcriptPath = path.join(dirPath, '.system_generated', 'logs', 'transcript.jsonl');
                        if (fs.existsSync(transcriptPath)) {
                            const handle = await fs.promises.open(transcriptPath, 'r');
                            const buffer = Buffer.alloc(8192);
                            const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
                            await handle.close();
                            const text = buffer.toString('utf8', 0, bytesRead);
                            const lines = text.split('\n');

                            for (const line of lines) {
                                if (!line.trim()) continue;
                                try {
                                    const parsed = JSON.parse(line);
                                    const isUser = parsed.type === 'USER_INPUT' || parsed.source === 'USER_EXPLICIT' || parsed.role === 'user';
                                    if (isUser && parsed.content && typeof parsed.content === 'string') {
                                        const clean = parsed.content
                                            .replace(/<[^>]+>/g, '')
                                            .replace(/^#\s*/, '')
                                            .trim()
                                            .split('\n')[0]
                                            .trim();
                                        if (clean.length > 0 && !clean.startsWith('SQLite format')) {
                                            label = clean.length > 60 ? clean.substring(0, 57) + '...' : clean;
                                            break;
                                        }
                                    }
                                } catch {
                                    // continue
                                }
                            }
                        }
                    } catch {
                        // Ignore errors from transcript reading
                    }
                }

                const lm = LocalizationManager.getInstance();
                return {
                    label: label,
                    description: id,
                    detail: `${lm.t('Created')}: ${lm.formatDateTime(birthDate)} | ${lm.t('Modified')}: ${lm.formatDateTime(modDate)}`,
                    id: id,
                    lastModified: modDate,
                    createdAt: birthDate
                } as ConversationItem;

            } catch (e: any) {
                const lm = LocalizationManager.getInstance();
                vscode.window.showErrorMessage(lm.t('Error processing {0}: {1}', dirPath, e.message));
                return null;
            }
        });

        // Use limited concurrency worker pool instead of unbounded Promise.all
        const results: (ConversationItem | null)[] = [];
        const queue = [...jobFactories];
        const worker = async () => {
            while (queue.length > 0) {
                const factory = queue.shift();
                if (!factory) break;
                results.push(await factory());
            }
        };
        await Promise.all(Array(Math.min(concurrencyLimit, jobFactories.length)).fill(null).map(() => worker()));

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
