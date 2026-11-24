jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((_key: string, defaultValue?: any) => defaultValue)
        }))
    },
    env: { language: 'en' }
}), { virtual: true });

import { SyncStatsWebview, SyncStatsData } from '../../quota/syncStatsWebview';

describe('Sync Statistics Logic', () => {
    test('identifies Local Only and Remote Only conversations', () => {
        const local = [{ id: 'local1' }, { id: 'shared1' }];
        const remote = [{ id: 'remote1' }, { id: 'shared1' }];

        const localOnly = local.filter(l => !remote.find(r => r.id === l.id));
        const remoteOnly = remote.filter(r => !local.find(l => l.id === r.id));

        expect(localOnly.length).toBe(1);
        expect(localOnly[0].id).toBe('local1');

        expect(remoteOnly.length).toBe(1);
        expect(remoteOnly[0].id).toBe('remote1');
    });

    test('calculates upload and download sizes correctly', () => {
        const currentMachine = { id: 'machineA', name: 'PC-A' };
        // const otherMachine = { id: 'machineB', name: 'PC-B' };

        const remoteManifest = {
            conversations: [
                { id: 'c1', createdBy: 'machineA', size: 100 }, // Uploaded by A
                { id: 'c2', createdBy: 'machineB', size: 200 }, // Uploaded by B
                { id: 'c3', createdBy: 'machineA', size: 50 }   // Uploaded by A
            ]
        };

        // Machine A state: Has c1, c2, c3
        const machineAState = {
            id: 'machineA',
            conversationStates: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]
        };

        // Calculate Uploads for A (Created by A)
        const uploadsA = remoteManifest.conversations.filter(c => c.createdBy === currentMachine.id);
        const uploadSizeA = uploadsA.reduce((acc, c) => acc + c.size, 0);
        expect(uploadsA.length).toBe(2);
        expect(uploadSizeA).toBe(150);

        // Calculate Downloads for A (Present on A, but NOT created by A)
        const downloadsA = machineAState.conversationStates.filter(s => {
            const conv = remoteManifest.conversations.find(c => c.id === s.id);
            return conv && conv.createdBy !== currentMachine.id;
        });
        const downloadSizeA = downloadsA.reduce((acc, s) => {
            const conv = remoteManifest.conversations.find(c => c.id === s.id);
            return acc + (conv ? conv.size : 0);
        }, 0);

        expect(downloadsA.length).toBe(1); // Only c2
        expect(downloadsA[0].id).toBe('c2');
        expect(downloadSizeA).toBe(200);
    });

    test('calculates percentage for pie charts correctly', () => {
        const local = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }]; // 4 total
        const remote = [{ id: '3' }, { id: '4' }, { id: '5' }, { id: '6' }, { id: '7' }]; // 5 total

        // Synced = Intersection (3, 4) -> Count 2
        const syncedCount = local.filter(l => remote.some(r => r.id === l.id)).length;
        expect(syncedCount).toBe(2);

        // Local Pct: 2 synced / 4 total = 50%
        const localPct = (syncedCount / local.length) * 100;
        expect(localPct).toBe(50);

        // Remote Pct: 2 synced / 5 total = 40%
        const remotePct = (syncedCount / remote.length) * 100;
        expect(remotePct).toBe(40);
    });

    test('SyncStatsWebview hides epoch (1970-01-01) reset timestamps and displays valid future reset timestamps', () => {
        const futureReset = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const data: SyncStatsData = {
            localConversations: [],
            remoteManifest: {
                version: 1,
                createdAt: new Date().toISOString(),
                lastModified: new Date().toISOString(),
                passwordVerificationSalt: 's',
                passwordVerificationHash: 'h',
                conversations: []
            },
            localCount: 0,
            remoteCount: 0,
            lastSync: new Date().toISOString(),
            machines: [
                {
                    id: 'machine-1',
                    name: 'PC',
                    fileId: 'current',
                    lastSync: new Date().toISOString(),
                    isCurrent: true,
                    syncCount: 1,
                    uploadCount: 0,
                    downloadCount: 0,
                    conversationStates: [],
                    accountQuota: {
                        timestamp: new Date(),
                        models: [
                            {
                                label: 'Claude and GPT models (5-Hour Limit)',
                                modelId: 'claude-5h',
                                remainingFraction: 1,
                                remainingPercentage: 100,
                                isExhausted: false,
                                resetTime: new Date(0),
                                timeUntilReset: 0,
                                timeUntilResetFormatted: ''
                            },
                            {
                                label: 'Gemini Models (5-Hour Limit)',
                                modelId: 'gemini-5h',
                                remainingFraction: 0.64,
                                remainingPercentage: 64,
                                isExhausted: false,
                                resetTime: futureReset,
                                timeUntilReset: 2 * 60 * 60 * 1000,
                                timeUntilResetFormatted: '2h'
                            }
                        ]
                    }
                }
            ],
            loadTime: 10,
            currentMachineId: 'machine-1'
        };

        const html: string = (SyncStatsWebview as any).getHtmlContent(data);
        expect(html).not.toContain('Jan 1');
        expect(html).not.toContain('1970');
        // Valid Gemini bucket still renders its reset info
        expect(html).toContain('Reset at');
    });

    test('SyncStatsWebview filters active/archived/all conversations and switches archive/unarchive actions', () => {
        const data: SyncStatsData = {
            localConversations: [
                { id: 'conv-active', title: 'Active Chat', lastModified: '2026-11-25T01:00:00Z' },
                { id: 'conv-archived', title: 'Old Archived Chat', lastModified: '2026-10-01T01:00:00Z' }
            ],
            remoteManifest: {
                version: 1,
                createdAt: '2026-01-01T00:00:00Z',
                lastModified: '2026-11-25T01:00:00Z',
                passwordVerificationSalt: 's',
                passwordVerificationHash: 'h',
                conversations: [
                    {
                        id: 'conv-active',
                        title: 'Active Chat',
                        lastModified: '2026-11-25T01:00:00Z',
                        hash: 'h1',
                        modifiedBy: 'machine-1'
                    }
                ]
            },
            archivedIds: ['conv-archived'],
            localCount: 2,
            remoteCount: 1,
            lastSync: '2026-11-25T01:00:00Z',
            machines: [],
            loadTime: 5,
            currentMachineId: 'machine-1'
        };

        try {
            // Default filter: active only
            SyncStatsWebview.setConversationsFilter('active');
            const activeHtml: string = (SyncStatsWebview as any).getHtmlContent(data);
            expect(activeHtml).toContain('Active (1)');
            expect(activeHtml).toContain('Archived (1)');
            expect(activeHtml).toContain('All (2)');
            expect(activeHtml).toContain('Active Chat');
            expect(activeHtml).not.toContain('Old Archived Chat');
            expect(activeHtml).toContain("postCommand('archiveConversation', {id:'conv-active'})");

            // Archived filter: archived only, shows unarchive button and hides push/pull
            SyncStatsWebview.setConversationsFilter('archived');
            const archivedHtml: string = (SyncStatsWebview as any).getHtmlContent(data);
            expect(archivedHtml).toContain('Old Archived Chat');
            expect(archivedHtml).not.toContain('Active Chat');
            expect(archivedHtml).toContain("postCommand('unarchiveConversation', {id:'conv-archived'})");
            expect(archivedHtml).not.toContain("postCommand('pushConversation', {id:'conv-archived'})");

            // All filter: shows both
            SyncStatsWebview.setConversationsFilter('all');
            const allHtml: string = (SyncStatsWebview as any).getHtmlContent(data);
            expect(allHtml).toContain('Active Chat');
            expect(allHtml).toContain('Old Archived Chat');
        } finally {
            SyncStatsWebview.setConversationsFilter('active');
        }
    });
});
