import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import extract from 'extract-zip';

let mockConfigValues: Record<string, any> = {};

jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn()
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key: string, defaultValue?: any) => (
                key in mockConfigValues ? mockConfigValues[key] : defaultValue
            ))
        })),
        onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() }))
    },
    CancellationError: class CancellationError extends Error {
        constructor() { super('Cancelled'); }
    }
}), { virtual: true });

import { BackupManager } from '../../backup';

describe('BackupManager Reliability & Safety', () => {
    let tempDir: string;
    let storageRoot: string;
    let backupDir: string;
    let mockContext: any;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-backup-test-'));
        storageRoot = path.join(tempDir, 'storage');
        backupDir = path.join(tempDir, 'backups');
        fs.mkdirSync(path.join(storageRoot, 'brain', 'conv-1'), { recursive: true });
        fs.mkdirSync(path.join(storageRoot, 'conversations'), { recursive: true });
        fs.writeFileSync(path.join(storageRoot, 'brain', 'conv-1', 'task.md'), '# Task 1');
        fs.writeFileSync(path.join(storageRoot, 'conversations', 'conv-1.db'), 'sqlite-content');
        fs.writeFileSync(path.join(storageRoot, 'conversations', 'conv-1.db-shm'), 'ephemeral-shm');

        mockConfigValues = {
            enabled: false,
            interval: 24,
            path: backupDir,
            retention: 2
        };

        mockContext = {
            subscriptions: [],
            globalState: { get: jest.fn(), update: jest.fn() }
        };
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('backupNow with explicit .zip path writes directly to that file and excludes .db-shm', async () => {
        const manager = new BackupManager(mockContext, storageRoot);
        const explicitZip = path.join(tempDir, 'my-manual-backup.zip');

        const resultPath = await manager.backupNow(explicitZip);
        expect(resultPath).toBe(explicitZip);
        expect(fs.existsSync(explicitZip)).toBe(true);
        expect(fs.statSync(explicitZip).isFile()).toBe(true);

        // Extract and verify contents
        const extractDir = path.join(tempDir, 'extracted');
        fs.mkdirSync(extractDir);
        await extract(explicitZip, { dir: extractDir });
        expect(fs.existsSync(path.join(extractDir, 'brain', 'conv-1', 'task.md'))).toBe(true);
        expect(fs.existsSync(path.join(extractDir, 'conversations', 'conv-1.db'))).toBe(true);
        expect(fs.existsSync(path.join(extractDir, 'conversations', 'conv-1.db-shm'))).toBe(false);

        manager.dispose();
    });

    test('backupNow rejects saving backup inside brainDir or convDir', async () => {
        const manager = new BackupManager(mockContext, storageRoot);
        await expect(manager.backupNow(path.join(storageRoot, 'brain'))).rejects.toThrow(/cannot be inside/i);
        await expect(manager.backupNow(path.join(storageRoot, 'conversations', 'bad.zip'))).rejects.toThrow(/cannot be inside/i);
        manager.dispose();
    });

    test('backupNow with directory path enforces retention safely (including fractional retention < 1)', async () => {
        mockConfigValues['retention'] = 0.5;
        const manager = new BackupManager(mockContext, storageRoot);

        // Pre-create old backup files with matching managed naming prefix
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, 'backup-2025-01-01T00-00-00.zip'), 'old1');
        fs.writeFileSync(path.join(backupDir, 'backup-2025-01-02T00-00-00.zip'), 'old2');

        const created = await manager.backupNow(backupDir);
        expect(fs.existsSync(created)).toBe(true);
        // Fractional retention 0.5 floors to 0 (retention disabled -> keeps all instead of deleting everything!)
        const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip'));
        expect(files.length).toBe(3);

        // Now test retention = 2
        mockConfigValues['retention'] = 2;
        await new Promise(r => setTimeout(r, 15));
        await manager.backupNow(backupDir);
        const filesAfter = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip'));
        expect(filesAfter.length).toBe(2);

        manager.dispose();
    });
});
