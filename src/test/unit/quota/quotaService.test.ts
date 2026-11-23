
import { parseQuotaResponse, parseQuotaSummaryResponse } from '../../../quota/quotaService';

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
                                label: "Gemini 3.1 Pro",
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
            expect(model.label).toBe("Gemini 3.1 Pro");
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

        test('parses Gemini 4 models with alias or missing resetTime safely', () => {
            const response = {
                userStatus: {
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: "Gemini 4 Neon (High)",
                                modelOrAlias: { alias: "gemini-4-neon-high" },
                                quotaInfo: {
                                    remainingFraction: 0.75
                                }
                            }
                        ]
                    }
                }
            };

            const snapshot = parseQuotaResponse(response);
            expect(snapshot.models).toHaveLength(1);
            expect(snapshot.models[0].modelId).toBe("gemini-4-neon-high");
            expect(snapshot.models[0].remainingPercentage).toBe(75);
            expect(snapshot.models[0].isExhausted).toBe(false);
            expect(snapshot.models[0].timeUntilReset).toBe(0);
        });
    });

    describe('parseQuotaSummaryResponse', () => {
        test('parses RetrieveUserQuotaSummary groups and buckets', () => {
            const reset5h = new Date(Date.now() + 3600000).toISOString();
            const resetWeekly = new Date(Date.now() + 86400000 * 3).toISOString();
            const summaryResponse = {
                response: {
                    groups: [
                        {
                            displayName: "Gemini Models",
                            buckets: [
                                {
                                    bucketId: "gemini-5h",
                                    displayName: "5-Hour Limit",
                                    window: "5h",
                                    remainingFraction: 0.85,
                                    resetTime: reset5h,
                                    disabled: false
                                },
                                {
                                    bucketId: "gemini-weekly",
                                    displayName: "Weekly Limit",
                                    window: "weekly",
                                    remainingFraction: 0.4,
                                    resetTime: resetWeekly,
                                    disabled: false
                                }
                            ]
                        },
                        {
                            displayName: "Claude and GPT models",
                            buckets: [
                                {
                                    bucketId: "3p-5h",
                                    displayName: "5-Hour Session",
                                    window: "5h",
                                    remainingFraction: 0,
                                    resetTime: reset5h,
                                    disabled: false
                                }
                            ]
                        }
                    ]
                }
            };

            const snapshot = parseQuotaSummaryResponse(summaryResponse, {
                timestamp: new Date(),
                models: [],
                planName: 'Google AI Ultra',
                userEmail: 'test@example.com'
            });

            expect(snapshot.planName).toBe('Google AI Ultra');
            expect(snapshot.userEmail).toBe('test@example.com');
            expect(snapshot.models).toHaveLength(3);
            expect(snapshot.models[0].label).toBe('Gemini Models (5-Hour Limit)');
            expect(snapshot.models[0].modelId).toBe('gemini-5h');
            expect(snapshot.models[0].remainingPercentage).toBeCloseTo(85);
            expect(snapshot.models[1].label).toBe('Gemini Models (Weekly Limit)');
            expect(snapshot.models[1].remainingPercentage).toBeCloseTo(40);
            expect(snapshot.models[2].label).toBe('Claude and GPT models');
            expect(snapshot.models[2].isExhausted).toBe(true);
        });
    });
});
