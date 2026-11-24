import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';
import { GoogleAuthProvider } from './googleAuth';
import { LocalizationManager } from './l10n/localizationManager';
import { QuotaSnapshot } from './quota/types';
import { StorageService } from './localStorage';

const SYNC_FOLDER_NAME = 'AntigravitySync';
const MACHINES_FOLDER_NAME = 'machines';
const CONVERSATIONS_FOLDER_NAME = 'conversations';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DEFAULT_LOCK_TTL_MS = 300000; // 5 minutes
const MAX_RETRY_DELAY_MS = 30000;

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    size?: string;
    md5Checksum?: string;
}

export interface DeletedConversationEntry {
    deletedAt: string;
    deletedBy: string;
}

export interface ArchivedConversationEntry {
    archivedAt: string;
    archivedBy: string;
}

export interface SyncManifest {
    version: number;
    createdAt: string;
    lastModified: string;
    passwordVerificationSalt: string; // Base64 encoded salt for password verification
    passwordVerificationHash: string; // Hash to verify correct password
    conversations: SyncedConversation[];
    machines?: Machine[];
    deletedConversations?: { [id: string]: DeletedConversationEntry };
    archivedConversations?: { [id: string]: ArchivedConversationEntry };
}

export interface Machine {
    id: string;
    name: string;
    lastSync: string;
    uploadCount?: number;
    downloadCount?: number;
    createdAt?: string;
}

export interface FileHashInfo {
    hash: string;           // MD5 hash of file content
    size: number;           // File size in bytes
    lastModified: string;   // ISO timestamp
}

export interface SyncedConversation {
    id: string;
    title: string;
    lastModified: string;
    hash: string;                                    // Overall conversation hash (for quick comparison)
    modifiedBy: string;                              // machine ID
    fileHashes?: { [relativePath: string]: FileHashInfo }; // Per-file hashes (new format)
    fileId?: string;                                 // Google Drive file ID (legacy)
    size?: number;                                   // Size in bytes
    createdAt?: string;
    createdBy?: string;                              // machine ID
    createdByName?: string;                          // machine name
    version?: number;                                // Format version: 1 = zip, 2 = per-file
}

export interface MachineState {
    machineId: string;
    machineName: string;
    lastSync: string;
    syncCount?: number;
    uploadCount?: number;
    downloadCount?: number;
    quota?: {
        used: number;
        limit: number;
    };
    accountQuota?: QuotaSnapshot;
    conversationStates: {
        id: string;
        localHash: string;
        lastSynced: string;
    }[];
}

export interface LockFile {
    machineId: string;
    expiresAt: number;
    token?: string;
}

/**
 * Escape a string literal for inclusion inside single quotes in a Google Drive API `q` query.
 */
export function escapeDriveQuery(val: string): string {
    return val.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getHttpStatus(error: any): number | undefined {
    const candidate = error?.response?.status ?? error?.status ?? error?.code;
    return typeof candidate === 'number' ? candidate : undefined;
}

function getGoogleErrorReason(error: any): string | undefined {
    return (
        error?.errors?.[0]?.reason ??
        error?.response?.data?.error?.errors?.[0]?.reason ??
        undefined
    );
}

/**
 * Determine whether a Google Drive API error is a real permission error (403 insufficient permissions)
 * as opposed to a rate limit / transient 403.
 */
export function isInsufficientPermissionError(error: any): boolean {
    if (!error) return false;
    const status = getHttpStatus(error);
    const reason = getGoogleErrorReason(error);
    const msg = typeof error.message === 'string' ? error.message : '';

    if (reason) {
        const rateLimitReasons = new Set([
            'rateLimitExceeded',
            'userRateLimitExceeded',
            'sharingRateLimitExceeded',
            'backendError'
        ]);
        if (rateLimitReasons.has(reason)) {
            return false;
        }
        if (reason === 'insufficientPermissions' || reason === 'insufficientFilePermissions' || reason === 'forbidden' || reason === 'authError') {
            return true;
        }
    }

    if (msg.includes('Insufficient Permission') || msg.includes('insufficientPermissions')) {
        return true;
    }

    return status === 403 && !msg.toLowerCase().includes('rate limit');
}

/**
 * Determine whether a Google Drive API error is transient and safe to retry.
 */
export function isRetryableDriveError(error: any): boolean {
    if (!error) return false;
    const status = getHttpStatus(error);
    const reason = getGoogleErrorReason(error);
    const code = error.code;
    const msg = typeof error.message === 'string' ? error.message : '';

    if (
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EPIPE' ||
        code === 'ENOTFOUND' ||
        code === 'EAI_AGAIN' ||
        code === 'ECONNREFUSED' ||
        code === 'ECONNABORTED' ||
        (typeof code === 'string' && code.includes('SSL'))
    ) {
        return true;
    }

    if (
        msg.includes('SSLV3_ALERT_BAD_RECORD_MAC') ||
        msg.includes('socket hang up') ||
        msg.includes('network timeout') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNRESET')
    ) {
        return true;
    }

    if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) {
        return true;
    }

    if (status === 403) {
        if (
            reason === 'rateLimitExceeded' ||
            reason === 'userRateLimitExceeded' ||
            reason === 'sharingRateLimitExceeded' ||
            reason === 'backendError' ||
            msg.toLowerCase().includes('rate limit')
        ) {
            return true;
        }
    }

    return false;
}

function getRetryAfterMs(error: any): number | null {
    const rawHeader = error?.response?.headers?.['retry-after'] ?? error?.response?.headers?.['Retry-After'];
    if (!rawHeader) return null;
    const seconds = Number(rawHeader);
    if (!Number.isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(String(rawHeader));
    if (!Number.isNaN(dateMs)) {
        const delta = dateMs - Date.now();
        if (delta > 0) {
            return Math.min(delta, MAX_RETRY_DELAY_MS);
        }
    }
    return null;
}

function splitRelativePath(relativePath: string): string[] {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(p => p === '.' || p === '..')) {
        throw new Error(`Invalid relative path: "${relativePath}"`);
    }
    return parts;
}

/**
 * Service for interacting with Google Drive API
 */
export class GoogleDriveService implements StorageService, vscode.Disposable {
    private _drive: drive_v3.Drive | null = null;
    private lastAuthClient: any = null;
    private authProvider: GoogleAuthProvider;
    private sessionSubscription: vscode.Disposable | null = null;

    private syncFolderId: string | null = null;
    private machinesFolderId: string | null = null;
    private conversationsFolderId: string | null = null;

    private folderCache = new Map<string, string>();
    private ensureFoldersPromise: Promise<{ syncFolderId: string; machinesFolderId: string; conversationsFolderId: string }> | null = null;
    private inFlightFolderOps = new Map<string, Promise<string>>();
    private activeLockTokens = new Map<string, string>();

    constructor(authProvider: GoogleAuthProvider) {
        this.authProvider = authProvider;
        this.sessionSubscription = this.authProvider.onDidChangeSessions(() => {
            console.log('GoogleDriveService: Session changed, resetting cache');
            this.resetCache();
            this._drive = null; // Force client re-creation to pick up new tokens
            this.lastAuthClient = null;
        });
    }

    dispose(): void {
        if (this.sessionSubscription) {
            this.sessionSubscription.dispose();
            this.sessionSubscription = null;
        }
        this.resetCache();
        this.activeLockTokens.clear();
        this._drive = null;
        this.lastAuthClient = null;
    }

    private resetCache(): void {
        this.syncFolderId = null;
        this.machinesFolderId = null;
        this.conversationsFolderId = null;
        this.folderCache.clear();
        this.ensureFoldersPromise = null;
        this.inFlightFolderOps.clear();
    }

    private get drive(): drive_v3.Drive {
        const currentClient = this.authProvider.getOAuth2Client();
        if (!this._drive || this.lastAuthClient !== currentClient) {
            console.log('GoogleDriveService: Re-initializing drive client with new credentials');
            this.resetCache();
            this._drive = google.drive({
                version: 'v3',
                auth: currentClient
            });
            this.lastAuthClient = currentClient;
        }
        return this._drive!;
    }

    private async listAllFiles(
        q: string,
        fields: string,
        orderBy?: string,
        description: string = 'List Drive files'
    ): Promise<drive_v3.Schema$File[]> {
        const allFiles: drive_v3.Schema$File[] = [];
        let pageToken: string | undefined = undefined;
        const fieldsWithPaging = fields.includes('nextPageToken') ? fields : `nextPageToken, ${fields}`;

        do {
            const currentToken: string | undefined = pageToken;
            const response: { data: drive_v3.Schema$FileList } = await this.withRetry(
                (): Promise<{ data: drive_v3.Schema$FileList }> => this.drive.files.list({
                    q,
                    fields: fieldsWithPaging,
                    spaces: 'drive',
                    pageSize: 1000,
                    pageToken: currentToken,
                    ...(orderBy ? { orderBy } : {})
                }),
                description
            );

            if (response.data.files && response.data.files.length > 0) {
                allFiles.push(...response.data.files);
            }
            pageToken = response.data.nextPageToken || undefined;
        } while (pageToken);

        return allFiles;
    }

    async ensureSyncFolders(): Promise<{ syncFolderId: string; machinesFolderId: string; conversationsFolderId: string }> {
        if (this.syncFolderId && this.machinesFolderId && this.conversationsFolderId) {
            return {
                syncFolderId: this.syncFolderId,
                machinesFolderId: this.machinesFolderId,
                conversationsFolderId: this.conversationsFolderId
            };
        }

        if (this.ensureFoldersPromise) {
            return this.ensureFoldersPromise;
        }

        const promise = (async () => {
            const syncId = await this.findOrCreateFolder(SYNC_FOLDER_NAME, 'root');
            const [machinesId, conversationsId] = await Promise.all([
                this.findOrCreateFolder(MACHINES_FOLDER_NAME, syncId),
                this.findOrCreateFolder(CONVERSATIONS_FOLDER_NAME, syncId)
            ]);

            this.syncFolderId = syncId;
            this.machinesFolderId = machinesId;
            this.conversationsFolderId = conversationsId;

            return {
                syncFolderId: syncId,
                machinesFolderId: machinesId,
                conversationsFolderId: conversationsId
            };
        })();

        this.ensureFoldersPromise = promise;
        try {
            return await promise;
        } finally {
            if (this.ensureFoldersPromise === promise) {
                this.ensureFoldersPromise = null;
            }
        }
    }

    /**
     * Read-only folder lookup (does not create missing folders).
     */
    private async findFolder(name: string, parentId: string): Promise<string | null> {
        const cacheKey = `${parentId}/${name}`;
        const cached = this.folderCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const escapedName = escapeDriveQuery(name);
        const escapedParent = escapeDriveQuery(parentId);
        const query = `name = '${escapedName}' and mimeType = '${DRIVE_FOLDER_MIME}' and '${escapedParent}' in parents and trashed = false`;

        try {
            const files = await this.listAllFiles(query, 'files(id, name)', 'createdTime asc', `Find folder ${name}`);
            if (files.length > 0 && files[0].id) {
                this.folderCache.set(cacheKey, files[0].id);
                return files[0].id;
            }
            return null;
        } catch (error: any) {
            if (getHttpStatus(error) === 404) {
                this.resetCache();
                return null;
            }
            if (isInsufficientPermissionError(error)) {
                throw new Error(LocalizationManager.getInstance().t('Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.'));
            }
            throw error;
        }
    }

    /**
     * Find or create a folder in Google Drive (with in-flight deduplication and caching).
     */
    private async findOrCreateFolder(name: string, parentId: string): Promise<string> {
        const cacheKey = `${parentId}/${name}`;
        const cached = this.folderCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const existingOp = this.inFlightFolderOps.get(cacheKey);
        if (existingOp) {
            return existingOp;
        }

        const op = (async () => {
            const escapedName = escapeDriveQuery(name);
            const escapedParent = escapeDriveQuery(parentId);
            const query = `name = '${escapedName}' and mimeType = '${DRIVE_FOLDER_MIME}' and '${escapedParent}' in parents and trashed = false`;

            try {
                const files = await this.listAllFiles(query, 'files(id, name)', 'createdTime asc', `Find folder ${name}`);
                if (files.length > 0 && files[0].id) {
                    console.log(`Found existing folder '${name}': ${files[0].id}`);
                    this.folderCache.set(cacheKey, files[0].id);
                    return files[0].id;
                }
            } catch (error: any) {
                console.error(`Error finding folder '${name}':`, error);
                if (getHttpStatus(error) === 404) {
                    this.resetCache();
                }
                if (isInsufficientPermissionError(error)) {
                    throw new Error(LocalizationManager.getInstance().t('Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.'));
                }
                throw error;
            }

            // Create new folder
            try {
                const folderMetadata: drive_v3.Schema$File = {
                    name: name,
                    mimeType: DRIVE_FOLDER_MIME,
                    parents: [parentId]
                };

                const folder = await this.withRetry(() => this.drive.files.create({
                    requestBody: folderMetadata,
                    fields: 'id'
                }), `Create folder ${name}`);

                const createdId = folder.data.id!;
                this.folderCache.set(cacheKey, createdId);
                return createdId;
            } catch (error: any) {
                if (getHttpStatus(error) === 404) {
                    this.resetCache();
                }
                if (isInsufficientPermissionError(error)) {
                    throw new Error(LocalizationManager.getInstance().t('Permission denied creating folder. Please re-authenticate.'));
                }
                throw error;
            }
        })();

        this.inFlightFolderOps.set(cacheKey, op);
        try {
            return await op;
        } finally {
            if (this.inFlightFolderOps.get(cacheKey) === op) {
                this.inFlightFolderOps.delete(cacheKey);
            }
        }
    }

    /**
     * Get the sync manifest from Google Drive (Encrypted)
     */
    async getManifest(): Promise<Buffer | null> {
        const { syncFolderId } = await this.ensureSyncFolders();

        const query = `name = 'manifest.json.enc' and '${escapeDriveQuery(syncFolderId)}' in parents and trashed = false`;
        const files = await this.listAllFiles(query, 'files(id, name, modifiedTime)', 'modifiedTime desc', 'Get manifest');

        if (files.length === 0 || !files[0].id) {
            return null;
        }

        return this.downloadFile(files[0].id);
    }

    /**
     * Upload or update the sync manifest
     */
    async updateManifest(encryptedManifest: Buffer): Promise<void> {
        const { syncFolderId } = await this.ensureSyncFolders();

        await this.uploadOrUpdateFile(
            'manifest.json.enc',
            encryptedManifest,
            syncFolderId,
            'application/octet-stream'
        );
    }

    /**
     * Get machine state from Google Drive
     */
    async getMachineState(machineId: string): Promise<Buffer | null> {
        const { machinesFolderId } = await this.ensureSyncFolders();

        const fileName = `${machineId}.json.enc`;
        const query = `name = '${escapeDriveQuery(fileName)}' and '${escapeDriveQuery(machinesFolderId)}' in parents and trashed = false`;

        const files = await this.listAllFiles(query, 'files(id, modifiedTime)', 'modifiedTime desc', `Get machine state ${machineId}`);

        if (files.length === 0 || !files[0].id) {
            return null;
        }

        return this.downloadFile(files[0].id);
    }

    /**
     * Update machine state in Google Drive
     */
    async updateMachineState(machineId: string, encryptedState: Buffer): Promise<void> {
        const { machinesFolderId } = await this.ensureSyncFolders();

        await this.uploadOrUpdateFile(
            `${machineId}.json.enc`,
            encryptedState,
            machinesFolderId,
            'application/octet-stream'
        );
    }

    /**
     * List all machine state files
     */
    async listMachineStates(): Promise<DriveFile[]> {
        const { machinesFolderId } = await this.ensureSyncFolders();

        const query = `'${escapeDriveQuery(machinesFolderId)}' in parents and trashed = false`;
        const files = await this.listAllFiles(query, 'files(id, name, modifiedTime)', undefined, 'List machine states');

        return files.map((f) => ({
            id: f.id!,
            name: f.name!,
            mimeType: 'application/json',
            modifiedTime: f.modifiedTime || ''
        }));
    }

    /**
     * Upload a conversation archive to Google Drive
     */
    async uploadConversation(conversationId: string, encryptedData: Buffer): Promise<string> {
        const { conversationsFolderId } = await this.ensureSyncFolders();

        const fileName = `${conversationId}.zip.enc`;
        return this.uploadOrUpdateFile(
            fileName,
            encryptedData,
            conversationsFolderId,
            'application/octet-stream'
        );
    }

    /**
     * Download a conversation archive from Google Drive
     */
    async downloadConversation(conversationId: string): Promise<Buffer | null> {
        const { conversationsFolderId } = await this.ensureSyncFolders();

        const fileName = `${conversationId}.zip.enc`;
        const query = `name = '${escapeDriveQuery(fileName)}' and '${escapeDriveQuery(conversationsFolderId)}' in parents and trashed = false`;

        const files = await this.listAllFiles(query, 'files(id, modifiedTime)', 'modifiedTime desc', `Find conversation archive ${conversationId}`);

        if (files.length === 0 || !files[0].id) {
            return null;
        }

        return this.downloadFile(files[0].id);
    }

    /**
     * Delete a conversation from Google Drive (supports both legacy .zip.enc files and v2 conversation folders)
     */
    async deleteConversation(conversationId: string): Promise<void> {
        const { conversationsFolderId } = await this.ensureSyncFolders();

        const escapedId = escapeDriveQuery(conversationId);
        const escapedZipName = escapeDriveQuery(`${conversationId}.zip.enc`);
        const escapedParent = escapeDriveQuery(conversationsFolderId);

        const query = `(name = '${escapedZipName}' or (name = '${escapedId}' and mimeType = '${DRIVE_FOLDER_MIME}')) and '${escapedParent}' in parents and trashed = false`;
        const files = await this.listAllFiles(query, 'files(id, name, mimeType)', undefined, `Find conversation to delete ${conversationId}`);

        for (const f of files) {
            if (!f.id) continue;
            try {
                await this.withRetry(() => this.drive.files.delete({ fileId: f.id! }), `Delete conversation item ${f.name}`);
            } catch (err: any) {
                if (getHttpStatus(err) !== 404) {
                    throw err;
                }
            }
        }

        // Invalidate cached folder IDs under this conversation
        const convCacheKey = `${conversationsFolderId}/${conversationId}`;
        const cachedConvFolderId = this.folderCache.get(convCacheKey);
        this.folderCache.delete(convCacheKey);
        if (cachedConvFolderId) {
            for (const key of Array.from(this.folderCache.keys())) {
                if (key.startsWith(`${cachedConvFolderId}/`)) {
                    this.folderCache.delete(key);
                }
            }
        }
    }

    /**
     * List all conversation files and folders in Google Drive
     */
    async listConversations(): Promise<DriveFile[]> {
        const { conversationsFolderId } = await this.ensureSyncFolders();

        const query = `'${escapeDriveQuery(conversationsFolderId)}' in parents and trashed = false`;
        const files = await this.listAllFiles(query, 'files(id, name, mimeType, modifiedTime, size)', undefined, 'List conversations');

        return files.map((f) => ({
            id: f.id!,
            name: f.name!,
            mimeType: f.mimeType!,
            modifiedTime: f.modifiedTime || '',
            size: f.size || undefined
        }));
    }

    // =====================================================
    // Per-File Sync Methods (New Format)
    // =====================================================

    /**
     * Get or create a folder for a conversation
     */
    async getOrCreateConversationFolder(conversationId: string): Promise<string> {
        const { conversationsFolderId } = await this.ensureSyncFolders();
        return this.findOrCreateFolder(conversationId, conversationsFolderId);
    }

    /**
     * Upload a single file to the conversation folder
     */
    async uploadConversationFile(
        conversationId: string,
        relativePath: string,
        encryptedData: Buffer,
        originalMd5?: string
    ): Promise<string> {
        const convFolderId = await this.getOrCreateConversationFolder(conversationId);

        const parts = splitRelativePath(relativePath);
        let parentId = convFolderId;

        for (let i = 0; i < parts.length - 1; i++) {
            parentId = await this.findOrCreateFolder(parts[i], parentId);
        }

        const fileName = parts[parts.length - 1] + '.enc';
        const appProperties = originalMd5 ? { originalMd5 } : undefined;

        return this.uploadOrUpdateFile(
            fileName,
            encryptedData,
            parentId,
            'application/octet-stream',
            appProperties
        );
    }

    /**
     * Download a single file from the conversation folder (read-only lookup, never creates folders)
     */
    async downloadConversationFile(
        conversationId: string,
        relativePath: string
    ): Promise<Buffer | null> {
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const convFolderId = await this.findFolder(conversationId, conversationsFolderId);
        if (!convFolderId) {
            return null;
        }

        const parts = splitRelativePath(relativePath);
        let parentId = convFolderId;

        for (let i = 0; i < parts.length - 1; i++) {
            const subFolderId = await this.findFolder(parts[i], parentId);
            if (!subFolderId) {
                return null;
            }
            parentId = subFolderId;
        }

        const fileName = parts[parts.length - 1] + '.enc';
        const query = `name = '${escapeDriveQuery(fileName)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`;
        const files = await this.listAllFiles(query, 'files(id, modifiedTime)', 'modifiedTime desc', `Find conversation file ${fileName}`);

        if (files.length === 0 || !files[0].id) {
            return null;
        }

        return this.downloadFile(files[0].id);
    }

    /**
     * Delete a single file (and any duplicates) from the conversation folder (read-only folder lookup)
     */
    async deleteConversationFile(
        conversationId: string,
        relativePath: string
    ): Promise<void> {
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const convFolderId = await this.findFolder(conversationId, conversationsFolderId);
        if (!convFolderId) {
            return;
        }

        const parts = splitRelativePath(relativePath);
        let parentId = convFolderId;

        for (let i = 0; i < parts.length - 1; i++) {
            const subFolderId = await this.findFolder(parts[i], parentId);
            if (!subFolderId) {
                return;
            }
            parentId = subFolderId;
        }

        const fileName = parts[parts.length - 1] + '.enc';
        const query = `name = '${escapeDriveQuery(fileName)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`;
        const files = await this.listAllFiles(query, 'files(id)', undefined, `Find file to delete ${fileName}`);

        for (const f of files) {
            if (!f.id) continue;
            try {
                await this.withRetry(() => this.drive.files.delete({ fileId: f.id! }), `Delete file ${fileName}`);
            } catch (err: any) {
                if (getHttpStatus(err) !== 404) {
                    throw err;
                }
            }
        }
    }

    /**
     * List all files in a conversation folder (recursively) with details
     */
    async listConversationFilesDetails(conversationId: string): Promise<Map<string, { id: string; md5: string; originalMd5?: string }>> {
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const convFolderId = await this.findFolder(conversationId, conversationsFolderId);
        if (!convFolderId) {
            return new Map();
        }

        return this.listFilesRecursiveDetails(convFolderId, '');
    }

    private async listFilesRecursiveDetails(folderId: string, prefix: string): Promise<Map<string, { id: string; md5: string; originalMd5?: string }>> {
        const files = new Map<string, { id: string; md5: string; originalMd5?: string }>();
        const query = `'${escapeDriveQuery(folderId)}' in parents and trashed = false`;
        const entries = await this.listAllFiles(
            query,
            'files(id, name, mimeType, md5Checksum, appProperties, modifiedTime)',
            'modifiedTime asc',
            `List files in folder ${prefix || folderId}`
        );

        for (const file of entries) {
            if (!file.id || !file.name) continue;
            const entryPath = prefix ? `${prefix}/${file.name}` : file.name;

            if (file.mimeType === DRIVE_FOLDER_MIME) {
                const subFiles = await this.listFilesRecursiveDetails(file.id, entryPath);
                subFiles.forEach((val, key) => files.set(key, val));
            } else {
                // Remove .enc extension for the relative path; later (newer) entries overwrite duplicates
                const relativePath = entryPath.replace(/\.enc$/, '');
                files.set(relativePath, {
                    id: file.id,
                    md5: file.md5Checksum || '',
                    originalMd5: file.appProperties?.originalMd5
                });
            }
        }

        return files;
    }

    /**
     * List all files in a conversation folder (recursively)
     * @deprecated Use listConversationFilesDetails instead
     */
    async listConversationFiles(conversationId: string): Promise<string[]> {
        const details = await this.listConversationFilesDetails(conversationId);
        return Array.from(details.keys());
    }

    /**
     * Download a file from Google Drive
     */
    async downloadFile(fileId: string): Promise<Buffer> {
        return this.withRetry(async () => {
            const response = await this.drive.files.get({
                fileId: fileId,
                alt: 'media'
            }, {
                responseType: 'arraybuffer'
            });

            return Buffer.from(response.data as ArrayBuffer);
        }, `Download file ${fileId}`);
    }

    /**
     * Helper to retry operations on transient network/SSL/rate-limit/5xx errors
     */
    private async withRetry<T>(operation: (attempt: number) => Promise<T>, description: string, retries = 4): Promise<T> {
        let lastError: any;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await operation(attempt);
            } catch (error: any) {
                lastError = error;

                if (!isRetryableDriveError(error) || attempt === retries) {
                    throw error;
                }

                const retryAfterMs = getRetryAfterMs(error);
                const exponentialDelay = Math.min(Math.pow(2, attempt - 1) * 1000, MAX_RETRY_DELAY_MS);
                const delay = (retryAfterMs ?? exponentialDelay) + Math.floor(Math.random() * 500);

                const lm = LocalizationManager.getInstance();
                console.warn(lm.t('[GoogleDrive] Retry {0}/{1} for "{2}" due to error: {3}. Waiting {4}ms',
                    attempt, retries, description, error.message, delay.toFixed(0)));
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }

    private async uploadOrUpdateFile(
        name: string,
        data: Buffer,
        parentId: string,
        mimeType: string,
        appProperties?: { [key: string]: string }
    ): Promise<string> {
        const lm = LocalizationManager.getInstance();
        const query = `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(parentId)}' in parents and trashed = false`;

        const existingFiles = await this.listAllFiles(query, 'files(id, modifiedTime)', 'modifiedTime desc', lm.t('Check existence of {0}', name));

        if (existingFiles.length > 0 && existingFiles[0].id) {
            const fileId = existingFiles[0].id;
            const requestBody: drive_v3.Schema$File | undefined = appProperties ? { appProperties } : undefined;

            await this.withRetry(() => this.drive.files.update({
                fileId: fileId,
                requestBody,
                media: {
                    mimeType: mimeType,
                    body: bufferToStream(data)
                }
            }), lm.t('Update file {0}', name));

            return fileId;
        }

        // Create new file (with duplicate check on retry attempts)
        const requestBody: drive_v3.Schema$File = {
            name: name,
            parents: [parentId],
            ...(appProperties ? { appProperties } : {})
        };

        return this.withRetry(async (attempt) => {
            if (attempt > 1) {
                const retryExisting = await this.listAllFiles(query, 'files(id, modifiedTime)', 'modifiedTime desc', lm.t('Check existence of {0}', name));
                if (retryExisting.length > 0 && retryExisting[0].id) {
                    const existingId = retryExisting[0].id;
                    await this.drive.files.update({
                        fileId: existingId,
                        requestBody: appProperties ? { appProperties } : undefined,
                        media: {
                            mimeType: mimeType,
                            body: bufferToStream(data)
                        }
                    });
                    return existingId;
                }
            }

            const response = await this.drive.files.create({
                requestBody: requestBody,
                media: {
                    mimeType: mimeType,
                    body: bufferToStream(data)
                },
                fields: 'id'
            });

            return response.data.id!;
        }, lm.t('Create file {0}', name));
    }

    /**
     * Check if sync folder exists (to detect if sync was already set up)
     */
    async checkSyncFolderExists(): Promise<boolean> {
        const folderId = await this.findFolder(SYNC_FOLDER_NAME, 'root');
        return folderId !== null;
    }

    /**
     * Get storage quota info
     */
    async getStorageInfo(): Promise<{ used: number; limit: number } | null> {
        try {
            const response = await this.withRetry(() => this.drive.about.get({
                fields: 'storageQuota'
            }), 'Get storage info');

            const quota = response.data.storageQuota;
            if (quota) {
                return {
                    used: parseInt(quota.usage || '0', 10),
                    limit: parseInt(quota.limit || '0', 10)
                };
            }
            return null;
        } catch (error: any) {
            const lm = LocalizationManager.getInstance();
            console.error(lm.t('Failed to get storage info: {0}', error));
            return null;
        }
    }

    /**
     * Get user info from Drive API
     */
    async getUserInfo(): Promise<{ email: string; name: string } | null> {
        try {
            const response = await this.withRetry(() => this.drive.about.get({
                fields: 'user'
            }), 'Get user info');
            const user = response.data.user;
            if (user) {
                return {
                    email: user.emailAddress || '',
                    name: user.displayName || user.emailAddress || ''
                };
            }
            return null;
        } catch (error: any) {
            const lm = LocalizationManager.getInstance();
            console.error(lm.t('Failed to get user info: {0}', error));
            return null;
        }
    }

    /**
     * Try to acquire the sync lock (best-effort distributed lock with post-create verification)
     */
    async acquireLock(machineId: string, ttlMs: number = DEFAULT_LOCK_TTL_MS): Promise<boolean> {
        const { syncFolderId } = await this.ensureSyncFolders();

        const lockFileName = 'sync.lock';
        const query = `name = '${lockFileName}' and '${escapeDriveQuery(syncFolderId)}' in parents and trashed = false`;

        try {
            const existingLocks = await this.listAllFiles(query, 'files(id, createdTime)', 'createdTime asc', 'Check sync lock');

            for (const lockFile of existingLocks) {
                if (!lockFile.id) continue;
                let content: Buffer;
                try {
                    content = await this.downloadFile(lockFile.id);
                } catch (downloadErr: any) {
                    if (getHttpStatus(downloadErr) === 404) {
                        continue; // Already removed by another machine
                    }
                    // Network/API error reading an existing lock -> fail-closed, never delete someone else's lock!
                    console.warn('[GoogleDrive] Failed to read existing lock file, aborting lock acquisition:', downloadErr?.message);
                    return false;
                }

                let lockData: LockFile;
                try {
                    lockData = JSON.parse(content.toString('utf8')) as LockFile;
                } catch (parseErr) {
                    if (parseErr instanceof SyntaxError) {
                        // Corrupt JSON lock file — safe to clean up
                        try {
                            await this.drive.files.delete({ fileId: lockFile.id });
                        } catch { /* ignore */ }
                        continue;
                    }
                    return false;
                }

                if (
                    typeof lockData?.expiresAt === 'number' &&
                    Date.now() < lockData.expiresAt &&
                    lockData.machineId !== machineId
                ) {
                    return false; // Active lock held by another machine
                }

                // Expired or owned by us - clean up
                try {
                    await this.drive.files.delete({ fileId: lockFile.id });
                } catch (delErr: any) {
                    if (getHttpStatus(delErr) !== 404) {
                        console.warn('[GoogleDrive] Failed to delete stale lock:', delErr?.message);
                    }
                }
            }

            // Create our lock with unique token
            const token = crypto.randomBytes(16).toString('hex');
            const lockData: LockFile = {
                machineId,
                token,
                expiresAt: Date.now() + ttlMs
            };

            const created = await this.withRetry(() => this.drive.files.create({
                requestBody: {
                    name: lockFileName,
                    parents: [syncFolderId]
                },
                media: {
                    mimeType: 'application/json',
                    body: bufferToStream(Buffer.from(JSON.stringify(lockData)))
                },
                fields: 'id'
            }), 'Create sync lock');

            const createdId = created.data.id!;

            // Post-create verification: re-list locks ordered by createdTime asc to detect concurrent acquisitions
            const allLocksAfter = await this.listAllFiles(query, 'files(id, createdTime)', 'createdTime asc', 'Verify sync lock');
            const ourIndex = allLocksAfter.findIndex(f => f.id === createdId);

            if (ourIndex === -1) {
                return false;
            }

            if (ourIndex > 0) {
                // Another lock was created before ours — verify if any earlier lock is active and foreign
                for (let i = 0; i < ourIndex; i++) {
                    const earlierId = allLocksAfter[i].id;
                    if (!earlierId) continue;
                    try {
                        const earlierBuf = await this.downloadFile(earlierId);
                        const earlierLock = JSON.parse(earlierBuf.toString('utf8')) as LockFile;
                        if (
                            typeof earlierLock?.expiresAt === 'number' &&
                            Date.now() < earlierLock.expiresAt &&
                            earlierLock.machineId !== machineId
                        ) {
                            // Lost the race — delete our own lock and back off
                            try { await this.drive.files.delete({ fileId: createdId }); } catch { /* ignore */ }
                            return false;
                        }
                    } catch (err: any) {
                        if (getHttpStatus(err) === 404) {
                            continue;
                        }
                        if (!(err instanceof SyntaxError)) {
                            // Fail-closed on network error
                            try { await this.drive.files.delete({ fileId: createdId }); } catch { /* ignore */ }
                            return false;
                        }
                    }
                }
            }

            this.activeLockTokens.set(machineId, token);
            return true;
        } catch (e: any) {
            const lm = LocalizationManager.getInstance();
            console.error(lm.t('Failed to acquire lock: {0}', e.message));
            return false;
        }
    }

    /**
     * Release the sync lock (deletes only locks owned by this machine/token)
     */
    async releaseLock(machineId: string): Promise<void> {
        const folderId = this.syncFolderId ?? await this.findFolder(SYNC_FOLDER_NAME, 'root');
        const expectedToken = this.activeLockTokens.get(machineId);
        this.activeLockTokens.delete(machineId);

        if (!folderId) return;

        const lockFileName = 'sync.lock';
        const query = `name = '${lockFileName}' and '${escapeDriveQuery(folderId)}' in parents and trashed = false`;

        try {
            const locks = await this.listAllFiles(query, 'files(id)', undefined, 'List sync locks to release');

            for (const lockFile of locks) {
                if (!lockFile.id) continue;
                try {
                    const content = await this.downloadFile(lockFile.id);
                    const lockData = JSON.parse(content.toString('utf8')) as LockFile;

                    const isOurLock =
                        lockData.machineId === machineId &&
                        (!expectedToken || !lockData.token || lockData.token === expectedToken);

                    if (isOurLock) {
                        await this.withRetry(() => this.drive.files.delete({ fileId: lockFile.id! }), 'Release sync lock');
                    }
                } catch {
                    // Never delete unreadable or foreign lock files
                }
            }
        } catch (e: any) {
            const lm = LocalizationManager.getInstance();
            console.error(lm.t('Failed to release lock: {0}', e.message));
        }
    }

    /**
     * Delete any file by ID
     */
    async deleteFile(fileId: string): Promise<void> {
        try {
            await this.withRetry(() => this.drive.files.delete({
                fileId: fileId
            }), `Delete file ${fileId}`);
        } catch (err: any) {
            if (getHttpStatus(err) !== 404) {
                throw err;
            }
        }
    }
}

/**
 * Convert a Buffer to a readable stream
 */
function bufferToStream(buffer: Buffer): NodeJS.ReadableStream {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}
