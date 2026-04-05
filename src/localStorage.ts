import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SyncManifest, SyncedConversation, Machine, MachineState, FileHashInfo, LockFile, DriveFile } from './googleDrive';
import { LocalizationManager } from './l10n/localizationManager';

/**
 * Interface for storage services used by SyncManager.
 * Both GoogleDriveService and LocalStorageService implement this interface.
 */
export interface StorageService {
    ensureSyncFolders(): Promise<{ syncFolderId: string; machinesFolderId: string; conversationsFolderId: string }>;
    getManifest(): Promise<Buffer | null>;
    updateManifest(encryptedManifest: Buffer): Promise<void>;
    getMachineState(machineId: string): Promise<Buffer | null>;
    updateMachineState(machineId: string, encryptedState: Buffer): Promise<void>;
    listMachineStates(): Promise<DriveFile[]>;
    uploadConversation(conversationId: string, encryptedData: Buffer): Promise<string>;
    downloadConversation(conversationId: string): Promise<Buffer | null>;
    deleteConversation(conversationId: string): Promise<void>;
    listConversations(): Promise<DriveFile[]>;
    uploadConversationFile(conversationId: string, relativePath: string, encryptedData: Buffer, originalMd5?: string): Promise<string>;
    downloadConversationFile(conversationId: string, relativePath: string): Promise<Buffer | null>;
    deleteConversationFile(conversationId: string, relativePath: string): Promise<void>;
    listConversationFilesDetails(conversationId: string): Promise<Map<string, { id: string; md5: string; originalMd5?: string }>>;
    listConversationFiles(conversationId: string): Promise<string[]>;
    checkSyncFolderExists(): Promise<boolean>;
    getStorageInfo(): Promise<{ used: number; limit: number } | null>;
    getUserInfo(): Promise<{ email: string; name: string } | null>;
    acquireLock(machineId: string, ttlMs?: number): Promise<boolean>;
    releaseLock(machineId: string): Promise<void>;
    deleteFile(fileId: string): Promise<void>;
}

/**
 * Local filesystem storage service for sync.
 * Stores encrypted files in a local directory, mirroring the GoogleDriveService API.
 */
export class LocalStorageService implements StorageService {
    private basePath: string;
    private syncFolderPath: string | null = null;
    private machinesFolderPath: string | null = null;
    private conversationsFolderPath: string | null = null;

    constructor(localPath: string) {
        // Expand ~ to home directory
        if (localPath.startsWith('~')) {
            localPath = path.join(os.homedir(), localPath.slice(1));
        }
        this.basePath = localPath;
    }

    async ensureSyncFolders(): Promise<{ syncFolderId: string; machinesFolderId: string; conversationsFolderId: string }> {
        if (this.syncFolderPath && this.machinesFolderPath && this.conversationsFolderPath) {
            return {
                syncFolderId: this.syncFolderPath,
                machinesFolderId: this.machinesFolderPath,
                conversationsFolderId: this.conversationsFolderPath
            };
        }

        this.syncFolderPath = path.join(this.basePath, 'AntigravitySync');
        this.machinesFolderPath = path.join(this.syncFolderPath, 'machines');
        this.conversationsFolderPath = path.join(this.syncFolderPath, 'conversations');

        await fs.promises.mkdir(this.syncFolderPath, { recursive: true });
        await fs.promises.mkdir(this.machinesFolderPath, { recursive: true });
        await fs.promises.mkdir(this.conversationsFolderPath, { recursive: true });

        return {
            syncFolderId: this.syncFolderPath,
            machinesFolderId: this.machinesFolderPath,
            conversationsFolderId: this.conversationsFolderPath
        };
    }

    async getManifest(): Promise<Buffer | null> {
        await this.ensureSyncFolders();
        const manifestPath = path.join(this.syncFolderPath!, 'manifest.json.enc');
        try {
            return await fs.promises.readFile(manifestPath);
        } catch {
            return null;
        }
    }

    async updateManifest(encryptedManifest: Buffer): Promise<void> {
        await this.ensureSyncFolders();
        const manifestPath = path.join(this.syncFolderPath!, 'manifest.json.enc');
        await fs.promises.writeFile(manifestPath, encryptedManifest);
    }

    async getMachineState(machineId: string): Promise<Buffer | null> {
        await this.ensureSyncFolders();
        const statePath = path.join(this.machinesFolderPath!, `${machineId}.json.enc`);
        try {
            return await fs.promises.readFile(statePath);
        } catch {
            return null;
        }
    }

    async updateMachineState(machineId: string, encryptedState: Buffer): Promise<void> {
        await this.ensureSyncFolders();
        const statePath = path.join(this.machinesFolderPath!, `${machineId}.json.enc`);
        await fs.promises.writeFile(statePath, encryptedState);
    }

    async listMachineStates(): Promise<DriveFile[]> {
        await this.ensureSyncFolders();
        try {
            const entries = await fs.promises.readdir(this.machinesFolderPath!);
            const results: DriveFile[] = [];
            for (const entry of entries) {
                if (entry.endsWith('.json.enc')) {
                    const fullPath = path.join(this.machinesFolderPath!, entry);
                    const stats = await fs.promises.stat(fullPath);
                    results.push({
                        id: fullPath,
                        name: entry,
                        mimeType: 'application/json',
                        modifiedTime: stats.mtime.toISOString()
                    });
                }
            }
            return results;
        } catch {
            return [];
        }
    }

    async uploadConversation(conversationId: string, encryptedData: Buffer): Promise<string> {
        await this.ensureSyncFolders();
        const filePath = path.join(this.conversationsFolderPath!, `${conversationId}.zip.enc`);
        await fs.promises.writeFile(filePath, encryptedData);
        return filePath;
    }

    async downloadConversation(conversationId: string): Promise<Buffer | null> {
        await this.ensureSyncFolders();
        const filePath = path.join(this.conversationsFolderPath!, `${conversationId}.zip.enc`);
        try {
            return await fs.promises.readFile(filePath);
        } catch {
            return null;
        }
    }

    async deleteConversation(conversationId: string): Promise<void> {
        await this.ensureSyncFolders();
        const filePath = path.join(this.conversationsFolderPath!, `${conversationId}.zip.enc`);
        try {
            await fs.promises.unlink(filePath);
        } catch {
            // Ignore if not exists
        }

        // Also delete per-file folder if exists
        const folderPath = path.join(this.conversationsFolderPath!, conversationId);
        try {
            await fs.promises.rm(folderPath, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    }

    async listConversations(): Promise<DriveFile[]> {
        await this.ensureSyncFolders();
        try {
            const entries = await fs.promises.readdir(this.conversationsFolderPath!);
            const results: DriveFile[] = [];
            for (const entry of entries) {
                const fullPath = path.join(this.conversationsFolderPath!, entry);
                const stats = await fs.promises.stat(fullPath);
                results.push({
                    id: fullPath,
                    name: entry,
                    mimeType: stats.isDirectory() ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
                    modifiedTime: stats.mtime.toISOString(),
                    size: stats.isFile() ? stats.size.toString() : undefined
                });
            }
            return results;
        } catch {
            return [];
        }
    }

    async uploadConversationFile(
        conversationId: string,
        relativePath: string,
        encryptedData: Buffer,
        originalMd5?: string
    ): Promise<string> {
        await this.ensureSyncFolders();
        const convFolder = path.join(this.conversationsFolderPath!, conversationId);

        // Create subdirectories from relativePath
        const parts = relativePath.split('/');
        const fileName = parts[parts.length - 1] + '.enc';
        const subDir = parts.slice(0, -1).join(path.sep);
        const targetDir = subDir ? path.join(convFolder, subDir) : convFolder;

        await fs.promises.mkdir(targetDir, { recursive: true });

        const filePath = path.join(targetDir, fileName);
        await fs.promises.writeFile(filePath, encryptedData);

        // Store originalMd5 as a sidecar file if provided
        if (originalMd5) {
            const metaPath = filePath + '.meta';
            await fs.promises.writeFile(metaPath, JSON.stringify({ originalMd5 }), 'utf8');
        }

        return filePath;
    }

    async downloadConversationFile(
        conversationId: string,
        relativePath: string
    ): Promise<Buffer | null> {
        await this.ensureSyncFolders();
        const convFolder = path.join(this.conversationsFolderPath!, conversationId);
        const parts = relativePath.split('/');
        const fileName = parts[parts.length - 1] + '.enc';
        const subDir = parts.slice(0, -1).join(path.sep);
        const targetDir = subDir ? path.join(convFolder, subDir) : convFolder;
        const filePath = path.join(targetDir, fileName);

        try {
            return await fs.promises.readFile(filePath);
        } catch {
            return null;
        }
    }

    async deleteConversationFile(
        conversationId: string,
        relativePath: string
    ): Promise<void> {
        await this.ensureSyncFolders();
        const convFolder = path.join(this.conversationsFolderPath!, conversationId);
        const parts = relativePath.split('/');
        const fileName = parts[parts.length - 1] + '.enc';
        const subDir = parts.slice(0, -1).join(path.sep);
        const targetDir = subDir ? path.join(convFolder, subDir) : convFolder;
        const filePath = path.join(targetDir, fileName);

        try {
            await fs.promises.unlink(filePath);
            // Also remove meta file
            try { await fs.promises.unlink(filePath + '.meta'); } catch { /* ignore */ }
        } catch {
            // Ignore if not exists
        }
    }

    async listConversationFilesDetails(conversationId: string): Promise<Map<string, { id: string; md5: string; originalMd5?: string }>> {
        await this.ensureSyncFolders();
        const convFolder = path.join(this.conversationsFolderPath!, conversationId);

        try {
            await fs.promises.access(convFolder);
        } catch {
            return new Map();
        }

        return this.listFilesRecursiveDetails(convFolder, '');
    }

    private async listFilesRecursiveDetails(
        dirPath: string,
        prefix: string
    ): Promise<Map<string, { id: string; md5: string; originalMd5?: string }>> {
        const files = new Map<string, { id: string; md5: string; originalMd5?: string }>();

        try {
            const entries = await fs.promises.readdir(dirPath);
            for (const entry of entries) {
                // Skip .meta sidecar files
                if (entry.endsWith('.meta')) continue;

                const fullPath = path.join(dirPath, entry);
                const entryPath = prefix ? `${prefix}/${entry}` : entry;
                const stats = await fs.promises.stat(fullPath);

                if (stats.isDirectory()) {
                    const subFiles = await this.listFilesRecursiveDetails(fullPath, entryPath);
                    subFiles.forEach((val, key) => files.set(key, val));
                } else {
                    // Remove .enc extension for the relative path
                    const relativePath = entryPath.replace(/\.enc$/, '');
                    const content = await fs.promises.readFile(fullPath);
                    const md5 = crypto.createHash('md5').update(content).digest('hex');

                    let originalMd5: string | undefined;
                    try {
                        const metaPath = fullPath + '.meta';
                        const metaContent = await fs.promises.readFile(metaPath, 'utf8');
                        const meta = JSON.parse(metaContent);
                        originalMd5 = meta.originalMd5;
                    } catch {
                        // No meta file
                    }

                    files.set(relativePath, {
                        id: fullPath,
                        md5,
                        originalMd5
                    });
                }
            }
        } catch {
            // Directory doesn't exist or not readable
        }

        return files;
    }

    async listConversationFiles(conversationId: string): Promise<string[]> {
        const details = await this.listConversationFilesDetails(conversationId);
        return Array.from(details.keys());
    }

    async checkSyncFolderExists(): Promise<boolean> {
        const syncFolder = path.join(this.basePath, 'AntigravitySync');
        try {
            await fs.promises.access(syncFolder);
            return true;
        } catch {
            return false;
        }
    }

    async getStorageInfo(): Promise<{ used: number; limit: number } | null> {
        // For local storage, calculate used space in sync folder
        try {
            await this.ensureSyncFolders();
            const used = await this.getDirSize(this.syncFolderPath!);
            // No real limit for local filesystem, use 0 to indicate unlimited
            return { used, limit: 0 };
        } catch {
            return null;
        }
    }

    private async getDirSize(dirPath: string): Promise<number> {
        let totalSize = 0;
        try {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    totalSize += await this.getDirSize(fullPath);
                } else {
                    const stats = await fs.promises.stat(fullPath);
                    totalSize += stats.size;
                }
            }
        } catch {
            // Ignore errors
        }
        return totalSize;
    }

    async getUserInfo(): Promise<{ email: string; name: string } | null> {
        // Local storage doesn't have user info
        return {
            email: 'local',
            name: os.hostname()
        };
    }

    async acquireLock(machineId: string, ttlMs: number = 60000): Promise<boolean> {
        await this.ensureSyncFolders();
        const lockPath = path.join(this.syncFolderPath!, 'sync.lock');

        try {
            // Check existing lock
            try {
                const content = await fs.promises.readFile(lockPath, 'utf8');
                const lockData = JSON.parse(content) as LockFile;

                if (Date.now() < lockData.expiresAt && lockData.machineId !== machineId) {
                    return false; // Locked by another machine
                }

                // Expired or owned by us - remove it
                await fs.promises.unlink(lockPath);
            } catch {
                // No lock file or invalid - proceed
            }

            // Create lock
            const lockData: LockFile = {
                machineId,
                expiresAt: Date.now() + ttlMs
            };
            await fs.promises.writeFile(lockPath, JSON.stringify(lockData), 'utf8');
            return true;
        } catch {
            return false;
        }
    }

    async releaseLock(machineId: string): Promise<void> {
        await this.ensureSyncFolders();
        const lockPath = path.join(this.syncFolderPath!, 'sync.lock');

        try {
            const content = await fs.promises.readFile(lockPath, 'utf8');
            const lockData = JSON.parse(content) as LockFile;
            if (lockData.machineId === machineId) {
                await fs.promises.unlink(lockPath);
            }
        } catch {
            // No lock or already released
        }
    }

    async deleteFile(fileId: string): Promise<void> {
        // fileId is the full path for local storage
        try {
            const stats = await fs.promises.stat(fileId);
            if (stats.isDirectory()) {
                await fs.promises.rm(fileId, { recursive: true, force: true });
            } else {
                await fs.promises.unlink(fileId);
            }
        } catch {
            // Ignore if not exists
        }
    }
}
