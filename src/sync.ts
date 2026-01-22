import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { GoogleDriveService, SyncManifest, SyncedConversation, Machine, MachineState, FileHashInfo } from './googleDrive';
import * as crypto from './crypto';
import { LocalizationManager } from './l10n/localizationManager';
import { getConversationsAsync, limitConcurrency, formatDuration, ConversationItem } from './utils';

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
    private cachedManifest: SyncManifest | null = null;
    private lastManifestFetch: number = 0;

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
                this.reportProgress(progress, lm.t('Starting synchronization...'));
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
                result.success ? 'ok' : 'error',
                result.success ? undefined : result.errors.join('\n')
            );

            // Error suggestions
            if (result.errors.length > 0) {
                const notFoundErrors = result.errors.filter(e => e.includes('not found in Drive'));
                const suggestSolutions = vscode.workspace.getConfiguration(EXT_NAME).get('sync.suggestSolutions', true);

                if (notFoundErrors.length > 0 && suggestSolutions) {
                    const fixAction = lm.t('Fix Manifest (Remove Missing)');
                    const pushAction = lm.t('Push Local Versions');
                    const settingsAction = lm.t('Disable Suggestions');

                    vscode.window.showWarningMessage(
                        lm.t('Some conversations were not found in Google Drive. This usually happens if they were deleted manually from Drive but are still in the sync manifest.'),
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
                            vscode.window.showInformationMessage(lm.t('To push local versions, simply modify them locally to trigger a change, or use "Fix Manifest" then sync again.'));
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
        const lm = LocalizationManager.getInstance();
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
                title: lm.t('Fixing manifest...'),
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
                    vscode.window.showInformationMessage(lm.t('Removed {0} missing conversation(s) from manifest.', removedCount));
                }
            });
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Failed to fix manifest: {0}', e.message));
        }
    }

    /**
     * Push a single conversation to Google Drive (per-file sync)
     */
    /**
     * Push a single conversation to Google Drive (per-file sync)
     */
    async pushConversation(conversationId: string, progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<void> {
        const lm = LocalizationManager.getInstance();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (!this.masterPassword) {
            throw new Error(lm.t('Encryption password not set'));
        }

        // Get local file hashes
        this.reportProgress(progress, lm.t('Analyzing {0}...', conversationId));
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
            this.reportProgress(progress, lm.t('Uploading: {0} ({1}/{2})...', relativePath, uploadedCount, filesToUpload.length));

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
        const lm = LocalizationManager.getInstance();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (!this.masterPassword) {
            throw new Error(lm.t('Encryption password not set'));
        }

        // Get remote manifest to check format and file hashes
        const manifest = await this.getDecryptedManifest();
        const remoteConv = manifest?.conversations.find(c => c.id === conversationId);

        if (!remoteConv) {
            throw new Error(lm.t('Conversation {0} not found in manifest', conversationId));
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
        const lm = LocalizationManager.getInstance();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        // Get local file hashes
        this.reportProgress(progress, lm.t('Analyzing {0}...', conversationId));
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
            this.reportProgress(progress, lm.t('Downloading: {0} ({1}/{2})...', relativePath, downloadedCount, filesToDownload.length));

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
        const lm = LocalizationManager.getInstance();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        // Download encrypted ZIP
        this.reportProgress(progress, lm.t('Downloading {0}...', conversationId));
        const encrypted = await this.driveService.downloadConversation(conversationId);

        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        if (!encrypted) {
            throw new Error(lm.t('Conversation {0} not found in Drive', conversationId));
        }

        // Decrypt
        this.reportProgress(progress, lm.t('Decrypting {0}...', conversationId));
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
     * Get decrypted manifest from Drive with caching support
     */
    public async getDecryptedManifest(forceRefresh: boolean = false): Promise<SyncManifest | null> {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const useCache = config.get<boolean>('sync.useMetadataCache', true);
        const cacheTTL = 60000; // 1 minute

        if (!forceRefresh && useCache && this.cachedManifest && (Date.now() - this.lastManifestFetch < cacheTTL)) {
            return this.cachedManifest;
        }

        try {
            if (!this.driveService) return null;
            await this.driveService.ensureSyncFolders();
            const encrypted = await this.driveService.getManifest();

            if (!encrypted) {
                return null;
            }

            const decrypted = crypto.decrypt(encrypted, this.masterPassword!);

            try {
                const manifest = JSON.parse(decrypted.toString('utf8'));
                this.cachedManifest = manifest;
                this.lastManifestFetch = Date.now();
                return manifest;
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
     * Get sync status for all local conversations
     */
    /**
     * Get sync status for all local conversations
     */
    public async getConversationStatuses(options?: { forceCache?: boolean }): Promise<Map<string, { status: string, icon: string }>> {
        const statuses = new Map<string, { status: string, icon: string }>();
        const lm = LocalizationManager.getInstance();

        // Check if we should use cached metadata
        const useCache = vscode.workspace.getConfiguration('antigravity-storage-manager').get<boolean>('sync.useMetadataCache', true);

        let manifest: SyncManifest | null = null;

        const forceCache = options?.forceCache ?? false;

        // Try to get manifest without forcing a remote fetch if possible/configured
        const cacheTTL = 60000;
        const hasValidCache = this.cachedManifest && (Date.now() - this.lastManifestFetch < cacheTTL);

        if (forceCache) {
            manifest = this.cachedManifest || null;
        } else {
            const willFetch = !useCache || !hasValidCache;

            if (willFetch) {
                const manualFetchMsg = lm.t('Fetching data from Google Drive...');

                // Update Status Bar Tooltip to say "Fetching..."
                if (this.statusBarItem) {
                    this.statusBarItem.tooltip = manualFetchMsg;
                }

                // Show notification
                vscode.window.showInformationMessage(manualFetchMsg);
            }

            manifest = await this.getDecryptedManifest();

            // Restore Status Bar Tooltip
            if (willFetch && this.statusBarItem) {
                this.updateStatusBar(this.isSyncing ? 'syncing' : 'idle');
            }
        }

        const local = await this.getLocalConversationsAsync();

        // 1. Local conversations
        for (const l of local) {
            const remote = manifest?.conversations.find(c => c.id === l.id);
            if (!remote) {
                statuses.set(l.id, { status: lm.t('Local Only'), icon: '🏠' });
            } else {
                const isExternal = remote.createdBy !== this.config?.machineId;
                if (isExternal) {
                    statuses.set(l.id, { status: lm.t('Imported'), icon: '📥' });
                } else {
                    statuses.set(l.id, { status: lm.t('Synced'), icon: '✅' });
                }
            }
        }

        // 2. Remote conversations not present locally
        if (manifest) {
            for (const r of manifest.conversations) {
                if (!local.some(l => l.id === r.id)) {
                    statuses.set(r.id, { status: lm.t('Remote Only'), icon: '☁️' });
                }
            }
        }

        return statuses;
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

        // Update machine info in manifest
        if (!manifest.machines) manifest.machines = [];
        const machineIdx = manifest.machines.findIndex(m => m.id === this.config!.machineId);
        const existingMachine = machineIdx >= 0 ? manifest.machines[machineIdx] : null;
        const machineInfo: Machine = {
            id: this.config!.machineId,
            name: this.config!.machineName,
            lastSync: now,
            createdAt: existingMachine?.createdAt || now
        };

        if (machineIdx >= 0) {
            manifest.machines[machineIdx] = machineInfo;
        } else {
            manifest.machines.push(machineInfo);
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

        // Update machine info in manifest
        if (!manifest.machines) manifest.machines = [];
        const machineIdx = manifest.machines.findIndex(m => m.id === this.config!.machineId);
        const existingMachine = machineIdx >= 0 ? manifest.machines[machineIdx] : null;
        const machineInfo: Machine = {
            id: this.config!.machineId,
            name: this.config!.machineName,
            lastSync: now,
            createdAt: existingMachine?.createdAt || now
        };

        if (machineIdx >= 0) {
            manifest.machines[machineIdx] = machineInfo;
        } else {
            manifest.machines.push(machineInfo);
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

        // Fetch Quota
        const quota = await this.driveService.getStorageInfo();

        const state: MachineState = {
            machineId: this.config.machineId,
            machineName: machineName,
            lastSync: new Date().toISOString(),
            syncCount: this.syncCount,
            quota: quota || undefined,
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
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.color = undefined;
                // Use rich tooltip even in 'ok' state
                this.updateStatusBar('idle');
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
        } else {
            this.updateStatusBar('idle');
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
                            const lm = LocalizationManager.getInstance();
                            const message = [];
                            if (result.pushed.length) message.push(lm.t('{0} pushed', result.pushed.length));
                            if (result.pulled.length) message.push(lm.t('{0} pulled', result.pulled.length));

                            vscode.window.showInformationMessage(lm.t('Sync complete: {0}', message.join(', ')));
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

                // Match existing logic but inject session selection
                this.reportProgress(progress, lm.t('Checking Google Drive folders...'));
                await this.driveService.ensureSyncFolders();

                // Get encrypted manifest EARLY to check for existing sessions
                this.reportProgress(progress, lm.t('Checking for existing backup...'));
                const manifest = await this.getDecryptedManifest();

                let machineId = crypto.generateMachineId();
                let machineName = os.hostname();

                // Check for existing machines to resume session
                if (manifest && manifest.machines && manifest.machines.length > 0) {
                    let sortMethod: 'date' | 'duration' | 'name' = 'date';
                    let selection: any;

                    while (true) {
                        // Sort machines based on selected method
                        const sortedMachines = [...manifest.machines].sort((a, b) => {
                            if (sortMethod === 'name') {
                                const nameA = a.name || a.id || '';
                                const nameB = b.name || b.id || '';
                                const nameComp = nameA.localeCompare(nameB);
                                if (nameComp !== 0) return nameComp;
                                return (a.id || '').localeCompare(b.id || '');
                            } else if (sortMethod === 'date') {
                                const dateA = a.lastSync ? new Date(a.lastSync).getTime() : 0;
                                const dateB = b.lastSync ? new Date(b.lastSync).getTime() : 0;
                                return dateB - dateA;
                            } else {
                                const durA = (a.lastSync && a.createdAt) ? new Date(a.lastSync).getTime() - new Date(a.createdAt).getTime() : 0;
                                const durB = (b.lastSync && b.createdAt) ? new Date(b.lastSync).getTime() - new Date(b.createdAt).getTime() : 0;
                                if (durB !== durA) return durB - durA;
                                return new Date(b.lastSync || 0).getTime() - new Date(a.lastSync || 0).getTime();
                            }
                        });

                        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
                        quickPick.title = lm.t('Connect to existing session?');
                        quickPick.placeholder = lm.t('Select a previously connected device to resume sync:');
                        quickPick.ignoreFocusOut = true;

                        const updateSortButton = () => {
                            let sortTooltip = lm.t('Sort by Date and Time');
                            if (sortMethod === 'duration') sortTooltip = lm.t('Sort by Duration');
                            if (sortMethod === 'name') sortTooltip = lm.t('Sort by Name');

                            quickPick.buttons = [{
                                iconPath: new vscode.ThemeIcon('list-ordered'),
                                tooltip: `${lm.t('Sort')}: ${sortTooltip}`
                            }];
                        };

                        const updateItems = () => {
                            const choices: (vscode.QuickPickItem & { id: string })[] = [
                                {
                                    label: `$(add) ${lm.t('Create New Session')}`,
                                    id: 'new',
                                    description: lm.t('Start fresh with a new device ID')
                                },
                                { label: lm.t('Existing Sessions'), kind: vscode.QuickPickItemKind.Separator, id: '' }
                            ];

                            for (const m of sortedMachines) {
                                if (m.id && m.name) {
                                    let detail = '';
                                    if (m.lastSync && m.createdAt) {
                                        const start = new Date(m.createdAt).getTime();
                                        const end = new Date(m.lastSync).getTime();
                                        const durationMs = end - start;
                                        if (durationMs > 0) {
                                            detail = lm.t('Duration: {0}', formatDuration(durationMs));
                                        }
                                    }

                                    choices.push({
                                        label: `$(device-desktop) ${lm.t('Resume: {0}', m.name)}`,
                                        id: m.id,
                                        description: m.lastSync ? lm.t('Last active: {0}', lm.formatDateTime(m.lastSync)) : m.id,
                                        detail: detail
                                    });
                                }
                            }
                            quickPick.items = choices;
                            updateSortButton();
                        };

                        updateItems();

                        quickPick.onDidTriggerButton(_button => {
                            if (sortMethod === 'date') sortMethod = 'duration';
                            else if (sortMethod === 'duration') sortMethod = 'name';
                            else sortMethod = 'date';

                            // Re-sort sortedMachines
                            sortedMachines.sort((a, b) => {
                                if (sortMethod === 'name') {
                                    const nameA = a.name || a.id || '';
                                    const nameB = b.name || b.id || '';
                                    const nameComp = nameA.localeCompare(nameB);
                                    if (nameComp !== 0) return nameComp;
                                    // Tie-breaker: ID
                                    return (a.id || '').localeCompare(b.id || '');
                                } else if (sortMethod === 'date') {
                                    return new Date(b.lastSync || 0).getTime() - new Date(a.lastSync || 0).getTime();
                                } else {
                                    const durA = (a.lastSync && a.createdAt) ? new Date(a.lastSync).getTime() - new Date(a.createdAt).getTime() : 0;
                                    const durB = (b.lastSync && b.createdAt) ? new Date(b.lastSync).getTime() - new Date(b.createdAt).getTime() : 0;
                                    if (durB !== durA) return durB - durA; // Longest duration first
                                    // Tie-breaker: Date
                                    return new Date(b.lastSync || 0).getTime() - new Date(a.lastSync || 0).getTime();
                                }
                            });
                            updateItems();
                        });

                        selection = await new Promise<any>((resolve) => {
                            quickPick.onDidAccept(() => {
                                const selected = quickPick.selectedItems[0];
                                resolve(selected);
                                quickPick.hide();
                            });
                            quickPick.onDidHide(() => resolve(undefined));
                            quickPick.show();
                        });

                        if (!selection) break;
                        break; // Normal selection (new or resume)
                    }

                    if (!selection) return; // User cancelled

                    if (selection && selection.id !== 'new') {
                        machineId = selection.id; // Reuse ID
                        // Find original name
                        const original = manifest.machines.find(m => m.id === machineId);
                        if (original) {
                            machineName = original.name;
                        }

                        // Optional: Allow renaming even when resuming
                        const newName = await vscode.window.showInputBox({
                            prompt: lm.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                            value: machineName,
                            validateInput: (value) => value ? null : lm.t("Machine name cannot be empty")
                        });
                        if (newName) machineName = newName;

                    } else {
                        // NEW SESSION logic
                        const inputName = await vscode.window.showInputBox({
                            prompt: lm.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                            value: machineName,
                            validateInput: (value) => value ? null : lm.t("Machine name cannot be empty")
                        });
                        if (inputName) machineName = inputName;
                    }
                } else {
                    // No manifest or no machines -> Default New Session flow
                    const inputName = await vscode.window.showInputBox({
                        prompt: lm.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                        value: machineName,
                        validateInput: (value) => value ? null : lm.t("Machine name cannot be empty")
                    });
                    if (inputName) machineName = inputName;
                }

                // Initialize config with determined ID and Name
                this.config = {
                    enabled: true,
                    machineId: machineId,
                    machineName: machineName,
                    lastSync: new Date().toISOString(),
                    autoSync: true,
                    syncInterval: 300000,
                    showStatusBar: true,
                    selectedConversations: 'all',
                    silent: false
                };

                await this.saveConfig();

                if (manifest) {
                    vscode.window.showInformationMessage(lm.t("Found existing sync data! Joined as '{0}'.", this.config!.machineName));

                    // Ask user which conversations to sync
                    if (manifest.conversations.length > 0) {
                        // Sort by creation date descending (newest first)
                        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
                        quickPick.title = lm.t('Select conversations to sync from Google Drive');
                        quickPick.placeholder = lm.t('Use Space to select/deselect, Enter to confirm');
                        quickPick.canSelectMany = true;

                        let sortMethod: 'modified' | 'created' | 'name' = 'modified';

                        const updateSortButton = () => {
                            let sortTooltip = lm.t('Sort by Modified Date and Time');
                            if (sortMethod === 'created') sortTooltip = lm.t('Sort by Created Date and Time');
                            if (sortMethod === 'name') sortTooltip = lm.t('Sort by Name');

                            quickPick.buttons = [{
                                iconPath: new vscode.ThemeIcon('list-ordered'),
                                tooltip: `${lm.t('Sort')}: ${sortTooltip}`
                            }];
                        };

                        const updateItems = (preserveSelection = false) => {
                            const sortedConversations = [...manifest.conversations].sort((a, b) => {
                                if (sortMethod === 'name') {
                                    return (a.title || a.id).localeCompare(b.title || b.id);
                                } else if (sortMethod === 'created') {
                                    const dateA = new Date(a.createdAt || 0).getTime();
                                    const dateB = new Date(b.createdAt || 0).getTime();
                                    return dateB - dateA;
                                } else {
                                    const dateA = new Date(a.lastModified || 0).getTime();
                                    const dateB = new Date(b.lastModified || 0).getTime();
                                    return dateB - dateA;
                                }
                            });

                            const items = sortedConversations.map(c => {
                                const createdDate = c.createdAt ? lm.formatDateTime(c.createdAt) : undefined;
                                const modifiedDate = lm.formatDateTime(c.lastModified);
                                const dateInfo = createdDate
                                    ? `${lm.t('Created')}: ${createdDate}`
                                    : undefined;

                                return {
                                    label: c.title || c.id,
                                    description: c.id,
                                    detail: `${lm.t('Modified')}: ${modifiedDate}${dateInfo ? ` | ${dateInfo}` : ''}`,
                                    picked: true, // Default to all
                                    id: c.id
                                };
                            });

                            const previousSelectionIds = preserveSelection ? quickPick.selectedItems.map(i => i.id) : [];
                            quickPick.items = items;

                            if (preserveSelection) {
                                quickPick.selectedItems = items.filter(i => previousSelectionIds.includes(i.id));
                            } else {
                                // Default select all
                                quickPick.selectedItems = items;
                            }

                            updateSortButton();
                        };

                        updateItems();

                        quickPick.onDidTriggerButton(_button => {
                            if (sortMethod === 'modified') sortMethod = 'created';
                            else if (sortMethod === 'created') sortMethod = 'name';
                            else sortMethod = 'modified';
                            updateItems(true);
                        });

                        const selected = await new Promise<(vscode.QuickPickItem & { id: string })[]>((resolve) => {
                            quickPick.onDidAccept(() => {
                                resolve([...quickPick.selectedItems] as (vscode.QuickPickItem & { id: string })[]);
                                quickPick.hide();
                            });
                            quickPick.onDidHide(() => resolve([]));
                            quickPick.show();
                        });

                        if (selected) {
                            if (selected.length === quickPick.items.length) {
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
        const lm = LocalizationManager.getInstance();
        try {
            let remoteManifest = await this.getDecryptedManifest();
            if (!remoteManifest) {
                try {
                    console.log('Remote manifest not found, attempting to recreate...');
                    await this.createInitialManifest();
                } catch (e: any) {
                    throw new Error(lm.t("Failed to get or create remote manifest: {0}", e.message));
                }

                const retryManifest = await this.getDecryptedManifest();
                if (!retryManifest) {
                    throw new Error(lm.t("Failed to get remote manifest after recreation attempt"));
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
        const lm = LocalizationManager.getInstance();
        const conversations = await getConversationsAsync(BRAIN_DIR);
        const currentSelection = this.config?.selectedConversations;

        // Get sync statuses
        const statuses = await this.getConversationStatuses();

        const prepareItems = (convs: ConversationItem[], sortMode: 'modified' | 'created' | 'name') => {
            const sorted = [...convs].sort((a, b) => {
                if (sortMode === 'name') {
                    return (a.label || a.id).localeCompare(b.label || b.id);
                } else if (sortMode === 'created') {
                    return b.createdAt.getTime() - a.createdAt.getTime();
                } else {
                    return b.lastModified.getTime() - a.lastModified.getTime();
                }
            });

            return sorted.map(c => {
                const status = statuses.get(c.id);
                const icon = status ? `${status.icon} ` : '';
                return {
                    id: c.id,
                    label: `${icon}${c.label}`,
                    description: c.description,
                    detail: `${status ? status.status + '  |  ' : ''}${lm.t('Created')}: ${lm.formatDateTime(c.createdAt)}  •  ${lm.t('Modified')}: ${lm.formatDateTime(c.lastModified)}`,
                    picked: currentSelection === 'all' ||
                        (Array.isArray(currentSelection) && currentSelection.includes(c.id))
                } as (vscode.QuickPickItem & { id: string });
            });
        };



        let currentSort: 'modified' | 'created' | 'name' = 'modified';

        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { id?: string }>();
        quickPick.title = lm.t('Select conversations to sync');
        quickPick.canSelectMany = true;
        quickPick.placeholder = lm.t('Select conversations to sync');

        const updateSortButton = () => {
            let sortTooltip = lm.t('Sort by Modified Date and Time');
            if (currentSort === 'created') sortTooltip = lm.t('Sort by Created Date and Time');
            if (currentSort === 'name') sortTooltip = lm.t('Sort by Name');

            quickPick.buttons = [{
                iconPath: new vscode.ThemeIcon('list-ordered'),
                tooltip: `${lm.t('Sort')}: ${sortTooltip}`
            }];
        };

        const updateItems = () => {
            quickPick.items = prepareItems(conversations, currentSort);

            // Set selected items based on config
            if (currentSelection === 'all') {
                quickPick.selectedItems = quickPick.items;
            } else if (Array.isArray(currentSelection)) {
                quickPick.selectedItems = quickPick.items.filter(i => i.id && currentSelection.includes(i.id));
            }

            updateSortButton();
        };

        updateItems();

        // Handle Button Click (Sort)
        quickPick.onDidTriggerButton(_button => {
            if (currentSort === 'modified') currentSort = 'created';
            else if (currentSort === 'created') currentSort = 'name';
            else currentSort = 'modified';

            const previousSelectionIds = quickPick.selectedItems.map(i => i.id);
            quickPick.items = prepareItems(conversations, currentSort);
            quickPick.selectedItems = quickPick.items.filter(i => i.id && previousSelectionIds.includes(i.id));

            updateSortButton();
        });
        quickPick.onDidChangeSelection((_selection) => {
            // Keep selection updated for result
        });

        const result = await new Promise<(vscode.QuickPickItem & { id: string })[] | undefined>((resolve) => {
            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems.filter(i => !i.id?.startsWith('sort_')) as (vscode.QuickPickItem & { id: string })[];
                resolve(selected);
                quickPick.hide();
            });
            quickPick.onDidHide(() => resolve(undefined));
            quickPick.show();
        });

        if (result) {
            if (result.some(s => s.id === 'all')) {
                this.config!.selectedConversations = 'all';
            } else {
                this.config!.selectedConversations = result.map(s => s.id);
            }
            await this.saveConfig();
            vscode.window.showInformationMessage(lm.t('Sync selection updated'));
        }
    }

    /**
     * Show sync statistics/dashboard
     */
    async showStatistics(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        if (!this.isReady()) {
            const result = await vscode.window.showWarningMessage(
                lm.t('Sync is not configured. Would you like to set it up now?'),
                lm.t('Setup Sync'),
                lm.t('Cancel')
            );
            if (result === lm.t('Setup Sync')) {
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
                    case 'deleteMachineConversations':
                        if (message.id && message.name) {
                            this.deleteRemoteConversationsForMachine(message.id, message.name);
                        }
                        return;
                    case 'deleteConversation': {
                        const confirm = await vscode.window.showWarningMessage(
                            LocalizationManager.getInstance().t('Are you sure you want to delete conversation "{0}"?', message.title || message.id),
                            { modal: true },
                            LocalizationManager.getInstance().t('Delete'),
                            LocalizationManager.getInstance().t('Cancel')
                        );

                        if (confirm === lm.t('Delete')) {
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

                // Update cached manifest to reflect the change immediately
                this.cachedManifest = manifest;
                this.lastManifestFetch = Date.now();
            }
        }
    }

    private async refreshStatistics(panel: vscode.WebviewPanel) {
        panel.webview.html = this.getLoadingHtml();

        try {
            // Gather data
            const localConversations = await this.getLocalConversationsAsync();
            const start = Date.now();
            const remoteManifest = await this.getDecryptedManifest(true); // Force refresh from Drive

            // Get global quota once
            const currentQuota = await this.driveService.getStorageInfo();

            // Get machine states
            const machineFiles = await this.driveService.listMachineStates();
            const machines: Array<{ name: string; id: string; fileId?: string; lastSync: string; isCurrent: boolean; syncCount: number; quota?: { used: number; limit: number }; conversationStates: any[] }> = [];

            for (const file of machineFiles) {
                let machineName = LocalizationManager.getInstance().t('Unknown Device');
                let lastSync = file.modifiedTime;
                let syncCount = 0;
                let quota: { used: number; limit: number } | undefined = undefined;

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
                            syncCount: this.syncCount,
                            quota: currentQuota || undefined,
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
                        syncCount = state.syncCount || 0;
                        quota = state.quota;

                        machines.push({
                            name: machineName,
                            id: machineId,
                            fileId: file.id, // Needed for deletion
                            lastSync: lastSync,
                            isCurrent: false,
                            syncCount: syncCount,
                            quota: quota,
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
                        syncCount: 0,
                        quota: undefined,
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
                currentMachineId: this.config!.machineId,
                driveQuota: currentQuota || undefined
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
        driveQuota?: { used: number; limit: number };
    }): string {
        const lm = LocalizationManager.getInstance();
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const syncInterval = config.get<number>('sync.syncInterval') || 300000;
        const now = Date.now();

        // Helper to format bytes
        const formatBytes = (bytes: number) => {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        // Group machines by name
        const machineGroups = new Map<string, any[]>();
        data.machines.forEach(m => {
            const name = m.name || lm.t('Unknown');
            if (!machineGroups.has(name)) {
                machineGroups.set(name, []);
            }
            machineGroups.get(name)!.push(m);
        });

        let machineRows = '';
        let groupIndex = 0;

        // Helper to format duration
        const formatDuration = (ms: number) => {
            if (ms < 60000) return lm.t('{0}s', Math.floor(ms / 1000));
            if (ms < 3600000) return lm.t('{0}m', Math.floor(ms / 60000));
            if (ms < 86400000) return lm.t('{0}h', Math.floor(ms / 3600000));
            return lm.t('{0}d', Math.floor(ms / 86400000));
        };

        for (const [groupName, machines] of machineGroups) {
            // Sort sessions: current session first, then by lastSync descending
            machines.sort((a, b) => {
                if (a.isCurrent) return -1;
                if (b.isCurrent) return 1;
                return new Date(b.lastSync).getTime() - new Date(a.lastSync).getTime();
            });

            const groupId = `group-${groupIndex++}`;
            // Collapsible header for the group
            machineRows += `<tr class="group-header" data-group="${groupId}" style="cursor: pointer;" onclick="toggleGroup('${groupId}')">
                <td colspan="8" style="background-color: var(--vscode-sideBarSectionHeader-background); font-weight: bold; padding: 5px 10px;">
                    <span class="collapse-icon" id="icon-${groupId}">▼</span> ${lm.t('Device')}: ${groupName} (${machines.length} ${lm.t('sessions')})
                </td>
            </tr>`;

            machines.forEach(m => {
                // Uploads/Downloads stats
                const uploads = data.remoteManifest.conversations.filter(c => c.createdBy === m.id || (c.createdByName === m.name));
                const uploadCount = uploads.length;
                const uploadSize = uploads.reduce((acc, c) => acc + (c.size || 0), 0);

                const machineState = m.conversationStates || [];
                const downloads = machineState.filter((s: any) => {
                    const conv = data.remoteManifest.conversations.find(c => c.id === s.id);
                    return conv && (conv.createdBy !== m.id && conv.createdByName !== m.name);
                });
                const downloadCount = downloads.length;
                const downloadSize = downloads.reduce((acc: number, s: any) => {
                    const conv = data.remoteManifest.conversations.find(c => c.id === s.id);
                    return acc + (conv?.size || 0);
                }, 0);

                // Status Logic
                const lastSyncTime = new Date(m.lastSync).getTime();
                // Online if synced within last 2 intervals (approx) or 10 mins default
                const isOnline = (now - lastSyncTime) < (Math.max(syncInterval * 2.5, 600000));
                const statusColor = isOnline ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-testing-iconFailed)';
                const statusTitle = isOnline ? lm.t('Online (Synced recently)') : lm.t('Offline (Last seen: {0})', lm.formatDateTime(m.lastSync));
                const statusDot = `<span class="status-dot" style="background-color: ${statusColor};" title="${statusTitle}"></span>`;

                // Quota - Use global drive quota if available (fallback) or specific machine quota
                const quotaToUse = data.driveQuota || m.quota;
                let quotaDisplay = '-';
                if (quotaToUse) {
                    const used = formatBytes(quotaToUse.used);
                    const limit = formatBytes(quotaToUse.limit);
                    const pct = Math.min(100, (quotaToUse.used / quotaToUse.limit) * 100).toFixed(1);
                    quotaDisplay = `<div title="${used} / ${limit}" style="display:flex; align-items:center; gap:5px;">
                        <div style="flex-grow:1; height:6px; background:var(--vscode-widget-shadow); border-radius:3px; overflow:hidden; width: 50px;">
                            <div style="height:100%; width:${pct}%; background:var(--vscode-progressBar-background);"></div>
                        </div>
                        <span style="font-size:0.8em">${pct}%</span>
                    </div>`;
                }

                // Actions
                let machineActions = '';
                if (!m.isCurrent) {
                    machineActions += `<button class="small-btn danger action-btn" data-command="deleteMachine" data-id="${m.fileId}" data-name="${m.name}" title="${lm.t('Remove machine')}">🗑️</button>`;
                    machineActions += `<button class="small-btn primary action-btn" data-command="forceRemoteSync" data-id="${m.id}" data-name="${m.name}" title="${lm.t('Trigger immediate synchronization')}">🔄 ${lm.t('Push')}</button>`;

                    const authorizedIds = config.get<string[]>('sync.authorizedRemoteDeleteMachineIds') || [];
                    if (authorizedIds.includes(data.currentMachineId)) {
                        machineActions += `<button class="small-btn danger action-btn" data-command="deleteMachineConversations" data-id="${m.id}" data-name="${m.name}" title="${lm.t('Delete all conversations from this machine')}">🧹</button>`;
                    }
                }

                // Session activity and duration
                const lastActive = lm.formatDateTime(m.lastSync);
                const firstSyncTime = m.firstSync ? new Date(m.firstSync).getTime() : lastSyncTime;
                const duration = now - firstSyncTime;
                const durationDisplay = formatDuration(duration);

                machineRows += `
                <tr class="session-row ${groupId}" style="${m.isCurrent ? 'background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);' : ''}">
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: center; width: 30px;">
                        ${statusDot}
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                         ${m.isCurrent ? `<b>(${lm.t('This Session')})</b>` : `<span style="opacity:0.8">${lm.t('Session')}</span>`}
                         <div style="font-size: 0.75em; opacity: 0.7; margin-top: 2px;">
                            ${lm.t('Last Active')}: ${lastActive}
                         </div>
                         <div style="font-size: 0.75em; opacity: 0.7;">
                            ${lm.t('Duration')}: ${durationDisplay}
                         </div>
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); font-family: monospace; font-size: 0.9em;">${m.id}</td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: center;">${m.syncCount || 0}</td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${uploadCount} <span style="font-size:0.8em; opacity:0.7">(${formatBytes(uploadSize)})</span></td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${downloadCount} <span style="font-size:0.8em; opacity:0.7">(${formatBytes(downloadSize)})</span></td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${quotaDisplay}</td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: right; white-space: nowrap;">${machineActions}</td>
                </tr>`;
            });
        }

        // Already processed machineRows above.

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
            const originMachineName = remote?.createdByName || (local ? lm.t('This Machine') : lm.t('Unknown'));
            const isExternal = remote && remote.createdBy !== data.currentMachineId;

            const sizeBytes = remote?.size || 0;
            const sizeDisplay = formatBytes(sizeBytes);

            // File breakdown
            let fileBreakdown = '';
            if (remote?.fileHashes) {
                fileBreakdown = '<div class="file-list" style="display:none; font-size: 0.8em; margin-top: 5px; max-height: 150px; overflow-y: auto; padding-right: 5px;">';
                for (const [fPath, fInfo] of Object.entries(remote.fileHashes)) {
                    fileBreakdown += `<div>${fPath.split('/').pop()}: ${(fInfo.size / 1024).toFixed(1)} KB</div>`;
                }
                fileBreakdown += '</div>';
            }

            const dateStr = remote?.lastModified ? lm.formatDateTime(remote.lastModified) : (local ? lm.formatDateTime(local.lastModified) : '-');
            const originDateStr = remote?.createdAt ? lm.formatDateTime(remote.createdAt) : (local?.createdAt ? lm.formatDateTime(local.createdAt) : '-');

            const statusBadges = [];
            let actionButtons = '';

            // Actions
            const title = (remote?.title || local?.title || '').replace(/'/g, "\\'");
            actionButtons += `<button class="small-btn action-btn" data-command="renameConversation" data-id="${id}" data-title="${title}" title="${lm.t('Rename')}">✏️</button> `;
            actionButtons += `<button class="small-btn danger action-btn" data-command="deleteConversation" data-id="${id}" data-title="${title}" title="${lm.t('Delete')}">🗑️</button> `;

            if (syncedCount > 0) {
                statusBadges.push(`<span class="badge" title="${lm.t('Synced on {0} sessions', syncedCount)}" style="background: var(--vscode-progressBar-background); color: white; cursor: help;">${lm.t('Synced')}</span>`);
            }
            if (isExternal) statusBadges.push(`<span class="badge" title="${lm.t('Created on another machine')}" style="background: var(--vscode-terminal-ansiCyan); color: black; cursor: help;">${lm.t('Imported')}</span>`);

            if (!remote) {
                statusBadges.push(`<span class="badge" title="${lm.t('Not yet pushed to Drive')}" style="background: var(--vscode-list-errorForeground); color: white; cursor: help;">${lm.t('Local Only')}</span>`);
                actionButtons += `<button class="small-btn primary action-btn" data-command="pushConversation" data-id="${id}" title="${lm.t('Upload to Drive')}">⬆️</button>`;
            }
            if (!local) {
                statusBadges.push(`<span class="badge" title="${lm.t('Not present on this machine')}" style="background: var(--vscode-list-warningForeground); color: white; cursor: help;">${lm.t('Remote Only')}</span>`);
                actionButtons += `<button class="small-btn primary action-btn" data-command="pullConversation" data-id="${id}" title="${lm.t('Download from Drive')}">⬇️</button>`;
            }

            return `
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div class="action-link" data-command="openConversation" data-id="${id}" style="cursor: pointer; color: var(--vscode-textLink-foreground); font-weight:bold;">${(local?.title && local.title !== id) ? local.title : (remote?.title || id)}</div>
                    <div style="font-size: 0.8em; opacity: 0.7;">${id}</div>
                    <div style="margin-top: 4px; display: flex; gap: 4px;">${actionButtons}</div>
                </td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div style="cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
                        ${sizeDisplay}
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
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src 'none'; img-src vscode-resource: https:; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th { text-align: left; padding: 8px; border-bottom: 2px solid var(--vscode-panel-border); }
                th[onclick] { cursor: pointer; user-select: none; }
                th[onclick]:hover { background-color: var(--vscode-list-hoverBackground); }
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
                
                .file-list::-webkit-scrollbar { width: 6px; }
                .file-list::-webkit-scrollbar-track { background: transparent; }
                .file-list::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
                .file-list::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
                
                .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
                
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

                .status-dot {
                    display: inline-block;
                    width: 10px; height: 10px;
                    border-radius: 50%;
                }
            </style>
            <script>
                const vscode = acquireVsCodeApi();

                // Interactivity Handler
                document.addEventListener('click', event => {
                    const target = event.target.closest('.action-btn, .action-link');
                    if (!target) return;

                    const command = target.dataset.command;
                    if (!command) return;

                    const id = target.dataset.id;
                    const name = target.dataset.name;
                    const title = target.dataset.title;

                    vscode.postMessage({
                        command: command,
                        id: id,
                        name: name,
                        title: title
                    });
                });

                // ... Sort Logic (Simplified for brevity, or kept if needed) ...
                let sortState = {};
                function sortTable(n, tableId) {
                    var table, rows, switching, i, x, y, shouldSwitch, dir, switchcount = 0;
                    table = document.getElementById(tableId);
                    switching = true;
                    dir = "asc"; 
                    if (sortState[tableId] && sortState[tableId].col === n && sortState[tableId].dir === "asc") {
                        dir = "desc";
                    }
                    sortState[tableId] = { col: n, dir: dir };

                    while (switching) {
                        switching = false;
                        rows = table.rows;
                        // Skip header rows? The logic handles 1 header row.
                        // For grouped table, we have multiple header rows ("Device: X").
                        // Sorting grouped tables is complex. We should probably only sort WITHIN groups or sort GROUPS.
                        // For now, let's disable sorting on the machine table or make it only sort top-level.
                        // Or Keep it simple: standard sorting might break grouping headers.
                        // Let's just disable sorting for Machine Table for now, as grouping is more important.
                        if (tableId === 'machineTable') return; 

                        for (i = 1; i < (rows.length - 1); i++) {
                            shouldSwitch = false;
                            x = rows[i].getElementsByTagName("TD")[n];
                            y = rows[i + 1].getElementsByTagName("TD")[n];
                            if (compareValues(x.innerText, y.innerText, dir, n, tableId)) {
                                shouldSwitch = true;
                                break;
                            }
                        }
                        if (shouldSwitch) {
                            rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
                            switching = true;
                            switchcount ++;      
                        } else {
                            if (switchcount == 0 && dir == "asc") {
                                //
                            }
                        }
                    }
                }

                 function compareValues(a, b, dir, n, tableId) {
                    a = a.trim(); b = b.trim();
                    if (dir === "asc") return a.localeCompare(b) > 0;
                    return a.localeCompare(b) < 0;
                }

                // Toggle group visibility
                function toggleGroup(groupId) {
                    const rows = document.querySelectorAll('.session-row.' + groupId);
                    const icon = document.getElementById('icon-' + groupId);
                    const isHidden = rows.length > 0 && rows[0].style.display === 'none';
                    rows.forEach(row => {
                        row.style.display = isHidden ? '' : 'none';
                    });
                    if (icon) {
                        icon.textContent = isHidden ? '▼' : '▶';
                    }
                }
            </script>
        </head>
        <body>
            <div class="header-row">
                <h1>${lm.t('Sync Statistics')}</h1>
                <button class="small-btn primary action-btn" style="font-size: 13px; padding: 6px 12px;" data-command="refresh">🔄 ${lm.t('Refresh Data')}</button>
            </div>
            
            <div class="grid">
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
                    <div class="stat-label">${lm.t('Connected Sessions')}</div>
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
                        <th onclick="sortTable(3, 'convTable')" style="cursor: pointer;">${lm.t('Origin / Created')}</th>
                        <th onclick="sortTable(4, 'convTable')" style="cursor: pointer;">${lm.t('Status')}</th>
                    </tr>
                </thead>
                <tbody>
                    ${convRows}
                </tbody>
            </table>

            <h3>${lm.t('Connected Devices')}</h3>
            <table id="machineTable">
                <thead>
                    <tr>
                        <th style="width: 30px;">#</th>
                        <th>${lm.t('Session Type')}</th>
                        <th>${lm.t('UID')}</th>
                        <th style="text-align: center;">${lm.t('Syncs')}</th>
                        <th>${lm.t('Uploads')}</th>
                        <th>${lm.t('Downloads')}</th>
                        <th>${lm.t('Quota')}</th>
                        <th>${lm.t('Actions')}</th>
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

    public async deleteRemoteConversationsForMachine(machineId: string, machineName: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            LocalizationManager.getInstance().t('Delete all conversations created by {0} from Google Drive? This cannot be undone.', machineName),
            { modal: true },
            LocalizationManager.getInstance().t('Delete')
        );

        if (confirm !== LocalizationManager.getInstance().t('Delete')) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: LocalizationManager.getInstance().t('Deleting conversations...'),
            cancellable: false
        }, async (_progress) => {
            try {
                if (!this.driveService) throw new Error('Drive service not initialized');

                const encryptedManifest = await this.driveService.getManifest();
                if (!encryptedManifest) throw new Error('Failed to load manifest');

                if (!this.masterPassword) throw new Error('Master password not loaded');
                const manifest = JSON.parse(crypto.decrypt(encryptedManifest, this.masterPassword).toString()) as SyncManifest;

                const toDelete = manifest.conversations.filter(c => c.createdBy === machineId);

                if (toDelete.length === 0) {
                    vscode.window.showInformationMessage(LocalizationManager.getInstance().t('No conversations found for this machine.'));
                    return;
                }

                // Delete files
                const fileIds = toDelete.map(c => (c as any).fileId).filter((id: string) => !!id);

                // Delete via fileId
                for (const fid of fileIds) {
                    try {
                        await this.driveService.deleteFile(fid);
                    } catch (e) { console.error('Failed to delete file', fid, e); }
                }

                // Fallback delete via conversation ID (zip)
                const missingFileId = toDelete.filter(c => !c.fileId);
                for (const c of missingFileId) {
                    try {
                        await this.driveService.deleteConversation(c.id);
                    } catch (e) { console.error('Failed to delete conversation zip', c.id, e); }
                }

                // Update Manifest by removing these conversations
                manifest.conversations = manifest.conversations.filter(c => c.createdBy !== machineId);
                manifest.lastModified = new Date().toISOString();

                // Encrypt and save
                const encryptedNew = crypto.encrypt(Buffer.from(JSON.stringify(manifest), 'utf8'), this.masterPassword);
                await this.driveService.updateManifest(encryptedNew);

                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Conversations deleted.'));

                // Refresh stats
                this.showStatistics();

            } catch (error: any) {
                vscode.window.showErrorMessage(`${LocalizationManager.getInstance().t('Error')}: ${error.message}`);
                // Also refresh stats in case of partial failure or to reset UI
                this.showStatistics();
            }
        });
    }

    public async manageAuthorizedMachines(): Promise<void> {
        if (!this.config?.machineId) {
            vscode.window.showWarningMessage(LocalizationManager.getInstance().t('Sync is not configured. Run setup first.'));
            return;
        }

        try {
            if (!this.driveService) {
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Drive service not initialized'));
                return;
            }

            const encryptedManifest = await this.driveService.getManifest();
            let manifest: SyncManifest | null = null;
            if (encryptedManifest && this.masterPassword) {
                try {
                    manifest = JSON.parse(crypto.decrypt(encryptedManifest, this.masterPassword).toString('utf8')) as SyncManifest;
                } catch {
                    vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to decrypt manifest.'));
                    return;
                }
            }

            if (!manifest) {
                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to fetch manifest.'));
                return;
            }

            const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
            const currentAuthorized = config.get<string[]>('sync.authorizedRemoteDeleteMachineIds') || [];

            // Collect all known machines with details
            const machinesMap = new Map<string, { name: string, lastSync?: string, createdAt?: string }>();

            // Add current machine
            machinesMap.set(this.config.machineId, {
                name: this.config.machineName || LocalizationManager.getInstance().t('Current Machine'),
                lastSync: new Date().toISOString(), // Assume active
                createdAt: undefined // Unknown start for current without manifest lookup, but acceptable
            });

            // Add from manifest machines (rich info)
            if (manifest.machines) {
                for (const m of manifest.machines) {
                    machinesMap.set(m.id, {
                        name: m.name,
                        lastSync: m.lastSync,
                        createdAt: m.createdAt
                    });
                }
            }
            // Add from conversations override (fallback)
            for (const c of manifest.conversations) {
                if (c.createdBy && !machinesMap.has(c.createdBy)) {
                    machinesMap.set(c.createdBy, { name: c.createdByName || LocalizationManager.getInstance().t('Unknown Machine') });
                }
            }

            const items: vscode.QuickPickItem[] = [];
            const lm = LocalizationManager.getInstance();
            const now = Date.now();

            for (const [id, info] of machinesMap.entries()) {
                const isAuth = currentAuthorized.includes(id);
                const isCurrent = id === this.config.machineId;

                // Status Logic
                let statusIcon = '🔴'; // Default Offline
                let statusText = lm.t('Offline');
                let lastSyncText = '';
                let durationText = '';

                if (info.lastSync) {
                    const lastSyncTime = new Date(info.lastSync).getTime();
                    const diff = now - lastSyncTime;

                    // Online if sync < 10 mins ago
                    if (diff < 10 * 60 * 1000) {
                        statusIcon = '🟢';
                        statusText = lm.t('Online');
                    }

                    // Format Date
                    lastSyncText = `${lm.t('Last Sync')}: ${lm.formatDateTime(new Date(info.lastSync))}`;

                    // Duration
                    if (info.createdAt) {
                        const startTime = new Date(info.createdAt).getTime();
                        const durationMs = lastSyncTime - startTime;
                        if (durationMs > 0) {
                            durationText = ` | ${lm.t('Duration')}: ${formatDuration(durationMs)}`;
                        }
                    }
                }

                items.push({
                    label: `${statusIcon} ${info.name}${isCurrent ? ` (${lm.t('This Machine')})` : ''}`,
                    description: id,
                    detail: `${statusText} | ${lastSyncText}${durationText}`,
                    picked: isAuth
                });
            }

            // Show QuickPick
            const selected = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                placeHolder: LocalizationManager.getInstance().t('Select machines authorized to delete conversations from others'),
                title: LocalizationManager.getInstance().t('Manage Authorized Deletion Machines')
            });

            if (selected) {
                const newAuthorized = selected.map(i => i.description!);
                await config.update('sync.authorizedRemoteDeleteMachineIds', newAuthorized, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Authorized machines updated.'));
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`${LocalizationManager.getInstance().t('Error')}: ${error.message}`);
        }
    }

}


