import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConversationsAsync, formatRelativeTime, ConversationItem } from './utils';
import { SyncManager } from './sync';

/**
 * Handle manual conflict resolution
 */
export async function resolveConflictsCommand(brainDir: string, convDir: string) {
    // 1. Scan for potential conflicts (folders with -conflict pattern)
    // Looking for pattern: {originalId}-conflict-{timestamp}

    // Get all directories
    const dirs = fs.readdirSync(brainDir).filter(d =>
        fs.statSync(path.join(brainDir, d)).isDirectory()
    );

    const conflicts: {
        conflictId: string;
        originalId: string;
        timestamp: string;
        title: string;
        lastModified: Date;
    }[] = [];

    const conflictRegex = /^(.*)-conflict-(\d+)$/;

    for (const dir of dirs) {
        const match = dir.match(conflictRegex);
        if (match) {
            const originalId = match[1];

            // Verify original exists
            if (fs.existsSync(path.join(brainDir, originalId))) {
                // Get title from task.md
                let title = dir;
                try {
                    const taskPath = path.join(brainDir, dir, 'task.md');
                    if (fs.existsSync(taskPath)) {
                        const content = fs.readFileSync(taskPath, 'utf8');
                        const m = content.match(/^#\s*Task:?\s*(.*)$/im);
                        if (m && m[1]) title = m[1].trim();
                    }
                } catch { }

                const stats = fs.statSync(path.join(brainDir, dir));

                conflicts.push({
                    conflictId: dir,
                    originalId: originalId,
                    timestamp: match[2],
                    title: title,
                    lastModified: stats.mtime
                });
            }
        }
    }

    if (conflicts.length === 0) {
        vscode.window.showInformationMessage('No detected conflict copies found.');
        return;
    }

    // 2. Show QuickPick to select a conflict pair to resolve
    const items = conflicts.map(c => ({
        label: `$(diff) ${c.title}`,
        description: `Conflict copy from ${formatRelativeTime(c.lastModified.toISOString())}`,
        detail: `Original ID: ${c.originalId} | Conflict ID: ${c.conflictId}`,
        conflict: c
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${conflicts.length} conflict copies. Select one to resolve.`
    });

    if (!selected) return;

    const c = selected.conflict;

    // 3. Show Action Options
    const action = await vscode.window.showWarningMessage(
        `Resolve conflict for "${c.title}"?`,
        { modal: true, detail: `Conflict copy: ${c.conflictId}\nOriginal: ${c.originalId}` },
        'Keep Original (Delete Copy)',
        'Keep Conflict (Overwrite Original)',
        'Cancel'
    );

    if (action === 'Keep Original (Delete Copy)') {
        try {
            // Delete conflict folder
            fs.rmSync(path.join(brainDir, c.conflictId), { recursive: true, force: true });
            // Delete conflict .pb
            const pbPath = path.join(convDir, `${c.conflictId}.pb`);
            if (fs.existsSync(pbPath)) fs.unlinkSync(pbPath);

            vscode.window.showInformationMessage(`Conflict resolved: Start version kept.`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to delete conflict copy: ${e.message}`);
        }
    } else if (action === 'Keep Conflict (Overwrite Original)') {
        try {
            // 1. Delete original folder
            const originalPath = path.join(brainDir, c.originalId);
            fs.rmSync(originalPath, { recursive: true, force: true });

            // 2. Rename conflict folder to original
            fs.renameSync(path.join(brainDir, c.conflictId), originalPath);

            // 3. Handle PB files
            const conflictPb = path.join(convDir, `${c.conflictId}.pb`);
            const originalPb = path.join(convDir, `${c.originalId}.pb`);

            if (fs.existsSync(originalPb)) fs.unlinkSync(originalPb);
            if (fs.existsSync(conflictPb)) fs.renameSync(conflictPb, originalPb);

            vscode.window.showInformationMessage(`Conflict resolved: Conflict version kept.`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to overwrite original: ${e.message}`);
        }
    }
}
