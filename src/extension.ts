import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { SyncManager } from './sync';
import { getConversationsAsync, ConversationItem } from './utils';
import { resolveConflictsCommand } from './conflicts';
import { BackupManager } from './backup';
import { QuotaManager } from './quota/quotaManager';
import { LocalizationManager } from './l10n/localizationManager';

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

    // Initialize Localization
    LocalizationManager.getInstance().initialize(context);

    // Initialize Google Auth Provider
    authProvider = new GoogleAuthProvider(context);
    await authProvider.initialize();

    // Initialize Sync Manager
    syncManager = new SyncManager(context, authProvider);
    await syncManager.initialize();

    // Initialize Backup Manager
    backupManager = new BackupManager(context, STORAGE_ROOT);
    backupManager.initialize();

    // Initialize QuotaManager with AuthProvider
    quotaManager = new QuotaManager(context, authProvider);
    syncManager.setQuotaManager(quotaManager);
    quotaManager.setSyncManager(syncManager); // Inject sync manager for stats

    // Register existing commands
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXT_NAME}.export`, exportConversations),
        vscode.commands.registerCommand(`${EXT_NAME}.import`, importConversations),
        vscode.commands.registerCommand(`${EXT_NAME}.rename`, renameConversation),
        vscode.commands.registerCommand(`${EXT_NAME}.backupAll`, backupAll),
        vscode.commands.registerCommand(`${EXT_NAME}.triggerBackup`, async () => {
            const lm = LocalizationManager.getInstance();
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: lm.t('Performing scheduled backup...'),
                cancellable: false
            }, async () => {
                const path = await backupManager.backupNow();
                vscode.window.showInformationMessage(
                    lm.t('Backup created at: {0}', path),
                    lm.t('Show in Folder')
                ).then(selection => {
                    if (selection === lm.t('Show in Folder')) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
                    }
                });
            });
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.resolveConflicts`, () => resolveConflictsCommand(BRAIN_DIR, CONV_DIR)),

        // Account Management Commands
        vscode.commands.registerCommand(`${EXT_NAME}.addAccount`, async () => {
            try {
                await authProvider.addAccount();
            } catch (e: any) {
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to add account: {0}', e.message));
            }
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.switchAccount`, async (accountId: string) => {
            try {
                await authProvider.switchAccount(accountId);
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Switched account successfully'));
            } catch (e: any) {
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to switch account: {0}', e.message));
            }
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.removeAccount`, async (accountId: string) => {
            try {
                await authProvider.removeAccount(accountId);
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Account removed'));
            } catch (e: any) {
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to remove account: {0}', e.message));
            }
        })
    );

    // Register sync commands
    context.subscriptions.push(
        vscode.commands.registerCommand(`${EXT_NAME}.showMenu`, async () => {
            const lm = LocalizationManager.getInstance();
            const isReady = syncManager.isReady();

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

            // Define items with an explicit 'requiresAuth' property or handling
            const items: (vscode.QuickPickItem & { command?: string, args?: any[], requiresAuth?: boolean })[] = [
                {
                    label: `$(sync) ${lm.t('Sync Now')}`,
                    description: `${lm.t('Trigger immediate synchronization')} ${getKeybindingLabel(`${EXT_NAME}.syncNow`)}`,
                    command: `${EXT_NAME}.syncNow`
                },
                {
                    label: `$(graph) ${lm.t('Show Statistics')}`,
                    description: `${lm.t('View detailed sync status and history')} ${getKeybindingLabel(`${EXT_NAME}.showSyncStats`)}`,
                    command: `${EXT_NAME}.showSyncStats`,
                    requiresAuth: true
                },
                {
                    label: `$(cloud-upload) ${lm.t('Setup Sync')}`,
                    description: `${lm.t('Configure Google Drive synchronization')} ${getKeybindingLabel(`${EXT_NAME}.syncSetup`)}`,
                    command: `${EXT_NAME}.syncSetup`
                },

                { label: '', kind: vscode.QuickPickItemKind.Separator },

                // Management
                {
                    label: `$(shield) ${lm.t('Manage Authorized Deletion Machines')}`,
                    description: lm.t('Manage authorized devices for deletion'),
                    command: `${EXT_NAME}.syncManageAuthorizedMachines`,
                    requiresAuth: true
                },
                {
                    label: `$(list-unordered) ${lm.t('Manage Synced Conversations')}`,
                    description: `${lm.t('Manage which conversations are synced')} ${getKeybindingLabel(`${EXT_NAME}.syncManage`)}`,
                    command: `${EXT_NAME}.syncManage`,
                    requiresAuth: true
                },
                {
                    label: `$(sign-out) ${lm.t('Disconnect Google Drive Sync')}`,
                    description: lm.t('Disconnect from Google Drive'),
                    command: `${EXT_NAME}.syncDisconnect`,
                    requiresAuth: true
                },

                { label: '', kind: vscode.QuickPickItemKind.Separator },

                { label: `$(archive) ${lm.t('Backup Now')}`, description: `${lm.t('Create a local zip backup')} ${getKeybindingLabel(`${EXT_NAME}.triggerBackup`)}`, command: `${EXT_NAME}.triggerBackup` },
                { label: `$(arrow-down) ${lm.t('Import Conversations')}`, description: `${lm.t('Import from archive')} ${getKeybindingLabel(`${EXT_NAME}.import`)}`, command: `${EXT_NAME}.import` },
                { label: `$(arrow-up) ${lm.t('Export Conversations')}`, description: `${lm.t('Export to archive')} ${getKeybindingLabel(`${EXT_NAME}.export`)}`, command: `${EXT_NAME}.export` },

                { label: '', kind: vscode.QuickPickItemKind.Separator },

                { label: `$(edit) ${lm.t('Rename Conversation')}`, description: `${lm.t('Rename selected conversation')} ${getKeybindingLabel(`${EXT_NAME}.rename`)}`, command: `${EXT_NAME}.rename` },
                { label: `$(diff) ${lm.t('Resolve Conflict Copies')}`, description: `${lm.t('Resolve conflicts between local and remote versions')} ${getKeybindingLabel(`${EXT_NAME}.resolveConflicts`)}`, command: `${EXT_NAME}.resolveConflicts` },

                { label: '', kind: vscode.QuickPickItemKind.Separator },

                { label: `$(settings-gear) ${lm.t('Settings')}`, description: lm.t('Open extension settings'), command: 'workbench.action.openSettings', args: [`@ext:unchase.${EXT_NAME}`] }
            ];

            if (quotaManager.isFeatureEnabled()) {
                items.splice(2, 0, { label: `$(dashboard) ${lm.t('Show Quota')}`, description: `${lm.t('View Antigravity quota usage')} ${getKeybindingLabel(`${EXT_NAME}.showQuota`)}`, command: `${EXT_NAME}.showQuota` });
                items.splice(3, 0, { label: `$(account) ${lm.t('Google Account Data')}`, description: lm.t('View raw account data from Google'), command: `${EXT_NAME}.showAccountData` });
            }

            // Post-process items to reflect auth state
            const processedItems = items.map(item => {
                if (item.requiresAuth && !isReady) {
                    const labelMatch = item.label.match(/^(\$\([a-z-]+\)\s*)?(.*)$/);
                    const originalText = labelMatch ? labelMatch[2] : item.label;

                    return {
                        ...item,
                        label: '$(lock)',
                        description: `${originalText} [${lm.t('Requires Sync Setup')}] ${item.description || ''}`,
                        detail: undefined
                    };
                }
                return item;
            });

            // Use createQuickPick for Title Bar Buttons
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = processedItems;
            quickPick.placeholder = lm.t('Antigravity Storage Manager');
            quickPick.title = lm.t('Select an action');

            const patreonBtn = {
                iconPath: new vscode.ThemeIcon('heart'),
                tooltip: 'Support on Patreon'
            };
            const coffeeBtn = {
                iconPath: new vscode.ThemeIcon('gift'),
                tooltip: 'Buy Me a Coffee'
            };
            quickPick.buttons = [patreonBtn, coffeeBtn];

            quickPick.onDidTriggerButton(btn => {
                if (btn === patreonBtn) {
                    vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
                } else if (btn === coffeeBtn) {
                    vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
                }
                quickPick.hide();
            });

            quickPick.onDidAccept(async () => {
                const selected = quickPick.selectedItems[0] as any;
                if (selected && selected.command) {
                    const originalItem = items.find(i => i.command === selected.command);

                    if (originalItem?.requiresAuth && !isReady) {
                        quickPick.hide();
                        const setupNow = await vscode.window.showWarningMessage(
                            lm.t('This action requires Google Drive Sync to be configured.'),
                            lm.t('Setup Sync'),
                            lm.t('Cancel')
                        );
                        if (setupNow === lm.t('Setup Sync')) {
                            vscode.commands.executeCommand(`${EXT_NAME}.syncSetup`);
                        }
                        return;
                    }

                    quickPick.hide();
                    if (selected.args) {
                        vscode.commands.executeCommand(selected.command, ...selected.args);
                    } else {
                        vscode.commands.executeCommand(selected.command);
                    }
                }
            });

            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        }),

        vscode.commands.registerCommand(`${EXT_NAME}.syncSetup`, async () => {
            await syncManager.setup();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncNow`, async () => {
            const lm = LocalizationManager.getInstance();
            if (!syncManager.isReady()) {
                const setupNow = await vscode.window.showWarningMessage(
                    lm.t('Sync is not configured. Would you like to set it up now?'),
                    lm.t('Setup Sync'),
                    lm.t('Cancel')
                );
                if (setupNow === lm.t('Setup Sync')) {
                    await syncManager.setup();
                }
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: lm.t('Syncing conversations...'),
                cancellable: true
            }, async (progress, token) => {
                const result = await syncManager.syncNow(progress, token);

                if (result.success) {
                    const message = [];
                    if (result.pushed.length) message.push(lm.t('{0} pushed', result.pushed.length));
                    if (result.pulled.length) message.push(lm.t('{0} pulled', result.pulled.length));

                    if (message.length) {
                        const msgText = lm.t('Sync complete: {0}', message.join(', '));
                        if (result.pulled.length > 0) {
                            const reload = lm.t('Reload Window');
                            vscode.window.showInformationMessage(`${msgText}. ${lm.t('Reload to refresh chat list?')}`, reload)
                                .then(selection => {
                                    if (selection === reload) {
                                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                                    }
                                });
                        } else {
                            vscode.window.showInformationMessage(msgText);
                        }
                    } else {
                        vscode.window.showInformationMessage(lm.t('Sync complete: Everything is up to date'));
                    }
                } else {
                    vscode.window.showErrorMessage(lm.t('Sync failed: {0}', result.errors.join(', ')));
                }

                // Handle conflicts
                for (const conflict of result.conflicts) {
                    const choice = await vscode.window.showWarningMessage(
                        lm.t('Conflict detected for conversation. Local and remote versions differ.'),
                        { modal: true },
                        lm.t('Keep Local'),
                        lm.t('Keep Remote'),
                        lm.t('Keep Both')
                    );

                    if (choice === lm.t('Keep Local')) {
                        await syncManager.resolveConflict(conflict, 'keepLocal');
                    } else if (choice === lm.t('Keep Remote')) {
                        await syncManager.resolveConflict(conflict, 'keepRemote');
                    } else if (choice === lm.t('Keep Both')) {
                        await syncManager.resolveConflict(conflict, 'keepBoth');
                    }
                }
            });
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.showQuota`, async () => {
            await quotaManager.showQuota();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.showAccountData`, async () => {
            await quotaManager.showAccountData();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncManage`, async () => {
            const lm = LocalizationManager.getInstance();
            if (!syncManager.isEnabled()) {
                vscode.window.showWarningMessage(lm.t('Sync is not enabled. Please set up sync first.'));
                return;
            }
            await syncManager.manageConversations();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncManageAuthorizedMachines`, async () => {
            await syncManager.manageAuthorizedMachines();
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.syncDisconnect`, async () => {
            const lm = LocalizationManager.getInstance();
            const confirm = await vscode.window.showWarningMessage(
                lm.t('Are you sure you want to disconnect from Google Drive sync?'),
                { modal: true },
                lm.t('Disconnect'),
                lm.t('Cancel')
            );
            if (confirm === lm.t('Disconnect')) {
                await syncManager.disconnect();
            }
        }),
        vscode.commands.registerCommand(`${EXT_NAME}.showSyncStats`, async () => {
            await syncManager.showStatistics();
        })
    );

    // Create status bar items for export/import
    const lm = LocalizationManager.getInstance();
    const exportButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    exportButton.text = `$(export) ${lm.t('AG Export')}`;
    exportButton.tooltip = lm.t("Export Antigravity Conversations (via .zip file)");
    exportButton.command = `${EXT_NAME}.export`;
    exportButton.show();
    context.subscriptions.push(exportButton);

    const importButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    importButton.text = `$(cloud-download) ${lm.t('AG Import')}`;
    importButton.tooltip = lm.t("Import Antigravity Conversations (via .zip file)");
    importButton.command = `${EXT_NAME}.import`;
    importButton.show();
    context.subscriptions.push(importButton);

    // Prompt for reload on language change
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`${EXT_NAME}.language`)) {
            vscode.window.showInformationMessage(
                lm.t('{0}. Reload window to refresh?', lm.t('Language changed.')),
                lm.t('Reload'),
                lm.t('Later')
            ).then(selection => {
                if (selection === lm.t('Reload')) {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }
    }));

    // Check if sync is configured (if not suppressed)
    if (!syncManager.isReady()) {
        const suppress = context.globalState.get<boolean>('suppressSyncSetupPrompt');
        if (!suppress) {
            const config = vscode.workspace.getConfiguration(EXT_NAME);
            const autoSync = config.get<boolean>('sync.autoSync');

            // Only prompt if autoSync is enabled by default or user hasn't disabled it explicitly?
            // Actually, if user hasn't configured sync, we should prompt regardless of autoSync setting?
            // But if autoSync is false, maybe they don't want sync.
            // Default autoSync is true.

            if (autoSync) {
                vscode.window.showWarningMessage(
                    lm.t('Sync is not configured. Would you like to set it up now?'),
                    lm.t('Setup Sync'),
                    lm.t('Cancel')
                ).then(selection => {
                    if (selection === lm.t('Setup Sync')) {
                        vscode.commands.executeCommand(`${EXT_NAME}.syncSetup`);
                    }
                });
            }
        }
    }
}





/**
 * Enhanced QuickPick for conversations with sorting and status icons
 */
export async function showEnhancedConversationQuickPick(
    context: {
        title: string;
        placeholder: string;
        canSelectMany: boolean;
        syncManager?: SyncManager;
        statuses?: Map<string, { status: string, icon: string }>;
    }
): Promise<ConversationItem[] | undefined> {
    const lm = LocalizationManager.getInstance();
    const initialItems = await getConversationsAsync(BRAIN_DIR);

    if (initialItems.length === 0) {
        return [];
    }

    // Get sync statuses if sync is ready
    let statuses = context.statuses;
    if (!statuses && context.syncManager && context.syncManager.isReady()) {
        statuses = await context.syncManager.getConversationStatuses();
    }

    let currentSort: 'modified' | 'created' | 'name' = 'modified';

    const prepareItems = (items: ConversationItem[]) => {
        const sorted = [...items].sort((a, b) => {
            if (currentSort === 'name') {
                return (a.label || a.id).localeCompare(b.label || b.id);
            } else if (currentSort === 'created') {
                return b.createdAt.getTime() - a.createdAt.getTime();
            } else {
                return b.lastModified.getTime() - a.lastModified.getTime();
            }
        });

        return sorted.map(item => {
            const status = statuses?.get(item.id);
            const icon = status ? `${status.icon} ` : '';
            return {
                ...item,
                label: `${icon}${item.label}`,
                description: item.description,
                detail: `${status ? status.status + '  |  ' : ''}${item.detail}`
            };
        });
    };

    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem | ConversationItem>();
    quickPick.title = context.title;
    quickPick.canSelectMany = context.canSelectMany;
    quickPick.placeholder = context.placeholder;

    // Create Sort Button
    const updateSortButton = () => {
        let sortTooltip = lm.t('Sort by Modified Date and Time');
        if (currentSort === 'created') sortTooltip = lm.t('Sort by Created Date and Time');
        if (currentSort === 'name') sortTooltip = lm.t('Sort by Name');

        quickPick.buttons = [
            { iconPath: new vscode.ThemeIcon('heart'), tooltip: lm.t('Support on Patreon') },
            { iconPath: new vscode.ThemeIcon('coffee'), tooltip: lm.t('Buy Me a Coffee') },
            { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: `${lm.t('Sort')}: ${sortTooltip}` }
        ];
    };

    const updateItems = (preserveSelection = false) => {
        const previousSelectionIds = preserveSelection ? quickPick.selectedItems.map(i => (i as any).id) : [];
        quickPick.items = prepareItems(initialItems);

        if (preserveSelection && previousSelectionIds.length > 0) {
            quickPick.selectedItems = quickPick.items.filter(i => (i as any).id && previousSelectionIds.includes((i as any).id));
        }
        updateSortButton();
    };

    updateItems();

    // Handle Button Click (Sort)
    quickPick.onDidTriggerButton(button => {
        const tooltip = button.tooltip?.toString() || '';
        if (tooltip.includes('Patreon')) {
            vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
        } else if (tooltip.includes('Coffee')) {
            vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
        } else {
            // Toggle sort
            if (currentSort === 'modified') currentSort = 'created';
            else if (currentSort === 'created') currentSort = 'name';
            else currentSort = 'modified';
            updateItems(true); // Preserve selection
        }
    });

    return new Promise<ConversationItem[] | undefined>((resolve) => {
        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems as ConversationItem[];
            if (selected.length === 0 && !context.canSelectMany) {
                // Prevent empty accept in single select (unless strictly intended?)
                // Actually standard behavior allows empty accept if user cleared it? 
                // But typically QuickPick auto-selects active item.
                // let's follow standard.
            }
            resolve(selected.length > 0 ? selected : undefined);
            quickPick.hide();
        });
        quickPick.onDidHide(() => resolve(undefined));
        quickPick.show();
    });
}

// EXPORT: Multi-select
async function exportConversations() {
    const lm = LocalizationManager.getInstance();

    let statuses: Map<string, { status: string, icon: string }> | undefined;
    if (syncManager && syncManager.isReady()) {
        statuses = await syncManager.getConversationStatuses({ forceCache: true });
    }

    const selected = await showEnhancedConversationQuickPick({
        title: lm.t('Export Conversations'),
        placeholder: lm.t('Select conversations to export (use Space to select multiple)'),
        canSelectMany: true,
        syncManager: syncManager,
        statuses: statuses
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
        saveLabel: lm.t('Export')
    });

    if (!saveUri) return;

    const destPath = saveUri.fsPath;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: lm.t('Exporting {0} conversation(s)...', selected.length),
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
                    lm.t('Exported {0} conversation(s) to {1}', selected.length, destPath)
                );
                resolve();
            });

            archive.on('error', (err) => {
                vscode.window.showErrorMessage(lm.t('Export failed: {0}', err.message));
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
    const lm = LocalizationManager.getInstance();
    // 1. Get all conversations without prompting (just to check if empty)
    const conversations = await getConversationsAsync(BRAIN_DIR);
    if (conversations.length === 0) {
        vscode.window.showInformationMessage(lm.t('No conversations found to backup.'));
        return;
    }

    // 2. Ask for save location
    const defaultName = `antigravity-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
        filters: { 'Antigravity Archive': ['zip'] },
        saveLabel: lm.t('Create Backup')
    });

    if (!uri) return;

    // 3. Create Archive using BackupManager
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: lm.t('Backing up {0} conversations...', conversations.length),
        cancellable: true
    }, async (_progress, token) => {
        try {
            const filePath = await backupManager.backupNow(uri.fsPath, token);

            const stats = fs.statSync(filePath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

            vscode.window.showInformationMessage(
                lm.t('Backup complete! ({0} MB)', sizeMB),
                lm.t('Show in Folder')
            ).then(selection => {
                if (selection === lm.t('Show in Folder')) {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
                }
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(lm.t('Backup failed: {0}', err.message));
        }
    });
}

// IMPORT: Multi-file with conflict resolution
async function importConversations() {
    const lm = LocalizationManager.getInstance();
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: true,
        filters: { 'Antigravity Archive': ['zip'] },
        openLabel: lm.t('Import')
    });

    if (!uris || uris.length === 0) return;

    let importedCount = 0;
    let skippedCount = 0;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: lm.t('Importing {0} archive(s)...', uris.length),
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
                                    lm.t('Conversation "{0}" already exists.', id),
                                    { modal: true },
                                    lm.t('Overwrite'),
                                    lm.t('Rename'),
                                    lm.t('Skip')
                                );

                                if (choice === lm.t('Skip')) {
                                    skippedCount++;
                                    continue;
                                } else if (choice === lm.t('Rename')) {
                                    const newId = await vscode.window.showInputBox({
                                        prompt: lm.t('Enter new conversation ID'),
                                        value: `${id}-imported`,
                                        validateInput: (value) => {
                                            if (!value) return lm.t('ID cannot be empty');
                                            if (fs.existsSync(path.join(BRAIN_DIR, value))) {
                                                return lm.t('This ID already exists');
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
                vscode.window.showErrorMessage(lm.t('Failed to import {0}: {1}', path.basename(zipPath), e.message));
            }
        }
    });

    const message = lm.t('Imported {0} conversation(s)', importedCount) +
        (skippedCount > 0 ? lm.t(', skipped {0}', skippedCount) : '');

    const choice = await vscode.window.showInformationMessage(
        lm.t('{0}. Reload window to refresh?', message),
        lm.t('Reload'),
        lm.t('Later')
    );

    if (choice === lm.t('Reload')) {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

// RENAME: Change conversation title
async function renameConversation() {
    const lm = LocalizationManager.getInstance();

    const selectedList = await showEnhancedConversationQuickPick({
        title: lm.t('Rename Conversation'),
        placeholder: lm.t('Select conversation to rename'),
        canSelectMany: false,
        syncManager: syncManager
    });

    if (!selectedList || selectedList.length === 0) return;
    const selected = selectedList[0];

    // Strip emojis for the input field
    let currentTitle = selected.label;
    if (currentTitle.match(/^[^\w\s].*?\s/)) {
        currentTitle = currentTitle.replace(/^[^\w\s].*?\s/, '');
    }

    const newTitle = await vscode.window.showInputBox({
        prompt: lm.t('Enter new title'),
        value: currentTitle,
        validateInput: (value) => value ? null : lm.t('Title cannot be empty')
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
        vscode.window.showInformationMessage(lm.t('Renamed to "{0}"', newTitle));
    } catch (e: any) {
        vscode.window.showErrorMessage(lm.t('Rename failed: {0}', e.message));
    }
}

export function deactivate() { }
