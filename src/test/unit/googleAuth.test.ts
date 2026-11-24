jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn().mockResolvedValue(undefined),
        showInformationMessage: jest.fn(),
        withProgress: jest.fn()
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key: string) => {
                if (key === 'google.clientId') return 'test-client-id';
                if (key === 'google.clientSecret') return 'test-client-secret';
                return '';
            })
        }))
    },
    EventEmitter: class {
        private listeners: Array<() => void> = [];
        event = (cb: () => void) => {
            this.listeners.push(cb);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== cb); } };
        };
        fire = () => { this.listeners.forEach(l => l()); };
        dispose = jest.fn();
    }
}), { virtual: true });

import {
    GoogleAuthProvider,
    escapeHtml,
    safeEqualString,
    isPermanentAuthError
} from '../../googleAuth';

describe('GoogleAuthProvider Security & Session Lifecycle', () => {
    let secretsStore: Map<string, string>;
    let mockContext: any;
    let provider: GoogleAuthProvider;

    beforeEach(() => {
        secretsStore = new Map<string, string>();
        mockContext = {
            secrets: {
                get: jest.fn(async (key: string) => secretsStore.get(key)),
                store: jest.fn(async (key: string, val: string) => { secretsStore.set(key, val); }),
                delete: jest.fn(async (key: string) => { secretsStore.delete(key); })
            }
        };
        provider = new GoogleAuthProvider(mockContext);
    });

    afterEach(() => {
        provider.dispose();
    });

    test('escapeHtml neutralizes XSS payloads in OAuth error rendering', () => {
        const payload = '<script>alert("xss")</script>&\'';
        expect(escapeHtml(payload)).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&amp;&#39;');
    });

    test('safeEqualString validates OAuth CSRF state safely', () => {
        expect(safeEqualString('abc123', 'abc123')).toBe(true);
        expect(safeEqualString('abc123', 'abc124')).toBe(false);
        expect(safeEqualString('short', 'longer-string')).toBe(false);
    });

    test('isPermanentAuthError distinguishes invalid_grant from transient network errors', () => {
        expect(isPermanentAuthError({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
        expect(isPermanentAuthError({ message: 'unauthorized_client' })).toBe(true);
        expect(isPermanentAuthError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
        expect(isPermanentAuthError({ response: { status: 503 }, message: 'Service Unavailable' })).toBe(false);
    });

    test('signOut / removeAccount does NOT infinitely recurse when removing the last account', async () => {
        const accId = 'acc-1';
        secretsStore.set('antigravity-storage-manager.google.accounts', JSON.stringify([
            { id: accId, email: 'user@example.com', name: 'User', lastActive: Date.now() }
        ]));
        secretsStore.set(`antigravity-storage-manager.google.tokens.${accId}`, JSON.stringify({
            accessToken: 'at-1',
            refreshToken: 'rt-1',
            expiryDate: Date.now() + 3600000
        }));
        secretsStore.set('antigravity-storage-manager.google.currentAccountId', accId);

        await provider.initialize();
        expect(provider.isAuthenticated()).toBe(true);

        const sessionChanged = jest.fn();
        provider.onDidChangeSessions(sessionChanged);

        // Previously threw RangeError: Maximum call stack size exceeded
        await provider.signOut();

        expect(provider.isAuthenticated()).toBe(false);
        expect(provider.getCurrentAccountId()).toBeNull();
        expect(sessionChanged).toHaveBeenCalledTimes(1);
    });

    test('refreshToken preserves session on transient network error and clears ONLY active session on invalid_grant', async () => {
        const acc1 = 'acc-1';
        const acc2 = 'acc-2';
        secretsStore.set('antigravity-storage-manager.google.accounts', JSON.stringify([
            { id: acc1, email: 'a@example.com', name: 'A', lastActive: 1 },
            { id: acc2, email: 'b@example.com', name: 'B', lastActive: 2 }
        ]));
        secretsStore.set(`antigravity-storage-manager.google.tokens.${acc1}`, JSON.stringify({
            accessToken: 'at-1',
            refreshToken: 'rt-1',
            expiryDate: 0 // expiryDate === 0 must trigger refresh in getAccessToken!
        }));
        secretsStore.set(`antigravity-storage-manager.google.tokens.${acc2}`, JSON.stringify({
            accessToken: 'at-2',
            refreshToken: 'rt-2',
            expiryDate: Date.now() + 3600000
        }));
        secretsStore.set('antigravity-storage-manager.google.currentAccountId', acc1);

        await provider.initialize();

        const client = provider.getOAuth2Client();
        const refreshMock = jest.spyOn(client as any, 'refreshAccessToken') as jest.Mock;

        // 1. Transient network error -> must NOT sign out or wipe tokens
        refreshMock.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        await expect(provider.getAccessToken()).rejects.toThrow(/socket hang up/);
        expect(provider.isAuthenticated()).toBe(true);
        expect(provider.getCurrentAccountId()).toBe(acc1);

        // 2. Permanent invalid_grant -> clears active session, does NOT silently switch to acc2
        refreshMock.mockRejectedValueOnce({ response: { data: { error: 'invalid_grant' } }, message: 'invalid_grant' });
        await expect(provider.refreshToken()).rejects.toThrow(/Session expired/i);
        expect(provider.isAuthenticated()).toBe(false);
        expect(provider.getCurrentAccountId()).toBeNull();
    });

    test('getAccounts returns empty array on corrupted SecretStorage JSON', async () => {
        secretsStore.set('antigravity-storage-manager.google.accounts', '{not-valid-json');
        const accounts = await provider.getAccounts();
        expect(accounts).toEqual([]);
    });
});
