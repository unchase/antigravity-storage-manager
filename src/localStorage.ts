import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { LockFile, DriveFile } from './googleDrive';

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

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

function isEnoent(err: unknown): boolean {
    return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT');
}

function validateSafeId(id: string, label: string): string {
    if (!id || id === '.' || id === '..' || !SAFE_ID_REGEX.test(id)) {
        throw new Error(`Invalid ${label}: "${id}"`);
    }
    return id;
}

function resolveSafePath(rootDir: string, ...relativeSegments: string[]): string {
    const resolvedRoot = path.resolve(rootDir);
    const normalizedSegments: string[] = [];

    for (const seg of relativeSegments) {
        const parts = seg.replace(/\\/g, '/').split('/');
        for (const p of parts) {
            if (!p || p === '.') continue;
            if (p === '..' || p.includes('\0') || /^[a-zA-Z]:/.test(p)) {
                throw new Error(`Path traversal detected in segment: "${seg}"`);
            }
            normalizedSegments.push(p);
        }
    }

    if (normalizedSegments.length === 0) {
        throw new Error('Resolved relative path cannot be empty');
    }

    const resolvedTarget = path.resolve(resolvedRoot, ...normalizedSegments);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Resolved path escapes root directory: "${resolvedTarget}"`);
    }
    return resolvedTarget;
}

async function atomicWriteFile(targetPath: string, data: Buffer | string): Promise<void> {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);

    try {
        await fs.promises.writeFile(tmpPath, data);
        await fs.promises.rename(tmpPath, targetPath);
    } catch (err) {
        try {
            await fs.promises.unlink(tmpPath);
        } catch {
            // Best effort cleanup
        }
        throw err;
    }
}

async function computeFileMd5Stream(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
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
    private activeLockToken: string | null = null;

    constructor(localPath: string) {
        // Expand ~ or ~/ or ~\ to home directory
        if (localPath === '~') {
            localPath = os.homedir();
        } else if (localPath.startsWith('~/') || localPath.startsWith('~\\')) {
            localPath = path.join(os.homedir(), localPath.slice(2));
        }
        this.basePath = path.resolve(localPath);
    }

    async ensureSyncFolders(): Promise<{ syncFolderId: string; machinesFolderId: string; conversationsFolderId: string }> {
        const syncFolder = path.join(this.basePath, 'AntigravitySync');
        const machinesFolder = path.join(syncFolder, 'machines');
        const conversationsFolder = path.join(syncFolder, 'conversations');

        await fs.promises.mkdir(syncFolder, { recursive: true });
        await fs.promises.mkdir(machinesFolder, { recursive: true });
        await fs.promises.mkdir(conversationsFolder, { recursive: true });

        this.syncFolderPath = syncFolder;
        this.machinesFolderPath = machinesFolder;
        this.conversationsFolderPath = conversationsFolder;

        return {
            syncFolderId: syncFolder,
            machinesFolderId: machinesFolder,
            conversationsFolderId: conversationsFolder
        };
    }

    async getManifest(): Promise<Buffer | null> {
        const { syncFolderId } = await this.ensureSyncFolders();
        const manifestPath = path.join(syncFolderId, 'manifest.json.enc');
        try {
            return await fs.promises.readFile(manifestPath);
        } catch (err) {
            if (isEnoent(err)) return null;
            throw err;
        }
    }

    async updateManifest(encryptedManifest: Buffer): Promise<void> {
        const { syncFolderId } = await this.ensureSyncFolders();
        const manifestPath = path.join(syncFolderId, 'manifest.json.enc');
        await atomicWriteFile(manifestPath, encryptedManifest);
    }

    async getMachineState(machineId: string): Promise<Buffer | null> {
        const safeId = validateSafeId(machineId, 'machineId');
        const { machinesFolderId } = await this.ensureSyncFolders();
        const statePath = resolveSafePath(machinesFolderId, `${safeId}.json.enc`);
        try {
            return await fs.promises.readFile(statePath);
        } catch (err) {
            if (isEnoent(err)) return null;
            throw err;
        }
    }

    async updateMachineState(machineId: string, encryptedState: Buffer): Promise<void> {
        const safeId = validateSafeId(machineId, 'machineId');
        const { machinesFolderId } = await this.ensureSyncFolders();
        const statePath = resolveSafePath(machinesFolderId, `${safeId}.json.enc`);
        await atomicWriteFile(statePath, encryptedState);
    }

    async listMachineStates(): Promise<DriveFile[]> {
        const { machinesFolderId } = await this.ensureSyncFolders();
        try {
            const entries = await fs.promises.readdir(machinesFolderId, { withFileTypes: true });
            const results: DriveFile[] = [];
            for (const entry of entries) {
                if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json.enc')) {
                    continue;
                }
                const fullPath = path.join(machinesFolderId, entry.name);
                const stats = await fs.promises.lstat(fullPath);
                results.push({
                    id: fullPath,
                    name: entry.name,
                    mimeType: 'application/json',
                    modifiedTime: stats.mtime.toISOString()
                });
            }
            return results;
        } catch (err) {
            if (isEnoent(err)) return [];
            throw err;
        }
    }

    async uploadConversation(conversationId: string, encryptedData: Buffer): Promise<string> {
        const safeId = validateSafeId(conversationId, 'conversationId');
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const filePath = resolveSafePath(conversationsFolderId, `${safeId}.zip.enc`);
        await atomicWriteFile(filePath, encryptedData);
        return filePath;
    }

    async downloadConversation(conversationId: string): Promise<Buffer | null> {
        const safeId = validateSafeId(conversationId, 'conversationId');
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const filePath = resolveSafePath(conversationsFolderId, `${safeId}.zip.enc`);
        try {
            return await fs.promises.readFile(filePath);
        } catch (err) {
            if (isEnoent(err)) return null;
            throw err;
        }
    }

    async deleteConversation(conversationId: string): Promise<void> {
        const safeId = validateSafeId(conversationId, 'conversationId');
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const filePath = resolveSafePath(conversationsFolderId, `${safeId}.zip.enc`);
        try {
            await fs.promises.unlink(filePath);
        } catch (err) {
            if (!isEnoent(err)) throw err;
        }

        const folderPath = resolveSafePath(conversationsFolderId, safeId);
        try {
            await fs.promises.rm(folderPath, { recursive: true, force: true });
        } catch (err) {
            if (!isEnoent(err)) throw err;
        }
    }

    async listConversations(): Promise<DriveFile[]> {
        const { conversationsFolderId } = await this.ensureSyncFolders();
        try {
            const entries = await fs.promises.readdir(conversationsFolderId, { withFileTypes: true });
            const results: DriveFile[] = [];
            for (const entry of entries) {
                if (entry.isSymbolicLink() || entry.name.endsWith('.tmp')) continue;
                const fullPath = path.join(conversationsFolderId, entry.name);
                const stats = await fs.promises.lstat(fullPath);
                results.push({
                    id: fullPath,
                    name: entry.name,
                    mimeType: stats.isDirectory() ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
                    modifiedTime: stats.mtime.toISOString(),
                    size: stats.isFile() ? stats.size.toString() : undefined
                });
            }
            return results;
        } catch (err) {
            if (isEnoent(err)) return [];
            throw err;
        }
    }

    async uploadConversationFile(
        conversationId: string,
        relativePath: string,
        encryptedData: Buffer,
        originalMd5?: string
    ): Promise<string> {
        const safeId = validateSafeId(conversationId, 'conversationId');
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const convFolder = resolveSafePath(conversationsFolderId, safeId);
        const filePath = resolveSafePath(convFolder, `${relativePath}.enc`);

        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await atomicWriteFile(filePath, encryptedData);

        const metaPath = filePath + '.meta';
        if (originalMd5) {
            await atomicWriteFile(metaPath, JSON.stringify({ originalMd5 }));
        } else {
            try {
                await fs.promises.unlink(metaPath);
            } catch (err) {
                if (!isEnoent(err)) throw err;
            }
        }

        return filePath;
    }

    async downloadConversationFile(
        conversationId: string,
        relativePath: string
    ): Promise<Buffer | null> {
        const safeId = validateSafeId(conversationId, 'conversationId');
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const convFolder = resolveSafePath(conversationsFolderId, safeId);
        const filePath = resolveSafePath(convFolder, `${relativePath}.enc`);

        try {
            return await fs.promises.readFile(filePath);
        } catch (err) {
            if (isEnoent(err)) return null;
            throw err;
        }
    }

    async deleteConversationFile(
        conversationId: string,
        relativePath: string
    ): Promise<void> {
        const safeId = validateSafeId(conversationId, 'conversationId');
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const convFolder = resolveSafePath(conversationsFolderId, safeId);
        const filePath = resolveSafePath(convFolder, `${relativePath}.enc`);

        try {
            await fs.promises.unlink(filePath);
        } catch (err) {
            if (!isEnoent(err)) throw err;
        }
        try {
            await fs.promises.unlink(filePath + '.meta');
        } catch (err) {
            if (!isEnoent(err)) throw err;
        }
    }

    async listConversationFilesDetails(conversationId: string): Promise<Map<string, { id: string; md5: string; originalMd5?: string }>> {
        const safeId = validateSafeId(conversationId, 'conversationId');
        const { conversationsFolderId } = await this.ensureSyncFolders();
        const convFolder = resolveSafePath(conversationsFolderId, safeId);

        try {
            await fs.promises.access(convFolder);
        } catch (err) {
            if (isEnoent(err)) return new Map();
            throw err;
        }

        return this.listFilesRecursiveDetails(convFolder, '');
    }

    private async listFilesRecursiveDetails(
        dirPath: string,
        prefix: string
    ): Promise<Map<string, { id: string; md5: string; originalMd5?: string }>> {
        const files = new Map<string, { id: string; md5: string; originalMd5?: string }>();
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (entry.name.endsWith('.meta') || entry.name.endsWith('.tmp')) continue;

            const fullPath = path.join(dirPath, entry.name);
            const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                const subFiles = await this.listFilesRecursiveDetails(fullPath, entryPath);
                subFiles.forEach((val, key) => files.set(key, val));
            } else if (entry.isFile() && entry.name.endsWith('.enc')) {
                const relativePath = entryPath.slice(0, -4); // strip '.enc'
                const md5 = await computeFileMd5Stream(fullPath);

                let originalMd5: string | undefined;
                try {
                    const metaPath = fullPath + '.meta';
                    const metaContent = await fs.promises.readFile(metaPath, 'utf8');
                    const meta = JSON.parse(metaContent);
                    if (typeof meta.originalMd5 === 'string') {
                        originalMd5 = meta.originalMd5;
                    }
                } catch {
                    // No meta file or invalid JSON
                }

                files.set(relativePath, {
                    id: fullPath,
                    md5,
                    originalMd5
                });
            }
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
        try {
            const { syncFolderId } = await this.ensureSyncFolders();
            const used = await this.getDirSize(syncFolderId);
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
                if (entry.isSymbolicLink()) continue;
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    totalSize += await this.getDirSize(fullPath);
                } else if (entry.isFile()) {
                    const stats = await fs.promises.lstat(fullPath);
                    totalSize += stats.size;
                }
            }
        } catch {
            // Ignore errors
        }
        return totalSize;
    }

    async getUserInfo(): Promise<{ email: string; name: string } | null> {
        return {
            email: 'local',
            name: os.hostname()
        };
    }

    async acquireLock(machineId: string, ttlMs: number = 300000): Promise<boolean> {
        const { syncFolderId } = await this.ensureSyncFolders();
        const lockPath = path.join(syncFolderId, 'sync.lock');
        const token = crypto.randomUUID();

        const tryCreateExclusive = async (): Promise<boolean> => {
            const lockData: LockFile & { token?: string } = {
                machineId,
                expiresAt: Date.now() + ttlMs,
                token
            };
            const fh = await fs.promises.open(lockPath, 'wx');
            try {
                await fh.writeFile(JSON.stringify(lockData), 'utf8');
            } finally {
                await fh.close();
            }
            this.activeLockToken = token;
            return true;
        };

        try {
            return await tryCreateExclusive();
        } catch (err: any) {
            if (err?.code !== 'EEXIST') {
                return false;
            }
        }

        // Lock exists — inspect whether it is expired, corrupted, or owned by us
        try {
            const content = await fs.promises.readFile(lockPath, 'utf8');
            let lockData: (LockFile & { token?: string }) | null = null;
            try {
                lockData = JSON.parse(content);
            } catch {
                // Corrupted JSON — safe to remove and retry
                lockData = null;
            }

            if (lockData && Date.now() < lockData.expiresAt && lockData.machineId !== machineId) {
                return false;
            }

            await fs.promises.unlink(lockPath);
        } catch (err) {
            if (!isEnoent(err)) {
                return false;
            }
        }

        try {
            return await tryCreateExclusive();
        } catch {
            return false;
        }
    }

    async releaseLock(machineId: string): Promise<void> {
        const { syncFolderId } = await this.ensureSyncFolders();
        const lockPath = path.join(syncFolderId, 'sync.lock');

        try {
            const content = await fs.promises.readFile(lockPath, 'utf8');
            const lockData = JSON.parse(content) as LockFile & { token?: string };
            const tokenMatches = !this.activeLockToken || !lockData.token || lockData.token === this.activeLockToken;
            if (lockData.machineId === machineId && tokenMatches) {
                await fs.promises.unlink(lockPath);
                this.activeLockToken = null;
            }
        } catch {
            // No lock or already released
        }
    }

    async deleteFile(fileId: string): Promise<void> {
        const { syncFolderId, machinesFolderId, conversationsFolderId } = await this.ensureSyncFolders();
        const resolvedRoot = path.resolve(syncFolderId);
        const resolvedTarget = path.resolve(fileId);
        const rel = path.relative(resolvedRoot, resolvedTarget);

        if (
            !rel ||
            rel.startsWith('..') ||
            path.isAbsolute(rel) ||
            resolvedTarget === resolvedRoot ||
            resolvedTarget === path.resolve(machinesFolderId) ||
            resolvedTarget === path.resolve(conversationsFolderId)
        ) {
            throw new Error(`Refusing to delete path outside AntigravitySync: "${fileId}"`);
        }

        try {
            const stats = await fs.promises.lstat(resolvedTarget);
            if (stats.isSymbolicLink()) {
                await fs.promises.unlink(resolvedTarget);
                return;
            }
            if (stats.isDirectory()) {
                await fs.promises.rm(resolvedTarget, { recursive: true, force: true });
            } else {
                await fs.promises.unlink(resolvedTarget);
                if (resolvedTarget.endsWith('.enc')) {
                    try { await fs.promises.unlink(resolvedTarget + '.meta'); } catch { /* ignore */ }
                }
            }
        } catch (err) {
            if (!isEnoent(err)) throw err;
        }
    }
}
