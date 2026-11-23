
import * as https from "https";
import * as http from "http";
import { QuotaSnapshot, PromptCreditsInfo, ModelQuotaInfo } from "./types";
import { versionInfo } from "./versionInfo";

interface RequestConfig {
    path: string;
    body: object;
    timeout?: number;
}

async function makeRequest(
    config: RequestConfig,
    port: number,
    httpPort: number | undefined,
    csrfToken: string | undefined,
    protocol: 'https' | 'http' = 'https'
): Promise<any> {
    const requestBody = JSON.stringify(config.body);

    const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'Connect-Protocol-Version': '1'
    };

    if (csrfToken) {
        headers['X-Codeium-Csrf-Token'] = csrfToken;
    } else {
        throw new Error('Missing CSRF token');
    }

    const doRequest = (useHttps: boolean, targetPort: number) => new Promise((resolve, reject) => {
        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port: targetPort,
            path: config.path,
            method: 'POST',
            headers,
            rejectUnauthorized: false,
            timeout: config.timeout ?? 5000
        };

        const client = useHttps ? https : http;
        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    let errorDetail = '';
                    try {
                        const errorBody = JSON.parse(data);
                        errorDetail = errorBody.message || errorBody.error || JSON.stringify(errorBody);
                    } catch {
                        errorDetail = data || '(empty response)';
                    }
                    reject(new Error(`HTTP error: ${res.statusCode}, detail: ${errorDetail}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(new Error(`Failed to parse response: ${error}`));
                }
            });
        });

        req.on('error', (error) => reject(error));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.write(requestBody);
        req.end();
    });

    if (protocol === 'http') {
        try {
            return await doRequest(false, port);
        } catch (error: any) {
            if (httpPort && httpPort !== port) {
                return await doRequest(false, httpPort);
            }
            throw error;
        }
    }

    try {
        return await doRequest(true, port);
    } catch (error: any) {
        const msg = (error?.message || '').toLowerCase();
        const shouldRetryHttp = error.code === 'EPROTO' || msg.includes('wrong_version_number') || msg.includes('wrong version number');
        if (shouldRetryHttp) {
            const fallbackPort = httpPort && httpPort > 0 ? httpPort : port;
            return await doRequest(false, fallbackPort);
        }
        throw error;
    }
}

export class QuotaService {
    private readonly GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
    private readonly RETRIEVE_USER_QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

    private port: number;
    private httpPort?: number;
    private csrfToken: string;
    private protocol: 'https' | 'http';

    constructor(port: number, csrfToken: string, httpPort?: number, protocol: 'https' | 'http' = 'https') {
        this.port = port;
        this.csrfToken = csrfToken;
        this.httpPort = httpPort;
        this.protocol = protocol;
    }

    async fetchQuota(): Promise<QuotaSnapshot> {
        let userStatusSnapshot: QuotaSnapshot | null = null;
        let userStatusError: unknown = null;

        try {
            const userStatusResponse = await this.makeGetUserStatusRequest();
            userStatusSnapshot = parseQuotaResponse(userStatusResponse);
            if (userStatusSnapshot.models.length > 0) {
                return userStatusSnapshot;
            }
        } catch (error) {
            userStatusError = error;
        }

        // Fallback to RetrieveUserQuotaSummary (Antigravity 2.0 / agy hub bucketed quota endpoint)
        try {
            const summaryResponse = await this.makeRetrieveUserQuotaSummaryRequest();
            const summarySnapshot = parseQuotaSummaryResponse(summaryResponse, userStatusSnapshot || undefined);
            if (summarySnapshot.models.length > 0 || !userStatusSnapshot) {
                return summarySnapshot;
            }
        } catch (summaryError) {
            if (userStatusSnapshot) {
                return userStatusSnapshot;
            }
            throw userStatusError || summaryError;
        }

        return userStatusSnapshot!;
    }

    private async makeGetUserStatusRequest(): Promise<any> {
        return makeRequest(
            {
                path: this.GET_USER_STATUS_PATH,
                body: {
                    metadata: {
                        ideName: 'antigravity',
                        extensionName: 'antigravity',
                        ideVersion: versionInfo.getIdeVersion(),
                        locale: 'en'
                    }
                }
            },
            this.port,
            this.httpPort,
            this.csrfToken,
            this.protocol
        );
    }

    private async makeRetrieveUserQuotaSummaryRequest(): Promise<any> {
        return makeRequest(
            {
                path: this.RETRIEVE_USER_QUOTA_SUMMARY_PATH,
                body: {}
            },
            this.port,
            this.httpPort,
            this.csrfToken,
            this.protocol
        );
    }
}

export function parseQuotaResponse(response: any): QuotaSnapshot {
    if (!response || !response.userStatus) {
        throw new Error('API response format is invalid; missing userStatus');
    }

    const userStatus = response.userStatus;
    const planStatus = userStatus.planStatus;
    const modelConfigs = userStatus.cascadeModelConfigData?.clientModelConfigs || [];

    const monthlyCreditsRaw = planStatus?.planInfo?.monthlyPromptCredits;
    const availableCreditsRaw = planStatus?.availablePromptCredits;

    const monthlyCredits = monthlyCreditsRaw !== undefined ? Number(monthlyCreditsRaw) : undefined;
    const availableCredits = availableCreditsRaw !== undefined ? Number(availableCreditsRaw) : undefined;

    const promptCredits: PromptCreditsInfo | undefined =
        planStatus && monthlyCredits !== undefined && monthlyCredits > 0 && availableCredits !== undefined
            ? {
                available: availableCredits,
                monthly: monthlyCredits,
                usedPercentage: ((monthlyCredits - availableCredits) / monthlyCredits) * 100,
                remainingPercentage: (availableCredits / monthlyCredits) * 100
            }
            : undefined;

    const models: ModelQuotaInfo[] = modelConfigs
        .filter((config: any) => config.quotaInfo)
        .map((config: any) => parseModelQuota(config));

    const planName = userStatus?.userTier?.name;

    const userEmail = userStatus?.user?.email
        || userStatus?.email
        || userStatus?.user_email
        || userStatus?.contactEmail;

    return {
        timestamp: new Date(),
        promptCredits,
        models,
        planName,
        userEmail,
        rawUserStatus: userStatus
    };
}

export function parseQuotaSummaryResponse(summaryResponse: any, baseSnapshot?: QuotaSnapshot): QuotaSnapshot {
    const payload = summaryResponse?.response || summaryResponse;
    const groups = payload?.groups;

    if (!Array.isArray(groups)) {
        throw new Error('API response format is invalid; missing quota groups');
    }

    const models: ModelQuotaInfo[] = [];

    for (const group of groups) {
        const groupName = group.displayName || group.name || 'Quota';
        const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
        const activeBuckets = rawBuckets.filter((b: any) => !b.disabled);
        const bucketsToUse = activeBuckets.length > 0 ? activeBuckets : rawBuckets;

        for (const bucket of bucketsToUse) {
            const remainingFraction = bucket.remainingFraction !== undefined
                ? Number(bucket.remainingFraction)
                : (bucket.remaining_fraction !== undefined ? Number(bucket.remaining_fraction) : undefined);

            const resetTimeRaw = bucket.resetTime || bucket.reset_time;
            const resetTime = resetTimeRaw ? new Date(resetTimeRaw) : new Date(0);
            const isValidResetTime = !isNaN(resetTime.getTime()) && resetTime.getTime() > 0;
            const timeUntilReset = isValidResetTime ? resetTime.getTime() - Date.now() : 0;

            const bucketSuffix = bucket.displayName || bucket.window || bucket.bucketId;
            const label = bucketsToUse.length > 1 && bucketSuffix
                ? `${groupName} (${bucketSuffix})`
                : (groupName || bucketSuffix || 'Unknown');

            const modelId = bucket.bucketId || bucket.bucket_id || label;

            models.push({
                label,
                modelId,
                remainingFraction,
                remainingPercentage: remainingFraction !== undefined ? remainingFraction * 100 : undefined,
                isExhausted: remainingFraction === undefined || remainingFraction === 0,
                resetTime,
                timeUntilReset,
                timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset)
            });
        }
    }

    return {
        timestamp: new Date(),
        promptCredits: baseSnapshot?.promptCredits,
        models,
        planName: baseSnapshot?.planName,
        userEmail: baseSnapshot?.userEmail,
        rawUserStatus: baseSnapshot?.rawUserStatus || summaryResponse
    };
}

function parseModelQuota(config: any): ModelQuotaInfo {
    const quotaInfo = config.quotaInfo;
    const remainingFraction = quotaInfo?.remainingFraction;
    const resetTimeRaw = quotaInfo?.resetTime;
    const resetTime = resetTimeRaw ? new Date(resetTimeRaw) : new Date(0);
    const isValidResetTime = !isNaN(resetTime.getTime()) && resetTime.getTime() > 0;
    const timeUntilReset = isValidResetTime ? resetTime.getTime() - Date.now() : 0;
    const modelId = config.modelOrAlias?.model || config.modelOrAlias?.alias || config.modelId || config.label;

    return {
        label: config.label,
        modelId,
        remainingFraction,
        remainingPercentage: remainingFraction !== undefined ? remainingFraction * 100 : undefined,
        isExhausted: remainingFraction === undefined || remainingFraction === 0,
        resetTime,
        timeUntilReset,
        timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset),
        requestLimit: quotaInfo?.limit ?? quotaInfo?.maxRequestCount,
        requestUsage: quotaInfo?.usage ?? quotaInfo?.requestCount,
        tokenLimit: quotaInfo?.tokenLimit ?? quotaInfo?.maxTokens,
        tokenUsage: quotaInfo?.tokenUsage ?? quotaInfo?.tokensUsed
    };
}

function formatTimeUntilReset(ms: number): string {
    if (ms <= 0) {
        return 'Expired';
    }

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days}d${hours % 24}h from now`;
    } else if (hours > 0) {
        return `${hours}h ${minutes % 60}m from now`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s from now`;
    }
    return `${seconds}s from now`;
}
