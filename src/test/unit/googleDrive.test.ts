jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn()
    },
    EventEmitter: class {
        event = jest.fn(() => ({ dispose: jest.fn() }));
        fire = jest.fn();
        dispose = jest.fn();
    }
}), { virtual: true });

import {
    GoogleDriveService,
    escapeDriveQuery,
    isRetryableDriveError,
    isInsufficientPermissionError
} from '../../googleDrive';

describe('GoogleDriveService Query Escaping, Retries, Pagination & Locks', () => {
    let mockFilesList: jest.Mock;
    let mockFilesCreate: jest.Mock;
    let mockFilesUpdate: jest.Mock;
    let mockFilesDelete: jest.Mock;
    let mockFilesGet: jest.Mock;
    let mockAuthProvider: any;
    let service: GoogleDriveService;

    beforeEach(() => {
        mockFilesList = jest.fn();
        mockFilesCreate = jest.fn();
        mockFilesUpdate = jest.fn();
        mockFilesDelete = jest.fn();
        mockFilesGet = jest.fn();

        const fakeOAuthClient = {};
        mockAuthProvider = {
            onDidChangeSessions: jest.fn(() => ({ dispose: jest.fn() })),
            getOAuth2Client: jest.fn(() => fakeOAuthClient)
        };

        service = new GoogleDriveService(mockAuthProvider);
        (service as any)._drive = {
            files: {
                list: mockFilesList,
                create: mockFilesCreate,
                update: mockFilesUpdate,
                delete: mockFilesDelete,
                get: mockFilesGet
            },
            about: { get: jest.fn() }
        };
        (service as any).lastAuthClient = fakeOAuthClient;
        (service as any).syncFolderId = 'sync-folder-1';
        (service as any).machinesFolderId = 'machines-folder-1';
        (service as any).conversationsFolderId = 'convs-folder-1';
    });

    afterEach(() => {
        service.dispose();
    });

    test('escapeDriveQuery escapes backslashes and single quotes', () => {
        expect(escapeDriveQuery("foo'bar\\baz")).toBe("foo\\'bar\\\\baz");
        expect(escapeDriveQuery("name' or '1'='1")).toBe("name\\' or \\'1\\'=\\'1");
    });

    test('distinguishes retryable rate-limit 403 from permanent insufficientPermissions 403', () => {
        const rateLimit403 = {
            code: 403,
            errors: [{ reason: 'userRateLimitExceeded' }],
            message: 'User Rate Limit Exceeded'
        };
        expect(isRetryableDriveError(rateLimit403)).toBe(true);
        expect(isInsufficientPermissionError(rateLimit403)).toBe(false);

        const perm403 = {
            code: 403,
            errors: [{ reason: 'insufficientPermissions' }],
            message: 'Insufficient Permission'
        };
        expect(isRetryableDriveError(perm403)).toBe(false);
        expect(isInsufficientPermissionError(perm403)).toBe(true);

        expect(isRetryableDriveError({ response: { status: 429 }, message: 'Too Many Requests' })).toBe(true);
        expect(isRetryableDriveError({ response: { status: 503 }, message: 'Service Unavailable' })).toBe(true);
        expect(isRetryableDriveError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(true);
    });

    test('listConversations paginates across multiple nextPageToken pages', async () => {
        mockFilesList
            .mockResolvedValueOnce({
                data: {
                    files: [{ id: 'f1', name: 'c1', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01T00:00:00Z' }],
                    nextPageToken: 'page-2'
                }
            })
            .mockResolvedValueOnce({
                data: {
                    files: [{ id: 'f2', name: 'c2.zip.enc', mimeType: 'application/octet-stream', modifiedTime: '2026-01-02T00:00:00Z' }],
                    nextPageToken: undefined
                }
            });

        const list = await service.listConversations();
        expect(list).toHaveLength(2);
        expect(list.map(f => f.id)).toEqual(['f1', 'f2']);
        expect(mockFilesList).toHaveBeenCalledTimes(2);
        expect(mockFilesList.mock.calls[1][0].pageToken).toBe('page-2');
    });

    test('deleteConversation removes both legacy .zip.enc files and v2 folders', async () => {
        mockFilesList.mockResolvedValueOnce({
            data: {
                files: [
                    { id: 'zip-id', name: 'conv-1.zip.enc', mimeType: 'application/octet-stream' },
                    { id: 'folder-id', name: 'conv-1', mimeType: 'application/vnd.google-apps.folder' }
                ]
            }
        });
        mockFilesDelete.mockResolvedValue({});

        await service.deleteConversation('conv-1');

        expect(mockFilesDelete).toHaveBeenCalledTimes(2);
        expect(mockFilesDelete).toHaveBeenCalledWith({ fileId: 'zip-id' });
        expect(mockFilesDelete).toHaveBeenCalledWith({ fileId: 'folder-id' });
    });

    test('acquireLock fails closed on network error reading existing lock and does NOT delete foreign lock', async () => {
        mockFilesList.mockResolvedValueOnce({
            data: { files: [{ id: 'foreign-lock-1' }] }
        });
        // Simulate permanent/non-retryable error reading foreign lock
        mockFilesGet.mockRejectedValue(new Error('Fatal read error'));

        const acquired = await service.acquireLock('machine-A', 60000);
        expect(acquired).toBe(false);
        expect(mockFilesDelete).not.toHaveBeenCalled();
        expect(mockFilesCreate).not.toHaveBeenCalled();
    });

    test('acquireLock detects concurrent race via post-create verification and cleans up own lock', async () => {
        const foreignLockPayload = Buffer.from(JSON.stringify({
            machineId: 'machine-B',
            token: 'tok-B',
            expiresAt: Date.now() + 60000
        }));

        // 1st list: appears empty
        mockFilesList
            .mockResolvedValueOnce({ data: { files: [] } })
            // 2nd list (post-create verification): foreign lock was created right before ours
            .mockResolvedValueOnce({
                data: {
                    files: [
                        { id: 'lock-B', createdTime: '2026-01-01T00:00:00.001Z' },
                        { id: 'lock-A', createdTime: '2026-01-01T00:00:00.002Z' }
                    ]
                }
            });

        mockFilesCreate.mockResolvedValueOnce({ data: { id: 'lock-A' } });
        mockFilesGet.mockResolvedValueOnce({ data: foreignLockPayload });
        mockFilesDelete.mockResolvedValue({});

        const acquired = await service.acquireLock('machine-A', 60000);
        expect(acquired).toBe(false);
        // Must delete ONLY our own losing lock, never lock-B
        expect(mockFilesDelete).toHaveBeenCalledTimes(1);
        expect(mockFilesDelete).toHaveBeenCalledWith({ fileId: 'lock-A' });
    });
});
