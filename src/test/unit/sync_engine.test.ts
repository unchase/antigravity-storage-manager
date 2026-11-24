import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let mockConfig: Record<string, any> = {};

jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        withProgress: jest.fn((_opts, task) => task({ report: jest.fn() }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })),
        createStatusBarItem: jest.fn(() => ({
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn(),
            text: '',
            tooltip: ''
        }))
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key: string, defaultValue?: any) => (key in mockConfig ? mockConfig[key] : defaultValue))
        })),
        onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() }))
    },
    ThemeColor: jest.fn(),
    MarkdownString: class {
        value = '';
        isTrusted = false;
        supportThemeIcons = false;
        appendMarkdown(s: string) { this.value += s; }
    },
    StatusBarAlignment: { Right: 2 },
    ProgressLocation: { Notification: 15 },
    CancellationError: class CancellationError extends Error {
        constructor() { super('CancellationError'); }
    }
}), { virtual: true });

import { SyncManager, SyncResult } from '../../sync';
import { LocalStorageService } from '../../localStorage';
import * as crypto from '../../crypto';
import { SyncManifest } from '../../googleDrive';

describe('SyncManager Core Engine & Webview Security', () => {
    let tempDir: string;
    let storageRoot: string;
    let brainDir: string;
    let convDir: string;
    let localSyncDir: string;
    let mockContext: any;
    let mockAuthProvider: any;
    let mockDriveService: any;
    let syncManager: SyncManager;
    const PASSWORD = 'super-secret-password';

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sync-engine-test-'));
        storageRoot = path.join(tempDir, 'antigravity');
        brainDir = path.join(storageRoot, 'brain');
        convDir = path.join(storageRoot, 'conversations');
        localSyncDir = path.join(tempDir, 'local-sync');
        fs.mkdirSync(brainDir, { recursive: true });
        fs.mkdirSync(convDir, { recursive: true });

        mockConfig = {
            storagePath: storageRoot,
            'sync.storageProvider': 'google-drive',
            'sync.keepLocalFiles': true,
            'sync.enableCompression': true,
            'sync.conflictResolution': 'prompt',
            'sync.preSyncBackup': false,
            'sync.concurrency': 2
        };

        mockContext = {
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn().mockResolvedValue(undefined) },
            secrets: {
                get: jest.fn(),
                store: jest.fn().mockResolvedValue(undefined),
                delete: jest.fn().mockResolvedValue(undefined)
            }
        };

        mockAuthProvider = {
            isAuthenticated: jest.fn().mockReturnValue(true),
            onDidChangeSessions: jest.fn(() => ({ dispose: jest.fn() })),
            signOut: jest.fn().mockResolvedValue(undefined),
            signIn: jest.fn().mockResolvedValue(undefined),
            getOAuth2Client: jest.fn(() => ({}))
        };

        mockDriveService = {
            ensureSyncFolders: jest.fn().mockResolvedValue({ syncFolderId: 's', machinesFolderId: 'm', conversationsFolderId: 'c' }),
            getManifest: jest.fn(),
            updateManifest: jest.fn().mockResolvedValue(undefined),
            getMachineState: jest.fn().mockResolvedValue(null),
            updateMachineState: jest.fn().mockResolvedValue(undefined),
            listMachineStates: jest.fn().mockResolvedValue([]),
            uploadConversation: jest.fn(),
            downloadConversation: jest.fn(),
            deleteConversation: jest.fn().mockResolvedValue(undefined),
            listConversations: jest.fn().mockResolvedValue([]),
            uploadConversationFile: jest.fn().mockResolvedValue('file-id'),
            downloadConversationFile: jest.fn(),
            deleteConversationFile: jest.fn().mockResolvedValue(undefined),
            listConversationFilesDetails: jest.fn().mockResolvedValue(new Map()),
            listConversationFiles: jest.fn().mockResolvedValue([]),
            checkSyncFolderExists: jest.fn().mockResolvedValue(true),
            getStorageInfo: jest.fn().mockResolvedValue(null),
            getUserInfo: jest.fn().mockResolvedValue(null),
            acquireLock: jest.fn().mockResolvedValue(true),
            releaseLock: jest.fn().mockResolvedValue(undefined),
            deleteFile: jest.fn().mockResolvedValue(undefined)
        };

        syncManager = new SyncManager(mockContext, mockAuthProvider);
        (syncManager as any).driveService = mockDriveService;
        (syncManager as any).masterPassword = PASSWORD;
        (syncManager as any).config = {
            enabled: true,
            machineId: 'machine-A',
            machineName: 'SharedName',
            selectedConversations: 'all',
            autoSync: false,
            syncInterval: 300000,
            lastSync: '2026-01-01T00:00:00.000Z',
            showStatusBar: false,
            silent: true
        };
    });

    afterEach(() => {
        syncManager.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('ensureRemoteManifest NEVER overwrites existing manifest on decryption or network error', async () => {
        // Manifest encrypted with a DIFFERENT password -> decryption fails -> status: 'error'
        const encryptedOther = crypto.encrypt(Buffer.from(JSON.stringify({ version: 1, conversations: [{ id: 'precious' }] })), 'other-password');
        mockDriveService.getManifest.mockResolvedValue(encryptedOther);

        await expect((syncManager as any).ensureRemoteManifest()).rejects.toThrow();
        expect(mockDriveService.updateManifest).not.toHaveBeenCalled();

        // Network error -> status: 'error' -> must NOT recreate manifest
        mockDriveService.getManifest.mockRejectedValue(new Error('ECONNRESET'));
        await expect((syncManager as any).ensureRemoteManifest()).rejects.toThrow();
        expect(mockDriveService.updateManifest).not.toHaveBeenCalled();
    });

    test('manifestUpdateQueue recovers cleanly after a rejected update (no queue poisoning)', async () => {
        const manifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-01-01T00:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: []
        };
        const enc = crypto.encrypt(Buffer.from(JSON.stringify(manifest)), PASSWORD);
        mockDriveService.getManifest.mockResolvedValue(enc);

        // First update fails during write
        mockDriveService.updateManifest
            .mockRejectedValueOnce(new Error('Transient write failure'))
            .mockResolvedValueOnce(undefined);

        await expect((syncManager as any).enqueueManifestUpdate(() => true)).rejects.toThrow(/Transient write failure/);

        // Subsequent update must still execute and succeed!
        await expect((syncManager as any).enqueueManifestUpdate((m: SyncManifest) => {
            m.conversations.push({ id: 'c-after', title: 'After', lastModified: '2026-01-02T00:00:00Z', hash: 'h1', modifiedBy: 'machine-A' });
            return true;
        })).resolves.toBeUndefined();

        expect(mockDriveService.updateManifest).toHaveBeenCalledTimes(2);
    });

    test('processSyncItem applies 3-way merge BEFORE conflictPolicy (keepLocal still pulls remote-only changes)', async () => {
        mockConfig['sync.conflictResolution'] = 'keepLocal';
        const pushSpy = jest.spyOn(syncManager, 'pushConversation').mockResolvedValue(undefined);
        const pullSpy = jest.spyOn(syncManager, 'pullConversation').mockResolvedValue(undefined);

        const manifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-01-02T00:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: [{
                id: 'conv-1',
                title: 'Chat 1',
                lastModified: '2026-01-02T00:00:00Z',
                hash: 'remote-new-hash',
                modifiedBy: 'machine-B'
            }]
        };
        const localConversations = [{
            id: 'conv-1',
            title: 'Chat 1',
            lastModified: '2026-01-01T00:00:00Z',
            hash: 'base-hash',
            size: 100
        }];
        const lastSynced = new Map<string, string>([['conv-1', 'base-hash']]);
        const result: SyncResult = { success: true, pushed: [], pulled: [], conflicts: [], errors: [] };

        await (syncManager as any).processSyncItem('conv-1', localConversations, manifest, lastSynced, result);

        expect(pullSpy).toHaveBeenCalledWith('conv-1', undefined, undefined, true);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(result.pulled).toEqual(['conv-1']);
    });

    test('processSyncItem checks isSameDevice strictly by machineId (not by matching machineName)', async () => {
        const pushSpy = jest.spyOn(syncManager, 'pushConversation').mockResolvedValue(undefined);
        const pullSpy = jest.spyOn(syncManager, 'pullConversation').mockResolvedValue(undefined);

        const manifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-01-02T00:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            machines: [{ id: 'machine-B', name: 'SharedName', lastSync: '2026-01-02T00:00:00Z' }],
            conversations: [{
                id: 'conv-1',
                title: 'Chat 1',
                lastModified: '2026-01-02T00:00:00Z',
                hash: 'remote-hash',
                modifiedBy: 'machine-B',
                createdByName: 'SharedName'
            }]
        };
        const localConversations = [{
            id: 'conv-1',
            title: 'Chat 1',
            lastModified: '2026-01-03T00:00:00Z',
            hash: 'local-hash',
            size: 100
        }];
        const lastSynced = new Map<string, string>([['conv-1', 'base-hash']]);
        const result: SyncResult = { success: true, pushed: [], pulled: [], conflicts: [], errors: [] };

        await (syncManager as any).processSyncItem('conv-1', localConversations, manifest, lastSynced, result);

        // Both sides diverged across different machineIds (even with identical names) -> MUST be conflict!
        expect(result.conflicts).toHaveLength(1);
        expect(pushSpy).not.toHaveBeenCalled();
        expect(pullSpy).not.toHaveBeenCalled();
    });

    test('processSyncItem force sync with matching hashes pushes without false conflict', async () => {
        const pushSpy = jest.spyOn(syncManager, 'pushConversation').mockResolvedValue(undefined);
        const manifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-01-02T00:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: [{
                id: 'conv-1',
                title: 'Chat 1',
                lastModified: '2026-01-02T00:00:00Z',
                hash: 'same-hash',
                modifiedBy: 'machine-B'
            }]
        };
        const localConversations = [{
            id: 'conv-1',
            title: 'Chat 1',
            lastModified: '2026-01-02T00:00:00Z',
            hash: 'same-hash',
            size: 100
        }];
        const result: SyncResult = { success: true, pushed: [], pulled: [], conflicts: [], errors: [] };

        await (syncManager as any).processSyncItem('conv-1', localConversations, manifest, new Map(), result, undefined, undefined, true);

        expect(pushSpy).toHaveBeenCalledWith('conv-1', undefined, undefined);
        expect(result.conflicts).toHaveLength(0);
    });

    test('pullConversationPerFile respects forceOverwrite and cleans stale .db-wal and .db-shm even with keepLocalFiles=true', async () => {
        const convId = '11111111-1111-1111-1111-111111111111';
        fs.writeFileSync(path.join(convDir, `${convId}.db`), 'old-local-db');
        fs.writeFileSync(path.join(convDir, `${convId}.db-wal`), 'stale-local-wal');
        fs.writeFileSync(path.join(convDir, `${convId}.db-shm`), 'stale-local-shm');

        const newDbContent = Buffer.from('fresh-remote-db');
        const newDbHash = crypto.computeMd5Hash(newDbContent);
        mockDriveService.downloadConversationFile.mockResolvedValue(crypto.encrypt(newDbContent, PASSWORD, true));

        const remoteHashes = {
            [`conversations/${convId}.db`]: {
                hash: newDbHash,
                size: newDbContent.length,
                lastModified: '2020-01-01T00:00:00.000Z' // Older than local mtime!
            }
        };

        await (syncManager as any).pullConversationPerFile(convId, 'Title', remoteHashes, undefined, undefined, true);

        expect(fs.readFileSync(path.join(convDir, `${convId}.db`)).toString()).toBe('fresh-remote-db');
        expect(fs.existsSync(path.join(convDir, `${convId}.db-wal`))).toBe(false);
        expect(fs.existsSync(path.join(convDir, `${convId}.db-shm`))).toBe(false);
    });

    test('pushConversation with keepLocalFiles=true preserves remote-only brain files in manifest while deleting checkpointed .db-wal', async () => {
        const convId = '22222222-2222-2222-2222-222222222222';
        fs.mkdirSync(path.join(brainDir, convId), { recursive: true });
        fs.writeFileSync(path.join(brainDir, convId, 'task.md'), '# Updated Task');
        fs.writeFileSync(path.join(convDir, `${convId}.db`), 'checkpointed-db');

        const remoteManifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-01-01T00:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: [{
                id: convId,
                title: 'Updated Task',
                lastModified: '2026-01-01T00:00:00Z',
                hash: 'old-hash',
                modifiedBy: 'machine-A',
                version: 2,
                fileHashes: {
                    [`brain/${convId}/task.md`]: { hash: 'old-task', size: 10, lastModified: '2026-01-01T00:00:00Z' },
                    [`brain/${convId}/remote-extra.md`]: { hash: 'keep-me', size: 20, lastModified: '2026-01-01T00:00:00Z' },
                    [`conversations/${convId}.db`]: { hash: 'old-db', size: 10, lastModified: '2026-01-01T00:00:00Z' },
                    [`conversations/${convId}.db-wal`]: { hash: 'stale-wal', size: 5, lastModified: '2026-01-01T00:00:00Z' }
                }
            }]
        };
        mockDriveService.getManifest.mockResolvedValue(crypto.encrypt(Buffer.from(JSON.stringify(remoteManifest)), PASSWORD, true));

        let savedManifest: SyncManifest | null = null;
        mockDriveService.updateManifest.mockImplementation(async (buf: Buffer) => {
            savedManifest = JSON.parse(crypto.decrypt(buf, PASSWORD).toString('utf8'));
        });

        await syncManager.pushConversation(convId);

        // Stale .db-wal MUST be deleted remotely; remote-extra.md MUST be preserved in manifest!
        expect(mockDriveService.deleteConversationFile).toHaveBeenCalledWith(convId, `conversations/${convId}.db-wal`);
        expect(mockDriveService.deleteConversationFile).not.toHaveBeenCalledWith(convId, `brain/${convId}/remote-extra.md`);
        expect(savedManifest).not.toBeNull();
        const savedEntry = savedManifest!.conversations.find(c => c.id === convId)!;
        expect(savedEntry.fileHashes![`brain/${convId}/remote-extra.md`]).toBeDefined();
        expect(savedEntry.fileHashes![`conversations/${convId}.db-wal`]).toBeUndefined();
    });

    test('resolveConflict keepBoth supports v2 per-file format and aborts without pushing if download fails', async () => {
        const convId = '33333333-3333-3333-3333-333333333333';
        const manifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-01-01T00:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: [{
                id: convId,
                title: 'V2 Chat',
                lastModified: '2026-01-01T00:00:00Z',
                hash: 'rhash',
                modifiedBy: 'machine-B',
                version: 2,
                fileHashes: {
                    [`brain/${convId}/task.md`]: { hash: 'h1', size: 10, lastModified: '2026-01-01T00:00:00Z' }
                }
            }]
        };
        mockDriveService.getManifest.mockResolvedValue(crypto.encrypt(Buffer.from(JSON.stringify(manifest)), PASSWORD, true));
        const pushSpy = jest.spyOn(syncManager, 'pushConversation').mockResolvedValue(undefined);

        // Missing file on remote -> must throw and NOT overwrite remote via pushConversation
        mockDriveService.downloadConversationFile.mockResolvedValueOnce(null);
        await expect(syncManager.resolveConflict({
            conversationId: convId,
            localModified: '2026-01-02T00:00:00Z',
            remoteModified: '2026-01-01T00:00:00Z',
            localHash: 'lh',
            remoteHash: 'rhash'
        }, 'keepBoth')).rejects.toThrow(/Failed to download/i);
        expect(pushSpy).not.toHaveBeenCalled();

        // Now succeed download -> writes conflict copy and pushes local
        mockDriveService.downloadConversationFile.mockResolvedValueOnce(crypto.encrypt(Buffer.from('# Remote Version'), PASSWORD, true));
        await syncManager.resolveConflict({
            conversationId: convId,
            localModified: '2026-01-02T00:00:00Z',
            remoteModified: '2026-01-01T00:00:00Z',
            localHash: 'lh',
            remoteHash: 'rhash'
        }, 'keepBoth');

        const conflictFolders = fs.readdirSync(brainDir).filter(d => d.startsWith(`${convId}-conflict-`));
        expect(conflictFolders).toHaveLength(1);
        expect(fs.readFileSync(path.join(brainDir, conflictFolders[0], 'task.md'), 'utf8')).toBe('# Remote Version');
        expect(pushSpy).toHaveBeenCalledWith(convId);
    });

    test('disconnect clears the actual config key, masterPassword, and internal caches', async () => {
        await syncManager.disconnect();
        expect(mockContext.globalState.update).toHaveBeenCalledWith('antigravity-storage-manager.sync.config', undefined);
        expect(mockContext.globalState.update).toHaveBeenCalledWith('ag-sync-config', undefined);
        expect(syncManager.getConfig()).toBeNull();
        expect((syncManager as any).masterPassword).toBeNull();
    });

    test('LocalStorageService works when Google OAuth is NOT authenticated', async () => {
        mockAuthProvider.isAuthenticated.mockReturnValue(false);
        const localSvc = new LocalStorageService(localSyncDir);
        (syncManager as any).driveService = localSvc;

        expect(syncManager.isReady()).toBe(true);

        const manifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-01-01T00:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: []
        };
        await localSvc.ensureSyncFolders();
        await localSvc.updateManifest(crypto.encrypt(Buffer.from(JSON.stringify(manifest)), PASSWORD, true));

        const fetched = await syncManager.getDecryptedManifest(true);
        expect(fetched?.version).toBe(1);
    });

    test('getFullPathForRelative blocks Path Traversal attempts', () => {
        expect(() => (syncManager as any).getFullPathForRelative('c1', 'brain/../../etc/passwd')).toThrow(/traversal|escapes/i);
        expect(() => (syncManager as any).getFullPathForRelative('c1', 'conversations/../evil.db')).toThrow(/traversal|escapes/i);
        expect(() => (syncManager as any).getFullPathForRelative('c1', 'other/file.txt')).toThrow(/Unknown path/i);
    });

    test('Webview chat HTML includes strict CSP nonce, blocks Stored XSS, and safely renders token usage without crash', () => {
        const maliciousPayload = '<img src=x onerror=alert(1)> [DIFF:PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==]';
        const steps = [
            {
                type: 'CORTEX_STEP_TYPE_USER_INPUT',
                userInput: { userResponse: maliciousPayload },
                timestamp: Date.now()
            }
        ];

        const html: string = (syncManager as any).getChatHtml('test', steps, []);

        expect(html).toContain('Content-Security-Policy');
        expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
        // Must not contain raw unescaped img/onerror or decoded fake [DIFF:...] <script>
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
        expect(html).not.toContain('<script>alert(1)</script>');
        // Must not contain inline onclick handlers
        expect(html).not.toMatch(/\sonclick="/i);

        // renderTokenUsage with null usage and positive latency must not throw
        const usageHtml: string = (syncManager as any).renderTokenUsage(null, 2500);
        expect(usageHtml).toContain('2.5');
    });

    test('updateMachineState preserves previous lastSyncedHash for conflicted/excluded conversations', async () => {
        const convOk = '44444444-4444-4444-4444-444444444444';
        const convConflicted = '55555555-5555-5555-5555-555555555555';
        (syncManager as any).getLocalConversationsAsync = jest.fn().mockResolvedValue([
            { id: convOk, title: 'OK', lastModified: '2026-01-02T00:00:00Z', hash: 'new-ok-hash', size: 10 },
            { id: convConflicted, title: 'Conflicted', lastModified: '2026-01-02T00:00:00Z', hash: 'diverged-local-hash', size: 20 }
        ]);

        let savedState: any = null;
        mockDriveService.updateMachineState.mockImplementation(async (_id: string, buf: Buffer) => {
            savedState = JSON.parse(crypto.decrypt(buf, PASSWORD).toString('utf8'));
        });

        const excluded = new Set<string>([convConflicted]);
        const prevHashes = new Map<string, string>([
            [convOk, 'old-ok-hash'],
            [convConflicted, 'base-before-conflict-hash']
        ]);

        await (syncManager as any).updateMachineState(excluded, prevHashes);

        expect(savedState).not.toBeNull();
        const okState = savedState.conversationStates.find((s: any) => s.id === convOk);
        const conflictState = savedState.conversationStates.find((s: any) => s.id === convConflicted);
        expect(okState.localHash).toBe('new-ok-hash');
        expect(conflictState.localHash).toBe('base-before-conflict-hash');
    });
});
