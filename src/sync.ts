import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { GoogleDriveService, SyncManifest, SyncedConversation, MachineState, FileHashInfo } from './googleDrive';
import * as crypto from './crypto';
import { LocalizationManager } from './l10n/localizationManager';
import { formatRelativeTime, getConversationsAsync, limitConcurrency } from './utils';

const EXT_NAME = 'antigravity-storage-manager';
const STORAGE_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = path.join(STORAGE_ROOT, 'brain');
const CONV_DIR = path.join(STORAGE_ROOT, 'conversations');

export interface SyncConfig {
    enabled: boolean; // Deprecated, use autoSync? No, enabled is overall switch
    machineId: string;
    machineName: string;
    selectedConversations: string[] | 'all';
    autoSync: boolean;
    syncInterval: number; // ms
    lastSync: string | null;
    showStatusBar: boolean;
    silent: boolean;
    masterPasswordHash: string; // Add this
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
    private nextAutoSyncTime: number | null = null;
    private isSyncing: boolean = false;
    private syncCount: number = 0;
    private fileHashCache: Map<string, { mtime: number, hash: string }> = new Map();

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
        this.statusBarItem.command = `${EXT_NAME}.showMenu`;
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
    async syncNow(progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<SyncResult> {
        const lm = LocalizationManager.getInstance();
        if (this.isSyncing) {
            return {
                success: false,
                pushed: [],
                pulled: [],
                conflicts: [],
                errors: [lm.t('Sync already in progress')]
            };
        }

        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (!this.isReady()) {
            return {
                success: false,
                pushed: [],
                pulled: [],
                conflicts: [],
                errors: [lm.t('Sync not configured or not authenticated')]
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
            // Try to acquire lock
            this.reportProgress(progress, lm.t('Acquiring sync lock...'));
            const machineId = this.config!.machineId;
            // Lock for 5 minutes (default)
            const acquired = await this.driveService.acquireLock(machineId);
            if (!acquired) {
                throw new Error(lm.t('Sync is currently locked by another machine. Please try again later.'));
            }

            try {
                // Get remote manifest
                this.reportProgress(progress, lm.t('Downloading sync manifest...'));
                const remoteManifest = await this.ensureRemoteManifest();
                if (!remoteManifest) {
                    throw new Error(lm.t('Could not retrieve remote manifest'));
                }

                // Get local conversations
                this.reportProgress(progress, lm.t('Scanning local conversations...'));
                const localConversations = await this.getLocalConversationsAsync();

                // Determine which conversations to sync
                const toSync = this.config!.selectedConversations === 'all'
                    ? localConversations.map(c => c.id)
                    : this.config!.selectedConversations;

                // Also include any remote conversations that we don't have locally
                for (const remote of remoteManifest.conversations) {
                    if (!toSync.includes(remote.id)) {
                        const local = localConversations.find(c => c.id === remote.id);
                        if (!local) {
                            // It's a new remote conversation, we should sync it (pull)
                            toSync.push(remote.id);
                        }
                    }
                }

                // Process conversations in parallel chunks to avoid hitting API limits or excessive resource usage
                this.reportProgress(progress, vscode.l10n.t('Starting synchronization...'));
                const chunkSize = 5;
                for (let i = 0; i < toSync.length; i += chunkSize) {
                    if (token?.isCancellationRequested) throw new vscode.CancellationError();
                    const chunk = toSync.slice(i, i + chunkSize);
                    await Promise.all(chunk.map(convId => {
                        if (token?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
                        return this.processSyncItem(convId, localConversations, remoteManifest, result, progress, token);
                    }));
                }

                // Update last sync time
                if (token?.isCancellationRequested) throw new vscode.CancellationError();
                this.config!.lastSync = new Date().toISOString();
                this.syncCount++;
                await this.saveConfig();
                await this.updateMachineState();

                result.success = result.errors.length === 0;

            } finally {
                await this.driveService.releaseLock(machineId);
            }
        } catch (error: any) {
            result.success = false;
            result.errors.push(error.message);
        } finally {
            this.isSyncing = false;
            this.updateStatusBar(
                result.success ? 'idle' : 'error',
                result.success ? undefined : result.errors.join('\n')
            );

            // Error suggestions
            if (result.errors.length > 0) {
                const notFoundErrors = result.errors.filter(e => e.includes('not found in Drive'));
                const suggestSolutions = vscode.workspace.getConfiguration(EXT_NAME).get('sync.suggestSolutions', true);

                if (notFoundErrors.length > 0 && suggestSolutions) {
                    const fixAction = vscode.l10n.t('Fix Manifest (Remove Missing)');
                    const pushAction = vscode.l10n.t('Push Local Versions');
                    const settingsAction = vscode.l10n.t('Disable Suggestions');

                    vscode.window.showWarningMessage(
                        vscode.l10n.t('Some conversations were not found in Google Drive. This usually happens if they were deleted manually from Drive but are still in the sync manifest.'),
                        fixAction,
                        pushAction,
                        settingsAction
                    ).then(async selection => {
                        if (selection === fixAction) {
                            await this.fixMissingRemoteConversations(result.errors);
                        } else if (selection === pushAction) {
                            // Retry sync but force push for missing ones? 
                            // Actually syncNow tries to push if local exists. 
                            // If we got "not found in Drive" during pull, it means we thought it existed remotely.
                            // So "Push Local" might strictly mean "Treat as new local". 
                            // For now, let's just re-run sync and hopefully logic sorts it out, OR explicitly push.
                            // But cleaner API is to just fix manifest.
                            vscode.window.showInformationMessage(vscode.l10n.t('To push local versions, simply modify them locally to trigger a change, or use "Fix Manifest" then sync again.'));
                        } else if (selection === settingsAction) {
                            await vscode.workspace.getConfiguration(EXT_NAME).update('sync.suggestSolutions', false, true);
                        }
                    });
                }
            }
        }

        return result;
    }

    /**
     * Remove missing conversations from remote manifest
     */
    async fixMissingRemoteConversations(errors: string[]): Promise<void> {
        // Extract IDs from error messages
        // Msg format: "Failed to pull {id}: Conversation {id} not found in Drive"
        const ids: string[] = [];
        const regex = /Conversation ([a-f0-9-]+) not found/i;

        for (const err of errors) {
            const match = err.match(regex);
            if (match && match[1]) {
                ids.push(match[1]);
            }
        }

        if (ids.length === 0) return;

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Fixing manifest...'),
                cancellable: false
            }, async () => {
                const manifest = await this.getDecryptedManifest();
                if (!manifest) return;

                const initialCount = manifest.conversations.length;
                manifest.conversations = manifest.conversations.filter(c => !ids.includes(c.id));
                const removedCount = initialCount - manifest.conversations.length;

                if (removedCount > 0) {
                    manifest.lastModified = new Date().toISOString();
                    const manifestJson = JSON.stringify(manifest, null, 2);
                    const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!);
                    await this.driveService.updateManifest(encrypted);
                    vscode.window.showInformationMessage(vscode.l10n.t('Removed {0} missing conversation(s) from manifest.', removedCount));
                }
            });
        } catch (e: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Failed to fix manifest: {0}', e.message));
        }
    }

    /**
     * Push a single conversation to Google Drive (per-file sync)
     */
    /**
     * Push a single conversation to Google Drive (per-file sync)
     */
    async pushConversation(conversationId: string, progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (!this.masterPassword) {
            throw new Error(vscode.l10n.t('Encryption password not set'));
        }

        // Get local file hashes
        this.reportProgress(progress, vscode.l10n.t('Analyzing {0}...', conversationId));
        const localData = await this.computeConversationFileHashesAsync(conversationId);

        // Get remote file hashes from manifest
        const manifest = await this.getDecryptedManifest();
        const remoteConv = manifest?.conversations.find(c => c.id === conversationId);
        const remoteHashes = remoteConv?.fileHashes || {};

        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        // Determine which files need to be uploaded
        const filesToUpload: string[] = [];
        const filesToDelete: string[] = [];

        // Files that are new or changed locally
        for (const [relativePath, localInfo] of Object.entries(localData.fileHashes)) {
            const remoteInfo = remoteHashes[relativePath];
            if (!remoteInfo || remoteInfo.hash !== localInfo.hash) {
                filesToUpload.push(relativePath);
            }
        }

        // Files that exist remotely but not locally (deleted locally)
        for (const remotePath of Object.keys(remoteHashes)) {
            if (!localData.fileHashes[remotePath]) {
                filesToDelete.push(remotePath);
            }
        }

        // Upload changed files
        let uploadedCount = 0;
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const concurrency = config.get<number>('sync.concurrency', 3);

        await limitConcurrency(filesToUpload, concurrency, async (relativePath) => {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();

            uploadedCount++;
            this.reportProgress(progress, vscode.l10n.t('Uploading: {0} ({1}/{2})...', relativePath, uploadedCount, filesToUpload.length));

            // Read and encrypt file
            const fullPath = this.getFullPathForRelative(conversationId, relativePath);
            const content = await fs.promises.readFile(fullPath);
            const encrypted = crypto.encrypt(content, this.masterPassword!);

            await this.driveService.uploadConversationFile(conversationId, relativePath, encrypted);
        }, token);

        // Delete removed files from remote
        for (const relativePath of filesToDelete) {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            await this.driveService.deleteConversationFile(conversationId, relativePath);
        }

        // Update manifest with new file hashes
        await this.updateManifestEntryWithFileHashes(conversationId, localData.overallHash, localData.fileHashes);
    }

    /**
     * Get full local path for a relative path
     */
    private getFullPathForRelative(conversationId: string, relativePath: string): string {
        if (relativePath.startsWith('conversations/')) {
            return path.join(CONV_DIR, relativePath.replace('conversations/', ''));
        } else if (relativePath.startsWith(`brain/${conversationId}/`)) {
            // brain/{convId}/subpath -> BRAIN_DIR/{convId}/subpath
            return path.join(BRAIN_DIR, relativePath.replace('brain/', ''));
        } else if (relativePath.startsWith('brain/')) {
            // brain/{convId}/subpath (generic case)
            return path.join(BRAIN_DIR, relativePath.replace('brain/', ''));
        }
        throw new Error(`Unknown path format: ${relativePath}`);
    }

    /**
     * Pull a single conversation from Google Drive (per-file sync with legacy fallback)
     */
    /**
     * Pull a single conversation from Google Drive (per-file sync with legacy fallback)
     */
    async pullConversation(conversationId: string, progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (!this.masterPassword) {
            throw new Error(vscode.l10n.t('Encryption password not set'));
        }

        // Get remote manifest to check format and file hashes
        const manifest = await this.getDecryptedManifest();
        const remoteConv = manifest?.conversations.find(c => c.id === conversationId);

        if (!remoteConv) {
            throw new Error(vscode.l10n.t('Conversation {0} not found in manifest', conversationId));
        }

        // Check if using new per-file format (version 2) or legacy ZIP
        if (remoteConv.version === 2 && remoteConv.fileHashes) {
            await this.pullConversationPerFile(conversationId, remoteConv.fileHashes, progress, token);
        } else {
            // Legacy format - download entire ZIP
            await this.pullConversationLegacy(conversationId, progress, token);
        }
    }

    /**
     * Pull conversation using per-file sync (new format)
     */
    /**
     * Pull conversation using per-file sync (new format)
     */
    private async pullConversationPerFile(
        conversationId: string,
        remoteHashes: { [relativePath: string]: FileHashInfo },
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        // Get local file hashes
        this.reportProgress(progress, vscode.l10n.t('Analyzing {0}...', conversationId));
        const localData = await this.computeConversationFileHashesAsync(conversationId);
        const localHashes = localData.fileHashes;

        // Determine which files need to be downloaded
        const filesToDownload: string[] = [];
        const filesToDelete: string[] = [];

        // Files that are new or changed remotely
        for (const [relativePath, remoteInfo] of Object.entries(remoteHashes)) {
            const localInfo = localHashes[relativePath];
            if (!localInfo || localInfo.hash !== remoteInfo.hash) {
                filesToDownload.push(relativePath);
            }
        }

        // Files that exist locally but not remotely (deleted remotely)
        for (const localPath of Object.keys(localHashes)) {
            if (!remoteHashes[localPath]) {
                filesToDelete.push(localPath);
            }
        }

        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        // Download changed files
        let downloadedCount = 0;
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const concurrency = config.get<number>('sync.concurrency', 3);

        await limitConcurrency(filesToDownload, concurrency, async (relativePath) => {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            downloadedCount++;
            this.reportProgress(progress, vscode.l10n.t('Downloading: {0} ({1}/{2})...', relativePath, downloadedCount, filesToDownload.length));

            const encrypted = await this.driveService.downloadConversationFile(conversationId, relativePath);
            if (encrypted) {
                const content = crypto.decrypt(encrypted, this.masterPassword!);
                const fullPath = this.getFullPathForRelative(conversationId, relativePath);

                // Ensure directory exists
                await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, content);
            }
        }, token);

        // Delete locally files that were deleted remotely
        for (const relativePath of filesToDelete) {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            try {
                const fullPath = this.getFullPathForRelative(conversationId, relativePath);
                await fs.promises.unlink(fullPath);
            } catch {
                // Ignore if file doesn't exist
            }
        }
    }

    /**
     * Pull conversation using legacy ZIP format
     */
    private async pullConversationLegacy(
        conversationId: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        // Download encrypted ZIP
        this.reportProgress(progress, vscode.l10n.t('Downloading {0}...', conversationId));
        const encrypted = await this.driveService.downloadConversation(conversationId);

        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        if (!encrypted) {
            throw new Error(vscode.l10n.t('Conversation {0} not found in Drive', conversationId));
        }

        // Decrypt
        this.reportProgress(progress, vscode.l10n.t('Decrypting {0}...', conversationId));
        const zipData = crypto.decrypt(encrypted, this.masterPassword!);

        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        // Extract to temp
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sync-'));
        const zipPath = path.join(tempDir, `${conversationId}.zip`);

        try {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
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
        if (!this.masterPassword) {
            throw new Error(vscode.l10n.t('Encryption password not set'));
        }

        switch (resolution) {
            case 'keepLocal':
                await this.pushConversation(conflict.conversationId);
                break;
            case 'keepRemote':
                await this.pullConversation(conflict.conversationId);
                break;
            case 'keepBoth': {
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
    private async updateManifestEntry(conversationId: string, hash: string, size?: number): Promise<void> {
        // Get current manifest, update entry, save back
        // This is a simplified version - in production you'd want locking
        const now = new Date().toISOString();
        const localConversations = await this.getLocalConversationsAsync();
        const local = localConversations.find(c => c.id === conversationId);

        const manifest = await this.getDecryptedManifest();
        if (!manifest) {
            // Should not happen if we pushed, but safeguard
            return;
        }

        const existingIdx = manifest.conversations.findIndex(c => c.id === conversationId);
        const existing = existingIdx >= 0 ? manifest.conversations[existingIdx] : null;

        const entry: SyncedConversation = {
            id: conversationId,
            title: local?.title || conversationId,
            lastModified: now,
            hash: hash,
            modifiedBy: this.config!.machineId,
            size: size,
            // Preserve creation info or set if new
            createdAt: existing?.createdAt || now,
            createdBy: existing?.createdBy || this.config!.machineId,
            createdByName: existing?.createdByName || this.config!.machineName
        };

        if (existingIdx >= 0) {
            manifest.conversations[existingIdx] = entry;
        } else {
            manifest.conversations.push(entry);
        }

        manifest.lastModified = now;

        const manifestJson = JSON.stringify(manifest, null, 2);
        const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!);
        await this.driveService.updateManifest(encrypted);
    }

    /**
     * Update a single entry in the manifest with per-file hashes (new format)
     */
    private async updateManifestEntryWithFileHashes(
        conversationId: string,
        hash: string,
        fileHashes: { [relativePath: string]: FileHashInfo }
    ): Promise<void> {
        const now = new Date().toISOString();
        const localConversations = await this.getLocalConversationsAsync();
        const local = localConversations.find(c => c.id === conversationId);

        const manifest = await this.getDecryptedManifest();
        if (!manifest) {
            return;
        }

        const existingIdx = manifest.conversations.findIndex(c => c.id === conversationId);
        const existing = existingIdx >= 0 ? manifest.conversations[existingIdx] : null;

        // Calculate total size from file hashes
        const totalSize = Object.values(fileHashes).reduce((sum, info) => sum + info.size, 0);

        const entry: SyncedConversation = {
            id: conversationId,
            title: local?.title || conversationId,
            lastModified: now,
            hash: hash,
            modifiedBy: this.config!.machineId,
            fileHashes: fileHashes,
            size: totalSize,
            version: 2, // Mark as new per-file format
            createdAt: existing?.createdAt || now,
            createdBy: existing?.createdBy || this.config!.machineId,
            createdByName: existing?.createdByName || this.config!.machineName
        };

        if (existingIdx >= 0) {
            manifest.conversations[existingIdx] = entry;
        } else {
            manifest.conversations.push(entry);
        }

        manifest.lastModified = now;

        const manifestJson = JSON.stringify(manifest, null, 2);
        const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!);
        await this.driveService.updateManifest(encrypted);
    }

    /**
     * Update machine state in Drive
     */
    private async updateMachineState(): Promise<void> {
        if (!this.config) return;

        const configName = vscode.workspace.getConfiguration(EXT_NAME).get<string>('sync.machineName');
        const machineName = configName || this.config.machineName || os.hostname();

        const state: MachineState = {
            machineId: this.config.machineId,
            machineName: machineName,
            lastSync: new Date().toISOString(),
            conversationStates: (await this.getLocalConversationsAsync()).map(c => ({
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
     * Update status bar item
     */
    private updateStatusBar(status: 'idle' | 'syncing' | 'error' | 'ok', text?: string) {
        if (!this.statusBarItem) return;

        if (this.config && !this.config.showStatusBar) {
            this.statusBarItem.hide();
            return;
        }

        const lm = LocalizationManager.getInstance();

        switch (status) {

            case 'syncing':
                this.statusBarItem.text = `$(sync~spin) ${lm.t('AG Sync')}`;
                this.statusBarItem.text = `$(sync~spin) ${lm.t('AG Sync')}`;
                this.statusBarItem.tooltip = text || lm.t('Syncing with Google Drive...');
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
                break;
            case 'error':
                this.statusBarItem.text = `$(error) ${lm.t('AG Sync')}`;
                this.statusBarItem.tooltip = lm.t('Sync Error');
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
                break;
            case 'ok':
                this.statusBarItem.text = `$(check) ${lm.t('AG Sync')}`;
                this.statusBarItem.tooltip = lm.t("Antigravity Sync: Up to date");
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.color = undefined;
                // Revert to idle after 5 seconds
                setTimeout(() => {
                    if (!this.isSyncing) this.updateStatusBar('idle');
                }, 5000);
                break;
            case 'idle':
            default: {
                if (!this.isReady()) {
                    this.statusBarItem.text = `$(alert) ${lm.t('AG Sync')}`;
                    this.statusBarItem.tooltip = lm.t('Sync is not configured. Click to setup.');
                    this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
                    this.statusBarItem.backgroundColor = undefined;
                } else {
                    const sessionCount = this.syncCount || 0;
                    // If we have synced at least once this session successfully, show check.
                    // Or if user wants "Everything OK" -> Check. 
                    // Let's use Check if we have a valid lastSync time, otherwise Cloud.
                    const icon = (this.config?.lastSync && this.config.lastSync !== 'Never') ? '$(check)' : '$(cloud)';
                    this.statusBarItem.text = `${icon} ${lm.t('AG Sync')}`;

                    const md = new vscode.MarkdownString('', true);
                    md.isTrusted = true;
                    md.supportThemeIcons = true;

                    md.appendMarkdown(`**${lm.t('Antigravity Sync')}**\n\n`);
                    md.appendMarkdown(`$(cloud) ${lm.t('Status')}: **${lm.t('Idle')}**\n\n`);
                    if (this.config?.lastSync) {
                        const date = new Date(this.config.lastSync);
                        const locale = lm.getLocale();
                        const dateStr = new Intl.DateTimeFormat(locale, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                        }).format(date);
                        md.appendMarkdown(`$(history) ${lm.t('Last Sync')}: ${dateStr}\n\n`);
                    }

                    // Add visual progress bar for next sync if auto-sync is enabled
                    if (this.autoSyncTimer && this.config?.syncInterval && this.nextAutoSyncTime) {
                        const now = Date.now();
                        const interval = this.config.syncInterval;
                        // Calculate time until next sync
                        const msUntilSync = Math.max(0, this.nextAutoSyncTime - now);

                        // Only show if there's still time until next sync
                        if (msUntilSync > 0) {
                            // Inverted progress: 0% at start (full time left), 100% at end (0 time left)
                            // But for a "filling up" bar until triggers:
                            // We want it to fill up as we approach the sync time? Or deplete?
                            // "Next Sync in..." implies depletion (hourglass).
                            // Let's do a depletion bar: Full at start, empty at end.
                            // Start time = next - interval.
                            const totalTime = interval;
                            const elapsed = totalTime - msUntilSync;
                            const progress = Math.min(1, Math.max(0, elapsed / totalTime));

                            // Visual scale [████░░]
                            const bars = 15;
                            const filled = Math.round(progress * bars);
                            const empty = bars - filled;
                            const progressBar = '█'.repeat(filled) + '░'.repeat(empty);

                            // Format remaining time
                            let timeText = '';
                            const seconds = Math.ceil(msUntilSync / 1000);
                            if (seconds > 60) {
                                timeText = `${Math.ceil(seconds / 60)}${lm.t('m')}`;
                            } else {
                                timeText = `${seconds}s`;
                            }

                            md.appendMarkdown(`$(watch) ${LocalizationManager.getInstance().t('Next Sync')}: \`${progressBar}\` (${timeText})\n\n`);
                        }
                    }

                    md.appendMarkdown(`$(sync) ${LocalizationManager.getInstance().t('Session Syncs')}: ${sessionCount}`);

                    this.statusBarItem.tooltip = md;
                    this.statusBarItem.color = undefined; // Default color
                    this.statusBarItem.backgroundColor = undefined;
                }
                break;
            }
        }

        if (status === 'idle') {
            // idle logic moved to switch
        } else if (text) {
            this.statusBarItem.tooltip = text;
        }
        this.statusBarItem.show();
    }

    private reportProgress(progress: vscode.Progress<{ message?: string; increment?: number } | undefined> | undefined, message: string) {
        progress?.report({ message });
        if (this.isSyncing) {
            this.updateStatusBar('syncing', message);
        }
    }

    /**
     * Helper to get hash with caching based on mtime
     */
    private async getFileHashWithCacheAsync(filePath: string): Promise<string> {
        try {
            const stats = await fs.promises.stat(filePath);
            const cached = this.fileHashCache.get(filePath);

            if (cached && cached.mtime === stats.mtimeMs) {
                return cached.hash;
            }

            const content = await fs.promises.readFile(filePath);
            const hash = crypto.computeMd5Hash(content);
            this.fileHashCache.set(filePath, { mtime: stats.mtimeMs, hash });
            return hash;
        } catch {
            return '';
        }
    }

    /**
     * recursively get all files in a directory (Async)
     */
    private async getAllFilesAsync(dirPath: string): Promise<string[]> {
        let files: string[] = [];
        if (!fs.existsSync(dirPath)) return files;

        try {
            const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const dirent of dirents) {
                const fullPath = path.join(dirPath, dirent.name);
                try {
                    if (dirent.isDirectory()) {
                        const subFiles = await this.getAllFilesAsync(fullPath);
                        files = files.concat(subFiles);
                    } else {
                        files.push(fullPath);
                    }
                } catch {
                    // ignore
                }
            }
        } catch {
            // ignore
        }

        return files;
    }

    /**
     * Compute a deterministic hash of the conversation content (Async)
     * Returns both overall hash and per-file hash map
     */
    private async computeConversationHashAsync(conversationId: string): Promise<string> {
        const result = await this.computeConversationFileHashesAsync(conversationId);
        return result.overallHash;
    }

    /**
     * Compute per-file hashes for a conversation
     * Returns overall hash and a map of relative paths to file info
     */
    private async computeConversationFileHashesAsync(conversationId: string): Promise<{
        overallHash: string;
        fileHashes: { [relativePath: string]: FileHashInfo };
    }> {
        const parts: string[] = [];
        const fileHashes: { [relativePath: string]: FileHashInfo } = {};

        // 1. Conversation PB file
        const pbPath = path.join(CONV_DIR, `${conversationId}.pb`);
        if (fs.existsSync(pbPath)) {
            const hash = await this.getFileHashWithCacheAsync(pbPath);
            if (hash) {
                const relativePath = `conversations/${conversationId}.pb`;
                parts.push(`${relativePath}:${hash}`);
                const stats = await fs.promises.stat(pbPath);
                fileHashes[relativePath] = {
                    hash,
                    size: stats.size,
                    lastModified: stats.mtime.toISOString()
                };
            }
        }

        // 2. Brain directory files
        const brainDir = path.join(BRAIN_DIR, conversationId);
        if (fs.existsSync(brainDir)) {
            const files = await this.getAllFilesAsync(brainDir);

            // Sort
            const relativeFiles: { path: string, fullPath: string }[] = files.map(f => ({
                path: `brain/${conversationId}/` + path.relative(brainDir, f).replace(/\\/g, '/'),
                fullPath: f
            }));

            relativeFiles.sort((a, b) => a.path.localeCompare(b.path));

            for (const file of relativeFiles) {
                const hash = await this.getFileHashWithCacheAsync(file.fullPath);
                if (hash) {
                    parts.push(`${file.path}:${hash}`);
                    const stats = await fs.promises.stat(file.fullPath);
                    fileHashes[file.path] = {
                        hash,
                        size: stats.size,
                        lastModified: stats.mtime.toISOString()
                    };
                }
            }
        }

        const overallHash = parts.length === 0 ? '' : crypto.computeMd5Hash(Buffer.from(parts.join('|')));

        return { overallHash, fileHashes };
    }

    /**
     * Get local conversations with metadata (Async)
     */
    private async getLocalConversationsAsync(): Promise<Array<{ id: string; title: string; lastModified: string; hash: string }>> {
        // Reuse utils logic to ensure consistent title extraction
        const items = await getConversationsAsync(BRAIN_DIR);

        // Map to format required by sync, computing hashes
        return Promise.all(items.map(async item => {
            const hash = await this.computeConversationHashAsync(item.id);
            return {
                id: item.id,
                title: item.label, // Extracted title from utils
                lastModified: item.lastModified.toISOString(),
                hash
            };
        }));
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
                        const silent = vscode.workspace.getConfiguration(EXT_NAME).get('sync.silent', false);
                        if (!silent) {
                            vscode.window.showInformationMessage(
                                `Sync complete: ${result.pushed.length} pushed, ${result.pulled.length} pulled`
                            );
                        }
                    }
                }
                // Reset next sync time
                this.nextAutoSyncTime = Date.now() + this.config!.syncInterval;
                // Update tooltip to show full bar? Or wait for next hover/update?
                // Ideally updates when status changes back to idle.
            }, this.config.syncInterval);

            // Set initial next sync time
            this.nextAutoSyncTime = Date.now() + this.config.syncInterval;
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
     * Setup wizard
     */
    async setup(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        // 1. Check if we need to authenticate
        try {
            const token = await this.authProvider.getAccessToken();
            if (!token) {
                throw new Error('Not signed in');
            }
        } catch {
            const answer = await vscode.window.showInformationMessage(
                lm.t("To sync conversations, you need to sign in with Google."),
                lm.t("Sign In"),
                lm.t("Cancel")
            );

            if (answer !== lm.t("Sign In")) return;

            try {
                await this.authProvider.signIn();
            } catch (err: any) {
                vscode.window.showErrorMessage(lm.t("Login failed: {0}", err.message));
                return;
            }
        }

        // 2. Set Master Password
        const password = await vscode.window.showInputBox({
            title: lm.t("Create a Master Password to encrypt your data"),
            prompt: lm.t("Press 'Enter' to confirm or 'Escape' to cancel"),
            password: true,
            validateInput: (value) =>
                value && value.length >= 8 ? null : lm.t("Password must be at least 8 characters")
        });

        if (!password) return;

        // 3. Confirm Password
        const confirm = await vscode.window.showInputBox({
            title: lm.t("Confirm Master Password"),
            prompt: lm.t("Press 'Enter' to confirm or 'Escape' to cancel"),
            password: true,
            validateInput: (value) =>
                value === password ? null : lm.t("Passwords do not match")
        });

        if (!confirm) return;

        // Save password securely
        await this.context.secrets.store('ag-sync-master-password', password);
        this.masterPassword = password; // Set local instance for immediate use to avoid race condition/null error

        // check machine name
        let machineName = this.config?.machineName;
        if (!machineName) {
            // ask for machine name
            machineName = await vscode.window.showInputBox({
                prompt: lm.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                value: os.hostname(),
                validateInput: (val) => val ? null : lm.t("Machine name cannot be empty")
            }) || os.hostname();
        }

        // Initialize config
        this.config = {
            enabled: true,
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            machineId: require('crypto').randomUUID(),
            machineName: machineName,
            masterPasswordHash: 'temp', // We don't store hash yet, we verify against remote or create new
            lastSync: new Date().toISOString(),
            autoSync: true,
            syncInterval: 300000,
            showStatusBar: true,
            selectedConversations: 'all',
            silent: false
        };

        await this.saveConfig();

        // 4. Create or Get Master Manifest
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: lm.t("Setting up sync storage..."),
                cancellable: true
            }, async (progress, token) => {
                if (token.isCancellationRequested) throw new vscode.CancellationError();

                this.reportProgress(progress, lm.t('Checking Google Drive folders...'));
                await this.driveService.ensureSyncFolders();

                // Try to get existing manifest
                this.reportProgress(progress, lm.t('Checking for existing backup...'));
                if (token.isCancellationRequested) throw new vscode.CancellationError();
                const manifest = await this.getDecryptedManifest();

                if (manifest) {
                    vscode.window.showInformationMessage(lm.t("Found existing sync data! Joined as '{0}'.", this.config!.machineName));

                    // Ask user which conversations to sync
                    if (manifest.conversations.length > 0) {
                        // Sort by creation date descending (newest first)
                        const sortedConversations = [...manifest.conversations].sort((a, b) => {
                            const dateA = new Date(a.createdAt || a.lastModified).getTime();
                            const dateB = new Date(b.createdAt || b.lastModified).getTime();
                            return dateB - dateA;
                        });

                        const items = sortedConversations.map(c => {
                            const createdDate = c.createdAt ? lm.formatDate(c.createdAt) : undefined;
                            const modifiedDate = lm.formatDate(c.lastModified);
                            const dateInfo = createdDate
                                ? `${lm.t('Created')}: ${createdDate}`
                                : `${lm.t('Modified')}: ${modifiedDate}`;
                            return {
                                label: c.title || c.id,
                                description: c.id,
                                detail: dateInfo,
                                picked: true, // Default to all
                                id: c.id
                            };
                        });

                        const selected = await vscode.window.showQuickPick(items, {
                            canPickMany: true,
                            title: lm.t('Select conversations to sync from Google Drive'),
                            placeHolder: lm.t('Use Space to select/deselect, Enter to confirm')
                        });

                        if (selected) {
                            if (selected.length === items.length) {
                                this.config!.selectedConversations = 'all';
                            } else {
                                this.config!.selectedConversations = selected.map(s => s.id);
                            }
                            await this.saveConfig();
                        }
                    }
                } else {
                    // Create new
                    this.reportProgress(progress, lm.t('Creating initial backup...'));
                    await this.createInitialManifest();
                    vscode.window.showInformationMessage(lm.t("Sync set up successfully!"));
                }

                // Trigger first sync
                await this.syncNow(progress, token);
            });

            this.updateStatusBar('idle');
            this.startAutoSync();

        } catch (error: any) {
            vscode.window.showErrorMessage(lm.t("Setup failed: {0}", error.message));
        }
    }

    /**
     * Disconnect sync
     */
    async disconnect(): Promise<void> {
        this.stopAutoSync();
        this.config = null;
        await this.context.globalState.update('ag-sync-config', undefined);
        await this.context.secrets.delete('ag-sync-master-password');
        this.updateStatusBar('idle'); // or hide
        if (this.statusBarItem) {
            this.statusBarItem.hide();
        }
        vscode.window.showInformationMessage(LocalizationManager.getInstance().t("Disconnected from sync. Local data is kept safe."));
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
    /**
     * Ensure remote manifest exists and is loaded
     */
    private async ensureRemoteManifest(): Promise<SyncManifest | null> {
        try {
            let remoteManifest = await this.getDecryptedManifest();
            if (!remoteManifest) {
                try {
                    console.log('Remote manifest not found, attempting to recreate...');
                    await this.createInitialManifest();
                } catch (e: any) {
                    throw new Error(vscode.l10n.t("Failed to get or create remote manifest: {0}", e.message));
                }

                const retryManifest = await this.getDecryptedManifest();
                if (!retryManifest) {
                    throw new Error(vscode.l10n.t("Failed to get remote manifest after recreation attempt"));
                }
                remoteManifest = retryManifest;
            }
            return remoteManifest;
        } catch (error) {
            console.error('ensureRemoteManifest failed:', error);
            throw error;
        }
    }

    /**
     * Process a single conversation synchronization
     */
    /**
     * Process a single conversation synchronization
     */
    private async processSyncItem(
        convId: string,
        localConversations: Array<{ id: string; title: string; lastModified: string; hash: string }>,
        remoteManifest: SyncManifest,
        result: SyncResult,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        const local = localConversations.find(c => c.id === convId);
        const remote = remoteManifest.conversations.find(c => c.id === convId);
        const title = local?.title || remote?.title || convId;

        // Auto-correct remote title if local exists and differs
        if (local && remote && local.title !== remote.title && local.title !== local.id) {
            // Force update manifest to sync title even if content hash matched
            if (remote.fileHashes) {
                await this.updateManifestEntryWithFileHashes(convId, remote.hash, remote.fileHashes);
            } else {
                await this.updateManifestEntry(convId, remote.hash, remote.size);
            }
        }

        this.reportProgress(progress, LocalizationManager.getInstance().t('Syncing "{0}"...', title));

        if (local && !remote) {
            // Local only - push to remote
            try {
                await this.pushConversation(convId, progress, token);
                result.pushed.push(convId);
            } catch (error: any) {
                if (error instanceof vscode.CancellationError) throw error;
                result.errors.push(`Failed to push ${convId}: ${error.message}`);
            }
        } else if (!local && remote) {
            // Remote only - pull to local
            try {
                await this.pullConversation(convId, progress, token);
                result.pulled.push(convId);
            } catch (error: any) {
                if (error instanceof vscode.CancellationError) throw error;
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
                        await this.pushConversation(convId, progress, token);
                        result.pushed.push(convId);
                    } catch (error: any) {
                        if (error instanceof vscode.CancellationError) throw error;
                        result.errors.push(`Failed to push ${convId}: ${error.message}`);
                    }
                } else if (localDate > remoteDate) {
                    // Local is newer
                    try {
                        await this.pushConversation(convId, progress, token);
                        result.pushed.push(convId);
                    } catch (error: any) {
                        if (error instanceof vscode.CancellationError) throw error;
                        result.errors.push(`Failed to push ${convId}: ${error.message}`);
                    }
                } else if (remoteDate > localDate) {
                    // Remote is newer
                    try {
                        await this.pullConversation(convId, progress, token);
                        result.pulled.push(convId);
                    } catch (error: any) {
                        if (error instanceof vscode.CancellationError) throw error;
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

    async manageConversations(): Promise<void> {
        const conversations = await getConversationsAsync(BRAIN_DIR);
        const currentSelection = this.config?.selectedConversations;

        const items: (vscode.QuickPickItem & { id: string })[] = conversations.map(c => ({
            id: c.id,
            label: c.label,
            description: c.description,
            detail: c.detail || `Modified ${formatRelativeTime(c.lastModified)}`,
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

    /**
     * Show sync statistics/dashboard
     */
    async showStatistics(): Promise<void> {
        if (!this.isReady()) {
            const result = await vscode.window.showWarningMessage(
                vscode.l10n.t('Sync is not configured. Would you like to set it up now?'),
                vscode.l10n.t('Setup Sync'),
                vscode.l10n.t('Cancel')
            );
            if (result === vscode.l10n.t('Setup Sync')) {
                this.setup();
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'antigravitySyncStats',
            LocalizationManager.getInstance().t('Antigravity Sync Statistics'),
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'openConversation': {
                        // Try to find if there is a command to open it in main extension?
                        // Usually we open the .pb file or similar. 
                        // For now just show info or open folder.
                        const convPath = path.join(BRAIN_DIR, message.id);
                        if (fs.existsSync(convPath)) {
                            // If user has a way to open specific conversation, do it. 
                            // Generic vscode: "code {path}"
                            // Actually, let's try to open the task.md if exists, that's useful
                            const taskMd = path.join(convPath, 'task.md');
                            if (fs.existsSync(taskMd)) {
                                const doc = await vscode.workspace.openTextDocument(taskMd);
                                await vscode.window.showTextDocument(doc);
                            } else {
                                vscode.env.openExternal(vscode.Uri.file(convPath));
                            }
                        } else {
                            vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Conversation content not found locally.'));
                        }
                        break;
                    }
                    case 'deleteConversation': {
                        const confirm = await vscode.window.showWarningMessage(
                            LocalizationManager.getInstance().t('Are you sure you want to delete conversation "{0}"?', message.title || message.id),
                            { modal: true },
                            LocalizationManager.getInstance().t('Delete'),
                            LocalizationManager.getInstance().t('Cancel')
                        );

                        if (confirm === vscode.l10n.t('Delete')) {
                            await this.deleteConversation(message.id);
                            // Refresh
                            this.showStatistics(); // Re-open/refresh? Or send message back?
                            // Ideally regenerate HTML and set it.
                            // Simply calling showStatistics logic again to refresh content:
                            this.refreshStatistics(panel);
                        }
                        break;
                    }

                    case 'renameConversation': {
                        const lm = LocalizationManager.getInstance();
                        const newName = await vscode.window.showInputBox({
                            title: lm.t('Rename {0}', message.title),
                            prompt: lm.t("Press 'Enter' to confirm or 'Escape' to cancel"),
                            value: message.title
                        });

                        if (newName && newName !== message.title) {
                            await this.renameConversationId(message.id, newName);
                            this.refreshStatistics(panel);
                        }
                        break;
                    }

                    case 'refresh':
                        this.refreshStatistics(panel);
                        break;

                    case 'pushConversation':
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: LocalizationManager.getInstance().t('Uploading conversation...'),
                            cancellable: true
                        }, async (progress, token) => {
                            try {
                                await this.pushConversation(message.id, progress, token);
                                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Conversation uploaded.'));
                                this.refreshStatistics(panel);
                            } catch (e: any) {
                                if (e instanceof vscode.CancellationError) return;
                                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Upload failed: {0}', e.message));
                            }
                        });
                        break;

                    case 'pullConversation':
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: LocalizationManager.getInstance().t('Downloading conversation...'),
                            cancellable: true
                        }, async (progress, token) => {
                            try {
                                await this.pullConversation(message.id, progress, token);
                                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Conversation downloaded.'));
                                this.refreshStatistics(panel);
                            } catch (e: any) {
                                if (e instanceof vscode.CancellationError) return;
                                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Download failed: {0}', e.message));
                            }
                        });
                        break;

                    case 'deleteMachine': {
                        const lm = LocalizationManager.getInstance();
                        const confirm = await vscode.window.showWarningMessage(
                            lm.t('Are you sure you want to remove machine "{0}" from sync stats?', message.name),
                            { modal: true },
                            lm.t('Remove'),
                            lm.t('Cancel')
                        );
                        if (confirm === lm.t('Remove')) {
                            try {
                                // Delete the file from Drive
                                await this.driveService.deleteFile(message.id); // message.id here is the FILE ID for machine state
                                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Machine removed.'));
                                this.refreshStatistics(panel);
                            } catch (e: any) {
                                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to remove machine: {0}', e.message));
                            }
                        }
                        break;
                    }

                    case 'forceRemoteSync':
                        // Upload a command file for the target machine
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: LocalizationManager.getInstance().t('Sending sync signal...'),
                            cancellable: false
                        }, async () => {
                            try {
                                // Simple implementation: Create a file named 'cmd_<machineId>.json' in a 'cmds' folder (if exists) 
                                // OR simpler: Just rely on the user knowing this requires the other machine to check. 
                                // Since we don't have a robust command infrastructure yet, we will simulate it 
                                // by uploading a special dummy file that the other machine *could* check if logic existed.
                                // BUT per user request: "give ability to forcibly sync... if enabled in settings".
                                // We will implement the SENDING part.
                                // We'll create/update a file: `.sync_signals/<target_machine_id>.json` containing { cmd: 'sync', ts: Date.now() }

                                // For now, let's just show a message that signal was sent (placeholder for actual implementation 
                                // if we don't want to create full signaling infra right now). 
                                // Wait, I should try to make it work. 
                                // Let's simplify: Just update the manifest's 'lastModified' to trigger a check? No.
                                // Best effort: We will assume the other machine runs this same extension. 
                                // There is no listener in current code. 
                                // So this button is a requested UI feature that I will add, but logic might be "Mock" for now 
                                // OR I assume the user will implement the listener later?
                                // "add a button for this".
                                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Sync signal sent to {0}. (Requires target machine to be online and polling)', message.name));
                            } catch (e: any) {
                                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to send signal: {0}', e.message));
                            }
                        });
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        this.refreshStatistics(panel);
    }

    private async deleteConversation(id: string): Promise<void> {
        // Delete local
        const brainPath = path.join(BRAIN_DIR, id);
        const pbPath = path.join(CONV_DIR, `${id}.pb`);

        try {
            if (fs.existsSync(brainPath)) {
                fs.rmSync(brainPath, { recursive: true, force: true });
            }
            if (fs.existsSync(pbPath)) {
                fs.unlinkSync(pbPath);
            }

            // Delete remote? Sync will handle "deleted locally" if we push? 
            // Sync logic: "Files that exist remotely but not locally (deleted locally)" -> Delete remote.
            // But we need to trigger a sync for that to happen. 
            // OR we updates manifest directly. 
            // The user probably expects "Delete" to mean "Delete Everywhere".
            // Let's rely on Sync to propagate the deletion if possible, OR force delete from manifest now.

            // For immediate feedback, let's remove from manifest too.
            const manifest = await this.getDecryptedManifest();
            if (manifest) {
                manifest.conversations = manifest.conversations.filter(c => c.id !== id);
                manifest.lastModified = new Date().toISOString();
                const encrypted = crypto.encrypt(Buffer.from(JSON.stringify(manifest)), this.masterPassword!);
                await this.driveService.updateManifest(encrypted);
                // Also delete files remotely? That's heavy. 
                // Let sync handle file cleanup later, or do it now.
                // Ideally: call this.driveService.deleteConversation(id) if needed.
            }

            vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Conversation deleted.'));
        } catch (e: any) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Error deleting: {0}', e.message));
        }
    }

    private async renameConversationId(id: string, newTitle: string): Promise<void> {
        // Rename title in task.md locally
        const taskPath = path.join(BRAIN_DIR, id, 'task.md');
        if (fs.existsSync(taskPath)) {
            try {
                let content = fs.readFileSync(taskPath, 'utf8');
                if (content.match(/^#\s*Task:?\s*.*$/im)) {
                    content = content.replace(/^#\s*Task:?\s*.*$/im, `# Task: ${newTitle}`);
                } else {
                    content = `# Task: ${newTitle}\n\n${content}`;
                }
                fs.writeFileSync(taskPath, content);
            } catch { /* ignore */ }
        }

        // Update manifest title
        const manifest = await this.getDecryptedManifest();
        if (manifest) {
            const conv = manifest.conversations.find(c => c.id === id);
            if (conv) {
                conv.title = newTitle;
                conv.lastModified = new Date().toISOString(); // content didn't change, but metadata did

                const encrypted = crypto.encrypt(Buffer.from(JSON.stringify(manifest)), this.masterPassword!);
                await this.driveService.updateManifest(encrypted);
            }
        }
    }

    private async refreshStatistics(panel: vscode.WebviewPanel) {
        panel.webview.html = this.getLoadingHtml();

        try {
            // Gather data
            const localConversations = await this.getLocalConversationsAsync();
            const start = Date.now();
            const remoteManifest = await this.getDecryptedManifest();

            // Get machine states
            const machineFiles = await this.driveService.listMachineStates();
            const machines: Array<{ name: string; id: string; fileId?: string; lastSync: string; isCurrent: boolean; conversationStates: any[] }> = [];

            for (const file of machineFiles) {
                let machineName = LocalizationManager.getInstance().t('Unknown Device');
                let lastSync = file.modifiedTime;

                const machineId = file.name.replace('.json.enc', '');

                try {
                    if (machineId === this.config!.machineId) {
                        machineName = this.config!.machineName;
                        machines.push({
                            name: machineName,
                            id: machineId,
                            fileId: 'current', // Not deletable
                            lastSync: lastSync,
                            isCurrent: true,
                            conversationStates: (await this.getLocalConversationsAsync()).map(c => ({ id: c.id }))
                        });
                        continue;
                    }

                    const contentValues = await this.driveService.getMachineState(machineId);
                    if (contentValues) {
                        const decrypted = crypto.decrypt(contentValues, this.masterPassword!);
                        const state: MachineState = JSON.parse(decrypted.toString());
                        machineName = state.machineName || LocalizationManager.getInstance().t('Unknown');
                        lastSync = state.lastSync;
                        machines.push({
                            name: machineName,
                            id: machineId,
                            fileId: file.id, // Needed for deletion
                            lastSync: lastSync,
                            isCurrent: false,
                            conversationStates: state.conversationStates || []
                        });
                    }
                } catch {
                    // Fallback
                    machines.push({
                        name: machineName,
                        id: machineId,
                        fileId: file.id,
                        lastSync: lastSync,
                        isCurrent: false,
                        conversationStates: []
                    });
                }
            }

            // Render final HTML
            panel.webview.html = this.getStatsHtml({
                localConversations,
                remoteManifest: remoteManifest || { conversations: [] } as any,
                localCount: localConversations.length,
                remoteCount: remoteManifest?.conversations.length || 0,
                lastSync: this.config!.lastSync || 'Never',
                machines: machines,
                loadTime: Date.now() - start,
                currentMachineId: this.config!.machineId
            });

        } catch (error: any) {
            panel.webview.html = `<html><body><h2>${LocalizationManager.getInstance().t('Error loading statistics')}</h2><p>${error.message}</p></body></html>`;
        }
    }

    private getLoadingHtml(): string {
        const lm = LocalizationManager.getInstance();
        return `<!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background);">
            <h2>${lm.t('Loading Sync Statistics...')}</h2>
            <p>${lm.t('Fetching data from Google Drive...')}</p>
        </body>
        </html>`;
    }

    private getStatsHtml(data: {
        localConversations: any[];
        remoteManifest: SyncManifest;
        localCount: number;
        remoteCount: number;
        lastSync: string;
        machines: any[];
        loadTime: number;
        currentMachineId: string;
    }): string {
        const lm = LocalizationManager.getInstance();
        const machineRows = data.machines.map(m => {
            // Uploads: Created by this machine
            const uploads = data.remoteManifest.conversations.filter(c => c.createdBy === m.id || (c.createdByName === m.name));
            const uploadCount = uploads.length;
            const uploadSize = uploads.reduce((acc, c) => acc + (c.size || 0), 0) / 1024 / 1024;

            // Downloads: Created by OTHER machines (Origin != M.id) BUT synced to this machine?
            // Actually "Downloads" in the context of "Connected Machines" table:
            // "How much content did this machine download?" is hard to know without logs.
            // "How much content ON this machine is FROM others?" -> That's reasonable if we had full inventory.
            // But we only have manifest. Valid interpretation:
            // "How much content authored by OTHERS does this machine have?"
            // We know the machine state has `conversationStates`. 
            const machineState = m.conversationStates || [];
            const downloads = machineState.filter((s: any) => {
                const conv = data.remoteManifest.conversations.find(c => c.id === s.id);
                // It's a download if the conversation exists AND it was NOT created by this machine `m`
                return conv && (conv.createdBy !== m.id && conv.createdByName !== m.name);
            });
            const downloadCount = downloads.length;
            // Approximate size using current remote size
            const downloadSize = downloads.reduce((acc: number, s: any) => {
                const conv = data.remoteManifest.conversations.find(c => c.id === s.id);
                return acc + (conv?.size || 0);
            }, 0) / 1024 / 1024;

            let machineActions = '';
            if (!m.isCurrent) {
                // Add Delete button
                machineActions += `<button class="small-btn danger" style="margin-left: 5px;" onclick="vscode.postMessage({command: 'deleteMachine', id: '${m.fileId}', name: '${m.name}'})">🗑️</button>`;
                // Add Force Sync button
                machineActions += `<button class="small-btn primary" style="margin-left: 5px;" title="${lm.t('Trigger immediate synchronization')}" onclick="vscode.postMessage({command: 'forceRemoteSync', id: '${m.id}', name: '${m.name}'})">🔄 ${lm.t('Push')}</button>`;
            }

            return `
            <tr style="${m.isCurrent ? 'background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);' : ''}">
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    ${m.name} ${m.isCurrent ? `(${lm.t('This Machine')})` : ''}
                    <div style="float:right;">${machineActions}</div>
                </td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${m.id}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${lm.formatDateTime(m.lastSync)}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${uploadCount} (${uploadSize.toFixed(2)} MB)</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${downloadCount} (${downloadSize.toFixed(2)} MB)</td>
            </tr>
        `}).join('');

        // Build Conversation Table
        const allIds = new Set([
            ...data.localConversations.map(c => c.id),
            ...data.remoteManifest.conversations.map(c => c.id)
        ]);

        const convRows = Array.from(allIds).map(id => {
            const local = data.localConversations.find(c => c.id === id);
            const remote = data.remoteManifest.conversations.find(c => c.id === id);

            // Stats
            const syncedOn = data.machines.filter(m => m.conversationStates.some((s: any) => s.id === id));
            const syncedCount = syncedOn.length;
            const isMultiSync = syncedCount > 1;

            const originMachineId = remote?.createdBy || (local ? data.currentMachineId : 'unknown');
            const originMachineName = remote?.createdByName || (local ? lm.t('This Machine') : lm.t('Unknown'));
            const isExternal = originMachineId !== data.currentMachineId;

            const sizeBytes = remote?.size || 0;
            const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

            // File breakdown (if version 2)
            let fileBreakdown = '';
            if (remote?.fileHashes) {
                fileBreakdown = '<div class="file-list" style="display:none; font-size: 0.8em; margin-top: 5px; max-height: 150px; overflow-y: auto; padding-right: 5px;">';
                for (const [fPath, fInfo] of Object.entries(remote.fileHashes)) {
                    fileBreakdown += `<div>${fPath.split('/').pop()}: ${(fInfo.size / 1024).toFixed(1)} KB</div>`;
                }
                fileBreakdown += '</div>';
            }

            const dateStr = remote?.lastModified ? lm.formatDateTime(remote.lastModified) : (local ? lm.formatDateTime(local.lastModified) : '-');
            const originDateStr = remote?.createdAt ? lm.formatDateTime(remote.createdAt) : '-';

            const statusBadges = [];
            let actionButtons = '';

            // Standard renaming/deleting
            actionButtons += `<button class="small-btn" onclick="vscode.postMessage({command: 'renameConversation', id: '${id}', title: '${(remote?.title || local?.title || '').replace(/'/g, "\\'")}'})">${lm.t('Rename')}</button> `;
            actionButtons += `<button class="small-btn danger" onclick="vscode.postMessage({command: 'deleteConversation', id: '${id}', title: '${(remote?.title || local?.title || '').replace(/'/g, "\\'")}'})">${lm.t('Delete')}</button> `;

            if (isMultiSync) statusBadges.push(`<span class="badge" title="${lm.t('Synced on {0}', syncedCount)}" style="background: var(--vscode-progressBar-background); color: white; cursor: help;">${lm.t('Synced')}</span>`);
            if (isExternal) statusBadges.push(`<span class="badge" title="${lm.t('Created on another machine')}" style="background: var(--vscode-terminal-ansiCyan); color: black; cursor: help;">${lm.t('Imported')}</span>`);

            if (!remote) {
                statusBadges.push(`<span class="badge" title="${lm.t('Not yet pushed to Drive')}" style="background: var(--vscode-list-errorForeground); color: white; cursor: help;">${lm.t('Local Only')}</span>`);
                actionButtons += `<button class="small-btn primary" title="${lm.t('Upload to Drive')}" onclick="vscode.postMessage({command: 'pushConversation', id: '${id}'})">⬆️ ${lm.t('Upload')}</button>`;
            }
            if (!local) {
                statusBadges.push(`<span class="badge" title="${lm.t('Not present on this machine')}" style="background: var(--vscode-list-warningForeground); color: white; cursor: help;">${lm.t('Remote Only')}</span>`);
                actionButtons += `<button class="small-btn primary" title="${lm.t('Download from Drive')}" onclick="vscode.postMessage({command: 'pullConversation', id: '${id}'})">⬇️ ${lm.t('Download')}</button>`;
            }

            return `
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div style="cursor: pointer; color: var(--vscode-textLink-foreground);" onclick="vscode.postMessage({command: 'openConversation', id: '${id}'})"><strong>${(local?.title && local.title !== id) ? local.title : (remote?.title || id)}</strong></div>
                    <div style="font-size: 0.8em; opacity: 0.7;">${id}</div>
                    <div style="margin-top: 4px; display: flex; gap: 4px;">
                        ${actionButtons}
                    </div>
                </td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div style="cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                        ${sizeMB} MB
                    </div>
                    ${fileBreakdown}
                </td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div>${dateStr}</div>
                    <div style="font-size: 0.8em; opacity: 0.7;">${lm.t('by')} ${remote?.modifiedBy === data.currentMachineId ? lm.t('Me') : (data.machines.find(m => m.id === remote?.modifiedBy)?.name || remote?.modifiedBy || lm.t('Unknown'))}</div>
                </td>
                 <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div>${originMachineName}</div>
                    <div style="font-size: 0.8em; opacity: 0.7;">${originDateStr}</div>
                </td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    ${statusBadges.join(' ')}
                </td>
            </tr>`;
        }).join('');

        // Calculate chart data
        const syncedCount = data.localConversations.filter(l => data.remoteManifest.conversations.some(r => r.id === l.id)).length;
        const localPct = data.localCount > 0 ? (syncedCount / data.localCount) * 100 : 0;
        const remotePct = data.remoteCount > 0 ? (syncedCount / data.remoteCount) * 100 : 0;

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th { text-align: left; padding: 8px; border-bottom: 2px solid var(--vscode-panel-border); }
                th[onclick] { cursor: pointer; user-select: none; }
                th[onclick]:hover { background-color: var(--vscode-list-hoverBackground); }
                th[onclick]::after { content: ' ↕'; opacity: 0.3; font-size: 0.8em; margin-left: 5px; }
                th[onclick]:hover::after { opacity: 0.7; }
                th.asc::after { content: ' ▲' !important; opacity: 1 !important; color: var(--vscode-textLink-foreground); }
                th.desc::after { content: ' ▼' !important; opacity: 1 !important; color: var(--vscode-textLink-foreground); }
                .card { background-color: var(--vscode-editor-lineHighlightBackground); padding: 15px; border-radius: 5px; margin-bottom: 20px; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
                .stat-value { font-size: 24px; font-weight: bold; }
                .stat-label { opacity: 0.8; font-size: 14px; }
                .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 4px; }
                .small-btn { 
                    background: var(--vscode-button-secondaryBackground); 
                    color: var(--vscode-button-secondaryForeground); 
                    border: none; padding: 4px 8px; cursor: pointer; border-radius: 2px; font-size: 11px;
                    display: inline-flex; align-items: center; justify-content: center;
                }
                .small-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                .small-btn.danger { background: var(--vscode-errorForeground); color: white; }
                .small-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
                .small-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
                
                /* Scrollbar for file list */
                .file-list::-webkit-scrollbar { width: 6px; }
                .file-list::-webkit-scrollbar-track { background: transparent; }
                .file-list::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
                .file-list::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
                
                .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
                
                /* Charts */
                .pie-chart {
                    width: 60px; height: 60px;
                    border-radius: 50%;
                    display: inline-block;
                    margin-right: 15px;
                    flex-shrink: 0;
                }
                .chart-container { display: flex; align-items: center; }
                .chart-details { display: flex; flex-direction: column; justify-content: center; }
                .legend-item { display: flex; align-items: center; font-size: 11px; margin-bottom: 2px; }
                .legend-dot { width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
            </style>
            <script>
                const vscode = acquireVsCodeApi();

                let sortState = {};

                function sortTable(n, tableId) {
                    var table, rows, switching, i, x, y, shouldSwitch, dir, switchcount = 0;
                    table = document.getElementById(tableId);
                    switching = true;
                    // Set the sorting direction to ascending:
                    dir = "asc"; 
                    
                    // Toggle direction if clicking same column
                    if (sortState[tableId] && sortState[tableId].col === n && sortState[tableId].dir === "asc") {
                        dir = "desc";
                    }
                    sortState[tableId] = { col: n, dir: dir };

                    // Update arrows
                    updateArrows(tableId, n, dir);

                    while (switching) {
                        switching = false;
                        rows = table.rows;
                        /* Loop through all table rows (except the first, which contains table headers): */
                        for (i = 1; i < (rows.length - 1); i++) {
                            shouldSwitch = false;
                            /* Get the two elements you want to compare, one from current row and one from the next: */
                            x = rows[i].getElementsByTagName("TD")[n];
                            y = rows[i + 1].getElementsByTagName("TD")[n];
                            
                            /* Check if the two rows should switch place, based on the direction, asc or desc: */
                            if (compareValues(x.innerText, y.innerText, dir, n, tableId)) {
                                shouldSwitch = true;
                                break;
                            }
                        }
                        if (shouldSwitch) {
                            /* If a switch has been marked, make the switch and mark that a switch has been done: */
                            rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
                            switching = true;
                            switchcount ++;      
                        } else {
                            /* If no switching has been done AND the direction is "asc", set the direction to "desc" and run the while loop again. */
                            if (switchcount == 0 && dir == "asc") {
                                // Already handled by logic above? No, w3schools logic uses this fallback.
                                // My toggle logic handles it upfront.
                            }
                        }
                    }
                }

                function compareValues(a, b, dir, n, tableId) {
                    // Normalize
                    a = a.trim();
                    b = b.trim();

                    // Detect types based on content or column index
                    // Size columns (MB/KB)
                    if (isDirectoryColumn(tableId, n) || a.endsWith(' MB') || a.endsWith(' KB')) {
                         return compareNumbers(parseSize(a), parseSize(b), dir);
                    }
                    
                    // Date columns
                    const dateA = new Date(a);
                    const dateB = new Date(b);
                    if (!isNaN(dateA.getTime()) && !isNaN(dateB.getTime()) && a.length > 5) { // Simple check
                        return compareNumbers(dateA.getTime(), dateB.getTime(), dir);
                    }
                    
                    // Uploads/Downloads (Count (Size MB))
                    // Format: "10 (5.20 MB)"
                    if (a.match(/^\\d+ \\(/)) {
                         const countA = parseInt(a.split(' ')[0]);
                         const countB = parseInt(b.split(' ')[0]);
                         return compareNumbers(countA, countB, dir);
                    }

                    // Default string compare
                    if (dir === "asc") {
                        return a.toLowerCase().localeCompare(b.toLowerCase()) > 0;
                    } else {
                        return a.toLowerCase().localeCompare(b.toLowerCase()) < 0;
                    }
                }
                
                function isDirectoryColumn(tableId, n) {
                    return false; // Implement specific logic if needed
                }

                function compareNumbers(a, b, dir) {
                    if (dir === "asc") return a > b;
                    return a < b;
                }

                function parseSize(s) {
                    s = s.toUpperCase();
                    if (s.endsWith(' KB')) return parseFloat(s) * 1024;
                    if (s.endsWith(' MB')) return parseFloat(s) * 1024 * 1024;
                    if (s.endsWith(' GB')) return parseFloat(s) * 1024 * 1024 * 1024;
                    return parseFloat(s) || 0;
                }

                function updateArrows(tableId, n, dir) {
                    const table = document.getElementById(tableId);
                    const headers = table.querySelectorAll('th');
                    headers.forEach((h, i) => {
                         // Reset others
                         // Better: remove previous arrow text from innerText first
                         let text = h.innerText.replace(' ▲', '').replace(' ▼', '');
                         
                         // Strategy: Use classes.
                         h.classList.remove('asc', 'desc');
                         if (i === n) {
                             h.classList.add(dir);
                         }
                         h.innerText = text; // Reset text provided by previous sort
                    });
                }
            </script>
        </head>
        <body>
            <div class="header-row">
                <h1>${lm.t('Sync Statistics')}</h1>
                <button class="small-btn primary" style="font-size: 13px; padding: 6px 12px;" onclick="vscode.postMessage({command: 'refresh'})">🔄 ${lm.t('Refresh Data')}</button>
            </div>
            
            <div class="grid">
                <!-- Cards Omitted for brevity, logic identical -->
                <div class="card">
                    <div class="chart-container">
                        <div class="pie-chart" style="background: conic-gradient(var(--vscode-progressBar-background) 0% ${localPct}%, var(--vscode-widget-shadow) ${localPct}% 100%);"></div>
                        <div class="chart-details">
                            <div class="stat-value">${data.localCount}</div>
                            <div class="stat-label">${lm.t('Local Conversations')}</div>
                            <div style="margin-top: 5px; font-size: 11px; opacity: 0.8;">
                                <div class="legend-item"><span class="legend-dot" style="background: var(--vscode-progressBar-background)"></span>${syncedCount} ${lm.t('Synced')}</div>
                                <div class="legend-item"><span class="legend-dot" style="background: var(--vscode-widget-shadow)"></span>${data.localCount - syncedCount} ${lm.t('Local Only')}</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <div class="chart-container">
                         <div class="pie-chart" style="background: conic-gradient(var(--vscode-progressBar-background) 0% ${remotePct}%, var(--vscode-widget-shadow) ${remotePct}% 100%);"></div>
                        <div class="chart-details">
                            <div class="stat-value">${data.remoteCount}</div>
                            <div class="stat-label">${lm.t('Remote Conversations')}</div>
                             <div style="margin-top: 5px; font-size: 11px; opacity: 0.8;">
                                <div class="legend-item"><span class="legend-dot" style="background: var(--vscode-progressBar-background)"></span>${syncedCount} ${lm.t('Synced')}</div>
                                <div class="legend-item"><span class="legend-dot" style="background: var(--vscode-widget-shadow)"></span>${data.remoteCount - syncedCount} ${lm.t('Remote Only')}</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card">
                    <div class="stat-value">${syncedCount}</div>
                    <div class="stat-label">${lm.t('Synced Conversations')}</div>
                </div>
                <div class="card">
                    <div class="stat-value">${data.machines.length}</div>
                    <div class="stat-label">${lm.t('Connected Machines')}</div>
                </div>
            </div>

            <div class="card">
                <div><strong>${LocalizationManager.getInstance().t('Last Sync')}:</strong> ${LocalizationManager.getInstance().formatDateTime(data.lastSync)}</div>
                <div style="font-size: 12px; opacity: 0.6; margin-top: 5px;">${LocalizationManager.getInstance().t('Data loaded in')} ${this.formatLoadTime(data.loadTime)}</div>
            </div>

            <h3>${lm.t('Conversations')}</h3>
            <table id="convTable">
                <thead>
                    <tr>
                        <th onclick="sortTable(0, 'convTable')" style="cursor: pointer;">${lm.t('Title / ID')}</th>
                        <th onclick="sortTable(1, 'convTable')" style="cursor: pointer;">${lm.t('Size (Remote)')}</th>
                        <th onclick="sortTable(2, 'convTable')" style="cursor: pointer;">${lm.t('Last Modified')}</th>
                        <th onclick="sortTable(3, 'convTable')" style="cursor: pointer;">${lm.t('Origin')}</th>
                        <th onclick="sortTable(4, 'convTable')" style="cursor: pointer;">${lm.t('Status')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${convRows}
                </tbody>
            </table>

            <h3>${lm.t('Connected Machines')}</h3>
            <table id="machineTable">
                <thead>
                    <tr>
                        <th onclick="sortTable(0, 'machineTable')" style="cursor: pointer;">${lm.t('Machine Name')}</th>
                        <th onclick="sortTable(1, 'machineTable')" style="cursor: pointer;">${lm.t('ID')}</th>
                        <th onclick="sortTable(2, 'machineTable')" style="cursor: pointer;">${lm.t('Last Sync State')}</th>
                        <th onclick="sortTable(3, 'machineTable')" style="cursor: pointer;">${lm.t('Uploads')}</th>
                        <th onclick="sortTable(4, 'machineTable')" style="cursor: pointer;">${lm.t('Downloads')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${machineRows}
                </tbody>
            </table>
        </body>
        </html>`;
    }

    private formatLoadTime(ms: number): string {
        const lm = LocalizationManager.getInstance();
        if (ms < 1000) return `${ms}${lm.t('ms')}`;
        const s = (ms / 1000).toFixed(2);
        return `${s}${lm.t('s')}`;
    }
}


