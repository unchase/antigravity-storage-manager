
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
    csrfToken: string | undefined
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

    try {
        return await doRequest(true, port);
    } catch (error: any) {
        const msg = (error?.message || '').toLowerCase();
        const shouldRetryHttp = httpPort !== undefined && (error.code === 'EPROTO' || msg.includes('wrong_version_number'));
        if (shouldRetryHttp && httpPort) {
            return await doRequest(false, httpPort);
        }
        throw error;
    }
}

export class QuotaService {
    private readonly GET_USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

    private port: number;
    private httpPort?: number;
    private csrfToken: string;

    constructor(port: number, csrfToken: string, httpPort?: number) {
        this.port = port;
        this.csrfToken = csrfToken;
        this.httpPort = httpPort;
    }

    async fetchQuota(): Promise<QuotaSnapshot> {
        const userStatusResponse = await this.makeGetUserStatusRequest();
        return parseQuotaResponse(userStatusResponse);
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
            this.csrfToken
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

function parseModelQuota(config: any): ModelQuotaInfo {
    const quotaInfo = config.quotaInfo;
    const remainingFraction = quotaInfo?.remainingFraction;
    const resetTime = new Date(quotaInfo.resetTime);
    const timeUntilReset = resetTime.getTime() - Date.now();

    return {
        label: config.label,
        modelId: config.modelOrAlias.model,
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
