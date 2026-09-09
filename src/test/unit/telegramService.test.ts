import { EventEmitter } from 'events';
import * as https from 'https';

// Mock https.request
jest.mock('https', () => {
    const actual = jest.requireActual('https');
    return {
        ...actual,
        request: jest.fn()
    };
});

// Mock vscode
const mockConfig: Record<string, any> = {
    'telegram.botToken': 'test-token-123',
    'telegram.userIds': ['11111'],
    'telegram.usernames': ['@Alice', 'bob'],
    'sync.machineName': 'test-machine'
};

const mockGetConfiguration = jest.fn(() => ({
    get: jest.fn((key: string, defaultVal?: any) => {
        return mockConfig[key] !== undefined ? mockConfig[key] : defaultVal;
    })
}));

const mockShowInformationMessage = jest.fn();
const mockShowErrorMessage = jest.fn();
const mockDidChangeConfiguration = jest.fn(() => ({ dispose: jest.fn() }));

jest.mock('vscode', () => {
    class MockEventEmitter {
        private listeners: ((e: any) => void)[] = [];
        public event = (listener: (e: any) => void) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
        };
        public fire(data: any) {
            for (const l of this.listeners) {
                l(data);
            }
        }
        public dispose() {
            this.listeners = [];
        }
    }

    return {
        EventEmitter: MockEventEmitter,
        workspace: {
            getConfiguration: mockGetConfiguration,
            onDidChangeConfiguration: mockDidChangeConfiguration
        },
        window: {
            showInformationMessage: mockShowInformationMessage,
            showErrorMessage: mockShowErrorMessage
        },
        l10n: {
            t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
        }
    };
}, { virtual: true });

import { TelegramService } from '../../telegram/telegramService';

describe('TelegramService Out-Of-Band Authentication', () => {
    let service: TelegramService;
    let mockGlobalState: Record<string, any>;
    let mockContext: any;
    let sentMessages: { chatId: string, text: string }[];
    let receivedEvents: { chatId: string, text: string, username?: string, authorized: boolean }[];
    let nextUpdates: any[] = [];

    beforeEach(() => {
        sentMessages = [];
        receivedEvents = [];
        mockGlobalState = {};
        nextUpdates = [];
        mockShowInformationMessage.mockClear();

        mockContext = {
            globalState: {
                get: jest.fn((key: string, defVal: any) => mockGlobalState[key] ?? defVal),
                update: jest.fn((key: string, val: any) => { mockGlobalState[key] = val; return Promise.resolve(); })
            }
        };

        (https.request as unknown as jest.Mock).mockImplementation((options: any, callback?: any) => {
            const req = new EventEmitter();
            (req as any).write = jest.fn((data: string) => {
                const parsed = JSON.parse(data);
                if (options.path && options.path.includes('/sendMessage')) {
                    sentMessages.push({ chatId: parsed.chat_id, text: parsed.text });
                }
            });
            (req as any).end = jest.fn();

            if (callback) {
                const res = new EventEmitter();
                (res as any).statusCode = 200;
                process.nextTick(() => {
                    callback(res);
                    if (options.path && options.path.includes('/getUpdates')) {
                        const body = JSON.stringify({ ok: true, result: nextUpdates });
                        nextUpdates = []; // Consume
                        res.emit('data', body);
                        res.emit('end');
                    } else {
                        res.emit('data', JSON.stringify({ ok: true }));
                        res.emit('end');
                    }
                });
            }

            return req as any;
        });

        mockConfig['telegram.botToken'] = '';
        service = new TelegramService(mockContext);
        mockConfig['telegram.botToken'] = 'test-token-123';
        (service as any).updateConfig();
        service.onDidReceiveMessage(e => receivedEvents.push(e));
    });

    afterEach(() => {
        if (service) {
            service.dispose();
        }
    });

    async function triggerPoll(updates: any[]) {
        nextUpdates = updates;
        (service as any).isPolling = true;
        (service as any).poll();
        // Allow nextTick and promises to resolve
        await new Promise(resolve => setTimeout(resolve, 50));
        service.stopPolling(); // Stop next scheduled iteration
    }

    test('isConfigured returns true when botToken is present', () => {
        expect(service.isConfigured()).toBe(true);
    });

    test('direct userId match is immediately authorized', async () => {
        await triggerPoll([
            {
                update_id: 1,
                message: {
                    chat: { id: 11111 },
                    text: '/stats'
                }
            }
        ]);

        expect(receivedEvents.length).toBe(1);
        expect(receivedEvents[0]).toEqual({
            chatId: '11111',
            text: '/stats',
            username: undefined,
            authorized: true
        });
    });

    test('unknown username starts confirmation challenge and does not fire unauthorized event', async () => {
        await triggerPoll([
            {
                update_id: 2,
                message: {
                    chat: { id: 22222 },
                    from: { username: 'alice' }, // configured as @Alice in settings
                    text: '/start'
                }
            }
        ]);

        // VS Code notification should be displayed with confirmation code
        expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
        const vsCodeMsg = mockShowInformationMessage.mock.calls[0][0];
        expect(vsCodeMsg.toLowerCase()).toContain('telegram link request from @alice');
        expect(vsCodeMsg).toMatch(/\d{6}/);

        // Telegram sender should receive challenge prompt
        expect(sentMessages.length).toBe(1);
        expect(sentMessages[0].chatId).toBe('22222');
        expect(sentMessages[0].text.toLowerCase()).toContain('confirmation required to link @alice');

        // Crucially: NO onDidReceiveMessage event should be fired (avoids conflicting Access Denied)
        expect(receivedEvents.length).toBe(0);
    });

    test('re-sending command during active challenge does not re-issue new code or spam VS Code', async () => {
        // First message initiates challenge
        await triggerPoll([
            {
                update_id: 3,
                message: {
                    chat: { id: 22222 },
                    from: { username: 'alice' },
                    text: '/start'
                }
            }
        ]);

        expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
        expect(sentMessages.length).toBe(1);

        // Second message from same chatId
        await triggerPoll([
            {
                update_id: 4,
                message: {
                    chat: { id: 22222 },
                    from: { username: 'alice' },
                    text: '/stats'
                }
            }
        ]);

        // Should not show another VS Code notification
        expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
        // Should re-send prompt to Telegram
        expect(sentMessages.length).toBe(2);
        expect(sentMessages[1].text.toLowerCase()).toContain('confirmation required to link @alice');
        // Still no unauthorized command event fired
        expect(receivedEvents.length).toBe(0);
    });

    test('successful confirmation links the username and authorizes subsequent messages', async () => {
        // Step 1: Initiate challenge
        await triggerPoll([
            {
                update_id: 5,
                message: {
                    chat: { id: 22222 },
                    from: { username: 'alice' },
                    text: '/start'
                }
            }
        ]);

        const vsCodeMsg = mockShowInformationMessage.mock.calls[0][0];
        const match = vsCodeMsg.match(/Confirmation code: (\d{6})/);
        expect(match).toBeTruthy();
        const code = match![1];

        // Step 2: Send code with optional leading slash
        await triggerPoll([
            {
                update_id: 6,
                message: {
                    chat: { id: 22222 },
                    from: { username: 'alice' },
                    text: `/${code}`
                }
            }
        ]);

        // Confirmation message sent to Telegram
        expect(sentMessages.length).toBe(2);
        expect(sentMessages[1].text).toContain('Linked. You are now authorized.');

        // Mapping should be persisted in globalState
        expect(mockGlobalState['telegram.usernameToChatId']).toEqual({
            Alice: '22222'
        });

        // The confirmation message itself should not trigger command execution
        expect(receivedEvents.length).toBe(0);

        // Step 3: Subsequent command should now be authorized!
        await triggerPoll([
            {
                update_id: 7,
                message: {
                    chat: { id: 22222 },
                    from: { username: 'alice' },
                    text: '/stats'
                }
            }
        ]);

        expect(receivedEvents.length).toBe(1);
        expect(receivedEvents[0]).toEqual({
            chatId: '22222',
            text: '/stats',
            username: 'alice',
            authorized: true
        });
    });

    test('invalid confirmation code is rejected', async () => {
        await triggerPoll([
            {
                update_id: 8,
                message: {
                    chat: { id: 33333 },
                    from: { username: 'bob' },
                    text: '/start'
                }
            }
        ]);

        // Reply with incorrect 6-digit code
        await triggerPoll([
            {
                update_id: 9,
                message: {
                    chat: { id: 33333 },
                    from: { username: 'bob' },
                    text: '000000'
                }
            }
        ]);

        expect(sentMessages.length).toBe(2);
        expect(sentMessages[1].text).toContain('Invalid confirmation code.');
        // Mapping should not be set
        expect(mockGlobalState['telegram.usernameToChatId']).toBeUndefined();
        expect(receivedEvents.length).toBe(0);
    });

    test('exceeding maximum failed attempts invalidates the confirmation code', async () => {
        await triggerPoll([
            {
                update_id: 10,
                message: {
                    chat: { id: 33333 },
                    from: { username: 'bob' },
                    text: '/start'
                }
            }
        ]);

        // Send 5 incorrect codes (attempts 1 to 5)
        for (let i = 1; i <= 5; i++) {
            await triggerPoll([
                {
                    update_id: 10 + i,
                    message: {
                        chat: { id: 33333 },
                        from: { username: 'bob' },
                        text: `11111${i}`
                    }
                }
            ]);
        }

        // 6th attempt should invalidate code
        await triggerPoll([
            {
                update_id: 17,
                message: {
                    chat: { id: 33333 },
                    from: { username: 'bob' },
                    text: '999999'
                }
            }
        ]);

        const lastMsg = sentMessages[sentMessages.length - 1];
        expect(lastMsg.text).toContain('Too many failed attempts. Confirmation code invalidated.');
    });

    test('expired confirmation code is rejected', async () => {
        await triggerPoll([
            {
                update_id: 18,
                message: {
                    chat: { id: 33333 },
                    from: { username: 'bob' },
                    text: '/start'
                }
            }
        ]);

        // Manually expire pending links
        const pendingMap = (service as any).pendingLinks;
        const link = pendingMap.get('bob');
        expect(link).toBeDefined();
        link.expiresAt = Date.now() - 1000;

        await triggerPoll([
            {
                update_id: 19,
                message: {
                    chat: { id: 33333 },
                    from: { username: 'bob' },
                    text: '123456'
                }
            }
        ]);

        const lastMsg = sentMessages[sentMessages.length - 1];
        expect(lastMsg.text).toContain('Confirmation code expired. Send any command to request a new code.');
        expect(pendingMap.get('bob')).toBeUndefined();
    });

    test('unauthorized stranger sending a command fires unauthorized event', async () => {
        await triggerPoll([
            {
                update_id: 20,
                message: {
                    chat: { id: 99999 },
                    from: { username: 'evil_stranger' },
                    text: '/help'
                }
            }
        ]);

        expect(receivedEvents.length).toBe(1);
        expect(receivedEvents[0]).toEqual({
            chatId: '99999',
            text: '/help',
            username: 'evil_stranger',
            authorized: false
        });
    });

    test('sendBroadcast delivers to both userIds and linked usernames', async () => {
        mockGlobalState['telegram.usernameToChatId'] = {
            alice: '22222'
        };
        const newService = new TelegramService(mockContext);
        newService.stopPolling();

        await newService.sendBroadcast('Test notification');

        // Should broadcast to userIds ('11111') and resolved username ('22222')
        expect(sentMessages.length).toBe(2);
        const sentChatIds = sentMessages.map(m => m.chatId);
        expect(sentChatIds).toContain('11111');
        expect(sentChatIds).toContain('22222');

        newService.dispose();
    });
});
