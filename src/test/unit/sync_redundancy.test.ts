
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SyncManager } from '../../sync';
import * as crypto from '../../crypto';

// Mocks
jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        withProgress: jest.fn((options, task) => {
            return task({
                report: jest.fn(),
                isCancellationRequested: false
            }, {
                isCancellationRequested: false,
                onCancellationRequested: jest.fn()
            });
        }),
        createStatusBarItem: jest.fn(() => ({
            show: jest.fn(),
            hide: jest.fn(),
            text: '',
            tooltip: ''
        }))
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key, defaultValue) => defaultValue)
        })),
        rootPath: '/mock/root'
    },
    ThemeColor: jest.fn(),
    ProgressLocation: { Notification: 1 },
    ExtensionContext: jest.fn()
}), { virtual: true });

describe('Sync Redundancy Tests', () => {
    let syncManager: SyncManager;
    let mockDriveService: any;
    let mockAuthProvider: any;
    let mockContext: any;
    let tempDir: string;
    let brainDir: string;
    let convDir: string;

    const MASTER_PASSWORD = 'test-password';
    const CONVERSATION_ID = 'test-conversation-id';

    beforeEach(() => {
        // Setup temp directories
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-redundancy-'));
        brainDir = path.join(tempDir, 'brain');
        convDir = path.join(tempDir, 'conversations');
        fs.mkdirSync(brainDir);
        fs.mkdirSync(convDir);

        // Setup Mock Context
        mockContext = {
            globalState: {
                get: jest.fn(),
                update: jest.fn()
            },
            secrets: {
                store: jest.fn(),
                get: jest.fn(),
                delete: jest.fn()
            },
            extensionPath: tempDir
        };

        // Mock Drive Service
        mockDriveService = {
            getManifest: jest.fn(),
            uploadConversationFile: jest.fn(),
            deleteConversationFile: jest.fn(),
            updateManifest: jest.fn(),
            ensureSyncFolders: jest.fn()
        };

        // Mock Auth Provider
        mockAuthProvider = {
            getAccessToken: jest.fn().mockResolvedValue('mock-token')
        };

        // Initialize SyncManager with mocks
        syncManager = new SyncManager(mockContext, mockAuthProvider);
        (syncManager as any).driveService = mockDriveService;
        (syncManager as any).masterPassword = MASTER_PASSWORD;
        (syncManager as any).brainDir = brainDir; // Override private property
        (syncManager as any).convDir = convDir; // Override private property

        // Mock getFullPathForRelative to use our temp dir
        (syncManager as any).getFullPathForRelative = (convId: string, relativePath: string) => {
            if (relativePath.startsWith('conversations/')) {
                return path.join(convDir, relativePath.replace('conversations/', ''));
            } else {
                return path.join(brainDir, relativePath.replace('brain/', ''));
            }
        };

        // Mock config
        (syncManager as any).config = {
            machineId: 'test-machine',
            machineName: 'Test Machine'
        };

        // MOCK PRIVATE METHOD OVERRIDE
        // Because getFullPathForRelative/brainDir logic is hard to replicate exactly with mocks in this unit test structure
        // we mock the internal hash computation to return predictable paths that match our expectations.
        (syncManager as any).computeConversationFileHashesAsync = async (convId: string) => {
            const fileName = 'test.txt';
            const relativePath = `brain/${convId}/${fileName}`;
            const fileContent = 'Hello World'; // Default content
            const hash = crypto.computeMd5Hash(Buffer.from(fileContent));

            return {
                overallHash: hash,
                fileHashes: {
                    [relativePath]: {
                        hash: hash,
                        size: fileContent.length,
                        lastModified: new Date().toISOString()
                    }
                },
                maxMtime: Date.now()
            };
        };

        // Mock getLocalConversationsAsync to return our conversation
        (syncManager as any).getLocalConversationsAsync = jest.fn().mockResolvedValue([
            { id: CONVERSATION_ID, hash: 'local-hash', lastModified: new Date().toISOString() }
        ]);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        jest.clearAllMocks();
    });

    test('pushConversation should NOT upload file if remote hash matches', async () => {
        // 1. Create local file
        const fileName = 'test.txt';
        const fileContent = 'Hello World';
        const convPath = path.join(brainDir, CONVERSATION_ID);
        fs.mkdirSync(convPath);
        fs.writeFileSync(path.join(convPath, fileName), fileContent);

        // 2. Compute expected hash
        const expectedHash = crypto.computeMd5Hash(Buffer.from(fileContent));
        const relativePath = `brain/${CONVERSATION_ID}/${fileName}`;

        // 3. Mock Manifest with matching hash
        const mockManifest = {
            conversations: [{
                id: CONVERSATION_ID,
                fileHashes: {
                    [relativePath]: {
                        hash: expectedHash,
                        size: fileContent.length,
                        lastModified: new Date().toISOString()
                    }
                }
            }]
        };
        const encryptedManifest = crypto.encrypt(Buffer.from(JSON.stringify(mockManifest)), MASTER_PASSWORD);
        mockDriveService.getManifest.mockResolvedValue(encryptedManifest);

        // 4. Run pushConversation
        await syncManager.pushConversation(CONVERSATION_ID);

        // 5. Verify uploadConversationFile was NOT called
        expect(mockDriveService.uploadConversationFile).not.toHaveBeenCalled();

        // 6. Verify getManifest was called with true (force refresh)
        // In the real implementation, getDecryptedManifest calls cache check first. 
        // But since we mocked getManifest directly on driveService (which is called by getDecryptedManifest(true)),
        // checking that getManifest was called implies getDecryptedManifest(true) was called correctly 
        // assuming typical flow. 
        // More strictly: existing tests show getDecryptedManifest(true) calls driveService.getManifest(). 
        // If it was false, it might use cache and NOT call driveService.getManifest() if cache was hot.
        // But here cache is cold so it would call anyway.
        // However, the verify is valid for ensuring flow does reach remote fetch.
        expect(mockDriveService.getManifest).toHaveBeenCalled();
    });

    test('pushConversation SHOULD upload file if remote hash differs', async () => {
        // 1. Create local file
        const fileName = 'test.txt';
        const fileContent = 'Hello World';
        const convPath = path.join(brainDir, CONVERSATION_ID);
        fs.mkdirSync(convPath);
        fs.writeFileSync(path.join(convPath, fileName), fileContent);

        // 2. Mock Manifest with DIFFERENT hash
        const relativePath = `brain/${CONVERSATION_ID}/${fileName}`;
        const mockManifest = {
            conversations: [{
                id: CONVERSATION_ID,
                fileHashes: {
                    [relativePath]: {
                        hash: 'different-hash',
                        size: 100,
                        lastModified: new Date().toISOString()
                    }
                }
            }]
        };
        const encryptedManifest = crypto.encrypt(Buffer.from(JSON.stringify(mockManifest)), MASTER_PASSWORD);
        mockDriveService.getManifest.mockResolvedValue(encryptedManifest);

        // 4. Run pushConversation
        await syncManager.pushConversation(CONVERSATION_ID);

        // 5. Verify uploadConversationFile WAS called
        expect(mockDriveService.uploadConversationFile).toHaveBeenCalledTimes(1);
        expect(mockDriveService.uploadConversationFile).toHaveBeenCalledWith(
            CONVERSATION_ID,
            relativePath,
            expect.any(Buffer) // Encrypted content
        );
    });

    test('pushConversation SHOULD upload file if remote is missing it', async () => {
        // 1. Create local file
        const fileName = 'test.txt';
        const fileContent = 'Hello World';
        const convPath = path.join(brainDir, CONVERSATION_ID);
        fs.mkdirSync(convPath);
        fs.writeFileSync(path.join(convPath, fileName), fileContent);

        // 2. Mock Manifest WITHOUT the file
        const mockManifest = {
            conversations: [{
                id: CONVERSATION_ID,
                fileHashes: {} // Empty
            }]
        };
        const encryptedManifest = crypto.encrypt(Buffer.from(JSON.stringify(mockManifest)), MASTER_PASSWORD);
        mockDriveService.getManifest.mockResolvedValue(encryptedManifest);

        // 3. Run pushConversation
        await syncManager.pushConversation(CONVERSATION_ID);

        // 4. Verify uploadConversationFile WAS called
        const relativePath = `brain/${CONVERSATION_ID}/${fileName}`;
        expect(mockDriveService.uploadConversationFile).toHaveBeenCalledWith(
            CONVERSATION_ID,
            relativePath,
            expect.any(Buffer)
        );
    });

    test('getDecryptedManifest(true) bypasses cache', async () => {
        // 1. Setup mock manifest
        const mockManifest = { version: 1, conversations: [] };
        const encryptedManifest = crypto.encrypt(Buffer.from(JSON.stringify(mockManifest)), MASTER_PASSWORD);
        mockDriveService.getManifest.mockResolvedValue(encryptedManifest);

        // 2. Call with forceRefresh = true
        await syncManager.getDecryptedManifest(true);

        // 3. Call again with forceRefresh = true
        await syncManager.getDecryptedManifest(true);

        // 4. Verify driveService.getManifest called twice (no caching)
        expect(mockDriveService.getManifest).toHaveBeenCalledTimes(2);
    });
});
