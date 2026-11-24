import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalStorageService } from '../../localStorage';

describe('LocalStorageService Security & Reliability', () => {
    let tempDir: string;
    let storageDir: string;
    let outsideFile: string;
    let service: LocalStorageService;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-local-storage-test-'));
        storageDir = path.join(tempDir, 'sync-root');
        outsideFile = path.join(tempDir, 'secret-outside.txt');
        fs.writeFileSync(outsideFile, 'do-not-delete');
        service = new LocalStorageService(storageDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('blocks Path Traversal in deleteFile, deleteConversation, and uploadConversationFile', async () => {
        await service.ensureSyncFolders();

        await expect(service.deleteFile(outsideFile)).rejects.toThrow(/outside|escapes|Invalid/i);
        await expect(service.deleteFile('../secret-outside.txt')).rejects.toThrow(/outside|escapes|Invalid/i);
        expect(fs.existsSync(outsideFile)).toBe(true);

        await expect(service.deleteConversation('../outside')).rejects.toThrow(/Invalid/i);
        await expect(service.uploadConversationFile('valid-conv', '../../escape.txt', Buffer.from('x'))).rejects.toThrow(/traversal|escapes|Invalid/i);
        await expect(service.getMachineState('../evil')).rejects.toThrow(/Invalid/i);
    });

    test('manifest, machineState, and per-file upload/download/list/delete roundtrip', async () => {
        await service.ensureSyncFolders();

        expect(await service.getManifest()).toBeNull();
        await service.updateManifest(Buffer.from('encrypted-manifest'));
        expect((await service.getManifest())?.toString()).toBe('encrypted-manifest');

        await service.updateMachineState('machine-1', Buffer.from('state-1'));
        expect((await service.getMachineState('machine-1'))?.toString()).toBe('state-1');

        const convId = 'conv-abc-123';
        await service.uploadConversationFile(convId, 'brain/conv-abc-123/task.md', Buffer.from('enc-task'), 'md5-task');
        await service.uploadConversationFile(convId, 'conversations/conv-abc-123.db', Buffer.from('enc-db'), 'md5-db');

        // Plant a stray .tmp file that must be ignored by listConversationFilesDetails
        const strayTmp = path.join(storageDir, 'AntigravitySync', 'conversations', convId, 'brain', convId, 'stray.tmp');
        fs.writeFileSync(strayTmp, 'temp');

        const details = await service.listConversationFilesDetails(convId);
        expect(details.size).toBe(2);
        expect(details.get('brain/conv-abc-123/task.md')?.originalMd5).toBe('md5-task');
        expect(details.get('conversations/conv-abc-123.db')?.originalMd5).toBe('md5-db');

        const downloaded = await service.downloadConversationFile(convId, 'brain/conv-abc-123/task.md');
        expect(downloaded?.toString()).toBe('enc-task');

        // Re-uploading without originalMd5 cleans up stale .meta sidecar
        await service.uploadConversationFile(convId, 'brain/conv-abc-123/task.md', Buffer.from('enc-task-2'));
        const detailsAfter = await service.listConversationFilesDetails(convId);
        expect(detailsAfter.get('brain/conv-abc-123/task.md')?.originalMd5).toBeUndefined();

        await service.deleteConversationFile(convId, 'brain/conv-abc-123/task.md');
        expect(await service.downloadConversationFile(convId, 'brain/conv-abc-123/task.md')).toBeNull();

        await service.deleteConversation(convId);
        expect((await service.listConversationFilesDetails(convId)).size).toBe(0);
    });

    test('atomic acquireLock (wx) prevents concurrent lock acquisition and releaseLock checks ownership', async () => {
        await service.ensureSyncFolders();

        const first = await service.acquireLock('machine-A', 60000);
        expect(first).toBe(true);

        // Concurrent machine B is blocked
        const second = await service.acquireLock('machine-B', 60000);
        expect(second).toBe(false);

        // Machine B cannot release machine A's lock
        await service.releaseLock('machine-B');
        expect(await service.acquireLock('machine-B', 60000)).toBe(false);

        // Machine A releases its own lock
        await service.releaseLock('machine-A');
        expect(await service.acquireLock('machine-B', 60000)).toBe(true);
        await service.releaseLock('machine-B');
    });

    test('acquireLock takes over expired locks', async () => {
        const { syncFolderId } = await service.ensureSyncFolders();
        const lockPath = path.join(syncFolderId, 'sync.lock');
        fs.writeFileSync(lockPath, JSON.stringify({ machineId: 'dead-machine', token: 'old', expiresAt: Date.now() - 1000 }));

        expect(await service.acquireLock('machine-C', 60000)).toBe(true);
        await service.releaseLock('machine-C');
    });

    test('getManifest propagates non-ENOENT I/O errors instead of masking them as null', async () => {
        const { syncFolderId } = await service.ensureSyncFolders();
        // Make manifest.json.enc a directory so readFile fails with EISDIR (non-ENOENT)
        fs.mkdirSync(path.join(syncFolderId, 'manifest.json.enc'));
        await expect(service.getManifest()).rejects.toThrow();
    });
});
