import * as assert from 'assert';
import * as vscode from 'vscode';
import { QuotaUsageTracker } from '../../../quota/quotaUsageTracker';
import { QuotaSnapshot, ModelQuotaInfo } from '../../../quota/types';
import { LocalizationManager } from '../../../l10n/localizationManager';

describe('QuotaUsageTracker Test Suite', () => {
    let context: vscode.ExtensionContext;
    let globalState: any;
    let updateSpy: jest.Mock;

    beforeEach(() => {
        updateSpy = jest.fn().mockResolvedValue(undefined);
        globalState = {
            get: jest.fn().mockReturnValue([]),
            update: updateSpy
        };
        context = {
            globalState: globalState
        } as unknown as vscode.ExtensionContext;

        jest.spyOn(LocalizationManager, 'getInstance').mockReturnValue({
            t: (key: string) => key,
            getLocale: () => 'en'
        } as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('should load history from globalState on init', () => {
        const history = [{ modelId: 'test-model', points: [{ timestamp: 100, usage: 10 }] }];
        globalState.get.mockReturnValue(history);

        const tracker = new QuotaUsageTracker(context);

        const est = tracker.getEstimation('test-model');
        assert.strictEqual(est, null);
    });

    test('should track new usage points', () => {
        const tracker = new QuotaUsageTracker(context);
        const snapshot: QuotaSnapshot = {
            timestamp: new Date(),
            models: [
                {
                    modelId: 'm1',
                    label: 'Model 1',
                    isExhausted: false,
                    remainingPercentage: 90,
                    resetTime: new Date(),
                    timeUntilReset: 0,
                    timeUntilResetFormatted: ''
                }
            ]
        };

        tracker.track(snapshot);
        expect(updateSpy).toHaveBeenCalledTimes(1);

        const args = updateSpy.mock.calls[0];
        assert.strictEqual(args[0], 'quotaUsageHistory');
        const savedData = args[1];
        assert.strictEqual(savedData.length, 1);
        assert.strictEqual(savedData[0].modelId, 'm1');
        assert.strictEqual(savedData[0].points.length, 1);
        assert.strictEqual(savedData[0].points[0].usage, 10); // 100 - 90
    });

    test('should calculate speed correctly', () => {
        const tracker = new QuotaUsageTracker(context);
        const now = Date.now();
        const oneHourAgo = now - 3600 * 1000;

        const trackerAny = tracker as any;
        trackerAny.history.set('m1', [
            { timestamp: oneHourAgo, usage: 10 },
            { timestamp: now, usage: 20 }
        ]);

        const est = tracker.getEstimation('m1');
        assert.ok(est);
        assert.strictEqual(est?.speedPerHour.toFixed(1), '10.0');

        const remainingHours = (est!.estimatedTimeRemainingMs!) / (3600 * 1000);
        assert.strictEqual(remainingHours.toFixed(1), '8.0');
    });

    test('should handle resets (usage drop)', () => {
        const tracker = new QuotaUsageTracker(context);
        const now = Date.now();
        const trackerAny = tracker as any;
        trackerAny.history.set('m1', [
            { timestamp: now - 7200000, usage: 90 },
            { timestamp: now - 3600000, usage: 0 }, // Reset happened
            { timestamp: now, usage: 5 }
        ]);

        const est = tracker.getEstimation('m1');
        assert.ok(est);
        assert.strictEqual(est?.speedPerHour.toFixed(1), '5.0');

        // Remaining: 100-5 = 95%. Speed 5/h. Time = 19h.
        const remainingHours = (est!.estimatedTimeRemainingMs!) / (3600 * 1000);
        assert.strictEqual(remainingHours.toFixed(1), '19.0');
    });

    test('should return null if not enough data', () => {
        const tracker = new QuotaUsageTracker(context);
        const trackerAny = tracker as any;
        trackerAny.history.set('m1', [
            { timestamp: Date.now(), usage: 10 }
        ]);

        const est = tracker.getEstimation('m1');
        assert.strictEqual(est, null);
    });

    test('should limit history size', () => {
        const tracker = new QuotaUsageTracker(context);
        const modelInfo: ModelQuotaInfo = {
            modelId: 'm1', label: 'M1', remainingPercentage: 100,
            isExhausted: false, resetTime: new Date(), timeUntilReset: 0, timeUntilResetFormatted: ''
        };

        for (let i = 0; i < 60; i++) {
            modelInfo.remainingPercentage = 100 - i;
            tracker.track({
                timestamp: new Date(),
                models: [modelInfo]
            });
        }

        // MAX_POINTS is 50
        const args = updateSpy.mock.calls[updateSpy.mock.calls.length - 1];
        const savedData = args[1];
        assert.strictEqual(savedData[0].points.length, 50);
    });
});
