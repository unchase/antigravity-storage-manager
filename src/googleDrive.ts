import { google, drive_v3 } from 'googleapis';
import { GoogleAuthProvider } from './googleAuth';

const SYNC_FOLDER_NAME = 'AntigravitySync';
const MACHINES_FOLDER_NAME = 'machines';
const CONVERSATIONS_FOLDER_NAME = 'conversations';

export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    size?: string;
}

export interface SyncManifest {
    version: number;
    createdAt: string;
    lastModified: string;
    passwordVerificationSalt: string; // Base64 encoded salt for password verification
    passwordVerificationHash: string; // Hash to verify correct password
    conversations: SyncedConversation[];
}

export interface SyncedConversation {
    id: string;
    title: string;
    lastModified: string;
    hash: string;
    modifiedBy: string; // machine ID
    fileId?: string; // Google Drive file ID
}

export interface MachineState {
    machineId: string;
    machineName: string;
    lastSync: string;
    conversationStates: {
        id: string;
        localHash: string;
        lastSynced: string;
    }[];
}

export interface LockFile {
    machineId: string;
    expiresAt: number;
}

/**
 * Service for interacting with Google Drive API
 */
export class GoogleDriveService {
    private drive: drive_v3.Drive;
    private authProvider: GoogleAuthProvider;
    private syncFolderId: string | null = null;
    private machinesFolderId: string | null = null;
    private conversationsFolderId: string | null = null;

    constructor(authProvider: GoogleAuthProvider) {
        this.authProvider = authProvider;
        this.drive = google.drive({
            version: 'v3',
            auth: authProvider.getOAuth2Client()
        });
    }

    /**
     * Ensure the sync folder structure exists in Google Drive
     * Creates folders if they don't exist
     */
    async ensureSyncFolders(): Promise<{ syncFolderId: string; machinesFolderId: string; conversationsFolderId: string }> {
        // Find or create main sync folder
        this.syncFolderId = await this.findOrCreateFolder(SYNC_FOLDER_NAME, 'root');

        // Find or create subfolders
        this.machinesFolderId = await this.findOrCreateFolder(MACHINES_FOLDER_NAME, this.syncFolderId);
        this.conversationsFolderId = await this.findOrCreateFolder(CONVERSATIONS_FOLDER_NAME, this.syncFolderId);

        return {
            syncFolderId: this.syncFolderId,
            machinesFolderId: this.machinesFolderId,
            conversationsFolderId: this.conversationsFolderId
        };
    }

    /**
     * Find or create a folder in Google Drive
     */
    private async findOrCreateFolder(name: string, parentId: string): Promise<string> {
        // Search for existing folder
        const query = parentId === 'root'
            ? `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`
            : `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;

        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (response.data.files && response.data.files.length > 0) {
            return response.data.files[0].id!;
        }

        // Create new folder
        const folderMetadata: drive_v3.Schema$File = {
            name: name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId]
        };

        const folder = await this.drive.files.create({
            requestBody: folderMetadata,
            fields: 'id'
        });

        return folder.data.id!;
    }

    /**
     * Get the sync manifest from Google Drive (Encrypted)
     */
    async getManifest(): Promise<Buffer | null> {
        if (!this.syncFolderId) {
            await this.ensureSyncFolders();
        }

        const query = `name = 'manifest.json.enc' and '${this.syncFolderId}' in parents and trashed = false`;
        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (!response.data.files || response.data.files.length === 0) {
            return null;
        }

        const fileId = response.data.files[0].id!;
        return this.downloadFile(fileId);
    }

    /**
     * Upload or update the sync manifest
     */
    async updateManifest(encryptedManifest: Buffer): Promise<void> {
        if (!this.syncFolderId) {
            await this.ensureSyncFolders();
        }

        await this.uploadOrUpdateFile(
            'manifest.json.enc',
            encryptedManifest,
            this.syncFolderId!,
            'application/octet-stream'
        );
    }

    /**
     * Get machine state from Google Drive
     */
    async getMachineState(machineId: string): Promise<Buffer | null> {
        if (!this.machinesFolderId) {
            await this.ensureSyncFolders();
        }

        const fileName = `${machineId}.json.enc`;
        const query = `name = '${fileName}' and '${this.machinesFolderId}' in parents and trashed = false`;

        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id)',
            spaces: 'drive'
        });

        if (!response.data.files || response.data.files.length === 0) {
            return null;
        }

        return this.downloadFile(response.data.files[0].id!);
    }

    /**
     * Update machine state in Google Drive
     */
    async updateMachineState(machineId: string, encryptedState: Buffer): Promise<void> {
        if (!this.machinesFolderId) {
            await this.ensureSyncFolders();
        }

        await this.uploadOrUpdateFile(
            `${machineId}.json.enc`,
            encryptedState,
            this.machinesFolderId!,
            'application/octet-stream'
        );
    }

    /**
     * Upload a conversation archive to Google Drive
     */
    async uploadConversation(conversationId: string, encryptedData: Buffer): Promise<string> {
        if (!this.conversationsFolderId) {
            await this.ensureSyncFolders();
        }

        const fileName = `${conversationId}.zip.enc`;
        return this.uploadOrUpdateFile(
            fileName,
            encryptedData,
            this.conversationsFolderId!,
            'application/octet-stream'
        );
    }

    /**
     * Download a conversation archive from Google Drive
     */
    async downloadConversation(conversationId: string): Promise<Buffer | null> {
        if (!this.conversationsFolderId) {
            await this.ensureSyncFolders();
        }

        const fileName = `${conversationId}.zip.enc`;
        const query = `name = '${fileName}' and '${this.conversationsFolderId}' in parents and trashed = false`;

        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id)',
            spaces: 'drive'
        });

        if (!response.data.files || response.data.files.length === 0) {
            return null;
        }

        return this.downloadFile(response.data.files[0].id!);
    }

    /**
     * Delete a conversation from Google Drive
     */
    async deleteConversation(conversationId: string): Promise<void> {
        if (!this.conversationsFolderId) {
            await this.ensureSyncFolders();
        }

        const fileName = `${conversationId}.zip.enc`;
        const query = `name = '${fileName}' and '${this.conversationsFolderId}' in parents and trashed = false`;

        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id)',
            spaces: 'drive'
        });

        if (response.data.files && response.data.files.length > 0) {
            await this.drive.files.delete({
                fileId: response.data.files[0].id!
            });
        }
    }

    /**
     * List all conversation files in Google Drive
     */
    async listConversations(): Promise<DriveFile[]> {
        if (!this.conversationsFolderId) {
            await this.ensureSyncFolders();
        }

        const query = `'${this.conversationsFolderId}' in parents and trashed = false`;
        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id, name, mimeType, modifiedTime, size)',
            spaces: 'drive'
        });

        return (response.data.files || []).map((f: any) => ({
            id: f.id!,
            name: f.name!,
            mimeType: f.mimeType!,
            modifiedTime: f.modifiedTime!,
            size: f.size || undefined
        }));
    }

    /**
     * Download a file from Google Drive
     */
    async downloadFile(fileId: string): Promise<Buffer> {
        const response = await this.drive.files.get({
            fileId: fileId,
            alt: 'media'
        }, {
            responseType: 'arraybuffer'
        });

        return Buffer.from(response.data as ArrayBuffer);
    }

    /**
     * Upload or update a file in Google Drive
     */
    private async uploadOrUpdateFile(
        name: string,
        data: Buffer,
        parentId: string,
        mimeType: string
    ): Promise<string> {
        // Check if file exists
        const query = `name = '${name}' and '${parentId}' in parents and trashed = false`;
        const existing = await this.drive.files.list({
            q: query,
            fields: 'files(id)',
            spaces: 'drive'
        });

        if (existing.data.files && existing.data.files.length > 0) {
            // Update existing file
            const fileId = existing.data.files[0].id!;
            await this.drive.files.update({
                fileId: fileId,
                media: {
                    mimeType: mimeType,
                    body: bufferToStream(data)
                }
            });
            return fileId;
        } else {
            // Create new file
            const response = await this.drive.files.create({
                requestBody: {
                    name: name,
                    parents: [parentId]
                },
                media: {
                    mimeType: mimeType,
                    body: bufferToStream(data)
                },
                fields: 'id'
            });
            return response.data.id!;
        }
    }

    /**
     * Check if sync folder exists (to detect if sync was already set up)
     */
    async checkSyncFolderExists(): Promise<boolean> {
        const query = `name = '${SYNC_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`;
        const response = await this.drive.files.list({
            q: query,
            fields: 'files(id)',
            spaces: 'drive'
        });

        return !!(response.data.files && response.data.files.length > 0);
    }

    /**
     * Get storage quota info
     */
    async getStorageInfo(): Promise<{ used: number; limit: number } | null> {
        try {
            const response = await this.drive.about.get({
                fields: 'storageQuota'
            });

            const quota = response.data.storageQuota;
            if (quota) {
                return {
                    used: parseInt(quota.usage || '0'),
                    limit: parseInt(quota.limit || '0')
                };
            }
            return null;
        } catch (error) {
            console.error('Failed to get storage info:', error);
            return null;
        }
    }

    /**
     * Try to acquire the sync lock
     */
    async acquireLock(machineId: string, ttlMs: number = 60000): Promise<boolean> {
        if (!this.syncFolderId) {
            await this.ensureSyncFolders();
        }

        const lockFileName = 'sync.lock';
        const query = `name = '${lockFileName}' and '${this.syncFolderId}' in parents and trashed = false`;

        try {
            const list = await this.drive.files.list({
                q: query,
                fields: 'files(id)',
                spaces: 'drive'
            });

            if (list.data.files && list.data.files.length > 0) {
                // Lock exists check validity
                const fileId = list.data.files[0].id!;
                try {
                    const content = await this.downloadFile(fileId);
                    const lockData = JSON.parse(content.toString()) as LockFile;

                    if (Date.now() < lockData.expiresAt && lockData.machineId !== machineId) {
                        return false; // Locked by another machine
                    }

                    // Expired or owned by us - refresh/overwrite
                    await this.drive.files.delete({ fileId });
                } catch (e) {
                    // Invalid lock file or download failed - assume we can take over
                    try { await this.drive.files.delete({ fileId }); } catch { }
                }
            }

            // Create lock
            const lockData: LockFile = {
                machineId,
                expiresAt: Date.now() + ttlMs
            };

            await this.drive.files.create({
                requestBody: {
                    name: lockFileName,
                    parents: [this.syncFolderId!]
                },
                media: {
                    mimeType: 'application/json',
                    body: bufferToStream(Buffer.from(JSON.stringify(lockData)))
                }
            });

            return true;
        } catch (e) {
            console.error('Failed to acquire lock:', e);
            return false;
        }
    }

    /**
     * Release the sync lock
     */
    async releaseLock(machineId: string): Promise<void> {
        if (!this.syncFolderId) return;

        const lockFileName = 'sync.lock';
        const query = `name = '${lockFileName}' and '${this.syncFolderId}' in parents and trashed = false`;

        try {
            const list = await this.drive.files.list({
                q: query,
                fields: 'files(id)',
                spaces: 'drive'
            });

            if (list.data.files && list.data.files.length > 0) {
                const fileId = list.data.files[0].id!;
                try {
                    const content = await this.downloadFile(fileId);
                    const lockData = JSON.parse(content.toString()) as LockFile;

                    // Only delete if it's our lock
                    if (lockData.machineId === machineId) {
                        await this.drive.files.delete({ fileId });
                    }
                } catch {
                    // Force delete if corrupt? No, better safe.
                }
            }
        } catch (e) {
            console.error('Failed to release lock:', e);
        }
    }
}

/**
 * Convert a Buffer to a readable stream
 */
function bufferToStream(buffer: Buffer): NodeJS.ReadableStream {
    const { Readable } = require('stream');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    return stream;
}
