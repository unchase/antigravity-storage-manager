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
import { SyncStatsWebview, SyncStatsData } from './quota/syncStatsWebview';
import { QuotaManager } from './quota/quotaManager';
import { drawProgressBar } from './quota/utils';

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
    localSize?: number;
    remoteSize?: number;
    remoteModifiedBy?: string;
    remoteModifiedByName?: string;
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
    private uploadCount: number = 0;
    private downloadCount: number = 0;
    private fileHashCache: Map<string, { mtime: number, hash: string }> = new Map();
    private cachedManifest: SyncManifest | null = null;
    private lastManifestFetch: number = 0;
    private activeTransfers: Map<string, { title: string; type: 'upload' | 'download'; startTime: number }> = new Map();
    private lastStatsData: any | null = null;
    private manifestUpdateQueue: Promise<void> = Promise.resolve();
    private quotaManager: QuotaManager | null = null;

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

    public setQuotaManager(quotaManager: QuotaManager) {
        this.quotaManager = quotaManager;
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
        const useCompression = vscode.workspace.getConfiguration(EXT_NAME).get<boolean>('sync.enableCompression', true);
        const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!, useCompression);

        await this.driveService.ensureSyncFolders();
        await this.driveService.updateManifest(encrypted);
    }

    /**
     * Verify password against stored manifest
     */
    private async verifyPassword(password: string): Promise<boolean> {
        const lm = LocalizationManager.getInstance();
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
        } catch (error: any) {
            vscode.window.showErrorMessage(lm.t('Password verification failed: {0}', error.message));
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

                // Get last known machine state (for 3-way merge detection)
                const lastMachineState = await this.getMyMachineState();
                const lastSyncedConversations = new Map<string, string>(); // id -> hash
                if (lastMachineState && lastMachineState.conversationStates) {
                    lastMachineState.conversationStates.forEach(s => lastSyncedConversations.set(s.id, s.localHash));
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
                        return this.processSyncItem(convId, localConversations, remoteManifest, lastSyncedConversations, result, progress, token);
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

            // Auto-update statistics dashboard if ALREADY open (do not open it automatically)
            if (SyncStatsWebview.isVisible()) {
                this.showStatistics();
            }

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

            // Conflict Notification handled by caller (extension.ts) which presents interactive resolution options

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
                    const useCompression = vscode.workspace.getConfiguration(EXT_NAME).get<boolean>('sync.enableCompression', true);
                    const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!, useCompression);
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

        // Track active transfer for dashboard
        const convTitle = this.getConversationTitle(conversationId);
        this.activeTransfers.set(conversationId, { title: convTitle, type: 'upload', startTime: Date.now() });
        this.updateDashboardIfVisible();

        // Get local file hashes
        this.reportProgress(progress, lm.t('Analyzing "{0}"...', convTitle));

        try {
            const localData = await this.computeConversationFileHashesAsync(conversationId);

            // Get remote file hashes from manifest (Force Refresh to avoid stale data)
            const manifest = await this.getDecryptedManifest(true);
            const remoteConv = manifest?.conversations.find(c => c.id === conversationId);
            const remoteHashes = remoteConv?.fileHashes || {};

            if (token?.isCancellationRequested) throw new vscode.CancellationError();

            // Determine which files need to be uploaded
            const filesToUpload: string[] = [];
            const filesToDelete: string[] = [];

            // Fetch actual remote files to check for existing uploads (optimization for interrupted syncs)
            // This map contains { id, md5, originalMd5 }
            const actualRemoteFiles = await this.driveService.listConversationFilesDetails(conversationId);
            let skippedCount = 0;

            // Files that are new or changed locally
            for (const [relativePath, localInfo] of Object.entries(localData.fileHashes)) {
                // Check manifest first (fast check)
                const remoteInfo = remoteHashes[relativePath];
                // Check actual drive state (slow check, but needed for resume)
                const actualRemote = actualRemoteFiles.get(relativePath);

                let shouldUpload = false;

                if (!remoteInfo || remoteInfo.hash !== localInfo.hash) {
                    // Manifest says it changed. But maybe we already uploaded it partially?
                    if (actualRemote && actualRemote.originalMd5 === localInfo.hash) {
                        // File exists on Drive and matches local content! Skip upload.
                        console.log(`[Push] Skipping ${relativePath}: already on Drive with matching hash.`);
                        skippedCount++;
                    } else {
                        shouldUpload = true;
                    }
                }

                if (shouldUpload) {
                    console.log(`[Push] Will upload ${relativePath}:`);
                    console.log(`  Remote hash: ${remoteInfo ? remoteInfo.hash : 'MISSING'}`);
                    console.log(`  Local hash:  ${localInfo.hash}`);
                    filesToUpload.push(relativePath);
                }
            }

            // Files that exist remotely but not locally (deleted locally)
            for (const remotePath of Object.keys(remoteHashes)) {
                if (!localData.fileHashes[remotePath]) {
                    filesToDelete.push(remotePath);
                }
            }

            if (skippedCount > 0) {
                this.reportProgress(progress, lm.t('Skipping {0} already uploaded files...', skippedCount));
            }

            // Upload changed files
            let uploadedCount = 0;
            const config = vscode.workspace.getConfiguration(EXT_NAME);
            const concurrency = config.get<number>('sync.concurrency', 3);

            await limitConcurrency(filesToUpload, concurrency, async (relativePath) => {
                if (token?.isCancellationRequested) throw new vscode.CancellationError();

                uploadedCount++;
                this.uploadCount++;
                this.reportProgress(progress, lm.t('Uploading "{0}": {1} ({2}/{3})...', convTitle, relativePath, uploadedCount, filesToUpload.length));

                // Read and encrypt file
                const fullPath = this.getFullPathForRelative(conversationId, relativePath);
                const content = await fs.promises.readFile(fullPath);

                const useCompression = config.get<boolean>('sync.enableCompression', true);
                const encrypted = crypto.encrypt(content, this.masterPassword!, useCompression);

                // Get the local plaintext hash to save as metadata
                const localHash = localData.fileHashes[relativePath].hash;

                await this.driveService.uploadConversationFile(conversationId, relativePath, encrypted, localHash);

                // Update hash cache to ensure consistency on next comparison
                const fileHash = crypto.computeMd5Hash(content);
                const stats = await fs.promises.stat(fullPath);
                this.fileHashCache.set(fullPath, { mtime: stats.mtimeMs, hash: fileHash });
            }, token);

            // Delete removed files from remote
            for (const relativePath of filesToDelete) {
                if (token?.isCancellationRequested) throw new vscode.CancellationError();
                await this.driveService.deleteConversationFile(conversationId, relativePath);
            }

            // Only update manifest if we actually made changes (or found existing files that needed to be recorded)
            if (filesToUpload.length > 0 || filesToDelete.length > 0 || skippedCount > 0) {
                // Update manifest with new file hashes
                await this.updateManifestEntryWithFileHashes(
                    conversationId,
                    localData.overallHash,
                    localData.fileHashes,
                    localData.maxMtime > 0 ? new Date(localData.maxMtime).toISOString() : undefined
                );
                console.log(`[Push] Updated manifest for ${conversationId}: ${filesToUpload.length} uploaded, ${filesToDelete.length} deleted`);
            } else {
                console.log(`[Push] Skipped ${conversationId}: no changes detected`);
            }
        } finally {
            this.activeTransfers.delete(conversationId);
            this.updateDashboardIfVisible();
        }
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
        const manifest = await this.getDecryptedManifest(true);
        const remoteConv = manifest?.conversations.find(c => c.id === conversationId);

        if (!remoteConv) {
            throw new Error(lm.t('Conversation {0} not found in manifest', conversationId));
        }

        // Track active transfer for dashboard
        const convTitle = this.getConversationTitle(conversationId);
        this.activeTransfers.set(conversationId, { title: convTitle, type: 'download', startTime: Date.now() });
        this.updateDashboardIfVisible();

        try {
            // Check if using new per-file format (version 2) or legacy ZIP
            if (remoteConv.version === 2 && remoteConv.fileHashes) {
                await this.pullConversationPerFile(conversationId, convTitle, remoteConv.fileHashes, progress, token);
            } else {
                // Legacy format - download entire ZIP
                await this.pullConversationLegacy(conversationId, convTitle, progress, token);
            }
        } finally {
            this.activeTransfers.delete(conversationId);
            this.updateDashboardIfVisible();
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
        convTitle: string,
        remoteHashes: { [relativePath: string]: FileHashInfo },
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        const lm = LocalizationManager.getInstance();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        // Get local file hashes
        this.reportProgress(progress, lm.t('Analyzing "{0}"...', convTitle));
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
            this.downloadCount++;
            this.reportProgress(progress, lm.t('Downloading "{0}": {1} ({2}/{3})...', convTitle, relativePath, downloadedCount, filesToDownload.length));

            const encrypted = await this.driveService.downloadConversationFile(conversationId, relativePath);
            if (encrypted) {
                const content = crypto.decrypt(encrypted, this.masterPassword!);
                const fullPath = this.getFullPathForRelative(conversationId, relativePath);

                // Ensure directory exists
                await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, content);

                // Update hash cache with new content to prevent stale cache on next sync
                const newHash = crypto.computeMd5Hash(content);
                const newStats = await fs.promises.stat(fullPath);
                this.fileHashCache.set(fullPath, { mtime: newStats.mtimeMs, hash: newHash });
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
        convTitle: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        const lm = LocalizationManager.getInstance();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        // Download encrypted ZIP
        this.reportProgress(progress, lm.t('Downloading "{0}"...', convTitle));
        this.downloadCount++;
        const encrypted = await this.driveService.downloadConversation(conversationId);

        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        if (!encrypted) {
            throw new Error(lm.t('Conversation {0} not found in Drive', conversationId));
        }

        // Decrypt
        this.reportProgress(progress, lm.t('Decrypting "{0}"...', convTitle));
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
            const lm = LocalizationManager.getInstance();
            throw new Error(lm.t('Encryption password not set'));
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
     * Clear all internal caches and temporary files
     */
    public async clearCache(): Promise<void> {
        this.fileHashCache.clear();
        this.activeTransfers.clear();
        this.cachedManifest = null;
        this.lastManifestFetch = 0;

        // Clean up temp files
        try {
            const tempDir = os.tmpdir();
            const files = await fs.promises.readdir(tempDir);
            let deletedCount = 0;

            for (const file of files) {
                if (file.startsWith('ag-sync-') || file.startsWith('ag-import-')) {
                    const fullPath = path.join(tempDir, file);
                    try {
                        await fs.promises.rm(fullPath, { recursive: true, force: true });
                        deletedCount++;
                    } catch (e) {
                        console.error(`Failed to delete temp file ${file}:`, e);
                    }
                }
            }
            console.log(`[Cache] Cleared internal caches and deleted ${deletedCount} temp files/dirs.`);
        } catch (e) {
            console.error('Failed to cleanup temp files:', e);
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

        const lm = LocalizationManager.getInstance();
        try {
            if (!this.driveService) return null;
            await this.driveService.ensureSyncFolders();
            const encrypted = await this.driveService.getManifest();

            if (!encrypted) {
                return null;
            }

            if (!this.masterPassword) {
                // Cannot decrypt without password
                return null;
            }

            const decrypted = crypto.decrypt(encrypted, this.masterPassword!);

            try {
                const manifest = JSON.parse(decrypted.toString('utf8'));
                this.cachedManifest = manifest;
                this.lastManifestFetch = Date.now();
                return manifest;
            } catch (e: any) {
                vscode.window.showErrorMessage(lm.t('Failed to parse manifest JSON: {0}', e.message));
                return null;
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(lm.t('Failed to get/decrypt manifest: {0}', error.message));
            return null;
        }
    }

    /**
     * Get sync usage statistics (local calculation based on cached manifest)
     */
    public async getSyncUsageStats(): Promise<{ conversationCount: number; totalSize: number; lastModified?: string }> {
        // Ensure we have the latest manifest
        const manifest = await this.getDecryptedManifest();
        if (!manifest) {
            return { conversationCount: 0, totalSize: 0 };
        }

        let totalSize = 0;
        let conversationCount = 0;

        for (const conv of manifest.conversations) {
            conversationCount++;
            // Use stored size if available, otherwise estimate or ignore
            if (conv.size) {
                totalSize += conv.size;
            } else if (conv.fileHashes) {
                // Sum up file sizes
                for (const hashInfo of Object.values(conv.fileHashes)) {
                    totalSize += hashInfo.size;
                }
            }
        }

        return {
            conversationCount,
            totalSize,
            lastModified: manifest.lastModified
        };
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
    private async updateManifestEntry(conversationId: string, hash: string, size?: number, lastModified?: string): Promise<void> {
        const lm = LocalizationManager.getInstance();
        // Use a queue to ensure manifest updates are sequential and don't overwrite each other
        this.manifestUpdateQueue = this.manifestUpdateQueue.then(async () => {
            try {
                const now = new Date().toISOString();
                const title = this.getConversationTitle(conversationId);

                // Always get fresh manifest when updating
                const manifest = await this.getDecryptedManifest(true);
                if (!manifest) {
                    return;
                }

                const existingIdx = manifest.conversations.findIndex(c => c.id === conversationId);
                const existing = existingIdx >= 0 ? manifest.conversations[existingIdx] : null;

                const entry: SyncedConversation = {
                    id: conversationId,
                    title: title,
                    lastModified: lastModified || now,
                    hash: hash,
                    modifiedBy: this.config!.machineId,
                    size: size,
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
                const useCompression = vscode.workspace.getConfiguration(EXT_NAME).get<boolean>('sync.enableCompression', true);
                const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!, useCompression);
                await this.driveService.updateManifest(encrypted);
            } catch (error: any) {
                vscode.window.showErrorMessage(lm.t('Failed to update manifest for {0}: {1}', conversationId, error.message));
                throw error;
            }
        });

        return this.manifestUpdateQueue;
    }

    /**
     * Update a single entry in the manifest with per-file hashes (new format)
     */
    private async updateManifestEntryWithFileHashes(
        conversationId: string,
        hash: string,
        fileHashes: { [relativePath: string]: FileHashInfo },
        lastModified?: string
    ): Promise<void> {
        const lm = LocalizationManager.getInstance();
        // Use a queue to ensure manifest updates are sequential and don't overwrite each other
        this.manifestUpdateQueue = this.manifestUpdateQueue.then(async () => {
            try {
                const now = new Date().toISOString();
                const title = this.getConversationTitle(conversationId);

                // Always get fresh manifest when updating
                const manifest = await this.getDecryptedManifest(true);
                if (!manifest) {
                    return;
                }

                const existingIdx = manifest.conversations.findIndex(c => c.id === conversationId);
                const existing = existingIdx >= 0 ? manifest.conversations[existingIdx] : null;

                // Calculate total size from file hashes
                const totalSize = Object.values(fileHashes).reduce((sum, info) => sum + info.size, 0);

                const entry: SyncedConversation = {
                    id: conversationId,
                    title: title,
                    lastModified: lastModified || now,
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

                console.log(`[Manifest] Updating for ${conversationId}: ${Object.keys(fileHashes).length} files, ${manifest.conversations.length} conversations total`);
                const manifestJson = JSON.stringify(manifest, null, 2);
                const useCompression = vscode.workspace.getConfiguration(EXT_NAME).get<boolean>('sync.enableCompression', true);
                const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!, useCompression);
                await this.driveService.updateManifest(encrypted);
                console.log(`[Manifest] Saved (${manifestJson.length} bytes)`);

            } catch (error: any) {
                vscode.window.showErrorMessage(lm.t('Failed to update manifest (per-file) for {0}: {1}', conversationId, error.message));
                throw error;
            }
        });

        return this.manifestUpdateQueue;
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
        const accountQuota = this.quotaManager?.getLatestSnapshot();
        const conversations = await this.getLocalConversationsAsync();

        const state: MachineState = {
            machineId: this.config.machineId,
            machineName: machineName,
            lastSync: new Date().toISOString(),
            syncCount: this.syncCount,
            uploadCount: this.uploadCount,
            downloadCount: this.downloadCount,
            quota: quota || undefined,
            accountQuota: accountQuota,
            conversationStates: conversations.map(c => ({
                id: c.id,
                localHash: c.hash,
                lastSynced: new Date().toISOString()
            }))
        };

        const useCompression = vscode.workspace.getConfiguration(EXT_NAME).get<boolean>('sync.enableCompression', true);
        const encrypted = crypto.encrypt(
            Buffer.from(JSON.stringify(state)),
            this.masterPassword!,
            useCompression
        );

        await this.driveService.updateMachineState(this.config.machineId, encrypted);
    }

    /**
     * Get this machine's previous state from Drive
     */
    private async getMyMachineState(): Promise<MachineState | null> {
        if (!this.config?.machineId) return null;
        try {
            const encrypted = await this.driveService.getMachineState(this.config.machineId);
            if (!encrypted) return null;

            const decrypted = crypto.decrypt(encrypted, this.masterPassword!);
            return JSON.parse(decrypted.toString()) as MachineState;
        } catch (e) {
            console.warn('Failed to load machine state, falling back to basic sync:', e);
            return null;
        }
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

                            // Visual scale [■■■■□□]
                            const progressBar = drawProgressBar(progress * 100, 15);

                            // Format remaining time
                            let timeText = '';
                            const seconds = Math.ceil(msUntilSync / 1000);
                            if (seconds > 60) {
                                timeText = `${Math.ceil(seconds / 60)}${lm.t('m')}`;
                            } else {
                                timeText = `${seconds}s`;
                            }

                            md.appendMarkdown(`$(watch) ${lm.t('Next Sync')}: \`${progressBar}\` (${timeText})\n\n`);
                        }
                    }

                    md.appendMarkdown(`$(sync) ${lm.t('Session Syncs')}: ${sessionCount}`);

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

        const EXCLUDE_LIST = ['.ds_store', 'thumbs.db', '.git', '.temp', '.bak'];

        try {
            const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const dirent of dirents) {
                if (EXCLUDE_LIST.includes(dirent.name.toLowerCase()) || dirent.name.endsWith('~')) {
                    continue;
                }
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
        maxMtime: number;
    }> {
        const parts: string[] = [];
        const fileHashes: { [relativePath: string]: FileHashInfo } = {};
        let maxMtime = 0;

        // 1. Conversation PB file
        const pbPath = path.join(CONV_DIR, `${conversationId}.pb`);
        if (fs.existsSync(pbPath)) {
            const hash = await this.getFileHashWithCacheAsync(pbPath);
            if (hash) {
                const relativePath = `conversations/${conversationId}.pb`;
                parts.push(`${relativePath}:${hash}`);
                const stats = await fs.promises.stat(pbPath);
                maxMtime = Math.max(maxMtime, stats.mtimeMs);
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
                    maxMtime = Math.max(maxMtime, stats.mtimeMs);
                    fileHashes[file.path] = {
                        hash,
                        size: stats.size,
                        lastModified: stats.mtime.toISOString()
                    };
                }
            }
        }

        const overallHash = parts.length === 0 ? '' : crypto.computeMd5Hash(Buffer.from(parts.join('|')));

        return { overallHash, fileHashes, maxMtime };
    }

    /**
     * Get local conversations with metadata (Async)
     */
    private async getLocalConversationsAsync(): Promise<Array<{ id: string; title: string; lastModified: string; hash: string; size: number }>> {
        // Reuse utils logic to ensure consistent title extraction
        const items = await getConversationsAsync(BRAIN_DIR);

        // Map to format required by sync, computing hashes
        return Promise.all(items.map(async item => {
            const { overallHash, fileHashes, maxMtime } = await this.computeConversationFileHashesAsync(item.id);
            // Use the actual max mtime of files, falling back to the directory mtime if no files
            const lastModified = maxMtime > 0 ? new Date(maxMtime).toISOString() : item.lastModified.toISOString();
            const size = Object.values(fileHashes).reduce((sum, f) => sum + f.size, 0);

            return {
                id: item.id,
                title: item.label, // Extracted title from utils
                lastModified: lastModified,
                hash: overallHash,
                files: fileHashes,
                size: size
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
                    if (result.pushed.length || result.pulled.length || result.conflicts.length) {
                        const silent = vscode.workspace.getConfiguration(EXT_NAME).get('sync.silent', false);
                        const lm = LocalizationManager.getInstance();

                        if (result.conflicts.length > 0) {
                            vscode.window.showWarningMessage(
                                lm.t('Auto-sync: {0} conflicts detected. Run "Sync Now" to resolve.', result.conflicts.length),
                                lm.t('Sync Now')
                            ).then(selection => {
                                if (selection === lm.t('Sync Now')) {
                                    vscode.commands.executeCommand(`${EXT_NAME}.syncNow`);
                                }
                            });
                        } else if (!silent) {
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

        // NOTE: Machine name and config initialization moved inside withProgress
        // to allow session selection logic to run first


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

                            const currentHostname = os.hostname();

                            for (const m of sortedMachines) {
                                if (m.id && m.name) {
                                    let detail = '';
                                    const isSameDevice = m.name?.toLowerCase() === currentHostname.toLowerCase();

                                    if (m.lastSync && m.createdAt) {
                                        const start = new Date(m.createdAt).getTime();
                                        const end = new Date(m.lastSync).getTime();
                                        const durationMs = end - start;
                                        if (durationMs > 0) {
                                            detail = lm.t('Duration: {0}', formatDuration(durationMs));
                                        }
                                    }

                                    if (!isSameDevice) {
                                        detail = detail ? `${detail} | ${lm.t('Different Device')}` : lm.t('Different Device');
                                    }

                                    choices.push({
                                        label: `$(device-desktop) ${lm.t('Resume: {0}', m.name)}`,
                                        id: m.id,
                                        description: m.lastSync ? lm.t('Last active: {0}', lm.formatDateTime(m.lastSync)) : m.id,
                                        detail: detail,
                                        // Store availability in a custom property or check name in logic
                                        // We can't disable items in VS Code API properly, so we rely on logic check
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
                                if (selected) {
                                    if (selected.id === 'new' || selected.id === '') {
                                        // Allowed
                                        resolve(selected);
                                        quickPick.hide();
                                    } else {
                                        resolve(selected);
                                        quickPick.hide();
                                    }
                                } else {
                                    resolve(undefined);
                                    quickPick.hide();
                                }
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

                            quickPick.buttons = [
                                { iconPath: new vscode.ThemeIcon('heart'), tooltip: lm.t('Support on Patreon') },
                                { iconPath: new vscode.ThemeIcon('coffee'), tooltip: lm.t('Buy Me a Coffee') },
                                { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: `${lm.t('Sort')}: ${sortTooltip}` }
                            ];
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

                        quickPick.onDidTriggerButton(button => {
                            const tooltip = button.tooltip?.toString() || '';
                            if (tooltip.includes('Patreon')) {
                                vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
                            } else if (tooltip.includes('Coffee')) {
                                vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
                            } else {
                                // Sort button
                                if (sortMethod === 'modified') sortMethod = 'created';
                                else if (sortMethod === 'created') sortMethod = 'name';
                                else sortMethod = 'modified';
                                updateItems(true);
                            }
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
            console.error('Setup failed details:', error);
            if (error.stack) console.error(error.stack);
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
        // Keep status bar visible with disconnected state (updateStatusBar shows warning icon)
        this.updateStatusBar('idle');

        const lm = LocalizationManager.getInstance();
        vscode.window.showInformationMessage(lm.t("Disconnected from sync. Local data is kept safe."));
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
            // Always force a fresh manifest fetch at the start of sync to avoid stale data/race conditions
            let remoteManifest = await this.getDecryptedManifest(true);
            if (!remoteManifest) {
                try {
                    console.log('Remote manifest not found, attempting to recreate...');
                    await this.createInitialManifest();
                } catch (e: any) {
                    throw new Error(lm.t("Failed to get or create remote manifest: {0}", e.message));
                }

                const retryManifest = await this.getDecryptedManifest(true);
                if (!retryManifest) {
                    throw new Error(lm.t("Failed to get remote manifest after recreation attempt"));
                }
                remoteManifest = retryManifest;
            }
            return remoteManifest;
        } catch (error: any) {
            vscode.window.showErrorMessage(lm.t('ensureRemoteManifest failed: {0}', error.message));
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
        localConversations: Array<{ id: string; title: string; lastModified: string; hash: string; size: number }>,
        remoteManifest: SyncManifest,
        lastSyncedDatabase: Map<string, string>, // id -> lastSyncedHash
        result: SyncResult,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        const lm = LocalizationManager.getInstance();
        const local = localConversations.find(c => c.id === convId);
        const remote = remoteManifest.conversations.find(c => c.id === convId);
        const title = local?.title || remote?.title || convId;
        const lastSyncedHash = lastSyncedDatabase.get(convId);

        // Auto-correct remote title if local exists and differs
        if (local && remote && local.title !== remote.title && local.title !== local.id) {
            // Force update manifest to sync title even if content hash matched.
            // Preserve the remote.lastModified to avoid triggering sync loops on other machines.
            if (remote.fileHashes) {
                await this.updateManifestEntryWithFileHashes(convId, remote.hash, remote.fileHashes, remote.lastModified);
            } else {
                await this.updateManifestEntry(convId, remote.hash, remote.size, remote.lastModified);
            }
        }

        this.reportProgress(progress, lm.t('Syncing "{0}"...', title));

        if (local && !remote) {
            // Local only - push to remote
            // (Unless it was deleted remotely? If lastSyncedHash exists but remote doesn't, it implies remote deletion)
            if (lastSyncedHash) {
                // It was synced before, but now gone from remote. 
                // This means another machine deleted it.
                // Action: Delete locally? Or restore remote?
                // Safest: Restore remote (Push) or ask user?
                // Git logic: Upstream deleted. Local modified?
                // Let's assume re-push for now, or maybe "Conflict: Remote Deleted".
                // Simple logic: Push as new.
            }
            try {
                await this.pushConversation(convId, progress, token);
                result.pushed.push(convId);
            } catch (error: any) {
                if (error instanceof vscode.CancellationError) throw error;
                result.errors.push(`Failed to push ${convId}: ${error.message}`);
            }
        } else if (!local && remote) {
            // Remote only - pull to local
            // (Unless checked against lastSyncedHash? If we tracked deletions locally via a tombstone list, we'd know. But we don't.)
            try {
                await this.pullConversation(convId, progress, token);
                result.pulled.push(convId);
            } catch (error: any) {
                if (error instanceof vscode.CancellationError) throw error;
                result.errors.push(`Failed to pull ${convId}: ${error.message}`);
            }
        } else if (local && remote) {
            // Both exist - check for changes
            if (local.hash === remote.hash) {
                // Synced
                return;
            }

            // 3-Way Merge Logic
            const removeChanged = remote.hash !== lastSyncedHash;
            const localChanged = local.hash !== lastSyncedHash;

            if (!lastSyncedHash) {
                // First sync for this item on this machine, but both exist. 
                // Treat as conflict to be safe, unless we want to "Last Write Wins" fallback.
                // Fallback to timestamp logic for "Adoption"
                // const localDate = new Date(local.lastModified);
                // const remoteDate = new Date(remote.lastModified);

                // If one is significantly newer (e.g. > 1 min), adopt it?
                // Better safe: Conflict.
                const remoteMachine = remoteManifest.machines?.find(m => m.id === remote.modifiedBy);
                result.conflicts.push({
                    conversationId: convId,
                    localModified: local.lastModified,
                    remoteModified: remote.lastModified,
                    localHash: local.hash,
                    remoteHash: remote.hash,
                    localSize: local.size,
                    remoteSize: remote.size,
                    remoteModifiedBy: remote.modifiedBy,
                    remoteModifiedByName: remoteMachine?.name || remote.createdByName
                });
            } else if (localChanged && !removeChanged) {
                // Only local changed -> Push
                try {
                    await this.pushConversation(convId, progress, token);
                    result.pushed.push(convId);
                } catch (error: any) {
                    if (error instanceof vscode.CancellationError) throw error;
                    result.errors.push(`Failed to push ${convId}: ${error.message}`);
                }
            } else if (removeChanged && !localChanged) {
                // Only remote changed -> Pull
                try {
                    await this.pullConversation(convId, progress, token);
                    result.pulled.push(convId);
                } catch (error: any) {
                    if (error instanceof vscode.CancellationError) throw error;
                    result.errors.push(`Failed to pull ${convId}: ${error.message}`);
                }
            } else {
                // Both changed (and hashes differ) -> Conflict
                const remoteMachine = remoteManifest.machines?.find(m => m.id === remote.modifiedBy);
                const remoteDate = remote.lastModified;

                result.conflicts.push({
                    conversationId: convId,
                    localModified: local.lastModified,
                    remoteModified: remoteDate,
                    localHash: local.hash,
                    remoteHash: remote.hash,
                    localSize: local.size,
                    remoteSize: remote.size,
                    remoteModifiedBy: remote.modifiedBy,
                    remoteModifiedByName: remoteMachine?.name || remote.createdByName
                });
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

            quickPick.buttons = [
                { iconPath: new vscode.ThemeIcon('heart'), tooltip: lm.t('Support on Patreon') },
                { iconPath: new vscode.ThemeIcon('coffee'), tooltip: lm.t('Buy Me a Coffee') },
                { iconPath: new vscode.ThemeIcon('star'), tooltip: lm.t('Star on GitHub') },
                { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: `${lm.t('Sort')}: ${sortTooltip}` }
            ];
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

        // Handle Button Click (Sort and Donation)
        quickPick.onDidTriggerButton(button => {
            const tooltip = button.tooltip?.toString() || '';
            if (tooltip.includes('Patreon')) {
                vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
            } else if (tooltip.includes('Coffee')) {
                vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
            } else if (tooltip.includes('GitHub')) {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/unchase/antigravity-storage-manager'));
            } else {
                // Sort button
                if (currentSort === 'modified') currentSort = 'created';
                else if (currentSort === 'created') currentSort = 'name';
                else currentSort = 'modified';

                const previousSelectionIds = quickPick.selectedItems.map(i => i.id);
                quickPick.items = prepareItems(conversations, currentSort);
                quickPick.selectedItems = quickPick.items.filter(i => i.id && previousSelectionIds.includes(i.id));

                updateSortButton();
            }
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

        this.refreshStatistics(false);
    }

    private async deleteConversation(id: string): Promise<void> {
        const lm = LocalizationManager.getInstance();
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

            vscode.window.showInformationMessage(lm.t('Conversation deleted.'));
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Error deleting: {0}', e.message));
        }
    }

    /**
     * Delete a single file from a conversation (local and remote)
     */
    async deleteConversationFile(conversationId: string, relativePath: string): Promise<void> {
        // 1. Delete locally if exists
        const fullPath = this.getFullPathForRelative(conversationId, relativePath);
        if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
        }

        // 2. Delete remotely if exists (update manifest)
        const manifest = await this.getDecryptedManifest();
        if (!manifest) return;

        const remoteConv = manifest.conversations.find(c => c.id === conversationId);
        if (remoteConv && remoteConv.fileHashes && remoteConv.fileHashes[relativePath]) {
            // Delete file from Drive
            await this.driveService.deleteConversationFile(conversationId, relativePath);

            // Update manifest
            delete remoteConv.fileHashes[relativePath];

            // Recompute overall hash
            const remainingFiles = Object.keys(remoteConv.fileHashes).sort();
            const parts: string[] = [];
            for (const path of remainingFiles) {
                parts.push(`${path}:${remoteConv.fileHashes[path].hash}`);
            }
            remoteConv.hash = parts.length === 0 ? '' : crypto.computeMd5Hash(Buffer.from(parts.join('|')));

            // Save manifest
            manifest.lastModified = new Date().toISOString();
            const manifestJson = JSON.stringify(manifest, null, 2);
            const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword!);
            await this.driveService.updateManifest(encrypted);
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

    private async refreshStatistics(preserveFocus: boolean = true) {
        const lm = LocalizationManager.getInstance();

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: lm.t('Loading Sync Statistics...'),
            cancellable: false
        }, async () => {
            try {
                const start = Date.now();

                // Gather initial data in parallel
                const [localConversations, remoteManifest, currentQuota, machineFiles] = await Promise.all([
                    this.getLocalConversationsAsync(),
                    this.getDecryptedManifest(true), // Force refresh from Drive
                    this.driveService.getStorageInfo(),
                    this.driveService.listMachineStates()
                ]);

                // Get machine states in parallel
                const machinePromises = machineFiles.map(async file => {
                    let machineName = lm.t('Unknown Device');
                    let lastSync = file.modifiedTime;
                    let syncCount = 0;
                    let quota: { used: number; limit: number } | undefined = undefined;

                    const machineId = file.name.replace('.json.enc', '');

                    try {
                        // Check if this file corresponds to the current machine
                        if (machineId === this.config!.machineId) {
                            const localMachine = {
                                name: this.config!.machineName,
                                id: machineId,
                                fileId: 'current', // Not deletable
                                lastSync: lastSync, // This is file modified time, might be old config.lastSync is better?
                                isCurrent: true,
                                syncCount: this.syncCount,
                                uploadCount: this.uploadCount,
                                downloadCount: this.downloadCount,
                                quota: currentQuota || undefined,
                                accountQuota: this.quotaManager?.getLatestSnapshot(),
                                conversationStates: localConversations.map(c => ({ id: c.id }))
                            };

                            // CHECK FOR REMOTE CONFLICT (Shared Session)
                            // If the remote file has a different name, it means another machine is using this ID.
                            try {
                                const contentValues = await this.driveService.getMachineState(machineId);
                                if (contentValues) {
                                    const decrypted = crypto.decrypt(contentValues, this.masterPassword!);
                                    const state: MachineState = JSON.parse(decrypted.toString());

                                    // If names differ, or if the remote lastSync is significantly newer than our lastSync (implies concurrency), 
                                    // treat it as a ghost/other device.
                                    // Simplest check: Name difference.
                                    if (state.machineName && state.machineName !== this.config!.machineName) {
                                        const remoteGhost = {
                                            name: state.machineName, // Shows the OTHER name
                                            id: machineId,
                                            fileId: file.id,
                                            lastSync: state.lastSync,
                                            isCurrent: false, // It's NOT us, even if ID matches
                                            syncCount: state.syncCount || 0,
                                            uploadCount: state.uploadCount || 0,
                                            downloadCount: state.downloadCount || 0,
                                            quota: state.quota,
                                            accountQuota: state.accountQuota,
                                            conversationStates: state.conversationStates || []
                                        };
                                        return [localMachine, remoteGhost];
                                    }
                                }
                            } catch (e) {
                                console.error('Failed to check remote state for current machine ghosting', e);
                            }

                            return localMachine;
                        }

                        const contentValues = await this.driveService.getMachineState(machineId);
                        if (contentValues) {
                            const decrypted = crypto.decrypt(contentValues, this.masterPassword!);
                            const state: MachineState = JSON.parse(decrypted.toString());
                            machineName = state.machineName || lm.t('Unknown');
                            lastSync = state.lastSync;
                            syncCount = state.syncCount || 0;
                            quota = state.quota;

                            return {
                                name: machineName,
                                id: machineId,
                                fileId: file.id, // Needed for deletion
                                lastSync: lastSync,
                                isCurrent: false,
                                syncCount: syncCount,
                                uploadCount: state.uploadCount || 0,
                                downloadCount: state.downloadCount || 0,
                                quota: quota,
                                accountQuota: state.accountQuota,
                                conversationStates: state.conversationStates || []
                            };
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(lm.t('Failed to load machine state for {0}: {1}', machineId, e.message));
                        // Fallback for partially corrupted or missing states
                        return {
                            name: machineName,
                            id: machineId,
                            fileId: file.id,
                            lastSync: lastSync,
                            isCurrent: false,
                            syncCount: 0,
                            uploadCount: 0,
                            downloadCount: 0,
                            quota: undefined,
                            accountQuota: undefined,
                            conversationStates: []
                        };
                    }
                    return null;
                });

                const machineResults = await Promise.all(machinePromises);
                const machines = machineResults.flat().filter(m => m !== null) as any[];

                // Ensure current machine is always present
                if (!machines.some(m => m.isCurrent)) {
                    machines.push({
                        name: this.config!.machineName,
                        id: this.config!.machineId,
                        fileId: 'current',
                        lastSync: new Date().toISOString(),
                        isCurrent: true,
                        syncCount: this.syncCount,
                        uploadCount: this.uploadCount,
                        downloadCount: this.downloadCount,
                        quota: currentQuota || undefined,
                        accountQuota: this.quotaManager?.getLatestSnapshot(),
                        conversationStates: localConversations.map(c => ({ id: c.id }))
                    });
                }

                // Merge machines from manifest (for shared session scenarios where one device overwrote the state file)
                if (remoteManifest?.machines) {
                    for (const manifestMachine of remoteManifest.machines) {
                        // Check if this machine is already in the list (by id + name combination)
                        const existsWithSameName = machines.some(m =>
                            m.id === manifestMachine.id && m.name === manifestMachine.name
                        );

                        if (!existsWithSameName) {
                            // Check if this machine shares the ID with current machine but has different name
                            const isSameIdDifferentName = manifestMachine.id === this.config!.machineId &&
                                manifestMachine.name !== this.config!.machineName;

                            if (isSameIdDifferentName || !machines.some(m => m.id === manifestMachine.id)) {
                                machines.push({
                                    name: manifestMachine.name,
                                    id: manifestMachine.id,
                                    fileId: '', // No direct file for this entry
                                    lastSync: manifestMachine.lastSync,
                                    isCurrent: false,
                                    syncCount: 0,
                                    uploadCount: manifestMachine.uploadCount || 0,
                                    downloadCount: manifestMachine.downloadCount || 0,
                                    quota: undefined,
                                    accountQuota: undefined, // Manifest doesn't store full quota snapshot
                                    conversationStates: []
                                });
                            }
                        }
                    }
                }


                // Use Drive API (about.get) to avoid requiring userinfo.email scope, which triggers re-auth
                const userInfo = await this.driveService?.getUserInfo().catch(() => null);
                const quotaSnapshot = this.quotaManager?.getLatestSnapshot();

                // Build usage history map for current device's models
                const usageHistory = new Map<string, { timestamp: number; usage: number }[]>();
                if (this.quotaManager && quotaSnapshot?.models) {
                    const tracker = this.quotaManager.getUsageTracker();
                    for (const model of quotaSnapshot.models) {
                        const history = tracker.getHistory(model.modelId);
                        if (history && history.length > 0) {
                            usageHistory.set(model.modelId, history);
                        }
                    }
                }

                // Render final HTML using SyncStatsWebview
                const statsData: SyncStatsData = {
                    localConversations,
                    remoteManifest: remoteManifest || { conversations: [] } as any,
                    localCount: localConversations.length,
                    remoteCount: remoteManifest?.conversations.length || 0,
                    lastSync: this.config!.lastSync || 'Never',
                    machines: machines,
                    loadTime: Date.now() - start,
                    currentMachineId: this.config!.machineId,
                    driveQuota: currentQuota || undefined,
                    activeTransfers: Array.from(this.activeTransfers.entries()).map(([id, info]) => ({
                        conversationId: id,
                        conversationTitle: info.title,
                        type: info.type,
                        startTime: info.startTime
                    })),
                    accountQuotaSnapshot: quotaSnapshot || undefined,
                    userEmail: quotaSnapshot?.userEmail, // Keep this for AI Studio account
                    driveEmail: userInfo?.email, // Specific for Drive Storage
                    usageHistory: usageHistory.size > 0 ? usageHistory : undefined
                };

                this.lastStatsData = statsData;
                const onMessage = async (message: any) => {
                    switch (message.command) {
                        case 'sort': {
                            SyncStatsWebview.updateSort(message.table, message.col);
                            if (this.lastStatsData) {
                                SyncStatsWebview.update(this.lastStatsData);
                            } else {
                                this.refreshStatistics();
                            }
                            break;
                        }
                        case 'refresh': {
                            this.refreshStatistics(false); // Force refresh
                            break;
                        }
                        case 'openConversation': {
                            // Try to open in Antigravity/Roo-Cline/Claude-Dev first
                            let opened = false;
                            const possibleCommands = [
                                'antigravity.openConversation',
                                'roo-cline.openConversation',
                                'claude-dev.openConversation',
                                'cline.openConversation'
                            ];

                            for (const cmd of possibleCommands) {
                                try {
                                    await vscode.commands.executeCommand(cmd, message.id);
                                    opened = true;
                                    break;
                                } catch {
                                    // Command not found or failed, try next
                                }
                            }

                            if (opened) break;

                            const convPath = path.join(BRAIN_DIR, message.id);
                            if (fs.existsSync(convPath)) {
                                const taskMd = path.join(convPath, 'task.md');
                                if (fs.existsSync(taskMd)) {
                                    const doc = await vscode.workspace.openTextDocument(taskMd);
                                    await vscode.window.showTextDocument(doc);
                                } else {
                                    vscode.env.openExternal(vscode.Uri.file(convPath));
                                }
                            } else {
                                vscode.window.showInformationMessage(lm.t('Conversation content not found locally.'));
                            }
                            break;
                        }
                        case 'deleteConversation': {
                            const confirm = await vscode.window.showWarningMessage(
                                lm.t('Are you sure you want to delete conversation "{0}"?', message.title || message.id),
                                { modal: true },
                                lm.t('Delete'),
                                lm.t('Cancel')
                            );
                            if (confirm === lm.t('Delete')) {
                                await this.deleteConversation(message.id);
                                this.refreshStatistics();
                            }
                            break;
                        }
                        case 'openConversationFile': {
                            const fullPath = this.getFullPathForRelative(message.id, message.file);
                            if (fs.existsSync(fullPath)) {
                                const uri = vscode.Uri.file(fullPath);
                                // Use vscode.open command which delegates to the default editor for the file type (including images)
                                await vscode.commands.executeCommand('vscode.open', uri);
                            } else {
                                vscode.window.showInformationMessage(lm.t('File not found locally.'));
                            }
                            break;
                        }
                        case 'deleteConversationFile': {
                            const confirm = await vscode.window.showWarningMessage(
                                lm.t('Are you sure you want to delete file "{0}"?', message.file),
                                { modal: true },
                                lm.t('Delete'),
                                lm.t('Cancel')
                            );
                            if (confirm === lm.t('Delete')) {
                                try {
                                    await this.deleteConversationFile(message.id, message.file);
                                    vscode.window.showInformationMessage(lm.t('File deleted.'));
                                    this.refreshStatistics();
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(lm.t('Failed to delete file: {0}', e.message));
                                }
                            }
                            break;
                        }
                        case 'renameConversation': {
                            const newName = await vscode.window.showInputBox({
                                title: lm.t('Rename {0}', message.title),
                                prompt: lm.t("Press 'Enter' to confirm or 'Escape' to cancel"),
                                value: message.title
                            });
                            if (newName && newName !== message.title) {
                                await this.renameConversationId(message.id, newName);
                                this.refreshStatistics();
                            }
                            break;
                        }
                        case 'pushConversation':
                            vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: lm.t('Uploading conversation...'),
                                cancellable: true
                            }, async (progress, token) => {
                                try {
                                    await this.pushConversation(message.id, progress, token);
                                    vscode.window.showInformationMessage(lm.t('Conversation uploaded.'));
                                    this.refreshStatistics();
                                } catch (e: any) {
                                    if (e instanceof vscode.CancellationError) return;
                                    vscode.window.showErrorMessage(lm.t('Upload failed: {0}', e.message));
                                }
                            });
                            break;
                        case 'pullConversation':
                            vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: lm.t('Downloading conversation...'),
                                cancellable: true
                            }, async (progress, token) => {
                                try {
                                    await this.pullConversation(message.id, progress, token);
                                    vscode.window.showInformationMessage(lm.t('Conversation downloaded.'));
                                    this.refreshStatistics();
                                } catch (e: any) {
                                    if (e instanceof vscode.CancellationError) return;
                                    vscode.window.showErrorMessage(lm.t('Download failed: {0}', e.message));
                                }
                            });
                            break;
                        case 'deleteMachine': {
                            const confirm = await vscode.window.showWarningMessage(
                                lm.t('Are you sure you want to remove machine "{0}" from sync stats?', message.name),
                                { modal: true },
                                lm.t('Remove'),
                                lm.t('Cancel')
                            );
                            if (confirm === lm.t('Remove')) {
                                try {
                                    await this.driveService.deleteFile(message.id);
                                    vscode.window.showInformationMessage(lm.t('Machine removed.'));
                                    this.refreshStatistics();
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(lm.t('Failed to remove machine: {0}', e.message));
                                }
                            }
                            break;
                        }
                        case 'forceRemoteSync':
                            vscode.window.showInformationMessage(lm.t('Sync signal sent to {0}. (Requires target machine to be online and polling)', message.name));
                            break;
                        case 'deleteMachineConversations':
                            await this.deleteRemoteConversationsForMachine(message.id, message.name);
                            this.refreshStatistics();
                            break;
                    }
                };

                if (SyncStatsWebview.isVisible()) {
                    SyncStatsWebview.update(statsData);
                } else {
                    SyncStatsWebview.show(this.context, statsData, onMessage, preserveFocus);
                }

            } catch (error: any) {
                vscode.window.showErrorMessage(`${lm.t('Error loading statistics')}: ${error.message}`);
            }
        });
    }



    public async deleteRemoteConversationsForMachine(machineId: string, machineName: string): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const confirm = await vscode.window.showWarningMessage(
            lm.t('Delete all conversations created by {0} from Google Drive? This cannot be undone.', machineName),
            { modal: true },
            lm.t('Delete')
        );

        if (confirm !== lm.t('Delete')) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: lm.t('Deleting conversations...'),
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
                    vscode.window.showInformationMessage(lm.t('No conversations found for this machine.'));
                    return;
                }

                // Delete files
                const fileIds = toDelete.map(c => (c as any).fileId).filter((id: string) => !!id);

                // Delete via fileId
                for (const fid of fileIds) {
                    try {
                        await this.driveService.deleteFile(fid);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(lm.t('Failed to delete file {0}: {1}', fid, e.message));
                    }
                }

                // Fallback delete via conversation ID (zip)
                const missingFileId = toDelete.filter(c => !c.fileId);
                for (const c of missingFileId) {
                    try {
                        await this.driveService.deleteConversation(c.id);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(lm.t('Failed to delete conversation zip {0}: {1}', c.id, e.message));
                    }
                }

                // Update Manifest by removing these conversations
                manifest.conversations = manifest.conversations.filter(c => c.createdBy !== machineId);
                manifest.lastModified = new Date().toISOString();

                // Encrypt and save
                const encryptedNew = crypto.encrypt(Buffer.from(JSON.stringify(manifest), 'utf8'), this.masterPassword);
                await this.driveService.updateManifest(encryptedNew);

                vscode.window.showInformationMessage(lm.t('Conversations deleted.'));

                // Refresh stats
                this.showStatistics();

            } catch (error: any) {
                vscode.window.showErrorMessage(`${lm.t('Error')}: ${error.message}`);
                // Also refresh stats in case of partial failure or to reset UI
                this.showStatistics();
            }
        });
    }

    public async manageAuthorizedMachines(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        if (!this.config?.machineId) {
            vscode.window.showWarningMessage(lm.t('Sync is not configured. Run setup first.'));
            return;
        }

        try {
            if (!this.driveService) {
                vscode.window.showErrorMessage(lm.t('Drive service not initialized'));
                return;
            }

            const encryptedManifest = await this.driveService.getManifest();
            let manifest: SyncManifest | null = null;
            if (encryptedManifest && this.masterPassword) {
                try {
                    manifest = JSON.parse(crypto.decrypt(encryptedManifest, this.masterPassword).toString('utf8')) as SyncManifest;
                } catch {
                    vscode.window.showErrorMessage(lm.t('Failed to decrypt manifest.'));
                    return;
                }
            }

            if (!manifest) {
                vscode.window.showErrorMessage(lm.t('Failed to fetch manifest.'));
                return;
            }

            const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
            const currentAuthorized = config.get<string[]>('sync.authorizedRemoteDeleteMachineIds') || [];

            // Collect all known machines with details
            const machinesMap = new Map<string, { name: string, lastSync?: string, createdAt?: string }>();

            // Add current machine
            machinesMap.set(this.config.machineId, {
                name: this.config.machineName || lm.t('Current Machine'),
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
                    machinesMap.set(c.createdBy, { name: c.createdByName || lm.t('Unknown Machine') });
                }
            }

            // ... (machines gathering logic is above, effectively reusing existing variables)

            interface MachineQuickPickItem extends vscode.QuickPickItem {
                description: string; // machineId
                info: { name: string, lastSync?: string, createdAt?: string };
            }

            const quickPick = vscode.window.createQuickPick<MachineQuickPickItem>();
            quickPick.title = lm.t('Manage Authorized Deletion Machines');
            quickPick.placeholder = lm.t('Select machines authorized to delete conversations from others');
            quickPick.canSelectMany = true;

            let sortMethod: 'status' | 'sync' | 'name' = 'status';

            const updateSortButton = () => {
                let sortTooltip = lm.t('Status');
                if (sortMethod === 'sync') sortTooltip = lm.t('Last Sync');
                if (sortMethod === 'name') sortTooltip = lm.t('Name');

                quickPick.buttons = [
                    { iconPath: new vscode.ThemeIcon('heart'), tooltip: lm.t('Support on Patreon') },
                    { iconPath: new vscode.ThemeIcon('coffee'), tooltip: lm.t('Buy Me a Coffee') },
                    { iconPath: new vscode.ThemeIcon('star'), tooltip: lm.t('Star on GitHub') },
                    { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: `${lm.t('Sort')}: ${sortTooltip}` }
                ];
            };

            const updateItems = () => {
                const items: MachineQuickPickItem[] = [];
                const now = Date.now();
                const machinesList = Array.from(machinesMap.entries());

                const sorted = machinesList.sort(([, a], [, b]) => {
                    // Helper to get status priority (Online = 1, Offline = 0)
                    const getStatus = (info: { lastSync?: string }) => {
                        if (!info.lastSync) return 0;
                        const diff = now - new Date(info.lastSync).getTime();
                        return diff < 10 * 60 * 1000 ? 1 : 0;
                    };

                    if (sortMethod === 'status') {
                        const sA = getStatus(a);
                        const sB = getStatus(b);
                        if (sA !== sB) return sB - sA; // Online first
                        // Tie-breaker: Last Sync
                        return (new Date(b.lastSync || 0).getTime()) - (new Date(a.lastSync || 0).getTime());
                    } else if (sortMethod === 'sync') {
                        return (new Date(b.lastSync || 0).getTime()) - (new Date(a.lastSync || 0).getTime());
                    } else { // name
                        return a.name.localeCompare(b.name);
                    }
                });

                for (const [id, info] of sorted) {
                    const isAuth = currentAuthorized.includes(id);
                    const isCurrent = id === this.config?.machineId;

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
                        picked: isAuth,
                        info: info
                    });
                }

                quickPick.items = items;
                quickPick.selectedItems = items.filter(i => i.picked);
                updateSortButton();
            };

            updateItems();

            quickPick.onDidTriggerButton(button => {
                const tooltip = button.tooltip?.toString() || '';
                if (tooltip.includes('Patreon')) {
                    vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
                } else if (tooltip.includes('Coffee')) {
                    vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
                } else if (tooltip.includes('GitHub')) {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/unchase/antigravity-storage-manager'));
                } else {
                    // Sort button
                    if (sortMethod === 'status') sortMethod = 'sync';
                    else if (sortMethod === 'sync') sortMethod = 'name';
                    else sortMethod = 'status';
                    updateItems();
                }
            });

            quickPick.onDidAccept(async () => {
                const selected = quickPick.selectedItems;
                const newAuthorized = selected.map(i => i.description || ''); // Safety check
                await config.update('sync.authorizedRemoteDeleteMachineIds', newAuthorized, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(lm.t('Authorized machines updated.'));
                quickPick.hide();
            });

            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        } catch (error: any) {
            vscode.window.showErrorMessage(`${lm.t('Error')}: ${error.message}`);
        }
    }

    /**
     * Get title of a conversation from its task.md
     */
    private getConversationTitle(conversationId: string): string {
        const lm = LocalizationManager.getInstance();
        try {
            const taskPath = path.join(BRAIN_DIR, conversationId, 'task.md');
            if (fs.existsSync(taskPath)) {
                const content = fs.readFileSync(taskPath, 'utf8');
                const match = content.match(/^#\s+(.*)/);
                if (match) return match[1].trim();
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Failed to get conversation title for {0}: {1}', conversationId, e.message));
        }
        return conversationId;
    }

    /**
     * Update dashboard if it is currently visible
     */
    private updateDashboardIfVisible(): void {
        if (SyncStatsWebview.isVisible()) {
            this.refreshStatistics();
        }
    }
}


