
import { drawProgressBar, getModelAbbreviation, formatResetTime, compareModels } from '../../../quota/utils';
import { ModelQuotaInfo } from '../../../quota/types';

describe('Quota Utilities', () => {
    describe('drawProgressBar', () => {
        test('returns correct ASCII bar', () => {
            expect(drawProgressBar(0)).toBe('░░░░░░░░░░');
            expect(drawProgressBar(50)).toBe('▓▓▓▓▓░░░░░');
            expect(drawProgressBar(100)).toBe('▓▓▓▓▓▓▓▓▓▓');
            expect(drawProgressBar(25, 8)).toBe('▓▓░░░░░░');
        });
    });

    describe('getModelAbbreviation', () => {
        test('returns correct abbreviations', () => {
            // Known abbreviations
            expect(getModelAbbreviation('Gemini 3 Pro (High)')).toBe('Gemini 3 Pro (H)');
            expect(getModelAbbreviation('Claude Sonnet 4.5')).toBe('Claude S4.5');

            // Dynamic fallback
            expect(getModelAbbreviation('My Custom Model')).toBe('MCM');
            expect(getModelAbbreviation('GPT-4')).toBe('G4');
            expect(getModelAbbreviation('Llama-3-70b')).toBe('L370');
        });
    });

    describe('formatResetTime', () => {


        test('formats today correctly', () => {
            const today = new Date();
            today.setHours(15, 30, 0, 0);
            expect(formatResetTime(today)).toMatch(/Today 15:30/);
        });

        test('formats tomorrow correctly', () => {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            expect(formatResetTime(tomorrow)).toMatch(/Tomorrow 09:00/);
        });

        test('formats other dates correctly', () => {
            const future = new Date('2030-01-01T12:00:00');
            const result = formatResetTime(future);
            expect(result).toContain('2030');
            expect(result).toContain('12:00');
        });
    });

    describe('compareModels', () => {
        const baseModel: ModelQuotaInfo = {
            modelId: '1',
            label: 'Test',
            remainingPercentage: 50,
            resetTime: new Date('2024-01-01T12:00:00'),
            isExhausted: false,
            timeUntilReset: 0,
            timeUntilResetFormatted: ''
        };

        const createModel = (overrides: Partial<ModelQuotaInfo>): ModelQuotaInfo => ({ ...baseModel, ...overrides });

        test('sorts by quota (primary)', () => {
            const m1 = createModel({ remainingPercentage: 10 });
            const m2 = createModel({ remainingPercentage: 90 });
            // Descending: m2 (90) comes before m1 (10)
            expect(compareModels(m2, m1, 'quota')).toBeLessThan(0);
            expect(compareModels(m1, m2, 'quota')).toBeGreaterThan(0);
        });

        test('sorts by time (quota secondary)', () => {
            // Quota Equal (50%), Time different
            const m1 = createModel({ remainingPercentage: 50, resetTime: new Date('2024-01-01T10:00:00') });
            const m2 = createModel({ remainingPercentage: 50, resetTime: new Date('2024-01-01T12:00:00') });

            // quota equal, sort time asc (m1 first)
            expect(compareModels(m1, m2, 'quota')).toBeLessThan(0);
            expect(compareModels(m2, m1, 'quota')).toBeGreaterThan(0);
        });

        test('sorts by time (primary)', () => {
            const m1 = createModel({ resetTime: new Date('2024-01-01T10:00:00') });
            const m2 = createModel({ resetTime: new Date('2024-01-01T12:00:00') });
            expect(compareModels(m1, m2, 'time')).toBeLessThan(0);
            expect(compareModels(m2, m1, 'time')).toBeGreaterThan(0);
        });

        test('sorts by quota (time secondary)', () => {
            const time = new Date('2024-01-01T12:00:00');
            const m1 = createModel({ resetTime: time, remainingPercentage: 10 });
            const m2 = createModel({ resetTime: time, remainingPercentage: 90 });

            // time equal, sort quota asc
            expect(compareModels(m1, m2, 'time')).toBeLessThan(0);
            expect(compareModels(m2, m1, 'time')).toBeGreaterThan(0);
        });
    });
});
