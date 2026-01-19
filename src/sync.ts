import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { GoogleDriveService, SyncManifest, SyncedConversation, MachineState } from './googleDrive';
import * as crypto from './crypto';

const EXT_NAME = 'antigravity-storage-manager';
const STORAGE_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = path.join(STORAGE_ROOT, 'brain');
const CONV_DIR = path.join(STORAGE_ROOT, 'conversations');

export interface SyncConfig {
    enabled: boolean;
    machineId: string;
    machineName: string;
    selectedConversations: string[] | 'all';
    autoSync: boolean;
    syncInterval: number; // ms
    lastSync: string | null;
}

export interface SyncResult {
    success: boolean;
    pushed: string[];
    pulled: string[];
    conflicts: SyncConflict[];
    errors: string[];
}

export interface SyncConflict {
    conversationId: string;
    localModified: string;
    remoteModified: string;
    localHash: string;
    remoteHash: string;
}

type ConflictResolution = 'keepLocal' | 'keepRemote' | 'keepBoth';

/**
 * Main sync manager for coordinating conversation synchronization
 */
export class SyncManager {
    private context: vscode.ExtensionContext;
    private authProvider: GoogleAuthProvider;
    private driveService: GoogleDriveService;
    private config: SyncConfig | null = null;
    private masterPassword: string | null = null;
    private autoSyncTimer: NodeJS.Timeout | null = null;
    private isSyncing: boolean = false;

    // Status bar item for sync status
    private statusBarItem: vscode.StatusBarItem | null = null;

    constructor(
        context: vscode.ExtensionContext,
        authProvider: GoogleAuthProvider
    ) {
        this.context = context;
        this.authProvider = authProvider;
        this.driveService = new GoogleDriveService(authProvider);
    }

    /**
     * Initialize sync manager
     */
    async initialize(): Promise<void> {
        await this.loadConfig();

        // Load master password from secrets
        const storedPassword = await this.context.secrets.get(`${EXT_NAME}.sync.masterPassword`);
        if (storedPassword) {
            this.masterPassword = storedPassword;
        }

        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            98
        );
        this.statusBarItem.command = `${EXT_NAME}.syncNow`;
        this.context.subscriptions.push(this.statusBarItem);
        this.updateStatusBar('idle');

        // Start auto-sync if enabled
        if (this.config?.enabled && this.config?.autoSync && this.isReady()) {
            this.startAutoSync();
        }
    }

    /**
     * Check if sync is ready (authenticated and configured)
     */
    isReady(): boolean {
        return this.authProvider.isAuthenticated() &&
            this.config !== null &&
            this.config.enabled &&
            this.masterPassword !== null;
    }

    /**
     * Check if sync is enabled
     */
    isEnabled(): boolean {
        return this.config?.enabled ?? false;
    }

    /**
     * Get current config
     */
    getConfig(): SyncConfig | null {
        return this.config;
    }

    /**
     * Setup sync for the first time
     */
    async setup(): Promise<boolean> {
        try {
            // Step 1: Sign in to Google
            if (!this.authProvider.isAuthenticated()) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Signing in to Google...',
                    cancellable: false
                }, async () => {
                    await this.authProvider.signIn();
                });
            }

            // Step 2: Check if sync folder exists
            const syncExists = await this.driveService.checkSyncFolderExists();

            let isNewSetup = true;
            if (syncExists) {
                // Ask if they want to join existing sync
                const choice = await vscode.window.showInformationMessage(
                    'An existing sync folder was found in your Google Drive. Would you like to join it?',
                    { modal: true },
                    'Join Existing',
                    'Create New'
                );

                if (choice === 'Join Existing') {
                    isNewSetup = false;
                } else if (choice !== 'Create New') {
                    return false; // Cancelled
                }
            }

            // Step 3: Get or set master password
            if (isNewSetup) {
                // New setup - create password
                const password = await vscode.window.showInputBox({
                    prompt: 'Create a Master Password for encryption (remember this password!)',
                    password: true,
                    validateInput: (value) => {
                        if (!value || value.length < 8) {
                            return 'Password must be at least 8 characters';
                        }
                        return null;
                    }
                });

                if (!password) {
                    return false;
                }

                // Confirm password
                const confirmPassword = await vscode.window.showInputBox({
                    prompt: 'Confirm Master Password',
                    password: true,
                    validateInput: (value) => {
                        if (value !== password) {
                            return 'Passwords do not match';
                        }
                        return null;
                    }
                });

                if (!confirmPassword) {
                    return false;
                }

                this.masterPassword = password;
                await this.context.secrets.store(`${EXT_NAME}.sync.masterPassword`, password);

                // Create initial manifest
                await this.createInitialManifest();
            } else {
                // Joining existing - verify password
                const password = await vscode.window.showInputBox({
                    prompt: 'Enter the Master Password for this sync',
                    password: true
                });

                if (!password) {
                    return false;
                }

                // Verify password against manifest
                const verified = await this.verifyPassword(password);
                if (!verified) {
                    vscode.window.showErrorMessage('Incorrect password. Please try again.');
                    return false;
                }

                this.masterPassword = password;
                await this.context.secrets.store(`${EXT_NAME}.sync.masterPassword`, password);
            }

            // Step 4: Create/update config
            this.config = {
                enabled: true,
                machineId: crypto.generateMachineId(),
                machineName: os.hostname(),
                selectedConversations: 'all',
                autoSync: true,
                syncInterval: 5 * 60 * 1000, // 5 minutes
                lastSync: null
            };
            await this.saveConfig();

            // Step 5: Update machine state
            await this.updateMachineState();

            // Step 6: Start auto-sync
            if (this.config.autoSync) {
                this.startAutoSync();
            }

            this.updateStatusBar('idle');
            vscode.window.showInformationMessage('Google Drive sync setup complete!');
            return true;
        } catch (error: any) {
            vscode.window.showErrorMessage(`Sync setup failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Create initial manifest in Google Drive
     */
    private async createInitialManifest(): Promise<void> {
        const salt = crypto.generateSalt();
        const passwordHash = crypto.hashPassword(this.masterPassword!, salt);

        const manifest: SyncManifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            lastModified: new Date().toISOString(),
            passwordVerificationSalt: salt.toString('base64'),
            passwordVerificationHash: passwordHash,
            conversations: []
        };

        const manifestJson = JSON.stringify(manifest, null, 2);
        const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!);

        await this.driveService.ensureSyncFolders();
        await this.driveService.updateManifest(encrypted);
    }

    /**
     * Verify password against stored manifest
     */
    private async verifyPassword(password: string): Promise<boolean> {
        try {
            await this.driveService.ensureSyncFolders();

            // Try to download and decrypt manifest
            const encryptedManifest = await this.downloadManifestRaw();
            if (!encryptedManifest) {
                return false;
            }

            try {
                const decrypted = crypto.decrypt(encryptedManifest, password);
                JSON.parse(decrypted.toString('utf8'));
                return true;
            } catch {
                return false;
            }
        } catch (error) {
            console.error('Password verification failed:', error);
            return false;
        }
    }

    /**
     * Download raw manifest bytes
     */
    private async downloadManifestRaw(): Promise<Buffer | null> {
        try {
            return await this.driveService.getManifest();
        } catch {
            return null;
        }
    }

    /**
     * Sync now - manual or automatic sync trigger
     */
    async syncNow(): Promise<SyncResult> {
        if (this.isSyncing) {
            return {
                success: false,
                pushed: [],
                pulled: [],
                conflicts: [],
                errors: ['Sync already in progress']
            };
        }

        if (!this.isReady()) {
            return {
                success: false,
                pushed: [],
                pulled: [],
                conflicts: [],
                errors: ['Sync not configured or not authenticated']
            };
        }

        this.isSyncing = true;
        this.updateStatusBar('syncing');

        const result: SyncResult = {
            success: true,
            pushed: [],
            pulled: [],
            conflicts: [],
            errors: []
        };

        try {
            // Get remote manifest
            let remoteManifest = await this.getDecryptedManifest();
            if (!remoteManifest) {
                // If remote manifest doesn't exist, it might be the first sync or it was deleted
                // Try to recreate it if we have master password
                try {
                    console.log('Remote manifest not found, attempting to recreate...');
                    await this.createInitialManifest();
                } catch (e: any) {
                    throw new Error(`Failed to get or create remote manifest: ${e.message}`);
                }

                // Try getting it again
                const retryManifest = await this.getDecryptedManifest();
                if (!retryManifest) {
                    throw new Error('Failed to get remote manifest after recreation attempt');
                }
                remoteManifest = retryManifest;
            }

            // Get local conversations
            const localConversations = this.getLocalConversations();

            // Determine which conversations to sync
            const toSync = this.config!.selectedConversations === 'all'
                ? localConversations.map(c => c.id)
                : this.config!.selectedConversations;

            // Check for changes and conflicts
            for (const convId of toSync) {
                const local = localConversations.find(c => c.id === convId);
                const remote = remoteManifest.conversations.find(c => c.id === convId);

                if (local && !remote) {
                    // Local only - push to remote
                    try {
                        await this.pushConversation(convId);
                        result.pushed.push(convId);
                    } catch (error: any) {
                        result.errors.push(`Failed to push ${convId}: ${error.message}`);
                    }
                } else if (!local && remote) {
                    // Remote only - pull to local
                    try {
                        await this.pullConversation(convId);
                        result.pulled.push(convId);
                    } catch (error: any) {
                        result.errors.push(`Failed to pull ${convId}: ${error.message}`);
                    }
                } else if (local && remote) {
                    // Both exist - check for conflicts
                    if (local.hash !== remote.hash) {
                        const localDate = new Date(local.lastModified);
                        const remoteDate = new Date(remote.lastModified);

                        if (remote.modifiedBy === this.config!.machineId) {
                            // We modified it last, push
                            try {
                                await this.pushConversation(convId);
                                result.pushed.push(convId);
                            } catch (error: any) {
                                result.errors.push(`Failed to push ${convId}: ${error.message}`);
                            }
                        } else if (localDate > remoteDate) {
                            // Local is newer
                            try {
                                await this.pushConversation(convId);
                                result.pushed.push(convId);
                            } catch (error: any) {
                                result.errors.push(`Failed to push ${convId}: ${error.message}`);
                            }
                        } else if (remoteDate > localDate) {
                            // Remote is newer
                            try {
                                await this.pullConversation(convId);
                                result.pulled.push(convId);
                            } catch (error: any) {
                                result.errors.push(`Failed to pull ${convId}: ${error.message}`);
                            }
                        } else {
                            // Same time but different content - conflict
                            result.conflicts.push({
                                conversationId: convId,
                                localModified: local.lastModified,
                                remoteModified: remote.lastModified,
                                localHash: local.hash,
                                remoteHash: remote.hash
                            });
                        }
                    }
                }
            }

            // Pull any remote conversations not in local sync list
            for (const remote of remoteManifest.conversations) {
                if (!toSync.includes(remote.id)) {
                    const local = localConversations.find(c => c.id === remote.id);
                    if (!local) {
                        // New remote conversation - ask if should pull
                        // For auto-sync, just pull it
                        try {
                            await this.pullConversation(remote.id);
                            result.pulled.push(remote.id);
                        } catch (error: any) {
                            result.errors.push(`Failed to pull ${remote.id}: ${error.message}`);
                        }
                    }
                }
            }

            // Update last sync time
            this.config!.lastSync = new Date().toISOString();
            await this.saveConfig();
            await this.updateMachineState();

            result.success = result.errors.length === 0;
        } catch (error: any) {
            result.success = false;
            result.errors.push(error.message);
        } finally {
            this.isSyncing = false;
            this.updateStatusBar(result.success ? 'idle' : 'error');
        }

        return result;
    }

    /**
     * Push a single conversation to Google Drive
     */
    async pushConversation(conversationId: string): Promise<void> {
        // Create a temporary zip
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sync-'));
        const zipPath = path.join(tempDir, `${conversationId}.zip`);

        try {
            // Create zip archive
            await new Promise<void>((resolve, reject) => {
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });

                output.on('close', resolve);
                archive.on('error', reject);

                archive.pipe(output);

                // Add brain directory
                const brainDir = path.join(BRAIN_DIR, conversationId);
                if (fs.existsSync(brainDir)) {
                    archive.directory(brainDir, `brain/${conversationId}`);
                }

                // Add conversation file
                const convFile = path.join(CONV_DIR, `${conversationId}.pb`);
                if (fs.existsSync(convFile)) {
                    archive.file(convFile, { name: `conversations/${conversationId}.pb` });
                }

                archive.finalize();
            });

            // Read and encrypt
            const zipData = fs.readFileSync(zipPath);
            const encrypted = crypto.encrypt(zipData, this.masterPassword!);

            // Upload to Drive
            await this.driveService.uploadConversation(conversationId, encrypted);

            // Update manifest
            await this.updateManifestEntry(conversationId, crypto.computeHash(zipData));
        } finally {
            // Cleanup
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    /**
     * Pull a single conversation from Google Drive
     */
    async pullConversation(conversationId: string): Promise<void> {
        // Download encrypted data
        const encrypted = await this.driveService.downloadConversation(conversationId);
        if (!encrypted) {
            throw new Error(`Conversation ${conversationId} not found in Drive`);
        }

        // Decrypt
        const zipData = crypto.decrypt(encrypted, this.masterPassword!);

        // Extract to temp
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sync-'));
        const zipPath = path.join(tempDir, `${conversationId}.zip`);

        try {
            fs.writeFileSync(zipPath, zipData);
            await extract(zipPath, { dir: tempDir });

            // Copy brain directory
            const sourceBrain = path.join(tempDir, 'brain', conversationId);
            if (fs.existsSync(sourceBrain)) {
                const destBrain = path.join(BRAIN_DIR, conversationId);
                if (fs.existsSync(destBrain)) {
                    fs.rmSync(destBrain, { recursive: true, force: true });
                }
                fs.cpSync(sourceBrain, destBrain, { recursive: true });
            }

            // Copy conversation file
            const sourcePb = path.join(tempDir, 'conversations', `${conversationId}.pb`);
            if (fs.existsSync(sourcePb)) {
                fs.copyFileSync(sourcePb, path.join(CONV_DIR, `${conversationId}.pb`));
            }
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    /**
     * Resolve a sync conflict
     */
    async resolveConflict(conflict: SyncConflict, resolution: ConflictResolution): Promise<void> {
        switch (resolution) {
            case 'keepLocal':
                await this.pushConversation(conflict.conversationId);
                break;
            case 'keepRemote':
                await this.pullConversation(conflict.conversationId);
                break;
            case 'keepBoth':
                // Create a copy with -conflict suffix
                const newId = `${conflict.conversationId}-conflict-${Date.now()}`;

                // First pull remote as the conflict copy
                const encrypted = await this.driveService.downloadConversation(conflict.conversationId);
                if (encrypted) {
                    const zipData = crypto.decrypt(encrypted, this.masterPassword!);
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sync-'));
                    const zipPath = path.join(tempDir, 'conflict.zip');

                    try {
                        fs.writeFileSync(zipPath, zipData);
                        await extract(zipPath, { dir: tempDir });

                        // Copy with new ID
                        const sourceBrain = path.join(tempDir, 'brain', conflict.conversationId);
                        if (fs.existsSync(sourceBrain)) {
                            fs.cpSync(sourceBrain, path.join(BRAIN_DIR, newId), { recursive: true });
                        }

                        const sourcePb = path.join(tempDir, 'conversations', `${conflict.conversationId}.pb`);
                        if (fs.existsSync(sourcePb)) {
                            fs.copyFileSync(sourcePb, path.join(CONV_DIR, `${newId}.pb`));
                        }
                    } finally {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                }

                // Then push local
                await this.pushConversation(conflict.conversationId);
                break;
        }
    }

    /**
     * Get decrypted manifest from Drive
     */
    private async getDecryptedManifest(): Promise<SyncManifest | null> {
        try {
            await this.driveService.ensureSyncFolders();
            const encrypted = await this.driveService.getManifest();

            if (!encrypted) {
                return null;
            }

            const decrypted = crypto.decrypt(encrypted, this.masterPassword!);

            try {
                return JSON.parse(decrypted.toString('utf8'));
            } catch (e) {
                console.error('Failed to parse manifest JSON:', e);
                return null;
            }
        } catch (error) {
            console.error('Failed to get/decrypt manifest:', error);
            return null;
        }
    }

    /**
     * Update a single entry in the manifest
     */
    private async updateManifestEntry(conversationId: string, hash: string): Promise<void> {
        // Get current manifest, update entry, save back
        // This is a simplified version - in production you'd want locking
        const now = new Date().toISOString();

        const local = this.getLocalConversations().find(c => c.id === conversationId);
        const title = local?.title || conversationId;

        // For now, just ensure the conversation is uploaded
        // Manifest updates would be handled in a more sophisticated way
    }

    /**
     * Update machine state in Drive
     */
    private async updateMachineState(): Promise<void> {
        if (!this.config) return;

        const state: MachineState = {
            machineId: this.config.machineId,
            machineName: this.config.machineName,
            lastSync: new Date().toISOString(),
            conversationStates: this.getLocalConversations().map(c => ({
                id: c.id,
                localHash: c.hash,
                lastSynced: new Date().toISOString()
            }))
        };

        const encrypted = crypto.encrypt(
            Buffer.from(JSON.stringify(state)),
            this.masterPassword!
        );

        await this.driveService.updateMachineState(this.config.machineId, encrypted);
    }

    /**
     * Get local conversations with metadata
     */
    private getLocalConversations(): Array<{ id: string; title: string; lastModified: string; hash: string }> {
        if (!fs.existsSync(BRAIN_DIR)) {
            return [];
        }

        const dirs = fs.readdirSync(BRAIN_DIR).filter(d => {
            try {
                return fs.statSync(path.join(BRAIN_DIR, d)).isDirectory();
            } catch { return false; }
        });

        return dirs.map(id => {
            const dirPath = path.join(BRAIN_DIR, id);
            const taskPath = path.join(dirPath, 'task.md');
            let title = id;
            let hash = '';

            if (fs.existsSync(taskPath)) {
                try {
                    const content = fs.readFileSync(taskPath, 'utf8');
                    const match = content.match(/^#\s*Task:?\s*(.*)$/im);
                    if (match && match[1]) {
                        title = match[1].trim();
                    }
                    hash = crypto.computeHash(Buffer.from(content));
                } catch { }
            }

            const stats = fs.statSync(dirPath);
            return {
                id,
                title,
                lastModified: stats.mtime.toISOString(),
                hash
            };
        });
    }

    /**
     * Start auto-sync timer
     */
    startAutoSync(): void {
        this.stopAutoSync();

        if (this.config?.syncInterval) {
            this.autoSyncTimer = setInterval(async () => {
                if (this.isReady() && !this.isSyncing) {
                    const result = await this.syncNow();
                    if (result.pushed.length || result.pulled.length) {
                        vscode.window.showInformationMessage(
                            `Sync complete: ${result.pushed.length} pushed, ${result.pulled.length} pulled`
                        );
                    }
                }
            }, this.config.syncInterval);
        }
    }

    /**
     * Stop auto-sync timer
     */
    stopAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
    }

    /**
     * Update status bar
     */
    private updateStatusBar(status: 'idle' | 'syncing' | 'error'): void {
        if (!this.statusBarItem) return;

        const showStatusBar = vscode.workspace.getConfiguration(EXT_NAME).get('sync.showStatusBar', true);

        if (!showStatusBar || !this.config?.enabled) {
            this.statusBarItem.hide();
            return;
        }

        switch (status) {
            case 'idle':
                this.statusBarItem.text = '$(cloud) AG Sync';
                this.statusBarItem.tooltip = `Last sync: ${this.config?.lastSync || 'Never'}`;
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'syncing':
                this.statusBarItem.text = '$(sync~spin) AG Syncing...';
                this.statusBarItem.tooltip = 'Synchronizing...';
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'error':
                this.statusBarItem.text = '$(cloud-offline) AG Sync Error';
                this.statusBarItem.tooltip = 'Click to retry sync';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
        }

        this.statusBarItem.show();
    }

    /**
     * Disconnect sync (sign out and clear config)
     */
    async disconnect(): Promise<void> {
        this.stopAutoSync();
        await this.authProvider.signOut();
        await this.context.secrets.delete(`${EXT_NAME}.sync.masterPassword`);

        this.config = {
            enabled: false,
            machineId: '',
            machineName: '',
            selectedConversations: 'all',
            autoSync: false,
            syncInterval: 5 * 60 * 1000,
            lastSync: null
        };
        await this.saveConfig();

        this.masterPassword = null;
        this.updateStatusBar('idle');

        vscode.window.showInformationMessage('Disconnected from Google Drive sync');
    }

    /**
     * Load config from global state
     */
    private async loadConfig(): Promise<void> {
        const stored = this.context.globalState.get<SyncConfig>(`${EXT_NAME}.sync.config`);
        if (stored) {
            this.config = stored;
        }
    }

    /**
     * Save config to global state
     */
    private async saveConfig(): Promise<void> {
        if (this.config) {
            await this.context.globalState.update(`${EXT_NAME}.sync.config`, this.config);
        }
    }

    /**
     * Manage which conversations are synced
     */
    async manageConversations(): Promise<void> {
        const conversations = this.getLocalConversations();
        const currentSelection = this.config?.selectedConversations;

        const items: (vscode.QuickPickItem & { id: string })[] = conversations.map(c => ({
            id: c.id,
            label: c.title,
            description: c.id,
            picked: currentSelection === 'all' ||
                (Array.isArray(currentSelection) && currentSelection.includes(c.id))
        }));

        items.unshift({
            id: 'all',
            label: '$(check-all) Sync All Conversations',
            description: 'Automatically sync all conversations',
            picked: currentSelection === 'all'
        });

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: 'Select conversations to sync'
        });

        if (selected) {
            if (selected.some(s => s.id === 'all')) {
                this.config!.selectedConversations = 'all';
            } else {
                this.config!.selectedConversations = selected.map(s => s.id);
            }
            await this.saveConfig();
            vscode.window.showInformationMessage('Sync selection updated');
        }
    }
}
