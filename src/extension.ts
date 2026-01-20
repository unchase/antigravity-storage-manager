import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { SyncManager } from './sync';
import { getConversationsAsync } from './utils';
import { resolveConflictsCommand } from './conflicts';
import { BackupManager } from './backup';
import { QuotaManager } from './quota/quotaManager';

// Configuration
const EXT_NAME = 'antigravity-storage-manager';
const STORAGE_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = path.join(STORAGE_ROOT, 'brain');
const CONV_DIR = path.join(STORAGE_ROOT, 'conversations');



// Global instances for sync
let authProvider: GoogleAuthProvider;
let syncManager: SyncManager;
let backupManager: BackupManager;
let quotaManager: QuotaManager;

export async function activate(context: vscode.ExtensionContext) {
    console.log(`Congratulations, "${EXT_NAME}" is now active!`);

    // Initialize Google Auth Provider
    authProvider = new GoogleAuthProvider(context);
    await authProvider.initialize();

    // Initialize Sync Manager
    syncManager = new SyncManager(context, authProvider);
    await syncManager.initialize();

    // Initialize Backup Manager
    backupManager = new BackupManager(context, STORAGE_ROOT);
    backupManager.initialize();

    // Initialize Quota Manager
    quotaManager = new QuotaManager(context);

    // Register existing commands
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXT_NAME}.export`, exportConversations),
        vscode.commands.registerCommand(`${EXT_NAME}.import`, importConversations),
        vscode.commands.registerCommand(`${EXT_NAME}.rename`, renameConversation),
        vscode.commands.registerCommand(`${EXT_NAME}.backupAll`, backupAll),
        vscode.commands.registerCommand(`${EXT_NAME}.triggerBackup`, async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Performing scheduled backup...'),
                cancellable: false
            }, async () => {
                const path = await backupManager.backupNow();
                vscode.window.showInformationMessage(vscode.l10n.t('Backup created at: {0}', path));
            });
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.resolveConflicts`, () => resolveConflictsCommand(BRAIN_DIR, CONV_DIR))
    );

    // Register sync commands
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXT_NAME}.showMenu`, async () => {
            // Helper to get keybinding label
            const getKeybindingLabel = (commandId: string): string => {
                const packageJSON = context.extension.packageJSON;
                const keybindings = packageJSON.contributes?.keybindings;
                if (!keybindings) return '';

                const isMac = vscode.env.appHost === 'desktop' && process.platform === 'darwin'; // approximate check
                const kb = keybindings.find((k: any) => k.command === commandId);

                if (kb) {
                    const key = isMac && kb.mac ? kb.mac : kb.key;
                    if (key) {
                        // formats like "ctrl+alt+s" -> "Ctrl+Alt+S"
                        return `(${key.split('+').map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join('+')})`;
                    }
                }
                return '';
            };

            const items = [
                { label: '$(sync) Sync Now', description: `Trigger immediate synchronization ${getKeybindingLabel(`${EXT_NAME}.syncNow`)}`, command: `${EXT_NAME}.syncNow` },
                { label: '$(graph) Show Statistics', description: `View detailed sync status and history ${getKeybindingLabel(`${EXT_NAME}.showSyncStats`)}`, command: `${EXT_NAME}.showSyncStats` },
                { label: '$(cloud-upload) Setup Sync', description: `Configure Google Drive synchronization ${getKeybindingLabel(`${EXT_NAME}.syncSetup`)}`, command: `${EXT_NAME}.syncSetup` },
                { label: '$(archive) Backup Now', description: `Create a local zip backup ${getKeybindingLabel(`${EXT_NAME}.triggerBackup`)}`, command: `${EXT_NAME}.triggerBackup` },
                { label: '$(arrow-down) Import Conversations', description: `Import from archive ${getKeybindingLabel(`${EXT_NAME}.import`)}`, command: `${EXT_NAME}.import` },
                { label: '$(arrow-up) Export Conversations', description: `Export to archive ${getKeybindingLabel(`${EXT_NAME}.export`)}`, command: `${EXT_NAME}.export` },
                { label: '$(settings-gear) Settings', description: 'Open extension settings', command: 'workbench.action.openSettings', args: [`@ext:unchase.${EXT_NAME}`] }
            ];

            if (quotaManager.isFeatureEnabled()) {
                items.splice(2, 0, { label: '$(dashboard) Show Quota', description: 'View Antigravity quota usage', command: `${EXT_NAME}.showQuota` });
            }

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: vscode.l10n.t('Antigravity Storage Manager'),
                title: vscode.l10n.t('Select an action')
            });

            if (selected) {
                if (selected.args) {
                    vscode.commands.executeCommand(selected.command, ...selected.args);
                } else {
                    vscode.commands.executeCommand(selected.command);
                }
            }
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncSetup`, async () => {
            await syncManager.setup();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncNow`, async () => {
            if (!syncManager.isReady()) {
                const setupNow = await vscode.window.showWarningMessage(
                    vscode.l10n.t('Sync is not configured. Would you like to set it up now?'),
                    vscode.l10n.t('Setup Sync'),
                    vscode.l10n.t('Cancel')
                );
                if (setupNow === vscode.l10n.t('Setup Sync')) {
                    await syncManager.setup();
                }
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Syncing conversations...'),
                cancellable: true
            }, async (progress, token) => {
                const result = await syncManager.syncNow(progress, token);

                if (result.success) {
                    const message = [];
                    if (result.pushed.length) message.push(vscode.l10n.t('{0} pushed', result.pushed.length));
                    if (result.pulled.length) message.push(vscode.l10n.t('{0} pulled', result.pulled.length));

                    if (message.length) {
                        vscode.window.showInformationMessage(vscode.l10n.t('Sync complete: {0}', message.join(', ')));
                    } else {
                        vscode.window.showInformationMessage(vscode.l10n.t('Sync complete: Everything is up to date'));
                    }
                } else {
                    vscode.window.showErrorMessage(vscode.l10n.t('Sync failed: {0}', result.errors.join(', ')));
                }

                // Handle conflicts
                for (const conflict of result.conflicts) {
                    const choice = await vscode.window.showWarningMessage(
                        vscode.l10n.t('Conflict detected for conversation. Local and remote versions differ.'),
                        { modal: true },
                        vscode.l10n.t('Keep Local'),
                        vscode.l10n.t('Keep Remote'),
                        vscode.l10n.t('Keep Both')
                    );

                    if (choice === vscode.l10n.t('Keep Local')) {
                        await syncManager.resolveConflict(conflict, 'keepLocal');
                    } else if (choice === vscode.l10n.t('Keep Remote')) {
                        await syncManager.resolveConflict(conflict, 'keepRemote');
                    } else if (choice === vscode.l10n.t('Keep Both')) {
                        await syncManager.resolveConflict(conflict, 'keepBoth');
                    }
                }
            });
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncManage`, async () => {
            if (!syncManager.isEnabled()) {
                vscode.window.showWarningMessage(vscode.l10n.t('Sync is not enabled. Please set up sync first.'));
                return;
            }
            await syncManager.manageConversations();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncDisconnect`, async () => {
            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t('Are you sure you want to disconnect from Google Drive sync?'),
                { modal: true },
                vscode.l10n.t('Disconnect'),
                vscode.l10n.t('Cancel')
            );
            if (confirm === vscode.l10n.t('Disconnect')) {
                await syncManager.disconnect();
            }
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.showSyncStats`, async () => {
            await syncManager.showStatistics();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.showQuota`, async () => {
            await quotaManager.showQuota();
        })
    );

    // Create status bar items for export/import
    const exportButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    exportButton.text = "$(export) AG Export";
    exportButton.tooltip = vscode.l10n.t("Export Antigravity Conversations (via .zip file)");
    exportButton.command = `${EXT_NAME}.export`;
    exportButton.show();
    context.subscriptions.push(exportButton);

    const importButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    importButton.text = "$(cloud-download) AG Import";
    importButton.tooltip = vscode.l10n.t("Import Antigravity Conversations (via .zip file)");
    importButton.command = `${EXT_NAME}.import`;
    importButton.show();
    context.subscriptions.push(importButton);
}





// EXPORT: Multi-select
async function exportConversations() {
    const items = await getConversationsAsync(BRAIN_DIR);

    if (items.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No conversations found to export.'));
        return;
    }

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select conversations to export (use Space to select multiple)'),
        canPickMany: true
    });

    if (!selected || selected.length === 0) return;

    // Determine filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = selected.length === 1
        ? `${selected[0].id}.zip`
        : `antigravity-export-${timestamp}.zip`;

    const defaultUri = vscode.Uri.file(path.join(os.homedir(), 'Desktop', defaultName));
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: defaultUri,
        filters: { 'Antigravity Archive': ['zip'] },
        saveLabel: vscode.l10n.t('Export')
    });

    if (!saveUri) return;

    const destPath = saveUri.fsPath;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Exporting {0} conversation(s)...', selected.length),
        cancellable: true
    }, async (_progress, token) => {
        if (token.isCancellationRequested) return;
        return new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(destPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            token.onCancellationRequested(() => {
                archive.abort();
                output.close();
                fs.unlink(destPath, () => { }); // cleanup
                reject(new vscode.CancellationError());
            });

            output.on('close', () => {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Exported {0} conversation(s) to {1}', selected.length, destPath)
                );
                resolve();
            });

            archive.on('error', (err) => {
                vscode.window.showErrorMessage(vscode.l10n.t('Export failed: {0}', err.message));
                reject(err);
            });

            archive.pipe(output);

            // Add all selected conversations
            for (const conv of selected) {
                const id = conv.id;

                // Add brain directory
                const sourceBrainDir = path.join(BRAIN_DIR, id);
                if (fs.existsSync(sourceBrainDir)) {
                    archive.directory(sourceBrainDir, `brain/${id}`);
                }

                // Add conversation .pb file
                const convFile = path.join(CONV_DIR, `${id}.pb`);
                if (fs.existsSync(convFile)) {
                    archive.file(convFile, { name: `conversations/${id}.pb` });
                }
            }

            archive.finalize();
        });
    });
}

// BACKUP: One-click backup of all conversations
async function backupAll() {
    // 1. Get all conversations without prompting (just to check if empty)
    const conversations = await getConversationsAsync(BRAIN_DIR);
    if (conversations.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No conversations found to backup.'));
        return;
    }

    // 2. Ask for save location
    const defaultName = `antigravity-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
        filters: { 'Antigravity Archive': ['zip'] },
        saveLabel: vscode.l10n.t('Create Backup')
    });

    if (!uri) return;

    // 3. Create Archive using BackupManager
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Backing up {0} conversations...', conversations.length),
        cancellable: true
    }, async (_progress, token) => {
        try {
            const filePath = await backupManager.backupNow(uri.fsPath, token);

            const stats = fs.statSync(filePath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

            vscode.window.showInformationMessage(
                vscode.l10n.t('Backup complete! ({0} MB)', sizeMB),
                vscode.l10n.t('Open Folder')
            ).then(selection => {
                if (selection === vscode.l10n.t('Open Folder')) {
                    vscode.env.openExternal(vscode.Uri.file(path.dirname(filePath)));
                }
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Backup failed: {0}', err.message));
        }
    });
}

// IMPORT: Multi-file with conflict resolution
async function importConversations() {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: true,
        filters: { 'Antigravity Archive': ['zip'] },
        openLabel: vscode.l10n.t('Import')
    });

    if (!uris || uris.length === 0) return;

    let importedCount = 0;
    let skippedCount = 0;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Importing {0} archive(s)...', uris.length),
        cancellable: true
    }, async (progress, token) => {
        for (const uri of uris) {
            if (token.isCancellationRequested) break;
            const zipPath = uri.fsPath;
            progress.report({ message: path.basename(zipPath) });

            try {
                // First extract to temp to check for conflicts
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-import-'));

                try {
                    await extract(zipPath, { dir: tempDir });

                    // Check for brain directories (conversation IDs)
                    const brainDir = path.join(tempDir, 'brain');
                    if (fs.existsSync(brainDir)) {
                        const convIds = fs.readdirSync(brainDir).filter(d =>
                            fs.statSync(path.join(brainDir, d)).isDirectory()
                        );

                        for (const id of convIds) {
                            const existingDir = path.join(BRAIN_DIR, id);
                            let targetId = id;

                            if (fs.existsSync(existingDir)) {
                                // Conflict! Ask user
                                const choice = await vscode.window.showWarningMessage(
                                    vscode.l10n.t('Conversation "{0}" already exists.', id),
                                    { modal: true },
                                    vscode.l10n.t('Overwrite'),
                                    vscode.l10n.t('Rename'),
                                    vscode.l10n.t('Skip')
                                );

                                if (choice === vscode.l10n.t('Skip')) {
                                    skippedCount++;
                                    continue;
                                } else if (choice === vscode.l10n.t('Rename')) {
                                    const newId = await vscode.window.showInputBox({
                                        prompt: vscode.l10n.t('Enter new conversation ID'),
                                        value: `${id}-imported`,
                                        validateInput: (value) => {
                                            if (!value) return vscode.l10n.t('ID cannot be empty');
                                            if (fs.existsSync(path.join(BRAIN_DIR, value))) {
                                                return vscode.l10n.t('This ID already exists');
                                            }
                                            return null;
                                        }
                                    });

                                    if (!newId) {
                                        skippedCount++;
                                        continue;
                                    }
                                    targetId = newId;
                                }
                                // else Overwrite - continue with same ID
                            }

                            // Copy brain directory
                            const sourceBrain = path.join(brainDir, id);
                            const destBrain = path.join(BRAIN_DIR, targetId);

                            if (fs.existsSync(destBrain)) {
                                fs.rmSync(destBrain, { recursive: true, force: true });
                            }
                            fs.cpSync(sourceBrain, destBrain, { recursive: true });

                            // Copy .pb file if exists
                            const sourcePb = path.join(tempDir, 'conversations', `${id}.pb`);
                            if (fs.existsSync(sourcePb)) {
                                const destPb = path.join(CONV_DIR, `${targetId}.pb`);
                                fs.copyFileSync(sourcePb, destPb);
                            }

                            importedCount++;
                        }
                    }
                } finally {
                    // Cleanup temp
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(vscode.l10n.t('Failed to import {0}: {1}', path.basename(zipPath), e.message));
            }
        }
    });

    const message = vscode.l10n.t('Imported {0} conversation(s)', importedCount) +
        (skippedCount > 0 ? vscode.l10n.t(', skipped {0}', skippedCount) : '');

    const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('{0}. Reload window to refresh?', message),
        vscode.l10n.t('Reload'),
        vscode.l10n.t('Later')
    );

    if (choice === vscode.l10n.t('Reload')) {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

// RENAME: Change conversation title
async function renameConversation() {
    const items = await getConversationsAsync(BRAIN_DIR);

    if (items.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No conversations found.'));
        return;
    }

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t('Select conversation to rename')
    });

    if (!selected) return;

    const currentTitle = selected.label;
    const newTitle = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Enter new title'),
        value: currentTitle,
        validateInput: (value) => value ? null : vscode.l10n.t('Title cannot be empty')
    });

    if (!newTitle || newTitle === currentTitle) return;

    const taskPath = path.join(BRAIN_DIR, selected.id, 'task.md');

    try {
        let content = '';
        if (fs.existsSync(taskPath)) {
            content = fs.readFileSync(taskPath, 'utf8');
            // Replace existing Task header
            if (content.match(/^#\s*Task:?\s*.*$/im)) {
                content = content.replace(/^#\s*Task:?\s*.*$/im, `# Task: ${newTitle}`);
            } else {
                content = `# Task: ${newTitle}\n\n${content}`;
            }
        } else {
            content = `# Task: ${newTitle}\n`;
        }

        fs.writeFileSync(taskPath, content, 'utf8');
        vscode.window.showInformationMessage(vscode.l10n.t('Renamed to "{0}"', newTitle));
    } catch (e: any) {
        vscode.window.showErrorMessage(vscode.l10n.t('Rename failed: {0}', e.message));
    }
}

export function deactivate() { }
