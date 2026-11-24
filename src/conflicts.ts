import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { formatRelativeTime, formatSize, getDirectorySize } from './utils';
import { LocalizationManager } from './l10n/localizationManager';

const SAFE_CONFLICT_ID_REGEX = /^([a-zA-Z0-9][a-zA-Z0-9_-]*)-conflict-(\d+)$/;
const CONV_EXTS = ['.pb', '.db', '.db-wal', '.db-shm'] as const;

export interface DetectedConflictCopy {
    conflictId: string;
    originalId: string;
    timestamp: string;
    title: string;
    lastModified: Date;
    size: number;
    hasOriginal: boolean;
}

/**
 * Validates that a resolved target path stays strictly inside baseDir.
 */
export function resolveStrictChildPath(baseDir: string, entryName: string): string {
    if (!entryName || entryName === '.' || entryName === '..' || /[/\\\0]/.test(entryName)) {
        throw new Error(`Invalid entry name: ${entryName}`);
    }
    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(resolvedBase, entryName);
    const rel = path.relative(resolvedBase, resolvedTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path escapes base directory: ${entryName}`);
    }
    return resolvedTarget;
}

/**
 * Scans both brainDir and convDir for `{originalId}-conflict-{timestamp}` entries safely.
 */
export function scanConflictCopies(brainDir: string, convDir: string): DetectedConflictCopy[] {
    const foundMap = new Map<string, { originalId: string; timestamp: string }>();

    if (fs.existsSync(brainDir)) {
        try {
            const entries = fs.readdirSync(brainDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
                const match = entry.name.match(SAFE_CONFLICT_ID_REGEX);
                if (match) {
                    foundMap.set(entry.name, { originalId: match[1], timestamp: match[2] });
                }
            }
        } catch {
            // Ignore unreadable brainDir
        }
    }

    if (fs.existsSync(convDir)) {
        try {
            const entries = fs.readdirSync(convDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isSymbolicLink() || !entry.isFile()) continue;
                const match = entry.name.match(/^([a-zA-Z0-9][a-zA-Z0-9_-]*)-conflict-(\d+)\.(?:db|pb)$/i);
                if (match) {
                    const conflictId = `${match[1]}-conflict-${match[2]}`;
                    if (!foundMap.has(conflictId)) {
                        foundMap.set(conflictId, { originalId: match[1], timestamp: match[2] });
                    }
                }
            }
        } catch {
            // Ignore unreadable convDir
        }
    }

    const conflicts: DetectedConflictCopy[] = [];
    for (const [conflictId, info] of foundMap.entries()) {
        try {
            const conflictBrainPath = resolveStrictChildPath(brainDir, conflictId);
            const originalBrainPath = resolveStrictChildPath(brainDir, info.originalId);

            const hasOriginalBrain = fs.existsSync(originalBrainPath);
            const hasOriginalConv = CONV_EXTS.some(ext => {
                try {
                    return fs.existsSync(resolveStrictChildPath(convDir, `${info.originalId}${ext}`));
                } catch {
                    return false;
                }
            });

            let title = conflictId;
            if (fs.existsSync(conflictBrainPath)) {
                try {
                    const taskPath = path.join(conflictBrainPath, 'task.md');
                    if (fs.existsSync(taskPath)) {
                        const content = fs.readFileSync(taskPath, 'utf8');
                        const m = content.match(/^#\s*Task:?\s*(.*)$/im);
                        if (m && m[1]) title = m[1].trim();
                    }
                } catch {
                    // ignore
                }
            }

            let size = 0;
            let lastModifiedMs = 0;
            if (fs.existsSync(conflictBrainPath)) {
                try {
                    const stats = fs.lstatSync(conflictBrainPath);
                    lastModifiedMs = Math.max(lastModifiedMs, stats.mtimeMs);
                    size += getDirectorySize(conflictBrainPath);
                } catch {
                    // ignore
                }
            }
            for (const ext of CONV_EXTS) {
                const fPath = resolveStrictChildPath(convDir, `${conflictId}${ext}`);
                if (fs.existsSync(fPath)) {
                    try {
                        const stats = fs.lstatSync(fPath);
                        size += stats.size;
                        lastModifiedMs = Math.max(lastModifiedMs, stats.mtimeMs);
                    } catch {
                        // ignore
                    }
                }
            }

            conflicts.push({
                conflictId,
                originalId: info.originalId,
                timestamp: info.timestamp,
                title,
                lastModified: new Date(lastModifiedMs || Number(info.timestamp) || Date.now()),
                size,
                hasOriginal: hasOriginalBrain || hasOriginalConv
            });
        } catch {
            // Skip invalid/unsafe names
        }
    }

    conflicts.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return conflicts;
}

/**
 * Atomically replaces the original conversation (brain + conversations files) with the conflict copy,
 * rolling back completely if any filesystem operation fails (e.g., EBUSY on Windows).
 */
export function applyKeepConflictSafely(
    brainDir: string,
    convDir: string,
    originalId: string,
    conflictId: string,
    renameFn: (oldPath: fs.PathLike, newPath: fs.PathLike) => void = fs.renameSync
): void {
    const originalBrainPath = resolveStrictChildPath(brainDir, originalId);
    const conflictBrainPath = resolveStrictChildPath(brainDir, conflictId);
    const stagingTag = `.resolve-bak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const movedOriginals: Array<{ original: string; backup: string }> = [];
    const movedConflicts: Array<{ conflict: string; target: string }> = [];

    try {
        // Phase 1: move existing original files/folder aside into staging backup
        if (fs.existsSync(originalBrainPath)) {
            const bakBrain = resolveStrictChildPath(brainDir, `${originalId}${stagingTag}`);
            renameFn(originalBrainPath, bakBrain);
            movedOriginals.push({ original: originalBrainPath, backup: bakBrain });
        }

        for (const ext of CONV_EXTS) {
            const origFile = resolveStrictChildPath(convDir, `${originalId}${ext}`);
            if (fs.existsSync(origFile)) {
                const bakFile = resolveStrictChildPath(convDir, `${originalId}${stagingTag}${ext}`);
                renameFn(origFile, bakFile);
                movedOriginals.push({ original: origFile, backup: bakFile });
            }
        }

        // Phase 2: promote conflict files/folder into original slots (skip ephemeral .db-shm)
        if (fs.existsSync(conflictBrainPath)) {
            renameFn(conflictBrainPath, originalBrainPath);
            movedConflicts.push({ conflict: conflictBrainPath, target: originalBrainPath });
        }

        for (const ext of ['.pb', '.db', '.db-wal'] as const) {
            const confFile = resolveStrictChildPath(convDir, `${conflictId}${ext}`);
            const origFile = resolveStrictChildPath(convDir, `${originalId}${ext}`);
            if (fs.existsSync(confFile)) {
                renameFn(confFile, origFile);
                movedConflicts.push({ conflict: confFile, target: origFile });
            }
        }

        // Clean up ephemeral conflict .db-shm if present
        const confShm = resolveStrictChildPath(convDir, `${conflictId}.db-shm`);
        if (fs.existsSync(confShm)) {
            try { fs.unlinkSync(confShm); } catch { /* ignore */ }
        }

        // Phase 3: delete staging backups only after full promotion succeeded
        for (const item of movedOriginals) {
            try {
                fs.rmSync(item.backup, { recursive: true, force: true });
            } catch {
                // Best effort cleanup
            }
        }
    } catch (error) {
        // Rollback in reverse order
        for (const item of movedConflicts.reverse()) {
            try {
                if (fs.existsSync(item.target)) {
                    fs.renameSync(item.target, item.conflict);
                }
            } catch {
                // Best effort rollback
            }
        }
        for (const item of movedOriginals.reverse()) {
            try {
                if (fs.existsSync(item.backup)) {
                    fs.renameSync(item.backup, item.original);
                }
            } catch {
                // Best effort rollback
            }
        }
        throw error;
    }
}

/**
 * Handle manual conflict resolution
 */
export async function resolveConflictsCommand(brainDir: string, convDir: string) {
    const lm = LocalizationManager.getInstance();
    const conflicts = scanConflictCopies(brainDir, convDir);

    if (conflicts.length === 0) {
        vscode.window.showInformationMessage(lm.t('No detected conflict copies found.'));
        return;
    }

    const items = conflicts.map(c => ({
        label: `$(diff) ${c.title}`,
        description: lm.t("{0} • {1}", formatRelativeTime(c.lastModified.toISOString()), formatSize(c.size)),
        detail: lm.t("Original ID: {0} | Conflict ID: {1}", c.originalId, c.conflictId),
        conflict: c
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: lm.t("Found {0} conflict copies. Select one to resolve.", conflicts.length)
    });

    if (!selected) return;

    const c = selected.conflict;
    const keepOriginal = lm.t('Keep Original (Delete Copy)');
    const keepConflict = lm.t('Keep Conflict (Overwrite Original)');
    const cancel = lm.t('Cancel');

    let originalSize = 0;
    let originalMtime = new Date(0);
    try {
        const originalPath = resolveStrictChildPath(brainDir, c.originalId);
        if (fs.existsSync(originalPath)) {
            originalSize += getDirectorySize(originalPath);
            originalMtime = fs.lstatSync(originalPath).mtime;
        }
        for (const ext of CONV_EXTS) {
            const origFile = resolveStrictChildPath(convDir, `${c.originalId}${ext}`);
            if (fs.existsSync(origFile)) {
                const st = fs.lstatSync(origFile);
                originalSize += st.size;
                if (st.mtimeMs > originalMtime.getTime()) originalMtime = st.mtime;
            }
        }
    } catch {
        // Ignore stat errors for missing original
    }

    const action = await vscode.window.showWarningMessage(
        lm.t("Resolve conflict for \"{0}\"?", c.title),
        {
            modal: true,
            detail: [
                lm.t("Conflict Copy: {0} ({1})", formatSize(c.size), lm.formatDateTime(c.lastModified)),
                c.hasOriginal
                    ? lm.t("Original: {0} ({1})", formatSize(originalSize), lm.formatDateTime(originalMtime))
                    : `${lm.t("Original ID: {0} | Conflict ID: {1}", c.originalId, c.conflictId)}`,
                '',
                lm.t("Choose which version to keep. The other will be permanently deleted.")
            ].join('\n')
        },
        keepOriginal,
        keepConflict,
        cancel
    );

    if (action === keepOriginal) {
        try {
            const conflictBrainPath = resolveStrictChildPath(brainDir, c.conflictId);
            if (fs.existsSync(conflictBrainPath)) {
                fs.rmSync(conflictBrainPath, { recursive: true, force: true });
            }
            for (const ext of CONV_EXTS) {
                const filePath = resolveStrictChildPath(convDir, `${c.conflictId}${ext}`);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }

            vscode.window.showInformationMessage(lm.t("Conflict resolved: Start version kept."));
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t("Failed to delete conflict copy: {0}", e.message));
        }
    } else if (action === keepConflict) {
        try {
            applyKeepConflictSafely(brainDir, convDir, c.originalId, c.conflictId);
            vscode.window.showInformationMessage(lm.t("Conflict resolved: Conflict version kept."));
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t("Failed to overwrite original: {0}", e.message));
        }
    }
}
