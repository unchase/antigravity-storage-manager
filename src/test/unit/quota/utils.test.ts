import {
    drawProgressBar,
    getModelAbbreviation,
    formatResetTime,
    compareModels,
    isGeminiModel,
    isThirdPartyModel,
    isHighTierModel,
    getCycleDuration
} from '../../../quota/utils';
import { ModelQuotaInfo } from '../../../quota/types';
import { LocalizationManager } from '../../../l10n/localizationManager';

describe('Quota Utilities', () => {
    let lmSpy: jest.SpyInstance;

    beforeAll(() => {
        lmSpy = jest.spyOn(LocalizationManager, 'getInstance').mockReturnValue({
            t: (key: string) => key,
            getLocale: () => 'en'
        } as any);
    });

    afterAll(() => {
        lmSpy.mockRestore();
    });

    describe('drawProgressBar', () => {
        test('returns correct ASCII bar', () => {
            expect(drawProgressBar(0)).toBe('□□□□□□□□□□');
            expect(drawProgressBar(50)).toBe('■■■■■□□□□□');
            expect(drawProgressBar(100)).toBe('■■■■■■■■■■');
            expect(drawProgressBar(25, 8)).toBe('■■□□□□□□');
        });
    });

    describe('getModelAbbreviation', () => {
        test('returns correct abbreviations', () => {
            // Known abbreviations
            expect(getModelAbbreviation('Gemini 3.1 Pro (High)')).toBe('Gemini 3.1 Pro (H)');
            expect(getModelAbbreviation('Claude Sonnet 4.6')).toBe('Claude S4.6');

            // Dynamic model patterns (Gemini 3.6 / 3.7 / 3.8, Claude, GPT-OSS)
            expect(getModelAbbreviation('Gemini 3.8 Flash (Medium)')).toBe('Gemini 3.8 Flash (M)');
            expect(getModelAbbreviation('Gemini 3.7 Flash (High)')).toBe('Gemini 3.7 Flash (H)');
            expect(getModelAbbreviation('Gemini 3.6 Flash (Low)')).toBe('Gemini 3.6 Flash (L)');
            expect(getModelAbbreviation('Gemini 3.8 Pro (High)')).toBe('Gemini 3.8 Pro (H)');
            expect(getModelAbbreviation('Claude Sonnet 4.6 (Thinking)')).toBe('Claude S4.6T');
            expect(getModelAbbreviation('Claude Opus 4.6 (Thinking)')).toBe('Claude O4.6T');
            expect(getModelAbbreviation('GPT-OSS 120B (Medium)')).toBe('GPT-OSS (M)');

            // Gemini 4, Orchestrator & Claude 5.5 models
            expect(getModelAbbreviation('Gemini 4 Neon (High)')).toBe('Gemini 4 Neon (H)');
            expect(getModelAbbreviation('Gemini 4 Neon High')).toBe('Gemini 4 Neon (H)');
            expect(getModelAbbreviation('Gemini 4 Neon (XHigh)')).toBe('Gemini 4 Neon (XH)');
            expect(getModelAbbreviation('Gemini 4 Carbon (Medium)')).toBe('Gemini 4 Carbon (M)');
            expect(getModelAbbreviation('Gemini 4 Argon (Medium)')).toBe('Gemini 4 Argon (M)');
            expect(getModelAbbreviation('Gemini 4 Hydrogen (Low)')).toBe('Gemini 4 Hydrogen (L)');
            expect(getModelAbbreviation('Orchestrator (Neon)')).toBe('Orch (Neon)');
            expect(getModelAbbreviation('Orchestrator (Carbon)')).toBe('Orch (Carbon)');
            expect(getModelAbbreviation('Orchestrator Gemini 4 Neon High')).toBe('Orch G4 Neon (H)');
            expect(getModelAbbreviation('Claude Opus 5.5 (Medium)')).toBe('Claude O5.5 (M)');
            expect(getModelAbbreviation('Claude Sonnet 5.5 (High)')).toBe('Claude S5.5 (H)');
            expect(getModelAbbreviation('Claude Opus 5.5 Low')).toBe('Claude O5.5 (L)');

            // Bucketed quota summary labels
            expect(getModelAbbreviation('Gemini Models (5-Hour Limit)')).toBe('Gemini (5h)');
            expect(getModelAbbreviation('Gemini Models (Weekly Limit)')).toBe('Gemini (7d)');
            expect(getModelAbbreviation('Claude and GPT models (5-Hour Session)')).toBe('Claude/GPT (5h)');
            expect(getModelAbbreviation('Claude and GPT models (Weekly Limit)')).toBe('Claude/GPT (7d)');

            // Dynamic fallback
            expect(getModelAbbreviation('My Custom Model')).toBe('MCM');
            expect(getModelAbbreviation('GPT-4')).toBe('G4');
            expect(getModelAbbreviation('Llama-3-70b')).toBe('L370');
        });
    });

    describe('model classification & cycle helpers', () => {
        test('classifies Gemini and Orchestrator models correctly', () => {
            expect(isGeminiModel('Gemini 4 Neon (High)')).toBe(true);
            expect(isGeminiModel('Orchestrator (Neon)', 'gemini-pro-orchestrator-neon')).toBe(true);
            expect(isGeminiModel('Orchestrator (Carbon)')).toBe(true);
            expect(isGeminiModel('Claude Opus 5.5 (Medium)')).toBe(false);
            expect(isThirdPartyModel('Claude Opus 5.5 (Medium)')).toBe(true);
            expect(isThirdPartyModel('GPT-OSS 120B (Medium)')).toBe(true);
            expect(isThirdPartyModel('3p-5h', '3p-5h')).toBe(true);
            expect(isThirdPartyModel('Gemini 4 Carbon (High)')).toBe(false);
        });

        test('detects high-tier models and cycle durations', () => {
            expect(isHighTierModel('Gemini 4 Neon (High)')).toBe(true);
            expect(isHighTierModel('Orchestrator (Neon)')).toBe(true);
            expect(isHighTierModel('Claude Opus 5.5 (Medium)')).toBe(true);
            expect(getCycleDuration('Gemini 4 Neon (High)')).toBe(5 * 60 * 60 * 1000);
            expect(getCycleDuration('Gemini Models (Weekly Limit)')).toBe(7 * 24 * 60 * 60 * 1000);
            expect(getCycleDuration('Gemini Models (5-Hour Limit)')).toBe(5 * 60 * 60 * 1000);
        });
    });

    describe('formatResetTime', () => {


        test('formats today correctly', () => {
            const today = new Date();
            today.setHours(15, 30, 0, 0);
            expect(formatResetTime(today)).toMatch(/Today.*(15:30|3:30|03:30)/i);
        });

        test('formats tomorrow correctly', () => {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            expect(formatResetTime(tomorrow)).toMatch(/Tomorrow.*(09:00|9:00)/i);
        });

        test('formats other dates correctly', () => {
            const future = new Date(2030, 0, 1, 12, 0, 0); // Jan 1, 2030, 12:00 Local
            const result = formatResetTime(future);
            // Check essential parts (12 is the hour), ignore separators/AM/PM specifics
            expect(result).toMatch(/12/);
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

        test('sorts by label (quota secondary)', () => {
            // Quota Equal (50%), Time different (should not matter), Labels different
            // sort label asc
            const m1 = createModel({ remainingPercentage: 50, label: 'Alpha' });
            const m2 = createModel({ remainingPercentage: 50, label: 'Beta' });

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
