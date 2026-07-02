import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode module (identical shape to the existing proxyManager test)
jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        withProgress: jest.fn((options, task) => task({ report: jest.fn() }, undefined)),
        createOutputChannel: jest.fn(() => ({
            append: jest.fn(),
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn()
        })),
        createStatusBarItem: jest.fn(() => ({
            show: jest.fn(),
            hide: jest.fn(),
            dispose: jest.fn(),
            text: '',
            command: '',
            backgroundColor: undefined
        }))
    },
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key: string, defaultValue: any) => defaultValue),
            update: jest.fn()
        }))
    },
    StatusBarAlignment: { Right: 1 },
    ThemeColor: jest.fn(),
    EventEmitter: class {
        event = jest.fn();
        fire = jest.fn();
        dispose = jest.fn();
    },
    commands: {
        registerCommand: jest.fn()
    }
}), { virtual: true });

import { ProxyManager } from '../../proxy/proxyManager';

describe('ProxyManager.generateApiKey (CWE-338 fix)', () => {
    let context: any;
    let tmpDir: string;
    let pm: ProxyManager;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agsm-pm-'));
        // Pre-create bin dir so generateApiKey can write config.yaml
        fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
        context = {
            subscriptions: [],
            secrets: { get: jest.fn(), store: jest.fn(), delete: jest.fn() },
            extensionUri: { fsPath: '/mock/path' }
        };
        pm = new ProxyManager(context, tmpDir);
    });

    afterEach(() => {
        try { pm.dispose(); } catch { /* noop */ }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    });

    test('key has expected sk-antigravity- prefix and 48 hex chars', () => {
        const key = pm.generateApiKey();
        expect(key).not.toBe('');
        expect(key.startsWith('sk-antigravity-')).toBe(true);
        const body = key.substring('sk-antigravity-'.length);
        expect(body).toMatch(/^[0-9a-f]{48}$/);
    });

    test('does not use predictable Math.random format (alphabet is hex only)', () => {
        const key = pm.generateApiKey();
        const body = key.substring('sk-antigravity-'.length);
        expect(body).not.toMatch(/[g-z]/); // hex has no g-z
    });

    test('generates unique high-entropy keys across many invocations', () => {
        const seen = new Set<string>();
        const N = 200;
        for (let i = 0; i < N; i++) {
            const k = pm.generateApiKey();
            expect(k).not.toBe('');
            seen.add(k);
        }
        expect(seen.size).toBe(N);
    });

    test('entropy of 192 bits: hex body length is 48', () => {
        const key = pm.generateApiKey();
        const body = key.substring('sk-antigravity-'.length);
        expect(body.length).toBe(48); // 24 bytes * 2 hex chars = 48
    });

    test('is resistant to Math.random state recovery (statistical smoke test)', () => {
        // Observing outputs must not let us predict subsequent bytes. This
        // isn't a formal proof, but a smoke test: the first-byte distribution
        // over many samples should be roughly uniform across all 256 values.
        const counts = new Array(256).fill(0);
        const N = 5000;
        for (let i = 0; i < N; i++) {
            const key = pm.generateApiKey();
            expect(key).not.toBe('');
            const body = key.substring('sk-antigravity-'.length);
            const firstByte = parseInt(body.substring(0, 2), 16);
            counts[firstByte]++;
        }
        // Every byte value should appear at least once with N=5000 (E≈19.5).
        const zeroCells = counts.filter(c => c === 0).length;
        expect(zeroCells).toBeLessThan(10);
    });
});
