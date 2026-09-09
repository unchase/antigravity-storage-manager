import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import extract from 'extract-zip';
import { LocalizationManager } from './l10n/localizationManager';
import { PbParser } from './quota/pbParser';
import { formatSize } from './utils';

export interface IdeStatePaths {
    globalStorageDir: string;
    stateVscdbPath: string;
    workspaceStorageDir: string;
    exists: boolean;
}

/**
 * Resolves Antigravity IDE globalStorage and workspaceStorage paths across platforms.
 */
export function getIdeStatePaths(): IdeStatePaths {
    const platform = process.platform;
    let baseDir = '';

    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const primary = path.join(appData, 'Antigravity IDE', 'User');
        const fallback = path.join(appData, 'Antigravity', 'User');
        baseDir = fs.existsSync(primary) ? primary : (fs.existsSync(fallback) ? fallback : primary);
    } else if (platform === 'darwin') {
        const primary = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User');
        const fallback = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User');
        baseDir = fs.existsSync(primary) ? primary : (fs.existsSync(fallback) ? fallback : primary);
    } else {
        const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        const primary = path.join(configDir, 'Antigravity IDE', 'User');
        const fallback = path.join(configDir, 'Antigravity', 'User');
        baseDir = fs.existsSync(primary) ? primary : (fs.existsSync(fallback) ? fallback : primary);
    }

    const globalStorageDir = path.join(baseDir, 'globalStorage');
    const stateVscdbPath = path.join(globalStorageDir, 'state.vscdb');
    const workspaceStorageDir = path.join(baseDir, 'workspaceStorage');

    return {
        globalStorageDir,
        stateVscdbPath,
        workspaceStorageDir,
        exists: fs.existsSync(stateVscdbPath)
    };
}

/**
 * Rebuilds the conversation index and verifies directory integrity between brain/ and conversations/.
 * Ensures Antigravity IDE history doesn't grey out or fail to locate trajectory files.
 */
export async function reindexConversationsCommand(brainDir: string, convDir: string): Promise<void> {
    const lm = LocalizationManager.getInstance();

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: lm.t('Rebuilding Antigravity Conversation Index...'),
        cancellable: false
    }, async () => {
        let restoredBrainDirs = 0;
        let restoredTasks = 0;
        let totalConversations = 0;

        const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        const convIds = new Set<string>();

        // 1. Collect all conversation IDs from conversations/
        if (fs.existsSync(convDir)) {
            const files = fs.readdirSync(convDir);
            for (const file of files) {
                const match = file.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:db|pb)$/i);
                if (match) {
                    convIds.add(match[1]);
                }
            }
        }

        // 2. Collect all conversation IDs from brain/
        if (fs.existsSync(brainDir)) {
            const dirs = fs.readdirSync(brainDir);
            for (const d of dirs) {
                if (isUuid(d)) {
                    try {
                        if (fs.statSync(path.join(brainDir, d)).isDirectory()) {
                            convIds.add(d);
                        }
                    } catch {
                        // ignore
                    }
                }
            }
        }

        totalConversations = convIds.size;

        if (totalConversations === 0) {
            vscode.window.showInformationMessage(lm.t('No conversations found to reindex.'));
            return;
        }

        // 3. Verify each conversation has an intact brain directory and task.md
        if (!fs.existsSync(brainDir)) {
            fs.mkdirSync(brainDir, { recursive: true });
        }

        for (const id of Array.from(convIds)) {
            const bDir = path.join(brainDir, id);
            if (!fs.existsSync(bDir)) {
                fs.mkdirSync(bDir, { recursive: true });
                restoredBrainDirs++;
            }

            const taskFile = path.join(bDir, 'task.md');
            if (!fs.existsSync(taskFile)) {
                let title = id;
                const dbFile = path.join(convDir, `${id}.db`);
                const pbFile = path.join(convDir, `${id}.pb`);
                const activeFile = fs.existsSync(dbFile) ? dbFile : (fs.existsSync(pbFile) ? pbFile : null);

                if (activeFile) {
                    try {
                        const parsedTitle = await PbParser.extractTitle(activeFile);
                        if (parsedTitle && !parsedTitle.startsWith('SQLite format') && parsedTitle.trim().length > 0) {
                            title = parsedTitle.trim();
                        }
                    } catch {
                        // ignore
                    }
                }

                try {
                    fs.writeFileSync(taskFile, `# Task: ${title}\n\n*Restored index on ${new Date().toISOString()}*\n`, 'utf8');
                    restoredTasks++;
                } catch {
                    // ignore
                }
            }
        }

        const idePaths = getIdeStatePaths();
        const stateStatus = idePaths.exists ? lm.t('IDE State database located ({0})', formatSize(fs.statSync(idePaths.stateVscdbPath).size)) : lm.t('IDE State database not found at standard path.');

        const resultMsg = lm.t(
            'Reindexed {0} conversation(s). Restored {1} missing brain folder(s) and {2} task description(s). {3}',
            totalConversations,
            restoredBrainDirs,
            restoredTasks,
            stateStatus
        );

        const reloadChoice = await vscode.window.showInformationMessage(
            resultMsg,
            lm.t('Export IDE State'),
            lm.t('Reload Window')
        );

        if (reloadChoice === lm.t('Export IDE State')) {
            await exportIdeStateCommand();
        } else if (reloadChoice === lm.t('Reload Window')) {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
}

/**
 * Exports Antigravity IDE internal state (state.vscdb and workspaceStorage) to a ZIP archive.
 */
export async function exportIdeStateCommand(): Promise<void> {
    const lm = LocalizationManager.getInstance();
    const idePaths = getIdeStatePaths();

    if (!idePaths.exists) {
        vscode.window.showWarningMessage(lm.t('Antigravity IDE state database not found at {0}.', idePaths.stateVscdbPath));
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `antigravity-ide-state-${timestamp}.zip`;
    const defaultUri = vscode.Uri.file(path.join(os.homedir(), 'Desktop', defaultName));

    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: defaultUri,
        filters: { 'Antigravity State Archive': ['zip'] },
        saveLabel: lm.t('Export State')
    });

    if (!saveUri) return;

    const destPath = saveUri.fsPath;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: lm.t('Exporting Antigravity IDE State...'),
        cancellable: true
    }, async (_progress, token) => {
        return new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(destPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            token.onCancellationRequested(() => {
                archive.abort();
                output.close();
                fs.unlink(destPath, () => { });
                reject(new vscode.CancellationError());
            });

            output.on('close', () => {
                const stats = fs.statSync(destPath);
                vscode.window.showInformationMessage(
                    lm.t('Exported Antigravity IDE State ({0}) to {1}', formatSize(stats.size), destPath),
                    lm.t('Show in Folder')
                ).then(selection => {
                    if (selection === lm.t('Show in Folder')) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destPath));
                    }
                });
                resolve();
            });

            archive.on('error', (err) => {
                vscode.window.showErrorMessage(lm.t('State export failed: {0}', err.message));
                reject(err);
            });

            archive.pipe(output);

            // Add state.vscdb
            if (fs.existsSync(idePaths.stateVscdbPath)) {
                archive.file(idePaths.stateVscdbPath, { name: 'state.vscdb' });
            }

            // Add workspaceStorage if present
            if (fs.existsSync(idePaths.workspaceStorageDir)) {
                archive.directory(idePaths.workspaceStorageDir, 'workspaceStorage');
            }

            archive.finalize();
        });
    });
}

/**
 * Imports Antigravity IDE internal state from a ZIP archive or state.vscdb file.
 */
export async function importIdeStateCommand(): Promise<void> {
    const lm = LocalizationManager.getInstance();
    const idePaths = getIdeStatePaths();

    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'Antigravity IDE State': ['zip', 'vscdb'] },
        openLabel: lm.t('Import State')
    });

    if (!uris || uris.length === 0) return;

    const sourceFile = uris[0].fsPath;

    const confirm = await vscode.window.showWarningMessage(
        lm.t('Importing IDE state will replace current conversation indices and session data in Antigravity IDE. A safety backup will be created first. Continue?'),
        { modal: true },
        lm.t('Proceed'),
        lm.t('Cancel')
    );

    if (confirm !== lm.t('Proceed')) return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: lm.t('Importing Antigravity IDE State...'),
        cancellable: false
    }, async () => {
        try {
            // 1. Safety backup of existing state.vscdb
            if (fs.existsSync(idePaths.stateVscdbPath)) {
                const backupPath = `${idePaths.stateVscdbPath}.backup-${Date.now()}`;
                fs.copyFileSync(idePaths.stateVscdbPath, backupPath);
            }

            if (!fs.existsSync(idePaths.globalStorageDir)) {
                fs.mkdirSync(idePaths.globalStorageDir, { recursive: true });
            }

            if (sourceFile.toLowerCase().endsWith('.vscdb')) {
                fs.copyFileSync(sourceFile, idePaths.stateVscdbPath);
            } else {
                // ZIP archive
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-state-import-'));
                try {
                    await extract(sourceFile, { dir: tempDir });

                    const extractedState = path.join(tempDir, 'state.vscdb');
                    if (fs.existsSync(extractedState)) {
                        fs.copyFileSync(extractedState, idePaths.stateVscdbPath);
                    }

                    const extractedWs = path.join(tempDir, 'workspaceStorage');
                    if (fs.existsSync(extractedWs)) {
                        if (!fs.existsSync(idePaths.workspaceStorageDir)) {
                            fs.mkdirSync(idePaths.workspaceStorageDir, { recursive: true });
                        }
                        fs.cpSync(extractedWs, idePaths.workspaceStorageDir, { recursive: true });
                    }
                } finally {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            }

            const reload = await vscode.window.showInformationMessage(
                lm.t('Antigravity IDE State imported successfully! Please reload the window to apply changes.'),
                lm.t('Reload Window')
            );

            if (reload === lm.t('Reload Window')) {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(lm.t('Failed to import IDE state: {0}', err.message));
        }
    });
}
