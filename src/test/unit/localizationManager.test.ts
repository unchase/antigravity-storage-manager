import { LocalizationManager } from '../../../src/l10n/localizationManager';

// Mock vscode module
jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue('en')
        }),
        onDidChangeConfiguration: jest.fn()
    },
    env: {
        language: 'en'
    }
}), { virtual: true });

describe('LocalizationManager', () => {
    let lm: LocalizationManager;

    beforeEach(() => {
        // Get the singleton instance
        lm = LocalizationManager.getInstance();
    });

    describe('formatDateTime', () => {
        test('formats Date object according to locale', () => {
            const testDate = new Date('2026-01-15T10:30:00');
            const result = lm.formatDateTime(testDate);
            // Should return a non-empty string
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
            // Should contain parts of the date
            expect(result).toContain('2026');
        });

        test('formats ISO string according to locale', () => {
            const result = lm.formatDateTime('2026-01-15T10:30:00');
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
        });

        test('handles different date formats', () => {
            const isoDate = '2026-01-15T10:30:00Z';
            const result = lm.formatDateTime(isoDate);
            expect(result).toBeTruthy();
        });
    });

    describe('formatDate', () => {
        test('formats Date object (date only) according to locale', () => {
            const testDate = new Date('2026-01-15T10:30:00');
            const result = lm.formatDate(testDate);
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
            // Date-only format should not typically include time components
            // but this depends on locale, so we just check it's formatted
        });

        test('formats ISO string (date only) according to locale', () => {
            const result = lm.formatDate('2026-01-15');
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
        });
    });

    describe('getLocale', () => {
        test('returns current locale string', () => {
            const locale = lm.getLocale();
            expect(typeof locale).toBe('string');
            expect(locale.length).toBeGreaterThan(0);
        });
    });

    describe('t (translation)', () => {
        test('returns key when translation not found', () => {
            const unknownKey = 'some.unknown.key.that.does.not.exist';
            const result = lm.t(unknownKey);
            expect(result).toBe(unknownKey);
        });

        test('replaces placeholders with arguments', () => {
            // Even if translation is not found, placeholders should be replaced
            const key = 'Hello {0}, you have {1} messages';
            const result = lm.t(key, 'User', 5);
            expect(result).toBe('Hello User, you have 5 messages');
        });

        test('handles missing placeholders gracefully', () => {
            const key = 'Missing {0} and {2}';
            const result = lm.t(key, 'first');
            expect(result).toBe('Missing first and {2}');
        });
    });
});
