
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
        test('parses tagTitle, tagDescription and marks tier-restricted or explicitly disabled models as disabled', () => {
            const resetTimeStr = new Date(Date.now() + 3600000).toISOString();
            const response = {
                userStatus: {
                    planStatus: {
                        planInfo: {
                            teamsTier: 'TEAMS_TIER_FREE'
                        }
                    },
                    userTier: {
                        name: 'Free',
                        upgradeSubscriptionText: 'You can upgrade to a Google AI Pro plan.'
                    },
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: 'Gemini 4 Argon (Medium)',
                                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M418' },
                                allowedTiers: ['TEAMS_TIER_FREE', 'TEAMS_TIER_PRO'],
                                quotaInfo: {
                                    remainingFraction: 0.87,
                                    resetTime: resetTimeStr
                                },
                                tagTitle: 'Leaving Soon',
                                tagDescription: 'The original Gemini 4 model for advanced workflows. Leaving on Nov 30.'
                            },
                            {
                                label: 'Gemini 4 Carbon (High)',
                                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M427' },
                                allowedTiers: ['TEAMS_TIER_PRO', 'TEAMS_TIER_PRO_ULTIMATE'],
                                quotaInfo: {
                                    remainingFraction: 1,
                                    resetTime: resetTimeStr
                                },
                                tagTitle: 'New',
                                tagDescription: 'For your hardest, long-horizon tasks'
                            },
                            {
                                label: 'GPT-OSS 120B (Medium)',
                                modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' },
                                disabled: true,
                                disabledReason: 'GPT-OSS has been removed from Antigravity.',
                                tagTitle: 'Notice',
                                tagDescription: 'GPT-OSS will be removed from Antigravity on November 30, 2026.'
                            }
                        ]
                    }
                }
            };

            const snapshot = parseQuotaResponse(response);
            expect(snapshot.models).toHaveLength(3);

            const argon = snapshot.models[0];
            expect(argon.isDisabled).toBe(false);
            expect(argon.tagTitle).toBe('Leaving Soon');
            expect(argon.tagDescription).toBe('The original Gemini 4 model for advanced workflows. Leaving on Nov 30.');

            const carbon = snapshot.models[1];
            expect(carbon.isDisabled).toBe(true);
            expect(carbon.disabledReason).toBe('You can upgrade to a Google AI Pro plan.');
            expect(carbon.tagTitle).toBe('New');

            const gptOss = snapshot.models[2];
            expect(gptOss.isDisabled).toBe(true);
            expect(gptOss.isExhausted).toBe(true);
            expect(gptOss.disabledReason).toBe('GPT-OSS has been removed from Antigravity.');
            expect(gptOss.tagTitle).toBe('Notice');
        });

        test('parses flowCredits, canonicalModelId and model modality capabilities', () => {
            const resetTimeStr = new Date(Date.now() + 3600000).toISOString();
            const response = {
                userStatus: {
                    planStatus: {
                        availableFlowCredits: 100,
                        planInfo: {
                            monthlyFlowCredits: 150000
                        }
                    },
                    cascadeModelConfigData: {
                        clientModelConfigs: [
                            {
                                label: 'Gemini 4 Neon (High)',
                                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
                                modelId: 'gemini-4-neon-high',
                                supportsImages: true,
                                supportedMimeTypes: {
                                    'image/png': true,
                                    'application/pdf': true,
                                    'audio/mp3': true,
                                    'video/mp4': true
                                },
                                quotaInfo: { remainingFraction: 0.9, resetTime: resetTimeStr }
                            },
                            {
                                label: 'Claude Opus 5.5 (High)',
                                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' },
                                modelId: 'claude-opus-5-5-high',
                                supportsImages: true,
                                supportedMimeTypes: {
                                    'image/png': true,
                                    'video/jpeg2000': true
                                },
                                quotaInfo: { remainingFraction: 1, resetTime: resetTimeStr }
                            }
                        ]
                    }
                }
            };

            const snapshot = parseQuotaResponse(response);
            expect(snapshot.flowCredits).toBeDefined();
            expect(snapshot.flowCredits?.available).toBe(100);
            expect(snapshot.flowCredits?.monthly).toBe(150000);

            expect(snapshot.models[0].canonicalModelId).toBe('gemini-4-neon-high');
            expect(snapshot.models[0].capabilities).toEqual({
                images: true,
                documents: true,
                audio: true,
                video: true
            });

            expect(snapshot.models[1].canonicalModelId).toBe('claude-opus-5-5-high');
            expect(snapshot.models[1].capabilities).toEqual({
                images: true,
                documents: false,
                audio: false,
                video: false
            });
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
                userEmail: 'test@example.com',
                flowCredits: {
                    available: 500,
                    monthly: 1000,
                    usedPercentage: 50,
                    remainingPercentage: 50
                }
            });

            expect(snapshot.planName).toBe('Google AI Ultra');
            expect(snapshot.userEmail).toBe('test@example.com');
            expect(snapshot.flowCredits?.available).toBe(500);
            expect(snapshot.models).toHaveLength(3);
            expect(snapshot.models[0].label).toBe('Gemini Models (5-Hour Limit)');
            expect(snapshot.models[0].modelId).toBe('gemini-5h');
            expect(snapshot.models[0].remainingPercentage).toBeCloseTo(85);
            expect(snapshot.models[1].label).toBe('Gemini Models (Weekly Limit)');
            expect(snapshot.models[1].remainingPercentage).toBeCloseTo(40);
            expect(snapshot.models[2].label).toBe('Claude and GPT models');
            expect(snapshot.models[2].isExhausted).toBe(true);
        });

        test('parses agy CLI /usage --output-format json response', () => {
            const resetWeekly = new Date(Date.now() + 86400000 * 6).toISOString();
            const reset5h = new Date(Date.now() + 3600000 * 2).toISOString();
            const agyUsageResponse = {
                conversation_id: '',
                status: 'SUCCESS',
                num_turns: 0,
                command: {
                    name: 'usage',
                    data: {
                        groups: [
                            {
                                name: 'Gemini Models',
                                description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon',
                                buckets: [
                                    {
                                        id: 'gemini-weekly',
                                        name: 'Weekly Limit Remaining',
                                        description: 'You have used some of your weekly limit.',
                                        window: 'weekly',
                                        remaining_fraction: 0.7573,
                                        reset_time: resetWeekly
                                    },
                                    {
                                        id: 'gemini-5h',
                                        name: 'Five Hour Limit Remaining',
                                        description: 'You have used some of your 5-hour limit.',
                                        window: '5h',
                                        remaining_fraction: 0.455,
                                        reset_time: reset5h
                                    }
                                ]
                            },
                            {
                                name: 'Claude and GPT models',
                                description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
                                buckets: [
                                    {
                                        id: '3p-weekly',
                                        name: 'Weekly Limit Remaining',
                                        window: 'weekly',
                                        remaining_fraction: 1,
                                        reset_time: '1970-01-01T00:00:00Z'
                                    },
                                    {
                                        id: '3p-5h',
                                        name: 'Five Hour Limit Remaining',
                                        window: '5h',
                                        remaining_fraction: 1,
                                        reset_time: '1970-01-01T00:00:00Z'
                                    }
                                ]
                            }
                        ]
                    }
                }
            };

            const snapshot = parseQuotaSummaryResponse(agyUsageResponse, {
                timestamp: new Date(),
                models: [],
                userEmail: 'user@example.com'
            });

            expect(snapshot.userEmail).toBe('user@example.com');
            expect(snapshot.models).toHaveLength(4);
            expect(snapshot.models[0].label).toBe('Gemini Models (Weekly Limit)');
            expect(snapshot.models[0].modelId).toBe('gemini-weekly');
            expect(snapshot.models[0].canonicalModelId).toBe('gemini-weekly');
            expect(snapshot.models[0].remainingPercentage).toBeCloseTo(75.73);
            expect(snapshot.models[0].tagDescription).toContain('You have used some of your weekly limit.');
            expect(snapshot.models[0].tagDescription).toContain('Gemini 4 Neon');
            expect(snapshot.models[1].label).toBe('Gemini Models (5-Hour Limit)');
            expect(snapshot.models[1].remainingPercentage).toBeCloseTo(45.5);
            expect(snapshot.models[2].label).toBe('Claude and GPT models (Weekly Limit)');
            expect(snapshot.models[2].timeUntilReset).toBe(0);
            expect(snapshot.models[2].isExhausted).toBe(false);
            expect(snapshot.models[3].label).toBe('Claude and GPT models (5-Hour Limit)');
            expect(snapshot.models[3].modelId).toBe('3p-5h');
        });

        test('ignores non-numeric credit values safely', () => {
            const response = {
                userStatus: {
                    planStatus: {
                        availablePromptCredits: 'not-a-number',
                        availableFlowCredits: 'bad',
                        planInfo: {
                            monthlyPromptCredits: 50000,
                            monthlyFlowCredits: 150000
                        }
                    }
                }
            };
            const snapshot = parseQuotaResponse(response);
            expect(snapshot.promptCredits).toBeUndefined();
            expect(snapshot.flowCredits).toBeUndefined();
        });
    });
});
