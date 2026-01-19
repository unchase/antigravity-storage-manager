import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { SyncManager } from './sync';
import { formatRelativeTime, getConversationsAsync } from './utils';

// Configuration
const EXT_NAME = 'antigravity-storage-manager';
const STORAGE_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = path.join(STORAGE_ROOT, 'brain');
const CONV_DIR = path.join(STORAGE_ROOT, 'conversations');



// Global instances for sync
let authProvider: GoogleAuthProvider;
let syncManager: SyncManager;

export async function activate(context: vscode.ExtensionContext) {
    console.log(`Congratulations, "${EXT_NAME}" is now active!`);

    // Initialize Google Auth Provider
    authProvider = new GoogleAuthProvider(context);
    await authProvider.initialize();

    // Initialize Sync Manager
    syncManager = new SyncManager(context, authProvider);
    await syncManager.initialize();

    // Register existing commands
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXT_NAME}.export`, exportConversations),
        vscode.commands.registerCommand(`${EXT_NAME}.import`, importConversations),
        vscode.commands.registerCommand(`${EXT_NAME}.rename`, renameConversation)
    );

    // Register sync commands
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXT_NAME}.syncSetup`, async () => {
            await syncManager.setup();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncNow`, async () => {
            if (!syncManager.isReady()) {
                const setupNow = await vscode.window.showWarningMessage(
                    'Sync is not configured. Would you like to set it up now?',
                    'Setup Sync',
                    'Cancel'
                );
                if (setupNow === 'Setup Sync') {
                    await syncManager.setup();
                }
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Syncing conversations...',
                cancellable: false
            }, async () => {
                const result = await syncManager.syncNow();

                if (result.success) {
                    const message = [];
                    if (result.pushed.length) message.push(`${result.pushed.length} pushed`);
                    if (result.pulled.length) message.push(`${result.pulled.length} pulled`);

                    if (message.length) {
                        vscode.window.showInformationMessage(`Sync complete: ${message.join(', ')}`);
                    } else {
                        vscode.window.showInformationMessage('Sync complete: Everything is up to date');
                    }
                } else {
                    vscode.window.showErrorMessage(`Sync failed: ${result.errors.join(', ')}`);
                }

                // Handle conflicts
                for (const conflict of result.conflicts) {
                    const choice = await vscode.window.showWarningMessage(
                        `Conflict detected for conversation. Local and remote versions differ.`,
                        { modal: true },
                        'Keep Local',
                        'Keep Remote',
                        'Keep Both'
                    );

                    if (choice === 'Keep Local') {
                        await syncManager.resolveConflict(conflict, 'keepLocal');
                    } else if (choice === 'Keep Remote') {
                        await syncManager.resolveConflict(conflict, 'keepRemote');
                    } else if (choice === 'Keep Both') {
                        await syncManager.resolveConflict(conflict, 'keepBoth');
                    }
                }
            });
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncManage`, async () => {
            if (!syncManager.isEnabled()) {
                vscode.window.showWarningMessage('Sync is not enabled. Please set up sync first.');
                return;
            }
            await syncManager.manageConversations();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncDisconnect`, async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to disconnect from Google Drive sync?',
                { modal: true },
                'Disconnect',
                'Cancel'
            );
            if (confirm === 'Disconnect') {
                await syncManager.disconnect();
            }
        })
    );

    // Create status bar items for export/import
    const exportButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    exportButton.text = "$(export) AG Export";
    exportButton.tooltip = "Export Antigravity Conversations";
    exportButton.command = `${EXT_NAME}.export`;
    exportButton.show();
    context.subscriptions.push(exportButton);

    const importButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    importButton.text = "$(import) AG Import";
    importButton.tooltip = "Import Antigravity Conversations";
    importButton.command = `${EXT_NAME}.import`;
    importButton.show();
    context.subscriptions.push(importButton);
}





// EXPORT: Multi-select
async function exportConversations() {
    const items = await getConversationsAsync(BRAIN_DIR);

    if (items.length === 0) {
        vscode.window.showInformationMessage('No conversations found to export.');
        return;
    }

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select conversations to export (use Space to select multiple)',
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
        saveLabel: 'Export'
    });

    if (!saveUri) return;

    const destPath = saveUri.fsPath;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Exporting ${selected.length} conversation(s)...`,
        cancellable: false
    }, async () => {
        return new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(destPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => {
                vscode.window.showInformationMessage(
                    `Exported ${selected.length} conversation(s) to ${destPath}`
                );
                resolve();
            });

            archive.on('error', (err) => {
                vscode.window.showErrorMessage(`Export failed: ${err.message}`);
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

// IMPORT: Multi-file with conflict resolution
async function importConversations() {
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: true,
        filters: { 'Antigravity Archive': ['zip'] },
        openLabel: 'Import'
    });

    if (!uris || uris.length === 0) return;

    let importedCount = 0;
    let skippedCount = 0;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Importing ${uris.length} archive(s)...`,
        cancellable: false
    }, async (progress) => {
        for (const uri of uris) {
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
                                    `Conversation "${id}" already exists.`,
                                    { modal: true },
                                    'Overwrite',
                                    'Rename',
                                    'Skip'
                                );

                                if (choice === 'Skip') {
                                    skippedCount++;
                                    continue;
                                } else if (choice === 'Rename') {
                                    const newId = await vscode.window.showInputBox({
                                        prompt: 'Enter new conversation ID',
                                        value: `${id}-imported`,
                                        validateInput: (value) => {
                                            if (!value) return 'ID cannot be empty';
                                            if (fs.existsSync(path.join(BRAIN_DIR, value))) {
                                                return 'This ID already exists';
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
                vscode.window.showErrorMessage(`Failed to import ${path.basename(zipPath)}: ${e.message}`);
            }
        }
    });

    const message = `Imported ${importedCount} conversation(s)` +
        (skippedCount > 0 ? `, skipped ${skippedCount}` : '');

    const choice = await vscode.window.showInformationMessage(
        `${message}. Reload window to refresh?`,
        'Reload',
        'Later'
    );

    if (choice === 'Reload') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

// RENAME: Change conversation title
async function renameConversation() {
    const items = await getConversationsAsync(BRAIN_DIR);

    if (items.length === 0) {
        vscode.window.showInformationMessage('No conversations found.');
        return;
    }

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select conversation to rename'
    });

    if (!selected) return;

    const currentTitle = selected.label;
    const newTitle = await vscode.window.showInputBox({
        prompt: 'Enter new title',
        value: currentTitle,
        validateInput: (value) => value ? null : 'Title cannot be empty'
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
        vscode.window.showInformationMessage(`Renamed to "${newTitle}"`);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Rename failed: ${e.message}`);
    }
}

export function deactivate() { }
