import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const markdownit = require('markdown-it');


import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { GoogleDriveService, SyncManifest, SyncedConversation, Machine, MachineState, FileHashInfo } from './googleDrive';
import * as crypto from './crypto';
import { LocalizationManager } from './l10n/localizationManager';
import { getConversationsAsync, limitConcurrency, formatDuration, ConversationItem } from './utils';
import { SyncStatsWebview, SyncStatsData } from './quota/syncStatsWebview';
import { QuotaManager } from './quota/quotaManager';
import { drawProgressBar } from './quota/utils';
import { AntigravityClient } from './quota/antigravityClient';
import { getFileIconSvg } from './quota/fileIcons';

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
    conversationTitle?: string;
    relativePath?: string;
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
    private lastHistory: Uint8Array | null = null;
    private lastTaskName: string = '';
    private lastTaskSummary: string = '';
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
    private apiClient = new AntigravityClient();
    private md: any;

    constructor(
        context: vscode.ExtensionContext,
        authProvider: GoogleAuthProvider
    ) {
        this.context = context;
        this.authProvider = authProvider;
        this.driveService = new GoogleDriveService(authProvider);

        try {
            const MD = (markdownit as any).default || markdownit;
            if (typeof MD === 'function') {
                this.md = new MD({
                    html: true,
                    linkify: true,
                    breaks: true
                });
            } else if (MD && typeof MD.render === 'function') {
                this.md = MD;
            }
        } catch (e) {
            console.error('Failed to initialize MarkdownIt:', e);
        }
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
        } else if (this.config?.autoSync && this.config?.syncInterval) {
            // Even if not "enabled" (overall switch), if autoSync is on in config, show countdown estimate
            this.nextAutoSyncTime = Date.now() + this.config.syncInterval;
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

            if (filesToDelete.length > 0) {
                const isFirstSync = !this.config?.lastSync || !remoteConv;
                if (isFirstSync) {
                    console.warn(`[Push] First sync for ${conversationId}, skipping remote deletion for ${filesToDelete.length} files that might exist on other machines.`);
                    filesToDelete.length = 0; // Don't delete remotely on first sync
                } else {
                    console.warn(`[Push] Found ${filesToDelete.length} files missing locally for conversation ${conversationId}. Will delete from remote:`, filesToDelete);
                }
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
                    conversationTitle: title,
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
                    conversationTitle: title,
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
                    lastSyncTime: this.config!.lastSync ? new Date(this.config!.lastSync).getTime() : undefined,
                    nextSyncTime: (this.config!.autoSync && this.nextAutoSyncTime) ? this.nextAutoSyncTime : undefined,
                    syncInterval: this.config!.syncInterval || 300000,
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
                        case 'viewPb': {
                            const { id, file } = message;
                            const filename = file.split('/').pop() || id;
                            await this.openPbChat(id, filename);
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
                                }
                            }

                            if (opened) break;

                            const id = message.id;
                            const pbPath = path.join(STORAGE_ROOT, 'conversations', `${id}.pb`);
                            if (fs.existsSync(pbPath)) {
                                const title = message.title || this.getConversationTitle(id) || id;
                                await this.openPbChat(id, title);
                            } else {
                                const convPath = path.join(BRAIN_DIR, id);
                                if (fs.existsSync(convPath)) {
                                    const taskMd = path.join(convPath, 'task.md');
                                    if (fs.existsSync(taskMd)) {
                                        const doc = await vscode.workspace.openTextDocument(taskMd);
                                        await vscode.window.showTextDocument(doc);
                                    } else {
                                        vscode.env.openExternal(vscode.Uri.file(convPath));
                                    }
                                } else {
                                    const lm = LocalizationManager.getInstance();
                                    vscode.window.showInformationMessage(lm.t('Conversation content not found locally.'));
                                }
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
                                    // 1. Remove from Drive file if exists
                                    if (message.id && message.id.trim() !== '') {
                                        await this.driveService.deleteFile(message.id);
                                    }

                                    // 2. Remove from Manifest if present
                                    const manifest = await this.getDecryptedManifest();
                                    if (manifest && manifest.machines) {
                                        const initialCount = manifest.machines.length;
                                        manifest.machines = manifest.machines.filter(m => m.name !== message.name && m.id !== message.machineId);

                                        if (manifest.machines.length < initialCount) {
                                            const encrypted = crypto.encrypt(Buffer.from(JSON.stringify(manifest)), this.masterPassword!);
                                            await this.driveService.updateManifest(encrypted);
                                            this.cachedManifest = manifest;
                                        }
                                    }

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
                        case 'searchPb': {
                            const query = message.query;
                            if (!query) {
                                // Clear search
                                if (this.lastStatsData) {
                                    this.lastStatsData.searchResults = undefined;
                                    this.lastStatsData.searchQuery = undefined;
                                    SyncStatsWebview.update(this.lastStatsData);
                                }
                                return;
                            }

                            // Perform Search
                            await vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: lm.t('Searching history...'),
                                cancellable: true
                            }, async () => {
                                try {
                                    const results = await this.apiClient.search(query);
                                    if (this.lastStatsData) {
                                        this.lastStatsData.searchResults = results;
                                        this.lastStatsData.searchQuery = query;
                                        SyncStatsWebview.update(this.lastStatsData);
                                    }
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(lm.t('Search failed: {0}', e.message));
                                }
                            });
                            break;
                        }
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
     * Opens a specialized chat view for a .pb trajectory.
     */
    private async openPbChat(id: string, filename: string): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const panel = vscode.window.createWebviewPanel(
            'antigravityChat',
            `${filename} (Chat)`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = this.getChatLoadingHtml();

        try {
            const [steps, metadata] = await Promise.all([
                this.apiClient.getConversationMessages(id),
                this.apiClient.getTrajectoryMetadata(id)
            ]);

            // Steps that point to a more detailed trajectory
            const stepsWithPointers = steps.filter((s: any) => s.metadata?.sourceTrajectoryStepInfo?.trajectoryId);

            if (stepsWithPointers.length > 0) {
                const trajCache = new Map<string, any>();
                const uniqueTrajIds = Array.from(new Set(stepsWithPointers.map((s: any) => s.metadata.sourceTrajectoryStepInfo.trajectoryId)));

                await Promise.all(uniqueTrajIds.map(async (tid: string) => {
                    try {
                        // 1. Try GetUserTrajectory
                        let detail = await this.apiClient.getUserTrajectory(tid);

                        // 2. Try GetCascadeTrajectory (via getConversationMessages) if needed
                        if (!detail || !detail.trajectory?.steps || detail.trajectory.steps.length === 0) {
                            const steps = await this.apiClient.getConversationMessages(tid);
                            if (steps && steps.length > 0) {
                                detail = { trajectory: { steps: steps } };
                            }
                        }

                        if (detail) {
                            trajCache.set(tid, detail);
                        }
                    } catch (err) {
                        console.error(`Failed to fetch supplementary trajectory ${tid}:`, err);
                    }
                }));

                stepsWithPointers.forEach((s: any) => {
                    const info = s.metadata.sourceTrajectoryStepInfo;
                    const detail = trajCache.get(info.trajectoryId);
                    if (detail && detail.trajectory?.steps && Array.isArray(detail.trajectory.steps)) {
                        const fetchedStep = detail.trajectory.steps.find((fs: any) => fs.stepIndex === info.stepIndex)
                            || detail.trajectory.steps[info.stepIndex];
                        if (fetchedStep) {
                            Object.assign(s, fetchedStep);
                        }
                    }
                });
            }

            panel.webview.html = this.getChatHtml(filename, steps, metadata);

            panel.webview.onDidReceiveMessage(async (msg) => {
                switch (msg.command) {
                    case 'openFile': {
                        let filePath = msg.path;
                        let lineRange: string | undefined;

                        // Parse line range if present (e.g., path/to/file#L10-L20 or path/to/file:10-20)
                        if (filePath.includes('#')) {
                            [filePath, lineRange] = filePath.split('#');
                        } else {
                            const matches = filePath.match(/:(\d+(?:-\d+)?)$/);
                            if (matches) {
                                lineRange = matches[1];
                                filePath = filePath.substring(0, filePath.length - matches[0].length);
                            }
                        }

                        filePath = decodeURIComponent(filePath);
                        // Handle /c:/ style paths occasionally seen in some envs
                        if (filePath.match(/^\/[a-zA-Z]:/)) {
                            filePath = filePath.substring(1);
                        }

                        let fullPath = '';
                        if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
                            fullPath = filePath;
                        } else {
                            try {
                                fullPath = this.getFullPathForRelative(id, filePath);
                            } catch {
                                // Fallback: check if it is workspace relative
                                const workspaceFolders = vscode.workspace.workspaceFolders;
                                if (workspaceFolders) {
                                    for (const folder of workspaceFolders) {
                                        let p = path.join(folder.uri.fsPath, filePath);
                                        if (fs.existsSync(p)) {
                                            fullPath = p;
                                            break;
                                        }
                                        // Also check for BRAIN_DIR/{id}/{filePath}
                                        p = path.join(BRAIN_DIR, id, filePath);
                                        if (fs.existsSync(p)) {
                                            fullPath = p;
                                            break;
                                        }
                                    }
                                }

                                // Last Resort: Search across entire workspace if we still don't have it
                                if (!fullPath || !fs.existsSync(fullPath)) {
                                    const fileName = path.basename(filePath);
                                    const results = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 1);
                                    if (results && results.length > 0) {
                                        fullPath = results[0].fsPath;
                                    }
                                }
                            }
                        }

                        if (fullPath && fs.existsSync(fullPath)) {
                            const isDirectory = fs.statSync(fullPath).isDirectory();
                            if (isDirectory) {
                                vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fullPath));
                            } else {
                                try {
                                    const doc = await vscode.workspace.openTextDocument(fullPath);
                                    const options: vscode.TextDocumentShowOptions = {};

                                    if (lineRange) {
                                        // Format: 10 or 10-20 or L10-L20 or :10-20
                                        const cleanRange = lineRange.replace(/^[:L]/, '');
                                        const parts = cleanRange.split('-');
                                        const startLine = parseInt(parts[0]) - 1;
                                        const endLine = parts.length > 1 ? parseInt(parts[1]) - 1 : startLine;

                                        if (!isNaN(startLine)) {
                                            options.selection = new vscode.Range(startLine, 0, endLine, 1000);
                                        }
                                    }
                                    await vscode.window.showTextDocument(doc, options);
                                } catch (e) {
                                    // Fallback for binary files (images, etc.)
                                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fullPath));
                                }
                            }
                        } else {
                            vscode.window.showErrorMessage(lm.t('File or directory not found: {0}', filePath));
                        }
                        break;
                    }
                    case 'viewImage': {
                        // Handled by lightbox in webview, but we can also log or open in VS Code if needed
                        break;
                    }
                }
            });
        } catch (e: any) {
            panel.webview.html = this.getChatErrorHtml(e.message);
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
    private getChatLoadingHtml(): string {
        const lm = LocalizationManager.getInstance();
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { display: flex; justify-content: center; align-items: center; height: 100vh; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
                    .spinner { border: 4px solid rgba(255,255,255,0.1); width: 36px; height: 36px; border-radius: 50%; border-left-color: var(--vscode-textLink-foreground); animation: spin 1s linear infinite; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                </style>
            </head>
            <body>
                <div class="spinner"></div>
                <div style="margin-left: 10px;">${lm.t('Loading conversation history...')}</div>
            </body>
            </html>
        `;
    }

    private getChatErrorHtml(error: string): string {
        return `
            <!DOCTYPE html>
            <html>
            <body style="background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); padding: 20px; font-family: var(--vscode-font-family);">
                <h3 style="color: var(--vscode-errorForeground);">Error Loading Chat</h3>
                <pre>${error}</pre>
            </body>
            </html>
        `;
    }

    private getChatHtml(filename: string, steps: any[], metadata: any[] = []): string {
        const lm = LocalizationManager.getInstance();

        let currentThinkingBlock: string[] = [];
        let currentThinkingUsage: any = { inputTokens: 0, outputTokens: 0, thinkingOutputTokens: 0, cacheReadTokens: 0, totalLatencyMs: 0 };
        let currentThinkingStartTime: number | undefined;
        let currentThinkingEndTime: number | undefined;
        const processedSteps: any[] = [];
        const seenStepIds = new Set<string>();
        const seenTrajExecs = new Set<string>();
        let lastStepSignature = '';

        // Map step indices to metadata usage
        const stepMetadata = new Map<number, any>();
        metadata.forEach(m => {
            if (m.stepIndices && Array.isArray(m.stepIndices)) {
                m.stepIndices.forEach((idx: number) => {
                    stepMetadata.set(idx, m.chatModel?.usage || m.usage);
                });
            }
        });

        // Pre-process: Map tool results for merging
        const toolResults = new Map<string, any>();
        steps.forEach(s => {
            const trajId = s.trajectoryId || s.metadata?.sourceTrajectoryStepInfo?.trajectoryId;
            const execId = s.executionId || s.metadata?.executionId || s.metadata?.sourceTrajectoryStepInfo?.executionId;
            const output = s.output || s.response || s.result || s.toolOutput || s.tool_output;
            if (trajId && execId && output) {
                toolResults.set(`${trajId}|${execId}`, s);
            }
        });

        // Pre-process: Merge results into planner tool calls and mark for skipping
        steps.forEach(s => {
            const trajId = s.trajectoryId || s.metadata?.sourceTrajectoryStepInfo?.trajectoryId;
            const toolCalls = s.plannerResponse?.toolCalls || s.metadata?.toolCall;
            if (toolCalls && Array.isArray(toolCalls)) {
                toolCalls.forEach((tc: any) => {
                    const key = `${trajId || ''}|${tc.executionId || ''}`;
                    const res = toolResults.get(key);
                    if (res) {
                        tc.output = res.output || res.response || res.result || res.toolOutput || res.tool_output;
                        res._mergedIntoPlanner = true;
                    }
                });
            } else if (toolCalls && typeof toolCalls === 'object') {
                const key = `${trajId || ''}|${toolCalls.executionId || ''}`;
                const res = toolResults.get(key);
                if (res) {
                    toolCalls.output = res.output || res.response || res.result || res.toolOutput || res.tool_output;
                    res._mergedIntoPlanner = true;
                }
            }
        });

        steps.forEach((step, index) => {
            if (step._mergedIntoPlanner) return;

            // Deduplicate: Skip steps we've already seen (by id)
            if (step.id && seenStepIds.has(step.id)) {
                return;
            }
            if (step.id) seenStepIds.add(step.id);

            // Deduplicate by Trajectory + Execution IDs (often occurs for redundant notification steps)
            const trajId = step.trajectoryId || step.metadata?.sourceTrajectoryStepInfo?.trajectoryId;
            const execId = step.executionId || step.metadata?.executionId || step.metadata?.sourceTrajectoryStepInfo?.executionId;
            if (trajId && execId) {
                const teKey = `${trajId}|${execId}|${step.type || ''}`;
                if (seenTrajExecs.has(teKey)) return;
                seenTrajExecs.add(teKey);
            }

            const content = this.extractStepText(step);

            // Deduplicate adjacent identical steps (content + type), ignoring timestamps/ids
            // This handles retries or duplicate records that have different IDs but same content
            const signature = `${step.type}|${content}`;
            if (signature === lastStepSignature && content.trim().length > 0) {
                return;
            }
            lastStepSignature = signature;

            const hasModelResponse = !!step.modelResponse;
            const details = this.parseStepDetails(step);

            // Thinking is only folded if it has actual 'thinking' field and NO principal model response
            const hasThoughts = !!(step.plannerResponse?.thinking || step.plannerResponse?.thought);
            const isThinking = hasThoughts && !hasModelResponse && !details.isUser;

            if (isThinking && content) {
                const stepTime = step.timestamp || step.header?.timestamp || step.metadata?.createdAt;
                if (!currentThinkingStartTime) {
                    currentThinkingStartTime = stepTime;
                }
                currentThinkingEndTime = stepTime;
                currentThinkingBlock.push(content);
                const usage = stepMetadata.get(index);
                if (usage) {
                    currentThinkingUsage.inputTokens += parseInt(usage.inputTokens) || 0;
                    currentThinkingUsage.outputTokens += parseInt(usage.outputTokens) || 0;
                    currentThinkingUsage.thinkingOutputTokens += parseInt(usage.thinkingOutputTokens) || 0;
                    currentThinkingUsage.cacheReadTokens += parseInt(usage.cacheReadTokens) || 0;
                    currentThinkingUsage.totalLatencyMs += usage.totalLatencyMs || step.metadata?.totalLatencyMs || 0;
                }
            } else {
                const hasAttachments = this.hasAttachments(step);
                const isSystemSignificant = step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE';

                // Strict filtering? No, we need to show errors even if extraction failed (we now have fallback),
                // and we should show "unknown" content rather than hiding it to avoid "missing history".
                const hasVisibleContent = content.trim() !== '' || hasAttachments || isSystemSignificant || details.isUser || (details.isModel && !isThinking);

                if (hasVisibleContent) {
                    if (currentThinkingBlock.length > 0) {
                        processedSteps.push({
                            type: 'THINKING_GROUP',
                            content: [...currentThinkingBlock],
                            isModel: true,
                            isError: details.isError,
                            sender: details.sender,
                            timestamp: currentThinkingStartTime || step.timestamp || step.header?.timestamp,
                            endTime: currentThinkingEndTime,
                            usage: { ...currentThinkingUsage }
                        });
                        currentThinkingBlock = [];
                        currentThinkingUsage = { inputTokens: 0, outputTokens: 0, thinkingOutputTokens: 0, cacheReadTokens: 0, totalLatencyMs: 0 };
                        currentThinkingStartTime = undefined;
                        currentThinkingEndTime = undefined;
                    }
                    processedSteps.push({ ...step, ...details, text: content, hasAttachments, stepIndex: index, usage: stepMetadata.get(index) });
                } else if (isThinking && content.trim()) {
                    const stepTime = step.timestamp || step.header?.timestamp || step.metadata?.createdAt;
                    if (!currentThinkingStartTime) {
                        currentThinkingStartTime = stepTime;
                    }
                    currentThinkingEndTime = stepTime;
                    currentThinkingBlock.push(content);
                    const usage = stepMetadata.get(index);
                    if (usage) {
                        currentThinkingUsage.inputTokens += parseInt(usage.inputTokens) || 0;
                        currentThinkingUsage.outputTokens += parseInt(usage.outputTokens) || 0;
                        currentThinkingUsage.thinkingOutputTokens += parseInt(usage.thinkingOutputTokens) || 0;
                        currentThinkingUsage.cacheReadTokens += parseInt(usage.cacheReadTokens) || 0;
                        currentThinkingUsage.totalLatencyMs += usage.totalLatencyMs || step.metadata?.totalLatencyMs || 0;
                    }
                }
            }
        });

        if (currentThinkingBlock.length > 0) {
            processedSteps.push({
                type: 'THINKING_GROUP',
                content: currentThinkingBlock,
                isModel: true,
                sender: lm.t('AI'),
                timestamp: currentThinkingStartTime || Date.now(), // Fallback for orphaned thinking
                endTime: currentThinkingEndTime,
                usage: { ...currentThinkingUsage }
            });
        }

        // Final consolidation of consecutive AI messages and CLEARED messages
        const finalSteps: any[] = [];
        let currentGroup: any[] = [];
        let lastSenderKey = '';

        processedSteps.forEach(step => {
            const text = step.text || '';
            const isCleared = text.includes('cleared-message') || step.type === 'CORTEX_STEP_TYPE_CLEARED' || step.status?.includes('CLEARED');
            const isThinking = step.type === 'THINKING_GROUP';

            // Generate a unique key for the sender turn
            // For AI and Machine Errors, we want to group them together
            const senderKey = step.sender + '|' + (step.isUser ? 'U' : (step.isModel || isThinking || step.isError) ? 'M' : 'S');

            if (isCleared && !isThinking) {
                if (currentGroup.length > 0) {
                    finalSteps.push({ type: 'GROUPED_MESSAGES', steps: [...currentGroup] });
                    currentGroup = [];
                }
                finalSteps.push({ ...step, isCleared: true });
            } else if (currentGroup.length > 0 && senderKey === lastSenderKey && !isCleared) {
                currentGroup.push(step);
            } else {
                if (currentGroup.length > 0) {
                    finalSteps.push({ type: 'GROUPED_MESSAGES', steps: [...currentGroup] });
                }
                currentGroup = [step];
                lastSenderKey = senderKey;
            }
        });
        if (currentGroup.length > 0) {
            finalSteps.push({ type: 'GROUPED_MESSAGES', steps: currentGroup });
        }

        // Second pass: Group CLEARED messages if they are consecutive
        const groupedSteps: any[] = [];
        let currentClearedGroup: any[] = [];

        finalSteps.forEach(step => {
            if (step.isCleared) {
                currentClearedGroup.push(step);
            } else {
                if (currentClearedGroup.length > 0) {
                    if (currentClearedGroup.length > 1) {
                        groupedSteps.push({ type: 'CLEARED_GROUP', steps: [...currentClearedGroup] });
                    } else {
                        groupedSteps.push(currentClearedGroup[0]);
                    }
                    currentClearedGroup = [];
                }
                groupedSteps.push(step);
            }
        });
        if (currentClearedGroup.length > 0) {
            if (currentClearedGroup.length > 1) {
                groupedSteps.push({ type: 'CLEARED_GROUP', steps: currentClearedGroup });
            } else {
                groupedSteps.push(currentClearedGroup[0]);
            }
        }

        const getStepTimestamp = (s: any) => {
            const first = s.steps ? s.steps[0] : s;
            const pt = first.timestamp || first.header?.timestamp || first.metadata?.createdAt || first.createdAt;
            if (!pt) return 0;
            return (typeof pt === 'number' && pt < 10000000000) ? pt * 1000 : new Date(pt).getTime();
        };

        const isUserStep = (s: any) => {
            const first = s.steps ? s.steps[0] : s;
            return !!(first.isUser || (first.type === 'CORTEX_STEP_TYPE_USER_INPUT') || (first.header?.sender === 'USER'));
        };

        const messagesHtml = groupedSteps.map((step, idx) => {
            const currentMs = getStepTimestamp(step);
            const prevStep = idx > 0 ? groupedSteps[idx - 1] : null;
            const isUser = isUserStep(step);

            let responseTimeHtml = '';
            // Show response time only for AI/System messages by comparing with the previous message
            if (!isUser && prevStep) {
                const prevMs = getStepTimestamp(prevStep);
                if (currentMs > 0 && prevMs > 0 && currentMs > prevMs) {
                    const diff = currentMs - prevMs;
                    // Cap it at 10 minutes (600,000 ms)
                    if (diff < 600000) {
                        responseTimeHtml = `<span class="response-time">${lm.t('Response time')}: ${formatDuration(diff)}</span>`;
                    }
                }
            }

            if (step.type === 'GROUPED_MESSAGES') {
                const groupSteps = step.steps;
                const first = groupSteps[0];
                const { isUser, isModel, isError, sender } = first;

                const totalUsage: any = { inputTokens: 0, outputTokens: 0, thinkingOutputTokens: 0, cacheReadTokens: 0 };
                const seenExecIds = new Set<string>();
                const seenGroupText = new Set<string>();
                let totalLatencyMs = 0;

                let timestampAttr = '';
                let timestampDisplay = '';
                const possibleTime = first.timestamp || first.header?.timestamp || first.metadata?.createdAt;
                if (possibleTime) {
                    const date = (typeof possibleTime === 'number') ? (possibleTime < 10000000000 ? new Date(possibleTime * 1000) : new Date(possibleTime)) : new Date(possibleTime);
                    if (!isNaN(date.getTime())) {
                        timestampDisplay = lm.formatDateTime(date);
                        timestampAttr = `title="${timestampDisplay}"`;
                    }
                }

                const contentHtml = groupSteps.map((s: any) => {
                    // Aggregate usage and latency at the start
                    if (s.usage) {
                        totalUsage.inputTokens = Math.max(totalUsage.inputTokens, parseInt(s.usage.inputTokens) || 0);
                        totalUsage.outputTokens = Math.max(totalUsage.outputTokens, parseInt(s.usage.outputTokens) || 0);
                        totalUsage.thinkingOutputTokens = Math.max(totalUsage.thinkingOutputTokens, parseInt(s.usage.thinkingOutputTokens) || 0);
                        totalUsage.cacheReadTokens = Math.max(totalUsage.cacheReadTokens, parseInt(s.usage.cacheReadTokens) || 0);
                        totalLatencyMs = Math.max(totalLatencyMs, s.usage.totalLatencyMs || s.metadata?.totalLatencyMs || 0);
                    }

                    if (s.type === 'THINKING_GROUP') {
                        const thoughtText = s.content.map((t: string) => {
                            const trimmedText = t.trim();
                            if (trimmedText) seenGroupText.add(trimmedText);
                            const rendered = this.md ? this.md.render(t) : t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                            return this.renderToolCalls(rendered, seenExecIds);
                        }).join('<hr style="border:0; border-top:1px dashed var(--vscode-widget-border); margin: 12px 0;">');

                        // Use latency from thinking group if available, fallback to duration between start/end
                        let latency = s.usage?.totalLatencyMs || s.metadata?.totalLatencyMs || 0;
                        if (latency === 0 && s.timestamp && s.endTime && s.endTime > s.timestamp) {
                            latency = s.endTime - s.timestamp;
                        }
                        const seconds = Math.round(latency / 1000);

                        // Extract start/end times for reasoning if available
                        let timeRange = '';
                        const possibleStart = s.timestamp || s.header?.timestamp || s.metadata?.createdAt || possibleTime;
                        if (possibleStart) {
                            const start = (typeof possibleStart === 'number') ? (possibleStart < 10000000000 ? new Date(possibleStart * 1000) : new Date(possibleStart)) : new Date(possibleStart);
                            if (!isNaN(start.getTime())) {
                                const end = new Date(start.getTime() + latency);
                                const fmt = (d: Date) => d.toLocaleTimeString(lm.getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                timeRange = `${fmt(start)} — ${fmt(end)}`;
                            }
                        }

                        // Token stats for thinking
                        const thoughtStats = s.usage ? this.renderTokenUsage(s.usage, latency) : '';

                        return `
                            <details class="thought-box ${s.isError ? 'error-style' : ''}">
                                <summary class="thought-header">
                                    <span class="thought-chevron">▶</span>
                                    <span>${seconds > 0 ? lm.t('Thought for {0}s', seconds) : lm.t('Thought')}</span>
                                    ${timeRange ? `<span class="thought-timer">${timeRange}</span>` : ''}
                                </summary>
                                <div class="thought-content markdown-body text" data-original="${thoughtText.replace(/"/g, '&quot;')}">
                                    ${thoughtText}
                                    ${thoughtStats}
                                </div>
                            </details>
                        `;
                    }

                    let stepRendered = '';
                    const cleanText = (s.text || '').trim();
                    if (cleanText) {
                        // Deduplicate: If this exact text was already shown in this group (e.g. in a thought block), skip it
                        if (Array.from(seenGroupText).some(t => t.includes(cleanText) || cleanText.includes(t) || (cleanText.length > 50 && t.includes(cleanText.substring(0, 50))))) return '';
                        seenGroupText.add(cleanText);

                        try {
                            stepRendered = this.md ? this.md.render(cleanText) : cleanText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                        } catch (e) {
                            stepRendered = cleanText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
                        }
                    }

                    // Post-process: Style model errors
                    if (stepRendered) {
                        stepRendered = this.formatModelError(stepRendered, s);
                    }

                    // Post-process: Style checklists
                    if (stepRendered.includes('<li>[ ]') || stepRendered.includes('<li>[x]')) {
                        stepRendered = stepRendered.replace(/<ul>\s*<li>\[[ x]\][\s\S]*?<\/ul>/g, (match) => {
                            const items = match.match(/<li>\[([ x])\] (.*?)<\/li>/g) || [];
                            const listHtml = items.map(item => {
                                const done = item.includes('[x]');
                                const content = item.replace(/<li>\[[ x]\] (.*?)<\/li>/, '$1');
                                return `<li><div class="task-check ${done ? 'done' : ''}"></div><span>${content}</span></li>`;
                            }).join('');
                            return `<div class="progress-updates"><div class="progress-header"><span>${lm.t('Progress Updates')}</span></div><ul>${listHtml}</ul></div>`;
                        });
                    }

                    // Post-process: File badges
                    stepRendered = stepRendered.replace(/`([^`\s]+\.[a-z]{1,5})`/g, (match, pathStr) => {
                        const iconSvg = getFileIconSvg(pathStr);
                        return `<span class="file-badge"><span class="icon">${iconSvg}</span><span class="path">${pathStr}</span><span class="open-btn" onclick="openFile('${pathStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">${lm.t('Open')}</span></span>`;
                    });

                    // Post-process: Tool Calls
                    stepRendered = this.renderToolCalls(stepRendered, seenExecIds);

                    const attachments = this.renderAttachments(s);


                    if (!stepRendered.trim() && !attachments.trim()) return '';

                    return `<div class="step-content">
                                ${stepRendered}
                                ${attachments}
                            </div>`;
                }).join('');

                return `
                    <div class="message ${isUser ? 'user' : isError ? 'error-msg' : isModel ? 'ai' : ''}" ${timestampAttr}>
                        <div class="avatar">${isUser ? '👤' : isError ? '⚠️' : isModel ? '🤖' : '⚙️'}</div>
                        <div class="content">
                            <div class="sender">
                                <span class="sender-name">${sender}</span>
                                ${responseTimeHtml}
                                <div class="timestamp-wrapper">
                                    <span class="timestamp">${timestampDisplay}</span>
                                </div>
                            </div>
                            <div class="text-box">
                                <div class="text markdown-body">
                                    ${contentHtml}
                                </div>
                                <div class="box-footer">
                                    <div class="usage-footer">${this.renderTokenUsage(totalUsage, totalLatencyMs)}</div>
                                    <button class="toggle-mode-btn" onclick="toggleMode(this)" style="font-size: 10px; opacity: 0.5;">${lm.t('JSON')}</button>
                                </div>
                                <div class="json-box" style="display:none;">
                                    <div class="json-search-bar">
                                        <input type="text" class="json-search-input" placeholder="${lm.t('Search in JSON...')}" style="flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 2px 6px; font-size: 11px;" onkeyup="if(event.key==='Enter') navigateJsonSearch(this, event.shiftKey); else filterJson(this)">
                                        <span class="json-search-count" style="font-size: 10px; opacity: 0.6; min-width: 30px; text-align: center;"></span>
                                        <button class="search-btn" title="${lm.t('Previous (Shift+Enter)')}" style="padding: 2px; font-size: 10px;" onclick="navigateJsonSearch(this.previousElementSibling.previousElementSibling, true)">⬆️</button>
                                        <button class="search-btn" title="${lm.t('Next (Enter)')}" style="padding: 2px; font-size: 10px;" onclick="navigateJsonSearch(this.previousElementSibling.previousElementSibling.previousElementSibling, false)">⬇️</button>
                                    </div>
                                    <pre style="display:none;">${JSON.stringify(groupSteps).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                                    <div class="json-container"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }

            if (step.type === 'CLEARED_GROUP') {
                const groupSteps = step.steps;
                const aiCount = groupSteps.filter((s: any) => s.isModel).length;
                const userCount = groupSteps.filter((s: any) => s.isUser).length;
                const errorCount = groupSteps.filter((s: any) => s.isError).length;

                const startStep = groupSteps[0];
                const endStep = groupSteps[groupSteps.length - 1];

                const startTime = startStep.metadata?.createdAt || startStep.createdAt || '';
                const endTime = endStep.metadata?.createdAt || endStep.createdAt || '';

                let timeRange = '';
                if (startTime && endTime) {
                    const d1 = new Date(startTime);
                    const d2 = new Date(endTime);
                    if (d1.toLocaleDateString() === d2.toLocaleDateString()) {
                        timeRange = `${lm.formatDate(d1)} ${lm.formatDateTime(d1).split(', ')[1]} - ${lm.formatDateTime(d2).split(', ')[1]}`;
                    } else {
                        timeRange = `${lm.formatDateTime(d1)} - ${lm.formatDateTime(d2)}`;
                    }
                } else if (startTime) {
                    timeRange = lm.formatDateTime(new Date(startTime));
                }

                // Aggregate usage
                const totalUsage: any = { inputTokens: 0, outputTokens: 0, thinkingOutputTokens: 0, cacheReadTokens: 0 };
                groupSteps.forEach((s: any) => {
                    const u = s.usage;
                    if (u) {
                        totalUsage.inputTokens += parseInt(u.inputTokens) || 0;
                        totalUsage.outputTokens += parseInt(u.outputTokens) || 0;
                        totalUsage.thinkingOutputTokens += parseInt(u.thinkingOutputTokens) || 0;
                        totalUsage.cacheReadTokens += parseInt(u.cacheReadTokens) || 0;
                    }
                });

                return `
                    <div class="message cleared-group">
                        <div class="avatar">📦</div>
                        <div class="content">
                            <div class="sender">
                                <span class="sender-name">${lm.t('Cleared History')}</span>
                                ${responseTimeHtml}
                                <div class="timestamp-wrapper">
                                    <span class="timestamp">${timeRange}</span>
                                </div>
                            </div>
                            <div class="text-box">
                                <div class="text compact-summary">
                                    <div class="summary-line">
                                        ${aiCount > 0 ? `<span>🤖 <b>${aiCount}</b> ${lm.t('AI Messages')}</span>` : ''}
                                        ${userCount > 0 ? `<span>👤 <b>${userCount}</b> ${lm.t('User Messages')}</span>` : ''}
                                        ${errorCount > 0 ? `<span>⚠️ <b>${errorCount}</b> ${lm.t('Errors')}</span>` : ''}
                                    </div>
                                    <div class="cleared-message group-sub">${lm.t('Detailed content of these messages has been cleared or archived.')}</div>
                                </div>
                                <div class="box-footer">
                                    ${this.renderTokenUsage(totalUsage)}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }

        }).join('');

        const styleVars = `
            body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-editor-font-size); padding: 10px; margin: 0; padding-top: 54px; scroll-behavior: smooth; }
            ::-webkit-scrollbar { width: 10px; }
            ::-webkit-scrollbar-track { background: transparent; }
            ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 10px; border: 3px solid var(--vscode-editor-background); }
            ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

            .message { display: flex; gap: 12px; margin-bottom: 24px; animation: fadeIn 0.15s ease-out; max-width: 100%; align-items: flex-start; }
            .avatar { min-width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 14px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 6px; flex-shrink: 0; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
            .message.user .avatar { background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); }
            .message.ai .avatar { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
            .message.error-msg .avatar { background: var(--vscode-errorForeground); color: #fff; }
            
            .content { flex: 1; min-width: 0; }
            .sender { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.9em; }
            .sender-name { font-weight: 700; opacity: 0.9; }
            .response-time { font-size: 0.85em; opacity: 0.5; font-weight: 400; margin-left: 8px; }
            .cleared-message { font-style: italic; opacity: 0.6; }
            .cleared-message.group-sub { font-size: 0.9em; margin-top: 8px; }
            .compact-summary { opacity: 0.9; }
            .summary-line { display: flex; gap: 16px; flex-wrap: wrap; }
            .summary-line span { display: flex; align-items: center; gap: 6px; }
            .message.cleared-group { margin-bottom: 20px; opacity: 0.8; transition: opacity 0.2s; }
            .message.cleared-group:hover { opacity: 1; }
            .message.cleared-group .text-box { background: rgba(127,127,127,0.03); border: 1px dashed rgba(127,127,127,0.2); }
            .timestamp-wrapper { display: flex; align-items: center; gap: 8px; opacity: 0.5; font-size: 0.82em; margin-left: auto; }
            .date-label { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 1px 8px; border-radius: 4px; font-weight: 700; font-size: 0.85em; }
            .timestamp { white-space: nowrap; }
            
            .text-box { background: var(--vscode-editor-lineHighlightBackground); padding: 14px 16px; border-radius: 12px; border: 1px solid var(--vscode-widget-border); box-shadow: 0 4px 12px rgba(0,0,0,0.1); backdrop-filter: blur(4px); transition: border-color 0.2s; position: relative; max-width: 100%; box-sizing: border-box; overflow: hidden; }
            .message.user .text-box { background: rgba(255,255,255,0.02); border-color: rgba(255,255,255,0.05); }
            .message.error-msg .text-box { background: rgba(255, 0, 0, 0.04); border-color: rgba(255, 0, 0, 0.2); }
            .message:hover .text-box { border-color: var(--vscode-focusBorder); }

            .text { word-break: break-word; overflow-wrap: break-word; }
            .markdown-body { font-size: 1.05em; line-height: 1.6; }
            .markdown-body p:last-child { margin-bottom: 0; }
            .markdown-body pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-widget-border); padding: 12px; border-radius: 8px; overflow-x: auto; margin: 12px 0; max-width: 100%; box-sizing: border-box; }
            .markdown-body code { font-family: var(--vscode-editor-font-family); background: rgba(127,127,127,0.1); padding: 2px 4px; border-radius: 4px; border: 1px solid rgba(127,127,127,0.2); word-break: break-all; overflow-wrap: anywhere; }

            .thought-box { margin-bottom: 16px; border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; background: rgba(255,255,255,0.01); }
            .thought-box.error-style { border-color: rgba(255, 0, 0, 0.3); background: rgba(255, 0, 0, 0.02); }
            .thought-header { padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 0.9em; opacity: 0.7; user-select: none; transition: background 0.2s; }
            .thought-header:hover { background: rgba(255,255,255,0.03); opacity: 1; }
            .thought-timer { margin-left: auto; font-family: monospace; font-size: 0.85em; opacity: 0.5; }
            .thought-chevron { transition: transform 0.2s; font-size: 10px; }
            .thought-box[open] .thought-chevron { transform: rotate(90deg); }
            .thought-content { padding: 12px; border-top: 1px solid var(--vscode-widget-border); font-style: italic; color: var(--vscode-descriptionForeground); font-size: 0.95em; }
            .thought-stats { display: flex; gap: 12px; margin-top: 12px; font-size: 0.85em; opacity: 0.6; font-style: normal; border-top: 1px dashed rgba(127,127,127,0.1); padding-top: 8px; }
            .thought-stats span { display: flex; align-items: center; gap: 4px; }

            .progress-updates { background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 16px; margin: 12px 0; }
            .progress-header { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.5; margin-bottom: 12px; display: flex; justify-content: space-between; }
            .progress-updates ul { list-style: none; padding: 0; margin: 0; }
            .progress-updates li { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 0.95em; }
            .progress-updates li:last-child { margin-bottom: 0; }
            .task-check { width: 14px; height: 14px; border: 1px solid var(--vscode-checkbox-border); border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; }
            .task-check.done { background: var(--vscode-checkbox-background); border-color: var(--vscode-checkbox-background); color: var(--vscode-checkbox-foreground); }
            .task-check.done::after { content: '✓'; }

            .file-badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(127,127,127,0.1); border: 1px solid rgba(127,127,127,0.2); padding: 2px 8px; border-radius: 12px; font-size: 0.9em; margin: 2px 4px; vertical-align: middle; }
            .file-badge .icon { font-size: 14px; display: flex; align-items: center; width: 14px; height: 14px; }
            .file-badge .icon svg { width: 100%; height: 100%; }
            .file-badge .open-btn { cursor: pointer; color: var(--vscode-textLink-foreground); opacity: 0.7; font-size: 11px; margin-left: 4px; }
            .file-badge .open-btn:hover { text-decoration: underline; opacity: 1; }
            .file-badge.missing { opacity: 0.65; border-style: dotted; filter: grayscale(0.5); }
            .file-badge.missing .path { text-decoration: line-through; opacity: 0.8; }

            .attachment-preview { margin-top: 12px; display: flex; gap: 12px; flex-wrap: wrap; }
            .attachment-item { border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; background: rgba(0,0,0,0.3); transition: transform 0.2s, background 0.2s; max-width: 240px; position: relative; min-width: 120px; min-height: 120px; display: flex; align-items: center; justify-content: center; padding-bottom: 30px; }
            .attachment-item:hover { transform: scale(1.02); border-color: var(--vscode-focusBorder); }
            .attachment-item.file-button { display: flex; align-items: center; gap: 8px; padding: 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-button-secondaryBorder); padding-bottom: 34px; justify-content: flex-start; min-height: 48px; }
            .attachment-item.file-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
            .attachment-icon { width: 24px; height: 24px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
            .attachment-icon svg { width: 100%; height: 100%; display: block; }
            .attachment-item img { display: block; width: 100%; height: auto; max-height: 200px; cursor: pointer; object-fit: contain; }
            .attachment-label { position: absolute; bottom: 0; left: 0; right: 0; padding: 6px 10px; font-size: 0.85em; background: rgba(10, 10, 10, 0.45); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-top: 1px solid rgba(255,255,255,0.07); display: flex; align-items: center; gap: 8px; justify-content: space-between; overflow: hidden; z-index: 5; }
            .attachment-label .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; opacity: 0.95; }
            .attachment-item.file-button .attachment-label { border-top: 1px solid rgba(255,255,255,0.05); }
            .copy-btn.mini { padding: 2px; font-size: 10px; opacity: 0.4; }
            .copy-btn.mini:hover { opacity: 1; background: rgba(255,255,255,0.1); }
            
            .task-boundary-info { margin: 8px 0 12px 0; border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 12px; }
            .task-name-header { font-size: 1.1em; color: var(--vscode-textLink-foreground); margin-bottom: 8px; }
            .command-info { margin: 8px 0; padding: 10px; background: rgba(127,127,127,0.05); border-radius: 6px; border: 1px solid rgba(127,127,127,0.1); }
            .command-desc { font-style: italic; opacity: 0.8; margin-bottom: 6px; font-size: 0.95em; }
            .command-line { font-family: var(--vscode-editor-font-family); color: var(--vscode-symbolIcon-methodForeground); display: flex; align-items: center; gap: 8px; }

            #search-container { position: fixed; top: 0; left: 0; right: 0; height: 44px; background: rgba(30, 30, 30, 0.82); backdrop-filter: blur(12px); border-bottom: 1px solid var(--vscode-widget-border); display: flex; align-items: center; padding: 0 16px; z-index: 100; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
            #search-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px 10px; margin-right: 10px; border-radius: 4px; flex: 1; outline: none; font-size: 13px; }
            .search-btn { background: transparent; border: none; color: var(--vscode-icon-foreground); cursor: pointer; padding: 4px; margin-left: 2px; border-radius: 4px; transition: background 0.2s; }
            .search-btn:hover { background: rgba(255,255,255,0.08); }

            .search-filters { display: flex; align-items: center; gap: 10px; margin-left: 14px; padding-left: 14px; border-left: 1px solid rgba(127,127,127,0.2); height: 24px; }
            .filter-item { display: flex; align-items: center; gap: 4px; font-size: 11px; opacity: 0.75; cursor: pointer; user-select: none; transition: opacity 0.2s; white-space: nowrap; }
            .filter-item:hover { opacity: 1; }
            .filter-item input { margin: 0; cursor: pointer; width: 12px; height: 12px; }
            .filter-label { font-weight: 500; }

            #lightbox { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); display: none; justify-content: center; align-items: center; z-index: 2000; cursor: zoom-out; }
            #lightbox img { max-width: 95%; max-height: 95%; box-shadow: 0 0 30px rgba(0,0,0,0.5); object-fit: contain; }

            .token-usage { display: flex; gap: 8px; flex-wrap: wrap; font-size: 0.8em; opacity: 0.8; }
            .token-badge { background: rgba(127,127,127,0.1); border: 1px solid rgba(127,127,127,0.2); padding: 2px 8px; border-radius: 6px; display: flex; align-items: center; gap: 4px; }
            .token-badge.thinking { border-color: rgba(255, 165, 0, 0.3); color: orange; font-weight: bold; }
            .token-badge.total { border-color: var(--vscode-textLink-foreground); background: rgba(0, 122, 204, 0.1); }
            .token-icon { font-size: 10px; }

            .file-badge.mini { margin-left: auto; padding: 2px 8px; font-size: 0.85em; cursor: pointer; border-radius: 6px; }
            .file-badge.mini .open-btn { display: none; }
            .file-badge.mini:hover { background: var(--vscode-button-hoverBackground); border-color: var(--vscode-focusBorder); }
            .file-badge.directory { border-style: dashed; background: rgba(255, 165, 0, 0.05); }
            .file-badge.directory .icon { color: orange; }

            .copy-btn { background: transparent; border: none; color: var(--vscode-icon-foreground); cursor: pointer; padding: 2px 4px; border-radius: 4px; opacity: 0.5; transition: opacity 0.2s, background 0.2s; font-size: 12px; margin-left: 4px; vertical-align: middle; }
            .copy-btn:hover { opacity: 1; background: rgba(127,127,127,0.2); }
            .copy-btn:active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

            .diff-container { margin: 8px 0; border: 1px solid var(--vscode-widget-border); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
            .diff-header { background: var(--vscode-sideBar-headerBackground); color: var(--vscode-foreground); padding: 6px 12px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none; font-weight: 600; }
            .diff-header:hover { background: var(--vscode-list-hoverBackground); }
            .diff-header::before { content: '▼'; font-size: 8px; transition: transform 0.2s; opacity: 0.5; margin-right: 8px; }
            .diff-header.collapsed::before { transform: rotate(-90deg); }
            .diff-icon { width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .diff-icon svg { width: 100%; height: 100%; }
            .diff-header .icon { font-size: 14px; }
            .font-controls { display: flex; gap: 4px; margin-left: 12px; align-items: center; }
            .font-btn { background: rgba(127,127,127,0.1); border: 1px solid rgba(127,127,127,0.2); border-radius: 4px; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.2s, border-color 0.2s; font-size: 12px; line-height: 1; color: var(--vscode-foreground); opacity: 0.7; }
            .font-btn:hover { background: rgba(127,127,127,0.3); border-color: var(--vscode-focusBorder); opacity: 1; }
            .diff-header .stats { margin-left: auto; opacity: 0.6; font-size: 0.85em; font-weight: normal; }

            .diff-block { border-top: 1px solid var(--vscode-widget-border); padding: 8px 0; max-height: 500px; overflow-y: auto; overflow-x: auto; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.4; transition: max-height 0.3s ease-in-out; }
            .diff-block.collapsed { max-height: 0; padding: 0; border: none; }
            .diff-lines-wrapper { display: inline-block; min-width: 100%; vertical-align: top; }
            
            .diff-line { display: flex; white-space: pre; font-family: var(--vscode-editor-font-family); font-size: 0.9em; padding: 0 12px; min-height: 1.4em; position: relative; }
            .diff-line:hover { background: rgba(127, 127, 127, 0.05); }
            .diff-line .line-num { display: inline-block; width: 35px; text-align: right; margin-right: 12px; opacity: 0.4; font-family: var(--vscode-editor-font-family); user-select: none; flex-shrink: 0; }
            .diff-line.diff-del { background: rgba(255, 0, 0, 0.15); border-left: 2px solid #f85149; }
            .diff-line.diff-add { background: rgba(0, 255, 0, 0.08); border-left: 2px solid #3fb950; }
            .chunk-header { background: var(--vscode-editor-lineHighlightBackground); padding: 4px 12px; font-weight: bold; opacity: 0.6; border-bottom: 1px solid var(--vscode-widget-border); font-size: 11px; color: var(--vscode-descriptionForeground); }

            .tool-call { display: flex; align-items: center; gap: 8px; background: var(--vscode-editor-lineHighlightBackground); border: 1px solid var(--vscode-widget-border); padding: 6px 12px; border-radius: 8px; margin: 8px 0; font-family: var(--vscode-editor-font-family); font-size: 0.9em; box-shadow: 0 2px 4px rgba(0,0,0,0.1); flex-wrap: wrap; }
            .tool-query-badge { background: rgba(127, 127, 127, 0.15); border: 1px solid rgba(127, 127, 127, 0.25); padding: 2px 8px; border-radius: 6px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; opacity: 0.9; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; transition: background 0.2s, border-color 0.2s; }
            .tool-query-badge:hover { background: var(--vscode-button-hoverBackground); border-color: var(--vscode-focusBorder); opacity: 1; }
            .tool-query-badge:active { background: var(--vscode-button-background); }
            .tool-icon { font-size: 14px; opacity: 0.8; }
            .tool-label { opacity: 0.6; font-weight: 400; }
            .tool-name { font-weight: 700; color: var(--vscode-textLink-foreground); }
            .tool-args-btn { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: none; font-size: 10px; padding: 2px 6px; border-radius: 4px; cursor: pointer; opacity: 0.7; margin-left: auto; transition: opacity 0.2s; }
            .tool-args-btn:hover { opacity: 1; }
            .tool-args-box { display: none; margin: 4px 0 12px 40px; background: rgba(0,0,0,0.2); border: 1px solid rgba(127,127,127,0.2); border-radius: 6px; padding: 8px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; overflow-x: auto; }
            .tool-args-box.visible { display: block; animation: fadeIn 0.2s ease-out; }

            .highlight { background-color: var(--vscode-editor-findMatchHighlightBackground); color: inherit; border-radius: 2px; }
            .highlight.active { background-color: var(--vscode-editor-findMatchBackground); color: var(--vscode-editor-findMatchForeground); outline: 1px solid var(--vscode-focusBorder); z-index: 1; position: relative; }

            .json-highlight { background-color: var(--vscode-editor-findMatchHighlightBackground); color: inherit; border-radius: 2px; }
            .json-highlight.active { background-color: var(--vscode-editor-findMatchBackground); color: var(--vscode-editor-findMatchForeground); outline: 1px solid var(--vscode-focusBorder); z-index: 1; position: relative; }

            .task-summary-box { border-left: 3px solid var(--vscode-textLink-foreground); background: rgba(127, 127, 127, 0.05); padding: 8px 12px; margin: 8px 0 8px 10px; font-style: italic; opacity: 0.9; border-radius: 0 4px 4px 0; font-size: 0.95em; }

            .box-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; position: relative; border-top: 1px solid rgba(127,127,127,0.1); padding-top: 8px; }
            .toggle-mode-btn { background: transparent; border: 1px solid rgba(127,127,127,0.2); color: var(--vscode-textLink-foreground); font-size: 10px; padding: 2px 6px; border-radius: 4px; cursor: pointer; opacity: 0.5; transition: all 0.2s; font-family: var(--vscode-editor-font-family); margin-left: auto; }
            .toggle-mode-btn:hover { opacity: 1; border-color: var(--vscode-textLink-foreground); background: rgba(127,127,127,0.05); }
            
            .json-box { background: rgba(0,0,0,0.1); border-radius: 6px; padding: 12px; margin-top: 8px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; overflow: auto; max-height: 500px; position: relative; }
            .json-search-bar { position: sticky; top: -12px; z-index: 10; background: var(--vscode-editor-lineHighlightBackground); margin: -12px -12px 8px -12px; padding: 12px 12px 8px 12px; border-bottom: 1px solid rgba(127,127,127,0.1); display: flex; align-items: center; gap: 4px; backdrop-filter: blur(4px); }
            .json-box pre { margin: 0; white-space: pre-wrap; word-break: break-all; color: var(--vscode-editor-foreground); opacity: 0.6; }
            
            .json-tree { font-family: var(--vscode-editor-font-family); line-height: 1.5; color: var(--vscode-editor-foreground); }
            .json-node { position: relative; padding-left: 20px; white-space: nowrap; }
            .json-collapsible > .json-toggle { position: absolute; left: 4px; cursor: pointer; opacity: 0.4; transition: transform 0.2s; user-select: none; font-size: 10px; width: 12px; text-align: center; }
            .json-collapsible > .json-toggle:hover { opacity: 1; color: var(--vscode-textLink-foreground); }
            .json-toggle.collapsed { transform: rotate(-90deg); }
            .json-content.collapsed { display: none; }
            
            .json-key { color: #9cdcfe; } /* VS Code Blue */
            .json-string { color: #ce9178; white-space: pre-wrap; word-break: break-all; } /* VS Code Orange */
            .json-number { color: #b5cea8; } /* VS Code Green */
            .json-boolean, .json-null { color: #569cd6; } /* VS Code Dark Blue */
            .json-brace, .json-comma, .json-sep { opacity: 0.5; }
            .json-footer { padding-left: 20px; }

            @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        `;

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <style>${styleVars}</style>
            </head>
            <body>
                <div id="search-container">
                    <span style="font-size: 14px; margin-right: 8px; opacity: 0.6;">🔍</span>
                    <input type="text" id="search-input" placeholder="${lm.t('Search in chat...')}" onkeydown="if(event.key==='Enter') findNext(event.shiftKey)">
                    <button class="search-btn" title="${lm.t('Previous (Shift+Enter)')}" onclick="findNext(true)">⬆️</button>
                    <button class="search-btn" title="${lm.t('Next (Enter)')}" onclick="findNext(false)">⬇️</button>
                    <span id="search-count" style="margin-left:8px; font-size:0.8em; opacity:0.6; min-width: 50px;"></span>

                    <div class="search-filters">
                        <label class="filter-item">
                            <input type="checkbox" checked onchange="applyFilters()" data-type="ai">
                            <span class="filter-label">🤖 ${lm.t('AI')}</span>
                        </label>
                        <label class="filter-item">
                            <input type="checkbox" checked onchange="applyFilters()" data-type="user">
                            <span class="filter-label">👤 ${lm.t('User')}</span>
                        </label>
                        <label class="filter-item">
                            <input type="checkbox" checked onchange="applyFilters()" data-type="error-msg">
                            <span class="filter-label">⚠️ ${lm.t('Error')}</span>
                        </label>
                        <label class="filter-item">
                            <input type="checkbox" checked onchange="applyFilters()" data-type="other">
                            <span class="filter-label">⚙️ ${lm.t('Other')}</span>
                        </label>
                    </div>
                </div>

                <div id="chat-container">
                    ${messagesHtml}
                </div>

                <div id="lightbox" onclick="this.style.display='none'">
                    <img id="lightbox-img" src="">
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let currentMatchIndex = -1;
                    let matches = [];

                    function findNext(reverse) {
                        const query = document.getElementById('search-input').value.toLowerCase();
                        if (!query) return clearSearch();

                        if (!matches.length || matches[0].query !== query) {
                            performSearch(query);
                        }

                        if (matches.length === 0) return;

                        if (reverse) {
                            currentMatchIndex = (currentMatchIndex - 1 + matches.length) % matches.length;
                        } else {
                            currentMatchIndex = (currentMatchIndex + 1) % matches.length;
                        }
                        
                        updateHighlight();
                    }

                    function performSearch(query) {
                        clearHighlights();
                        matches = [];
                        currentMatchIndex = -1;

                        if (!query) return;

                        const textDivs = Array.from(document.querySelectorAll('.text, .json-box pre, .diff-line'))
                                              .filter(div => {
                                                  const msg = div.closest('.message');
                                                  return msg && msg.style.display !== 'none';
                                              });
                        
                        textDivs.forEach((div) => {
                            if (!div.getAttribute('data-original')) {
                                div.setAttribute('data-original', div.innerHTML);
                            }
                            highlightText(div, query);
                        });
                        
                        const highlights = document.querySelectorAll('.highlight');
                        highlights.forEach((el) => {
                            matches.push({ element: el, query: query });
                        });
                        
                        if (matches.length > 0) {
                            currentMatchIndex = 0;
                            updateHighlight();
                        } else {
                            document.getElementById('search-count').textContent = '${lm.t('No results')}';
                        }
                    }

                    function highlightText(node, query) {
                        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
                        let textNode;
                        const nodesToReplace = [];
                        
                        while (textNode = walker.nextNode()) {
                            const text = textNode.nodeValue;
                            const lowerText = text.toLowerCase();
                            const lowerQuery = query.toLowerCase();
                            
                            if (lowerText.includes(lowerQuery)) {
                                nodesToReplace.push(textNode);
                            }
                        }
                        
                        nodesToReplace.forEach(textNode => {
                            const parent = textNode.parentNode;
                            const text = textNode.nodeValue;
                            const parts = text.split(new RegExp('('+escapeRegExp(query)+')', 'gi'));
                            
                            const fragment = document.createDocumentFragment();
                            parts.forEach(part => {
                                if (part.toLowerCase() === query.toLowerCase()) {
                                    const span = document.createElement('span');
                                    span.className = 'highlight';
                                    span.textContent = part;
                                    fragment.appendChild(span);
                                } else if (part !== "") {
                                    fragment.appendChild(document.createTextNode(part));
                                }
                            });
                            parent.replaceChild(fragment, textNode);
                        });
                    }

                    function escapeRegExp(string) {
                        return string.replace(/[.*+?^\${}()|[\\x5D\\\\]/g, '\\\\$&'); 
                    }

                    function updateHighlight() {
                        document.querySelectorAll('.highlight.active').forEach(el => el.classList.remove('active'));
                        
                        const match = matches[currentMatchIndex];
                        if (match) {
                            match.element.classList.add('active');
                            match.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            
                            let parent = match.element.closest('details');
                            if (parent) parent.open = true;

                            let jsonBox = match.element.closest('.json-box');
                            if (jsonBox) {
                                if (jsonBox.style.display === 'none') {
                                    const textBox = jsonBox.closest('.text-box');
                                    if (textBox) {
                                        const text = textBox.querySelector('.text');
                                        const btn = textBox.querySelector('.toggle-mode-btn');
                                        jsonBox.style.display = 'block';
                                        if (text) text.style.display = 'none';
                                        if (btn) btn.textContent = '${lm.t('TEXT')}';
                                    }
                                }
                                // Ensure it's rendered if we have a match inside (even if it was already visible)
                                if (!jsonBox.classList.contains('rendered')) {
                                    const raw = jsonBox.querySelector('pre');
                                    if (raw) {
                                        const data = JSON.parse(raw.textContent);
                                        renderJson(jsonBox.querySelector('.json-container'), data);
                                        jsonBox.classList.add('rendered');
                                    }
                                }
                            }

                            let diffBlock = match.element.closest('.diff-block');
                            if (diffBlock && diffBlock.classList.contains('collapsed')) {
                                const container = diffBlock.closest('.diff-container');
                                if (container) {
                                    const header = container.querySelector('.diff-header');
                                    if (header) header.classList.remove('collapsed');
                                    diffBlock.classList.remove('collapsed');
                                }
                            }

                            document.getElementById('search-count').textContent = (currentMatchIndex + 1) + '/' + matches.length;
                        }
                    }

                    function clearSearch() {
                         clearHighlights();
                         matches = [];
                         currentMatchIndex = -1;
                         document.getElementById('search-count').textContent = '';
                    }

                    function clearHighlights() {
                        document.querySelectorAll('.text, .json-box pre, .diff-line').forEach(div => {
                             if (div.getAttribute('data-original')) {
                                 div.innerHTML = div.getAttribute('data-original');
                             }
                        });
                    }

                    function applyFilters() {
                        const ai = document.querySelector('input[data-type="ai"]').checked;
                        const user = document.querySelector('input[data-type="user"]').checked;
                        const error = document.querySelector('input[data-type="error-msg"]').checked;
                        const other = document.querySelector('input[data-type="other"]').checked;

                        document.querySelectorAll('.message').forEach(msg => {
                            let visible = false;
                            if (msg.classList.contains('ai')) visible = ai;
                            else if (msg.classList.contains('user')) visible = user;
                            else if (msg.classList.contains('error-msg')) visible = error;
                            else visible = other;
                            
                            msg.style.display = visible ? 'flex' : 'none';
                        });
                        
                        // Re-run search if active to update results count and positions
                        const query = document.getElementById('search-input').value;
                        if (query) {
                            performSearch(query);
                        }
                    }

                    function toggleArgs(id) {
                        const box = document.getElementById(id);
                        if (box) {
                            box.classList.toggle('visible');
                            if (box.classList.contains('visible')) {
                                box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            }
                        }
                    }

                    function changeFontSize(btn, delta) {
                        const container = btn.closest('.diff-container');
                        const block = container.querySelector('.diff-block');
                        let currentSize = parseInt(window.getComputedStyle(block).fontSize);
                        if (isNaN(currentSize)) currentSize = 12;
                        const newSize = Math.max(8, Math.min(32, currentSize + delta));
                        block.style.fontSize = newSize + 'px';
                        
                        const zoomLabel = container.querySelector('.zoom-level');
                        if (zoomLabel) {
                            zoomLabel.textContent = (newSize / 12).toFixed(1) + 'x';
                        }
                    }

                    function toggleDiff(header) {
                        header.classList.toggle('collapsed');
                        const block = header.nextElementSibling;
                        if (block) {
                            block.classList.toggle('collapsed');
                        }
                    }

                    function openFile(path) {
                        vscode.postMessage({
                            command: 'openFile',
                            path: path
                        });
                    }

                    function copyToClipboard(text, btn) {
                        navigator.clipboard.writeText(text).then(() => {
                            const original = btn.innerHTML;
                            btn.innerHTML = '✅';
                            setTimeout(() => { btn.innerHTML = original; }, 2000);
                        });
                    }

                    function showImage(src) {
                        const lightbox = document.getElementById('lightbox');
                        const img = document.getElementById('lightbox-img');
                        img.src = src;
                        lightbox.style.display = 'flex';
                        
                        vscode.postMessage({
                            command: 'viewImage',
                            src: src
                        });
                    }

                    function toggleMode(btn) {
                        const textBox = btn.closest('.text-box');
                        const text = textBox.querySelector('.text');
                        const json = textBox.querySelector('.json-box');
                        const isJson = json.style.display !== 'none';

                        if (isJson) {
                            json.style.display = 'none';
                            text.style.display = 'block';
                            btn.textContent = '${lm.t('JSON')}';
                        } else {
                            if (!json.classList.contains('rendered')) {
                                const raw = json.querySelector('pre');
                                if (raw) {
                                    try {
                                        const data = JSON.parse(raw.textContent);
                                        renderJson(json.querySelector('.json-container'), data);
                                        json.classList.add('rendered');
                                    } catch (e) {
                                        console.error('Failed to render JSON:', e);
                                        raw.style.display = 'block'; // Fallback to raw pre
                                    }
                                }
                            }
                            json.style.display = 'block';
                            text.style.display = 'none';
                            btn.textContent = '${lm.t('TEXT')}';
                        }
                    }

                    function renderJson(container, data) {
                        container.innerHTML = '';
                        const tree = document.createElement('div');
                        tree.className = 'json-tree';
                        tree.appendChild(createJsonNode(null, data, true));
                        container.appendChild(tree);
                    }

                    function createJsonNode(key, val, isLast) {
                        const node = document.createElement('div');
                        node.className = 'json-node';
                        
                        const isObject = val !== null && typeof val === 'object';
                        const isArray = Array.isArray(val);
                        
                        let header = document.createElement('span');
                        header.className = 'json-header';
                        
                        if (key !== null) {
                            header.innerHTML = '<span class="json-key">"' + key + '"</span><span class="json-sep">: </span>';
                        }
                        
                        if (isObject) {
                            const badge = isArray ? '[' : '{';
                            const closeBadge = isArray ? ']' : '}';
                            const keys = Object.keys(val);
                            
                            node.classList.add('json-collapsible');
                            const toggle = document.createElement('span');
                            toggle.className = 'json-toggle';
                            toggle.textContent = '▼';
                            node.appendChild(toggle);
                            node.appendChild(header);
                            
                            const braceOpen = document.createElement('span');
                            braceOpen.className = 'json-brace';
                            braceOpen.textContent = badge;
                            node.appendChild(braceOpen);
                            
                            const content = document.createElement('div');
                            content.className = 'json-content';
                            keys.forEach((k, i) => {
                                content.appendChild(createJsonNode(isArray ? null : k, val[k], i === keys.length - 1));
                            });
                            node.appendChild(content);
                            
                            const footer = document.createElement('div');
                            footer.className = 'json-footer';
                            footer.innerHTML = '<span class="json-brace">' + closeBadge + '</span>' + (isLast ? '' : '<span class="json-comma">,</span>');
        node.appendChild(footer);

        toggle.onclick = (e) => {
            e.stopPropagation();
            toggle.classList.toggle('collapsed');
            content.classList.toggle('collapsed');
            toggle.textContent = toggle.classList.contains('collapsed') ? '▶' : '▼';
        };
    } else {
    node.appendChild(header);
    let valStr = '';
    let type = 'null';
    if (typeof val === 'string') {
        type = 'string';
        valStr = '"' + val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '"';
    } else if (typeof val === 'number') {
        type = 'number';
        valStr = val.toString();
    } else if (typeof val === 'boolean') {
        type = 'boolean';
        valStr = val.toString();
    } else if (val === null) {
        valStr = 'null';
    }

    const valueSpan = document.createElement('span');
    valueSpan.className = 'json-value json-' + type;
    valueSpan.innerHTML = valStr;
    node.appendChild(valueSpan);

    if (!isLast) {
        const comma = document.createElement('span');
        comma.className = 'json-comma';
        comma.textContent = ',';
        node.appendChild(comma);
    }
}

                        return node;
                    }

                    function filterJson(input) {
                        const query = input.value.toLowerCase();
                        const jsonBox = input.closest('.json-box');
                        
                        // Ensure it's rendered before searching
                        if (!jsonBox.classList.contains('rendered')) {
                            const raw = jsonBox.querySelector('pre');
                            if (raw) {
                                try {
                                    const data = JSON.parse(raw.textContent);
                                    renderJson(jsonBox.querySelector('.json-container'), data);
                                    jsonBox.classList.add('rendered');
                                } catch (e) {}
                            }
                        }

                        const nodes = jsonBox.querySelectorAll('.json-node');
                        const statusSpan = jsonBox.querySelector('.json-search-count');
                        
                        // Reset local search state
                        jsonBox._matches = [];
                        jsonBox._matchIndex = -1;

                        nodes.forEach(node => {
                            // Extract key and value spans belonging ONLY to this specific node
                            const keySpan = node.querySelector(':scope > .json-header > .json-key');
                            const valSpan = node.querySelector(':scope > .json-value');
                            
                            // Restore originals if they were highlighted
                            if (keySpan && keySpan.getAttribute('data-original')) {
                                keySpan.innerHTML = keySpan.getAttribute('data-original');
                            }
                            if (valSpan && valSpan.getAttribute('data-original')) {
                                valSpan.innerHTML = valSpan.getAttribute('data-original');
                            }

                            if (!query) {
                                node.style.display = '';
                                return;
                            }
                            
                            const text = node.textContent.toLowerCase();
                            const isMatch = text.includes(query);
                            node.style.display = isMatch ? '' : 'none';
                            
                            if (isMatch) {
                                // Highlighting
                                [keySpan, valSpan].forEach(span => {
                                    if (!span) return;
                                    const content = span.textContent;
                                    if (content.toLowerCase().includes(query)) {
                                        if (!span.getAttribute('data-original')) {
                                            span.setAttribute('data-original', span.innerHTML);
                                        }
                                        const regex = new RegExp('(' + escapeRegExp(query) + ')', 'gi');
                                        span.innerHTML = content.replace(regex, '<span class="json-highlight">$1</span>');
                                    }
                                });

                                // Expand parents
                                let parentNode = node.parentElement.closest('.json-node');
                                while (parentNode) {
                                    parentNode.style.display = '';
                                    const content = parentNode.querySelector('.json-content');
                                    const toggle = parentNode.querySelector('.json-toggle');
                                    if (content) content.classList.remove('collapsed');
                                    if (toggle) {
                                        toggle.classList.remove('collapsed');
                                        toggle.textContent = '▼';
                                    }
                                    parentNode = parentNode.parentElement.closest('.json-node');
                                }
                            }
                        });

                        // Collect all unique matches from the entire box once
                        if (query) {
                            jsonBox._matches = Array.from(jsonBox.querySelectorAll('.json-highlight'));
                        }

                        if (query && jsonBox._matches.length > 0) {
                            jsonBox._matchIndex = 0;
                            statusSpan.textContent = '1/' + jsonBox._matches.length;
                            updateJsonHighlight(jsonBox);
                        } else {
                            statusSpan.textContent = query ? '0/0' : '';
                        }
                    }

                    function navigateJsonSearch(input, reverse) {
                        const jsonBox = input.closest('.json-box');
                        if (!jsonBox._matches || jsonBox._matches.length === 0) return;

                        if (reverse) {
                            jsonBox._matchIndex = (jsonBox._matchIndex - 1 + jsonBox._matches.length) % jsonBox._matches.length;
                        } else {
                            jsonBox._matchIndex = (jsonBox._matchIndex + 1) % jsonBox._matches.length;
                        }

                        const statusSpan = jsonBox.querySelector('.json-search-count');
                        statusSpan.textContent = (jsonBox._matchIndex + 1) + '/' + jsonBox._matches.length;
                        updateJsonHighlight(jsonBox);
                    }

                    function updateJsonHighlight(jsonBox) {
                        jsonBox.querySelectorAll('.json-highlight.active').forEach(h => h.classList.remove('active'));
                        const match = jsonBox._matches[jsonBox._matchIndex];
                        if (match) {
                            match.classList.add('active');
                            match.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
</script>
    </body>
    </html>
        `;
    }

    private extractStepText(step: any): string {
        if (!step) return '';
        const lm = LocalizationManager.getInstance();

        let text = '';
        const type = step.type || '';

        // Strategy from antigravityClient.ts search(), enhanced with safe checks
        const stopReason = (step.modelResponse?.stopReason || step.plannerResponse?.stopReason || '').toUpperCase();
        const isErrorType = type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' || step.errorMessage || stopReason.includes('ERROR') || stopReason.includes('CANCELED');

        // 1. Priority: Errors and Special Terminations
        if (isErrorType) {
            const err = step.errorMessage?.error || step.errorMessage || {};
            const userMsg = err.userErrorMessage || err.message || (typeof step.errorMessage === 'string' ? step.errorMessage : '');
            const details = err.shortError || err.fullError || err.modelErrorMessage || '';

            if (userMsg && details && details !== userMsg) {
                text = `${userMsg}\n\n${details}`;
            } else {
                text = userMsg || details || stopReason || '';
            }

            if (text.includes('STREAM_ERROR')) {
                text = `⚠️ ${lm.t('Stream Error')}: ${text} `;
            } else if (text.includes('CANCELED')) {
                text = `🚫 ${lm.t('Request was canceled by client')} `;
            } else if (text === stopReason && stopReason) {
                text = `ℹ️ ${lm.t('Step ended with status')}: ${stopReason} `;
            }

            // Enhanced: Also try to extract tool calls if they exist, even if it's an error
            const toolCalls: any[] = [];
            if (Array.isArray(step.plannerResponse?.toolCalls)) toolCalls.push(...step.plannerResponse.toolCalls);
            if (step.metadata?.toolCall) {
                if (Array.isArray(step.metadata.toolCall)) toolCalls.push(...step.metadata.toolCall);
                else toolCalls.push(step.metadata.toolCall);
            }

            if (toolCalls.length > 0) {
                const toolParts = toolCalls.map(tc => this.formatToolCall(tc));
                text = (text ? text + '\n\n' : '') + toolParts.join('\n\n');
            }
        }
        // 2. Standard Types
        else if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
            if (step.userInput && Array.isArray(step.userInput.items) && step.userInput.items.length > 0) {
                const item = step.userInput.items[0];
                text = item.text?.content || (typeof item.text === 'string' ? item.text : '') || '';
            } else if (step.userInput?.userResponse) {
                text = step.userInput.userResponse;
            }
        } else if (type === 'CORTEX_STEP_TYPE_MODEL_RESPONSE') {
            if (step.modelResponse && step.modelResponse.content && Array.isArray(step.modelResponse.content)) {
                text = step.modelResponse.content.map((c: any) => c.text?.content || (typeof c.text === 'string' ? c.text : '') || '').join('\n');
            } else if (step.modelResponse?.text) {
                text = step.modelResponse.text;
            }
        } else if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || (step.metadata?.toolCall && type.includes('NOTIFY_USER'))) {
            const parts: string[] = [];

            const thinking = step.plannerResponse?.thinking || step.plannerResponse?.thought || '';
            if (thinking) parts.push(thinking);

            const resp = step.plannerResponse?.response || step.plannerResponse?.modifiedResponse || (typeof step.plannerResponse?.message === 'string' ? step.plannerResponse.message : '');
            if (resp) parts.push(resp);

            const toolCalls: any[] = [];
            if (Array.isArray(step.plannerResponse?.toolCalls)) {
                toolCalls.push(...step.plannerResponse.toolCalls);
            }
            if (step.metadata?.toolCall) {
                // If it's a single object (from metadata), Wrap it in array
                if (Array.isArray(step.metadata.toolCall)) toolCalls.push(...step.metadata.toolCall);
                else toolCalls.push(step.metadata.toolCall);
            }

            if (toolCalls.length > 0) {
                const toolParts = toolCalls.map(tc => this.formatToolCall(tc));
                parts.push(toolParts.join('\n\n'));
            }
            text = parts.join('\n\n');
        }
        else {
            text = step.message?.text || step.text || '';
            if (step.metadata?.toolCall) {
                const tcStr = this.formatToolCall(step.metadata.toolCall);
                text = (text ? text + '\n\n' : '') + tcStr;
            }
        }

        if (text) return text.trim();

        const extracted = this.extractFromObj(step).trim();

        // Critical Fallback: If we extracted nothing but expect content, dump JSON to avoid empty bubbles.
        if (!extracted) {
            const isImportant = step.errorMessage ||
                type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' ||
                step.modelResponse ||
                type === 'CORTEX_STEP_TYPE_MODEL_RESPONSE' ||
                step.plannerResponse ||
                type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
                step.userInput ||
                type === 'CORTEX_STEP_TYPE_USER_INPUT' ||
                (step.header?.sender === 'USER' || step.header?.sender === 'MODEL');

            if (isImportant && !this.hasAttachments(step)) {
                // If it's a pointer step (has sourceTrajectoryStepInfo) and we are here, 
                // it means extraction failed or pre-fetch is needed.
                if (step.metadata?.sourceTrajectoryStepInfo?.trajectoryId) {
                    // Check if we retrieved anything meaningful (type/status should have updated if pre-fetch worked)
                    // and it's no longer "cleared" OR it's a model response with content
                    const isPrefetched = (step.type && step.type !== 'CORTEX_STEP_TYPE_CLEARED' && !step.status?.includes('CLEARED')) ||
                        (step.modelResponse && (step.modelResponse.text || step.modelResponse.content));

                    if (!isPrefetched && (step.status === 'CORTEX_STEP_STATUS_CLEARED' || step.status?.includes('CLEARED'))) {
                        // If it's still cleared after pre-fetch attempt, show placeholder
                        return `< span class="cleared-message" > ${lm.t('Message content has been cleared or archived.')} </span>`;
                    }

                    // If we haven't even tried to pre-fetch (empty object mostly), return empty for now
                    if (!step.type && !step.modelResponse && !step.userInput) return '';
                }

                // If the message is cleared and we have no pointers, show a placeholders
                if (step.status === 'CORTEX_STEP_STATUS_CLEARED' || step.status?.includes('CLEARED') || type === 'CORTEX_STEP_TYPE_CLEARED') {
                    return `<span class="cleared-message">${lm.t('Message content has been cleared or archived.')}</span>`;
                }

                return '```json\n' + JSON.stringify(step.errorMessage || step.modelResponse || step.plannerResponse || step.userInput || step, null, 2) + '\n```';
            }
        }

        return extracted;
    }

    private renderToolCalls(content: string, seenExecIds?: Set<string>): string {
        const lm = LocalizationManager.getInstance();
        return content.replace(/\[TOOL_CALL:([^|\]]+)(?:\|([^|\]]+)(?:\|([^|\]]*))?)?(?:\|\|\|([^\]|]*))?(?:\|\|\|\|([^\]]*))?\]/g, (match, toolName, filePath, lineInfo, base64Args, execId) => {
            if (seenExecIds) {
                // If execId is missing, use tool name + args as a fallback deduplication key
                const dedupeId = execId || `${toolName}:${base64Args || ''}`;
                if (seenExecIds.has(dedupeId)) return '';
                seenExecIds.add(dedupeId);
            }
            let fileBadge = '';
            if (filePath) {
                // Strip fragment for display clean-up
                const cleanFilePath = filePath.includes('#') ? filePath.split('#')[0] : filePath;
                const displayPath = cleanFilePath.split(/[/\\]/).pop() || cleanFilePath;

                // Dynamic detection for 📂 icon
                let isDirectory = toolName === 'list_dir' || toolName === 'find_by_name';
                let exists = false;
                try {
                    if (fs.existsSync(cleanFilePath)) {
                        exists = true;
                        isDirectory = fs.statSync(cleanFilePath).isDirectory();
                    }
                } catch (e) { /* ignore */ }

                fileBadge = `
                    <span class="file-badge mini ${isDirectory ? 'directory' : ''} ${!exists ? 'missing' : ''}" onclick="openFile('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')" title="${!exists ? lm.t('File not found locally') : ''}">
                        <span class="icon">${isDirectory ? '📂' : (exists ? getFileIconSvg(cleanFilePath) : '🚫')}</span>
                        <span class="path">${displayPath}${lineInfo || ''}</span>
                    </span>
                `;
            }

            let argsButton = '';
            let argsBox = '';
            let reviewBadges = '';
            let detailBadges = '';

            if (base64Args) {
                try {
                    const jsonStr = Buffer.from(base64Args, 'base64').toString('utf8');
                    const args = JSON.parse(jsonStr);
                    const prettyJson = JSON.stringify(args, null, 2);
                    const boxId = `args-${Math.random().toString(36).substr(2, 9)}`;

                    argsButton = `<button class="tool-args-btn" onclick="toggleArgs('${boxId}')">${lm.t('Arguments')}</button>`;
                    argsBox = `
                        <div id="${boxId}" class="tool-args-box">
                            <pre>${prettyJson.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                        </div>
                    `;

                    if (toolName === 'run_command' && (args.CommandLine || args.Command)) {
                        // Copy button is handled via [COPY_CMD] replacement in the info string
                    }

                    if (toolName === 'notify_user' && args.PathsToReview && Array.isArray(args.PathsToReview) && args.PathsToReview.length > 0) {
                        reviewBadges = args.PathsToReview.map((p: string) => {
                            const name = p.split(/[/\\]/).pop() || p;
                            const exists = fs.existsSync(p);
                            return `
                                <span class="file-badge mini ${!exists ? 'missing' : ''}" title="${p}${!exists ? ' (' + lm.t('File not found locally') + ')' : ''}" onclick="openFile('${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">
                                    <span class="icon">${exists ? getFileIconSvg(p) : '🚫'}</span>
                                    <span class="path">${name}</span>
                                </span>
                            `;
                        }).join('');
                        reviewBadges = `<div style="display: flex; flex-wrap: wrap; gap: 4px; border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 8px; margin-left: 8px;">
                                            <span style="font-size: 0.85em; opacity: 0.8; display: flex; align-items: center;">${lm.t('Review Required')}:</span>
                                            ${reviewBadges}
                                        </div>`;
                    }

                    if (toolName === 'grep_search' || toolName === 'find_by_name' || toolName === 'view_file' || toolName === 'ls' || toolName === 'list_dir') {
                        let q = args.Query || args.Pattern || args.query || args.pattern || args.AbsolutePath || args.Path || args.SearchDirectory || args.SearchPath;
                        // Strip fragment for equality check
                        const cleanFilePath = filePath ? (filePath.includes('#') ? filePath.split('#')[0] : filePath) : '';

                        if (q && q !== filePath && q !== cleanFilePath) {
                            let qIsDir = false;
                            let qExists = false;
                            try {
                                if (fs.existsSync(q)) {
                                    qExists = true;
                                    qIsDir = fs.statSync(q).isDirectory();
                                }
                            } catch (e) { /* ignore */ }

                            // Smart join for find_by_name/grep_search if q looks like a relative filename
                            let openPath = q;
                            if ((toolName === 'find_by_name' || toolName === 'grep_search') && !path.isAbsolute(q) && filePath) {
                                // If filePath is a directory, join it
                                try {
                                    const dir = (fs.existsSync(cleanFilePath) && fs.statSync(cleanFilePath).isDirectory()) ? cleanFilePath : undefined;
                                    if (dir) {
                                        openPath = path.posix.join(dir.replace(/\\/g, '/'), q.replace(/\\/g, '/'));
                                        if (!qExists && fs.existsSync(openPath)) {
                                            qExists = true;
                                            qIsDir = fs.statSync(openPath).isDirectory();
                                        }
                                    }
                                } catch { /* ignore */ }
                            }

                            const qIcon = toolName === 'grep_search' ? '🔍' : (qIsDir ? '📂' : (qExists ? getFileIconSvg(openPath) : '🚫'));
                            const qStyle = !qExists && toolName !== 'grep_search' ? 'opacity: 0.6; filter: grayscale(1);' : '';

                            detailBadges = `<span class="tool-query-badge" style="cursor: pointer; ${qStyle}" onclick="openFile('${openPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')" title="${openPath.replace(/"/g, '&quot;')}"><small style="margin-right:4px; opacity:0.6; width: 14px; height: 14px; display: inline-flex; align-items: center; vertical-align: middle;">${qIcon}</small>${q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`;

                        }
                    }
                } catch (e) {
                    console.error('Failed to parse tool arguments:', e);
                }
            }

            let infoBadges = '';
            if (detailBadges || fileBadge) {
                // Ensure fileBadge doesn't float right by overriding margin-left
                const styledFileBadge = fileBadge.replace('class="file-badge mini', 'class="file-badge mini" style="margin-left: 0"');
                infoBadges = `
                    <div style="display: flex; align-items: center; gap: 6px; border-left: 1px solid var(--vscode-widget-border); padding-left: 8px; margin-left: 8px;">
                        ${detailBadges}
                        ${styledFileBadge}
                    </div>
                `;
            }

            let extraStuff = '';
            if (base64Args) {
                try {
                    const jsonStr = Buffer.from(base64Args, 'base64').toString('utf8');
                    const args = JSON.parse(jsonStr);

                    if (toolName === 'task_boundary') {
                        let name = args.TaskName || '';
                        let summary = args.TaskSummaryWithCitations || args.TaskSummary || '';

                        // Handle %SAME% logic
                        if (name === '%SAME%') name = this.lastTaskName || '';
                        else if (name) this.lastTaskName = name;

                        if (summary === '%SAME%') summary = this.lastTaskSummary || '';
                        else if (summary) this.lastTaskSummary = summary;

                        let summaryHtml = summary;
                        if (summary && this.md && typeof this.md.render === 'function') {
                            summaryHtml = this.md.render(summary);
                        }
                        if (name || summary) {
                            extraStuff = `
                                <div class="task-boundary-info">
                                    ${name ? `<div class="task-name-header">${name}</div>` : ''}
                                    ${summaryHtml ? `<div class="task-summary-box markdown-body">${summaryHtml}</div>` : ''}
                                </div>
                            `;
                        }
                    } else if (toolName === 'run_command' && args.CommandLine) {
                        const desc = args.Message || args.Description || args.Summary || '';
                        const base64Cmd = Buffer.from(args.CommandLine).toString('base64');
                        extraStuff = `
                            <div class="command-info">
                                ${desc ? `<div class="command-desc">${desc}</div>` : ''}
                                <div class="command-line">\`${args.CommandLine}\` <button class="copy-btn mini" title="${lm.t('Copy Link')}" onclick="copyToClipboard('${args.CommandLine.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', this)">📋</button></div>
                            </div>
                        `;
                    }
                } catch (e) { /* ignore */ }
            }

            return `
                <div class="tool-call">
                    <span class="tool-icon">🛠️</span>
                    <span class="tool-label">${lm.t('Tool Use')}:</span>
                    <span class="tool-name">${toolName}</span>
                    ${infoBadges}
                    ${reviewBadges}
                    ${argsButton}
                </div>
                ${argsBox}
                ${extraStuff}
            `;
        }).replace(/\[NAV_BADGE:([^|\]]+)\|([^|\]]+)\|([^\]]*)\]/g, (match, filePath, lineInfo, label) => {
            const exists = fs.existsSync(filePath);
            const iconSvg = getFileIconSvg(filePath);
            return `
                <span class="file-badge mini ${!exists ? 'missing' : ''}" title="${!exists ? lm.t('File not found locally') : ''}" onclick="openFile('${filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}${lineInfo}')">
                    <span class="icon">${exists ? iconSvg : '🚫'}</span>
                    <span class="path">${label}</span>
                </span>
            `;
        }).replace(/\[COPY_CMD:([^\]]+)\]/g, (match, base64Cmd) => {
            try {
                const cmd = Buffer.from(base64Cmd, 'base64').toString('utf8');
                const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
                return `<button class="copy-btn" title="${lm.t('Copy to Clipboard')}" onclick="copyToClipboard('${escapedCmd}', this)">📋</button>`;
            } catch { return ''; }
        }).replace(/\[DIFF:([^\]]+)\]/g, (match, base64Diff) => {
            try {
                return Buffer.from(base64Diff, 'base64').toString('utf8');
            } catch { return ''; }
        }).replace(/\[LOCAL_TIME:([^\]]+)\]/g, (match, timestamp) => {
            try {
                const date = new Date(parseInt(timestamp));
                return lm.formatDateTime(date);
            } catch { return timestamp; }
        });
    }

    private generateFileContentHtml(text: string, startLine: number, title?: string, collapsed: boolean = true, filename?: string): string {
        const lm = LocalizationManager.getInstance();
        const t = title || lm.t('File Content');
        const lines = text.split('\n');

        let html = '<div class="diff-container">';
        const iconSvg = filename ? getFileIconSvg(filename) : '<span class="icon">📄</span>';
        html += `<div class="diff-header ${collapsed ? 'collapsed' : ''}" onclick="toggleDiff(this)">
            <div class="diff-icon">${iconSvg}</div> ${t}
            <div class="font-controls" onclick="event.stopPropagation()">
                <button class="font-btn" onclick="changeFontSize(this, -1)">-</button>
                <button class="font-btn" onclick="changeFontSize(this, 1)">+</button>
                <span class="zoom-level">1.0x</span>
            </div>
            <span class="stats">${lines.length} ${lm.t('Lines')}</span>
        </div>`;
        html += `<div class="diff-block ${collapsed ? 'collapsed' : ''}"><div class="diff-lines-wrapper">`;

        let currentLine = startLine;
        lines.forEach((l) => {
            const lineNumStr = startLine >= 0 ? `<span class="line-num">${currentLine}</span>` : '';
            const lineContent = this.highlightDiff(l);
            html += `<div class="diff-line">${lineNumStr}<span style="flex: 1;">${lineContent || ' '}</span></div>`;
            if (startLine >= 0) currentLine++;
        });

        html += '</div></div></div>';
        return html;
    }

    private generateDiffHtml(oldText: string, newText: string, startLine: number = 0, filename?: string): string {
        const lm = LocalizationManager.getInstance();
        const oldLines = (oldText || '').split('\n');
        const newLines = (newText || '').split('\n');

        let delCount = 0;
        let addCount = 0;

        oldLines.forEach(l => { if (l.trim() || oldLines.length === 1) delCount++; });
        newLines.forEach(l => { if (l.trim() || newLines.length === 1) addCount++; });

        let html = '<div class="diff-container">';
        const iconSvg = filename ? getFileIconSvg(filename) : '<span class="icon">📝</span>';
        html += `<div class="diff-header collapsed" onclick="toggleDiff(this)">
            <div class="diff-icon">${iconSvg}</div> ${lm.t('Code Changes')}
            <div class="font-controls" onclick="event.stopPropagation()">
                <button class="font-btn" onclick="changeFontSize(this, -1)">-</button>
                <button class="font-btn" onclick="changeFontSize(this, 1)">+</button>
                <span class="zoom-level">1.0x</span>
            </div>
            <span class="stats">(-${delCount}, +${addCount})</span>
        </div>`;
        html += '<div class="diff-block collapsed"><div class="diff-lines-wrapper">';

        let currentLine = startLine;
        oldLines.forEach(l => {
            const lineNumStr = startLine > 0 ? `<span class="line-num">${currentLine}</span>` : '';
            if (l.trim() || oldLines.length === 1) {
                const lineContent = this.highlightDiff(l);
                html += `<div class="diff-line diff-del">${lineNumStr}- ${lineContent}</div>`;
            }
            if (startLine > 0) currentLine++;
        });

        currentLine = startLine;
        newLines.forEach(l => {
            const lineNumStr = startLine > 0 ? `<span class="line-num">${currentLine}</span>` : '';
            if (l.trim() || newLines.length === 1) {
                const lineContent = this.highlightDiff(l);
                html += `<div class="diff-line diff-add">${lineNumStr}+ ${lineContent}</div>`;
            }
            if (startLine > 0) currentLine++;
        });
        html += '</div></div></div>';
        return html;
    }

    private highlightDiff(line: string): string {
        // Escaping HTML characters first
        let html = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Use a richer color palette similar to VS Code's Dark Pro
        const colors = {
            keyword: '#c586c0',     // Purple
            function: '#dcdcaa',    // Yellowish
            string: '#ce9178',      // Orange tint
            number: '#b5cea8',      // Light green
            boolean: '#569cd6',     // Blue
            type: '#4ec9b0',        // Teal
            variable: '#9cdcfe',    // Light blue
            comment: '#6a9955',     // Green
            operator: '#d4d4d4'     // White/Gray
        };

        // 1. Strings (careful with quotes)
        html = html.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, `<span style="color: ${colors.string}">"$1"</span>`);
        html = html.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, `<span style="color: ${colors.string}">'$1'</span>`);

        // 2. Numbers
        html = html.replace(/\b(\d+(\.\d+)?)\b/g, `<span style="color: ${colors.number}">$1</span>`);

        // 3. Booleans and null
        html = html.replace(/\b(true|false|null)\b/g, `<span style="color: ${colors.boolean}">$1</span>`);

        // 4. Keywords
        const keywords = ['function', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return', 'import', 'from', 'export', 'class', 'interface', 'type', 'private', 'public', 'protected', 'async', 'await', 'new', 'this', 'throw', 'try', 'catch', 'finally', 'extends', 'implements', 'as', 'readonly', 'static'];
        const keywordRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
        html = html.replace(keywordRegex, `<span style="color: ${colors.keyword}">$1</span>`);

        // 5. Common built-ins and types
        const types = ['string', 'number', 'boolean', 'any', 'void', 'unknown', 'never', 'object', 'Array', 'Promise', 'Map', 'Set'];
        const typesRegex = new RegExp(`\\b(${types.join('|')})\\b`, 'g');
        html = html.replace(typesRegex, `<span style="color: ${colors.type}">$1</span>`);

        // 6. Functions (words before parenthesis)
        html = html.replace(/\b([a-zA-Z0-9_]+)(?=\s*\()/g, `<span style="color: ${colors.function}">$1</span>`);

        // 7. HTML/XML Tags (basic)
        html = html.replace(/(&lt;\/?)([a-zA-Z0-9]+)(.*?\/?[&gt;])/g, (m, open, tag, rest) => {
            return `<span style="color: ${colors.boolean}">${open}</span><span style="color: ${colors.keyword}">${tag}</span><span style="color: ${colors.boolean}">${rest}</span>`;
        });

        // 8. Comments (at the end to avoid matching inside code)
        html = html.replace(/(\/\/.*$)/g, `<span style="color: ${colors.comment}">$1</span>`);
        html = html.replace(/(\/\*[\s\S]*?\*\/)/g, `<span style="color: ${colors.comment}">$1</span>`);

        return html;
    }

    private formatToolCall(tc: any): string {
        const lm = LocalizationManager.getInstance();
        let encodedArgs = '';
        if (tc.argumentsJson) {
            try {
                encodedArgs = Buffer.from(tc.argumentsJson).toString('base64');
            } catch { /* ignore */ }
        }

        let toolBadge = `[TOOL_CALL:${tc.name || 'Unknown'}${encodedArgs ? '|||' + encodedArgs : ''}${tc.executionId ? '||||' + tc.executionId : ''}]`;
        let extraInfo = '';
        let prefixInfo = '';

        if (tc.argumentsJson || tc.arguments) {
            const infos: string[] = [];
            try {
                const args = tc.argumentsJson ? JSON.parse(tc.argumentsJson) : (tc.arguments || {});

                // Extract path for the badge link if possible
                let path = args.SearchPath || args.DirectoryPath || args.AbsolutePath || args.TargetFile || args.TargetPath || args.Path || args.SearchDirectory || args.File || args.TargetFolder || args.Cwd || args.cwd;

                if (path) {
                    let lineInfo = '';
                    if (args.StartLine !== undefined) {
                        lineInfo = `:${args.StartLine}${args.EndLine ? '-' + args.EndLine : ''}`;
                        // Append to path for the onclick handler to use fragment
                        path += '#' + lineInfo;
                    }
                    toolBadge = `[TOOL_CALL:${tc.name}|${path}|${lineInfo}${encodedArgs ? '|||' + encodedArgs : ''}${tc.executionId ? '||||' + tc.executionId : ''}]`;
                }

                const desc = args.Message || args.message || args.Description || args.description || args.Summary || args.summary || args.text || args.Text;

                // 1. Tool-Specific Priority Fields
                if (tc.name === 'task_boundary') {
                    // Handled in renderToolCalls
                } else if (tc.name === 'run_command') {
                    if (tc.output) {
                        const outputStr = typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2);
                        if (outputStr.trim()) {
                            const raw = outputStr.length > 5000 ? outputStr.substring(0, 5000) + '...' : outputStr;
                            const path = args.Path || args.path || args.TargetPath || args.targetPath || args.TargetFile || args.targetFile || args.AbsolutePath || args.absolutePath;
                            const contentHtml = this.generateFileContentHtml(raw, -1, lm.t('Command Output'), true, path);
                            infos.push(`[DIFF:${Buffer.from(contentHtml).toString('base64')}]`);
                        }
                    }
                }
                else if (tc.name === 'replace_file_content') {
                    if (args.TargetContent !== undefined && args.ReplacementContent !== undefined) {
                        const startLine = parseInt(args.StartLine) || 0;
                        const filename = args.TargetFile || args.File || args.Path || '';
                        const diffHtml = this.generateDiffHtml(args.TargetContent, args.ReplacementContent, startLine, filename);
                        infos.push(`[DIFF:${Buffer.from(diffHtml).toString('base64')}]`);
                    }
                } else if (tc.name === 'multi_replace_file_content') {
                    if (args.ReplacementChunks && Array.isArray(args.ReplacementChunks)) {
                        const filePath = args.TargetFile || args.File || '';

                        args.ReplacementChunks.forEach((chunk: any, idx: number) => {
                            const start = parseInt(chunk.StartLine) || 0;
                            const end = parseInt(chunk.EndLine) || start;

                            let chunkTitle = '';
                            if (args.ReplacementChunks.length > 1) {
                                chunkTitle = `**${lm.t('Chunk')} ${idx + 1}**`;
                            }

                            if (filePath && start > 0) {
                                const badge = ` [NAV_BADGE:${filePath}|#L${start}-L${end}|#${start}-${end}]`;
                                infos.push(chunkTitle ? `${chunkTitle}${badge}` : badge);
                            } else if (chunkTitle) {
                                infos.push(chunkTitle);
                            }

                            const diffHtml = this.generateDiffHtml(chunk.TargetContent, chunk.ReplacementContent, start, filePath);
                            infos.push(`[DIFF:${Buffer.from(diffHtml).toString('base64')}]`);
                        });
                    }
                } else if (tc.name === 'grep_search') {
                    // Query and SearchPath are handled in header
                    const outputToParse = tc.output || tc.response || tc.result;
                    if (outputToParse) {
                        try {
                            const res = typeof outputToParse === 'string' ? JSON.parse(outputToParse) : outputToParse;
                            const data = res.grepSearch || res.grep_search || res.grep || (Array.isArray(res) ? { results: res } : res);
                            if (data) {
                                if (data.totalResults !== undefined) {
                                    infos.push(`**${lm.t('Found')}:** ${data.totalResults} ${lm.t('matches')}`);
                                }
                                if (data.results && Array.isArray(data.results)) {
                                    const resultsHtml = data.results.slice(0, 20).map((item: any) => {
                                        const file = item.file || item.path || item.relativePath || item.absolutePath || item.filepath || item.file_path || '???';
                                        const lineNum = item.line || item.lineNumber || '';
                                        const content = item.content || item.lineContent || '';
                                        const displayFile = (typeof file === 'string' ? file.split(/[/\\]/).pop() : file) || file;
                                        return `<div class="outline-item" style="padding: 4px 0; border-bottom: 1px solid rgba(127,127,127,0.05);">
                                            <div style="display: flex; gap: 8px; font-size: 0.85em; opacity: 0.7; margin-bottom: 2px;">
                                                <span onclick="openFile('${file.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}${lineNum ? '#L' + lineNum : ''}')" style="cursor: pointer; color: var(--vscode-textLink-foreground); font-weight: 600;">${displayFile}${lineNum ? ':' + lineNum : ''}</span>
                                            </div>
                                            <div style="font-family: var(--vscode-editor-font-family); font-size: 0.9em; white-space: pre-wrap; word-break: break-all; opacity: 0.9;">${content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                                        </div>`;
                                    }).join('');

                                    if (resultsHtml) {
                                        const containerHtml = `<div class="diff-container">
                                            <div class="diff-header collapsed" onclick="toggleDiff(this)">
                                                <span class="icon">🔍</span> ${lm.t('Search Results')}
                                                <span class="stats">${data.results.length} ${lm.t('matches')}</span>
                                            </div>
                                            <div class="diff-block collapsed" style="padding: 8px 12px;">
                                                ${resultsHtml}
                                            </div>
                                        </div>`;
                                        infos.push(`[DIFF:${Buffer.from(containerHtml).toString('base64')}]`);
                                    }
                                } else if (data.rawOutput) {
                                    const raw = data.rawOutput.length > 5000 ? data.rawOutput.substring(0, 5000) + '...' : data.rawOutput;
                                    const contentHtml = this.generateFileContentHtml(raw, -1, lm.t('Search Results'));
                                    infos.push(`[DIFF:${Buffer.from(contentHtml).toString('base64')}]`);
                                }
                            }
                        } catch { /* ignore */ }
                    }
                } else if (tc.name === 'list_dir') {
                    if (tc.output) {
                        try {
                            const res = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
                            const data = res.listDirectory || res;
                            if (data && Array.isArray(data.results)) {
                                const listHtml = data.results.map((item: any) => {
                                    const icon = (item.isDir || item.type === 'directory') ? '📁' : '📄';
                                    const sizeVal = item.sizeBytes || item.size;
                                    const size = sizeVal ? ` (${(parseInt(sizeVal) / 1024).toFixed(1)} KB)` : '';
                                    const children = item.numChildren !== undefined ? ` [${item.numChildren}]` : '';
                                    return `<div class="outline-item" style="display: flex; gap: 8px; font-size: 0.9em; padding: 2px 0; border-bottom: 1px solid rgba(127,127,127,0.05);">
                                        <span style="opacity: 0.6; min-width: 20px; text-align: center;">${icon}</span>
                                        <span style="font-weight: 500;">${item.name || item.path || '???'}</span>
                                        <span style="margin-left: auto; opacity: 0.5; font-family: var(--vscode-editor-font-family);">${children}${size}</span>
                                    </div>`;
                                }).join('');

                                if (listHtml) {
                                    const containerHtml = `<div class="diff-container">
                                        <div class="diff-header collapsed" onclick="toggleDiff(this)">
                                            <span class="icon">📁</span> ${lm.t('Directory Listing')}
                                            <span class="stats">${data.results.length} ${lm.t('items')}</span>
                                        </div>
                                        <div class="diff-block collapsed" style="padding: 8px 12px;">
                                            ${listHtml}
                                        </div>
                                    </div>`;
                                    infos.push(`[DIFF:${Buffer.from(containerHtml).toString('base64')}]`);
                                }
                            }
                        } catch { /* ignore */ }
                    }
                } else if (tc.name === 'find_by_name') {
                    // Prepend directory to pattern for direct opening if it looks like a filename
                    const pattern = args.Pattern || args.pattern;
                    const directory = args.SearchDirectory || args.SearchPath || args.Directory || args.directory || args.path || '.';
                    if (pattern && directory && !pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[') && !pattern.includes('{')) {
                        const fullPath = path.posix.join(directory.replace(/\\/g, '/'), pattern.replace(/\\/g, '/'));
                        toolBadge = `[TOOL_CALL:${tc.name}|${fullPath}${encodedArgs ? '|||' + encodedArgs : ''}]`;
                    }

                    if (tc.output) {
                        try {
                            const res = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
                            const data = res.find || res;
                            if (data) {
                                if (data.results && Array.isArray(data.results)) {
                                    const resultsHtml = data.results.slice(0, 30).map((item: any) => {
                                        const p = item.path || item.relative_path || item.name || '???';
                                        const icon = (item.type === 'directory') ? '📁' : '📄';
                                        const displayPath = p.split(/[/\\]/).pop() || p;
                                        return `<div class="outline-item" style="display: flex; gap: 8px; font-size: 0.9em; padding: 2px 0;">
                                            <span style="opacity: 0.6; min-width: 20px; text-align: center;">${icon}</span>
                                            <span onclick="openFile('${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')" style="cursor: pointer; color: var(--vscode-textLink-foreground); font-weight: 500;">${displayPath}</span>
                                            <span style="margin-left: auto; opacity: 0.4; font-size: 0.8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;">${p}</span>
                                        </div>`;
                                    }).join('');

                                    if (resultsHtml) {
                                        const containerHtml = `<div class="diff-container">
                                            <div class="diff-header collapsed" onclick="toggleDiff(this)">
                                                <span class="icon">🔍</span> ${lm.t('Find Results')}
                                                <span class="stats">${data.results.length} ${lm.t('matches')}</span>
                                            </div>
                                            <div class="diff-block collapsed" style="padding: 8px 12px;">
                                                ${resultsHtml}
                                            </div>
                                        </div>`;
                                        infos.push(`[DIFF:${Buffer.from(containerHtml).toString('base64')}]`);
                                    }
                                } else if (data.rawOutput) {
                                    const raw = data.rawOutput.length > 5000 ? data.rawOutput.substring(0, 5000) + '...' : data.rawOutput;
                                    const contentHtml = this.generateFileContentHtml(raw, -1, lm.t('Find Results'));
                                    infos.push(`[DIFF:${Buffer.from(contentHtml).toString('base64')}]`);
                                }
                            }
                        } catch { /* ignore */ }
                    }
                } else if (tc.name === 'read_url_content' || tc.name === 'read_browser_page') {
                    if (tc.output) {
                        try {
                            const res = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
                            const content = res.content || res.text || (typeof res === 'string' ? res : '');
                            if (content) {
                                let rendered = content;
                                if (this.md) rendered = this.md.render(content);
                                const containerHtml = `<div class="diff-container">
                                    <div class="diff-header collapsed" onclick="toggleDiff(this)">
                                        <span class="icon">🌐</span> ${lm.t('Page Content')}
                                    </div>
                                    <div class="diff-block collapsed markdown-body" style="padding: 15px;">
                                        ${rendered}
                                    </div>
                                </div>`;
                                infos.push(`[DIFF:${Buffer.from(containerHtml).toString('base64')}]`);
                            }
                        } catch { /* ignore */ }
                    }
                } else if (tc.name === 'search_web') {
                    if (tc.output) {
                        try {
                            const res = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
                            if (res.summary) {
                                infos.push(`> ${res.summary}`);
                            }
                            if (res.results && Array.isArray(res.results)) {
                                const listHtml = res.results.slice(0, 5).map((r: any) => {
                                    return `<div style="margin-bottom: 8px;">
                                        <div style="font-weight: 600;"><a href="${r.url}" style="color: var(--vscode-textLink-foreground); text-decoration: none;">${r.title}</a></div>
                                        <div style="font-size: 0.85em; opacity: 0.8; white-space: pre-wrap;">${r.snippet}</div>
                                    </div>`;
                                }).join('');

                                if (listHtml) {
                                    const containerHtml = `<div class="diff-container">
                                        <div class="diff-header collapsed" onclick="toggleDiff(this)">
                                            <span class="icon">🔍</span> ${lm.t('Web Search Results')}
                                        </div>
                                        <div class="diff-block collapsed" style="padding: 12px;">
                                            ${listHtml}
                                        </div>
                                    </div>`;
                                    infos.push(`[DIFF:${Buffer.from(containerHtml).toString('base64')}]`);
                                }
                            }
                        } catch { /* ignore */ }
                    }
                } else if (tc.name === 'notify_user') {
                    // Paths are handled in renderToolCalls
                } else if (tc.name === 'view_file_outline') {
                    if (tc.output) {
                        try {
                            const res = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
                            const outline = res.viewFileOutline || res;
                            if (outline && outline.ccis && Array.isArray(outline.ccis)) {
                                let linesHtml = outline.ccis.map((cci: any) => {
                                    const start = cci.startLine !== undefined ? cci.startLine : '';
                                    const end = cci.endLine !== undefined ? cci.endLine : '';
                                    const range = start !== '' ? `L${start}-${end}` : '';
                                    const name = cci.nodeName || '???';

                                    let icon = '📦';
                                    if (cci.contextType?.includes('CLASS')) icon = '🏛️';
                                    if (cci.contextType?.includes('FUNCTION') || cci.contextType?.includes('METHOD')) icon = 'ƒ';
                                    if (cci.contextType?.includes('INTERFACE')) icon = '📋';

                                    return `<div class="outline-item" style="display: flex; gap: 8px; font-size: 0.9em; padding: 2px 0;">
                                        <span style="opacity: 0.6; min-width: 20px; text-align: center;">${icon}</span>
                                        <span style="font-weight: 600; color: var(--vscode-symbolIcon-methodForeground);">${name}</span>
                                        <span style="margin-left: auto; opacity: 0.5; font-family: var(--vscode-editor-font-family);">${range}</span>
                                    </div>`;
                                }).join('');

                                if (linesHtml) {
                                    const containerHtml = `<div class="diff-container">
                                        <div class="diff-header collapsed" onclick="toggleDiff(this)">
                                            <span class="icon">🧱</span> ${lm.t('File Outline')}
                                            <span class="stats">${outline.ccis.length} ${lm.t('symbols')}</span>
                                        </div>
                                        <div class="diff-block collapsed" style="padding: 8px 12px;">
                                            ${linesHtml}
                                        </div>
                                    </div>`;
                                    infos.push(`[DIFF:${Buffer.from(containerHtml).toString('base64')}]`);
                                }
                            }
                        } catch (e) {
                            /* ignore */
                        }
                    }
                } else if (tc.name === 'view_file') {
                    // Lines info is already in the badge
                    const outputToParse = tc.output || tc.response || tc.result;
                    if (outputToParse) {
                        const outputStr = typeof outputToParse === 'string' ? outputToParse : JSON.stringify(outputToParse);
                        let res: any = null;
                        try { res = typeof outputToParse === 'string' ? JSON.parse(outputToParse) : outputToParse; } catch { /* ignore */ }

                        let fileContent = '';
                        let numLines = '';
                        let numBytes = '';
                        let startLine = 1;

                        // Priority 1: Structured data if available
                        const data = res?.viewFile || res?.view_file || res?.viewFileContent || res?.view_file_content || res;
                        if (data && typeof data === 'object') {
                            fileContent = data.content || data.chunk || data.text || data.fileContent || data.file_content || '';
                            numLines = data.numLines || data.totalLines || data.lines || '';
                            numBytes = data.numBytes || data.totalBytes || data.bytes || '';
                            startLine = data.startLine || data.start_line || 1;
                        } else if (typeof data === 'string' && data.length > 0 && !data.trim().startsWith('{')) {
                            fileContent = data;
                        }

                        if (!fileContent) {
                            // Priority 2: Parse raw string output from tool
                            const linesMatch = outputStr.match(/Total Lines: (\d+)/);
                            if (linesMatch) numLines = linesMatch[1];

                            const bytesMatch = outputStr.match(/Total Bytes: (\d+)/);
                            if (bytesMatch) numBytes = bytesMatch[1];

                            const lines = outputStr.split('\n');
                            const codeLines: string[] = [];

                            let capture = false;
                            for (const line of lines) {
                                if (!capture && /^\d+:/.test(line)) {
                                    capture = true;
                                    const m = line.match(/^(\d+):/);
                                    if (m) startLine = parseInt(m[1]);
                                }

                                if (capture) {
                                    if (line.includes('The above content does NOT show the entire file contents')) break;

                                    if (/^\d+:/.test(line)) {
                                        codeLines.push(line.replace(/^\d+:\s?/, ''));
                                    } else {
                                        // If we are capturing but line doesn't start with digits, it might be a multi-line wrap
                                        // but usually tool prefixes EVERY line.
                                        codeLines.push(line);
                                    }
                                }
                            }
                            if (codeLines.length > 0) fileContent = codeLines.join('\n');

                            // Priority 3: Raw fallback if structured/regex parsing failed and it's not JSON
                            if (!fileContent && outputStr.trim()) {
                                if (outputStr.trim().startsWith('{')) {
                                    try {
                                        // Final attempt: if it's JSON but we didn't find specific fields, just show it pretty-printed
                                        const obj = JSON.parse(outputStr);
                                        fileContent = JSON.stringify(obj, null, 2);
                                        startLine = -1;
                                    } catch { /* ignore */ }
                                }
                                if (!fileContent) {
                                    fileContent = outputStr.trim();
                                    startLine = -1; // No line numbers
                                }
                            }
                        }

                        if (fileContent) {
                            const parts = [];
                            if (numLines) parts.push(`**${lm.t('Num Lines')}:** ${numLines}`);
                            if (numBytes) parts.push(`**${lm.t('Num Bytes')}:** ${numBytes}`);

                            if (parts.length > 0) infos.push(parts.join(' | '));

                            const filePath = args.AbsolutePath || args.Path || args.File || args.TargetFile || '';
                            const displayTitle = filePath ? path.basename(filePath) : undefined;
                            const contentHtml = this.generateFileContentHtml(fileContent, startLine, displayTitle, true);
                            infos.push(`[DIFF:${Buffer.from(contentHtml).toString('base64')}]`);
                        }
                    }
                } else if (tc.name === 'generate_image') {
                    if (tc.output) {
                        try {
                            const res = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
                            const imagePath = res.image_path || res.imagePath;
                            if (imagePath) {
                                const desc = res.description || res.Prompt || args.Prompt || '';
                                const containerHtml = `<div class="diff-container">
                                    <div class="diff-header" onclick="toggleDiff(this)">${lm.t('Generated Image')}</div>
                                    <div class="diff-block" style="padding: 10px; background: var(--vscode-editor-background); text-align: center;">
                                        <img src="vscode-resource:${imagePath.replace(/\\/g, '/')}" style="max-width: 100%; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);" alt="${desc}"/>
                                        ${desc ? `<div style="margin-top: 8px; font-size: 0.9em; opacity: 0.8;">${desc}</div>` : ''}
                                    </div>
                                </div>`;
                                infos.push(`[DIFF:${Buffer.from(containerHtml).toString('base64')}]`);
                            }
                        } catch { /* ignore */ }
                    }
                }

                // 2. Generic Descriptive Fields (if not already added and not handled as prefix)
                if (desc && tc.name !== 'run_command' && tc.name !== 'task_boundary' && !infos.some(i => i.includes(desc))) {
                    infos.push(`${desc}`);
                }

                const instr = args.Instruction || args.instruction;
                if (instr && tc.name !== 'replace_file_content' && tc.name !== 'multi_replace_file_content') {
                    infos.push(`*${lm.t('Instruction')}*: ${instr}`);
                }

                const query = args.Query || args.query || args.Prompt || args.prompt;
                if (query && tc.name !== 'grep_search' && tc.name !== 'find_by_name' && !infos.some(i => i.includes(query))) {
                    infos.push(`*${lm.t('Query/Prompt')}*: ${query}`);
                }

                const cmd = args.CommandLine || args.commandLine || args.Command || args.command;
                if (cmd && tc.name !== 'run_command' && !infos.some(i => i.includes(cmd))) {
                    infos.push(`*${lm.t('Command')}*: \`${cmd}\``);
                }

                if (infos.length > 0) {
                    extraInfo = infos.join('\n');
                }
            } catch (e) {
                console.error('Error formatting tool call:', e);
            }
        }

        let result = prefixInfo + toolBadge;
        if (extraInfo) result += '\n' + extraInfo;
        return result;
    }

    private extractFromObj(obj: any): string {
        if (!obj) return '';
        if (typeof obj === 'string') return obj;
        if (Array.isArray(obj)) return obj.map(o => this.extractFromObj(o)).filter(Boolean).join('\n');

        // Standard protobuf text containers
        if (obj.content !== undefined) {
            if (typeof obj.content === 'string') return obj.content;
            if (Array.isArray(obj.content)) return this.extractFromObj(obj.content);
        }
        if (obj.text !== undefined && typeof obj.text === 'string') return obj.text;
        if (obj.text && typeof obj.text === 'object') {
            const res = obj.text.content || obj.text.text || obj.text.value;
            if (typeof res === 'string') return res;
            return this.extractFromObj(obj.text);
        }
        if (obj.value !== undefined) {
            if (typeof obj.value === 'string') return obj.value;
            if (typeof obj.value === 'object') return this.extractFromObj(obj.value);
        }

        // Specific fields depending on object type
        if (obj.modelResponse) return this.extractFromObj(obj.modelResponse.content || obj.modelResponse.parts || obj.modelResponse.text || obj.modelResponse);
        if (obj.userInput) return this.extractFromObj(obj.userInput.items || obj.userInput.userResponse || obj.userInput.text || obj.userInput);
        if (obj.plannerResponse) {
            const thinking = obj.plannerResponse.thinking || obj.plannerResponse.thought;
            if (thinking) return typeof thinking === 'string' ? thinking : this.extractFromObj(thinking);
            const resp = obj.plannerResponse.response || obj.plannerResponse.modifiedResponse || obj.plannerResponse.message || obj.plannerResponse.text;
            return this.extractFromObj(resp || obj.plannerResponse);
        }
        if (obj.errorMessage) {
            const err = obj.errorMessage.error || obj.errorMessage || {};
            const userMsg = err.userErrorMessage || err.message || (typeof obj.errorMessage === 'string' ? obj.errorMessage : '');
            const details = err.shortError || err.fullError || err.modelErrorMessage || '';
            if (userMsg && details && details !== userMsg) return `${userMsg}\n\n${details}`;
            return userMsg || details || this.extractFromObj(obj.errorMessage);
        }
        if (obj.notifyUser) return obj.notifyUser.notificationContent || obj.notifyUser.message || this.extractFromObj(obj.notifyUser);
        if (obj.message) return this.extractFromObj(obj.message);

        // Expanded generic fields
        if (obj.thinking) return typeof obj.thinking === 'string' ? obj.thinking : this.extractFromObj(obj.thinking);
        if (obj.error) {
            const userMsg = obj.error.userErrorMessage || obj.error.message || '';
            const details = obj.error.shortError || obj.error.fullError || obj.error.modelErrorMessage || '';
            if (userMsg && details && details !== userMsg) return `${userMsg}\n\n${details}`;
            return userMsg || details || this.extractFromObj(obj.error);
        }
        if (obj.modelErrorMessage) return obj.modelErrorMessage;

        if (obj.details) return this.extractFromObj(obj.details);
        if (obj.stack) return this.extractFromObj(obj.stack);
        if (obj.description) return this.extractFromObj(obj.description);
        if (obj.summary) return this.extractFromObj(obj.summary);
        if (obj.query) return this.extractFromObj(obj.query);
        if (obj.input) return this.extractFromObj(obj.input);
        if (obj.notificationContent) return this.extractFromObj(obj.notificationContent);

        // Tool Calls
        if (obj.toolCalls && Array.isArray(obj.toolCalls)) {
            return obj.toolCalls.map((tc: any) => `[TOOL_CALL:${tc.name || 'Unknown'}]`).join('\n');
        }

        // Generic fallbacks for any object that might have 'content' or 'text' as a deeper field
        if (obj.items && Array.isArray(obj.items)) return this.extractFromObj(obj.items);
        if (obj.parts && Array.isArray(obj.parts)) return this.extractFromObj(obj.parts);

        return '';
    }

    private hasAttachments(step: any): boolean {
        return !!(step.userInput?.items?.some((i: any) => i.image || i.fileData || i.inlineData) ||
            (step.userInput?.media && Array.isArray(step.userInput.media) && step.userInput.media.length > 0) ||
            step.modelResponse?.content?.some((i: any) => i.image || i.inlineData) ||
            step.modelResponse?.parts?.some((i: any) => i.inlineData));
    }

    private renderAttachments(step: any): string {
        const lm = LocalizationManager.getInstance();
        const userInputItems = Array.isArray(step.userInput?.items) ? step.userInput.items : [];
        const userInputMedia = Array.isArray(step.userInput?.media) ? step.userInput.media : [];
        const modelResponseItems = step.modelResponse?.content || step.modelResponse?.parts || [];
        const modelItems = Array.isArray(modelResponseItems) ? modelResponseItems : [];

        const items = [...userInputItems, ...userInputMedia, ...modelItems];
        if (items.length === 0) return '';

        const attachmentsHtml = items.map((item: any) => {
            if (item.image || item.inlineData?.mimeType?.startsWith('image/') || (item.mimeType?.startsWith('image/') && item.inlineData)) {
                const data = item.image?.data || item.inlineData?.data || item.inlineData;
                const mime = item.image?.mimeType || item.inlineData?.mimeType || item.mimeType || 'image/png';
                const base64Data = typeof data === 'string' ? data : data?.data;

                const uri = item.image?.uri || item.uri;
                let fileName = item.image?.name || item.name || '';
                if (!fileName && typeof uri === 'string' && !uri.startsWith('data:')) {
                    try {
                        const cleanPath = uri.startsWith('file://') ? uri.substring(7) : uri;
                        fileName = decodeURIComponent(cleanPath).split(/[/\\]/).pop() || '';
                    } catch {
                        fileName = (uri as string).split(/[/\\]/).pop() || '';
                    }
                }
                const label = fileName || `${mime.split('/')[1].toUpperCase()}`;
                const escapedUri = (uri || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

                return `
                        <div class="attachment-item" title="${uri || ''}">
                            <img src="data:${mime};base64,${base64Data}" onclick="showImage(this.src)" alt="${label}">
                            <div class="attachment-label">
                                <span class="name">🖼️ ${label}</span>
                                <button class="copy-btn mini" title="${lm.t('Copy Link')}" onclick="copyToClipboard('${escapedUri}', this)">📋</button>
                            </div>
                        </div>
                    `;
            }
            if (item.fileData || item.file || (item.mimeType && !item.mimeType.startsWith('image/'))) {
                const name = item.fileData?.name || item.file?.name || item.name || 'File';
                const fPath = item.fileData?.path || item.file?.path || item.path || name;
                const icon = getFileIconSvg(name);
                const escapedPath = fPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

                return `
                    <div class="attachment-item file-button" onclick="openFile('${escapedPath}')">
                        <div class="attachment-icon">${icon}</div>
                        <div class="attachment-label" title="${fPath || name}">
                            <span class="name">${name}</span>
                            <button class="copy-btn mini" title="${lm.t('Copy Link')}" onclick="event.stopPropagation(); copyToClipboard('${escapedPath}', this)">📋</button>
                        </div>
                    </div>
                `;
            }
            return '';
        }).filter(Boolean).join('');

        return attachmentsHtml ? `<div class="attachment-preview">${attachmentsHtml}</div>` : '';
    }

    private parseStepDetails(step: any) {
        const lm = LocalizationManager.getInstance();
        let isUser = false;
        let isModel = false;
        let isError = false;
        let sender = lm.t('System');

        const senderStr = (step.header?.sender || step.sender || '').toUpperCase();
        const typeStr = (step.type || '').toUpperCase();
        const hasModelResponse = !!step.modelResponse;
        const hasUserInput = !!step.userInput;
        const stopReason = (step.modelResponse?.stopReason || step.plannerResponse?.stopReason || '').toUpperCase();
        const hasToolCall = !!(step.metadata?.toolCall || step.plannerResponse?.toolCall || step.modelResponse?.toolCall);

        if (typeStr === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' || step.errorMessage || stopReason.includes('ERROR') || stopReason.includes('CANCELED')) {
            isError = true;
            sender = lm.t('Error');
        } else if (typeStr === 'CORTEX_STEP_TYPE_USER_INPUT' || senderStr === 'USER' || senderStr.includes('USER') || hasUserInput) {
            isUser = true;
            sender = lm.t('User');
        } else if (typeStr === 'CORTEX_STEP_TYPE_MODEL_RESPONSE' || typeStr === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || typeStr.includes('NOTIFY_USER') || senderStr === 'MODEL' || senderStr === 'ASSISTANT' || senderStr.includes('MODEL') || senderStr.includes('AI') || hasModelResponse || hasToolCall) {
            isModel = true;
            const rawModelName = step.usage?.displayName || step.usage?.modelDisplayName || step.metadata?.modelDisplayName || step.metadata?.generatorModel || step.usage?.model || '';
            const modelName = this.getHumanReadableModelName(rawModelName);
            sender = lm.t('AI') + (modelName ? ` (${modelName})` : '');
        }

        return { isUser, isModel, isError, sender };
    }

    private getHumanReadableModelName(rawName: string): string {
        if (!rawName) return '';

        // Model Mapping Table (should be synced with package.json or config if possible, but hardcoded here for UI consistency)
        const modelMap: { [key: string]: string } = {
            'M10': 'Gemini 3 Ultra',
            'M11': 'Gemini 3 Flash',
            'M12': 'Gemini 3 Pro (High)',
            'M18': 'Gemini 3 Pro',
            'M19': 'Gemini 2.0 Flash',
            'M20': 'Claude 3.5 Haiku',
            'M21': 'Claude 3.7 Sonnet',
            'M22': 'Claude 3.7 Sonnet (Thinking)',
            'M8': 'Claude Opus 4.5 (Thinking)',
            'M1': 'Claude 3.5 Sonnet',
            'M2': 'Claude 3.5 Haiku (Old)',
            'M5': 'Claude 3 Opus',
            'M6': 'GPT-4o',
            'M7': 'GPT-4o Mini',
            'M9': 'Gemini 1.5 Pro'
        };

        // Check exact match or "clean" match
        let cleanName = rawName.replace(/^MODEL_PLACEHOLDER_|^PLACEHOLDER_|^models\//, '');

        // Sometimes the ID in the step comes as just "M12", sometimes "MODEL_PLACEHOLDER_M12"
        // Try direct lookup
        if (modelMap[cleanName]) return modelMap[cleanName];

        // Try lookup with underscore replacement? (unlikely for short codes like M12)
        // cleanName = cleanName.replace(/_/g, ' '); 

        // Fallback: Just return cleaned name
        return cleanName.replace(/_/g, ' ').trim();
    }

    private renderTokenUsage(usage: any, latencyMs: number = 0): string {
        if (!usage && latencyMs === 0) return '';
        const lm = LocalizationManager.getInstance();

        const input = parseInt(usage.inputTokens) || 0;
        const output = parseInt(usage.outputTokens) || 0;
        const thinking = parseInt(usage.thinkingOutputTokens) || 0;
        const cache = parseInt(usage.cacheReadTokens) || 0;
        const total = input + output;
        const totalWithThr = total + thinking + cache;

        if (totalWithThr === 0 && latencyMs === 0) return '';

        let html = '<div class="token-usage">';
        if (input > 0) html += `<div class="token-badge"><span class="token-icon">📥</span><span>${lm.t('Input')}: ${input.toLocaleString()}</span></div>`;
        if (output > 0) html += `<div class="token-badge"><span class="token-icon">📤</span><span>${lm.t('Output')}: ${output.toLocaleString()}</span></div>`;
        if (thinking > 0) html += `<div class="token-badge thinking"><span class="token-icon">🧠</span><span>${lm.t('Thinking')}: ${thinking.toLocaleString()}</span></div>`;
        if (cache > 0) html += `<div class="token-badge"><span class="token-icon">💾</span><span>${lm.t('Cached')}: ${cache.toLocaleString()}</span></div>`;

        if (latencyMs > 0) {
            const seconds = (latencyMs / 1000).toFixed(1);
            html += `<div class="token-badge thinking" style="border-color: rgba(255, 165, 0, 0.5);"><span class="token-icon">⏱️</span><span>${lm.t('Thinking')}: ${seconds}${lm.t('s')}</span></div>`;
        }

        html += `<div class="token-badge total" title="${lm.formatDateTime(new Date())}"><span class="token-icon">📊</span><span>${lm.t('Total')}: ${totalWithThr.toLocaleString()}</span></div>`;
        html += '</div>';

        return html;
    }

    private formatModelError(text: string, step?: any): string {
        const lm = LocalizationManager.getInstance();
        const uniqueId = `error-details-${Math.random().toString(36).substr(2, 9)}`;
        let errorCode: string | undefined;
        let detailsHtml = '';
        let displayMessage = '';

        // Strategy 1: Look in step object
        if (step && step.errorMessage?.error) {
            const errorObj = step.errorMessage.error;
            errorCode = errorObj.errorCode || errorObj.code;
            const details = errorObj.details;
            displayMessage = errorObj.message || '';

            if (errorCode || details) {
                if (details) {
                    // details is often an object or string
                    const detailsStr = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
                    try {
                        // Attempt to parse if string looks like JSON
                        const obj = typeof details === 'string' ? JSON.parse(details) : details;
                        const highlightedJson = this.highlightDiff(JSON.stringify(obj, null, 2));
                        detailsHtml = `<div class="error-raw"><pre>${highlightedJson}</pre></div>`;
                        if (!displayMessage && obj.message) displayMessage = obj.message;
                    } catch {
                        detailsHtml = `<pre>${this.highlightDiff(detailsStr)}</pre>`;
                    }
                }
            }
        }

        // Strategy 2: Look in text (fallback)
        if (!errorCode && text.includes('Encountered retryable error from model provider')) {
            const codeMatch = text.match(/errorCode"?:?\s*(\d+)/);
            const detailsMatch = text.match(/details"?:?\s*"((?:[^"\\]|\\.)*)"/);

            if (codeMatch) {
                errorCode = codeMatch[1];
                if (detailsMatch) {
                    try {
                        const jsonStr = JSON.parse(`"${detailsMatch[1]}"`);
                        try {
                            const obj = JSON.parse(jsonStr);
                            if (obj.error) {
                                if (obj.error.message) {
                                    if (!displayMessage) displayMessage = obj.error.message;
                                    detailsHtml += `<div class="error-message"><b>Message:</b> ${obj.error.message}</div>`;
                                }
                                if (obj.error.status) detailsHtml += `<div class="error-status"><b>Status:</b> ${obj.error.status}</div>`;
                                if (obj.error.details) {
                                    const highlightedDetails = this.highlightDiff(JSON.stringify(obj.error.details, null, 2));
                                    detailsHtml += `<div class="error-raw"><pre>${highlightedDetails}</pre></div>`;
                                }
                            } else {
                                detailsHtml = `<pre>${jsonStr}</pre>`;
                                if (!displayMessage && obj.message) displayMessage = obj.message;
                            }
                        } catch {
                            detailsHtml = `<pre>${this.highlightDiff(jsonStr)}</pre>`;
                        }
                    } catch {
                        detailsHtml = `<pre>${this.highlightDiff(detailsMatch[1])}</pre>`;
                    }
                }
            }
        }

        if (errorCode || (text.includes('Encountered retryable error') && detailsHtml)) {
            const headerText = `${lm.t('Model Provider Error')}${errorCode ? ' ' + errorCode : ''}`;
            return `
                    <div class="model-error-card" style="border: 1px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); padding: 6px 10px; border-radius: 4px; margin: 6px 0; position: relative; font-size: 0.9em;">
                        <div class="error-header" style="display: flex; align-items: center; margin-bottom: 4px; color: var(--vscode-errorForeground);">
                            <span class="icon" style="margin-right: 6px;">⚠️</span>
                            <strong style="font-size: 1.05em; opacity: 0.9;">${headerText}</strong>
                        </div>
                        <div class="error-body" style="font-family: var(--vscode-editor-font-family); white-space: pre-wrap; line-height: 1.3;">
                            ${(() => {
                    const bodyParts: string[] = [];
                    const mainMsg = displayMessage && displayMessage !== lm.t('Model Provider Error') ? displayMessage : '';

                    if (mainMsg) {
                        bodyParts.push(`<div style="font-weight: 600; margin-bottom: 2px;">${mainMsg}</div>`);
                    }

                    if (detailsHtml) {
                        // Remove excessive margins from pre tags in detailsHtml
                        const cleanedDetails = detailsHtml.replace(/<pre>/g, '<pre style="margin: 4px 0; padding: 4px; background: rgba(0,0,0,0.2); border-radius: 3px;">');
                        bodyParts.push(`<div style="opacity: 0.9; font-size: 0.95em;">${cleanedDetails}</div>`);
                    } else {
                        let rawText = text.replace(/errorCode[\s\S]*}/, '').split('details')[0].trim();
                        rawText = rawText.replace(/^[{},]+|[{},]+$/g, '').trim();
                        if (rawText && rawText !== mainMsg && rawText !== lm.t('Model Provider Error') && !mainMsg.includes(rawText)) {
                            bodyParts.push(`<div style="opacity: 0.85; font-size: 0.9em;">${rawText}</div>`);
                        }
                    }

                    return bodyParts.join('');
                })()}
                        </div>
                    </div>
                `;
        }

        return text;
    }
}

