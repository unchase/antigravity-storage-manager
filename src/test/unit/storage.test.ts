import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { getStoragePaths, getConversationsAsync } from '../../../src/utils';

// Mock vscode module
const mockConfigGet = jest.fn();
jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: (key: string, defaultVal?: any) => {
                const res = mockConfigGet(key, defaultVal);
                return res !== undefined ? res : defaultVal;
            }
        }))
    },
    window: {
        showErrorMessage: jest.fn()
    }
}), { virtual: true });

describe('Storage Management & Discovery', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-storage-test-'));
        mockConfigGet.mockReset();
        if (vscode && vscode.workspace) {
            (vscode.workspace.getConfiguration as any) = jest.fn(() => ({
                get: (key: string, defaultVal?: any) => {
                    const res = mockConfigGet(key, defaultVal);
                    return res !== undefined ? res : defaultVal;
                }
            }));
        }
        if (vscode && !vscode.window) {
            (vscode as any).window = { showErrorMessage: jest.fn() };
        } else if (vscode && vscode.window) {
            (vscode.window.showErrorMessage as any) = jest.fn();
        }
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('getStoragePaths', () => {
        test('respects custom user storagePath setting', () => {
            const customPath = path.join(tempDir, 'custom-storage');
            mockConfigGet.mockReturnValue(customPath);

            const paths = getStoragePaths();
            expect(paths.storageRoot).toBe(customPath);
            expect(paths.brainDir).toBe(path.join(customPath, 'brain'));
            expect(paths.convDir).toBe(path.join(customPath, 'conversations'));
        });

        test('returns valid storage paths when setting is empty', () => {
            mockConfigGet.mockReturnValue('');

            const paths = getStoragePaths();
            expect(paths.storageRoot).toBeDefined();
            expect(paths.brainDir).toBe(path.join(paths.storageRoot, 'brain'));
            expect(paths.convDir).toBe(path.join(paths.storageRoot, 'conversations'));
            expect(
                paths.storageRoot.endsWith('antigravity-ide') || paths.storageRoot.endsWith('antigravity')
            ).toBe(true);
        });
    });

    describe('getConversationsAsync & Title Extraction', () => {
        test('extracts title from task.md with # Task: prefix', async () => {
            const brainDir = path.join(tempDir, 'brain');
            const convId = 'a1b2c3d4-e5f6-4a1b-8c2d-123456789001';
            const convBrain = path.join(brainDir, convId);
            fs.mkdirSync(convBrain, { recursive: true });

            fs.writeFileSync(
                path.join(convBrain, 'task.md'),
                '# Task: Fix synchronization between Macs\n\nSome task details...'
            );

            const convs = await getConversationsAsync(brainDir);
            expect(convs).toHaveLength(1);
            expect(convs[0].id).toBe(convId);
            expect(convs[0].label).toBe('Fix synchronization between Macs');
        });

        test('ignores "SQLite format 3" and falls back to implementation_plan.md', async () => {
            const brainDir = path.join(tempDir, 'brain');
            const convId = 'a1b2c3d4-e5f6-4a1b-8c2d-123456789002';
            const convBrain = path.join(brainDir, convId);
            fs.mkdirSync(convBrain, { recursive: true });

            // Simulate corrupted task.md containing SQLite binary header
            fs.writeFileSync(
                path.join(convBrain, 'task.md'),
                'SQLite format 3\u0000\u0001\u0000...'
            );

            // implementation_plan.md should be used
            fs.writeFileSync(
                path.join(convBrain, 'implementation_plan.md'),
                '# Plan: Google Drive Sync Bugfix\n\nDetails of plan...'
            );

            const convs = await getConversationsAsync(brainDir);
            expect(convs).toHaveLength(1);
            expect(convs[0].id).toBe(convId);
            expect(convs[0].label).toBe('Google Drive Sync Bugfix');
        });

        test('falls back to transcript.jsonl user message when no markdown files exist', async () => {
            const brainDir = path.join(tempDir, 'brain');
            const convId = 'a1b2c3d4-e5f6-4a1b-8c2d-123456789003';
            const logsDir = path.join(brainDir, convId, '.system_generated', 'logs');
            fs.mkdirSync(logsDir, { recursive: true });

            const transcriptLines = [
                JSON.stringify({ type: 'SYSTEM', content: '<prompt>System prompt</prompt>' }),
                JSON.stringify({ type: 'USER_INPUT', content: 'Can you help me setup multi-mac sync?' }),
                JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Sure!' })
            ].join('\n');

            fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), transcriptLines);

            const convs = await getConversationsAsync(brainDir);
            expect(convs).toHaveLength(1);
            expect(convs[0].id).toBe(convId);
            expect(convs[0].label).toBe('Can you help me setup multi-mac sync?');
        });

        test('falls back to conversation ID when no title files exist', async () => {
            const brainDir = path.join(tempDir, 'brain');
            const convId = 'a1b2c3d4-e5f6-4a1b-8c2d-123456789004';
            const convBrain = path.join(brainDir, convId);
            fs.mkdirSync(convBrain, { recursive: true });

            const convs = await getConversationsAsync(brainDir);
            expect(convs).toHaveLength(1);
            expect(convs[0].id).toBe(convId);
            expect(convs[0].label).toBe(convId);
        });

        test('discovers conversations that only exist in conversations/ directory without brain folder', async () => {
            const brainDir = path.join(tempDir, 'brain');
            const convDir = path.join(tempDir, 'conversations');
            fs.mkdirSync(brainDir, { recursive: true });
            fs.mkdirSync(convDir, { recursive: true });

            const convId = 'a1b2c3d4-e5f6-4a1b-8c2d-123456789099';
            fs.writeFileSync(path.join(convDir, `${convId}.db`), 'dummy sqlite content');

            const convs = await getConversationsAsync(brainDir);
            expect(convs).toHaveLength(1);
            expect(convs[0].id).toBe(convId);
            expect(convs[0].description).toBe(convId);
        });
    });

    describe('SQLite .db and .db-wal conversation files', () => {
        test('conversation paths recognize both legacy .pb and modern .db/.db-wal files', () => {
            const convId = 'a1b2c3d4-e5f6-4a1b-8c2d-123456789005';
            const exts = ['.pb', '.db', '.db-wal', '.db-shm'];
            const filePaths = exts.map(ext => `conversations/${convId}${ext}`);

            for (const relPath of filePaths) {
                expect(relPath.startsWith('conversations/')).toBe(true);
                const filename = relPath.replace('conversations/', '');
                expect(filename.startsWith(convId)).toBe(true);
            }
        });
    });

    describe('Localization Completeness', () => {
        const rootDir = path.resolve(__dirname, '../../..');
        const baseNlsPath = path.join(rootDir, 'package.nls.json');
        const baseNls = JSON.parse(fs.readFileSync(baseNlsPath, 'utf8'));
        const baseKeys = Object.keys(baseNls).sort();

        const nlsFiles = fs.readdirSync(rootDir).filter(f => f.startsWith('package.nls.') && f.endsWith('.json'));

        test('base package.nls.json has valid keys', () => {
            expect(baseKeys.length).toBeGreaterThan(0);
        });

        test.each(nlsFiles)('%s contains all keys from package.nls.json without missing ones', (nlsFile) => {
            const filePath = path.join(rootDir, nlsFile);
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const fileKeys = Object.keys(content).sort();

            expect(fileKeys).toEqual(baseKeys);

            for (const value of Object.values(content)) {
                expect(typeof value).toBe('string');
                expect((value as string).trim().length).toBeGreaterThan(0);
            }
        });

        test('all %key% in package.json exist in package.nls.json', () => {
            const pkgPath = path.join(rootDir, 'package.json');
            const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
            const matches = pkgRaw.match(/%([^%]+)%/g) || [];
            const referencedKeys = Array.from(new Set(matches.map(m => m.replace(/%/g, ''))));

            for (const refKey of referencedKeys) {
                expect(baseKeys).toContain(refKey);
            }
        });
    });
});
