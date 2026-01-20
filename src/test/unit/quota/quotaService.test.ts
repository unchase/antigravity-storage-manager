
import { parseQuotaResponse } from '../../../quota/quotaService';

describe('QuotaService', () => {
    describe('parseQuotaResponse', () => {
        test('parses prompt credits correctly', () => {
            const response = {
                userStatus: {
                    planStatus: {
                        availablePromptCredits: "45000",
                        planInfo: {
                            monthlyPromptCredits: "50000"
                        }
                    }
                }
            };

            const snapshot = parseQuotaResponse(response);

            expect(snapshot.promptCredits).toBeDefined();
            expect(snapshot.promptCredits?.available).toBe(45000);
            expect(snapshot.promptCredits?.monthly).toBe(50000);
            // 5000 used out of 50000 = 10% used, 90% remaining
            expect(snapshot.promptCredits?.remainingPercentage).toBe(90);
            expect(snapshot.promptCredits?.usedPercentage).toBe(10);
        });

        test('handles missing or zero monthly credits', () => {
            const responseNoCredits = {
                userStatus: {
                    planStatus: {
                        availablePromptCredits: "0",
                        planInfo: {}
                    }
                }
            };

            const snapshot = parseQuotaResponse(responseNoCredits);
            expect(snapshot.promptCredits).toBeUndefined();
        });

        test('parses models correctly', () => {
            const resetTimeStr = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
            const response = {
                userStatus: {
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: "Gemini 3 Pro",
                                modelOrAlias: { model: "gemini-3-pro" },
                                quotaInfo: {
                                    remainingFraction: 0.8,
                                    resetTime: resetTimeStr
                                }
                            }
                        ]
                    }
                }
            };

            const snapshot = parseQuotaResponse(response);
            expect(snapshot.models).toHaveLength(1);

            const model = snapshot.models[0];
            expect(model.label).toBe("Gemini 3 Pro");
            expect(model.modelId).toBe("gemini-3-pro");
            expect(model.remainingPercentage).toBe(80); // 0.8 * 100
            expect(model.isExhausted).toBe(false);
            expect(model.resetTime.toISOString()).toBe(resetTimeStr);
            expect(model.timeUntilReset).toBeGreaterThan(0);
        });

        test('handles exhausted models', () => {
            const response = {
                userStatus: {
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: "Exhausted Model",
                                modelOrAlias: { model: "exhausted" },
                                quotaInfo: {
                                    remainingFraction: 0,
                                    resetTime: new Date().toISOString()
                                }
                            }
                        ]
                    }
                }
            };

            const snapshot = parseQuotaResponse(response);
            expect(snapshot.models[0].isExhausted).toBe(true);
        });
    });
});
