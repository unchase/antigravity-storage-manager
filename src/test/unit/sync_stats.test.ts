
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
});
