import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showQuickPick: jest.fn()
    },
    workspace: {
        getConfiguration: jest.fn(() => ({ get: jest.fn() }))
    }
}), { virtual: true });

import {
    resolveStrictChildPath,
    scanConflictCopies,
    applyKeepConflictSafely
} from '../../conflicts';

describe('Conflicts Safety & Transactional Replacement', () => {
    let tempDir: string;
    let brainDir: string;
    let convDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-conflicts-test-'));
        brainDir = path.join(tempDir, 'brain');
        convDir = path.join(tempDir, 'conversations');
        fs.mkdirSync(brainDir, { recursive: true });
        fs.mkdirSync(convDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('resolveStrictChildPath blocks path traversal and parent escapes', () => {
        expect(() => resolveStrictChildPath(brainDir, '..')).toThrow();
        expect(() => resolveStrictChildPath(brainDir, '../outside')).toThrow();
        expect(() => resolveStrictChildPath(brainDir, 'a/../../outside')).toThrow();
        expect(() => resolveStrictChildPath(brainDir, path.join(tempDir, 'outside'))).toThrow();

        const valid = resolveStrictChildPath(brainDir, 'conv-123');
        expect(valid).toBe(path.join(brainDir, 'conv-123'));
    });

    test('scanConflictCopies ignores traversal-like names and finds both brain and conv-only conflicts', () => {
        const origId = '11111111-1111-1111-1111-111111111111';
        const conflictId1 = `${origId}-conflict-1700000000000`;
        fs.mkdirSync(path.join(brainDir, origId));
        fs.mkdirSync(path.join(brainDir, conflictId1));

        // Malicious traversal-like folder name must be ignored
        fs.mkdirSync(path.join(brainDir, '..-conflict-1700000000001'));

        // Conversation-only conflict (no brain dir)
        const convOnlyOrig = '22222222-2222-2222-2222-222222222222';
        const convOnlyConflict = `${convOnlyOrig}-conflict-1700000000002`;
        fs.writeFileSync(path.join(convDir, `${convOnlyConflict}.db`), 'db-data');

        const pairs = scanConflictCopies(brainDir, convDir);
        const conflictIds = pairs.map(p => p.conflictId);

        expect(conflictIds).toContain(conflictId1);
        expect(conflictIds).toContain(convOnlyConflict);
        expect(conflictIds).not.toContain('..-conflict-1700000000001');
    });

    test('scanConflictCopies handles missing brainDir gracefully', () => {
        fs.rmSync(brainDir, { recursive: true, force: true });
        const convConflict = '33333333-3333-3333-3333-333333333333-conflict-1700000000003';
        fs.writeFileSync(path.join(convDir, `${convConflict}.pb`), 'pb-data');

        const pairs = scanConflictCopies(brainDir, convDir);
        expect(pairs).toHaveLength(1);
        expect(pairs[0].conflictId).toBe(convConflict);
    });

    test('applyKeepConflictSafely replaces original brain & db/wal and removes ephemeral .db-shm', () => {
        const origId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const conflictId = `${origId}-conflict-1700000000010`;

        fs.mkdirSync(path.join(brainDir, origId));
        fs.writeFileSync(path.join(brainDir, origId, 'task.md'), '# Original');
        fs.writeFileSync(path.join(convDir, `${origId}.db`), 'orig-db');
        fs.writeFileSync(path.join(convDir, `${origId}.db-wal`), 'orig-wal');
        fs.writeFileSync(path.join(convDir, `${origId}.db-shm`), 'orig-shm');

        fs.mkdirSync(path.join(brainDir, conflictId));
        fs.writeFileSync(path.join(brainDir, conflictId, 'task.md'), '# Conflict Copy');
        fs.writeFileSync(path.join(convDir, `${conflictId}.db`), 'conflict-db');

        applyKeepConflictSafely(brainDir, convDir, origId, conflictId);

        expect(fs.readFileSync(path.join(brainDir, origId, 'task.md'), 'utf8')).toBe('# Conflict Copy');
        expect(fs.readFileSync(path.join(convDir, `${origId}.db`), 'utf8')).toBe('conflict-db');
        // Stale original wal and shm must be gone!
        expect(fs.existsSync(path.join(convDir, `${origId}.db-wal`))).toBe(false);
        expect(fs.existsSync(path.join(convDir, `${origId}.db-shm`))).toBe(false);
        // Conflict copy cleaned up
        expect(fs.existsSync(path.join(brainDir, conflictId))).toBe(false);
        expect(fs.existsSync(path.join(convDir, `${conflictId}.db`))).toBe(false);
    });

    test('applyKeepConflictSafely rolls back original files if replacement fails mid-way', () => {
        const origId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const conflictId = `${origId}-conflict-1700000000020`;

        fs.mkdirSync(path.join(brainDir, origId));
        fs.writeFileSync(path.join(brainDir, origId, 'task.md'), '# Original Intact');
        fs.writeFileSync(path.join(convDir, `${origId}.db`), 'original-db-bytes');

        fs.mkdirSync(path.join(brainDir, conflictId));
        fs.writeFileSync(path.join(brainDir, conflictId, 'task.md'), '# Conflict');
        fs.writeFileSync(path.join(convDir, `${conflictId}.db`), 'conflict-db');

        // Inject failing renameFn when moving conflict .db into place
        const failingRename = (oldP: fs.PathLike, newP: fs.PathLike) => {
            if (String(oldP).endsWith(`${conflictId}.db`)) {
                throw Object.assign(new Error('EBUSY simulated'), { code: 'EBUSY' });
            }
            fs.renameSync(oldP, newP);
        };

        expect(() => applyKeepConflictSafely(brainDir, convDir, origId, conflictId, failingRename)).toThrow(/EBUSY/);

        // Original files must be restored intact!
        expect(fs.readFileSync(path.join(brainDir, origId, 'task.md'), 'utf8')).toBe('# Original Intact');
        expect(fs.readFileSync(path.join(convDir, `${origId}.db`), 'utf8')).toBe('original-db-bytes');
    });
});
