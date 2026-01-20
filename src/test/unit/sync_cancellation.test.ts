
// Mock vscode module BEFORE imports
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
        })),
        onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() }))
    },
    ThemeColor: jest.fn(),
    ProgressLocation: { Notification: 1 },
    CancellationError: class CancellationError extends Error {
        constructor() { super('CancellationError'); }
    },
    Uri: { file: (path: string) => ({ fsPath: path }) }
}), { virtual: true });

import * as vscode from 'vscode';
// Mock other dependencies
jest.mock('../../googleAuth');
jest.mock('../../googleDrive');
jest.mock('../../quota/quotaManager'); // Mock quota manager as it is used in SyncManager

import { SyncManager } from '../../sync';

describe('SyncManager Cancellation', () => {
    let syncManager: SyncManager;
    let mockContext: any;
    let mockAuthProvider: any;

    beforeEach(() => {
        mockContext = {
            subscriptions: [],
            globalState: {
                get: jest.fn(),
                update: jest.fn(),
            },
            secrets: {
                store: jest.fn(),
                get: jest.fn(),
                delete: jest.fn(),
                onDidChange: jest.fn(),
            },
            extensionUri: { fsPath: '/mock/path' }
        };

        mockAuthProvider = {
            getAccessToken: jest.fn().mockResolvedValue('mock-token'),
            signIn: jest.fn(),
            initialize: jest.fn()
        };

        // Instantiate SyncManager
        syncManager = new SyncManager(mockContext, mockAuthProvider);

        // Mock internal properties to bypass initialization checks
        (syncManager as any).config = {
            enabled: true,
            machineId: 'test-machine',
            selectedConversations: 'all'
        };
        (syncManager as any).driveService = {
            ensureSyncFolders: jest.fn(),
            uploadConversationFile: jest.fn(),
            deleteConversationFile: jest.fn(),
            downloadConversationFile: jest.fn()
        };
        (syncManager as any).masterPassword = 'test-password';

        // Mock helper methods to avoid file system calls
        (syncManager as any).isReady = jest.fn().mockReturnValue(true);
        (syncManager as any).computeConversationFileHashesAsync = jest.fn().mockResolvedValue({
            overallHash: 'hash', fileHashes: {}
        });
        (syncManager as any).getDecryptedManifest = jest.fn().mockResolvedValue({
            conversations: []
        });
        (syncManager as any).reportProgress = jest.fn();
    });

    it('syncNow should throw CancellationError if token is already cancelled', async () => {
        const token = {
            isCancellationRequested: true,
            onCancellationRequested: jest.fn()
        };

        await expect(syncManager.syncNow(undefined, token as any))
            .rejects
            .toThrow(vscode.CancellationError);
    });

    it('pushConversation should throw CancellationError if token is already cancelled', async () => {
        const token = {
            isCancellationRequested: true,
            onCancellationRequested: jest.fn()
        };

        await expect(syncManager.pushConversation('test-id', undefined, token as any))
            .rejects
            .toThrow(vscode.CancellationError);
    });

    it('pullConversation should throw CancellationError if token is already cancelled', async () => {
        const token = {
            isCancellationRequested: true,
            onCancellationRequested: jest.fn()
        };

        await expect(syncManager.pullConversation('test-id', undefined, token as any))
            .rejects
            .toThrow(vscode.CancellationError);
    });
});
