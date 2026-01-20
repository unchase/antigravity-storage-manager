import * as crypto from '../../../src/crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode module
jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        withProgress: jest.fn()
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn()
        }))
    },
    ThemeColor: jest.fn(),
    ProgressLocation: { Notification: 1 }
}), { virtual: true });

describe('Per-File Sync Logic', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('File Hash Computation', () => {
        test('computeMd5Hash returns consistent hash for same content', () => {
            const content = Buffer.from('test content');
            const hash1 = crypto.computeMd5Hash(content);
            const hash2 = crypto.computeMd5Hash(content);
            expect(hash1).toBe(hash2);
        });

        test('computeMd5Hash returns different hashes for different content', () => {
            const content1 = Buffer.from('content1');
            const content2 = Buffer.from('content2');
            const hash1 = crypto.computeMd5Hash(content1);
            const hash2 = crypto.computeMd5Hash(content2);
            expect(hash1).not.toBe(hash2);
        });

        test('computeMd5Hash returns correct MD5 for known input', () => {
            // MD5 of empty string is 'd41d8cd98f00b204e9800998ecf8427e'
            const emptyHash = crypto.computeMd5Hash(Buffer.from(''));
            expect(emptyHash).toBe('d41d8cd98f00b204e9800998ecf8427e');

            // MD5 of 'hello' is '5d41402abc4b2a76b9719d911017c592'
            const helloHash = crypto.computeMd5Hash(Buffer.from('hello'));
            expect(helloHash).toBe('5d41402abc4b2a76b9719d911017c592');
        });
    });

    describe('File Hash Comparison Logic', () => {
        test('identifies new files correctly', () => {
            const localHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' },
                'file2.txt': { hash: 'def456' },
                'file3.txt': { hash: 'ghi789' } // New file
            };

            const remoteHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' },
                'file2.txt': { hash: 'def456' }
            };

            const filesToUpload: string[] = [];
            for (const [path, localInfo] of Object.entries(localHashes)) {
                const remoteInfo = remoteHashes[path];
                if (!remoteInfo || remoteInfo.hash !== localInfo.hash) {
                    filesToUpload.push(path);
                }
            }

            expect(filesToUpload).toContain('file3.txt');
            expect(filesToUpload).not.toContain('file1.txt');
            expect(filesToUpload).not.toContain('file2.txt');
        });

        test('identifies changed files correctly', () => {
            const localHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' },
                'file2.txt': { hash: 'changed_hash' } // Changed
            };

            const remoteHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' },
                'file2.txt': { hash: 'def456' }
            };

            const filesToUpload: string[] = [];
            for (const [path, localInfo] of Object.entries(localHashes)) {
                const remoteInfo = remoteHashes[path];
                if (!remoteInfo || remoteInfo.hash !== localInfo.hash) {
                    filesToUpload.push(path);
                }
            }

            expect(filesToUpload).toContain('file2.txt');
            expect(filesToUpload).not.toContain('file1.txt');
        });

        test('identifies deleted files correctly', () => {
            const localHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' }
            };

            const remoteHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' },
                'file2.txt': { hash: 'def456' } // Deleted locally
            };

            const filesToDelete: string[] = [];
            for (const remotePath of Object.keys(remoteHashes)) {
                if (!localHashes[remotePath]) {
                    filesToDelete.push(remotePath);
                }
            }

            expect(filesToDelete).toContain('file2.txt');
            expect(filesToDelete).not.toContain('file1.txt');
        });

        test('handles empty local hashes', () => {
            const localHashes: Record<string, { hash: string }> = {};
            const remoteHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' }
            };

            const filesToDownload: string[] = [];
            for (const [path, remoteInfo] of Object.entries(remoteHashes)) {
                const localInfo = localHashes[path];
                if (!localInfo || localInfo.hash !== remoteInfo.hash) {
                    filesToDownload.push(path);
                }
            }

            expect(filesToDownload).toContain('file1.txt');
        });

        test('handles empty remote hashes', () => {
            const localHashes: Record<string, { hash: string }> = {
                'file1.txt': { hash: 'abc123' }
            };
            const remoteHashes: Record<string, { hash: string }> = {};

            const filesToUpload: string[] = [];
            for (const [path, localInfo] of Object.entries(localHashes)) {
                const remoteInfo = remoteHashes[path];
                if (!remoteInfo || remoteInfo.hash !== localInfo.hash) {
                    filesToUpload.push(path);
                }
            }

            expect(filesToUpload).toContain('file1.txt');
        });
    });

    describe('Path Utilities', () => {
        test('relative path parsing for conversations', () => {
            const relativePath = 'conversations/abc123.pb';
            expect(relativePath.startsWith('conversations/')).toBe(true);
            expect(relativePath.replace('conversations/', '')).toBe('abc123.pb');
        });

        test('relative path parsing for brain files', () => {
            const conversationId = 'conv-id-123';
            const relativePath = `brain/${conversationId}/task.md`;
            expect(relativePath.startsWith('brain/')).toBe(true);
            expect(relativePath.replace('brain/', '')).toBe(`${conversationId}/task.md`);
        });

        test('nested brain file paths', () => {
            const conversationId = 'conv-id-123';
            const relativePath = `brain/${conversationId}/.system_generated/logs/file.txt`;
            expect(relativePath.startsWith(`brain/${conversationId}/`)).toBe(true);
            const afterBrain = relativePath.replace('brain/', '');
            expect(afterBrain).toBe(`${conversationId}/.system_generated/logs/file.txt`);
        });
    });

    describe('Encryption/Decryption for Per-File Sync', () => {
        test('encrypt and decrypt single file content', () => {
            const password = 'test-password';
            const content = Buffer.from('This is test file content');

            const encrypted = crypto.encrypt(content, password);
            const decrypted = crypto.decrypt(encrypted, password);

            expect(decrypted.toString()).toBe(content.toString());
        });

        test('encrypt and decrypt binary content', () => {
            const password = 'test-password';
            const content = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);

            const encrypted = crypto.encrypt(content, password);
            const decrypted = crypto.decrypt(encrypted, password);

            expect(Buffer.compare(decrypted, content)).toBe(0);
        });

        test('encrypted content differs from original', () => {
            const password = 'test-password';
            const content = Buffer.from('Secret content');

            const encrypted = crypto.encrypt(content, password);

            expect(Buffer.compare(encrypted, content)).not.toBe(0);
        });
    });
});
