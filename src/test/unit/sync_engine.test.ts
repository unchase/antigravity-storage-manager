import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let mockConfig: Record<string, any> = {};

jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        activeTextEditor: undefined,
        visibleTextEditors: [],
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

    test('refreshStatistics does not duplicate current machine when sync.machineName differs from remote state or manifest', async () => {
        const myId = '7eabb307-aaaa-bbbb-cccc-111111111111';
        const otherId = '99999999-aaaa-bbbb-cccc-222222222222';
        const manifestOnlyId = '88888888-aaaa-bbbb-cccc-333333333333';

        mockConfig['sync.machineName'] = 'PC';
        (syncManager as any).config.machineId = myId;
        (syncManager as any).config.machineName = 'UNCHASE-GM';

        const remoteManifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-11-25T01:57:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: [],
            machines: [
                { id: myId, name: 'UNCHASE-GM', lastSync: '2026-11-25T01:57:00Z', createdAt: '2026-01-01T00:00:00Z' },
                { id: manifestOnlyId, name: 'MacBook', lastSync: '2026-11-24T12:00:00Z', createdAt: '2026-01-01T00:00:00Z' }
            ]
        };

        const myOldStateEnc = crypto.encrypt(Buffer.from(JSON.stringify({
            machineId: myId,
            machineName: 'UNCHASE-GM',
            lastSync: '2026-11-25T01:57:00Z',
            syncCount: 0,
            uploadCount: 0,
            downloadCount: 0,
            conversationStates: []
        })), PASSWORD, true);

        const otherStateEnc = crypto.encrypt(Buffer.from(JSON.stringify({
            machineId: otherId,
            machineName: 'Work Laptop',
            lastSync: '2026-11-25T01:50:00Z',
            syncCount: 3,
            uploadCount: 5,
            downloadCount: 2,
            conversationStates: []
        })), PASSWORD, true);

        mockDriveService.getManifest.mockResolvedValue(crypto.encrypt(Buffer.from(JSON.stringify(remoteManifest)), PASSWORD, true));
        mockDriveService.listMachineStates.mockResolvedValue([
            { id: 'f-my', name: `${myId}.json.enc`, modifiedTime: '2026-11-25T01:58:00Z' },
            { id: 'f-other', name: `${otherId}.json.enc`, modifiedTime: '2026-11-25T01:50:00Z' }
        ]);
        mockDriveService.getMachineState.mockImplementation(async (id: string) => {
            if (id === myId) return myOldStateEnc;
            if (id === otherId) return otherStateEnc;
            return null;
        });
        mockDriveService.getUserInfo = jest.fn().mockResolvedValue(null);
        (syncManager as any).getServerLatestTrajectoryId = jest.fn().mockResolvedValue(null);
        (syncManager as any).getMcpServerStates = jest.fn().mockResolvedValue([]);

        await (syncManager as any).refreshStatistics(true, false, true);

        const statsData = (syncManager as any).lastStatsData;
        expect(statsData).toBeDefined();

        const myEntries = statsData.machines.filter((m: any) => m.id === myId);
        expect(myEntries).toHaveLength(1);
        expect(myEntries[0].name).toBe('PC');
        expect(myEntries[0].isCurrent).toBe(true);

        // Other distinct machines remain intact
        expect(statsData.machines.find((m: any) => m.id === otherId)?.name).toBe('Work Laptop');
        expect(statsData.machines.find((m: any) => m.id === manifestOnlyId)?.name).toBe('MacBook');
    });

    test('syncNow updates stale machine name in remote manifest and machine state even with no conversation changes', async () => {
        mockConfig['sync.machineName'] = 'PC';
        (syncManager as any).config.machineName = 'UNCHASE-GM';

        const initialManifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-11-25T01:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: [],
            machines: [
                { id: 'machine-A', name: 'UNCHASE-GM', lastSync: '2026-11-25T01:00:00Z', createdAt: '2026-01-01T00:00:00Z' }
            ]
        };
        let storedManifestBuf = crypto.encrypt(Buffer.from(JSON.stringify(initialManifest)), PASSWORD, true);
        let savedMachineState: any = null;

        mockDriveService.getManifest.mockImplementation(async () => storedManifestBuf);
        mockDriveService.updateManifest.mockImplementation(async (buf: Buffer) => {
            storedManifestBuf = buf;
        });
        mockDriveService.updateMachineState.mockImplementation(async (_id: string, buf: Buffer) => {
            savedMachineState = JSON.parse(crypto.decrypt(buf, PASSWORD).toString('utf8'));
        });

        const result = await syncManager.syncNow();
        expect(result.success).toBe(true);

        const updatedManifest: SyncManifest = JSON.parse(crypto.decrypt(storedManifestBuf, PASSWORD).toString('utf8'));
        const updatedEntry = updatedManifest.machines?.find(m => m.id === 'machine-A');
        expect(updatedEntry?.name).toBe('PC');
        expect(savedMachineState?.machineName).toBe('PC');
        expect((syncManager as any).config.machineName).toBe('PC');
    });

    test('archiveConversations persists to manifest when ready, skips archived items in syncNow (even with force), and unarchive restores sync', async () => {
        const archivedConvId = 'aaaa1111-1111-1111-1111-111111111111';
        const activeConvId = 'bbbb2222-2222-2222-2222-222222222222';
        const remoteOnlyArchivedId = 'cccc3333-3333-3333-3333-333333333333';

        // Create local files for both archived and active conversations
        fs.mkdirSync(path.join(brainDir, archivedConvId), { recursive: true });
        fs.writeFileSync(path.join(brainDir, archivedConvId, 'task.md'), '# Archived Task');
        fs.mkdirSync(path.join(brainDir, activeConvId), { recursive: true });
        fs.writeFileSync(path.join(brainDir, activeConvId, 'task.md'), '# Active Task');

        const initialManifest: SyncManifest = {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            lastModified: '2026-11-25T01:00:00Z',
            passwordVerificationSalt: 's',
            passwordVerificationHash: 'h',
            conversations: [
                {
                    id: remoteOnlyArchivedId,
                    title: 'Remote Archived',
                    lastModified: '2026-11-25T01:00:00Z',
                    hash: 'remote-hash',
                    modifiedBy: 'machine-B',
                    version: 2,
                    fileHashes: { 'brain/task.md': { hash: 'h1', size: 10, lastModified: '2026-11-25T01:00:00Z' } }
                }
            ],
            machines: [
                { id: 'machine-A', name: 'SharedName', lastSync: '2026-11-25T01:00:00Z', createdAt: '2026-01-01T00:00:00Z' }
            ]
        };

        let storedManifestBuf = crypto.encrypt(Buffer.from(JSON.stringify(initialManifest)), PASSWORD, true);
        let savedMachineState: any = null;
        mockDriveService.getManifest.mockImplementation(async () => storedManifestBuf);
        mockDriveService.updateManifest.mockImplementation(async (buf: Buffer) => {
            storedManifestBuf = buf;
        });
        mockDriveService.updateMachineState.mockImplementation(async (_id: string, buf: Buffer) => {
            savedMachineState = JSON.parse(crypto.decrypt(buf, PASSWORD).toString('utf8'));
        });
        mockDriveService.getMachineState.mockResolvedValue(crypto.encrypt(Buffer.from(JSON.stringify({
            machineId: 'machine-A',
            machineName: 'SharedName',
            lastSync: '2026-11-25T00:00:00Z',
            conversationStates: [
                { id: archivedConvId, localHash: 'base-archived-hash', lastSynced: '2026-11-25T00:00:00Z' }
            ]
        })), PASSWORD, true));

        // 1. Archive both local and remote-only conversations
        await syncManager.archiveConversations([archivedConvId, remoteOnlyArchivedId]);
        const manifestAfterArchive: SyncManifest = JSON.parse(crypto.decrypt(storedManifestBuf, PASSWORD).toString('utf8'));
        expect(manifestAfterArchive.archivedConversations?.[archivedConvId]).toBeDefined();
        expect(manifestAfterArchive.archivedConversations?.[remoteOnlyArchivedId]).toBeDefined();

        // 2. Run syncNow (even with force=true): archived ones must NOT be pushed or pulled
        const pullSpy = jest.spyOn(syncManager as any, 'pullConversation').mockResolvedValue(undefined);
        const pushSpy = jest.spyOn(syncManager as any, 'pushConversation').mockResolvedValue(undefined);

        const syncRes = await syncManager.syncNow(undefined, undefined, true);
        expect(syncRes.success).toBe(true);
        expect(pushSpy).toHaveBeenCalledWith(activeConvId, undefined, undefined);
        expect(pushSpy).not.toHaveBeenCalledWith(archivedConvId, expect.anything(), expect.anything());
        expect(pullSpy).not.toHaveBeenCalledWith(remoteOnlyArchivedId, expect.anything(), expect.anything(), expect.anything());

        // Archived conversation's previous lastSyncedHash must be preserved in machineState
        const archivedStateEntry = savedMachineState?.conversationStates?.find((s: any) => s.id === archivedConvId);
        expect(archivedStateEntry?.localHash).toBe('base-archived-hash');

        // 3. Direct processSyncItem call on archived item also exits early
        const directRes: SyncResult = { success: true, pushed: [], pulled: [], conflicts: [], errors: [] };
        await (syncManager as any).processSyncItem(
            archivedConvId,
            [{ id: archivedConvId, title: 'Archived Task', lastModified: '2026-11-25T02:00:00Z', hash: 'new-hash', size: 15 }],
            manifestAfterArchive,
            new Map(),
            directRes,
            undefined,
            undefined,
            true
        );
        expect(directRes.pushed).toHaveLength(0);
        expect(directRes.pulled).toHaveLength(0);

        // 4. Unarchive restores participation in sync
        await syncManager.unarchiveConversation(archivedConvId);
        const manifestAfterUnarchive: SyncManifest = JSON.parse(crypto.decrypt(storedManifestBuf, PASSWORD).toString('utf8'));
        expect(manifestAfterUnarchive.archivedConversations?.[archivedConvId]).toBeUndefined();
        expect(manifestAfterUnarchive.archivedConversations?.[remoteOnlyArchivedId]).toBeDefined();

        pushSpy.mockClear();
        const syncRes2 = await syncManager.syncNow();
        expect(syncRes2.success).toBe(true);
        expect(pushSpy).toHaveBeenCalledWith(archivedConvId, undefined, undefined);
    });

    test('archiveConversation falls back to local globalState when sync is not ready and unarchive clears it', async () => {
        const stateStore = new Map<string, any>();
        mockContext.globalState.get = jest.fn((key: string, def?: any) => (stateStore.has(key) ? stateStore.get(key) : def));
        mockContext.globalState.update = jest.fn(async (key: string, val: any) => { stateStore.set(key, val); });

        // Simulate unconfigured / offline sync
        (syncManager as any).masterPassword = null;
        expect(syncManager.isReady()).toBe(false);

        const localOnlyId = 'dddd4444-4444-4444-4444-444444444444';
        await syncManager.archiveConversation(localOnlyId);
        expect(syncManager.isConversationArchived(localOnlyId, null)).toBe(true);

        await syncManager.unarchiveConversation(localOnlyId);
        expect(syncManager.isConversationArchived(localOnlyId, null)).toBe(false);
    });

    test('searchConversations finds matches across titles, brain/*.md, transcript.jsonl, and .db files even when RPC fails', async () => {
        const idTitle = '1111aaaa-1111-1111-1111-111111111111';
        const idMd = '2222bbbb-2222-2222-2222-222222222222';
        const idTranscript = '3333cccc-3333-3333-3333-333333333333';
        const idDb = '4444dddd-4444-4444-4444-444444444444';
        const idUnrelated = '5555eeee-5555-5555-5555-555555555555';

        // 1. Title match
        fs.mkdirSync(path.join(brainDir, idTitle), { recursive: true });
        fs.writeFileSync(path.join(brainDir, idTitle, 'task.md'), '# Аудит безопасности КвантовыйКот');

        // 2. Markdown body match
        fs.mkdirSync(path.join(brainDir, idMd), { recursive: true });
        fs.writeFileSync(path.join(brainDir, idMd, 'task.md'), '# Ordinary Title');
        fs.writeFileSync(path.join(brainDir, idMd, 'walkthrough.md'), 'Details about квантовыйкот integration.');

        // 3. transcript.jsonl match
        const logsDir = path.join(brainDir, idTranscript, '.system_generated', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(
            path.join(logsDir, 'transcript.jsonl'),
            JSON.stringify({ role: 'user', content: 'Please fix КВАНТОВЫЙКОТ parser' }) + '\n'
        );

        // 4. SQLite .db binary match
        fs.writeFileSync(
            path.join(convDir, `${idDb}.db`),
            Buffer.concat([
                Buffer.from('SQLite format 3\0'),
                Buffer.from([0x00, 0x01, 0x02]),
                Buffer.from('payload with квантовыйкот inside sqlite', 'utf8'),
                Buffer.from([0x00, 0x00])
            ])
        );

        // 5. Unrelated conversation
        fs.mkdirSync(path.join(brainDir, idUnrelated), { recursive: true });
        fs.writeFileSync(path.join(brainDir, idUnrelated, 'task.md'), '# Completely different topic');

        // Simulate Antigravity 2.0 RPC failure (403/404/unavailable)
        (syncManager as any).apiClient.search = jest.fn().mockRejectedValue(new Error('API Error 403'));

        const results = await syncManager.searchConversations('квантовыйкот');
        const foundIds = new Set(results.map(r => r.cascadeId));

        expect(foundIds.has(idTitle)).toBe(true);
        expect(foundIds.has(idMd)).toBe(true);
        expect(foundIds.has(idTranscript)).toBe(true);
        expect(foundIds.has(idDb)).toBe(true);
        expect(foundIds.has(idUnrelated)).toBe(false);

        const transcriptResult = results.find(r => r.cascadeId === idTranscript);
        expect(transcriptResult?.matches[0].role).toBe('user');
        expect(transcriptResult?.matches[0].text.toLowerCase()).toContain('квантовыйкот');
    });

    test('parseTranscriptJsonl extracts clean USER_REQUEST, folds thinking/tool_calls/tool outputs, skips empty {}, and preserves visible AI responses', () => {
        const transcriptLines = [
            JSON.stringify({
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-10-26T23:25:28Z',
                content: '<USER_REQUEST>\nпроведи аудит приложения\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-27T02:25:28+03:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting Model Selection\n</USER_SETTINGS_CHANGE>'
            }),
            JSON.stringify({
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-10-26T23:25:30Z',
                model: 'claude-opus-5.5',
                input_tokens: 1500,
                cache_read_tokens: 200,
                output_tokens: 120,
                thinking: 'Checking repository files first.',
                tool_calls: [
                    { name: 'run_command', args: { CommandLine: '"git status"' } }
                ]
            }),
            JSON.stringify({
                step_index: 2,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'DONE',
                created_at: '2026-10-26T23:25:32Z',
                content: 'Created At: 2026-10-27\nCommand output:\nOn branch master'
            }),
            JSON.stringify({
                step_index: 3,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                created_at: '2026-10-26T23:25:33Z',
                content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\nReminder: work efficiently. In this turn, issue in parallel...\n</SYSTEM_MESSAGE>'
            }),
            JSON.stringify({
                step_index: 4,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-10-26T23:25:35Z',
                input_tokens: 2100,
                output_tokens: 80,
                content: 'Аудит завершён: найдено 3 проблемы.'
            }),
            JSON.stringify({
                step_index: 5,
                source: 'SYSTEM',
                type: 'ERROR_MESSAGE',
                status: 'ERROR',
                created_at: '2026-10-26T23:25:36Z',
                error: 'Rate limit exceeded'
            }),
            JSON.stringify({
                step_index: 6,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-10-26T23:26:00Z',
                thinking: 'Inspecting directory and file before next prompt.',
                tool_calls: [
                    { name: 'list_dir', args: { DirectoryPath: '"e:/project"' } },
                    { name: 'view_file', args: { AbsolutePath: '"e:/project/README.md"' } }
                ]
            }),
            JSON.stringify({
                step_index: 7,
                source: 'MODEL',
                type: 'LIST_DIRECTORY',
                status: 'DONE',
                created_at: '2026-10-26T23:26:01Z',
                content: 'Created At: 2026-10-27\n{"name":".agents","isDir":true}'
            }),
            JSON.stringify({
                step_index: 8,
                source: 'MODEL',
                type: 'VIEW_FILE',
                status: 'DONE',
                created_at: '2026-10-26T23:26:02Z',
                content: 'Created At: 2026-10-27\nShowing lines 1 to 10\n1: # Secret File Dump'
            }),
            JSON.stringify({
                step_index: 9,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-10-26T23:26:10Z',
                content: '<USER_REQUEST>\nповторный запрос пользователя\n</USER_REQUEST>'
            })
        ].join('\n');

        const parsed = (syncManager as any).parseTranscriptJsonl(transcriptLines);
        expect(parsed.steps.length).toBeGreaterThanOrEqual(6);
        expect(parsed.metadata.length).toBe(2);

        // User message is stripped of internal XML wrappers
        expect(parsed.steps[0].type).toBe('CORTEX_STEP_TYPE_USER_INPUT');
        expect(parsed.steps[0].userInput.userResponse).toBe('проведи аудит приложения');
        expect(parsed.steps[0].timestamp).toBe(new Date('2026-10-26T23:25:28Z').getTime());

        // Tool output from GENERIC is attached to the pending toolCall instead of creating a raw AI bubble
        expect(parsed.steps[1].type).toBe('CORTEX_STEP_TYPE_PLANNER_RESPONSE');
        expect(parsed.steps[1].plannerResponse.toolCalls[0].name).toBe('run_command');
        expect(parsed.steps[1].plannerResponse.toolCalls[0].arguments.CommandLine).toBe('git status');
        expect(parsed.steps[1].plannerResponse.toolCalls[0].output).toContain('On branch master');

        // Typed tool results (LIST_DIRECTORY, VIEW_FILE) are attached to pending toolCalls, NOT emitted as open MODEL_RESPONSE
        const modelResponses = parsed.steps.filter((s: any) => s.type === 'CORTEX_STEP_TYPE_MODEL_RESPONSE');
        expect(modelResponses).toHaveLength(1);
        expect(modelResponses[0].modelResponse.text).toBe('Аудит завершён: найдено 3 проблемы.');

        // Render via getChatHtml: no empty `{}` JSON dumps, no raw XML tags, no raw LIST_DIRECTORY/VIEW_FILE dumps,
        // and THINKING_GROUP before a USER_INPUT is labeled AI (not User)
        const html: string = (syncManager as any).getChatHtml('audit.db', parsed.steps, parsed.metadata);
        expect(html).toContain('проведи аудит приложения');
        expect(html).toContain('повторный запрос пользователя');
        expect(html).toContain('Аудит завершён: найдено 3 проблемы.');
        expect(html).toContain('thought-box');
        expect(html).toContain('run_command');
        expect(html).toContain('Rate limit exceeded');
        expect(html).not.toContain('&lt;USER_REQUEST&gt;');
        expect(html).not.toContain('ADDITIONAL_METADATA');
        expect(html).not.toContain('USER_SETTINGS_CHANGE');
        expect(html).not.toContain('Reminder: work efficiently');
        expect(html).not.toContain('<code class="language-json">{}\n</code>');
        expect(html).not.toContain('{"name":".agents","isDir":true}');
        expect(html).not.toContain('# Secret File Dump');
        // No model bubble should be mislabeled as User
        expect(html).not.toMatch(/class="message model"[\s\S]{0,400}<span class="sender">User<\/span>/);
    });

    test('parseTranscriptJsonl strips empty USER_REQUEST + IDE action dumps, prefers transcript_full.jsonl, and renders clickable file:/// links', async () => {
        const convId = '7777aaaa-1111-1111-1111-111111111111';
        const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
        fs.mkdirSync(logsDir, { recursive: true });

        const compactLine = JSON.stringify({
            step_index: 0,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            content: 'Compact <truncated 999 bytes>'
        });
        const fullLines = [
            // Empty <USER_REQUEST> with ADDITIONAL_METADATA and IDE file dump -> must be dropped cleanly
            JSON.stringify({
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                content: '<USER_REQUEST>\n\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nActive Document: commit_msg.txt\n</ADDITIONAL_METADATA>\nThe USER performed the following action:\nShow the contents of file Cards.json'
            }),
            // Plain user prompt followed by IDE action tail -> only user prompt kept
            JSON.stringify({
                step_index: 1,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                content: 'закоммить правки на английском\n\nThe USER performed the following action:\nShow the contents of file Cards.json from lines 1 to 66'
            }),
            // Full AI answer with file:/// markdown link
            JSON.stringify({
                step_index: 2,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                content: 'Предлагаемый код для [ScoringService.cs](file:///e:/project/ScoringService.cs#L10-L20): full untruncated response.'
            })
        ].join('\n');

        fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), compactLine);
        fs.writeFileSync(path.join(logsDir, 'transcript_full.jsonl'), fullLines);

        const data = await (syncManager as any).getLocalConversationData(convId);
        expect(data).not.toBeNull();
        // Empty USER_REQUEST step skipped; only 1 clean user step + 1 full model step remain
        const userSteps = data.steps.filter((s: any) => s.type === 'CORTEX_STEP_TYPE_USER_INPUT');
        expect(userSteps).toHaveLength(1);
        expect(userSteps[0].userInput.userResponse).toBe('закоммить правки на английском');

        const html: string = (syncManager as any).getChatHtml('conv.db', data.steps, data.metadata);
        expect(html).toContain('full untruncated response.');
        expect(html).not.toContain('Compact <truncated 999 bytes>');
        expect(html).not.toContain('Show the contents of file Cards.json');
        expect(html).not.toContain('Active Document: commit_msg.txt');
        // file:/// markdown link converted to clickable file-badge inside rendered step-content
        const stepContentMatches = html.match(/<div class="step-content">[\s\S]*?<\/div>\s*<\/div>/g) || [];
        const renderedBody = stepContentMatches.join('\n');
        expect(renderedBody).toContain('data-action="open-file"');
        expect(renderedBody).toContain('data-path="e:/project/ScoringService.cs#L10-L20"');
        expect(renderedBody).toContain('ScoringService.cs');
        expect(renderedBody).not.toContain('[ScoringService.cs](file:///');
        // Clean pre code CSS reset present
        expect(html).toContain('.markdown-body pre code');
    });
});
