import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as nodeCrypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const markdownit = require('markdown-it');


import extract from 'extract-zip';
import { GoogleAuthProvider, escapeHtml } from './googleAuth';
import { GoogleDriveService, SyncManifest, SyncedConversation, Machine, MachineState, FileHashInfo } from './googleDrive';
import { StorageService, LocalStorageService } from './localStorage';
import * as crypto from './crypto';
import { LocalizationManager } from './l10n/localizationManager';
import { getConversationsAsync, limitConcurrency, formatDuration, ConversationItem, getStoragePaths } from './utils';
import { validateExtractedDirectory } from './ideState';
import { SyncStatsWebview, SyncStatsData } from './quota/syncStatsWebview';
import { QuotaManager } from './quota/quotaManager';
import { drawProgressBar } from './quota/utils';
import { AntigravityClient, SearchResult } from './quota/antigravityClient';
import { PbParser } from './quota/pbParser';
import { getFileIconSvg } from './quota/fileIcons';

const EXT_NAME = 'antigravity-storage-manager';
const getStorageRoot = () => getStoragePaths().storageRoot;
const getBrainDir = () => getStoragePaths().brainDir;
const getConvDir = () => getStoragePaths().convDir;
const getDefaultSyncBackupDir = () => path.join(getStorageRoot(), 'sync-backups');
const SECRET_KEY = `${EXT_NAME}.sync.masterPassword`;
const LEGACY_SECRET_KEY = 'ag-sync-master-password';
const DEFAULT_LOCK_TTL_MS = 300000; // 5 minutes
const MIN_SYNC_INTERVAL_MS = 10000;
const MAX_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

function compareDeterministic(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function isSafeLocalFsPath(p: string): boolean {
    if (!p || typeof p !== 'string' || p.includes('\0')) return false;
    // Block UNC / network share paths to prevent SMB/NTLM leakage on Windows
    if (/^(\\\\|\/\/)/.test(p)) return false;
    return true;
}

function isSqliteRelatedPath(relativePath: string): boolean {
    return relativePath.endsWith('.db') || relativePath.endsWith('.db-wal');
}

async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fs.promises.writeFile(tmpPath, data);
        await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        throw err;
    }
}

export type ManifestFetchResult =
    | { status: 'ok'; manifest: SyncManifest }
    | { status: 'not_found' }
    | { status: 'error'; error: Error };

export interface SyncConfig {
    enabled: boolean; // Deprecated, use autoSync? No, enabled is overall switch
    machineId: string;
    machineName: string;
    selectedConversations: string[] | 'all';
    archivedConversations?: string[];
    autoSync: boolean;
    syncInterval: number; // ms
    lastSync: string | null;
    showStatusBar: boolean;
    silent: boolean;
}

const ARCHIVED_CONVERSATIONS_KEY = 'antigravity-storage-manager.archivedConversations';



export interface SyncResult {
    success: boolean;
    pushed: string[];
    pulled: string[];
    conflicts: SyncConflict[];
    errors: string[];
    missingRemoteIds?: string[];
    cancelled?: boolean;
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

export type ConflictResolution = 'keepLocal' | 'keepRemote' | 'keepBoth' | 'keepNewer' | 'keepLarger';

/**
 * Main sync manager for coordinating conversation synchronization
 */
export class SyncManager implements vscode.Disposable {
    private lastDashboardUpdate: number = 0;
    private context: vscode.ExtensionContext;
    private authProvider: GoogleAuthProvider;
    private driveService: StorageService;
    private config: SyncConfig | null = null;
    private masterPassword: string | null = null;
    private lastHistory: Uint8Array | null = null;
    private lastTaskName: string = '';
    private lastTaskSummary: string = '';
    private autoSyncTimer: NodeJS.Timeout | null = null;
    private okStatusTimer: NodeJS.Timeout | null = null;
    private nextAutoSyncTime: number | null = null;
    private isSyncing: boolean = false;
    private syncCount: number = 0;
    private uploadCount: number = 0;
    private downloadCount: number = 0;
    private fileHashCache: Map<string, { mtime: number; size: number; hash: string }> = new Map();
    private cachedManifest: SyncManifest | null = null;
    private lastManifestFetch: number = 0;
    private activeTransfers: Map<string, { title: string; type: 'upload' | 'download'; startTime: number }> = new Map();
    private lastStatsData: any | null = null;
    private manifestUpdateQueue: Promise<void> = Promise.resolve();
    private quotaManager: QuotaManager | null = null;
    private lastActiveConversationId?: string;
    private configChangeDisposable: vscode.Disposable | null = null;
    private renderDiffStore: Map<string, string> | null = null;

    // Concurrency control and Sync Toggle
    private isRefreshing: boolean = false;
    private isSyncEnabled: boolean = true;

    // Status bar item for sync status
    private statusBarItem: vscode.StatusBarItem | null = null;
    private apiClient = new AntigravityClient();
    private md: any;
    private preSyncBackupCount: number = 0;

    constructor(
        context: vscode.ExtensionContext,
        authProvider: GoogleAuthProvider
    ) {
        this.context = context;
        this.authProvider = authProvider;
        this.driveService = this.createStorageService();

        if (typeof vscode.workspace?.onDidChangeConfiguration === 'function') {
            this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration(`${EXT_NAME}.sync.storageProvider`) ||
                    e.affectsConfiguration(`${EXT_NAME}.sync.localPath`)
                ) {
                    this.reloadStorageProvider();
                }
                if (
                    e.affectsConfiguration(`${EXT_NAME}.sync.autoSync`) ||
                    e.affectsConfiguration(`${EXT_NAME}.sync.syncInterval`) ||
                    e.affectsConfiguration(`${EXT_NAME}.sync.showStatusBar`) ||
                    e.affectsConfiguration(`${EXT_NAME}.sync.machineName`)
                ) {
                    this.applyWorkspaceSyncSettings();
                }
            });
        }

        try {
            const MD = (markdownit as any).default || markdownit;
            if (typeof MD === 'function') {
                this.md = new MD({
                    html: false,
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

    private createStorageService(): StorageService {
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const storageProvider = config.get<string>('sync.storageProvider', 'google-drive');

        if (storageProvider === 'local') {
            const localPath = (config.get<string>('sync.localPath', '') || '').trim();
            if (localPath) {
                return new LocalStorageService(localPath);
            }
        }
        return new GoogleDriveService(this.authProvider);
    }

    private reloadStorageProvider(): void {
        if (this.isSyncing) {
            console.warn('[SyncManager] Storage provider changed while syncing; cache invalidated.');
        }
        if (this.driveService && typeof (this.driveService as any).dispose === 'function') {
            (this.driveService as any).dispose();
        }
        this.driveService = this.createStorageService();
        this.cachedManifest = null;
        this.lastManifestFetch = 0;
        this.updateStatusBar('idle');
    }

    private getEffectiveMachineName(): string {
        const configName = vscode.workspace.getConfiguration(EXT_NAME).get<string>('sync.machineName')?.trim();
        return (configName || this.config?.machineName || os.hostname()).trim();
    }

    private applyWorkspaceSyncSettings(): void {
        const wsConfig = vscode.workspace.getConfiguration(EXT_NAME);
        const autoSync = wsConfig.get<boolean>('sync.autoSync');
        const syncInterval = wsConfig.get<number>('sync.syncInterval');
        const showStatusBar = wsConfig.get<boolean>('sync.showStatusBar');
        const machineNameSetting = wsConfig.get<string>('sync.machineName')?.trim();

        if (this.config) {
            if (typeof autoSync === 'boolean') this.config.autoSync = autoSync;
            if (typeof syncInterval === 'number' && syncInterval > 0) this.config.syncInterval = syncInterval;
            if (typeof showStatusBar === 'boolean') this.config.showStatusBar = showStatusBar;
            if (machineNameSetting && this.config.machineName !== machineNameSetting) {
                this.config.machineName = machineNameSetting;
                void this.saveConfig();
            }
        }

        if (this.config?.enabled && this.config?.autoSync && this.isReady() && this.isSyncEnabled) {
            this.startAutoSync();
        } else {
            this.stopAutoSync();
        }
        this.updateStatusBar(this.isSyncing ? 'syncing' : 'idle');
    }

    public dispose(): void {
        this.stopAutoSync();
        if (this.okStatusTimer) {
            clearTimeout(this.okStatusTimer);
            this.okStatusTimer = null;
        }
        if (this.configChangeDisposable) {
            this.configChangeDisposable.dispose();
            this.configChangeDisposable = null;
        }
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
            this.statusBarItem = null;
        }
        if (this.driveService && typeof (this.driveService as any).dispose === 'function') {
            (this.driveService as any).dispose();
        }
    }

    private isLocalStorage(): boolean {
        return this.driveService instanceof LocalStorageService;
    }

    public setQuotaManager(quotaManager: QuotaManager) {
        this.quotaManager = quotaManager;
    }

    /**
     * Initialize sync manager
     */
    async initialize(): Promise<void> {
        await this.loadConfig();

        // Sync runtime config with workspace settings
        if (this.config) {
            const wsConfig = vscode.workspace.getConfiguration(EXT_NAME);
            const autoSync = wsConfig.get<boolean>('sync.autoSync');
            const syncInterval = wsConfig.get<number>('sync.syncInterval');
            const showStatusBar = wsConfig.get<boolean>('sync.showStatusBar');
            const machineNameSetting = wsConfig.get<string>('sync.machineName')?.trim();
            if (typeof autoSync === 'boolean') this.config.autoSync = autoSync;
            if (typeof syncInterval === 'number' && syncInterval > 0) this.config.syncInterval = syncInterval;
            if (typeof showStatusBar === 'boolean') this.config.showStatusBar = showStatusBar;
            if (machineNameSetting && this.config.machineName !== machineNameSetting) {
                this.config.machineName = machineNameSetting;
                await this.saveConfig();
            }
        }

        // Load master password from secrets
        let storedPassword = await this.context.secrets.get(SECRET_KEY);
        if (!storedPassword) {
            // Migration: check legacy key (fixes #7 — key mismatch)
            storedPassword = await this.context.secrets.get(LEGACY_SECRET_KEY);
            if (storedPassword) {
                await this.context.secrets.store(SECRET_KEY, storedPassword);
                await this.context.secrets.delete(LEGACY_SECRET_KEY);
                console.log('[SyncManager] Migrated master password from legacy key');
            }
        }
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
            this.nextAutoSyncTime = Date.now() + this.config.syncInterval;
        }
    }

    /**
     * Check if sync is ready (authenticated or local storage, and configured)
     */
    isReady(): boolean {
        const authOk = this.isLocalStorage() || this.authProvider.isAuthenticated();
        return authOk &&
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
    async syncNow(progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken, force: boolean = false): Promise<SyncResult> {
        const lm = LocalizationManager.getInstance();

        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        if (this.isSyncing) {
            return {
                success: false,
                pushed: [],
                pulled: [],
                conflicts: [],
                errors: [lm.t('Sync already in progress')]
            };
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

        // Set lock synchronously BEFORE any async work (including force flush)
        this.isSyncing = true;
        this.updateStatusBar('syncing');

        const result: SyncResult = {
            success: true,
            pushed: [],
            pulled: [],
            conflicts: [],
            errors: [],
            missingRemoteIds: []
        };

        let wasCancelled = false;

        try {
            if (force) {
                try {
                    this.reportProgress(progress, lm.t('Flushing server state...'));
                    const flushed = await this.apiClient.sendAllQueuedMessages();
                    if (flushed) {
                        // Wait briefly for server to finish flushing WAL to disk
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } catch (e) {
                    console.error('Force sync: flush failed', e);
                }
            }

            if (token?.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            // Try to acquire distributed lock
            this.reportProgress(progress, lm.t('Acquiring sync lock...'));
            const machineId = this.config!.machineId;
            const acquired = await this.driveService.acquireLock(machineId, DEFAULT_LOCK_TTL_MS);
            if (!acquired) {
                throw new Error(lm.t('Sync is currently locked by another machine. Please try again later.'));
            }

            try {
                // Get remote manifest (never recreates on transient/password errors)
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

                // Collect archived conversation IDs (excluded from all sync operations)
                const archivedIds = this.getArchivedConversationIds(remoteManifest);

                // Determine which conversations to sync (always copy array, never mutate config!)
                const rawToSync = this.config!.selectedConversations === 'all'
                    ? localConversations.map(c => c.id)
                    : [...this.config!.selectedConversations];
                const toSync = rawToSync.filter(id => !archivedIds.has(id));

                // Include new remote conversations only in 'all' mode (respect selective sync & archive)
                if (this.config!.selectedConversations === 'all') {
                    for (const remote of remoteManifest.conversations) {
                        if (!archivedIds.has(remote.id) && !toSync.includes(remote.id)) {
                            const local = localConversations.find(c => c.id === remote.id);
                            if (!local) {
                                toSync.push(remote.id);
                            }
                        }
                    }
                }

                const failedConvIds = new Set<string>();

                // Process conversations in parallel chunks using allSettled so all tasks finish before releaseLock
                this.reportProgress(progress, lm.t('Starting synchronization...'));
                const chunkSize = 5;
                for (let i = 0; i < toSync.length; i += chunkSize) {
                    if (token?.isCancellationRequested) throw new vscode.CancellationError();
                    const chunk = toSync.slice(i, i + chunkSize);
                    const settlements = await Promise.allSettled(chunk.map(async (convId) => {
                        if (token?.isCancellationRequested) throw new vscode.CancellationError();
                        const errorsBefore = result.errors.length;
                        await this.processSyncItem(convId, localConversations, remoteManifest, lastSyncedConversations, result, progress, token, force);
                        if (result.errors.length > errorsBefore) {
                            failedConvIds.add(convId);
                        }
                    }));

                    for (const s of settlements) {
                        if (s.status === 'rejected') {
                            if (s.reason instanceof vscode.CancellationError) {
                                throw s.reason;
                            }
                            result.errors.push(s.reason?.message || String(s.reason));
                        }
                    }
                }

                if (token?.isCancellationRequested) throw new vscode.CancellationError();

                // Exclude conflicted, failed, and archived conversations from overwriting lastSyncedHash
                const excludedIds = new Set<string>(failedConvIds);
                for (const c of result.conflicts) {
                    excludedIds.add(c.conversationId);
                }
                for (const archivedId of archivedIds) {
                    excludedIds.add(archivedId);
                }

                const effectiveMachineName = this.getEffectiveMachineName();
                if (this.config!.machineName !== effectiveMachineName) {
                    this.config!.machineName = effectiveMachineName;
                }

                // Ensure remote manifest carries the current effective machine name
                const manifestMachine = remoteManifest.machines?.find(m => m.id === this.config!.machineId);
                if (!manifestMachine || manifestMachine.name !== effectiveMachineName) {
                    await this.enqueueManifestUpdate((manifest) => {
                        if (!manifest.machines) manifest.machines = [];
                        const nowIso = new Date().toISOString();
                        const idx = manifest.machines.findIndex(m => m.id === this.config!.machineId);
                        const existing = idx >= 0 ? manifest.machines[idx] : null;
                        const updated: Machine = {
                            id: this.config!.machineId,
                            name: effectiveMachineName,
                            lastSync: nowIso,
                            createdAt: existing?.createdAt || nowIso
                        };
                        if (idx >= 0) {
                            manifest.machines[idx] = updated;
                        } else {
                            manifest.machines.push(updated);
                        }
                        return true;
                    });
                }

                this.config!.lastSync = new Date().toISOString();
                this.syncCount++;
                await this.saveConfig();
                await this.updateMachineState(excludedIds, lastSyncedConversations);

                result.success = result.errors.length === 0;

            } finally {
                await this.driveService.releaseLock(machineId);
            }
        } catch (error: any) {
            if (error instanceof vscode.CancellationError) {
                wasCancelled = true;
                result.cancelled = true;
                result.success = false;
                throw error;
            }
            result.success = false;
            result.errors.push(error?.message || String(error));
        } finally {
            this.isSyncing = false;
            if (wasCancelled) {
                this.updateStatusBar('idle');
            } else {
                this.updateStatusBar(
                    result.success ? 'ok' : 'error',
                    result.success ? undefined : result.errors.join('\n')
                );
            }

            if (SyncStatsWebview.isVisible()) {
                this.updateDashboardIfVisible();
            }

            // Error suggestions using structured missingRemoteIds
            const missingIds = result.missingRemoteIds || [];
            if (!wasCancelled && missingIds.length > 0) {
                const suggestSolutions = vscode.workspace.getConfiguration(EXT_NAME).get('sync.suggestSolutions', true);

                if (suggestSolutions) {
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
                            await this.fixMissingRemoteConversations(missingIds);
                        } else if (selection === pushAction) {
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
     * Remove missing conversations from remote manifest.
     * Accepts either direct conversation IDs or legacy error message strings.
     */
    async fixMissingRemoteConversations(idsOrErrors: string[]): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const ids = new Set<string>();
        const regex = /Conversation ([a-f0-9-]+) not found/i;
        const uuidLike = /^[a-zA-Z0-9_-]+$/;

        for (const item of idsOrErrors) {
            const match = item.match(regex);
            if (match && match[1]) {
                ids.add(match[1]);
            } else if (uuidLike.test(item)) {
                ids.add(item);
            }
        }

        if (ids.size === 0) return;

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: lm.t('Fixing manifest...'),
                cancellable: false
            }, async () => {
                let removedCount = 0;
                await this.enqueueManifestUpdate((manifest) => {
                    const initialCount = manifest.conversations.length;
                    manifest.conversations = manifest.conversations.filter(c => !ids.has(c.id));
                    removedCount = initialCount - manifest.conversations.length;
                    return removedCount > 0;
                });

                if (removedCount > 0) {
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
            const config = vscode.workspace.getConfiguration(EXT_NAME);
            const keepLocalFiles = config.get<boolean>('sync.keepLocalFiles', true);
            const hasLocalDb = Boolean(localData.fileHashes[`conversations/${conversationId}.db`]);
            const walRelPath = `conversations/${conversationId}.db-wal`;
            const staleWalDeleted = hasLocalDb && !localData.fileHashes[walRelPath] && Boolean(remoteHashes[walRelPath]);

            // Ensure SQLite (.db + .db-wal) are pushed together as a consistent unit if either changed
            const dbRelPath = `conversations/${conversationId}.db`;
            if (
                localData.fileHashes[dbRelPath] &&
                localData.fileHashes[walRelPath] &&
                (filesToUpload.includes(dbRelPath) || filesToUpload.includes(walRelPath))
            ) {
                if (!filesToUpload.includes(dbRelPath)) filesToUpload.push(dbRelPath);
                if (!filesToUpload.includes(walRelPath)) filesToUpload.push(walRelPath);
            }

            const preservedRemotePaths = new Set<string>();
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
                if (isFirstSync || keepLocalFiles) {
                    const reason = isFirstSync
                        ? `First sync for ${conversationId}`
                        : `keepLocalFiles is enabled for ${conversationId}`;
                    // Keep non-WAL remote files in manifest so they do not become orphaned,
                    // but ALWAYS delete stale .db-wal when local .db has checkpointed!
                    const actuallyToDelete: string[] = [];
                    for (const p of filesToDelete) {
                        if (p === walRelPath && staleWalDeleted) {
                            actuallyToDelete.push(p);
                        } else {
                            preservedRemotePaths.add(p);
                        }
                    }
                    if (preservedRemotePaths.size > 0) {
                        console.warn(`[Push] ${reason}, preserving ${preservedRemotePaths.size} remote file(s) in manifest.`);
                    }
                    filesToDelete.length = 0;
                    filesToDelete.push(...actuallyToDelete);
                } else {
                    console.warn(`[Push] Found ${filesToDelete.length} files missing locally for conversation ${conversationId}. Will delete from remote:`, filesToDelete);
                }
            }

            // Build effective fileHashes map from actual uploaded buffers + preserved remote entries
            const effectiveFileHashes: { [relativePath: string]: FileHashInfo } = { ...localData.fileHashes };
            for (const preservedPath of preservedRemotePaths) {
                if (remoteHashes[preservedPath]) {
                    effectiveFileHashes[preservedPath] = remoteHashes[preservedPath];
                }
            }

            // Upload changed files
            let uploadedCount = 0;
            const concurrency = Math.max(1, config.get<number>('sync.concurrency', 3));

            await limitConcurrency(filesToUpload, concurrency, async (relativePath) => {
                if (token?.isCancellationRequested) throw new vscode.CancellationError();

                uploadedCount++;
                this.uploadCount++;
                this.reportProgress(progress, lm.t('Uploading "{0}": {1} ({2}/{3})...', convTitle, relativePath, uploadedCount, filesToUpload.length));

                // Read file once and compute hash from the exact buffer being encrypted & uploaded
                const fullPath = this.getFullPathForRelative(conversationId, relativePath);
                const content = await fs.promises.readFile(fullPath);
                const stats = await fs.promises.stat(fullPath);
                const actualHash = crypto.computeMd5Hash(content);

                const useCompression = config.get<boolean>('sync.enableCompression', true);
                const encrypted = crypto.encrypt(content, this.masterPassword!, useCompression);

                await this.driveService.uploadConversationFile(conversationId, relativePath, encrypted, actualHash);

                // Update effective hashes and local hash cache to match exact uploaded buffer
                effectiveFileHashes[relativePath] = {
                    hash: actualHash,
                    size: content.length,
                    lastModified: stats.mtime.toISOString()
                };
                this.fileHashCache.set(fullPath, { mtime: stats.mtimeMs, size: stats.size, hash: actualHash });
            }, token);

            // Delete removed files from remote
            for (const relativePath of filesToDelete) {
                if (token?.isCancellationRequested) throw new vscode.CancellationError();
                await this.driveService.deleteConversationFile(conversationId, relativePath);
                delete effectiveFileHashes[relativePath];
            }

            // Only update manifest if we actually made changes (or found existing files that needed to be recorded)
            if (filesToUpload.length > 0 || filesToDelete.length > 0 || skippedCount > 0) {
                const effectiveOverallHash = this.computeOverallHashFromFileHashes(effectiveFileHashes);
                const effectiveMaxMtime = Math.max(
                    localData.maxMtime,
                    ...Object.values(effectiveFileHashes).map(f => Date.parse(f.lastModified) || 0)
                );

                await this.updateManifestEntryWithFileHashes(
                    conversationId,
                    effectiveOverallHash,
                    effectiveFileHashes,
                    effectiveMaxMtime > 0 ? new Date(effectiveMaxMtime).toISOString() : undefined
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

    async reindexConversations(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: lm.t('Reindexing conversations...'),
            cancellable: false
        }, async () => {
            // 1. Force refresh of local conversation list
            const localConversations = await getConversationsAsync(getBrainDir());

            // 2. Check for "orphaned" folders that might be valid conversations but missing metadata
            try {
                let recovered = 0;
                const brainRoot = getBrainDir();
                if (fs.existsSync(brainRoot)) {
                    const entries = await fs.promises.readdir(brainRoot);
                    for (const id of entries) {
                        // If not in localConversations, check if it looks like a conversation
                        if (!localConversations.find(c => c.id === id)) {
                            const dirPath = path.join(brainRoot, id);
                            try {
                                const stats = await fs.promises.stat(dirPath);
                                if (stats.isDirectory()) {
                                    console.log(`[Reindex] Found potential orphan: ${id}`);
                                    const files = await fs.promises.readdir(dirPath);
                                    if (files.length > 0) recovered++;
                                }
                            } catch { /* ignore unreadable entries */ }
                        }
                    }
                }

                // 3. Name-based mapping: check remote manifest for conversations missing locally (Issue #6)
                let remoteOnlyCount = 0;
                if (this.isReady()) {
                    try {
                        const manifest = await this.getDecryptedManifest(true);
                        if (manifest && manifest.conversations.length > 0) {
                            const localIds = new Set(localConversations.map(c => c.id));
                            const localTitles = new Map<string, string>(); // title -> id
                            for (const c of localConversations) {
                                if (c.label && c.label !== c.id) {
                                    localTitles.set(c.label.toLowerCase(), c.id);
                                }
                            }

                            const missingRemote: SyncedConversation[] = [];
                            const titleMatched: { remote: SyncedConversation; localId: string }[] = [];

                            for (const remote of manifest.conversations) {
                                if (!localIds.has(remote.id)) {
                                    // Not found by ID — try name-based matching
                                    const matchedLocalId = remote.title
                                        ? localTitles.get(remote.title.toLowerCase())
                                        : undefined;

                                    if (matchedLocalId) {
                                        titleMatched.push({ remote, localId: matchedLocalId });
                                    } else {
                                        missingRemote.push(remote);
                                    }
                                }
                            }

                            if (titleMatched.length > 0) {
                                console.log(`[Reindex] Found ${titleMatched.length} conversation(s) matched by title (name-based mapping):`);
                                for (const match of titleMatched) {
                                    console.log(`  Remote "${match.remote.title}" (${match.remote.id}) => Local (${match.localId})`);
                                }

                                // Issue #6: Offer automatic re-linking
                                const relinkAction = lm.t('Re-link All');
                                const titles = titleMatched.slice(0, 5).map(m => m.remote.title || m.remote.id).join(', ');
                                const suffix = titleMatched.length > 5 ? ` (+${titleMatched.length - 5})` : '';

                                const relinkChoice = await vscode.window.showInformationMessage(
                                    lm.t('Found {0} conversation(s) matched by workspace name: {1}{2}. Re-link them to current workspace?',
                                        titleMatched.length, titles, suffix),
                                    relinkAction
                                );

                                if (relinkChoice === relinkAction) {
                                    for (const match of titleMatched) {
                                        try {
                                            // Pull remote data using the remote conversation ID
                                            // then copy/symlink brain data from remote ID to local ID
                                            const remoteBrainDir = path.join(getBrainDir(), match.remote.id);
                                            const localBrainDir = path.join(getBrainDir(), match.localId);

                                            // Pull the remote conversation if not already on disk
                                            if (!fs.existsSync(remoteBrainDir)) {
                                                await this.pullConversation(match.remote.id);
                                            }

                                            // Copy files from remote ID folder to local ID folder (merge)
                                            if (fs.existsSync(remoteBrainDir) && remoteBrainDir !== localBrainDir) {
                                                const remoteFiles = await fs.promises.readdir(remoteBrainDir, { withFileTypes: true });
                                                for (const entry of remoteFiles) {
                                                    const srcPath = path.join(remoteBrainDir, entry.name);
                                                    const destPath = path.join(localBrainDir, entry.name);
                                                    if (!fs.existsSync(destPath)) {
                                                        if (entry.isDirectory()) {
                                                            fs.cpSync(srcPath, destPath, { recursive: true });
                                                        } else {
                                                            fs.copyFileSync(srcPath, destPath);
                                                        }
                                                    }
                                                }
                                                console.log(`[Reindex] Re-linked "${match.remote.title}" (${match.remote.id}) => (${match.localId})`);
                                            }
                                        } catch (e: any) {
                                            console.error(`[Reindex] Failed to re-link ${match.remote.id}: ${e.message}`);
                                        }
                                    }
                                    vscode.window.showInformationMessage(
                                        lm.t('Re-linked {0} conversation(s) to current workspace.', titleMatched.length)
                                    );
                                }
                            }

                            remoteOnlyCount = missingRemote.length;

                            if (missingRemote.length > 0) {
                                const pullAction = lm.t('Pull Missing');
                                const titles = missingRemote.slice(0, 5).map(c => c.title || c.id).join(', ');
                                const suffix = missingRemote.length > 5 ? ` (+${missingRemote.length - 5})` : '';

                                const choice = await vscode.window.showInformationMessage(
                                    lm.t('Found {0} remote conversation(s) not present locally: {1}{2}. Would you like to pull them?',
                                        missingRemote.length, titles, suffix),
                                    pullAction
                                );

                                if (choice === pullAction) {
                                    for (const remote of missingRemote) {
                                        try {
                                            await this.pullConversation(remote.id);
                                        } catch (e: any) {
                                            console.error(`[Reindex] Failed to pull ${remote.id}: ${e.message}`);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e: any) {
                        console.warn(`[Reindex] Could not check remote manifest: ${e.message}`);
                    }
                }

                if (recovered > 0) {
                    vscode.window.showInformationMessage(
                        lm.t('Found {0} potential orphaned conversations. Please check specific folders in {1}.', recovered, getBrainDir())
                    );
                } else if (remoteOnlyCount === 0) {
                    vscode.window.showInformationMessage(lm.t('Reindex complete. Found {0} conversations.', localConversations.length));
                }

                // Trigger a refresh of the Sidebar / UI if we have a way to do it.
                // Usually this happens via file watcher or command. 
                // We'll trust that getConversationsAsync being called later (by UI) will see them.

            } catch (e: any) {
                vscode.window.showErrorMessage(lm.t('Reindex failed: {0}', e.message));
            }
        });
    }

    /**
     * Get full local path for a relative path with strict containment checks (prevents Path Traversal)
     */
    private getFullPathForRelative(conversationId: string, relativePath: string): string {
        if (!relativePath || relativePath.includes('\0')) {
            throw new Error(`Invalid relative path: ${relativePath}`);
        }
        const normalized = relativePath.replace(/\\/g, '/');
        const segments = normalized.split('/');
        if (segments.some(s => s === '..')) {
            throw new Error(`Path traversal detected in relative path: ${relativePath}`);
        }

        if (normalized.startsWith('conversations/')) {
            const sub = normalized.slice('conversations/'.length);
            const baseDir = path.resolve(getConvDir());
            const resolved = path.resolve(baseDir, sub);
            if (!resolved.startsWith(baseDir + path.sep)) {
                throw new Error(`Path escapes conversations directory: ${relativePath}`);
            }
            return resolved;
        } else if (normalized.startsWith('brain/')) {
            const sub = normalized.slice('brain/'.length);
            const baseDir = path.resolve(getBrainDir());
            const resolved = path.resolve(baseDir, sub);
            if (!resolved.startsWith(baseDir + path.sep)) {
                throw new Error(`Path escapes brain directory: ${relativePath}`);
            }
            return resolved;
        }
        throw new Error(`Unknown path format: ${relativePath}`);
    }

    /**
     * Pull a single conversation from storage (per-file sync with legacy fallback)
     */
    async pullConversation(
        conversationId: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken,
        forceOverwrite: boolean = false
    ): Promise<void> {
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

        const convTitle = remoteConv.title || this.getConversationTitle(conversationId);
        this.activeTransfers.set(conversationId, { title: convTitle, type: 'download', startTime: Date.now() });
        this.updateDashboardIfVisible();

        try {
            if (remoteConv.version === 2 && remoteConv.fileHashes) {
                await this.pullConversationPerFile(conversationId, convTitle, remoteConv.fileHashes, progress, token, forceOverwrite);
            } else {
                await this.pullConversationLegacy(conversationId, convTitle, progress, token);
            }
        } finally {
            this.activeTransfers.delete(conversationId);
            this.updateDashboardIfVisible();
        }
    }

    /**
     * Pull conversation using per-file sync (new format) with SQLite WAL unit atomicity
     */
    private async pullConversationPerFile(
        conversationId: string,
        convTitle: string,
        remoteHashes: { [relativePath: string]: FileHashInfo },
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken,
        forceOverwrite: boolean = false
    ): Promise<void> {
        const lm = LocalizationManager.getInstance();
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        this.reportProgress(progress, lm.t('Analyzing "{0}"...', convTitle));
        const localData = await this.computeConversationFileHashesAsync(conversationId);
        const localHashes = localData.fileHashes;

        const dbRelPath = `conversations/${conversationId}.db`;
        const walRelPath = `conversations/${conversationId}.db-wal`;

        // Determine if SQLite unit (.db + .db-wal) differs
        const remoteHasDb = Boolean(remoteHashes[dbRelPath]);
        const remoteHasWal = Boolean(remoteHashes[walRelPath]);
        const dbChanged = remoteHasDb && (!localHashes[dbRelPath] || localHashes[dbRelPath].hash !== remoteHashes[dbRelPath].hash);
        const walChanged = remoteHasWal && (!localHashes[walRelPath] || localHashes[walRelPath].hash !== remoteHashes[walRelPath].hash);
        const walRemovedRemotely = remoteHasDb && !remoteHasWal && Boolean(localHashes[walRelPath]);
        let pullSqliteUnit = dbChanged || walChanged || walRemovedRemotely;

        if (pullSqliteUnit && !forceOverwrite && localHashes[dbRelPath]) {
            const remoteUnitMax = Math.max(
                Date.parse(remoteHashes[dbRelPath]?.lastModified || '') || 0,
                Date.parse(remoteHashes[walRelPath]?.lastModified || '') || 0
            );
            const localUnitMax = Math.max(
                Date.parse(localHashes[dbRelPath]?.lastModified || '') || 0,
                Date.parse(localHashes[walRelPath]?.lastModified || '') || 0
            );
            if (remoteUnitMax > 0 && localUnitMax > 0 && remoteUnitMax < localUnitMax) {
                console.warn(`[Pull] Skipping SQLite unit for ${conversationId}: remote unit is older than local`);
                pullSqliteUnit = false;
            }
        }

        const filesToDownload: string[] = [];
        const sqliteFilesToDownload: string[] = [];
        const filesToDelete: string[] = [];
        let skippedOlderCount = 0;

        for (const [relativePath, remoteInfo] of Object.entries(remoteHashes)) {
            if (isSqliteRelatedPath(relativePath)) {
                if (pullSqliteUnit) {
                    sqliteFilesToDownload.push(relativePath);
                }
                continue;
            }

            const localInfo = localHashes[relativePath];
            if (!localInfo || localInfo.hash !== remoteInfo.hash) {
                if (!forceOverwrite && localInfo && remoteInfo.lastModified && localInfo.lastModified) {
                    const remoteDate = new Date(remoteInfo.lastModified).getTime();
                    const localDate = new Date(localInfo.lastModified).getTime();
                    if (remoteDate < localDate) {
                        console.warn(`[Pull] Skipping ${relativePath}: remote version is older than local (${remoteInfo.lastModified} < ${localInfo.lastModified})`);
                        skippedOlderCount++;
                        continue;
                    }
                }
                filesToDownload.push(relativePath);
            }
        }

        if (skippedOlderCount > 0) {
            console.warn(`[Pull] Skipped ${skippedOlderCount} file(s) for ${conversationId}: remote version is older than local`);
        }

        // Files that exist locally but not remotely
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const keepLocalFiles = config.get<boolean>('sync.keepLocalFiles', true);
        for (const localPath of Object.keys(localHashes)) {
            if (!remoteHashes[localPath] && !isSqliteRelatedPath(localPath)) {
                filesToDelete.push(localPath);
            }
        }

        if (keepLocalFiles && filesToDelete.length > 0) {
            console.warn(`[Pull] keepLocalFiles is enabled, skipping local deletion for ${filesToDelete.length} file(s) for conversation ${conversationId}.`);
            filesToDelete.length = 0;
        }

        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        const totalDownloads = filesToDownload.length + sqliteFilesToDownload.length;

        // Create pre-sync backup before overwriting any local files
        if (totalDownloads > 0 || filesToDelete.length > 0 || (pullSqliteUnit && walRemovedRemotely)) {
            await this.backupConversationBeforePull(conversationId, convTitle, progress);
        }

        let downloadedCount = 0;
        const concurrency = Math.max(1, config.get<number>('sync.concurrency', 3));

        // 1. Download and atomically stage SQLite unit (.db + .db-wal) together
        if (pullSqliteUnit) {
            const stagedSqlite: Array<{ targetPath: string; tmpPath: string; hash: string; size: number }> = [];
            try {
                for (const relativePath of sqliteFilesToDownload) {
                    if (token?.isCancellationRequested) throw new vscode.CancellationError();
                    downloadedCount++;
                    this.downloadCount++;
                    this.reportProgress(progress, lm.t('Downloading "{0}": {1} ({2}/{3})...', convTitle, relativePath, downloadedCount, totalDownloads));

                    const encrypted = await this.driveService.downloadConversationFile(conversationId, relativePath);
                    if (!encrypted) {
                        throw new Error(`Conversation ${conversationId} not found in Drive (missing ${relativePath})`);
                    }

                    const content = crypto.decrypt(encrypted, this.masterPassword!);
                    const fullPath = this.getFullPathForRelative(conversationId, relativePath);
                    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                    const tmpPath = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
                    await fs.promises.writeFile(tmpPath, content);
                    stagedSqlite.push({
                        targetPath: fullPath,
                        tmpPath,
                        hash: crypto.computeMd5Hash(content),
                        size: content.length
                    });
                }

                // Always remove ephemeral .db-shm before swapping SQLite files
                const shmPath = path.join(getConvDir(), `${conversationId}.db-shm`);
                try { await fs.promises.unlink(shmPath); } catch { /* ignore */ }

                // If remote has .db without .db-wal, ALWAYS remove stale local .db-wal even when keepLocalFiles is true
                if (remoteHasDb && !remoteHasWal) {
                    const localWalPath = path.join(getConvDir(), `${conversationId}.db-wal`);
                    try { await fs.promises.unlink(localWalPath); } catch { /* ignore */ }
                    this.fileHashCache.delete(localWalPath);
                }

                for (const item of stagedSqlite) {
                    await fs.promises.rename(item.tmpPath, item.targetPath);
                    const newStats = await fs.promises.stat(item.targetPath);
                    this.fileHashCache.set(item.targetPath, { mtime: newStats.mtimeMs, size: newStats.size, hash: item.hash });
                }
            } catch (err) {
                for (const item of stagedSqlite) {
                    try { await fs.promises.unlink(item.tmpPath); } catch { /* ignore */ }
                }
                throw err;
            }
        }

        // 2. Download non-SQLite files atomically
        await limitConcurrency(filesToDownload, concurrency, async (relativePath) => {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            downloadedCount++;
            this.downloadCount++;
            this.reportProgress(progress, lm.t('Downloading "{0}": {1} ({2}/{3})...', convTitle, relativePath, downloadedCount, totalDownloads));

            const encrypted = await this.driveService.downloadConversationFile(conversationId, relativePath);
            if (!encrypted) {
                throw new Error(`Conversation ${conversationId} not found in Drive (missing ${relativePath})`);
            }

            const content = crypto.decrypt(encrypted, this.masterPassword!);
            const fullPath = this.getFullPathForRelative(conversationId, relativePath);

            await atomicWriteFile(fullPath, content);

            const newHash = crypto.computeMd5Hash(content);
            const newStats = await fs.promises.stat(fullPath);
            this.fileHashCache.set(fullPath, { mtime: newStats.mtimeMs, size: newStats.size, hash: newHash });
        }, token);

        // 3. Delete locally files that were deleted remotely
        for (const relativePath of filesToDelete) {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            try {
                const fullPath = this.getFullPathForRelative(conversationId, relativePath);
                await fs.promises.unlink(fullPath);
                this.fileHashCache.delete(fullPath);
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
            validateExtractedDirectory(tempDir);

            // Create pre-sync backup before overwriting local data
            await this.backupConversationBeforePull(conversationId, convTitle, progress);

            // Copy brain directory
            const sourceBrain = path.join(tempDir, 'brain', conversationId);
            if (fs.existsSync(sourceBrain)) {
                const destBrain = path.join(getBrainDir(), conversationId);
                if (fs.existsSync(destBrain)) {
                    fs.rmSync(destBrain, { recursive: true, force: true });
                }
                fs.cpSync(sourceBrain, destBrain, { recursive: true });
            }

            // Copy conversation files (.pb, .db, .db-wal) and clean stale -shm/-wal
            const destConv = getConvDir();
            if (!fs.existsSync(destConv)) {
                fs.mkdirSync(destConv, { recursive: true });
            }
            const shmPath = path.join(destConv, `${conversationId}.db-shm`);
            if (fs.existsSync(shmPath)) {
                try { fs.unlinkSync(shmPath); } catch { /* ignore */ }
            }
            const sourceDb = path.join(tempDir, 'conversations', `${conversationId}.db`);
            const sourceWal = path.join(tempDir, 'conversations', `${conversationId}.db-wal`);
            if (fs.existsSync(sourceDb) && !fs.existsSync(sourceWal)) {
                const destWal = path.join(destConv, `${conversationId}.db-wal`);
                if (fs.existsSync(destWal)) {
                    try { fs.unlinkSync(destWal); } catch { /* ignore */ }
                }
            }
            const convExts = ['.pb', '.db', '.db-wal'];
            for (const ext of convExts) {
                const sourceFile = path.join(tempDir, 'conversations', `${conversationId}${ext}`);
                if (fs.existsSync(sourceFile)) {
                    fs.copyFileSync(sourceFile, path.join(destConv, `${conversationId}${ext}`));
                }
            }
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    /**
     * Resolve a sync conflict
     */
    async resolveConflict(conflict: SyncConflict, resolution: ConflictResolution): Promise<void> {
        const lm = LocalizationManager.getInstance();
        if (!this.masterPassword) {
            throw new Error(lm.t('Encryption password not set'));
        }

        let effectiveResolution: 'keepLocal' | 'keepRemote' | 'keepBoth' = 'keepLocal';
        if (resolution === 'keepNewer') {
            const localTime = new Date(conflict.localModified).getTime();
            const remoteTime = new Date(conflict.remoteModified).getTime();
            effectiveResolution = localTime >= remoteTime ? 'keepLocal' : 'keepRemote';
        } else if (resolution === 'keepLarger') {
            effectiveResolution = (conflict.localSize ?? 0) >= (conflict.remoteSize ?? 0) ? 'keepLocal' : 'keepRemote';
        } else {
            effectiveResolution = resolution;
        }

        switch (effectiveResolution) {
            case 'keepLocal':
                await this.pushConversation(conflict.conversationId);
                break;
            case 'keepRemote':
                await this.pullConversation(conflict.conversationId, undefined, undefined, true);
                break;
            case 'keepBoth': {
                const newId = `${conflict.conversationId}-conflict-${Date.now()}`;
                const manifest = await this.getDecryptedManifest(true);
                const remoteConv = manifest?.conversations.find(c => c.id === conflict.conversationId);

                if (remoteConv?.version === 2 && remoteConv.fileHashes) {
                    // Per-file v2 conflict copy: download all remote files into the conflict copy ID first
                    const downloadedFiles: Array<{ targetPath: string; content: Buffer }> = [];
                    const entries = Object.keys(remoteConv.fileHashes);
                    if (entries.length === 0) {
                        throw new Error(`Remote conversation ${conflict.conversationId} has no files to save as conflict copy.`);
                    }

                    for (const relativePath of entries) {
                        const encrypted = await this.driveService.downloadConversationFile(conflict.conversationId, relativePath);
                        if (!encrypted) {
                            throw new Error(`Failed to download remote file "${relativePath}" for Keep Both; aborting to preserve remote data.`);
                        }
                        const content = crypto.decrypt(encrypted, this.masterPassword!);
                        let targetPath: string;
                        if (relativePath.startsWith('conversations/')) {
                            const fileName = relativePath.slice('conversations/'.length);
                            const renamed = fileName.startsWith(conflict.conversationId)
                                ? `${newId}${fileName.slice(conflict.conversationId.length)}`
                                : `${newId}-${fileName}`;
                            targetPath = this.getFullPathForRelative(newId, `conversations/${renamed}`);
                        } else if (relativePath.startsWith(`brain/${conflict.conversationId}/`)) {
                            const sub = relativePath.slice(`brain/${conflict.conversationId}/`.length);
                            targetPath = this.getFullPathForRelative(newId, `brain/${newId}/${sub}`);
                        } else if (relativePath.startsWith('brain/')) {
                            const sub = relativePath.slice('brain/'.length);
                            targetPath = this.getFullPathForRelative(newId, `brain/${newId}/${sub}`);
                        } else {
                            throw new Error(`Unknown path format: ${relativePath}`);
                        }
                        downloadedFiles.push({ targetPath, content });
                    }

                    for (const item of downloadedFiles) {
                        await atomicWriteFile(item.targetPath, item.content);
                    }
                } else {
                    // Legacy v1 ZIP conflict copy
                    const encrypted = await this.driveService.downloadConversation(conflict.conversationId);
                    if (!encrypted) {
                        throw new Error(`Failed to download remote conversation ${conflict.conversationId} for Keep Both; aborting to preserve remote data.`);
                    }
                    const zipData = crypto.decrypt(encrypted, this.masterPassword!);
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sync-'));
                    const zipPath = path.join(tempDir, 'conflict.zip');

                    try {
                        fs.writeFileSync(zipPath, zipData);
                        await extract(zipPath, { dir: tempDir });
                        validateExtractedDirectory(tempDir);

                        const sourceBrain = path.join(tempDir, 'brain', conflict.conversationId);
                        if (fs.existsSync(sourceBrain)) {
                            fs.cpSync(sourceBrain, path.join(getBrainDir(), newId), { recursive: true });
                        }

                        const destConv = getConvDir();
                        if (!fs.existsSync(destConv)) {
                            fs.mkdirSync(destConv, { recursive: true });
                        }
                        const convExts = ['.pb', '.db', '.db-wal'];
                        for (const ext of convExts) {
                            const sourceFile = path.join(tempDir, 'conversations', `${conflict.conversationId}${ext}`);
                            if (fs.existsSync(sourceFile)) {
                                fs.copyFileSync(sourceFile, path.join(destConv, `${newId}${ext}`));
                            }
                        }
                    } finally {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                }

                // Only push local AFTER the remote copy was completely preserved locally
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
     * Create a backup of a conversation before it is overwritten during sync pull.
     * Skips creating an empty backup if no local files exist yet.
     */
    private async backupConversationBeforePull(
        conversationId: string,
        convTitle: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<string | null> {
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const enabled = config.get<boolean>('sync.preSyncBackup', true);
        if (!enabled) return null;

        const brainDir = path.join(getBrainDir(), conversationId);
        const convExts = ['.pb', '.db', '.db-wal'];
        const hasLocalBrain = fs.existsSync(brainDir);
        const existingConvFiles = convExts
            .map(ext => ({ ext, filePath: path.join(getConvDir(), `${conversationId}${ext}`) }))
            .filter(item => fs.existsSync(item.filePath));

        if (!hasLocalBrain && existingConvFiles.length === 0) {
            // Fresh pull of a remote-only conversation — nothing local to back up
            return null;
        }

        const lm = LocalizationManager.getInstance();
        this.reportProgress(progress, lm.t('Creating backup before sync for "{0}"...', convTitle));

        try {
            const backupBaseDir = config.get<string>('sync.preSyncBackupPath', '') || getDefaultSyncBackupDir();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = path.join(backupBaseDir, conversationId, timestamp);

            await fs.promises.mkdir(backupDir, { recursive: true });

            let backedUpFiles = 0;

            if (hasLocalBrain) {
                const destBrain = path.join(backupDir, 'brain', conversationId);
                await fs.promises.cp(brainDir, destBrain, { recursive: true });
                backedUpFiles++;
            }

            if (existingConvFiles.length > 0) {
                const destConv = path.join(backupDir, 'conversations');
                await fs.promises.mkdir(destConv, { recursive: true });
                for (const item of existingConvFiles) {
                    await fs.promises.copyFile(item.filePath, path.join(destConv, `${conversationId}${item.ext}`));
                    backedUpFiles++;
                }
            }

            const metadata = {
                conversationId,
                title: convTitle,
                timestamp: new Date().toISOString(),
                reason: 'pre-sync-pull',
                backedUpFiles
            };
            await fs.promises.writeFile(
                path.join(backupDir, 'metadata.json'),
                JSON.stringify(metadata, null, 2)
            );

            this.preSyncBackupCount++;
            console.log(`[Backup] Pre-sync backup created for ${conversationId} at ${backupDir}`);

            const retention = config.get<number>('sync.preSyncBackupRetention', 20);
            await this.cleanOldSyncBackups(conversationId, retention, backupBaseDir);

            return backupDir;
        } catch (e: any) {
            // Backup failure should not prevent sync from proceeding
            console.error(`[Backup] Failed to create pre-sync backup for ${conversationId}:`, e);
            return null;
        }
    }

    /**
     * Clean old pre-sync backups for a specific conversation, keeping only the most recent ones.
     */
    private async cleanOldSyncBackups(conversationId: string, retention: number, backupBaseDir: string): Promise<void> {
        const keepCount = Math.floor(retention);
        if (!Number.isFinite(keepCount) || keepCount <= 0) return;

        try {
            const convBackupDir = path.join(backupBaseDir, conversationId);
            if (!fs.existsSync(convBackupDir)) return;

            const entries = await fs.promises.readdir(convBackupDir);
            if (entries.length <= keepCount) return;

            const sorted = entries.sort((a, b) => compareDeterministic(b, a));
            const toDelete = sorted.slice(keepCount);

            for (const entry of toDelete) {
                const fullPath = path.join(convBackupDir, entry);
                try {
                    await fs.promises.rm(fullPath, { recursive: true, force: true });
                    console.log(`[Backup] Deleted old pre-sync backup: ${entry}`);
                } catch (e) {
                    console.error(`[Backup] Failed to delete old backup ${entry}:`, e);
                }
            }

            if (toDelete.length > 0) {
                console.log(`[Backup] Cleaned ${toDelete.length} old pre-sync backup(s) for ${conversationId}`);
            }
        } catch (e: any) {
            console.error(`[Backup] Failed to clean old backups for ${conversationId}:`, e);
        }
    }

    /**
     * Fetch and decrypt remote manifest, explicitly distinguishing `not_found` from `error`.
     */
    public async getDecryptedManifestResult(forceRefresh: boolean = false): Promise<ManifestFetchResult> {
        const config = vscode.workspace.getConfiguration(EXT_NAME);
        const useCache = config.get<boolean>('sync.useMetadataCache', true);
        const cacheTTL = 60000; // 1 minute

        if (!forceRefresh && useCache && this.cachedManifest && (Date.now() - this.lastManifestFetch < cacheTTL)) {
            return { status: 'ok', manifest: this.cachedManifest };
        }

        const lm = LocalizationManager.getInstance();
        try {
            if (!this.driveService) {
                return { status: 'error', error: new Error('Storage service not initialized') };
            }
            if (!this.isLocalStorage() && !this.authProvider.isAuthenticated()) {
                return { status: 'error', error: new Error('Not authenticated') };
            }

            const encrypted = await this.driveService.getManifest();
            if (!encrypted) {
                return { status: 'not_found' };
            }

            if (!this.masterPassword) {
                return { status: 'error', error: new Error(lm.t('Encryption password not set')) };
            }

            const decrypted = crypto.decrypt(encrypted, this.masterPassword);

            let manifest: SyncManifest;
            try {
                manifest = JSON.parse(decrypted.toString('utf8'));
            } catch (e: any) {
                vscode.window.showErrorMessage(lm.t('Failed to parse manifest JSON: {0}', e.message));
                return { status: 'error', error: e instanceof Error ? e : new Error(String(e)) };
            }

            this.cachedManifest = manifest;
            this.lastManifestFetch = Date.now();
            return { status: 'ok', manifest };
        } catch (error: any) {
            const msg = error?.message || '';
            const isInvalidGrant = msg.includes('invalid_grant') ||
                (error?.response?.data?.error === 'invalid_grant');
            const isPermissionDenied = msg.includes('Permission denied') && (msg.includes('file access permission') || msg.includes('insufficient permission') || msg.includes('Insufficient Permission'));

            if (!this.isLocalStorage() && isInvalidGrant) {
                console.warn(lm.t('SyncManager: Invalid grant detected. Signing out.'));
                await this.authProvider.signOut();

                const signIn = lm.t('Sign In');
                vscode.window.showWarningMessage(
                    lm.t('Google Drive session expired. Please sign in again.'),
                    signIn
                ).then(selection => {
                    if (selection === signIn) {
                        this.authProvider.signIn().catch(console.error);
                    }
                });
                return { status: 'error', error: error instanceof Error ? error : new Error(msg) };
            }

            if (!this.isLocalStorage() && isPermissionDenied) {
                console.warn(lm.t('SyncManager: Permission denied detected. Signing out.'));
                await this.authProvider.signOut();

                const signIn = lm.t('Sign In');
                vscode.window.showWarningMessage(
                    lm.t('Permission denied. Please sign in again and grant file access.'),
                    signIn
                ).then(selection => {
                    if (selection === signIn) {
                        this.authProvider.signIn().catch(console.error);
                    }
                });
                return { status: 'error', error: error instanceof Error ? error : new Error(msg) };
            }

            vscode.window.showErrorMessage(lm.t('Failed to get/decrypt manifest: {0}', msg));
            return { status: 'error', error: error instanceof Error ? error : new Error(msg) };
        }
    }

    /**
     * Get decrypted manifest from storage with caching support
     */
    public async getDecryptedManifest(forceRefresh: boolean = false): Promise<SyncManifest | null> {
        const res = await this.getDecryptedManifestResult(forceRefresh);
        return res.status === 'ok' ? res.manifest : null;
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
        const archivedIds = this.getArchivedConversationIds(manifest);

        // 1. Local conversations
        for (const l of local) {
            if (archivedIds.has(l.id)) {
                statuses.set(l.id, { status: lm.t('Archived'), icon: '📦' });
                continue;
            }
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
                    if (archivedIds.has(r.id)) {
                        statuses.set(r.id, { status: lm.t('Archived'), icon: '📦' });
                    } else {
                        statuses.set(r.id, { status: lm.t('Remote Only'), icon: '☁️' });
                    }
                }
            }
        }

        return statuses;
    }

    /**
     * Queue a serialized manifest mutation without poisoning the queue on rejection.
     * Clones the fetched manifest before mutating and updates cachedManifest only after successful persistence.
     */
    private enqueueManifestUpdate(
        mutator: (manifest: SyncManifest) => boolean | Promise<boolean>
    ): Promise<void> {
        const task = this.manifestUpdateQueue.then(async () => {
            if (!this.masterPassword) {
                throw new Error(LocalizationManager.getInstance().t('Encryption password not set'));
            }

            const fetchResult = await this.getDecryptedManifestResult(true);
            if (fetchResult.status === 'error') {
                throw fetchResult.error;
            }
            if (fetchResult.status === 'not_found') {
                return;
            }

            // Deep clone before mutating so a failed write never corrupts cachedManifest
            const cloned: SyncManifest = JSON.parse(JSON.stringify(fetchResult.manifest));
            const shouldSave = await mutator(cloned);
            if (!shouldSave) {
                return;
            }

            cloned.lastModified = new Date().toISOString();
            const manifestJson = JSON.stringify(cloned, null, 2);
            const useCompression = vscode.workspace.getConfiguration(EXT_NAME).get<boolean>('sync.enableCompression', true);
            const encrypted = crypto.encrypt(Buffer.from(manifestJson), this.masterPassword, useCompression);
            await this.driveService.updateManifest(encrypted);

            // Commit to cache only after remote write succeeds
            this.cachedManifest = cloned;
            this.lastManifestFetch = Date.now();
        });

        // Prevent a single rejection from poisoning subsequent queued updates
        this.manifestUpdateQueue = task.catch(() => { });
        return task;
    }

    /**
     * Update only the title of a conversation in the manifest without altering modifiedBy or lastModified.
     */
    private async updateManifestTitleOnly(conversationId: string, newTitle: string): Promise<void> {
        if (!newTitle || newTitle === conversationId) return;
        await this.enqueueManifestUpdate((manifest) => {
            const existing = manifest.conversations.find(c => c.id === conversationId);
            if (!existing || existing.title === newTitle) {
                return false;
            }
            existing.title = newTitle;
            return true;
        });
    }

    /**
     * Update a single entry in the manifest
     */
    private async updateManifestEntry(conversationId: string, hash: string, size?: number, lastModified?: string, titleOverride?: string): Promise<void> {
        const lm = LocalizationManager.getInstance();
        try {
            await this.enqueueManifestUpdate((manifest) => {
                const now = new Date().toISOString();
                const existingIdx = manifest.conversations.findIndex(c => c.id === conversationId);
                const existing = existingIdx >= 0 ? manifest.conversations[existingIdx] : null;
                const localTitle = titleOverride || this.getConversationTitle(conversationId);
                const effectiveTitle = (localTitle && localTitle !== conversationId)
                    ? localTitle
                    : (existing?.title || conversationId);

                const entry: SyncedConversation = {
                    id: conversationId,
                    title: effectiveTitle,
                    lastModified: lastModified || now,
                    hash: hash,
                    modifiedBy: this.config!.machineId,
                    size: size,
                    createdAt: existing?.createdAt || now,
                    createdBy: existing?.createdBy || this.config!.machineId,
                    createdByName: existing?.createdByName || this.getEffectiveMachineName()
                };

                if (existingIdx >= 0) {
                    manifest.conversations[existingIdx] = entry;
                } else {
                    manifest.conversations.push(entry);
                }

                // Remove any tombstone if conversation was re-pushed
                if (manifest.deletedConversations?.[conversationId]) {
                    delete manifest.deletedConversations[conversationId];
                }

                const currentMachineName = this.getEffectiveMachineName();
                if (!manifest.machines) manifest.machines = [];
                const machineIdx = manifest.machines.findIndex(m => m.id === this.config!.machineId);
                const existingMachine = machineIdx >= 0 ? manifest.machines[machineIdx] : null;
                const machineInfo: Machine = {
                    id: this.config!.machineId,
                    name: currentMachineName,
                    lastSync: now,
                    createdAt: existingMachine?.createdAt || now
                };

                if (machineIdx >= 0) {
                    manifest.machines[machineIdx] = machineInfo;
                } else {
                    manifest.machines.push(machineInfo);
                }

                return true;
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(lm.t('Failed to update manifest for {0}: {1}', conversationId, error.message));
            throw error;
        }
    }

    /**
     * Update a single entry in the manifest with per-file hashes (new format)
     */
    private async updateManifestEntryWithFileHashes(
        conversationId: string,
        hash: string,
        fileHashes: { [relativePath: string]: FileHashInfo },
        lastModified?: string,
        titleOverride?: string
    ): Promise<void> {
        const lm = LocalizationManager.getInstance();
        try {
            await this.enqueueManifestUpdate((manifest) => {
                const now = new Date().toISOString();
                const existingIdx = manifest.conversations.findIndex(c => c.id === conversationId);
                const existing = existingIdx >= 0 ? manifest.conversations[existingIdx] : null;
                const localTitle = titleOverride || this.getConversationTitle(conversationId);
                const effectiveTitle = (localTitle && localTitle !== conversationId)
                    ? localTitle
                    : (existing?.title || conversationId);

                const totalSize = Object.values(fileHashes).reduce((sum, info) => sum + info.size, 0);

                const entry: SyncedConversation = {
                    id: conversationId,
                    title: effectiveTitle,
                    lastModified: lastModified || now,
                    hash: hash,
                    modifiedBy: this.config!.machineId,
                    fileHashes: fileHashes,
                    size: totalSize,
                    version: 2,
                    createdAt: existing?.createdAt || now,
                    createdBy: existing?.createdBy || this.config!.machineId,
                    createdByName: existing?.createdByName || this.getEffectiveMachineName()
                };

                if (existingIdx >= 0) {
                    manifest.conversations[existingIdx] = entry;
                } else {
                    manifest.conversations.push(entry);
                }

                // Clear tombstone if conversation was re-created/pushed
                if (manifest.deletedConversations?.[conversationId]) {
                    delete manifest.deletedConversations[conversationId];
                }

                const currentMachineName = this.getEffectiveMachineName();
                if (!manifest.machines) manifest.machines = [];
                const machineIdx = manifest.machines.findIndex(m => m.id === this.config!.machineId);
                const existingMachine = machineIdx >= 0 ? manifest.machines[machineIdx] : null;
                const machineInfo: Machine = {
                    id: this.config!.machineId,
                    name: currentMachineName,
                    lastSync: now,
                    createdAt: existingMachine?.createdAt || now
                };

                if (machineIdx >= 0) {
                    manifest.machines[machineIdx] = machineInfo;
                } else {
                    manifest.machines.push(machineInfo);
                }

                console.log(`[Manifest] Updating for ${conversationId}: ${Object.keys(fileHashes).length} files, ${manifest.conversations.length} conversations total`);
                return true;
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(lm.t('Failed to update manifest (per-file) for {0}: {1}', conversationId, error.message));
            throw error;
        }
    }

    /**
     * Update machine state in remote storage.
     * Excludes conflicted or failed conversations from overwriting their previous lastSyncedHash
     * so 3-way merge base stays accurate.
     */
    private async updateMachineState(
        excludedIds?: Set<string>,
        previousSyncedHashes?: Map<string, string>
    ): Promise<void> {
        if (!this.config || !this.masterPassword) return;

        const machineName = this.getEffectiveMachineName();
        if (this.config.machineName !== machineName) {
            this.config.machineName = machineName;
        }

        const quota = await this.driveService.getStorageInfo();
        const accountQuota = this.quotaManager?.getLatestSnapshot();
        const conversations = await this.getLocalConversationsAsync();
        const now = new Date().toISOString();

        const conversationStates: MachineState['conversationStates'] = [];
        for (const c of conversations) {
            if (excludedIds?.has(c.id)) {
                const prevHash = previousSyncedHashes?.get(c.id);
                if (prevHash) {
                    conversationStates.push({
                        id: c.id,
                        localHash: prevHash,
                        lastSynced: now
                    });
                }
                continue;
            }
            conversationStates.push({
                id: c.id,
                localHash: c.hash,
                lastSynced: now
            });
        }

        const state: MachineState = {
            machineId: this.config.machineId,
            machineName: machineName,
            lastSync: now,
            syncCount: this.syncCount,
            uploadCount: this.uploadCount,
            downloadCount: this.downloadCount,
            quota: quota || undefined,
            accountQuota: accountQuota,
            conversationStates
        };

        const useCompression = vscode.workspace.getConfiguration(EXT_NAME).get<boolean>('sync.enableCompression', true);
        const encrypted = crypto.encrypt(
            Buffer.from(JSON.stringify(state)),
            this.masterPassword,
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

    private buildIdleStatusTooltip(lm: LocalizationManager): vscode.MarkdownString {
        const sessionCount = this.syncCount || 0;
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

        if (this.autoSyncTimer && this.config?.syncInterval && this.nextAutoSyncTime) {
            const now = Date.now();
            const interval = this.config.syncInterval;
            const msUntilSync = Math.max(0, this.nextAutoSyncTime - now);
            if (msUntilSync > 0) {
                const elapsed = interval - msUntilSync;
                const progress = Math.min(1, Math.max(0, elapsed / interval));
                const progressBar = drawProgressBar(progress * 100, 15);
                const seconds = Math.ceil(msUntilSync / 1000);
                const timeText = seconds > 60 ? `${Math.ceil(seconds / 60)}${lm.t('m')}` : `${seconds}s`;
                md.appendMarkdown(`$(watch) ${lm.t('Next Sync')}: \`${progressBar}\` (${timeText})\n\n`);
            }
        }

        md.appendMarkdown(`$(sync) ${lm.t('Session Syncs')}: ${sessionCount}`);
        return md;
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

        if (this.okStatusTimer) {
            clearTimeout(this.okStatusTimer);
            this.okStatusTimer = null;
        }

        const lm = LocalizationManager.getInstance();

        switch (status) {
            case 'syncing':
                this.statusBarItem.text = `$(sync~spin) ${lm.t('AG Sync')}`;
                this.statusBarItem.tooltip = text || lm.t('Syncing with Google Drive...');
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
                break;
            case 'error':
                this.statusBarItem.text = `$(error) ${lm.t('AG Sync')}`;
                this.statusBarItem.tooltip = text || lm.t('Sync Error');
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
                break;
            case 'ok':
                this.statusBarItem.text = `$(check) ${lm.t('AG Sync')}`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.color = undefined;
                this.statusBarItem.tooltip = text || this.buildIdleStatusTooltip(lm);
                this.okStatusTimer = setTimeout(() => {
                    this.okStatusTimer = null;
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
                    const icon = (this.config?.lastSync && this.config.lastSync !== 'Never') ? '$(check)' : '$(cloud)';
                    this.statusBarItem.text = `${icon} ${lm.t('AG Sync')}`;
                    this.statusBarItem.tooltip = this.buildIdleStatusTooltip(lm);
                    this.statusBarItem.color = undefined;
                    this.statusBarItem.backgroundColor = undefined;
                }
                break;
            }
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
     * Helper to get hash with caching based on (mtime, size).
     * Returns '' ONLY on ENOENT; propagates EBUSY/EACCES/EIO so locked files are never treated as deleted.
     */
    private async getFileHashWithCacheAsync(filePath: string): Promise<string> {
        try {
            const stats = await fs.promises.stat(filePath);
            const cached = this.fileHashCache.get(filePath);

            if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
                return cached.hash;
            }

            const content = await fs.promises.readFile(filePath);
            const hash = crypto.computeMd5Hash(content);
            this.fileHashCache.set(filePath, { mtime: stats.mtimeMs, size: stats.size, hash });
            return hash;
        } catch (err: any) {
            if (err && err.code === 'ENOENT') {
                this.fileHashCache.delete(filePath);
                return '';
            }
            throw err;
        }
    }

    /**
     * Compute a deterministic, locale-independent overall hash from a fileHashes map.
     */
    private computeOverallHashFromFileHashes(fileHashes: { [relativePath: string]: FileHashInfo }): string {
        const sortedPaths = Object.keys(fileHashes).sort(compareDeterministic);
        if (sortedPaths.length === 0) return '';
        const parts = sortedPaths.map(p => `${p}:${fileHashes[p].hash}`);
        return crypto.computeMd5Hash(Buffer.from(parts.join('|')));
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
                    } else if (dirent.isFile()) {
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
     * Compute per-file hashes for a conversation using locale-independent deterministic ordering
     */
    private async computeConversationFileHashesAsync(conversationId: string, options?: { skipHashes?: boolean }): Promise<{
        overallHash: string;
        fileHashes: { [relativePath: string]: FileHashInfo };
        maxMtime: number;
    }> {
        const fileHashes: { [relativePath: string]: FileHashInfo } = {};
        let maxMtime = 0;

        // 1. Conversation files (.db, .pb, .db-wal)
        const convDir = getConvDir();
        const convExts = ['.db', '.pb', '.db-wal'];
        for (const ext of convExts) {
            const filePath = path.join(convDir, `${conversationId}${ext}`);
            if (fs.existsSync(filePath)) {
                const hash = options?.skipHashes ? '' : await this.getFileHashWithCacheAsync(filePath);
                if (options?.skipHashes || hash) {
                    const relativePath = `conversations/${conversationId}${ext}`;
                    const stats = await fs.promises.stat(filePath);
                    maxMtime = Math.max(maxMtime, stats.mtimeMs);
                    fileHashes[relativePath] = {
                        hash: hash || '',
                        size: stats.size,
                        lastModified: stats.mtime.toISOString()
                    };
                }
            }
        }

        // 2. Brain directory files
        const brainDir = path.join(getBrainDir(), conversationId);
        if (fs.existsSync(brainDir)) {
            const files = await this.getAllFilesAsync(brainDir);

            const relativeFiles: { path: string; fullPath: string }[] = files.map(f => ({
                path: `brain/${conversationId}/` + path.relative(brainDir, f).replace(/\\/g, '/'),
                fullPath: f
            }));

            relativeFiles.sort((a, b) => compareDeterministic(a.path, b.path));

            for (const file of relativeFiles) {
                const hash = options?.skipHashes ? '' : await this.getFileHashWithCacheAsync(file.fullPath);
                if (options?.skipHashes || hash) {
                    const stats = await fs.promises.stat(file.fullPath);
                    maxMtime = Math.max(maxMtime, stats.mtimeMs);
                    fileHashes[file.path] = {
                        hash: hash || '',
                        size: stats.size,
                        lastModified: stats.mtime.toISOString()
                    };
                }
            }
        }

        const overallHash = options?.skipHashes ? '' : this.computeOverallHashFromFileHashes(fileHashes);

        return { overallHash, fileHashes, maxMtime };
    }

    /**
     * Get local conversations with metadata (Async)
     */
    private async getLocalConversationsAsync(options?: { skipHashes?: boolean }): Promise<Array<{ id: string; title: string; lastModified: string; hash: string; size: number }>> {
        // Reuse utils logic to ensure consistent title extraction
        const items = await getConversationsAsync(getBrainDir());
        const serverTitleMap = await this.getServerTitleMap();

        const concurrency = vscode.workspace.getConfiguration(EXT_NAME).get<number>('sync.concurrency', 3);

        // Use limited concurrency worker pool instead of unbounded Promise.all
        const results: { id: string; title: string; lastModified: string; hash: string; size: number; files?: any }[] = [];
        const queue = [...items];
        const worker = async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                if (!item) break;

                let overallHash = '';
                let fileHashes: { [relativePath: string]: FileHashInfo } = {};
                let maxMtime = 0;
                let size = 0;

                const computed = await this.computeConversationFileHashesAsync(item.id, options);
                overallHash = computed.overallHash;
                fileHashes = computed.fileHashes;
                maxMtime = computed.maxMtime;
                size = Object.values(fileHashes).reduce((sum, f) => sum + f.size, 0);

                // Use the actual max mtime of files, falling back to the directory mtime if no files
                const lastModified = maxMtime > 0 ? new Date(maxMtime).toISOString() : item.lastModified.toISOString();

                // Priority: Server Title > Local Title > ID
                let displayTitle = serverTitleMap.get(item.id);
                if (!displayTitle || displayTitle === item.id) {
                    displayTitle = item.label;
                }

                results.push({
                    id: item.id,
                    title: displayTitle || item.label || item.id,
                    lastModified: lastModified,
                    hash: overallHash,
                    files: fileHashes,
                    size: size
                });
            }
        };
        await Promise.all(Array(Math.min(concurrency, items.length || 1)).fill(null).map(() => worker()));
        return results;
    }

    /**
     * Start auto-sync timer
     */
    startAutoSync(): void {
        this.stopAutoSync();

        const wsConfig = vscode.workspace.getConfiguration(EXT_NAME);
        const wsAutoSync = wsConfig.get<boolean>('sync.autoSync');
        const wsInterval = wsConfig.get<number>('sync.syncInterval');
        const autoSyncEnabled = typeof wsAutoSync === 'boolean' ? wsAutoSync : (this.config?.autoSync ?? false);
        if (!autoSyncEnabled || !this.isSyncEnabled) {
            this.nextAutoSyncTime = null;
            return;
        }

        const rawInterval = (typeof wsInterval === 'number' && wsInterval > 0)
            ? wsInterval
            : (this.config?.syncInterval || 300000);
        const interval = Math.max(MIN_SYNC_INTERVAL_MS, Math.min(MAX_SYNC_INTERVAL_MS, rawInterval));
        if (this.config) {
            this.config.syncInterval = interval;
        }

        this.autoSyncTimer = setInterval(async () => {
            try {
                if (this.isReady() && !this.isSyncing && this.isSyncEnabled) {
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
            } catch (err) {
                if (!(err instanceof vscode.CancellationError)) {
                    console.error('[AutoSync] Background sync error:', err);
                }
            } finally {
                if (this.autoSyncTimer) {
                    this.nextAutoSyncTime = Date.now() + interval;
                }
            }
        }, interval);

        this.nextAutoSyncTime = Date.now() + interval;
    }

    /**
     * Stop auto-sync timer
     */
    stopAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }
        this.nextAutoSyncTime = null;
    }

    /**
     * Setup wizard
     */
    async setup(): Promise<void> {
        const lm = LocalizationManager.getInstance();

        // 1. Check if we need to authenticate (skip Google OAuth when using Local Storage provider)
        if (!this.isLocalStorage()) {
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

        const previousPassword = this.masterPassword;
        this.masterPassword = password;

        // 4. Create or Get Master Manifest
        try {
            let setupCompleted = false;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: lm.t("Setting up sync storage..."),
                cancellable: true
            }, async (progress, token) => {
                if (token.isCancellationRequested) throw new vscode.CancellationError();

                this.reportProgress(progress, lm.t('Checking Google Drive folders...'));
                await this.driveService.ensureSyncFolders();

                // Check existing manifest — distinguish not_found vs decryption/network error!
                this.reportProgress(progress, lm.t('Checking for existing backup...'));
                const manifestResult = await this.getDecryptedManifestResult(true);
                if (manifestResult.status === 'error') {
                    throw new Error(
                        `Existing sync manifest could not be read or decrypted (wrong Master Password or network error): ${manifestResult.error.message}`
                    );
                }
                const manifest = manifestResult.status === 'ok' ? manifestResult.manifest : null;

                let machineId = crypto.generateMachineId();
                let machineName = os.hostname();

                // Check for existing machines to resume session
                if (manifest && manifest.machines && manifest.machines.length > 0) {
                    let sortMethod: 'date' | 'duration' | 'name' = 'date';
                    let selection: any;

                    while (true) {
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

                            const configName = vscode.workspace.getConfiguration(EXT_NAME).get<string>('sync.machineName');
                            const currentMachineName = (configName || (this.config?.machineName) || os.hostname()).trim();

                            for (const m of sortedMachines) {
                                if (m.id && m.name) {
                                    let detail = '';
                                    const isSameDevice = (this.config && m.id === this.config.machineId) ||
                                        (m.name?.trim().toLowerCase() === currentMachineName.toLowerCase());

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

                            sortedMachines.sort((a, b) => {
                                if (sortMethod === 'name') {
                                    const nameA = a.name || a.id || '';
                                    const nameB = b.name || b.id || '';
                                    const nameComp = nameA.localeCompare(nameB);
                                    if (nameComp !== 0) return nameComp;
                                    return (a.id || '').localeCompare(b.id || '');
                                } else if (sortMethod === 'date') {
                                    return new Date(b.lastSync || 0).getTime() - new Date(a.lastSync || 0).getTime();
                                } else {
                                    const durA = (a.lastSync && a.createdAt) ? new Date(a.lastSync).getTime() - new Date(a.createdAt).getTime() : 0;
                                    const durB = (b.lastSync && b.createdAt) ? new Date(b.lastSync).getTime() - new Date(b.createdAt).getTime() : 0;
                                    if (durB !== durA) return durB - durA;
                                    return new Date(b.lastSync || 0).getTime() - new Date(a.lastSync || 0).getTime();
                                }
                            });
                            updateItems();
                        });

                        selection = await new Promise<any>((resolve) => {
                            let accepted = false;
                            quickPick.onDidAccept(() => {
                                accepted = true;
                                const selected = quickPick.selectedItems[0];
                                resolve(selected || undefined);
                                quickPick.hide();
                            });
                            quickPick.onDidHide(() => {
                                if (!accepted) resolve(undefined);
                                quickPick.dispose();
                            });
                            quickPick.show();
                        });

                        break;
                    }

                    if (!selection) return; // User cancelled

                    if (selection.id !== 'new') {
                        machineId = selection.id;
                        const original = manifest.machines.find(m => m.id === machineId);
                        if (original) {
                            machineName = original.name;
                        }

                        const newName = await vscode.window.showInputBox({
                            prompt: lm.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                            value: machineName,
                            validateInput: (value) => value ? null : lm.t("Machine name cannot be empty")
                        });
                        if (newName === undefined) return;
                        if (newName) machineName = newName;
                    } else {
                        const inputName = await vscode.window.showInputBox({
                            prompt: lm.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                            value: machineName,
                            validateInput: (value) => value ? null : lm.t("Machine name cannot be empty")
                        });
                        if (inputName === undefined) return;
                        if (inputName) machineName = inputName;
                    }
                } else {
                    const inputName = await vscode.window.showInputBox({
                        prompt: lm.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                        value: machineName,
                        validateInput: (value) => value ? null : lm.t("Machine name cannot be empty")
                    });
                    if (inputName === undefined) return;
                    if (inputName) machineName = inputName;
                }

                // Persist master password only after user confirmed all setup prompts and manifest verified
                await this.context.secrets.store(SECRET_KEY, password);

                const wsConfig = vscode.workspace.getConfiguration(EXT_NAME);
                const wsAutoSync = wsConfig.get<boolean>('sync.autoSync', true);
                const wsInterval = wsConfig.get<number>('sync.syncInterval', 300000);
                const wsShowStatusBar = wsConfig.get<boolean>('sync.showStatusBar', true);
                const wsSilent = wsConfig.get<boolean>('sync.silent', false);

                // Initialize config with lastSync: null (until first sync actually succeeds)
                this.config = {
                    enabled: true,
                    machineId: machineId,
                    machineName: machineName,
                    lastSync: null,
                    autoSync: wsAutoSync,
                    syncInterval: wsInterval,
                    showStatusBar: wsShowStatusBar,
                    selectedConversations: 'all',
                    silent: wsSilent
                };

                await this.saveConfig();

                if (manifest) {
                    vscode.window.showInformationMessage(lm.t("Found existing sync data! Joined as '{0}'.", this.config!.machineName));

                    if (manifest.conversations.length > 0) {
                        const serverTitles = await this.getServerTitleMap();

                        const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { id: string }>();
                        quickPick.title = lm.t('Select conversations to sync from Google Drive');
                        quickPick.placeholder = lm.t('Use Space to select/deselect, Enter to confirm');
                        quickPick.canSelectMany = true;

                        let sortMethod: 'modified' | 'created' | 'name' = 'modified';
                        const patreonBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('heart'), tooltip: lm.t('Support on Patreon') };
                        const coffeeBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('coffee'), tooltip: lm.t('Buy Me a Coffee') };
                        let sortBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: '' };

                        const updateSortButton = () => {
                            let sortTooltip = lm.t('Sort by Modified Date and Time');
                            if (sortMethod === 'created') sortTooltip = lm.t('Sort by Created Date and Time');
                            if (sortMethod === 'name') sortTooltip = lm.t('Sort by Name');

                            sortBtn = { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: `${lm.t('Sort')}: ${sortTooltip}` };
                            quickPick.buttons = [patreonBtn, coffeeBtn, sortBtn];
                        };

                        const updateItems = (preserveSelection = false) => {
                            const sortedConversations = [...manifest.conversations].sort((a, b) => {
                                if (sortMethod === 'name') {
                                    const titleA = serverTitles.get(a.id) || a.title || a.id;
                                    const titleB = serverTitles.get(b.id) || b.title || b.id;
                                    return titleA.localeCompare(titleB);
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
                                const dateInfo = createdDate ? `${lm.t('Created')}: ${createdDate}` : undefined;

                                return {
                                    label: serverTitles.get(c.id) || c.title || c.id,
                                    description: c.id,
                                    detail: `${lm.t('Modified')}: ${modifiedDate}${dateInfo ? ` | ${dateInfo}` : ''}`,
                                    picked: true,
                                    id: c.id
                                };
                            });

                            const previousSelectionIds = preserveSelection ? quickPick.selectedItems.map(i => i.id) : [];
                            quickPick.items = items;

                            if (preserveSelection) {
                                quickPick.selectedItems = items.filter(i => previousSelectionIds.includes(i.id));
                            } else {
                                quickPick.selectedItems = items;
                            }

                            updateSortButton();
                        };

                        updateItems();

                        quickPick.onDidTriggerButton(button => {
                            if (button === patreonBtn) {
                                vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
                            } else if (button === coffeeBtn) {
                                vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
                            } else if (button === sortBtn) {
                                if (sortMethod === 'modified') sortMethod = 'created';
                                else if (sortMethod === 'created') sortMethod = 'name';
                                else sortMethod = 'modified';
                                updateItems(true);
                            }
                        });

                        const selected = await new Promise<(vscode.QuickPickItem & { id: string })[] | undefined>((resolve) => {
                            let accepted = false;
                            quickPick.onDidAccept(() => {
                                accepted = true;
                                resolve([...quickPick.selectedItems] as (vscode.QuickPickItem & { id: string })[]);
                                quickPick.hide();
                            });
                            quickPick.onDidHide(() => {
                                if (!accepted) resolve(undefined);
                                quickPick.dispose();
                            });
                            quickPick.show();
                        });

                        if (selected !== undefined) {
                            if (selected.length === manifest.conversations.length) {
                                this.config!.selectedConversations = 'all';
                            } else {
                                this.config!.selectedConversations = selected.map(s => s.id);
                            }
                            await this.saveConfig();
                        }
                    }
                } else {
                    // Manifest genuinely does not exist yet -> create initial manifest
                    this.reportProgress(progress, lm.t('Creating initial backup...'));
                    await this.createInitialManifest();
                    vscode.window.showInformationMessage(lm.t("Sync set up successfully!"));
                }

                setupCompleted = true;

                // Trigger first sync
                await this.syncNow(progress, token);
            });

            if (!setupCompleted) {
                this.masterPassword = previousPassword;
                return;
            }

            this.updateStatusBar('idle');
            this.startAutoSync();

        } catch (error: any) {
            this.masterPassword = previousPassword;
            if (error instanceof vscode.CancellationError) {
                return;
            }
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
        this.masterPassword = null;
        this.cachedManifest = null;
        this.lastManifestFetch = 0;
        this.nextAutoSyncTime = null;
        this.fileHashCache.clear();
        await this.context.globalState.update(`${EXT_NAME}.sync.config`, undefined);
        await this.context.globalState.update('ag-sync-config', undefined);
        await this.context.secrets.delete(SECRET_KEY);
        await this.context.secrets.delete(LEGACY_SECRET_KEY);
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
     * Ensure remote manifest exists and is loaded.
     * NEVER overwrites an existing remote manifest on transient network or decryption errors!
     */
    private async ensureRemoteManifest(): Promise<SyncManifest | null> {
        const lm = LocalizationManager.getInstance();
        try {
            const fetchResult = await this.getDecryptedManifestResult(true);
            if (fetchResult.status === 'ok') {
                return fetchResult.manifest;
            }
            if (fetchResult.status === 'error') {
                throw fetchResult.error;
            }

            // status === 'not_found' -> genuinely absent, safe to initialize
            try {
                console.log('Remote manifest not found, creating initial manifest...');
                await this.createInitialManifest();
            } catch (e: any) {
                throw new Error(lm.t("Failed to get or create remote manifest: {0}", e.message));
            }

            const retryResult = await this.getDecryptedManifestResult(true);
            if (retryResult.status !== 'ok') {
                throw new Error(lm.t("Failed to get remote manifest after recreation attempt"));
            }
            return retryResult.manifest;
        } catch (error: any) {
            vscode.window.showErrorMessage(lm.t('ensureRemoteManifest failed: {0}', error.message));
            throw error;
        }
    }

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
        token?: vscode.CancellationToken,
        force: boolean = false
    ): Promise<void> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();

        // Never sync archived conversations (even during force sync)
        if (this.isConversationArchived(convId, remoteManifest)) {
            return;
        }

        const lm = LocalizationManager.getInstance();
        const local = localConversations.find(c => c.id === convId);
        const remote = remoteManifest.conversations.find(c => c.id === convId);
        const title = local?.title || remote?.title || convId;
        const lastSyncedHash = lastSyncedDatabase.get(convId);

        const recordPullError = (error: any) => {
            if (error instanceof vscode.CancellationError) throw error;
            const msg = error?.message || String(error);
            result.errors.push(`Failed to pull ${convId}: ${msg}`);
            if (msg.includes('not found in Drive') || msg.includes('not found in manifest')) {
                if (!result.missingRemoteIds) result.missingRemoteIds = [];
                if (!result.missingRemoteIds.includes(convId)) {
                    result.missingRemoteIds.push(convId);
                }
            }
        };

        const doPush = async () => {
            try {
                await this.pushConversation(convId, progress, token);
                result.pushed.push(convId);
            } catch (error: any) {
                if (error instanceof vscode.CancellationError) throw error;
                result.errors.push(`Failed to push ${convId}: ${error.message}`);
            }
        };

        const doPull = async (forceOverwrite: boolean) => {
            try {
                await this.pullConversation(convId, progress, token, forceOverwrite);
                result.pulled.push(convId);
            } catch (error: any) {
                recordPullError(error);
            }
        };

        // Auto-correct remote title if local exists with a human-readable title and differs,
        // WITHOUT overwriting modifiedBy or lastModified.
        if (local && remote && local.title !== remote.title && local.title !== local.id) {
            await this.updateManifestTitleOnly(convId, local.title);
        }

        this.reportProgress(progress, lm.t('Syncing "{0}"...', title));

        if (local && !remote) {
            // Check remote deletion tombstone before re-pushing
            const tombstone = remoteManifest.deletedConversations?.[convId];
            if (tombstone && lastSyncedHash) {
                const wsConfig = vscode.workspace.getConfiguration(EXT_NAME);
                const authorizedIds = wsConfig.get<string[]>('sync.authorizedRemoteDeleteMachineIds') || [];
                const isAuthorizedDeleter =
                    tombstone.deletedBy === this.config?.machineId ||
                    authorizedIds.includes(tombstone.deletedBy);

                if (isAuthorizedDeleter && local.hash === lastSyncedHash) {
                    // Authorized remote deletion and no local changes -> honor deletion safely with pre-sync backup
                    await this.backupConversationBeforePull(convId, title, progress);
                    const brainPath = path.join(getBrainDir(), convId);
                    if (fs.existsSync(brainPath)) {
                        await fs.promises.rm(brainPath, { recursive: true, force: true });
                    }
                    const convDir = getConvDir();
                    for (const ext of ['.pb', '.db', '.db-wal', '.db-shm']) {
                        const fp = path.join(convDir, `${convId}${ext}`);
                        try { await fs.promises.unlink(fp); } catch { /* ignore */ }
                    }
                    console.log(`[Sync] Honored remote deletion of ${convId} by authorized machine ${tombstone.deletedBy}`);
                    return;
                }
            }

            await doPush();
        } else if (!local && remote) {
            await doPull(true);
        } else if (local && remote) {
            // Both exist
            if (local.hash === remote.hash) {
                if (!force) {
                    return; // Already in sync
                }
                // Force sync with identical hashes -> push without creating a false conflict
                await doPush();
                return;
            }

            const remoteChanged = remote.hash !== lastSyncedHash;
            const localChanged = local.hash !== lastSyncedHash;

            const remoteMachine = remoteManifest.machines?.find(m => m.id === remote.modifiedBy);
            const myMachineId = this.config?.machineId;
            // Strict same-device identity check by machineId ONLY
            const isSameDevice = Boolean(remote.modifiedBy && myMachineId && remote.modifiedBy === myMachineId);

            // 1. Same-device sequential edits
            if (isSameDevice) {
                const localTime = new Date(local.lastModified).getTime();
                const remoteTime = new Date(remote.lastModified).getTime();
                if (localTime >= remoteTime) {
                    await doPush();
                } else {
                    await doPull(true);
                }
                return;
            }

            // 2. Clean 3-way merge BEFORE conflictPolicy (only one side changed)
            if (lastSyncedHash) {
                if (localChanged && !remoteChanged) {
                    await doPush();
                    return;
                }
                if (remoteChanged && !localChanged) {
                    await doPull(true);
                    return;
                }
            }

            // 3. True conflict (both sides diverged OR first sync across distinct machines with differing hashes)
            const conflictPolicy = vscode.workspace.getConfiguration(EXT_NAME).get<string>('sync.conflictResolution', 'prompt');

            if (conflictPolicy === 'keepLocal') {
                await doPush();
                return;
            } else if (conflictPolicy === 'keepRemote') {
                await doPull(true);
                return;
            } else if (conflictPolicy === 'keepNewer') {
                const localTime = new Date(local.lastModified).getTime();
                const remoteTime = new Date(remote.lastModified).getTime();
                if (localTime >= remoteTime) {
                    await doPush();
                } else {
                    await doPull(true);
                }
                return;
            } else if (conflictPolicy === 'keepLarger') {
                if ((local.size ?? 0) >= (remote.size ?? 0)) {
                    await doPush();
                } else {
                    await doPull(true);
                }
                return;
            }

            // 'prompt' policy -> report conflict for interactive resolution
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
        }
    }

    /**
     * Opens the most recently modified conversation in the specialized chat view.
     * Prioritizes the current workspace and real-time server data.
     */
    /**
     * Helper to retrieve the latest trajectory ID and title from the server.
     */
    private async getServerLatestTrajectoryId(): Promise<{ id: string, title?: string } | undefined> {
        try {
            const response = await this.apiClient.request('GetAllCascadeTrajectories', {});
            const rawSummaries = response?.trajectorySummaries;
            let trajectories: any[] = [];

            if (Array.isArray(rawSummaries)) {
                trajectories = rawSummaries;
            } else if (rawSummaries && typeof rawSummaries === 'object') {
                trajectories = Object.entries(rawSummaries).map(([key, value]: [string, any]) => ({
                    ...value,
                    cascadeId: key
                }));
            }

            if (trajectories.length > 0) {
                // Get current workspace info to filter if possible
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const workspaceNames = new Set((workspaceFolders || []).map(f => f.name.toLowerCase()));

                // Sort trajectories by lastModifiedTime descending
                const sorted = [...trajectories].sort((a, b) => {
                    const timeA = a.lastModifiedTime ? new Date(a.lastModifiedTime).getTime() : 0;
                    const timeB = b.lastModifiedTime ? new Date(b.lastModifiedTime).getTime() : 0;
                    return timeB - timeA;
                });

                // Try to find the latest that matches the current workspace
                let target = sorted.find(t => {
                    if (!t.workspaces || !Array.isArray(t.workspaces)) return false;
                    return t.workspaces.some((ws: any) => {
                        const wsName = (ws.name || ws.repository?.computedName || '').toLowerCase();
                        return wsName && workspaceNames.has(wsName);
                    });
                });

                // Fallback to absolute latest if no workspace match
                if (!target) target = sorted[0];

                const title = target.progressTitle || target.summary || target.name || target.title;
                return {
                    id: target.cascadeId,
                    title: (title && title !== target.cascadeId) ? title : undefined
                };
            }
        } catch (error) {
            console.error('Failed to get server latest trajectory:', error);
        }
        return undefined;
    }

    /**
     * Get a map of cascade IDs to their titles from the Antigravity server.
     * Used to enrich manifest data with readable titles.
     */
    private async getServerTitleMap(): Promise<Map<string, string>> {
        const titleMap = new Map<string, string>();
        try {
            const response = await this.apiClient.request('GetAllCascadeTrajectories', {});
            const rawSummaries = response?.trajectorySummaries;
            let trajectories: any[] = [];

            if (Array.isArray(rawSummaries)) {
                trajectories = rawSummaries;
            } else if (rawSummaries && typeof rawSummaries === 'object') {
                trajectories = Object.entries(rawSummaries).map(([key, value]: [string, any]) => ({
                    ...value,
                    cascadeId: key
                }));
            }

            for (const t of trajectories) {
                const id = t.cascadeId;
                const title = t.progressTitle || t.summary || t.name || t.title;
                if (id && title && title !== id) {
                    titleMap.set(id, title);
                }
            }
        } catch {
            // Ignore - server might not be available
        }
        return titleMap;
    }

    /**
     * Opens the most recently modified conversation in the specialized chat view.
     * Prioritizes the current workspace and real-time server data.
     */
    async openCurrentConversation(): Promise<void> {
        const lm = LocalizationManager.getInstance();

        // Priority 1: Server API
        const serverResult = await this.getServerLatestTrajectoryId();
        if (serverResult) {
            // Priority: Server Title > Local Title > ID
            let displayTitle = serverResult.title;

            if (!displayTitle || displayTitle === serverResult.id) {
                // Fallback to local title if server title is missing or same as ID
                const localTitle = this.getConversationTitle(serverResult.id);
                if (localTitle && localTitle !== serverResult.id) {
                    displayTitle = localTitle;
                }
            }

            // Final fallback to ID
            if (!displayTitle) {
                displayTitle = serverResult.id;
            }

            await this.openPbChat(serverResult.id, displayTitle);
            return;
        }

        // Priority 2: Fallback to the existing file-system-based detection (brain/ directory)
        const conversations = await getConversationsAsync(getBrainDir());
        if (conversations.length === 0) {
            vscode.window.showInformationMessage(lm.t('No conversations found locally.'));
            return;
        }

        // getConversationsAsync already returns sorted, but we ensure descending here
        const latestLocal = [...conversations].sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())[0];
        await this.openPbChat(latestLocal.id, latestLocal.label || latestLocal.id);
    }

    private getActiveConversationId(currentMachineId: string, serverActiveId?: string): string | undefined {
        // Priority 1: Check active text editor for Antigravity-specific files
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const fsPath = activeEditor.document.uri.fsPath;
            // Matches brain/<id>/task.md or brain/<id>/...
            const brainMatch = fsPath.match(/[\\/]brain[\\/]([a-f0-9-]{36})[\\/]/i);
            if (brainMatch) return brainMatch[1];

            // Matches .pb trajectories
            const pbMatch = fsPath.match(/([a-f0-9-]{36})\.(?:pb|trajectory)$/i);
            if (pbMatch) return pbMatch[1];
        }

        // Priority 2: Check visible text editors (useful if the dashboard is the active tab)
        for (const editor of vscode.window.visibleTextEditors) {
            const fsPath = editor.document.uri.fsPath;
            const brainMatch = fsPath.match(/[\\/]brain[\\/]([a-f0-9-]{36})[\\/]/i);
            if (brainMatch) return brainMatch[1];

            const pbMatch = fsPath.match(/([a-f0-9-]{36})\.(?:pb|trajectory)$/i);
            if (pbMatch) return pbMatch[1];
        }

        // Priority 3: Server Reported Active (Real-time Webview)
        if (serverActiveId) return serverActiveId;

        // Priority 4: Last opened/viewed via Antigravity UI
        if (this.lastActiveConversationId) return this.lastActiveConversationId;

        // Priority 5: Default to last modified (existing behavior, but moved here as final fallback)
        if (this.lastStatsData?.localConversations?.length > 0) {
            const latest = [...this.lastStatsData.localConversations].sort((a, b) =>
                new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
            )[0];
            return latest.id;
        }

        return undefined;
    }

    async manageConversations(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const conversations = await getConversationsAsync(getBrainDir());
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

        const patreonBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('heart'), tooltip: lm.t('Support on Patreon') };
        const coffeeBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('coffee'), tooltip: lm.t('Buy Me a Coffee') };
        const githubBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('star'), tooltip: lm.t('Star on GitHub') };
        let sortBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: '' };

        const updateSortButton = () => {
            let sortTooltip = lm.t('Sort by Modified Date and Time');
            if (currentSort === 'created') sortTooltip = lm.t('Sort by Created Date and Time');
            if (currentSort === 'name') sortTooltip = lm.t('Sort by Name');

            sortBtn = { iconPath: new vscode.ThemeIcon('list-ordered'), tooltip: `${lm.t('Sort')}: ${sortTooltip}` };
            quickPick.buttons = [patreonBtn, coffeeBtn, githubBtn, sortBtn];
        };

        const updateItems = () => {
            quickPick.items = prepareItems(conversations, currentSort);

            if (currentSelection === 'all') {
                quickPick.selectedItems = quickPick.items;
            } else if (Array.isArray(currentSelection)) {
                quickPick.selectedItems = quickPick.items.filter(i => i.id && currentSelection.includes(i.id));
            }

            updateSortButton();
        };

        updateItems();

        // Handle Button Click by button object reference (locale-safe)
        quickPick.onDidTriggerButton(button => {
            if (button === patreonBtn) {
                vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
            } else if (button === coffeeBtn) {
                vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
            } else if (button === githubBtn) {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/unchase/antigravity-storage-manager'));
            } else if (button === sortBtn) {
                if (currentSort === 'modified') currentSort = 'created';
                else if (currentSort === 'created') currentSort = 'name';
                else currentSort = 'modified';

                const previousSelectionIds = quickPick.selectedItems.map(i => i.id);
                quickPick.items = prepareItems(conversations, currentSort);
                quickPick.selectedItems = quickPick.items.filter(i => i.id && previousSelectionIds.includes(i.id));

                updateSortButton();
            }
        });

        const result = await new Promise<(vscode.QuickPickItem & { id: string })[] | undefined>((resolve) => {
            let accepted = false;
            quickPick.onDidAccept(() => {
                accepted = true;
                const selected = quickPick.selectedItems.filter(i => !i.id?.startsWith('sort_')) as (vscode.QuickPickItem & { id: string })[];
                resolve(selected);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                if (!accepted) resolve(undefined);
                quickPick.dispose();
            });
            quickPick.show();
        });

        if (result && this.config) {
            if (conversations.length > 0 && result.length === conversations.length) {
                this.config.selectedConversations = 'all';
            } else {
                this.config.selectedConversations = result.map(s => s.id);
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

        // Show skeleton immediately
        SyncStatsWebview.showWithSkeleton(this.context, (msg) => this.handleSyncStatsMessage(msg));

        // Then fetch data with a small delay to prevent ServiceWorker InvalidStateError in VSCode 1.95+
        // (Fast double assignment of webview.html crashes internal SW)
        setTimeout(() => {
            this.refreshStatistics(false);
        }, 300);
    }

    private async deleteConversation(id: string): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const brainPath = path.join(getBrainDir(), id);
        const convDir = getConvDir();

        try {
            if (fs.existsSync(brainPath)) {
                await fs.promises.rm(brainPath, { recursive: true, force: true });
            }
            for (const ext of ['.pb', '.db', '.db-wal', '.db-shm']) {
                const filePath = path.join(convDir, `${id}${ext}`);
                if (fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath);
                    this.fileHashCache.delete(filePath);
                }
            }

            // Delete remote files/folders AND update manifest via serialized queue with tombstone
            await this.driveService.deleteConversation(id);
            await this.enqueueManifestUpdate((manifest) => {
                manifest.conversations = manifest.conversations.filter(c => c.id !== id);
                if (manifest.archivedConversations?.[id]) {
                    delete manifest.archivedConversations[id];
                }
                if (!manifest.deletedConversations) {
                    manifest.deletedConversations = {};
                }
                manifest.deletedConversations[id] = {
                    deletedAt: new Date().toISOString(),
                    deletedBy: this.config?.machineId || 'unknown'
                };
                return true;
            });

            // Also remove from local archived list if present
            const localArchived = this.getLocalArchivedConversationIds();
            if (localArchived.delete(id)) {
                await this.saveLocalArchivedConversationIds(localArchived);
            }

            vscode.window.showInformationMessage(lm.t('Conversation deleted.'));
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Error deleting: {0}', e.message));
        }
    }

    /**
     * Get locally stored archived conversation IDs (used when offline or before sync is configured).
     */
    private getLocalArchivedConversationIds(): Set<string> {
        const result = new Set<string>();
        const fromConfig = this.config?.archivedConversations;
        if (Array.isArray(fromConfig)) {
            for (const id of fromConfig) {
                if (typeof id === 'string' && id.trim()) result.add(id.trim());
            }
        }
        const fromGlobal = this.context.globalState.get<string[]>(ARCHIVED_CONVERSATIONS_KEY, []);
        if (Array.isArray(fromGlobal)) {
            for (const id of fromGlobal) {
                if (typeof id === 'string' && id.trim()) result.add(id.trim());
            }
        }
        return result;
    }

    /**
     * Persist local archived conversation IDs to both config (if initialized) and globalState.
     */
    private async saveLocalArchivedConversationIds(ids: Set<string>): Promise<void> {
        const list = Array.from(ids).sort();
        await this.context.globalState.update(ARCHIVED_CONVERSATIONS_KEY, list);
        if (this.config) {
            this.config.archivedConversations = list;
            await this.saveConfig();
        }
    }

    /**
     * Get the effective set of archived conversation IDs (union of remote manifest and local fallback).
     */
    public getArchivedConversationIds(manifest?: SyncManifest | null): Set<string> {
        const archived = this.getLocalArchivedConversationIds();
        const effectiveManifest = manifest !== undefined ? manifest : this.cachedManifest;
        if (effectiveManifest?.archivedConversations) {
            for (const id of Object.keys(effectiveManifest.archivedConversations)) {
                if (effectiveManifest.archivedConversations[id]) {
                    archived.add(id);
                }
            }
        }
        return archived;
    }

    /**
     * Check whether a conversation is archived (and therefore excluded from sync).
     */
    public isConversationArchived(conversationId: string, manifest?: SyncManifest | null): boolean {
        return this.getArchivedConversationIds(manifest).has(conversationId);
    }

    /**
     * Archive one or more conversations so they no longer participate in synchronization.
     * Files stay untouched locally and remotely; only the archive state is persisted.
     */
    public async archiveConversations(ids: string[]): Promise<number> {
        const uniqueIds = Array.from(new Set(ids.map(id => (id || '').trim()).filter(Boolean)));
        if (uniqueIds.length === 0) return 0;

        let persistedToManifest = false;
        if (this.isReady()) {
            try {
                const now = new Date().toISOString();
                const archivedBy = this.config?.machineId || 'unknown';
                await this.enqueueManifestUpdate((manifest) => {
                    if (!manifest.archivedConversations) {
                        manifest.archivedConversations = {};
                    }
                    let changed = false;
                    for (const id of uniqueIds) {
                        if (!manifest.archivedConversations[id]) {
                            manifest.archivedConversations[id] = { archivedAt: now, archivedBy };
                            changed = true;
                        }
                    }
                    return changed;
                });
                persistedToManifest = true;
            } catch (e) {
                console.warn('[SyncManager] Failed to persist archived state to remote manifest, falling back to local storage:', e);
            }
        }

        const localArchived = this.getLocalArchivedConversationIds();
        if (persistedToManifest) {
            // Keep manifest as the single source of truth so another device can unarchive cleanly
            let localChanged = false;
            for (const id of uniqueIds) {
                if (localArchived.delete(id)) localChanged = true;
            }
            if (localChanged) {
                await this.saveLocalArchivedConversationIds(localArchived);
            }
        } else {
            for (const id of uniqueIds) {
                localArchived.add(id);
            }
            await this.saveLocalArchivedConversationIds(localArchived);
        }

        return uniqueIds.length;
    }

    /**
     * Unarchive one or more conversations so they participate in synchronization again.
     */
    public async unarchiveConversations(ids: string[]): Promise<number> {
        const uniqueIds = Array.from(new Set(ids.map(id => (id || '').trim()).filter(Boolean)));
        if (uniqueIds.length === 0) return 0;

        const localArchived = this.getLocalArchivedConversationIds();
        let localChanged = false;
        for (const id of uniqueIds) {
            if (localArchived.delete(id)) localChanged = true;
        }
        if (localChanged) {
            await this.saveLocalArchivedConversationIds(localArchived);
        }

        if (this.isReady()) {
            await this.enqueueManifestUpdate((manifest) => {
                if (!manifest.archivedConversations) return false;
                let changed = false;
                for (const id of uniqueIds) {
                    if (manifest.archivedConversations[id]) {
                        delete manifest.archivedConversations[id];
                        changed = true;
                    }
                }
                return changed;
            });
        }

        return uniqueIds.length;
    }

    public async archiveConversation(id: string): Promise<void> {
        await this.archiveConversations([id]);
    }

    public async unarchiveConversation(id: string): Promise<void> {
        await this.unarchiveConversations([id]);
    }

    /**
     * Interactive multi-select command to archive active conversations.
     */
    public async archiveConversationsInteractive(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const [localConversations, remoteManifest] = await Promise.all([
            this.getLocalConversationsAsync({ skipHashes: true }),
            this.isReady() ? this.getDecryptedManifest().catch(() => null) : Promise.resolve(null)
        ]);
        const archivedIds = this.getArchivedConversationIds(remoteManifest);

        const allMap = new Map<string, { id: string; title: string; lastModified: string; source: string }>();
        for (const c of localConversations) {
            if (archivedIds.has(c.id)) continue;
            allMap.set(c.id, { id: c.id, title: c.title || c.id, lastModified: c.lastModified, source: lm.t('Local Only') });
        }
        if (remoteManifest?.conversations) {
            for (const r of remoteManifest.conversations) {
                if (archivedIds.has(r.id)) continue;
                const existing = allMap.get(r.id);
                const remoteTitle = r.title && r.title !== r.id ? r.title : undefined;
                if (existing) {
                    existing.title = remoteTitle || existing.title;
                    existing.source = lm.t('Synced');
                } else {
                    allMap.set(r.id, { id: r.id, title: r.title || r.id, lastModified: r.lastModified, source: lm.t('Cloud Only') });
                }
            }
        }

        const items = Array.from(allMap.values())
            .sort((a, b) => new Date(b.lastModified || 0).getTime() - new Date(a.lastModified || 0).getTime())
            .map(c => ({
                label: c.title,
                description: c.source,
                detail: c.id,
                id: c.id
            }));

        if (items.length === 0) {
            vscode.window.showInformationMessage(lm.t('No active conversations available to archive.'));
            return;
        }

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: lm.t('Archive Conversations'),
            placeHolder: lm.t('Select conversations to archive (excluded from sync)')
        });

        if (!selected || selected.length === 0) return;

        try {
            const count = await this.archiveConversations(selected.map(s => s.id));
            vscode.window.showInformationMessage(lm.t('Archived {0} conversation(s). They will be excluded from sync.', count));
            if (SyncStatsWebview.isVisible()) {
                this.refreshStatistics(true, false, true);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Failed to archive conversation: {0}', e.message));
        }
    }

    /**
     * Interactive multi-select command to unarchive archived conversations.
     */
    public async unarchiveConversationsInteractive(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const [localConversations, remoteManifest] = await Promise.all([
            this.getLocalConversationsAsync({ skipHashes: true }),
            this.isReady() ? this.getDecryptedManifest().catch(() => null) : Promise.resolve(null)
        ]);
        const archivedIds = this.getArchivedConversationIds(remoteManifest);

        if (archivedIds.size === 0) {
            vscode.window.showInformationMessage(lm.t('No archived conversations.'));
            return;
        }

        const items = Array.from(archivedIds).map(id => {
            const local = localConversations.find(c => c.id === id);
            const remote = remoteManifest?.conversations.find(c => c.id === id);
            const remoteTitle = remote?.title && remote.title !== id ? remote.title : null;
            const localTitle = local?.title && local.title !== id ? local.title : null;
            const title = remoteTitle || localTitle || remote?.title || local?.title || id;
            const archivedAt = remoteManifest?.archivedConversations?.[id]?.archivedAt;
            return {
                label: title,
                description: archivedAt ? lm.formatDateTime(archivedAt) : lm.t('Archived'),
                detail: id,
                id
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: lm.t('Unarchive Conversations'),
            placeHolder: lm.t('Select conversations to unarchive (restore to sync)')
        });

        if (!selected || selected.length === 0) return;

        try {
            const count = await this.unarchiveConversations(selected.map(s => s.id));
            vscode.window.showInformationMessage(lm.t('Unarchived {0} conversation(s). They will participate in sync again.', count));
            if (SyncStatsWebview.isVisible()) {
                this.refreshStatistics(true, false, true);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(lm.t('Failed to unarchive conversation: {0}', e.message));
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
            this.fileHashCache.delete(fullPath);
        }

        // 2. Delete remotely and update manifest through serialized queue
        await this.driveService.deleteConversationFile(conversationId, relativePath);
        await this.enqueueManifestUpdate((manifest) => {
            const remoteConv = manifest.conversations.find(c => c.id === conversationId);
            if (!remoteConv || !remoteConv.fileHashes || !remoteConv.fileHashes[relativePath]) {
                return false;
            }

            delete remoteConv.fileHashes[relativePath];
            remoteConv.hash = this.computeOverallHashFromFileHashes(remoteConv.fileHashes);
            remoteConv.size = Object.values(remoteConv.fileHashes).reduce((sum, info) => sum + info.size, 0);
            return true;
        });
    }

    private async renameConversationId(id: string, newTitle: string): Promise<void> {
        // Rename title in task.md locally
        const taskPath = path.join(getBrainDir(), id, 'task.md');
        if (fs.existsSync(taskPath)) {
            try {
                let content = await fs.promises.readFile(taskPath, 'utf8');
                if (content.match(/^#\s*Task:?\s*.*$/im)) {
                    content = content.replace(/^#\s*Task:?\s*.*$/im, `# Task: ${newTitle}`);
                } else {
                    content = `# Task: ${newTitle}\n\n${content}`;
                }
                await fs.promises.writeFile(taskPath, content, 'utf8');
            } catch { /* ignore */ }
        }

        // Update manifest title through serialized queue
        await this.enqueueManifestUpdate((manifest) => {
            const conv = manifest.conversations.find(c => c.id === id);
            if (!conv) return false;
            conv.title = newTitle;
            conv.lastModified = new Date().toISOString();
            return true;
        });
    }

    /**
     * Get MCP server states from the API client.
     * Falls back to reading mcp_config.json if the API returns empty.
     */
    private async getMcpServerStates(): Promise<any[] | undefined> {
        try {
            const states = await this.apiClient.getMcpServerStates();
            if (states && states.length > 0) {
                return states.map((s: any) => ({
                    serverId: s.serverId || s.id || 'unknown',
                    serverName: s.serverName || s.name || s.serverId || 'Unknown',
                    status: s.status || s.state || 'UNKNOWN',
                    tools: s.tools || [],
                    resources: s.resources || [],
                    lastError: s.lastError || s.error
                }));
            }

            // Fallback: read from mcp_config.json
            return this.getMcpServerStatesFromConfig();
        } catch (e) {
            console.error('Failed to get MCP server states from API, trying config file', e);
            // Fallback: try reading from config file even on API error
            try {
                return this.getMcpServerStatesFromConfig();
            } catch {
                return undefined; // undefined means not available, won't show section
            }
        }
    }

    /**
     * Read MCP server states from mcp_config.json file
     */
    private getMcpServerStatesFromConfig(): any[] {
        const configPath = path.join(getStorageRoot(), 'mcp_config.json');
        if (!fs.existsSync(configPath)) {
            return []; // Return empty array to show "No MCP servers" section
        }

        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(content);
            const servers = config.mcpServers || config.servers || {};
            const result: any[] = [];

            for (const [id, serverConfig] of Object.entries(servers)) {
                const cfg = serverConfig as any;
                const isDisabled = cfg.disabled === true;
                result.push({
                    serverId: id,
                    serverName: id,
                    status: isDisabled ? 'DISCONNECTED' : 'CONNECTED',
                    tools: [],
                    resources: [],
                    lastError: isDisabled ? 'Disabled in config' : undefined
                });
            }

            return result;
        } catch (e) {
            console.error('Failed to read mcp_config.json', e);
            return [];
        }
    }

    private async refreshStatistics(preserveFocus: boolean = true, showProgress: boolean = true, updateOnly: boolean = false) {
        const lm = LocalizationManager.getInstance();

        const loadTask = async () => {
            try {
                const start = Date.now();

                // Gather initial data in parallel (skip hashes for dashboard — not needed for display)
                const [localConversations, remoteManifest, currentQuota, machineFiles] = await Promise.all([
                    this.getLocalConversationsAsync({ skipHashes: true }),
                    this.getDecryptedManifest(true), // Force refresh from Drive
                    this.driveService.getStorageInfo(),
                    this.driveService.listMachineStates()
                ]);

                // Populate text for local conversations (limit concurrency)
                // OPTIMIZATION: Removed pre-fetching to improve load time.
                // Text is now fetched on-demand via 'getConversationDetails' command.
                /*
               await limitConcurrency(localConversations, 5, async (c: any) => {
                   try {
                       const steps = await this.apiClient.getConversationMessages(c.id);

                       // Process steps to generate preview text
                       if (steps && steps.length > 0) {
                           const textParts: string[] = [];
                           for (const step of steps) {
                               let text = '';

                               if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                                   // 1. Text extraction logic
                                   if (step.userInput?.userResponse) {
                                       // Priority: userResponse
                                       text = step.userInput.userResponse;
                                   } else if (step.userInput?.items && Array.isArray(step.userInput.items)) {
                                       // Fallback: items
                                       text = step.userInput.items
                                           .map((item: any) => item.text?.content || item.code?.value || '')
                                           .filter((t: string) => t.length > 0)
                                           .join('\n\n');
                                   }

                                   // 2. Media (Images) logic
                                   if (step.userInput?.media && Array.isArray(step.userInput.media)) {
                                       for (const media of step.userInput.media) {
                                           if (media.mimeType === 'image/png') {
                                               if (media.content) {
                                                   // data:image/png;base64,...
                                                   text += `\n\n![Image](data:image/png;base64,${media.content})`;
                                               } else if (media.path) {
                                                   // Local path (less common in webview, but handle if present)
                                                   // For webview, paths usually need vscode-resource scheme, but simple path for now
                                                   text += `\n\n![Image](${media.path})`;
                                               }
                                           }
                                       }
                                   }
                               } else if (step.type === 'CORTEX_STEP_TYPE_MODEL_RESPONSE') {
                                   if (step.modelResponse && step.modelResponse.content && Array.isArray(step.modelResponse.content)) {
                                       text = step.modelResponse.content.map((c: any) => c.text?.content || '').join('\n');
                                   } else if (step.modelResponse?.text) {
                                       text = step.modelResponse.text;
                                   }
                               } else if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
                                   text = step.plannerResponse?.thinking || '';
                               } else {
                                   text = step.message?.text || step.text || '';
                               }

                               if (text) {
                                   textParts.push(text);
                               }
                           }
                           c.text = textParts.join('\n\n');
                         } else {
                            // Fallback to PbParser if API returns empty but file exists?
                            // Or just leave empty.
                            const dbPath = path.join(getConvDir(), c.id + '.db');
                            const pbPath = path.join(getConvDir(), c.id + '.pb');
                            const filePath = fs.existsSync(dbPath) ? dbPath : (fs.existsSync(pbPath) ? pbPath : null);
                            if (filePath) {
                                const strings = await PbParser.extractStrings(filePath);
                                if (strings.length > 0) {
                                    c.text = strings.join('\n\n').substring(0, 5000);
                                }
                            }
                        }
                    } catch (e) {
                        // Fallback to PbParser on error
                        try {
                            const dbPath = path.join(getConvDir(), c.id + '.db');
                            const pbPath = path.join(getConvDir(), c.id + '.pb');
                            const filePath = fs.existsSync(dbPath) ? dbPath : (fs.existsSync(pbPath) ? pbPath : null);
                            if (filePath) {
                                const strings = await PbParser.extractStrings(filePath);
                                if (strings.length > 0) {
                                    c.text = strings.join('\n\n').substring(0, 5000);
                                }
                            }
                        } catch (err) {
                           // ignore
                       }
                   }
               });
               */

                const currentMachineName = this.getEffectiveMachineName();

                // Get machine states with limited concurrency (lazy factories)
                const machineConcurrency = vscode.workspace.getConfiguration(EXT_NAME).get<number>('sync.concurrency', 3);
                const machineFactories = machineFiles.map(file => async () => {
                    let machineName = lm.t('Unknown Device');
                    let lastSync = file.modifiedTime;
                    let syncCount = 0;
                    let quota: { used: number; limit: number } | undefined = undefined;

                    const machineId = file.name.replace('.json.enc', '');

                    try {
                        // Check if this file corresponds to the current machine
                        if (machineId === this.config!.machineId) {
                            return {
                                name: currentMachineName,
                                id: machineId,
                                fileId: 'current', // Not deletable
                                lastSync: lastSync,
                                isCurrent: true,
                                syncCount: this.syncCount,
                                uploadCount: this.uploadCount,
                                downloadCount: this.downloadCount,
                                quota: currentQuota || undefined,
                                accountQuota: this.quotaManager?.getLatestSnapshot(),
                                conversationStates: localConversations.map(c => ({ id: c.id }))
                            };
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

                // Use limited concurrency worker pool for machine states
                const machineResults: any[] = [];
                const machineQueue = [...machineFactories];
                const machineWorker = async () => {
                    while (machineQueue.length > 0) {
                        const factory = machineQueue.shift();
                        if (!factory) break;
                        machineResults.push(await factory());
                    }
                };
                await Promise.all(
                    Array(Math.min(machineConcurrency, machineFactories.length || 1))
                        .fill(null)
                        .map(() => machineWorker())
                );
                const machines = machineResults.flat().filter(m => m !== null) as any[];

                // Ensure current machine is always present
                if (!machines.some(m => m.isCurrent)) {
                    machines.push({
                        name: currentMachineName,
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

                // Inject virtual profiles for Quota rendering on this device
                const profileQuotas = await this.quotaManager?.getProfileQuotas() || [];
                for (const pq of profileQuotas) {
                    machines.push({
                        name: currentMachineName,
                        id: this.config!.machineId + '_' + pq.profileName,
                        fileId: 'virtual_profile',
                        lastSync: pq.snapshot.timestamp.toISOString(),
                        isCurrent: true,
                        isVirtualProfile: true,
                        profileName: pq.profileName,
                        syncCount: 0,
                        uploadCount: 0,
                        downloadCount: 0,
                        quota: undefined,
                        accountQuota: pq.snapshot,
                        conversationStates: []
                    });
                }

                // Merge machines from manifest (deduplicating strictly by machine ID to avoid ghost duplicates on rename)
                if (remoteManifest?.machines) {
                    for (const manifestMachine of remoteManifest.machines) {
                        const alreadyListed = machines.some(m => !m.isVirtualProfile && m.id === manifestMachine.id);
                        if (!alreadyListed) {
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


                // Use Drive API (about.get) to avoid requiring userinfo.email scope, which triggers re-auth
                const userInfo = await this.driveService?.getUserInfo().catch(() => null);
                const quotaSnapshot = this.quotaManager?.getLatestSnapshot();

                // Build usage history maps and track profile quotas
                const tracker = this.quotaManager?.getUsageTracker();

                // Track main account
                const usageHistory = new Map<string, { timestamp: number; usage: number }[]>();
                if (tracker && quotaSnapshot?.models) {
                    for (const model of quotaSnapshot.models) {
                        const history = tracker.getHistory(model.modelId);
                        if (history && history.length > 0) {
                            usageHistory.set(model.modelId, history);
                        }
                    }
                }

                // Track and collect history for virtual profiles (reuse profileQuotas fetched above)
                if (tracker) {
                    for (const pq of profileQuotas) {
                        tracker.track(pq.snapshot, pq.profileName);
                    }
                }

                // Attach usageHistory to each machine
                for (const machine of machines) {
                    if (tracker && machine.accountQuota?.models) {
                        const prefix = machine.isVirtualProfile ? machine.profileName : undefined;
                        const mHistory = new Map<string, { timestamp: number; usage: number }[]>();
                        for (const model of machine.accountQuota.models) {
                            const history = tracker.getHistory(model.modelId, prefix);
                            if (history && history.length > 0) {
                                mHistory.set(model.modelId, history);
                            }
                        }
                        if (mHistory.size > 0) {
                            machine.usageHistory = mHistory;
                        }
                    }
                }

                // Render final HTML using SyncStatsWebview
                const statsData: SyncStatsData = {
                    localConversations,
                    remoteManifest: remoteManifest || { conversations: [] } as any,
                    archivedIds: Array.from(this.getArchivedConversationIds(remoteManifest)),
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
                    usageHistory: usageHistory.size > 0 ? usageHistory : undefined,
                    activeConversationId: this.getActiveConversationId(this.config!.machineId, (await this.getServerLatestTrajectoryId())?.id),
                    mcpServerStates: await this.getMcpServerStates(),
                    isSyncEnabled: this.isSyncEnabled // Pass sync state to webview
                };

                this.lastStatsData = statsData;
                if (SyncStatsWebview.isVisible()) {
                    SyncStatsWebview.update(statsData);
                } else if (!updateOnly) {
                    SyncStatsWebview.show(this.context, statsData, (msg) => this.handleSyncStatsMessage(msg), preserveFocus);
                }

            } catch (error: any) {
                vscode.window.showErrorMessage(`${lm.t('Error loading statistics')}: ${error.message}`);
            } finally {
                this.isRefreshing = false; // Release lock
            }
        };

        if (this.isRefreshing) {
            console.log('Sync statistics refresh already in progress, skipping...');
            return;
        }

        this.isRefreshing = true;

        if (showProgress) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: lm.t('Loading Sync Statistics...'),
                cancellable: false
            }, loadTask);
        } else {
            await loadTask();
        }
    }

    private async handleSyncStatsMessage(message: any) {
        const lm = LocalizationManager.getInstance();
        switch (message.command) {
            case 'toggleSync': {
                this.isSyncEnabled = message.enabled;
                if (this.isSyncEnabled) {
                    // If enabling, trigger a refresh immediately (or start timer)
                    this.refreshStatistics(false);
                    // Also ensure auto-sync timer is restarted if it was stopped
                    if (this.config?.autoSync) {
                        this.startAutoSync();
                    }
                } else {
                    // If disabling, clear the timer
                    if (this.autoSyncTimer) {
                        clearInterval(this.autoSyncTimer);
                        this.autoSyncTimer = null;
                        this.nextAutoSyncTime = null;
                    }
                }
                // Update UI to reflect state
                if (this.lastStatsData) {
                    this.lastStatsData.isSyncEnabled = this.isSyncEnabled;
                    SyncStatsWebview.update(this.lastStatsData);
                }
                break;
            }
            case 'sort': {
                SyncStatsWebview.updateSort(message.table, message.col);
                if (this.lastStatsData) {
                    SyncStatsWebview.update(this.lastStatsData, true);
                } else {
                    this.refreshStatistics();
                }
                break;
            }
            case 'filterConversations': {
                const filter = message.filter;
                if (filter === 'active' || filter === 'archived' || filter === 'all') {
                    SyncStatsWebview.setConversationsFilter(filter);
                    if (this.lastStatsData) {
                        SyncStatsWebview.update(this.lastStatsData, true);
                    } else {
                        this.refreshStatistics();
                    }
                }
                break;
            }
            case 'archiveConversation': {
                try {
                    await this.archiveConversation(message.id);
                    if (this.lastStatsData) {
                        const archivedSet = new Set<string>(this.lastStatsData.archivedIds || []);
                        archivedSet.add(message.id);
                        this.lastStatsData.archivedIds = Array.from(archivedSet);
                        SyncStatsWebview.update(this.lastStatsData, true);
                    } else {
                        this.refreshStatistics(true, false, true);
                    }
                    vscode.window.showInformationMessage(lm.t('Conversation archived.'));
                } catch (e: any) {
                    vscode.window.showErrorMessage(lm.t('Failed to archive conversation: {0}', e.message));
                }
                break;
            }
            case 'unarchiveConversation': {
                try {
                    await this.unarchiveConversation(message.id);
                    if (this.lastStatsData) {
                        const archivedSet = new Set<string>(this.lastStatsData.archivedIds || []);
                        archivedSet.delete(message.id);
                        this.lastStatsData.archivedIds = Array.from(archivedSet);
                        SyncStatsWebview.update(this.lastStatsData, true);
                    } else {
                        this.refreshStatistics(true, false, true);
                    }
                    vscode.window.showInformationMessage(lm.t('Conversation unarchived.'));
                } catch (e: any) {
                    vscode.window.showErrorMessage(lm.t('Failed to unarchive conversation: {0}', e.message));
                }
                break;
            }
            case 'refresh': {
                this.refreshStatistics(false); // Force refresh
                break;
            }
            case 'forceSync': {
                vscode.commands.executeCommand(`${EXT_NAME}.forceSync`);
                break;
            }
            case 'getConversationDetails': {
                const { id } = message;
                try {
                    const steps = await this.apiClient.getConversationMessages(id);
                    let finalText = '';

                    if (steps && steps.length > 0) {
                        const textParts: string[] = [];
                        for (const step of steps) {
                            let text = '';

                            if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                                // 1. Text extraction logic
                                let textFromResponse = '';
                                let textFromItems = '';

                                if (step.userInput?.userResponse) {
                                    textFromResponse = step.userInput.userResponse;
                                }

                                if (step.userInput?.items && Array.isArray(step.userInput.items)) {
                                    textFromItems = step.userInput.items
                                        .map((item: any) => item.text?.content || item.code?.value || '')
                                        .filter((t: string) => t.length > 0)
                                        .join('\n\n');
                                }

                                // Use the longer text to avoid truncation
                                text = textFromResponse.length >= textFromItems.length ? textFromResponse : textFromItems;

                                // 2. Media (Images) logic
                                if (step.userInput?.media && Array.isArray(step.userInput.media)) {
                                    for (const media of step.userInput.media) {
                                        if (media.mimeType === 'image/png') {
                                            if (media.content) {
                                                text += `\n\n![Image](data:image/png;base64,${media.content})`;
                                            } else if (media.path) {
                                                text += `\n\n![Image](${media.path})`;
                                            }
                                        }
                                    }
                                }
                            } else if (step.type === 'CORTEX_STEP_TYPE_MODEL_RESPONSE') {
                                if (step.modelResponse && step.modelResponse.content && Array.isArray(step.modelResponse.content)) {
                                    text = step.modelResponse.content.map((c: any) => c.text?.content || '').join('\n');
                                } else if (step.modelResponse?.text) {
                                    text = step.modelResponse.text;
                                }
                            } else if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
                                text = step.plannerResponse?.thinking || '';
                            } else {
                                text = step.message?.text || step.text || '';
                            }

                            if (text) {
                                textParts.push(text);
                            }
                        }
                        finalText = textParts.join('\n\n');
                    }

                    // HYBRID STRATEGY: Fetch from local DB/PB as well and compare
                    let pbText = '';
                    const dbPath = path.join(getConvDir(), id + '.db');
                    const pbPath = path.join(getConvDir(), id + '.pb');
                    const filePath = fs.existsSync(dbPath) ? dbPath : (fs.existsSync(pbPath) ? pbPath : null);
                    if (filePath) {
                        try {
                            const strings = await PbParser.extractStrings(filePath);
                            if (strings.length > 0) {
                                pbText = strings.join('\n\n').substring(0, 5000); // Reasonable limit
                            }
                        } catch (e) {
                            console.warn('Hybrid: PbParser failed', e);
                        }
                    }

                    // Compare and select best text
                    // If PB text is significantly longer, prefer it (API might be truncated)
                    // If API text is roughly same or longer, prefer it (often better formatting/structure)
                    if (pbText.length > finalText.length + 20) {
                        // PB wins
                        finalText = pbText;

                        // BUT: We need to preserve images from API if they exist!
                        // We can re-scan steps for images and append them to pbText
                        if (steps && steps.length > 0) {
                            for (const step of steps) {
                                if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput?.media && Array.isArray(step.userInput.media)) {
                                    for (const media of step.userInput.media) {
                                        if (media.mimeType === 'image/png') {
                                            if (media.content) {
                                                finalText += `\n\n![Image](data:image/png;base64,${media.content})`;
                                            } else if (media.path) {
                                                finalText += `\n\n![Image](${media.path})`;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else if (!finalText && !pbText) {
                        finalText = '<i>No content available.</i>';
                    }

                    // Render to Markdown HTML
                    const html = SyncStatsWebview.renderMarkdown(finalText);

                    SyncStatsWebview.postMessage({
                        command: 'conversationDetails',
                        id: id,
                        html: html
                    });

                } catch (e) {
                    console.error('Failed to get conversation details', e);
                    SyncStatsWebview.postMessage({
                        command: 'conversationDetails',
                        id: id,
                        html: '<i>Failed to load content.</i>'
                    });
                }
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
                        // ignore
                    }
                }

                if (opened) break;

                const id = message.id;
                const dbPath = path.join(getConvDir(), `${id}.db`);
                const pbPath = path.join(getConvDir(), `${id}.pb`);
                const activePath = fs.existsSync(dbPath) ? dbPath : (fs.existsSync(pbPath) ? pbPath : null);
                if (activePath) {
                    const title = message.title || this.getConversationTitle(id) || id;
                    await this.openPbChat(id, title);
                } else {
                    const convPath = path.join(getBrainDir(), id);
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
                if (this.isSyncing) {
                    vscode.window.showWarningMessage(lm.t('Sync already in progress'));
                    break;
                }
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: lm.t('Uploading conversation...'),
                    cancellable: true
                }, async (progress, token) => {
                    this.isSyncing = true;
                    const machineId = this.config?.machineId;
                    let lockAcquired = false;
                    try {
                        if (machineId) {
                            lockAcquired = await this.driveService.acquireLock(machineId, DEFAULT_LOCK_TTL_MS);
                            if (!lockAcquired) {
                                throw new Error(lm.t('Sync is currently locked by another machine. Please try again later.'));
                            }
                        }
                        await this.pushConversation(message.id, progress, token);
                        await this.updateMachineState();
                        vscode.window.showInformationMessage(lm.t('Conversation uploaded.'));
                        this.refreshStatistics();
                    } catch (e: any) {
                        if (e instanceof vscode.CancellationError) return;
                        vscode.window.showErrorMessage(lm.t('Upload failed: {0}', e.message));
                    } finally {
                        if (lockAcquired && machineId) {
                            await this.driveService.releaseLock(machineId);
                        }
                        this.isSyncing = false;
                    }
                });
                break;
            case 'pullConversation':
                if (this.isSyncing) {
                    vscode.window.showWarningMessage(lm.t('Sync already in progress'));
                    break;
                }
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: lm.t('Downloading conversation...'),
                    cancellable: true
                }, async (progress, token) => {
                    this.isSyncing = true;
                    const machineId = this.config?.machineId;
                    let lockAcquired = false;
                    try {
                        if (machineId) {
                            lockAcquired = await this.driveService.acquireLock(machineId, DEFAULT_LOCK_TTL_MS);
                            if (!lockAcquired) {
                                throw new Error(lm.t('Sync is currently locked by another machine. Please try again later.'));
                            }
                        }
                        await this.pullConversation(message.id, progress, token, true);
                        await this.updateMachineState();
                        vscode.window.showInformationMessage(lm.t('Conversation downloaded.'));
                        this.refreshStatistics();
                    } catch (e: any) {
                        if (e instanceof vscode.CancellationError) return;
                        vscode.window.showErrorMessage(lm.t('Download failed: {0}', e.message));
                    } finally {
                        if (lockAcquired && machineId) {
                            await this.driveService.releaseLock(machineId);
                        }
                        this.isSyncing = false;
                    }
                });
                break;
            case 'deleteMachine': {
                if (
                    message.id === 'current' ||
                    message.id === 'virtual_profile' ||
                    (message.machineId && message.machineId === this.config?.machineId)
                ) {
                    vscode.window.showWarningMessage(lm.t('Cannot remove the current active machine.'));
                    break;
                }
                const confirm = await vscode.window.showWarningMessage(
                    lm.t('Are you sure you want to remove machine "{0}" from sync stats?', message.name),
                    { modal: true },
                    lm.t('Remove'),
                    lm.t('Cancel')
                );
                if (confirm === lm.t('Remove')) {
                    try {
                        // 1. Remove Drive state file if a real fileId was provided
                        if (message.id && message.id.trim() !== '') {
                            await this.driveService.deleteFile(message.id);
                        }

                        // 2. Remove from Manifest through serialized queue (match by machineId strictly when provided)
                        await this.enqueueManifestUpdate((manifest) => {
                            if (!manifest.machines) return false;
                            const initialCount = manifest.machines.length;
                            manifest.machines = manifest.machines.filter(m => {
                                if (message.machineId) {
                                    return m.id !== message.machineId;
                                }
                                return m.name !== message.name;
                            });
                            return manifest.machines.length < initialCount;
                        });

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
                const query = typeof message.query === 'string' ? message.query.trim() : '';
                if (!query) {
                    // Clear search
                    if (this.lastStatsData) {
                        this.lastStatsData.searchResults = undefined;
                        this.lastStatsData.searchQuery = undefined;
                        SyncStatsWebview.update(this.lastStatsData, true);
                    }
                    return;
                }

                // Perform hybrid search (local titles, brain/*.md, transcript.jsonl, .db/.pb + optional RPC)
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: lm.t('Searching history...'),
                    cancellable: true
                }, async (_progress, token) => {
                    try {
                        const results = await this.searchConversations(query, token);
                        if (token.isCancellationRequested) return;
                        if (this.lastStatsData) {
                            this.lastStatsData.searchResults = results;
                            this.lastStatsData.searchQuery = query;
                            SyncStatsWebview.update(this.lastStatsData, true);
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(lm.t('Search failed: {0}', e.message));
                    }
                });
                break;
            }
            case 'refreshMcp': {
                try {
                    await this.apiClient.refreshMcpServers();
                    // Wait a bit for servers to reconnect
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    this.refreshStatistics(true, false);
                } catch (e: any) {
                    vscode.window.showErrorMessage(lm.t('Failed to refresh MCP servers: {0}', e.message));
                }
                break;
            }
            case 'switchProfile': {
                if (message.profile) {
                    try {
                        const pm = this.quotaManager?.getProfileManager();
                        if (pm) {
                            await pm.switchProfile(message.profile);
                            vscode.window.showInformationMessage(lm.t('Switched to profile "{0}".', message.profile));
                            // Refresh to update quota data
                            setTimeout(() => this.refreshStatistics(false, false), 500);
                        } else {
                            vscode.window.showWarningMessage(lm.t('Profile manager is not available.'));
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(lm.t('Failed to switch profile: {0}', e.message));
                    }
                }
                break;
            }
        }
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

                const fetchRes = await this.getDecryptedManifestResult(true);
                if (fetchRes.status !== 'ok') {
                    throw new Error(fetchRes.status === 'error' ? fetchRes.error.message : 'Failed to load manifest');
                }
                const manifest = fetchRes.manifest;

                const toDelete = manifest.conversations.filter(c => c.createdBy === machineId);

                if (toDelete.length === 0) {
                    vscode.window.showInformationMessage(lm.t('No conversations found for this machine.'));
                    return;
                }

                const fileIds = toDelete.map(c => (c as any).fileId).filter((id: string) => !!id);
                for (const fid of fileIds) {
                    try {
                        await this.driveService.deleteFile(fid);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(lm.t('Failed to delete file {0}: {1}', fid, e.message));
                    }
                }

                // Delete conversation archives and v2 folders
                for (const c of toDelete) {
                    try {
                        await this.driveService.deleteConversation(c.id);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(lm.t('Failed to delete conversation zip {0}: {1}', c.id, e.message));
                    }
                }

                const deletedIds = new Set(toDelete.map(c => c.id));
                await this.enqueueManifestUpdate((freshManifest) => {
                    freshManifest.conversations = freshManifest.conversations.filter(c => !deletedIds.has(c.id));
                    if (!freshManifest.deletedConversations) {
                        freshManifest.deletedConversations = {};
                    }
                    const now = new Date().toISOString();
                    for (const id of deletedIds) {
                        freshManifest.deletedConversations[id] = {
                            deletedAt: now,
                            deletedBy: this.config?.machineId || machineId
                        };
                    }
                    return true;
                });

                vscode.window.showInformationMessage(lm.t('Conversations deleted.'));
                await this.refreshStatistics(false, false);

            } catch (error: any) {
                vscode.window.showErrorMessage(`${lm.t('Error')}: ${error.message}`);
                await this.refreshStatistics(false, false);
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
            const currentMachineName = this.getEffectiveMachineName() || lm.t('Current Machine');
            machinesMap.set(this.config.machineId, {
                name: currentMachineName,
                lastSync: new Date().toISOString(), // Assume active
                createdAt: undefined // Unknown start for current without manifest lookup, but acceptable
            });

            // Add from manifest machines (rich info, keeping effective name for current machine)
            if (manifest.machines) {
                for (const m of manifest.machines) {
                    machinesMap.set(m.id, {
                        name: m.id === this.config.machineId ? currentMachineName : m.name,
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
        this.lastActiveConversationId = id;
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

        // Register message handler BEFORE try block so fallback local chat also responds to openFile/viewImage
        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'openFile': {
                    if (typeof msg.path !== 'string' || !msg.path) break;
                    let filePath = msg.path;
                    let lineRange: string | undefined;

                    if (filePath.includes('#')) {
                        [filePath, lineRange] = filePath.split('#');
                    } else {
                        const matches = filePath.match(/:(\d+(?:-\d+)?)$/);
                        if (matches) {
                            lineRange = matches[1];
                            filePath = filePath.substring(0, filePath.length - matches[0].length);
                        }
                    }

                    try {
                        filePath = decodeURIComponent(filePath);
                    } catch {
                        // Keep original string if URI contains malformed percent encoding
                    }
                    if (filePath.match(/^\/[a-zA-Z]:/)) {
                        filePath = filePath.substring(1);
                    }

                    if (!isSafeLocalFsPath(filePath)) {
                        vscode.window.showErrorMessage(lm.t('File or directory not found: {0}', filePath));
                        break;
                    }

                    let fullPath = '';
                    if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
                        fullPath = filePath;
                    } else {
                        try {
                            fullPath = this.getFullPathForRelative(id, filePath);
                        } catch {
                            const workspaceFolders = vscode.workspace.workspaceFolders;
                            if (workspaceFolders) {
                                for (const folder of workspaceFolders) {
                                    let p = path.join(folder.uri.fsPath, filePath);
                                    if (isSafeLocalFsPath(p) && fs.existsSync(p)) {
                                        fullPath = p;
                                        break;
                                    }
                                    p = path.join(getBrainDir(), id, filePath);
                                    if (isSafeLocalFsPath(p) && fs.existsSync(p)) {
                                        fullPath = p;
                                        break;
                                    }
                                }
                            }

                            if (!fullPath || !fs.existsSync(fullPath)) {
                                const fileName = path.basename(filePath);
                                const results = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 1);
                                if (results && results.length > 0) {
                                    fullPath = results[0].fsPath;
                                }
                            }
                        }
                    }

                    if (fullPath && isSafeLocalFsPath(fullPath) && fs.existsSync(fullPath)) {
                        const isDirectory = fs.statSync(fullPath).isDirectory();
                        if (isDirectory) {
                            vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(fullPath));
                        } else {
                            try {
                                const doc = await vscode.workspace.openTextDocument(fullPath);
                                const options: vscode.TextDocumentShowOptions = {};

                                if (lineRange) {
                                    const cleanRange = lineRange.replace(/^[:L]/, '');
                                    const parts = cleanRange.split('-');
                                    const startLine = parseInt(parts[0], 10) - 1;
                                    const endLine = parts.length > 1 ? parseInt(parts[1], 10) - 1 : startLine;

                                    if (!isNaN(startLine) && startLine >= 0) {
                                        options.selection = new vscode.Range(startLine, 0, Math.max(startLine, isNaN(endLine) ? startLine : endLine), 1000);
                                    }
                                }
                                await vscode.window.showTextDocument(doc, options);
                            } catch {
                                vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fullPath));
                            }
                        }
                    } else {
                        vscode.window.showErrorMessage(lm.t('File or directory not found: {0}', filePath));
                    }
                    break;
                }
                case 'viewImage': {
                    break;
                }
            }
        });

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
                        let detail = await this.apiClient.getUserTrajectory(tid);

                        if (!detail || !detail.trajectory?.steps || detail.trajectory.steps.length === 0) {
                            const fetchedSteps = await this.apiClient.getConversationMessages(tid);
                            if (fetchedSteps && fetchedSteps.length > 0) {
                                detail = { trajectory: { steps: fetchedSteps } };
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
                        const fetchedStep = detail.trajectory.steps.find((fsItem: any) => fsItem.stepIndex === info.stepIndex)
                            || detail.trajectory.steps[info.stepIndex];
                        if (fetchedStep) {
                            Object.assign(s, fetchedStep);
                        }
                    }
                });
            }

            if (steps.length === 0) {
                const localData = await this.getLocalConversationData(id);
                if (localData && localData.steps.length > 0) {
                    panel.webview.html = this.getChatHtml(filename, localData.steps, localData.metadata);
                    return;
                }
            }

            panel.webview.html = this.getChatHtml(filename, steps, metadata);
        } catch (e: any) {
            // Attempt fallback to local transcript.jsonl or task.md if trajectory was not found on server
            try {
                const localData = await this.getLocalConversationData(id);
                if (localData && localData.steps.length > 0) {
                    panel.webview.html = this.getChatHtml(filename, localData.steps, localData.metadata);
                    return;
                }
            } catch {
                // ignore fallback error
            }
            panel.webview.html = this.getChatErrorHtml(e.message);
        }
    }

    /**
     * Hybrid search across conversation titles/IDs, local brain/*.md files, transcript.jsonl,
     * conversation .db/.db-wal/.pb files (bounded chunk scan), plus optional language server RPC.
     */
    public async searchConversations(query: string, token?: vscode.CancellationToken): Promise<SearchResult[]> {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const queryLower = trimmed.toLowerCase();

        const MAX_MATCHES_PER_CONV = 5;
        const MAX_MD_BYTES = 2 * 1024 * 1024;       // 2 MB per markdown file
        const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024; // 8 MB per transcript.jsonl
        const MAX_BINARY_SCAN_BYTES = 16 * 1024 * 1024; // 16 MB scan cap per .db/.pb file
        const CHUNK_SIZE = 1024 * 1024;             // 1 MB streaming chunks
        const CHUNK_OVERLAP = 512;

        const cleanSnippet = (raw: string): string =>
            // eslint-disable-next-line no-control-regex
            raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uFFFD]+/g, ' ').replace(/\s+/g, ' ').trim();

        const extractSnippet = (text: string, idx: number, qLen: number): string => {
            const start = Math.max(0, idx - 100);
            const end = Math.min(text.length, idx + qLen + 140);
            const prefix = start > 0 ? '...' : '';
            const suffix = end < text.length ? '...' : '';
            return `${prefix}${cleanSnippet(text.slice(start, end))}${suffix}`;
        };

        const addUniqueMatch = (matches: Array<{ text: string; role: 'user' | 'model' }>, text: string, role: 'user' | 'model') => {
            if (matches.length >= MAX_MATCHES_PER_CONV) return;
            const cleaned = cleanSnippet(text);
            if (!cleaned) return;
            const key = cleaned.slice(0, 120).toLowerCase();
            if (matches.some(m => m.text.slice(0, 120).toLowerCase() === key)) return;
            matches.push({ text: cleaned.slice(0, 400) + (cleaned.length > 400 ? '...' : ''), role });
        };

        const scanBinaryFile = async (filePath: string, matches: Array<{ text: string; role: 'user' | 'model' }>): Promise<void> => {
            if (matches.length >= MAX_MATCHES_PER_CONV || !fs.existsSync(filePath)) return;
            let fd: fs.promises.FileHandle | undefined;
            try {
                const stat = await fs.promises.stat(filePath);
                const maxRead = Math.min(stat.size, MAX_BINARY_SCAN_BYTES);
                if (maxRead <= 0) return;
                fd = await fs.promises.open(filePath, 'r');
                const buf = Buffer.alloc(Math.min(CHUNK_SIZE, maxRead));
                let offset = 0;
                let tail = '';
                while (offset < maxRead && matches.length < MAX_MATCHES_PER_CONV) {
                    if (token?.isCancellationRequested) return;
                    const toRead = Math.min(buf.length, maxRead - offset);
                    const { bytesRead } = await fd.read(buf, 0, toRead, offset);
                    if (bytesRead <= 0) break;
                    const text = tail + buf.subarray(0, bytesRead).toString('utf8');
                    const lower = text.toLowerCase();
                    let searchFrom = 0;
                    while (matches.length < MAX_MATCHES_PER_CONV) {
                        const hit = lower.indexOf(queryLower, searchFrom);
                        if (hit === -1) break;
                        const snippet = extractSnippet(text, hit, queryLower.length);
                        addUniqueMatch(matches, snippet, 'model');
                        searchFrom = hit + Math.max(queryLower.length, 160);
                    }
                    tail = text.length > CHUNK_OVERLAP ? text.slice(-CHUNK_OVERLAP) : text;
                    offset += bytesRead;
                }
            } catch {
                // ignore unreadable binary files
            } finally {
                if (fd) {
                    await fd.close().catch(() => { /* ignore */ });
                }
            }
        };

        // Gather candidate conversations from current stats / local disk / cached manifest
        const candidates = new Map<string, { id: string; title: string; lastModified: number }>();
        const localConvs = this.lastStatsData?.localConversations
            || await this.getLocalConversationsAsync({ skipHashes: true }).catch(() => []);
        for (const c of localConvs) {
            candidates.set(c.id, {
                id: c.id,
                title: c.title || c.id,
                lastModified: c.lastModified ? new Date(c.lastModified).getTime() : 0
            });
        }
        const remoteConvs = this.lastStatsData?.remoteManifest?.conversations
            || this.cachedManifest?.conversations
            || [];
        for (const r of remoteConvs) {
            const existing = candidates.get(r.id);
            const remoteTitle = r.title && r.title !== r.id ? r.title : undefined;
            const remoteTs = r.lastModified ? new Date(r.lastModified).getTime() : 0;
            if (existing) {
                if (remoteTitle && existing.title === r.id) existing.title = remoteTitle;
                if (remoteTs > existing.lastModified) existing.lastModified = remoteTs;
            } else {
                candidates.set(r.id, {
                    id: r.id,
                    title: r.title || r.id,
                    lastModified: remoteTs
                });
            }
        }

        const resultsById = new Map<string, SearchResult>();
        const brainDir = getBrainDir();
        const convDir = getConvDir();
        const queue = Array.from(candidates.values());

        const worker = async () => {
            while (queue.length > 0) {
                if (token?.isCancellationRequested) return;
                const item = queue.shift();
                if (!item) break;

                const matches: Array<{ text: string; role: 'user' | 'model' }> = [];

                // 1. Title & ID match
                if (item.title.toLowerCase().includes(queryLower) || item.id.toLowerCase().includes(queryLower)) {
                    addUniqueMatch(matches, item.title, 'user');
                }

                // 2. Local brain/<id>/*.md files (task.md, implementation_plan.md, walkthrough.md, etc.)
                const itemBrainDir = path.join(brainDir, item.id);
                if (matches.length < MAX_MATCHES_PER_CONV && fs.existsSync(itemBrainDir)) {
                    try {
                        const entries = await fs.promises.readdir(itemBrainDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (token?.isCancellationRequested) return;
                            if (matches.length >= MAX_MATCHES_PER_CONV) break;
                            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
                            const mdPath = path.join(itemBrainDir, entry.name);
                            try {
                                const stat = await fs.promises.stat(mdPath);
                                if (stat.size > MAX_MD_BYTES) continue;
                                const content = await fs.promises.readFile(mdPath, 'utf8');
                                const lower = content.toLowerCase();
                                let searchFrom = 0;
                                while (matches.length < MAX_MATCHES_PER_CONV) {
                                    const hit = lower.indexOf(queryLower, searchFrom);
                                    if (hit === -1) break;
                                    addUniqueMatch(matches, `[${entry.name}] ${extractSnippet(content, hit, queryLower.length)}`, 'model');
                                    searchFrom = hit + Math.max(queryLower.length, 160);
                                }
                            } catch { /* ignore */ }
                        }
                    } catch { /* ignore */ }
                }

                // 3. Local transcript.jsonl
                const transcriptPath = path.join(itemBrainDir, '.system_generated', 'logs', 'transcript.jsonl');
                if (matches.length < MAX_MATCHES_PER_CONV && fs.existsSync(transcriptPath)) {
                    try {
                        const stat = await fs.promises.stat(transcriptPath);
                        if (stat.size <= MAX_TRANSCRIPT_BYTES) {
                            const content = await fs.promises.readFile(transcriptPath, 'utf8');
                            if (content.toLowerCase().includes(queryLower)) {
                                for (const line of content.split('\n')) {
                                    if (matches.length >= MAX_MATCHES_PER_CONV) break;
                                    if (!line.toLowerCase().includes(queryLower)) continue;
                                    try {
                                        const parsed = JSON.parse(line);
                                        const isUser = parsed.type === 'USER_INPUT' || parsed.source === 'USER_EXPLICIT' || parsed.role === 'user';
                                        const text = typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content ?? parsed);
                                        const hit = text.toLowerCase().indexOf(queryLower);
                                        if (hit !== -1) {
                                            addUniqueMatch(matches, extractSnippet(text, hit, queryLower.length), isUser ? 'user' : 'model');
                                        }
                                    } catch {
                                        const hit = line.toLowerCase().indexOf(queryLower);
                                        if (hit !== -1) {
                                            addUniqueMatch(matches, extractSnippet(line, hit, queryLower.length), 'model');
                                        }
                                    }
                                }
                            }
                        }
                    } catch { /* ignore */ }
                }

                // 4. Local conversation binary/SQLite files (.db, .db-wal, .pb)
                if (matches.length < MAX_MATCHES_PER_CONV) {
                    for (const ext of ['.db', '.db-wal', '.pb']) {
                        if (matches.length >= MAX_MATCHES_PER_CONV || token?.isCancellationRequested) break;
                        await scanBinaryFile(path.join(convDir, `${item.id}${ext}`), matches);
                    }
                }

                if (matches.length > 0) {
                    resultsById.set(item.id, {
                        cascadeId: item.id,
                        title: item.title,
                        matches,
                        lastModified: item.lastModified || Date.now()
                    });
                }
            }
        };

        await Promise.all(Array(Math.min(6, queue.length || 1)).fill(null).map(() => worker()));

        // 5. Optional language server RPC search (merged silently if server is available)
        if (!token?.isCancellationRequested) {
            try {
                const rpcResults = await this.apiClient.search(trimmed);
                for (const rpc of rpcResults) {
                    const existing = resultsById.get(rpc.cascadeId);
                    if (existing) {
                        for (const m of rpc.matches || []) {
                            addUniqueMatch(existing.matches, m.text, m.role);
                        }
                    } else {
                        resultsById.set(rpc.cascadeId, rpc);
                    }
                }
            } catch {
                // Local server unavailable or RPC restricted — local search results remain intact
            }
        }

        return Array.from(resultsById.values()).sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    }

    /**
     * Parses Antigravity 2.0 transcript.jsonl content into structured chat steps and token metadata
     * compatible with getChatHtml().
     */
    private parseTranscriptJsonl(content: string): { steps: any[]; metadata: any[] } {
        const lines = content.split('\n');
        const steps: any[] = [];
        const metadata: any[] = [];
        const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
        const MAX_TOOL_OUTPUT_CHARS = 8000;

        const cleanUserPrompt = (raw: string): string => {
            if (!raw) return '';
            const stripIdeActionTail = (s: string) =>
                s.replace(/\r?\n*The USER performed the following action:[\s\S]*$/i, '').trim();

            const reqMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
            if (reqMatch) {
                // If <USER_REQUEST> tag exists (even if empty, e.g. image-only prompt), never fall back to raw metadata
                return stripIdeActionTail(reqMatch[1]);
            }
            const stripped = raw
                .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
                .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
                .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
                .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
                .replace(/<\/?USER_REQUEST>/gi, '');
            return stripIdeActionTail(stripped);
        };

        const unwrapTranscriptArgs = (rawArgs: any): Record<string, any> => {
            if (!rawArgs || typeof rawArgs !== 'object') return {};
            const out: Record<string, any> = {};
            for (const [k, v] of Object.entries(rawArgs)) {
                if (typeof v === 'string') {
                    const trimmed = v.trim();
                    if (
                        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
                        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                        (trimmed.startsWith('[') && trimmed.endsWith(']'))
                    ) {
                        try {
                            out[k] = JSON.parse(trimmed);
                            continue;
                        } catch { /* keep raw string */ }
                    }
                }
                out[k] = v;
            }
            return out;
        };

        const loadMediaItems = (mediaArr: any): any[] => {
            if (!Array.isArray(mediaArr) || mediaArr.length === 0) return [];
            const result: any[] = [];
            for (const m of mediaArr) {
                const mimeType = m?.mime_type || m?.mimeType || '';
                const uri = typeof m?.uri === 'string' ? m.uri : '';
                if (!mimeType.startsWith('image/') || !uri) continue;
                try {
                    const cleanPath = uri.startsWith('file:///') ? decodeURIComponent(uri.slice(8)) : uri;
                    if (isSafeLocalFsPath(cleanPath) && fs.existsSync(cleanPath)) {
                        const stat = fs.statSync(cleanPath);
                        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_INLINE_IMAGE_BYTES) {
                            const data = fs.readFileSync(cleanPath).toString('base64');
                            result.push({
                                image: {
                                    mimeType,
                                    data,
                                    uri: cleanPath,
                                    name: path.basename(cleanPath)
                                }
                            });
                        }
                    }
                } catch {
                    // ignore unreadable media
                }
            }
            return result;
        };

        const pushUsageMeta = (stepIdx: number, parsed: any) => {
            const inputTokens = Number(parsed.input_tokens) || 0;
            const outputTokens = Number(parsed.output_tokens) || 0;
            const cacheReadTokens = Number(parsed.cache_read_tokens) || 0;
            if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
                metadata.push({
                    stepIndices: [stepIdx],
                    usage: { inputTokens, outputTokens, cacheReadTokens }
                });
            }
        };

        // Queue of tool calls from the most recent PLANNER_RESPONSE waiting for MODEL|GENERIC outputs
        let pendingToolCalls: any[] = [];

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            if (!line.trim()) continue;
            let parsed: any;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue;
            }

            const rawTs = parsed.created_at || parsed.timestamp;
            const timestamp = rawTs ? new Date(rawTs).getTime() : undefined;
            const validTs = timestamp && !isNaN(timestamp) ? timestamp : undefined;
            const stepIndex = parsed.step_index ?? lineIdx;
            const type = String(parsed.type || '').toUpperCase();
            const source = String(parsed.source || '').toUpperCase();

            // 1. User messages
            if (type === 'USER_INPUT' || source === 'USER_EXPLICIT' || parsed.role === 'user') {
                pendingToolCalls = [];
                const rawText = typeof parsed.content === 'string' ? parsed.content : (parsed.content ? JSON.stringify(parsed.content) : '');
                const cleanText = cleanUserPrompt(rawText);
                const mediaItems = loadMediaItems(parsed.media);
                if (!cleanText && mediaItems.length === 0) continue;

                steps.push({
                    type: 'CORTEX_STEP_TYPE_USER_INPUT',
                    userInput: {
                        userResponse: cleanText,
                        items: cleanText ? [{ text: { content: cleanText } }] : [],
                        media: mediaItems
                    },
                    timestamp: validTs
                });
                continue;
            }

            // 2. Errors
            if (type === 'ERROR_MESSAGE') {
                pendingToolCalls = [];
                const errText = parsed.error || (typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content || 'Unknown error'));
                steps.push({
                    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
                    errorMessage: { message: String(errText) },
                    timestamp: validTs
                });
                continue;
            }

            // 3. Context compaction checkpoints -> fold inside thought-box
            if (type === 'CHECKPOINT') {
                pendingToolCalls = [];
                const text = typeof parsed.content === 'string' ? parsed.content.trim() : '';
                if (!text) continue;
                const preview = text.length > 4000 ? text.slice(0, 4000) + '\n\n...[truncated]' : text;
                const idx = steps.length;
                steps.push({
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    plannerResponse: {
                        thinking: `**[Context Compaction Summary]**\n\n${preview}`
                    },
                    timestamp: validTs
                });
                pushUsageMeta(idx, parsed);
                continue;
            }

            // 4. System messages -> drop noisy internal reminders, fold real notices cleanly
            if (type === 'SYSTEM_MESSAGE' || source === 'SYSTEM') {
                const rawContent = typeof parsed.content === 'string' ? parsed.content : '';
                const strippedBanner = rawContent.replace(/^The following is a <SYSTEM_MESSAGE>[^\n]*\n*/i, '');
                const sysMatch = strippedBanner.match(/<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i);
                const sysText = (sysMatch ? sysMatch[1] : strippedBanner).trim();
                if (!sysText) continue;
                // Skip repetitive internal harness reminders
                if (/^Reminder:\s*work efficiently\./i.test(sysText)) {
                    continue;
                }
                const compact = sysText.length > 1500 ? sysText.slice(0, 1500) + '\n...[truncated]' : sysText;
                steps.push({
                    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                    plannerResponse: {
                        thinking: `**[System Notice]**\n\n${compact}`
                    },
                    timestamp: validTs
                });
                continue;
            }

            // 5. Tool outputs (MODEL | GENERIC, VIEW_FILE, LIST_DIRECTORY, RUN_COMMAND, GREP_SEARCH, etc.)
            // Any MODEL step whose type is not PLANNER_RESPONSE / MODEL_RESPONSE / NOTIFY_USER is a tool result.
            const isToolResultType = type === 'GENERIC' || (
                source === 'MODEL' &&
                type !== '' &&
                type !== 'PLANNER_RESPONSE' &&
                type !== 'MODEL_RESPONSE' &&
                !type.includes('NOTIFY_USER')
            );
            if (isToolResultType) {
                const rawOut = parsed.error
                    ? `Error: ${parsed.error}`
                    : (typeof parsed.content === 'string' ? parsed.content : (parsed.content !== undefined ? JSON.stringify(parsed.content) : ''));
                const trimmedOut = rawOut.length > MAX_TOOL_OUTPUT_CHARS
                    ? rawOut.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...[truncated]'
                    : rawOut;

                if (pendingToolCalls.length > 0) {
                    const tc = pendingToolCalls.shift()!;
                    if (trimmedOut.trim()) {
                        tc.output = trimmedOut;
                    }
                    continue;
                }

                // Orphaned tool result without preceding tool_call -> keep folded inside thought-box
                if (parsed.error) {
                    steps.push({
                        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
                        errorMessage: { message: String(parsed.error) },
                        timestamp: validTs
                    });
                } else if (trimmedOut.trim()) {
                    steps.push({
                        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                        plannerResponse: {
                            thinking: `**[Tool Output: ${type}]**\n\n\`\`\`\n${trimmedOut.slice(0, 2000)}\n\`\`\``
                        },
                        timestamp: validTs
                    });
                }
                continue;
            }

            // 6. Model planner response (thinking, tool_calls, and/or visible response content)
            if (type === 'PLANNER_RESPONSE' || type === 'MODEL_RESPONSE' || type.includes('NOTIFY_USER') || source === 'MODEL') {
                pendingToolCalls = [];
                const thinking = typeof parsed.thinking === 'string' ? parsed.thinking.trim() : '';
                const visibleContent = typeof parsed.content === 'string' ? parsed.content.trim() : '';
                const rawToolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];

                const normalizedToolCalls = rawToolCalls.map((tc: any, tcIdx: number) => {
                    const unwrappedArgs = unwrapTranscriptArgs(tc?.args || tc?.arguments);
                    return {
                        name: tc?.name || 'unknown_tool',
                        arguments: unwrappedArgs,
                        argumentsJson: JSON.stringify(unwrappedArgs),
                        executionId: `local-${stepIndex}-${tcIdx}`
                    };
                });

                let usageAttached = false;

                // Fold thinking + tool calls together into a collapsible thought-box step
                if (thinking || normalizedToolCalls.length > 0) {
                    const idx = steps.length;
                    steps.push({
                        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                        plannerResponse: {
                            thinking: thinking || undefined,
                            toolCalls: normalizedToolCalls.length > 0 ? normalizedToolCalls : undefined
                        },
                        timestamp: validTs
                    });
                    pushUsageMeta(idx, parsed);
                    usageAttached = true;
                    pendingToolCalls = [...normalizedToolCalls];
                }

                // Render visible model text as an open AI response bubble (never empty `{}`)
                if (visibleContent) {
                    const idx = steps.length;
                    steps.push({
                        type: 'CORTEX_STEP_TYPE_MODEL_RESPONSE',
                        modelResponse: { text: visibleContent },
                        timestamp: validTs
                    });
                    if (!usageAttached) {
                        pushUsageMeta(idx, parsed);
                    }
                }
                continue;
            }

            // Fallback for legacy/unknown transcript lines with plain string content
            if (typeof parsed.content === 'string' && parsed.content.trim()) {
                steps.push({
                    type: 'CORTEX_STEP_TYPE_MODEL_RESPONSE',
                    modelResponse: { text: parsed.content.trim() },
                    timestamp: validTs
                });
            }
        }

        return { steps, metadata };
    }

    /**
     * Reads local conversation steps and token metadata from transcript.jsonl or task.md
     * when language server is unavailable.
     */
    private async getLocalConversationData(id: string): Promise<{ steps: any[]; metadata: any[] } | null> {
        const logsDir = path.join(getBrainDir(), id, '.system_generated', 'logs');
        const fullTranscriptPath = path.join(logsDir, 'transcript_full.jsonl');
        const compactTranscriptPath = path.join(logsDir, 'transcript.jsonl');
        const MAX_FULL_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MB safety cap

        let transcriptPath: string | null = null;
        if (fs.existsSync(fullTranscriptPath)) {
            try {
                const stat = await fs.promises.stat(fullTranscriptPath);
                if (stat.size <= MAX_FULL_TRANSCRIPT_BYTES) {
                    transcriptPath = fullTranscriptPath;
                }
            } catch { /* ignore */ }
        }
        if (!transcriptPath && fs.existsSync(compactTranscriptPath)) {
            transcriptPath = compactTranscriptPath;
        }

        if (transcriptPath) {
            try {
                const content = await fs.promises.readFile(transcriptPath, 'utf8');
                const parsed = this.parseTranscriptJsonl(content);
                if (parsed.steps.length > 0) return parsed;
            } catch {
                // ignore read error
            }
        }

        const taskPath = path.join(getBrainDir(), id, 'task.md');
        if (fs.existsSync(taskPath)) {
            try {
                const taskContent = await fs.promises.readFile(taskPath, 'utf8');
                return {
                    steps: [
                        {
                            type: 'CORTEX_STEP_TYPE_USER_INPUT',
                            userInput: { userResponse: this.getConversationTitle(id) }
                        },
                        {
                            type: 'CORTEX_STEP_TYPE_MODEL_RESPONSE',
                            modelResponse: { text: taskContent }
                        }
                    ],
                    metadata: []
                };
            } catch {
                // ignore
            }
        }

        return null;
    }

    private async getLocalConversationSteps(id: string): Promise<any[] | null> {
        const data = await this.getLocalConversationData(id);
        return data ? data.steps : null;
    }

    /**
     * Get title of a conversation from its task.md
     */
    private getConversationTitle(conversationId: string): string {
        const lm = LocalizationManager.getInstance();
        try {
            const taskPath = path.join(getBrainDir(), conversationId, 'task.md');
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
            const now = Date.now();
            // Throttle updates to max once every 2 seconds
            if (now - this.lastDashboardUpdate > 2000) {
                this.lastDashboardUpdate = now;
                this.refreshStatistics(true, false, true); // updateOnly=true prevents auto-open
            }
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

    private storeDiffHtml(html: string): string {
        if (!this.renderDiffStore) {
            return '';
        }
        const token = nodeCrypto.randomBytes(12).toString('hex');
        this.renderDiffStore.set(token, html);
        return `@@AG_DIFF_${token}@@`;
    }

    private getChatErrorHtml(error: string): string {
        const safeError = escapeHtml(error || '');
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            </head>
            <body style="background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); padding: 20px; font-family: var(--vscode-font-family);">
                <h3 style="color: var(--vscode-errorForeground);">Error Loading Chat</h3>
                <pre>${safeError}</pre>
            </body>
            </html>
        `;
    }

    private getChatHtml(filename: string, steps: any[], metadata: any[] = []): string {
        const prevDiffStore = this.renderDiffStore;
        this.renderDiffStore = new Map<string, string>();
        try {
            return this.buildChatHtml(filename, steps, metadata);
        } finally {
            this.renderDiffStore = prevDiffStore;
        }
    }

    private buildChatHtml(filename: string, steps: any[], metadata: any[] = []): string {
        const lm = LocalizationManager.getInstance();
        const cspNonce = nodeCrypto.randomBytes(16).toString('base64');

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

            // Thinking and tool-only planner steps are folded into a collapsible thought-box
            const hasThoughts = !!(
                step.plannerResponse?.thinking ||
                step.plannerResponse?.thought ||
                (Array.isArray(step.plannerResponse?.toolCalls) && step.plannerResponse.toolCalls.length > 0 && !step.plannerResponse?.response)
            );
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
                            isError: false,
                            sender: lm.t('AI'),
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
                        } catch {
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

                    // Post-process: Convert local markdown file:/// links (outside code blocks) to clickable NAV_BADGE
                    if (stepRendered.includes('file:///')) {
                        const htmlSegments = stepRendered.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/gi);
                        stepRendered = htmlSegments.map((seg, idx) => {
                            if (idx % 2 === 1) return seg; // keep <pre>/<code> untouched
                            return seg.replace(/\[([^\]]+)\]\(file:\/\/\/([^)\s]+)\)/g, (orig, label, rawUriPath) => {
                                try {
                                    const decoded = decodeURIComponent(rawUriPath);
                                    const hashIdx = decoded.indexOf('#');
                                    const fsPath = hashIdx >= 0 ? decoded.slice(0, hashIdx) : decoded;
                                    const lineInfo = hashIdx >= 0 ? decoded.slice(hashIdx) : '';
                                    if (!isSafeLocalFsPath(fsPath)) return orig;
                                    return `[NAV_BADGE:${fsPath}|${lineInfo}|${label}]`;
                                } catch {
                                    return orig;
                                }
                            });
                        }).join('');
                    }

                    // Post-process: File badges
                    stepRendered = stepRendered.replace(/`([^`\s]+\.[a-z]{1,5})`/g, (match, pathStr) => {
                        const iconSvg = getFileIconSvg(pathStr);
                        const safePath = escapeHtml(pathStr);
                        return `<span class="file-badge"><span class="icon">${iconSvg}</span><span class="path">${safePath}</span><span class="open-btn" data-action="open-file" data-path="${safePath}">${escapeHtml(lm.t('Open'))}</span></span>`;
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
                                <span class="sender-name">${escapeHtml(sender || '')}</span>
                                ${responseTimeHtml}
                                <div class="timestamp-wrapper">
                                    <span class="timestamp">${escapeHtml(timestampDisplay)}</span>
                                </div>
                            </div>
                            <div class="text-box">
                                <div class="text markdown-body">
                                    ${contentHtml}
                                </div>
                                <div class="box-footer">
                                    <div class="usage-footer">${this.renderTokenUsage(totalUsage, totalLatencyMs)}</div>
                                    <button class="toggle-mode-btn" data-action="toggle-mode" style="font-size: 10px; opacity: 0.5;">${escapeHtml(lm.t('JSON'))}</button>
                                </div>
                                <div class="json-box" style="display:none;">
                                    <div class="json-search-bar">
                                        <input type="text" class="json-search-input" placeholder="${escapeHtml(lm.t('Search in JSON...'))}" style="flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 2px 6px; font-size: 11px;">
                                        <span class="json-search-count" style="font-size: 10px; opacity: 0.6; min-width: 30px; text-align: center;"></span>
                                        <button class="search-btn" data-action="json-prev" title="${escapeHtml(lm.t('Previous (Shift+Enter)'))}" style="padding: 2px; font-size: 10px;">⬆️</button>
                                        <button class="search-btn" data-action="json-next" title="${escapeHtml(lm.t('Next (Enter)'))}" style="padding: 2px; font-size: 10px;">⬇️</button>
                                    </div>
                                    <pre style="display:none;">${escapeHtml(JSON.stringify(groupSteps))}</pre>
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
                    if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
                        if (d1.toLocaleDateString() === d2.toLocaleDateString()) {
                            const t1 = d1.toLocaleTimeString(lm.getLocale(), { hour: '2-digit', minute: '2-digit' });
                            const t2 = d2.toLocaleTimeString(lm.getLocale(), { hour: '2-digit', minute: '2-digit' });
                            timeRange = `${lm.formatDate(d1)} ${t1} - ${t2}`;
                        } else {
                            timeRange = `${lm.formatDateTime(d1)} - ${lm.formatDateTime(d2)}`;
                        }
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

                // Pre-render each message using the same logic as regular messages
                const seenExecIds = new Set<string>();
                const preRenderedMessages = groupSteps.map((s: any) => {
                    const { isUser, isModel, isError, sender } = s;
                    if (!isUser && !isModel && !isError) return '';

                    let timestampDisplay = '';
                    const ts = s.metadata?.createdAt || s.createdAt || s.timestamp;
                    if (ts) {
                        try {
                            const d = new Date(ts);
                            if (!isNaN(d.getTime())) {
                                timestampDisplay = d.toLocaleTimeString(lm.getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            }
                        } catch {
                            // Ignore invalid date strings
                        }
                    }

                    let contentHtml = '';
                    const cleanText = (s.text || '').trim();

                    const isClearedPlaceholder = cleanText.includes('cleared-message') ||
                        cleanText.includes('Содержимое сообщения было удалено') ||
                        cleanText.includes('message content has been cleared') ||
                        cleanText.includes('Message content cleared');

                    if (isClearedPlaceholder) {
                        contentHtml = `<span class="cleared-message">${escapeHtml(lm.t('Message content has been cleared or archived.'))}</span>`;
                    } else if (cleanText) {
                        try {
                            contentHtml = this.md ? this.md.render(cleanText) : escapeHtml(cleanText).replace(/\n/g, '<br>');
                        } catch {
                            contentHtml = escapeHtml(cleanText).replace(/\n/g, '<br>');
                        }
                        contentHtml = this.formatModelError(contentHtml, s);
                        contentHtml = this.renderToolCalls(contentHtml, seenExecIds);
                    }

                    if (!contentHtml.trim()) return '';

                    const avatar = isUser ? '👤' : isError ? '⚠️' : isModel ? '🤖' : '⚙️';
                    const senderName = sender || (isUser ? lm.t('User') : isError ? lm.t('Error') : lm.t('AI'));
                    const msgClass = isUser ? 'user' : isError ? 'error-msg' : isModel ? 'ai' : '';

                    return `
                        <div class="message ${msgClass} restored" style="margin: 4px 0; padding: 4px 0;">
                            <div class="avatar" style="font-size: 12px;">${avatar}</div>
                            <div class="content">
                                <div class="sender" style="font-size: 11px;">
                                    <span class="sender-name">${escapeHtml(senderName)}</span>
                                    <span class="timestamp" style="margin-left: 8px;">${escapeHtml(timestampDisplay)}</span>
                                </div>
                                <div class="text-box" style="padding: 4px 8px;">
                                    <div class="text markdown-body" style="font-size: 12px;">
                                        ${contentHtml}
                                    </div>
                                    <div class="box-footer">
                                        ${this.renderTokenUsage(s.usage)}
                                        <button class="toggle-mode-btn" data-action="toggle-mode" style="font-size: 10px; opacity: 0.5;">${escapeHtml(lm.t('JSON'))}</button>
                                    </div>
                                    <div class="json-box" style="display:none;">
                                        <div class="json-search-bar">
                                            <input type="text" class="json-search-input" placeholder="${escapeHtml(lm.t('Search in JSON...'))}" style="flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 2px 6px; font-size: 11px;">
                                            <span class="json-search-count" style="font-size: 10px; opacity: 0.6; min-width: 30px; text-align: center;"></span>
                                            <button class="search-btn" data-action="json-prev" title="${escapeHtml(lm.t('Previous (Shift+Enter)'))}" style="padding: 2px; font-size: 10px;">⬆️</button>
                                            <button class="search-btn" data-action="json-next" title="${escapeHtml(lm.t('Next (Enter)'))}" style="padding: 2px; font-size: 10px;">⬇️</button>
                                        </div>
                                        <pre style="display:none;">${escapeHtml(JSON.stringify(s))}</pre>
                                        <div class="json-container"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }).filter((h: string) => h.trim()).join('');

                return `
                    <div class="message cleared-group">
                        <div class="avatar">📦</div>
                        <div class="content">
                            <div class="sender">
                                <span class="sender-name">${escapeHtml(lm.t('Cleared History'))}</span>
                                ${responseTimeHtml}
                                <div class="timestamp-wrapper">
                                    <span class="timestamp">${escapeHtml(timeRange)}</span>
                                </div>
                            </div>
                            <div class="text-box">
                                <div class="text compact-summary">
                                    <div class="summary-line">
                                        ${aiCount > 0 ? `<span>🤖 <b>${aiCount}</b> ${escapeHtml(lm.t('AI Messages'))}</span>` : ''}
                                        ${userCount > 0 ? `<span>👤 <b>${userCount}</b> ${escapeHtml(lm.t('User Messages'))}</span>` : ''}
                                        ${errorCount > 0 ? `<span>⚠️ <b>${errorCount}</b> ${escapeHtml(lm.t('Errors'))}</span>` : ''}
                                    </div>
                                    <div class="cleared-message group-sub">${escapeHtml(lm.t('Detailed content of these messages has been cleared or archived.'))} <button class="expand-content-btn" data-action="expand-cleared" style="font-size: 10px; margin-left: 8px; background: rgba(100,150,255,0.1); border: 1px solid rgba(100,150,255,0.3); color: var(--vscode-textLink-foreground); padding: 3px 8px; border-radius: 4px; cursor: pointer; transition: all 0.2s;">📖 ${escapeHtml(lm.t('Show content'))}</button></div>
                                </div>
                                <div class="box-footer">
                                    ${this.renderTokenUsage(totalUsage)}
                                    <button class="toggle-mode-btn" data-action="toggle-mode" style="font-size: 10px; opacity: 0.5;">${escapeHtml(lm.t('JSON'))}</button>
                                </div>
                                <div class="pre-rendered-content" style="display: none; max-height: 60vh; overflow-y: auto; position: relative; padding-top: 8px; margin-top: 8px; border-top: 1px dashed rgba(127,127,127,0.3);">
                                    ${preRenderedMessages}
                                    <button class="collapse-content-btn" data-action="collapse-cleared" style="font-size: 10px; position: sticky; bottom: 0; margin-top: 8px; background: rgba(150,100,100,0.95); border: 1px solid rgba(150,100,100,0.5); color: var(--vscode-button-foreground, #fff); padding: 5px 12px; border-radius: 4px; cursor: pointer; display: block; backdrop-filter: blur(4px); box-shadow: 0 -2px 6px rgba(0,0,0,0.2);">📕 ${escapeHtml(lm.t('Collapse'))}</button>
                                </div>
                                <div class="json-box" style="display:none;">
                                    <div class="json-search-bar">
                                        <input type="text" class="json-search-input" placeholder="${escapeHtml(lm.t('Search in JSON...'))}" style="flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 2px 6px; font-size: 11px;">
                                        <span class="json-search-count" style="font-size: 10px; opacity: 0.6; min-width: 30px; text-align: center;"></span>
                                        <button class="search-btn" data-action="json-prev" title="${escapeHtml(lm.t('Previous (Shift+Enter)'))}" style="padding: 2px; font-size: 10px;">⬆️</button>
                                        <button class="search-btn" data-action="json-next" title="${escapeHtml(lm.t('Next (Enter)'))}" style="padding: 2px; font-size: 10px;">⬇️</button>
                                    </div>
                                    <pre style="display:none;">${escapeHtml(JSON.stringify(groupSteps))}</pre>
                                    <div class="json-container"></div>
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
            
            .text-box { background: var(--vscode-editor-lineHighlightBackground); padding: 14px 16px; border-radius: 12px; border: 1px solid var(--vscode-widget-border); box-shadow: 0 4px 12px rgba(0,0,0,0.1); backdrop-filter: blur(4px); transition: border-color 0.2s; position: relative; max-width: 100%; box-sizing: border-box; overflow: auto; resize: vertical; min-height: 50px; display: flex; flex-direction: column; }
            .message.user .text-box { background: rgba(255,255,255,0.02); border-color: rgba(255,255,255,0.05); }
            .message.error-msg .text-box { background: rgba(255, 0, 0, 0.04); border-color: rgba(255, 0, 0, 0.2); }
            .message:hover .text-box { border-color: var(--vscode-focusBorder); }

            .text { word-break: break-word; overflow-wrap: break-word; }
            .markdown-body { font-size: 1.05em; line-height: 1.6; }
            .markdown-body p:last-child { margin-bottom: 0; }
            .markdown-body pre { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-widget-border); padding: 12px; border-radius: 8px; overflow-x: auto; margin: 12px 0; max-width: 100%; box-sizing: border-box; }
            .markdown-body code { font-family: var(--vscode-editor-font-family); background: rgba(127,127,127,0.1); padding: 2px 4px; border-radius: 4px; border: 1px solid rgba(127,127,127,0.2); word-break: break-all; overflow-wrap: anywhere; }
            .markdown-body pre code { background: transparent; border: none; padding: 0; border-radius: 0; word-break: normal; overflow-wrap: normal; }

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
            .file-badge.missing .path, .tool-query-badge.missing { text-decoration: line-through; opacity: 0.8; }

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

            .diff-block { border-top: 1px solid var(--vscode-widget-border); padding: 8px 0; max-height: none; overflow-y: visible; overflow-x: auto; background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.4; transition: max-height 0.3s ease-in-out; }
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
            
            .json-box { background: rgba(0,0,0,0.1); border-radius: 6px; padding: 12px; margin-top: 8px; font-family: var(--vscode-editor-font-family); font-size: 0.85em; overflow: auto; position: relative; flex: 1; display: flex; flex-direction: column; min-height: 0; }
            .json-search-bar { position: sticky; top: -12px; z-index: 100; background: var(--vscode-editor-lineHighlightBackground); margin: -12px -12px 8px -12px; padding: 12px 12px 8px 12px; border-bottom: 1px solid rgba(127,127,127,0.2); display: flex; align-items: center; gap: 4px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
            .json-box pre { margin: 0; white-space: pre-wrap; word-break: break-all; color: var(--vscode-editor-foreground); opacity: 0.6; }
            .json-container { flex: 1; min-height: 0; }
            
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
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: vscode-resource: https:; style-src 'unsafe-inline'; script-src 'nonce-${cspNonce}';">
                <style>${styleVars}</style>
            </head>
            <body>
                <div id="search-container">
                    <span style="font-size: 14px; margin-right: 8px; opacity: 0.6;">🔍</span>
                    <input type="text" id="search-input" placeholder="${escapeHtml(lm.t('Search in chat...'))}">
                    <button class="search-btn" data-action="find-prev" title="${escapeHtml(lm.t('Previous (Shift+Enter)'))}">⬆️</button>
                    <button class="search-btn" data-action="find-next" title="${escapeHtml(lm.t('Next (Enter)'))}">⬇️</button>
                    <span id="search-count" style="margin-left:8px; font-size:0.8em; opacity:0.6; min-width: 50px;"></span>

                    <div class="search-filters">
                        <label class="filter-item">
                            <input type="checkbox" class="filter-checkbox" checked data-type="ai">
                            <span class="filter-label">🤖 ${escapeHtml(lm.t('AI'))}</span>
                        </label>
                        <label class="filter-item">
                            <input type="checkbox" class="filter-checkbox" checked data-type="user">
                            <span class="filter-label">👤 ${escapeHtml(lm.t('User'))}</span>
                        </label>
                        <label class="filter-item">
                            <input type="checkbox" class="filter-checkbox" checked data-type="error-msg">
                            <span class="filter-label">⚠️ ${escapeHtml(lm.t('Error'))}</span>
                        </label>
                        <label class="filter-item">
                            <input type="checkbox" class="filter-checkbox" checked data-type="other">
                            <span class="filter-label">⚙️ ${escapeHtml(lm.t('Other'))}</span>
                        </label>
                    </div>
                </div>

                <div id="chat-container">
                    ${messagesHtml}
                </div>

                <div id="lightbox">
                    <img id="lightbox-img" src="">
                </div>

                <script nonce="${cspNonce}">
                    const vscode = acquireVsCodeApi();
                    const L10N = {
                        noResults: ${JSON.stringify(lm.t('No results'))},
                        json: ${JSON.stringify(lm.t('JSON'))},
                        text: ${JSON.stringify(lm.t('TEXT'))}
                    };
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
                            document.getElementById('search-count').textContent = L10N.noResults;
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
                                        if (btn) btn.textContent = L10N.text;
                                    }
                                }
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

                    function openFile(filePath) {
                        vscode.postMessage({
                            command: 'openFile',
                            path: filePath
                        });
                    }

                    function copyToClipboard(text, btn) {
                        navigator.clipboard.writeText(text).then(() => {
                            const original = btn.textContent;
                            btn.textContent = '✅';
                            setTimeout(() => { btn.textContent = original; }, 2000);
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

                        textBox.style.height = '';

                        if (isJson) {
                            json.style.display = 'none';
                            text.style.display = 'block';
                            btn.textContent = L10N.json;
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
                                        raw.style.display = 'block';
                                    }
                                }
                            }
                            json.style.display = 'block';
                            text.style.display = 'none';
                            btn.textContent = L10N.text;
                        }
                    }

                    function expandClearedContent(btn) {
                        const textBox = btn.closest('.text-box');
                        const summaryDiv = textBox.querySelector('.compact-summary');
                        const preRendered = textBox.querySelector('.pre-rendered-content');
                        
                        if (preRendered) {
                            textBox.dataset.originalHeight = textBox.style.height || '';
                            textBox.dataset.originalMinHeight = textBox.style.minHeight || '';
                            
                            preRendered.style.display = 'flex';
                            preRendered.style.flexDirection = 'column';
                            preRendered.style.flex = '1';
                            preRendered.style.maxHeight = 'none';
                            summaryDiv.style.display = 'none';

                            if (!textBox.style.height || parseInt(textBox.style.height) < 400) {
                                textBox.style.height = '400px';
                            }
                            
                            preRendered.scrollTop = 0;
                        }
                    }

                    function collapseClearedContent(btn) {
                        const textBox = btn.closest('.text-box');
                        const summaryDiv = textBox.querySelector('.compact-summary');
                        const preRendered = textBox.querySelector('.pre-rendered-content');
                        const message = textBox.closest('.message');
                        
                        if (preRendered && summaryDiv) {
                            preRendered.style.display = 'none';
                            summaryDiv.style.display = 'block';
                            preRendered.scrollTop = 0;
                            
                            textBox.style.height = textBox.dataset.originalHeight !== undefined ? textBox.dataset.originalHeight : '';
                            textBox.style.minHeight = textBox.dataset.originalMinHeight !== undefined ? textBox.dataset.originalMinHeight : '';
                            
                            if (message) {
                                message.style.height = '';
                                message.style.minHeight = '';
                            }
                        }
                    }

                    function renderJson(container, data) {
                        container.textContent = '';
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
                        
                        const header = document.createElement('span');
                        header.className = 'json-header';
                        
                        if (key !== null) {
                            const keySpan = document.createElement('span');
                            keySpan.className = 'json-key';
                            keySpan.textContent = '"' + String(key) + '"';
                            const sepSpan = document.createElement('span');
                            sepSpan.className = 'json-sep';
                            sepSpan.textContent = ': ';
                            header.appendChild(keySpan);
                            header.appendChild(sepSpan);
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
                            const closeSpan = document.createElement('span');
                            closeSpan.className = 'json-brace';
                            closeSpan.textContent = closeBadge;
                            footer.appendChild(closeSpan);
                            if (!isLast) {
                                const commaSpan = document.createElement('span');
                                commaSpan.className = 'json-comma';
                                commaSpan.textContent = ',';
                                footer.appendChild(commaSpan);
                            }
                            node.appendChild(footer);

                            toggle.addEventListener('click', (e) => {
                                e.stopPropagation();
                                toggle.classList.toggle('collapsed');
                                content.classList.toggle('collapsed');
                                toggle.textContent = toggle.classList.contains('collapsed') ? '▶' : '▼';
                            });
                        } else {
                            node.appendChild(header);
                            let valStr = 'null';
                            let type = 'null';
                            if (typeof val === 'string') {
                                type = 'string';
                                valStr = '"' + val + '"';
                            } else if (typeof val === 'number') {
                                type = 'number';
                                valStr = val.toString();
                            } else if (typeof val === 'boolean') {
                                type = 'boolean';
                                valStr = val.toString();
                            }

                            const valueSpan = document.createElement('span');
                            valueSpan.className = 'json-value json-' + type;
                            valueSpan.textContent = valStr;
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

                    function highlightSpanSafely(span, query) {
                        const rawText = span.getAttribute('data-raw-text') !== null
                            ? span.getAttribute('data-raw-text')
                            : span.textContent;
                        if (span.getAttribute('data-raw-text') === null) {
                            span.setAttribute('data-raw-text', rawText);
                        }
                        if (!query || !rawText.toLowerCase().includes(query)) {
                            span.textContent = rawText;
                            return;
                        }
                        const parts = rawText.split(new RegExp('(' + escapeRegExp(query) + ')', 'gi'));
                        span.textContent = '';
                        for (const part of parts) {
                            if (part.toLowerCase() === query) {
                                const hl = document.createElement('span');
                                hl.className = 'json-highlight';
                                hl.textContent = part;
                                span.appendChild(hl);
                            } else if (part !== '') {
                                span.appendChild(document.createTextNode(part));
                            }
                        }
                    }

                    function filterJson(input) {
                        const query = input.value.toLowerCase();
                        const jsonBox = input.closest('.json-box');
                        
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
                        
                        jsonBox._matches = [];
                        jsonBox._matchIndex = -1;

                        nodes.forEach(node => {
                            const keySpan = node.querySelector(':scope > .json-header > .json-key');
                            const valSpan = node.querySelector(':scope > .json-value');
                            
                            if (keySpan && keySpan.getAttribute('data-raw-text') !== null) {
                                keySpan.textContent = keySpan.getAttribute('data-raw-text');
                            }
                            if (valSpan && valSpan.getAttribute('data-raw-text') !== null) {
                                valSpan.textContent = valSpan.getAttribute('data-raw-text');
                            }

                            if (!query) {
                                node.style.display = '';
                                return;
                            }
                            
                            const text = node.textContent.toLowerCase();
                            const isMatch = text.includes(query);
                            node.style.display = isMatch ? '' : 'none';
                            
                            if (isMatch) {
                                [keySpan, valSpan].forEach(span => {
                                    if (span) highlightSpanSafely(span, query);
                                });

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

                    // Delegated event handling (strict CSP, zero inline event handlers)
                    document.getElementById('search-input')?.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') findNext(e.shiftKey);
                    });

                    document.getElementById('lightbox')?.addEventListener('click', (e) => {
                        e.currentTarget.style.display = 'none';
                    });

                    document.addEventListener('change', (e) => {
                        if (e.target && e.target.classList && e.target.classList.contains('filter-checkbox')) {
                            applyFilters();
                        }
                    });

                    document.addEventListener('keyup', (e) => {
                        if (e.target && e.target.classList && e.target.classList.contains('json-search-input')) {
                            if (e.key === 'Enter') navigateJsonSearch(e.target, e.shiftKey);
                            else filterJson(e.target);
                        }
                    });

                    document.addEventListener('click', (e) => {
                        const actionEl = e.target.closest('[data-action]');
                        if (!actionEl) return;
                        const action = actionEl.getAttribute('data-action');

                        switch (action) {
                            case 'find-prev':
                                findNext(true);
                                break;
                            case 'find-next':
                                findNext(false);
                                break;
                            case 'open-file':
                                e.stopPropagation();
                                if (actionEl.dataset.path) openFile(actionEl.dataset.path);
                                break;
                            case 'copy-text':
                                e.stopPropagation();
                                if (actionEl.dataset.copy !== undefined) copyToClipboard(actionEl.dataset.copy, actionEl);
                                break;
                            case 'toggle-args':
                                if (actionEl.dataset.target) toggleArgs(actionEl.dataset.target);
                                break;
                            case 'toggle-diff':
                                if (e.target.closest('.font-controls')) return;
                                toggleDiff(actionEl);
                                break;
                            case 'font-size':
                                e.stopPropagation();
                                changeFontSize(actionEl, parseInt(actionEl.dataset.delta || '0', 10));
                                break;
                            case 'toggle-mode':
                                toggleMode(actionEl);
                                break;
                            case 'expand-cleared':
                                expandClearedContent(actionEl);
                                break;
                            case 'collapse-cleared':
                                collapseClearedContent(actionEl);
                                break;
                            case 'show-image':
                                showImage(actionEl.getAttribute('src') || '');
                                break;
                            case 'json-prev':
                            case 'json-next': {
                                const bar = actionEl.closest('.json-search-bar');
                                const input = bar ? bar.querySelector('.json-search-input') : null;
                                if (input) navigateJsonSearch(input, action === 'json-prev');
                                break;
                            }
                        }
                    });

                    document.addEventListener('dblclick', function(e) {
                        const target = e.target.closest('.text-box');
                        if (target) {
                            const rect = target.getBoundingClientRect();
                            const isBottomRight = (e.clientX >= rect.right - 20) && (e.clientY >= rect.bottom - 20);
                            if (isBottomRight) {
                                target.style.height = '';
                                target.style.maxHeight = '';
                            }
                        }
                    });
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
                        return `<span class="cleared-message">${lm.t('Message content has been cleared or archived.')}</span>`;
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
                const dedupeId = execId || `${toolName}:${base64Args || ''}`;
                if (seenExecIds.has(dedupeId)) return '';
                seenExecIds.add(dedupeId);
            }
            let fileBadge = '';
            if (filePath) {
                const cleanFilePath = filePath.includes('#') ? filePath.split('#')[0] : filePath;
                const displayPath = cleanFilePath.split(/[/\\]/).pop() || cleanFilePath;

                let isDirectory = toolName === 'list_dir' || toolName === 'find_by_name';
                let exists = false;
                try {
                    if (isSafeLocalFsPath(cleanFilePath) && fs.existsSync(cleanFilePath)) {
                        exists = true;
                        isDirectory = fs.statSync(cleanFilePath).isDirectory();
                    }
                } catch { /* ignore */ }

                fileBadge = `
                    <span class="file-badge mini ${isDirectory ? 'directory' : ''} ${!exists ? 'missing' : ''}" data-action="open-file" data-path="${escapeHtml(filePath)}" title="${!exists ? escapeHtml(lm.t('File not found locally')) : ''}">
                        <span class="icon">${isDirectory ? '📂' : (exists ? getFileIconSvg(cleanFilePath) : '🚫')}</span>
                        <span class="path">${escapeHtml(displayPath)}${escapeHtml(lineInfo || '')}</span>
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
                    const boxId = `args-${nodeCrypto.randomBytes(6).toString('hex')}`;

                    argsButton = `<button class="tool-args-btn" data-action="toggle-args" data-target="${boxId}">${escapeHtml(lm.t('Arguments'))}</button>`;
                    argsBox = `
                        <div id="${boxId}" class="tool-args-box">
                            <pre>${escapeHtml(prettyJson)}</pre>
                        </div>
                    `;

                    if (toolName === 'notify_user' && args.PathsToReview && Array.isArray(args.PathsToReview) && args.PathsToReview.length > 0) {
                        reviewBadges = args.PathsToReview.map((p: string) => {
                            const safeP = String(p || '');
                            const name = safeP.split(/[/\\]/).pop() || safeP;
                            const exists = isSafeLocalFsPath(safeP) && fs.existsSync(safeP);
                            return `
                                <span class="file-badge mini ${!exists ? 'missing' : ''}" title="${escapeHtml(safeP)}${!exists ? ' (' + escapeHtml(lm.t('File not found locally')) + ')' : ''}" data-action="open-file" data-path="${escapeHtml(safeP)}">
                                    <span class="icon">${exists ? getFileIconSvg(safeP) : '🚫'}</span>
                                    <span class="path">${escapeHtml(name)}</span>
                                </span>
                            `;
                        }).join('');
                        reviewBadges = `<div style="display: flex; flex-wrap: wrap; gap: 4px; border-left: 2px solid var(--vscode-textLink-foreground); padding-left: 8px; margin-left: 8px;">
                                            <span style="font-size: 0.85em; opacity: 0.8; display: flex; align-items: center;">${escapeHtml(lm.t('Review Required'))}:</span>
                                            ${reviewBadges}
                                        </div>`;
                    }

                    if (toolName === 'grep_search' || toolName === 'find_by_name' || toolName === 'view_file' || toolName === 'ls' || toolName === 'list_dir') {
                        const q = args.Query || args.Pattern || args.query || args.pattern || args.AbsolutePath || args.Path || args.SearchDirectory || args.SearchPath;
                        const cleanFilePath = filePath ? (filePath.includes('#') ? filePath.split('#')[0] : filePath) : '';

                        if (q && typeof q === 'string' && q !== filePath && q !== cleanFilePath) {
                            let qIsDir = false;
                            let qExists = false;
                            try {
                                if (isSafeLocalFsPath(q) && fs.existsSync(q)) {
                                    qExists = true;
                                    qIsDir = fs.statSync(q).isDirectory();
                                }
                            } catch { /* ignore */ }

                            let openPath = q;
                            if ((toolName === 'find_by_name' || toolName === 'grep_search') && !path.isAbsolute(q) && filePath) {
                                try {
                                    const dir = (isSafeLocalFsPath(cleanFilePath) && fs.existsSync(cleanFilePath) && fs.statSync(cleanFilePath).isDirectory()) ? cleanFilePath : undefined;
                                    if (dir) {
                                        openPath = path.posix.join(dir.replace(/\\/g, '/'), q.replace(/\\/g, '/'));
                                        if (!qExists && isSafeLocalFsPath(openPath) && fs.existsSync(openPath)) {
                                            qExists = true;
                                            qIsDir = fs.statSync(openPath).isDirectory();
                                        }
                                    }
                                } catch { /* ignore */ }
                            }

                            const qIcon = toolName === 'grep_search' ? '🔍' : (qIsDir ? '📂' : (qExists ? getFileIconSvg(openPath) : '🚫'));
                            const qStyle = !qExists && toolName !== 'grep_search' ? 'opacity: 0.6; filter: grayscale(1);' : '';
                            const qClass = !qExists && toolName !== 'grep_search' ? 'missing' : '';

                            detailBadges = `<span class="tool-query-badge ${qClass}" style="cursor: pointer; ${qStyle}" data-action="open-file" data-path="${escapeHtml(openPath)}" title="${escapeHtml(openPath)}"><small style="margin-right:4px; opacity:0.6; width: 14px; height: 14px; display: inline-flex; align-items: center; vertical-align: middle;">${qIcon}</small>${escapeHtml(q)}</span>`;
                        }
                    }
                } catch (e) {
                    console.error('Failed to parse tool arguments:', e);
                }
            }

            let infoBadges = '';
            if (detailBadges || fileBadge) {
                const styledFileBadge = fileBadge.replace('class="file-badge mini', 'style="margin-left: 0" class="file-badge mini');
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

                        if (name === '%SAME%') name = this.lastTaskName || '';
                        else if (name) this.lastTaskName = name;

                        if (summary === '%SAME%') summary = this.lastTaskSummary || '';
                        else if (summary) this.lastTaskSummary = summary;

                        let summaryHtml = escapeHtml(summary);
                        if (summary && this.md && typeof this.md.render === 'function') {
                            summaryHtml = this.md.render(summary);
                        }
                        if (name || summary) {
                            extraStuff = `
                                <div class="task-boundary-info">
                                    ${name ? `<div class="task-name-header">${escapeHtml(name)}</div>` : ''}
                                    ${summaryHtml ? `<div class="task-summary-box markdown-body">${summaryHtml}</div>` : ''}
                                </div>
                            `;
                        }
                    } else if (toolName === 'run_command' && args.CommandLine) {
                        const desc = args.Message || args.Description || args.Summary || '';
                        const cmdLine = String(args.CommandLine);

                        extraStuff = `
                            <div class="command-info">
                                ${desc ? `<div class="command-desc">${escapeHtml(String(desc))}</div>` : ''}
                                <div class="command-line"><code>${escapeHtml(cmdLine)}</code> <button class="copy-btn mini" title="${escapeHtml(lm.t('Copy Link'))}" data-action="copy-text" data-copy="${escapeHtml(cmdLine)}">📋</button></div>
                            </div>
                        `;
                    }
                } catch { /* ignore */ }
            }

            return `
                <div class="tool-call">
                    <span class="tool-icon">🛠️</span>
                    <span class="tool-label">${escapeHtml(lm.t('Tool Use'))}:</span>
                    <span class="tool-name">${escapeHtml(toolName)}</span>
                    ${infoBadges}
                    ${reviewBadges}
                    ${argsButton}
                </div>
                ${argsBox}
                ${extraStuff}
            `;
        }).replace(/\[NAV_BADGE:([^|\]]+)\|([^|\]]*)\|([^\]]*)\]/g, (match, filePath, lineInfo, label) => {
            const exists = isSafeLocalFsPath(filePath) && fs.existsSync(filePath);
            const iconSvg = getFileIconSvg(filePath);
            const targetPath = lineInfo ? `${filePath}${lineInfo}` : filePath;
            return `
                <span class="file-badge mini ${!exists ? 'missing' : ''}" title="${!exists ? escapeHtml(lm.t('File not found locally')) : escapeHtml(targetPath)}" data-action="open-file" data-path="${escapeHtml(targetPath)}">
                    <span class="icon">${exists ? iconSvg : '🚫'}</span>
                    <span class="path">${escapeHtml(label)}</span>
                </span>
            `;
        }).replace(/\[COPY_CMD:([^\]]+)\]/g, (match, base64Cmd) => {
            try {
                const cmd = Buffer.from(base64Cmd, 'base64').toString('utf8');
                return `<button class="copy-btn" title="${escapeHtml(lm.t('Copy to Clipboard'))}" data-action="copy-text" data-copy="${escapeHtml(cmd)}">📋</button>`;
            } catch { return ''; }
        }).replace(/@@AG_DIFF_([a-f0-9]{24})@@/g, (_match, token) => {
            return this.renderDiffStore?.get(token) || '';
        }).replace(/\[LOCAL_TIME:([^\]]+)\]/g, (match, timestamp) => {
            try {
                const date = new Date(parseInt(timestamp, 10));
                return escapeHtml(lm.formatDateTime(date));
            } catch { return escapeHtml(timestamp); }
        });
    }

    private generateFileContentHtml(text: string, startLine: number, title?: string, collapsed: boolean = true, filename?: string): string {
        const lm = LocalizationManager.getInstance();
        const t = escapeHtml(title || lm.t('File Content'));
        const lines = text.split('\n');

        let html = '<div class="diff-container">';
        const iconSvg = filename ? getFileIconSvg(filename) : '<span class="icon">📄</span>';
        html += `<div class="diff-header ${collapsed ? 'collapsed' : ''}" data-action="toggle-diff">
            <div class="diff-icon">${iconSvg}</div> ${t}
            <div class="font-controls">
                <button class="font-btn" data-action="font-size" data-delta="-1">-</button>
                <button class="font-btn" data-action="font-size" data-delta="1">+</button>
                <span class="zoom-level">1.0x</span>
            </div>
            <span class="stats">${lines.length} ${escapeHtml(lm.t('Lines'))}</span>
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
        html += `<div class="diff-header collapsed" data-action="toggle-diff">
            <div class="diff-icon">${iconSvg}</div> ${escapeHtml(lm.t('Code Changes'))}
            <div class="font-controls">
                <button class="font-btn" data-action="font-size" data-delta="-1">-</button>
                <button class="font-btn" data-action="font-size" data-delta="1">+</button>
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
        const colors = {
            keyword: '#c586c0',
            function: '#dcdcaa',
            string: '#ce9178',
            number: '#b5cea8',
            boolean: '#569cd6',
            type: '#4ec9b0',
            comment: '#6a9955'
        };

        const keywords = new Set([
            'function', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return',
            'import', 'from', 'export', 'class', 'interface', 'type', 'private', 'public',
            'protected', 'async', 'await', 'new', 'this', 'throw', 'try', 'catch', 'finally',
            'extends', 'implements', 'as', 'readonly', 'static'
        ]);
        const types = new Set([
            'string', 'number', 'boolean', 'any', 'void', 'unknown', 'never', 'object',
            'Array', 'Promise', 'Map', 'Set'
        ]);
        const booleans = new Set(['true', 'false', 'null']);

        if (line.length > 4000) {
            return escapeHtml(line);
        }

        const tokenRegex = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_][a-zA-Z0-9_]*\b)/g;
        let out = '';
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = tokenRegex.exec(line)) !== null) {
            if (match.index > lastIndex) {
                out += escapeHtml(line.slice(lastIndex, match.index));
            }
            const token = match[0];
            const safeToken = escapeHtml(token);

            if (token.startsWith('//') || token.startsWith('/*')) {
                out += `<span style="color: ${colors.comment}">${safeToken}</span>`;
            } else if (token.startsWith('"') || token.startsWith("'")) {
                out += `<span style="color: ${colors.string}">${safeToken}</span>`;
            } else if (/^\d/.test(token)) {
                out += `<span style="color: ${colors.number}">${safeToken}</span>`;
            } else if (booleans.has(token)) {
                out += `<span style="color: ${colors.boolean}">${safeToken}</span>`;
            } else if (keywords.has(token)) {
                out += `<span style="color: ${colors.keyword}">${safeToken}</span>`;
            } else if (types.has(token)) {
                out += `<span style="color: ${colors.type}">${safeToken}</span>`;
            } else if (line.slice(tokenRegex.lastIndex).trimStart().startsWith('(')) {
                out += `<span style="color: ${colors.function}">${safeToken}</span>`;
            } else {
                out += safeToken;
            }
            lastIndex = tokenRegex.lastIndex;
        }

        if (lastIndex < line.length) {
            out += escapeHtml(line.slice(lastIndex));
        }

        return out;
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
        const prefixInfo = '';

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
                            const cmdPath = args.Path || args.path || args.TargetPath || args.targetPath || args.TargetFile || args.targetFile || args.AbsolutePath || args.absolutePath;
                            const contentHtml = this.generateFileContentHtml(raw, -1, lm.t('Command Output'), true, cmdPath);
                            infos.push(this.storeDiffHtml(contentHtml));
                        }
                    }
                }
                else if (tc.name === 'replace_file_content') {
                    if (args.TargetContent !== undefined && args.ReplacementContent !== undefined) {
                        const startLine = parseInt(args.StartLine) || 0;
                        const filename = args.TargetFile || args.File || args.Path || '';
                        const diffHtml = this.generateDiffHtml(args.TargetContent, args.ReplacementContent, startLine, filename);
                        infos.push(this.storeDiffHtml(diffHtml));
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
                            infos.push(this.storeDiffHtml(diffHtml));
                        });
                    }
                } else if (tc.name === 'grep_search') {
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
                                        const file = String(item.file || item.path || item.relativePath || item.absolutePath || item.filepath || item.file_path || '???');
                                        const lineNum = item.line || item.lineNumber || '';
                                        const content = String(item.content || item.lineContent || '');
                                        const displayFile = file.split(/[/\\]/).pop() || file;
                                        return `<div class="outline-item" style="padding: 4px 0; border-bottom: 1px solid rgba(127,127,127,0.05);">
                                            <div style="display: flex; gap: 8px; font-size: 0.85em; opacity: 0.7; margin-bottom: 2px;">
                                                <span data-action="open-file" data-path="${escapeHtml(`${file}${lineNum ? '#L' + lineNum : ''}`)}" style="cursor: pointer; color: var(--vscode-textLink-foreground); font-weight: 600;">${escapeHtml(displayFile)}${lineNum ? ':' + escapeHtml(String(lineNum)) : ''}</span>
                                            </div>
                                            <div style="font-family: var(--vscode-editor-font-family); font-size: 0.9em; white-space: pre-wrap; word-break: break-all; opacity: 0.9;">${escapeHtml(content)}</div>
                                        </div>`;
                                    }).join('');

                                    if (resultsHtml) {
                                        const containerHtml = `<div class="diff-container">
                                            <div class="diff-header collapsed" data-action="toggle-diff">
                                                <span class="icon">🔍</span> ${escapeHtml(lm.t('Search Results'))}
                                                <span class="stats">${data.results.length} ${escapeHtml(lm.t('matches'))}</span>
                                            </div>
                                            <div class="diff-block collapsed" style="padding: 8px 12px;">
                                                ${resultsHtml}
                                            </div>
                                        </div>`;
                                        infos.push(this.storeDiffHtml(containerHtml));
                                    }
                                } else if (data.rawOutput) {
                                    const raw = data.rawOutput.length > 5000 ? data.rawOutput.substring(0, 5000) + '...' : data.rawOutput;
                                    const contentHtml = this.generateFileContentHtml(raw, -1, lm.t('Search Results'));
                                    infos.push(this.storeDiffHtml(contentHtml));
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
                                        <span style="font-weight: 500;">${escapeHtml(String(item.name || item.path || '???'))}</span>
                                        <span style="margin-left: auto; opacity: 0.5; font-family: var(--vscode-editor-font-family);">${escapeHtml(children)}${escapeHtml(size)}</span>
                                    </div>`;
                                }).join('');

                                if (listHtml) {
                                    const containerHtml = `<div class="diff-container">
                                        <div class="diff-header collapsed" data-action="toggle-diff">
                                            <span class="icon">📁</span> ${escapeHtml(lm.t('Directory Listing'))}
                                            <span class="stats">${data.results.length} ${escapeHtml(lm.t('items'))}</span>
                                        </div>
                                        <div class="diff-block collapsed" style="padding: 8px 12px;">
                                            ${listHtml}
                                        </div>
                                    </div>`;
                                    infos.push(this.storeDiffHtml(containerHtml));
                                }
                            }
                        } catch { /* ignore */ }
                    }
                } else if (tc.name === 'find_by_name') {
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
                                        const p = String(item.path || item.relative_path || item.name || '???');
                                        const icon = (item.type === 'directory') ? '📁' : '📄';
                                        const displayPath = p.split(/[/\\]/).pop() || p;
                                        return `<div class="outline-item" style="display: flex; gap: 8px; font-size: 0.9em; padding: 2px 0;">
                                            <span style="opacity: 0.6; min-width: 20px; text-align: center;">${icon}</span>
                                            <span data-action="open-file" data-path="${escapeHtml(p)}" style="cursor: pointer; color: var(--vscode-textLink-foreground); font-weight: 500;">${escapeHtml(displayPath)}</span>
                                            <span style="margin-left: auto; opacity: 0.4; font-size: 0.8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;">${escapeHtml(p)}</span>
                                        </div>`;
                                    }).join('');

                                    if (resultsHtml) {
                                        const containerHtml = `<div class="diff-container">
                                            <div class="diff-header collapsed" data-action="toggle-diff">
                                                <span class="icon">🔍</span> ${escapeHtml(lm.t('Find Results'))}
                                                <span class="stats">${data.results.length} ${escapeHtml(lm.t('matches'))}</span>
                                            </div>
                                            <div class="diff-block collapsed" style="padding: 8px 12px;">
                                                ${resultsHtml}
                                            </div>
                                        </div>`;
                                        infos.push(this.storeDiffHtml(containerHtml));
                                    }
                                } else if (data.rawOutput) {
                                    const raw = data.rawOutput.length > 5000 ? data.rawOutput.substring(0, 5000) + '...' : data.rawOutput;
                                    const contentHtml = this.generateFileContentHtml(raw, -1, lm.t('Find Results'));
                                    infos.push(this.storeDiffHtml(contentHtml));
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
                                const rendered = this.md ? this.md.render(String(content)) : escapeHtml(String(content));
                                const containerHtml = `<div class="diff-container">
                                    <div class="diff-header collapsed" data-action="toggle-diff">
                                        <span class="icon">🌐</span> ${escapeHtml(lm.t('Page Content'))}
                                    </div>
                                    <div class="diff-block collapsed markdown-body" style="padding: 15px;">
                                        ${rendered}
                                    </div>
                                </div>`;
                                infos.push(this.storeDiffHtml(containerHtml));
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
                                    const rawUrl = typeof r.url === 'string' ? r.url.trim() : '';
                                    const isSafeUrl = /^https?:\/\//i.test(rawUrl);
                                    const safeTitle = escapeHtml(String(r.title || rawUrl || 'Result'));
                                    const titleHtml = isSafeUrl
                                        ? `<a href="${escapeHtml(rawUrl)}" style="color: var(--vscode-textLink-foreground); text-decoration: none;">${safeTitle}</a>`
                                        : `<span>${safeTitle}</span>`;
                                    return `<div style="margin-bottom: 8px;">
                                        <div style="font-weight: 600;">${titleHtml}</div>
                                        <div style="font-size: 0.85em; opacity: 0.8; white-space: pre-wrap;">${escapeHtml(String(r.snippet || ''))}</div>
                                    </div>`;
                                }).join('');

                                if (listHtml) {
                                    const containerHtml = `<div class="diff-container">
                                        <div class="diff-header collapsed" data-action="toggle-diff">
                                            <span class="icon">🔍</span> ${escapeHtml(lm.t('Web Search Results'))}
                                        </div>
                                        <div class="diff-block collapsed" style="padding: 12px;">
                                            ${listHtml}
                                        </div>
                                    </div>`;
                                    infos.push(this.storeDiffHtml(containerHtml));
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
                                const linesHtml = outline.ccis.map((cci: any) => {
                                    const start = cci.startLine !== undefined ? cci.startLine : '';
                                    const end = cci.endLine !== undefined ? cci.endLine : '';
                                    const range = start !== '' ? `L${start}-${end}` : '';
                                    const name = String(cci.nodeName || '???');

                                    let icon = '📦';
                                    if (cci.contextType?.includes('CLASS')) icon = '🏛️';
                                    if (cci.contextType?.includes('FUNCTION') || cci.contextType?.includes('METHOD')) icon = 'ƒ';
                                    if (cci.contextType?.includes('INTERFACE')) icon = '📋';

                                    return `<div class="outline-item" style="display: flex; gap: 8px; font-size: 0.9em; padding: 2px 0;">
                                        <span style="opacity: 0.6; min-width: 20px; text-align: center;">${icon}</span>
                                        <span style="font-weight: 600; color: var(--vscode-symbolIcon-methodForeground);">${escapeHtml(name)}</span>
                                        <span style="margin-left: auto; opacity: 0.5; font-family: var(--vscode-editor-font-family);">${escapeHtml(range)}</span>
                                    </div>`;
                                }).join('');

                                if (linesHtml) {
                                    const containerHtml = `<div class="diff-container">
                                        <div class="diff-header collapsed" data-action="toggle-diff">
                                            <span class="icon">🧱</span> ${escapeHtml(lm.t('File Outline'))}
                                            <span class="stats">${outline.ccis.length} ${escapeHtml(lm.t('symbols'))}</span>
                                        </div>
                                        <div class="diff-block collapsed" style="padding: 8px 12px;">
                                            ${linesHtml}
                                        </div>
                                    </div>`;
                                    infos.push(this.storeDiffHtml(containerHtml));
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                } else if (tc.name === 'view_file') {
                    const outputToParse = tc.output || tc.response || tc.result;
                    if (outputToParse) {
                        const outputStr = typeof outputToParse === 'string' ? outputToParse : JSON.stringify(outputToParse);
                        let res: any = null;
                        try { res = typeof outputToParse === 'string' ? JSON.parse(outputToParse) : outputToParse; } catch { /* ignore */ }

                        let fileContent = '';
                        let numLines = '';
                        let numBytes = '';
                        let startLine = 1;

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
                                        codeLines.push(line);
                                    }
                                }
                            }
                            if (codeLines.length > 0) fileContent = codeLines.join('\n');

                            if (!fileContent && outputStr.trim()) {
                                if (outputStr.trim().startsWith('{')) {
                                    try {
                                        const obj = JSON.parse(outputStr);
                                        fileContent = JSON.stringify(obj, null, 2);
                                        startLine = -1;
                                    } catch { /* ignore */ }
                                }
                                if (!fileContent) {
                                    fileContent = outputStr.trim();
                                    startLine = -1;
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
                            infos.push(this.storeDiffHtml(contentHtml));
                        }
                    }
                } else if (tc.name === 'generate_image') {
                    if (tc.output) {
                        try {
                            const res = typeof tc.output === 'string' ? JSON.parse(tc.output) : tc.output;
                            const imagePath = res.image_path || res.imagePath;
                            if (imagePath && typeof imagePath === 'string') {
                                const desc = String(res.description || res.Prompt || args.Prompt || '');
                                const safeSrc = escapeHtml(`vscode-resource:${imagePath.replace(/\\/g, '/')}`);
                                const safeDesc = escapeHtml(desc);
                                const containerHtml = `<div class="diff-container">
                                    <div class="diff-header" data-action="toggle-diff">${escapeHtml(lm.t('Generated Image'))}</div>
                                    <div class="diff-block" style="padding: 10px; background: var(--vscode-editor-background); text-align: center;">
                                        <img src="${safeSrc}" style="max-width: 100%; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);" alt="${safeDesc}"/>
                                        ${safeDesc ? `<div style="margin-top: 8px; font-size: 0.9em; opacity: 0.8;">${safeDesc}</div>` : ''}
                                    </div>
                                </div>`;
                                infos.push(this.storeDiffHtml(containerHtml));
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

    private extractFromObj(obj: any, depth: number = 0, seen: WeakSet<object> = new WeakSet()): string {
        if (!obj || depth > 15) return '';
        if (typeof obj === 'string') return obj;
        if (typeof obj === 'object') {
            if (seen.has(obj)) return '';
            seen.add(obj);
        }
        if (Array.isArray(obj)) return obj.map(o => this.extractFromObj(o, depth + 1, seen)).filter(Boolean).join('\n');

        // Standard protobuf text containers
        if (obj.content !== undefined) {
            if (typeof obj.content === 'string') return obj.content;
            if (Array.isArray(obj.content)) return this.extractFromObj(obj.content, depth + 1, seen);
        }
        if (obj.text !== undefined && typeof obj.text === 'string') return obj.text;
        if (obj.text && typeof obj.text === 'object') {
            const res = obj.text.content || obj.text.text || obj.text.value;
            if (typeof res === 'string') return res;
            return this.extractFromObj(obj.text, depth + 1, seen);
        }
        if (obj.value !== undefined) {
            if (typeof obj.value === 'string') return obj.value;
            if (typeof obj.value === 'object') return this.extractFromObj(obj.value, depth + 1, seen);
        }

        // Specific fields depending on object type
        if (obj.modelResponse) return this.extractFromObj(obj.modelResponse.content || obj.modelResponse.parts || obj.modelResponse.text || obj.modelResponse, depth + 1, seen);
        if (obj.userInput) return this.extractFromObj(obj.userInput.items || obj.userInput.userResponse || obj.userInput.text || obj.userInput, depth + 1, seen);
        if (obj.plannerResponse) {
            const thinking = obj.plannerResponse.thinking || obj.plannerResponse.thought;
            if (thinking) return typeof thinking === 'string' ? thinking : this.extractFromObj(thinking, depth + 1, seen);
            const resp = obj.plannerResponse.response || obj.plannerResponse.modifiedResponse || obj.plannerResponse.message || obj.plannerResponse.text;
            return this.extractFromObj(resp || obj.plannerResponse, depth + 1, seen);
        }
        if (obj.errorMessage) {
            const err = obj.errorMessage.error || obj.errorMessage || {};
            const userMsg = err.userErrorMessage || err.message || (typeof obj.errorMessage === 'string' ? obj.errorMessage : '');
            const details = err.shortError || err.fullError || err.modelErrorMessage || '';
            if (userMsg && details && details !== userMsg) return `${userMsg}\n\n${details}`;
            return userMsg || details || this.extractFromObj(obj.errorMessage, depth + 1, seen);
        }
        if (obj.notifyUser) return obj.notifyUser.notificationContent || obj.notifyUser.message || this.extractFromObj(obj.notifyUser, depth + 1, seen);
        if (obj.message) return this.extractFromObj(obj.message, depth + 1, seen);

        // Expanded generic fields
        if (obj.thinking) return typeof obj.thinking === 'string' ? obj.thinking : this.extractFromObj(obj.thinking, depth + 1, seen);
        if (obj.error) {
            const userMsg = obj.error.userErrorMessage || obj.error.message || '';
            const details = obj.error.shortError || obj.error.fullError || obj.error.modelErrorMessage || '';
            if (userMsg && details && details !== userMsg) return `${userMsg}\n\n${details}`;
            return userMsg || details || this.extractFromObj(obj.error, depth + 1, seen);
        }
        if (obj.modelErrorMessage) return obj.modelErrorMessage;

        if (obj.details) return this.extractFromObj(obj.details, depth + 1, seen);
        if (obj.stack) return this.extractFromObj(obj.stack, depth + 1, seen);
        if (obj.description) return this.extractFromObj(obj.description, depth + 1, seen);
        if (obj.summary) return this.extractFromObj(obj.summary, depth + 1, seen);
        if (obj.query) return this.extractFromObj(obj.query, depth + 1, seen);
        if (obj.input) return this.extractFromObj(obj.input, depth + 1, seen);
        if (obj.notificationContent) return this.extractFromObj(obj.notificationContent, depth + 1, seen);

        if (obj.toolCalls && Array.isArray(obj.toolCalls)) {
            return obj.toolCalls.map((tc: any) => `[TOOL_CALL:${tc.name || 'Unknown'}]`).join('\n');
        }

        if (obj.items && Array.isArray(obj.items)) return this.extractFromObj(obj.items, depth + 1, seen);
        if (obj.parts && Array.isArray(obj.parts)) return this.extractFromObj(obj.parts, depth + 1, seen);

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
                const rawMime = String(item.image?.mimeType || item.inlineData?.mimeType || item.mimeType || 'image/png');
                const mime = /^image\/[a-zA-Z0-9.+-]+$/.test(rawMime) ? rawMime : 'image/png';
                const base64Data = typeof data === 'string' ? data : data?.data || '';
                const safeBase64 = String(base64Data).replace(/[^A-Za-z0-9+/=]/g, '');

                const uri = String(item.image?.uri || item.uri || '');
                let fileName = item.image?.name || item.name || '';
                if (!fileName && uri && !uri.startsWith('data:')) {
                    try {
                        const cleanPath = uri.startsWith('file://') ? uri.substring(7) : uri;
                        fileName = decodeURIComponent(cleanPath).split(/[/\\]/).pop() || '';
                    } catch {
                        fileName = uri.split(/[/\\]/).pop() || '';
                    }
                }
                const label = String(fileName || `${mime.split('/')[1].toUpperCase()}`);

                return `
                        <div class="attachment-item" title="${escapeHtml(uri)}">
                            <img src="data:${mime};base64,${safeBase64}" data-action="show-image" alt="${escapeHtml(label)}">
                            <div class="attachment-label">
                                <span class="name">🖼️ ${escapeHtml(label)}</span>
                                <button class="copy-btn mini" title="${escapeHtml(lm.t('Copy Link'))}" data-action="copy-text" data-copy="${escapeHtml(uri)}">📋</button>
                            </div>
                        </div>
                    `;
            }
            if (item.fileData || item.file || (item.mimeType && !item.mimeType.startsWith('image/'))) {
                const name = String(item.fileData?.name || item.file?.name || item.name || 'File');
                const fPath = String(item.fileData?.path || item.file?.path || item.path || name);
                const icon = getFileIconSvg(name);

                return `
                    <div class="attachment-item file-button" data-action="open-file" data-path="${escapeHtml(fPath)}">
                        <div class="attachment-icon">${icon}</div>
                        <div class="attachment-label" title="${escapeHtml(fPath || name)}">
                            <span class="name">${escapeHtml(name)}</span>
                            <button class="copy-btn mini" title="${escapeHtml(lm.t('Copy Link'))}" data-action="copy-text" data-copy="${escapeHtml(fPath)}">📋</button>
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
        const status = (step.status || '').toUpperCase();

        if (typeStr === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' || step.errorMessage || stopReason.includes('ERROR') || stopReason.includes('CANCELED') || status === 'CORTEX_STEP_STATUS_ERROR') {
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

        // Strip known prefixes from input (e.g. "MODEL_PLACEHOLDER_M37" → "M37")
        const stripPrefix = (name: string) => name.replace(/^MODEL_PLACEHOLDER_|^PLACEHOLDER_|^MODEL_OPENAI_|^models\//, '');
        const cleanName = stripPrefix(rawName);

        // Dynamic lookup from quota snapshot
        // M-codes like M37 are mapped to labels like "Gemini 3.1 Pro (High)" via GetUserStatus API.
        // The snapshot modelId contains the full prefix (e.g. "MODEL_PLACEHOLDER_M37"),
        // so we strip it for comparison.
        if (this.quotaManager) {
            const snapshot = this.quotaManager.getLatestSnapshot();
            if (snapshot?.models) {
                const cleanUpper = cleanName.toUpperCase();
                const match = snapshot.models.find((m: any) => {
                    const cleanModelId = stripPrefix(m.modelId || '');
                    return cleanModelId.toUpperCase() === cleanUpper
                        || (m.modelId || '').toUpperCase() === cleanUpper
                        || (m.label || '').toUpperCase() === cleanUpper;
                });
                if (match?.label) return match.label;
            }
        }

        // Fallback: clean up underscores for readability
        return cleanName.replace(/_/g, ' ').trim();
    }

    private renderTokenUsage(usage: any, latencyMs: number = 0): string {
        if (!usage && latencyMs === 0) return '';
        const lm = LocalizationManager.getInstance();

        const input = parseInt(usage?.inputTokens) || 0;
        const output = parseInt(usage?.outputTokens) || 0;
        const thinking = parseInt(usage?.thinkingOutputTokens) || 0;
        const cache = parseInt(usage?.cacheReadTokens) || 0;
        const total = input + output;
        const totalWithThr = total + thinking + cache;

        if (totalWithThr === 0 && latencyMs === 0) return '';

        let html = '<div class="token-usage">';
        if (input > 0) html += `<div class="token-badge"><span class="token-icon">📥</span><span>${escapeHtml(lm.t('Input'))}: ${input.toLocaleString()}</span></div>`;
        if (output > 0) html += `<div class="token-badge"><span class="token-icon">📤</span><span>${escapeHtml(lm.t('Output'))}: ${output.toLocaleString()}</span></div>`;
        if (thinking > 0) html += `<div class="token-badge thinking"><span class="token-icon">🧠</span><span>${escapeHtml(lm.t('Thinking'))}: ${thinking.toLocaleString()}</span></div>`;
        if (cache > 0) html += `<div class="token-badge"><span class="token-icon">💾</span><span>${escapeHtml(lm.t('Cached'))}: ${cache.toLocaleString()}</span></div>`;

        if (latencyMs > 0) {
            const seconds = (latencyMs / 1000).toFixed(1);
            html += `<div class="token-badge thinking" style="border-color: rgba(255, 165, 0, 0.5);"><span class="token-icon">⏱️</span><span>${escapeHtml(lm.t('Thinking'))}: ${seconds}${escapeHtml(lm.t('s'))}</span></div>`;
        }

        html += `<div class="token-badge total" title="${escapeHtml(lm.formatDateTime(new Date()))}"><span class="token-icon">📊</span><span>${escapeHtml(lm.t('Total'))}: ${totalWithThr.toLocaleString()}</span></div>`;
        html += '</div>';

        return html;
    }

    private formatModelError(text: string, step?: any): string {
        const lm = LocalizationManager.getInstance();

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
                    const detailsStr = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
                    try {
                        const obj = typeof details === 'string' ? JSON.parse(details) : details;
                        const highlightedJson = this.highlightDiff(JSON.stringify(obj, null, 2));
                        detailsHtml = `<pre>${highlightedJson}</pre>`;
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
                                    if (!displayMessage) displayMessage = String(obj.error.message);
                                    detailsHtml += `<div class="error-message" style="margin: 0; padding: 2px 0;"><b>Message:</b> ${escapeHtml(String(obj.error.message))}</div>`;
                                }
                                if (obj.error.status) detailsHtml += `<div class="error-status" style="margin: 0; padding: 2px 0;"><b>Status:</b> ${escapeHtml(String(obj.error.status))}</div>`;
                                if (obj.error.details) {
                                    const highlightedDetails = this.highlightDiff(JSON.stringify(obj.error.details, null, 2));
                                    detailsHtml += `<pre>${highlightedDetails}</pre>`;
                                }
                            } else {
                                detailsHtml = `<pre>${escapeHtml(String(jsonStr))}</pre>`;
                                if (!displayMessage && obj.message) displayMessage = String(obj.message);
                            }
                        } catch {
                            detailsHtml = `<pre>${this.highlightDiff(String(jsonStr))}</pre>`;
                        }
                    } catch {
                        detailsHtml = `<pre>${this.highlightDiff(detailsMatch[1])}</pre>`;
                    }
                }
            }
        }

        if (errorCode || (text.includes('Encountered retryable error') && detailsHtml)) {
            const headerText = escapeHtml(`${lm.t('Model Provider Error')}${errorCode ? ' ' + errorCode : ''}`);
            return `
                    <div class="model-error-card" style="border: 1px solid rgba(255, 70, 70, 0.3); background: linear-gradient(135deg, var(--vscode-inputValidation-errorBackground), rgba(80, 20, 20, 0.45)); padding: 8px 12px; border-radius: 8px; margin: 8px 0; position: relative; font-size: 0.9em; box-shadow: 0 4px 15px rgba(0,0,0,0.25), inset 0 0 8px rgba(255,100,100,0.05); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); overflow: hidden;">
                        <div class="error-header" style="display: flex; align-items: center; color: var(--vscode-errorForeground); margin-bottom: 4px;">
                            <span class="icon" style="margin-right: 8px; filter: drop-shadow(0 0 3px var(--vscode-errorForeground)); font-size: 1.1em;">🚫</span>
                            <strong style="font-size: 1.05em; opacity: 0.95; letter-spacing: 0.3px;">${headerText}</strong>
                        </div>
                        <div class="error-body" style="font-family: var(--vscode-editor-font-family); white-space: normal; line-height: 1.4;">${(() => {
                    const bodyParts: string[] = [];
                    const mainMsg = displayMessage && displayMessage !== lm.t('Model Provider Error') ? String(displayMessage) : '';

                    if (mainMsg) {
                        bodyParts.push(`<div style="font-weight: 600; white-space: pre-wrap; opacity: 0.9; margin-bottom: 4px;">${escapeHtml(mainMsg)}</div>`);
                    }

                    if (detailsHtml) {
                        const cleanedDetails = detailsHtml.replace(/<pre>/g, '<pre style="margin: 0; padding: 6px; background: rgba(0,0,0,0.25); border-radius: 4px; line-height: 1.3; overflow-x: auto; max-width: 100%; border: 1px solid rgba(255,255,255,0.05);">');
                        bodyParts.push(`<div class="diff-container" style="border:none; margin: 0; background: transparent; width: 100%;">
                            <div class="diff-header collapsed" data-action="toggle-diff" style="padding: 2px 8px; background: rgba(255,255,255,0.07); font-size: 10px; opacity: 0.8; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; min-height: 0; margin: 4px 0; display: inline-flex; align-items: center; cursor: pointer; transition: all 0.2s; color: var(--vscode-foreground);">
                                <div class="diff-icon" style="font-size: 9px; width: 14px; margin-right: 4px;">🔍</div>
                                <span style="font-weight: 500;">${escapeHtml(lm.t('Show details'))}</span>
                            </div>
                            <div class="diff-block collapsed" style="border:none; background: rgba(0,0,0,0.15); border-radius: 6px; padding: 0; margin: 4px 0 0 0; width: 100%; overflow: hidden;">
                                <div class="diff-lines-wrapper" style="font-size: 11px; line-height: 1.4; padding: 4px; overflow-x: auto;">
                                    ${cleanedDetails}
                                </div>
                            </div>
                        </div>`);
                    } else {
                        let rawText = text.replace(/errorCode[\s\S]*}/, '').split('details')[0].trim();
                        rawText = rawText.replace(/^[{},]+|[{},]+$/g, '').trim();
                        if (rawText && rawText !== mainMsg && rawText !== lm.t('Model Provider Error') && !mainMsg.includes(rawText)) {
                            bodyParts.push(`<div style="opacity: 0.8; font-size: 0.9em; white-space: pre-wrap; background: rgba(0,0,0,0.1); padding: 4px 8px; border-radius: 4px; border-left: 2px solid var(--vscode-errorForeground);">${escapeHtml(rawText)}</div>`);
                        }
                    }

                    return bodyParts.join('');
                })()}</div>
                    </div>
                `;
        }

        return text;
    }
}

