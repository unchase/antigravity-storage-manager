import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import extract from 'extract-zip';
import { GoogleAuthProvider } from './googleAuth';
import { GoogleDriveService, SyncManifest, SyncedConversation, MachineState, FileHashInfo } from './googleDrive';
import * as crypto from './crypto';
import { formatRelativeTime, getConversationsAsync } from './utils';

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
    private isSyncing: boolean = false;
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
    async syncNow(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<SyncResult> {
        if (this.isSyncing) {
            return {
                success: false,
                pushed: [],
                pulled: [],
                conflicts: [],
                errors: [vscode.l10n.t('Sync already in progress')]
            };
        }

        if (!this.isReady()) {
            return {
                success: false,
                pushed: [],
                pulled: [],
                conflicts: [],
                errors: [vscode.l10n.t('Sync not configured or not authenticated')]
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
            this.reportProgress(progress, vscode.l10n.t('Acquiring sync lock...'));
            const machineId = this.config!.machineId;
            // Lock for 5 minutes (default)
            const acquired = await this.driveService.acquireLock(machineId);
            if (!acquired) {
                throw new Error(vscode.l10n.t('Sync is currently locked by another machine. Please try again later.'));
            }

            try {
                // Get remote manifest
                this.reportProgress(progress, vscode.l10n.t('Fetching remote data...'));
                const remoteManifest = await this.ensureRemoteManifest();
                if (!remoteManifest) {
                    throw new Error(vscode.l10n.t('Could not retrieve remote manifest'));
                }

                // Get local conversations
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
                const chunkSize = 5;
                for (let i = 0; i < toSync.length; i += chunkSize) {
                    const chunk = toSync.slice(i, i + chunkSize);
                    await Promise.all(chunk.map(convId =>
                        this.processSyncItem(convId, localConversations, remoteManifest, result)
                    ));
                }

                // Update last sync time
                this.config!.lastSync = new Date().toISOString();
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
        }

        return result;
    }

    /**
     * Push a single conversation to Google Drive (per-file sync)
     */
    async pushConversation(conversationId: string, progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
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
        for (const relativePath of filesToUpload) {
            uploadedCount++;
            this.reportProgress(progress, vscode.l10n.t('Uploading {0} ({1}/{2})...', relativePath.split('/').pop() || '', uploadedCount, filesToUpload.length));

            // Read and encrypt file
            const fullPath = this.getFullPathForRelative(conversationId, relativePath);
            const content = await fs.promises.readFile(fullPath);
            const encrypted = crypto.encrypt(content, this.masterPassword!);

            await this.driveService.uploadConversationFile(conversationId, relativePath, encrypted);
        }

        // Delete removed files from remote
        for (const relativePath of filesToDelete) {
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
    async pullConversation(conversationId: string, progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
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
            await this.pullConversationPerFile(conversationId, remoteConv.fileHashes, progress);
        } else {
            // Legacy format - download entire ZIP
            await this.pullConversationLegacy(conversationId, progress);
        }
    }

    /**
     * Pull conversation using per-file sync (new format)
     */
    private async pullConversationPerFile(
        conversationId: string,
        remoteHashes: { [relativePath: string]: FileHashInfo },
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<void> {
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

        // Download changed files
        let downloadedCount = 0;
        for (const relativePath of filesToDownload) {
            downloadedCount++;
            this.reportProgress(progress, vscode.l10n.t('Downloading {0} ({1}/{2})...', relativePath.split('/').pop() || '', downloadedCount, filesToDownload.length));

            const encrypted = await this.driveService.downloadConversationFile(conversationId, relativePath);
            if (encrypted) {
                const content = crypto.decrypt(encrypted, this.masterPassword!);
                const fullPath = this.getFullPathForRelative(conversationId, relativePath);

                // Ensure directory exists
                await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, content);
            }
        }

        // Delete locally files that were deleted remotely
        for (const relativePath of filesToDelete) {
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
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<void> {
        // Download encrypted ZIP
        this.reportProgress(progress, vscode.l10n.t('Downloading {0}...', conversationId));
        const encrypted = await this.driveService.downloadConversation(conversationId);
        if (!encrypted) {
            throw new Error(vscode.l10n.t('Conversation {0} not found in Drive', conversationId));
        }

        // Decrypt
        this.reportProgress(progress, vscode.l10n.t('Decrypting {0}...', conversationId));
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

        if (!this.config?.showStatusBar) {
            this.statusBarItem.hide();
            return;
        }

        switch (status) {
            case 'idle':
                this.statusBarItem.text = "$(cloud) AG Sync";
                this.statusBarItem.tooltip = vscode.l10n.t("Antigravity Storage Manager (Click for Menu)");
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'syncing':
                this.statusBarItem.text = `$(sync~spin) ${text || "AG Syncing..."}`;
                this.statusBarItem.tooltip = vscode.l10n.t("Antigravity Sync: Syncing...");
                this.statusBarItem.backgroundColor = undefined;
                break;
            case 'error':
                this.statusBarItem.text = "$(error) AG Sync";
                this.statusBarItem.tooltip = vscode.l10n.t("Antigravity Sync: Error (Click for Menu)");
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
            case 'ok':
                this.statusBarItem.text = "$(check) AG Sync";
                this.statusBarItem.tooltip = vscode.l10n.t("Antigravity Sync: Up to date");
                this.statusBarItem.backgroundColor = undefined;
                // Revert to idle after 5 seconds
                setTimeout(() => {
                    if (!this.isSyncing) this.updateStatusBar('idle');
                }, 5000);
                break;
        }

        if (text && status !== 'syncing') {
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
        if (!fs.existsSync(BRAIN_DIR)) {
            return [];
        }

        let dirs: string[] = [];
        try {
            const entries = await fs.promises.readdir(BRAIN_DIR, { withFileTypes: true });
            dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        } catch {
            return [];
        }

        return Promise.all(dirs.map(async id => {
            const dirPath = path.join(BRAIN_DIR, id);
            const hash = await this.computeConversationHashAsync(id);

            let title = id;
            const taskPath = path.join(dirPath, 'task.md');
            if (fs.existsSync(taskPath)) {
                try {
                    const content = await fs.promises.readFile(taskPath, 'utf8');
                    const match = content.match(/^#\s*Task:?\s*(.*)$/im);
                    if (match && match[1]) {
                        title = match[1].trim();
                    }
                } catch {
                    // Ignore error
                }
            }

            let lastModified = new Date().toISOString();
            try {
                const stats = await fs.promises.stat(dirPath);
                lastModified = stats.mtime.toISOString();
            } catch { }

            return {
                id,
                title,
                lastModified,
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
     * Setup wizard
     */
    async setup(): Promise<void> {
        // 1. Check if we need to authenticate
        try {
            const token = await this.authProvider.getAccessToken();
            if (!token) {
                throw new Error('Not signed in');
            }
        } catch (e: any) {
            const answer = await vscode.window.showInformationMessage(
                vscode.l10n.t("To sync conversations, you need to sign in with Google."),
                vscode.l10n.t("Sign In"),
                vscode.l10n.t("Cancel")
            );

            if (answer !== vscode.l10n.t("Sign In")) return;

            try {
                await this.authProvider.signIn();
            } catch (err: any) {
                vscode.window.showErrorMessage(vscode.l10n.t("Login failed: {0}", err.message));
                return;
            }
        }

        // 2. Set Master Password
        const password = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Create a Master Password to encrypt your data"),
            password: true,
            validateInput: (value) =>
                value && value.length >= 8 ? null : vscode.l10n.t("Password must be at least 8 characters")
        });

        if (!password) return;

        // 3. Confirm Password
        const confirm = await vscode.window.showInputBox({
            prompt: vscode.l10n.t("Confirm Master Password"),
            password: true,
            validateInput: (value) =>
                value === password ? null : vscode.l10n.t("Passwords do not match")
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
                prompt: vscode.l10n.t("Enter a name for this machine (e.g. 'Home PC', 'Work Laptop')"),
                value: os.hostname(),
                validateInput: (val) => val ? null : vscode.l10n.t("Machine name cannot be empty")
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
                title: vscode.l10n.t("Setting up sync storage..."),
                cancellable: false
            }, async (progress) => {
                this.reportProgress(progress, vscode.l10n.t('Checking Google Drive folders...'));
                await this.driveService.ensureSyncFolders();

                // Try to get existing manifest
                this.reportProgress(progress, vscode.l10n.t('Checking for existing backup...'));
                const manifest = await this.getDecryptedManifest();

                if (manifest) {
                    vscode.window.showInformationMessage(vscode.l10n.t("Found existing sync data! Joined as '{0}'.", this.config!.machineName));

                    // Ask user which conversations to sync
                    if (manifest.conversations.length > 0) {
                        const items = manifest.conversations.map(c => ({
                            label: c.title || c.id,
                            description: c.id,
                            picked: true, // Default to all
                            id: c.id
                        }));

                        const selected = await vscode.window.showQuickPick(items, {
                            canPickMany: true,
                            placeHolder: vscode.l10n.t('Select conversations to sync from Google Drive')
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
                    this.reportProgress(progress, vscode.l10n.t('Creating initial backup...'));
                    await this.createInitialManifest();
                    vscode.window.showInformationMessage(vscode.l10n.t("Sync set up successfully!"));
                }

                // Trigger first sync
                await this.syncNow(progress);
            });

            this.updateStatusBar('idle');
            this.startAutoSync();

        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t("Setup failed: {0}", error.message));
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
        vscode.window.showInformationMessage(vscode.l10n.t("Disconnected from sync. Local data is kept safe."));
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
    private async processSyncItem(
        convId: string,
        localConversations: Array<{ id: string; title: string; lastModified: string; hash: string }>,
        remoteManifest: SyncManifest,
        result: SyncResult,
        progress?: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<void> {
        this.reportProgress(progress, vscode.l10n.t('Processing {0}...', convId));
        const local = localConversations.find(c => c.id === convId);
        const remote = remoteManifest.conversations.find(c => c.id === convId);

        if (local && !remote) {
            // Local only - push to remote
            try {
                await this.pushConversation(convId, progress);
                result.pushed.push(convId);
            } catch (error: any) {
                result.errors.push(`Failed to push ${convId}: ${error.message}`);
            }
        } else if (!local && remote) {
            // Remote only - pull to local
            try {
                await this.pullConversation(convId, progress);
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
                        await this.pushConversation(convId, progress);
                        result.pushed.push(convId);
                    } catch (error: any) {
                        result.errors.push(`Failed to push ${convId}: ${error.message}`);
                    }
                } else if (localDate > remoteDate) {
                    // Local is newer
                    try {
                        await this.pushConversation(convId, progress);
                        result.pushed.push(convId);
                    } catch (error: any) {
                        result.errors.push(`Failed to push ${convId}: ${error.message}`);
                    }
                } else if (remoteDate > localDate) {
                    // Remote is newer
                    try {
                        await this.pullConversation(convId, progress);
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
            vscode.l10n.t('Antigravity Sync Statistics'),
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this.getLoadingHtml();

        try {
            // Gather data
            const localConversations = await this.getLocalConversationsAsync();
            const start = Date.now();
            const remoteManifest = await this.getDecryptedManifest();

            // Get machine states
            const machineFiles = await this.driveService.listMachineStates();
            const machines: Array<{ name: string; id: string; lastSync: string; isCurrent: boolean; conversationStates: any[] }> = [];

            for (const file of machineFiles) {
                let machineName = 'Unknown Device';
                let lastSync = file.modifiedTime;

                try {
                    // Try to decrypt to get real name
                    // The filename is ID.json.enc
                    // We need to match file.id (Drive ID) or we can use the name (which is ID.json.enc)
                    // file.name is "GUID.json.enc"
                    const machineId = file.name.replace('.json.enc', '');

                    if (machineId === this.config!.machineId) {
                        machineName = this.config!.machineName;
                        machines.push({
                            name: machineName,
                            id: machineId,
                            lastSync: lastSync,
                            isCurrent: true,
                            conversationStates: (await this.getLocalConversationsAsync()).map(c => ({ id: c.id })) // Current machine has these
                        });
                        continue;
                    }

                    // Download content
                    const contentValues = await this.driveService.getMachineState(machineId);
                    if (contentValues) {
                        const decrypted = crypto.decrypt(contentValues, this.masterPassword!);
                        const state: MachineState = JSON.parse(decrypted.toString());
                        machineName = state.machineName;
                        lastSync = state.lastSync;
                        machines.push({
                            name: machineName,
                            id: machineId,
                            lastSync: lastSync,
                            isCurrent: false,
                            conversationStates: state.conversationStates || []
                        });
                        continue;
                    }
                } catch (e) {
                    console.error('Failed to process machine file:', file.name, e);
                }

                machines.push({
                    name: machineName,
                    id: file.name.replace('.json.enc', ''),
                    lastSync: lastSync,
                    isCurrent: false,
                    conversationStates: []
                });
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
            panel.webview.html = `<html><body><h2>Error loading statistics</h2><p>${error.message}</p></body></html>`;
        }
    }

    private getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html>
        <body style="font-family: sans-serif; padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background);">
            <h2>Loading Sync Statistics...</h2>
            <p>Fetching data from Google Drive...</p>
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
        const machineRows = data.machines.map(m => `
            <tr style="${m.isCurrent ? 'background-color: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground);' : ''}">
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${m.name} ${m.isCurrent ? '(This Machine)' : ''}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${m.id}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${new Date(m.lastSync).toLocaleString()}</td>
            </tr>
        `).join('');

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
            const originMachineName = remote?.createdByName || (local ? 'This Machine' : 'Unknown');
            const isExternal = originMachineId !== data.currentMachineId;

            const sizeStr = remote?.size ? (remote.size / 1024).toFixed(1) + ' KB' : '-';
            const dateStr = remote?.lastModified ? new Date(remote.lastModified).toLocaleString() : (local ? new Date(local.lastModified).toLocaleString() : '-');

            const statusBadges = [];
            if (isMultiSync) statusBadges.push(`<span class="badge" style="background: var(--vscode-progressBar-background); color: white;">Synced on ${syncedCount}</span>`);
            if (isExternal) statusBadges.push(`<span class="badge" style="background: var(--vscode-terminal-ansiCyan); color: black;">Imported</span>`);
            if (!remote) statusBadges.push(`<span class="badge" style="background: var(--vscode-list-errorForeground); color: white;">Local Only</span>`);
            if (!local) statusBadges.push(`<span class="badge" style="background: var(--vscode-list-warningForeground); color: white;">Remote Only</span>`);

            return `
            <tr>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div><strong>${remote?.title || local?.title || id}</strong></div>
                    <div style="font-size: 0.8em; opacity: 0.7;">${id}</div>
                </td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">${sizeStr}</td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div>${dateStr}</div>
                    <div style="font-size: 0.8em; opacity: 0.7;">by ${remote?.modifiedBy === data.currentMachineId ? 'Me' : (data.machines.find(m => m.id === remote?.modifiedBy)?.name || remote?.modifiedBy || 'Unknown')}</div>
                </td>
                 <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    <div>${originMachineName}</div>
                    <div style="font-size: 0.8em; opacity: 0.7;">${remote?.createdAt ? new Date(remote.createdAt).toLocaleDateString() : '-'}</div>
                </td>
                <td style="padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);">
                    ${statusBadges.join(' ')}
                </td>
            </tr>`;
        }).join('');

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th { text-align: left; padding: 8px; border-bottom: 2px solid var(--vscode-panel-border); }
                .card { background-color: var(--vscode-editor-lineHighlightBackground); padding: 15px; border-radius: 5px; margin-bottom: 20px; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
                .stat-value { font-size: 24px; font-weight: bold; }
                .stat-label { opacity: 0.8; font-size: 14px; }
                .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 4px; }
            </style>
        </head>
        <body>
            <h1>Sync Statistics</h1>
            
            <div class="grid">
                <div class="card">
                    <div class="stat-value">${data.localCount}</div>
                    <div class="stat-label">Local Conversations</div>
                </div>
                <div class="card">
                    <div class="stat-value">${data.remoteCount}</div>
                    <div class="stat-label">Remote Conversations</div>
                </div>
                <div class="card">
                    <div class="stat-value">${data.machines.length}</div>
                    <div class="stat-label">Connected Machines</div>
                </div>
            </div>

            <div class="card">
                <div><strong>Last Sync:</strong> ${new Date(data.lastSync).toLocaleString()}</div>
                <div style="font-size: 12px; opacity: 0.6; margin-top: 5px;">Data loaded in ${data.loadTime}ms</div>
            </div>

            <h3>Conversations</h3>
            <table>
                <thead>
                    <tr>
                        <th>Title / ID</th>
                        <th>Size (Remote)</th>
                        <th>Last Modified</th>
                        <th>Origin</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${convRows}
                </tbody>
            </table>

            <h3>Connected Machines</h3>
            <table>
                <thead>
                    <tr>
                        <th>Machine Name</th>
                        <th>ID</th>
                        <th>Last Sync State</th>
                    </tr>
                </thead>
                <tbody>
                    ${machineRows}
                </tbody>
            </table>
        </body>
        </html>`;
    }
}


