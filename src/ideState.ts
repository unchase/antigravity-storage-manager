import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import extract from 'extract-zip';
import { LocalizationManager } from './l10n/localizationManager';
import { PbParser } from './quota/pbParser';
import { formatSize } from './utils';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const MAX_IMPORT_FILES = 10000;
const MAX_IMPORT_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GB zip bomb guard

export interface IdeStatePaths {
    globalStorageDir: string;
    stateVscdbPath: string;
    workspaceStorageDir: string;
    exists: boolean;
}

/**
 * Checks whether a file starts with the 16-byte SQLite3 magic header.
 */
export function isValidSqliteFile(filePath: string): boolean {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const header = Buffer.alloc(16);
            const bytesRead = fs.readSync(fd, header, 0, 16, 0);
            return bytesRead === 16 && header.equals(SQLITE_MAGIC);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
}

/**
 * Walks an extracted archive directory and rejects symlinks, excessive file counts, or zip bombs.
 */
export function validateExtractedDirectory(rootDir: string, maxFiles: number = MAX_IMPORT_FILES, maxBytes: number = MAX_IMPORT_TOTAL_BYTES): { fileCount: number; totalBytes: number } {
    let fileCount = 0;
    let totalBytes = 0;

    const walk = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const st = fs.lstatSync(fullPath);
            if (st.isSymbolicLink()) {
                throw new Error(`Unsafe symbolic link detected in archive: ${entry.name}`);
            }
            if (st.isDirectory()) {
                walk(fullPath);
            } else if (st.isFile()) {
                fileCount++;
                totalBytes += st.size;
                if (fileCount > maxFiles) {
                    throw new Error(`Archive exceeds maximum allowed file count (${maxFiles})`);
                }
                if (totalBytes > maxBytes) {
                    throw new Error(`Archive exceeds maximum allowed uncompressed size (${formatSize(maxBytes)})`);
                }
            }
        }
    };

    walk(rootDir);
    return { fileCount, totalBytes };
}

/**
 * Safely replaces a SQLite database file and removes stale -wal/-shm sidecars to prevent SQLITE_CORRUPT.
 */
export function replaceSqliteFileSafely(sourcePath: string, targetPath: string): void {
    if (!isValidSqliteFile(sourcePath)) {
        throw new Error(`Invalid SQLite database file: ${path.basename(sourcePath)}`);
    }

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Remove stale WAL and SHM sidecars first so SQLite never replays old WAL frames over the new DB
    for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${targetPath}${suffix}`;
        if (fs.existsSync(sidecar)) {
            try {
                fs.unlinkSync(sidecar);
            } catch {
                // Best effort if locked
            }
        }
    }

    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.copyFileSync(sourcePath, tmpPath);
        fs.renameSync(tmpPath, targetPath);
    } catch (err) {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            // ignore
        }
        throw err;
    }
}

/**
 * Resolves Antigravity IDE globalStorage and workspaceStorage paths across platforms.
 * Prefers the running IDE's `context.globalStorageUri` when available, then picks the
 * candidate directory that actually contains the freshest `globalStorage/state.vscdb`.
 */
export function getIdeStatePaths(context?: vscode.ExtensionContext): IdeStatePaths {
    const candidates: string[] = [];

    if (context?.globalStorageUri?.fsPath) {
        // globalStorageUri is typically <User>/globalStorage/<extensionId>
        const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
        const userDir = path.dirname(globalStorageDir);
        if (userDir) {
            candidates.push(userDir);
        }
    }

    const platform = process.platform;
    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        candidates.push(
            path.join(appData, 'Antigravity IDE', 'User'),
            path.join(appData, 'Antigravity', 'User')
        );
    } else if (platform === 'darwin') {
        candidates.push(
            path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User'),
            path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User')
        );
    } else {
        const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
        candidates.push(
            path.join(configDir, 'Antigravity IDE', 'User'),
            path.join(configDir, 'Antigravity', 'User'),
            path.join(configDir, 'antigravity-ide', 'User'),
            path.join(configDir, 'antigravity', 'User')
        );
    }

    // Pick the first candidate from context if it has state.vscdb, otherwise the freshest existing state.vscdb
    let selectedBase = candidates[0] || '';
    let bestMtime = -1;

    for (let i = 0; i < candidates.length; i++) {
        const base = candidates[i];
        const dbPath = path.join(base, 'globalStorage', 'state.vscdb');
        if (fs.existsSync(dbPath)) {
            if (i === 0 && context?.globalStorageUri) {
                selectedBase = base;
                break;
            }
            try {
                const mtime = fs.statSync(dbPath).mtimeMs;
                if (mtime > bestMtime) {
                    bestMtime = mtime;
                    selectedBase = base;
                }
            } catch {
                if (bestMtime < 0) selectedBase = base;
            }
        }
    }

    const globalStorageDir = path.join(selectedBase, 'globalStorage');
    const stateVscdbPath = path.join(globalStorageDir, 'state.vscdb');
    const workspaceStorageDir = path.join(selectedBase, 'workspaceStorage');

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
export async function reindexConversationsCommand(brainDir: string, convDir: string, context?: vscode.ExtensionContext): Promise<void> {
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
                        if (fs.lstatSync(path.join(brainDir, d)).isDirectory()) {
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
                            title = parsedTitle.replace(/[\r\n]+/g, ' ').trim();
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

        const idePaths = getIdeStatePaths(context);
        let stateStatus = lm.t('IDE State database not found at standard path.');
        if (idePaths.exists) {
            try {
                stateStatus = lm.t('IDE State database located ({0})', formatSize(fs.statSync(idePaths.stateVscdbPath).size));
            } catch {
                // Keep default not-found status
            }
        }

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
            await exportIdeStateCommand(context);
        } else if (reloadChoice === lm.t('Reload Window')) {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
}

/**
 * Exports Antigravity IDE internal state (state.vscdb, its WAL if present, and workspaceStorage) to a ZIP archive.
 */
export async function exportIdeStateCommand(context?: vscode.ExtensionContext): Promise<void> {
    const lm = LocalizationManager.getInstance();
    const idePaths = getIdeStatePaths(context);

    if (!idePaths.exists) {
        vscode.window.showWarningMessage(lm.t('Antigravity IDE state database not found at {0}.', idePaths.stateVscdbPath));
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `antigravity-ide-state-${timestamp}.zip`;
    const desktopDir = path.join(os.homedir(), 'Desktop');
    const defaultDir = fs.existsSync(desktopDir) ? desktopDir : os.homedir();
    const defaultUri = vscode.Uri.file(path.join(defaultDir, defaultName));

    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: defaultUri,
        filters: { 'Antigravity State Archive': ['zip'] },
        saveLabel: lm.t('Export State')
    });

    if (!saveUri) return;

    const destPath = saveUri.fsPath;
    const tmpPath = `${destPath}.${process.pid}.${Date.now()}.tmp`;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: lm.t('Exporting Antigravity IDE State...'),
        cancellable: true
    }, async (_progress, token) => {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let cancelled = false;
            const disposables: vscode.Disposable[] = [];

            const cleanupTmp = () => {
                try {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                } catch {
                    // ignore
                }
            };

            const finish = (err?: unknown) => {
                if (settled) return;
                settled = true;
                disposables.forEach(d => d.dispose());
                if (err) {
                    cleanupTmp();
                    reject(err);
                } else {
                    resolve();
                }
            };

            const output = fs.createWriteStream(tmpPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            disposables.push(token.onCancellationRequested(() => {
                cancelled = true;
                archive.abort();
                output.close(() => finish(new vscode.CancellationError()));
            }));

            output.on('error', (err) => {
                vscode.window.showErrorMessage(lm.t('State export failed: {0}', err.message));
                finish(err);
            });

            archive.on('error', (err) => {
                vscode.window.showErrorMessage(lm.t('State export failed: {0}', err.message));
                output.close(() => finish(err));
            });

            output.on('close', () => {
                if (cancelled) {
                    finish(new vscode.CancellationError());
                    return;
                }
                try {
                    fs.renameSync(tmpPath, destPath);
                    const stats = fs.statSync(destPath);
                    vscode.window.showInformationMessage(
                        lm.t('Exported Antigravity IDE State ({0}) to {1}', formatSize(stats.size), destPath),
                        lm.t('Show in Folder')
                    ).then(selection => {
                        if (selection === lm.t('Show in Folder')) {
                            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destPath));
                        }
                    });
                    finish();
                } catch (err: any) {
                    vscode.window.showErrorMessage(lm.t('State export failed: {0}', err.message));
                    finish(err);
                }
            });

            archive.pipe(output);

            // Add state.vscdb (+ WAL if present; omit ephemeral -shm)
            if (fs.existsSync(idePaths.stateVscdbPath)) {
                archive.file(idePaths.stateVscdbPath, { name: 'state.vscdb' });
                const walPath = `${idePaths.stateVscdbPath}-wal`;
                if (fs.existsSync(walPath)) {
                    archive.file(walPath, { name: 'state.vscdb-wal' });
                }
            }

            // Add workspaceStorage if present (excluding ephemeral -shm files)
            if (fs.existsSync(idePaths.workspaceStorageDir)) {
                archive.glob('**/*', {
                    cwd: idePaths.workspaceStorageDir,
                    ignore: ['**/*-shm']
                }, { prefix: 'workspaceStorage' });
            }

            archive.finalize();
        });
    });
}

/**
 * Imports Antigravity IDE internal state from a ZIP archive or state.vscdb file.
 */
export async function importIdeStateCommand(context?: vscode.ExtensionContext): Promise<void> {
    const lm = LocalizationManager.getInstance();
    const idePaths = getIdeStatePaths(context);

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
            const backupStamp = Date.now();

            // 1. Safety backup of existing state.vscdb (+ WAL if present)
            if (fs.existsSync(idePaths.stateVscdbPath)) {
                fs.copyFileSync(idePaths.stateVscdbPath, `${idePaths.stateVscdbPath}.backup-${backupStamp}`);
                const walPath = `${idePaths.stateVscdbPath}-wal`;
                if (fs.existsSync(walPath)) {
                    fs.copyFileSync(walPath, `${idePaths.stateVscdbPath}-wal.backup-${backupStamp}`);
                }
            }

            if (!fs.existsSync(idePaths.globalStorageDir)) {
                fs.mkdirSync(idePaths.globalStorageDir, { recursive: true });
            }

            if (sourceFile.toLowerCase().endsWith('.vscdb')) {
                replaceSqliteFileSafely(sourceFile, idePaths.stateVscdbPath);
            } else {
                // ZIP archive
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-state-import-'));
                try {
                    await extract(sourceFile, { dir: tempDir });
                    validateExtractedDirectory(tempDir);

                    const extractedState = path.join(tempDir, 'state.vscdb');
                    const extractedStateWal = path.join(tempDir, 'state.vscdb-wal');
                    const extractedWs = path.join(tempDir, 'workspaceStorage');

                    const hasState = fs.existsSync(extractedState);
                    const hasWs = fs.existsSync(extractedWs);
                    if (!hasState && !hasWs) {
                        throw new Error('Archive does not contain state.vscdb or workspaceStorage');
                    }

                    if (hasState) {
                        replaceSqliteFileSafely(extractedState, idePaths.stateVscdbPath);
                        if (fs.existsSync(extractedStateWal)) {
                            fs.copyFileSync(extractedStateWal, `${idePaths.stateVscdbPath}-wal`);
                        }
                    }

                    if (hasWs) {
                        if (!fs.existsSync(idePaths.workspaceStorageDir)) {
                            fs.mkdirSync(idePaths.workspaceStorageDir, { recursive: true });
                        }
                        // Clean stale -wal/-shm sidecars in target workspaceStorage before copying
                        try {
                            const wsEntries = fs.readdirSync(extractedWs, { withFileTypes: true });
                            for (const wsEntry of wsEntries) {
                                if (!wsEntry.isDirectory()) continue;
                                const targetWsDb = path.join(idePaths.workspaceStorageDir, wsEntry.name, 'state.vscdb');
                                for (const suffix of ['-wal', '-shm']) {
                                    const sidecar = `${targetWsDb}${suffix}`;
                                    if (fs.existsSync(sidecar)) {
                                        try { fs.unlinkSync(sidecar); } catch { /* ignore */ }
                                    }
                                }
                            }
                        } catch {
                            // Ignore cleanup errors
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
