
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { QuotaSnapshot, PromptCreditsInfo, ModelQuotaInfo, ModelCapabilities } from "./types";
import { versionInfo } from "./versionInfo";

const execFileAsync = promisify(execFile);

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
        headers['x-antigravity-csrf-token'] = csrfToken;
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
        planStatus && monthlyCredits !== undefined && !isNaN(monthlyCredits) && monthlyCredits > 0 && availableCredits !== undefined && !isNaN(availableCredits)
            ? {
                available: availableCredits,
                monthly: monthlyCredits,
                usedPercentage: ((monthlyCredits - availableCredits) / monthlyCredits) * 100,
                remainingPercentage: (availableCredits / monthlyCredits) * 100
            }
            : undefined;

    const monthlyFlowCreditsRaw = planStatus?.planInfo?.monthlyFlowCredits;
    const availableFlowCreditsRaw = planStatus?.availableFlowCredits;
    const monthlyFlowCredits = monthlyFlowCreditsRaw !== undefined ? Number(monthlyFlowCreditsRaw) : undefined;
    const availableFlowCredits = availableFlowCreditsRaw !== undefined ? Number(availableFlowCreditsRaw) : undefined;

    const flowCredits: PromptCreditsInfo | undefined =
        planStatus && monthlyFlowCredits !== undefined && !isNaN(monthlyFlowCredits) && monthlyFlowCredits > 0 && availableFlowCredits !== undefined && !isNaN(availableFlowCredits)
            ? {
                available: availableFlowCredits,
                monthly: monthlyFlowCredits,
                usedPercentage: ((monthlyFlowCredits - availableFlowCredits) / monthlyFlowCredits) * 100,
                remainingPercentage: (availableFlowCredits / monthlyFlowCredits) * 100
            }
            : undefined;

    const userTeamsTier: string | undefined = planStatus?.planInfo?.teamsTier;
    const upgradeSubscriptionText: string | undefined = userStatus?.userTier?.upgradeSubscriptionText;

    const models: ModelQuotaInfo[] = modelConfigs
        .filter((config: any) =>
            Boolean(config?.quotaInfo) ||
            Boolean(
                config?.label && (
                    config?.disabled ||
                    config?.isDisabled ||
                    config?.unavailable ||
                    config?.isUnavailable ||
                    config?.disabledReason ||
                    config?.unavailableReason ||
                    config?.modelOrAlias ||
                    config?.modelId
                )
            )
        )
        .map((config: any) => parseModelQuota(config, userTeamsTier, upgradeSubscriptionText));

    const planName = userStatus?.userTier?.name;

    const userEmail = userStatus?.user?.email
        || userStatus?.email
        || userStatus?.user_email
        || userStatus?.contactEmail;

    return {
        timestamp: new Date(),
        promptCredits,
        flowCredits,
        models,
        planName,
        userEmail,
        rawUserStatus: userStatus
    };
}

export function parseQuotaSummaryResponse(summaryResponse: any, baseSnapshot?: QuotaSnapshot): QuotaSnapshot {
    const payload = summaryResponse?.command?.data || summaryResponse?.response || summaryResponse;
    const groups = payload?.groups;

    if (!Array.isArray(groups)) {
        throw new Error('API response format is invalid; missing quota groups');
    }

    const models: ModelQuotaInfo[] = [];

    for (const group of groups) {
        const groupName = group.displayName || group.name || 'Quota';
        const groupDescription: string | undefined = typeof group.description === 'string' && group.description.trim()
            ? group.description.trim()
            : undefined;
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
            const timeUntilReset = isValidResetTime ? Math.max(0, resetTime.getTime() - Date.now()) : 0;

            const rawBucketSuffix = bucket.displayName || bucket.name || bucket.window || bucket.bucketId || bucket.id;
            const bucketSuffix = typeof rawBucketSuffix === 'string'
                ? rawBucketSuffix
                    .replace(/\bFive[\s-]+Hour\b/gi, '5-Hour')
                    .replace(/\s+Remaining$/i, '')
                    .trim()
                : rawBucketSuffix;
            const label = bucketsToUse.length > 1 && bucketSuffix
                ? `${groupName} (${bucketSuffix})`
                : (groupName || bucketSuffix || 'Unknown');

            const modelId = bucket.bucketId || bucket.bucket_id || bucket.id || label;
            const canonicalModelId: string | undefined = typeof (bucket.id || bucket.bucketId || bucket.bucket_id) === 'string'
                ? String(bucket.id || bucket.bucketId || bucket.bucket_id)
                : undefined;

            const bucketDescription: string | undefined = typeof bucket.description === 'string' && bucket.description.trim()
                ? bucket.description.trim()
                : undefined;
            const descParts = [bucketDescription, groupDescription].filter((p): p is string => Boolean(p));
            const tagDescription = descParts.length > 0 ? descParts.join(' • ') : undefined;
            const isDisabled = Boolean(bucket.disabled);

            models.push({
                label,
                modelId,
                canonicalModelId,
                remainingFraction,
                remainingPercentage: remainingFraction !== undefined && !isNaN(remainingFraction) ? remainingFraction * 100 : undefined,
                isExhausted: isDisabled || remainingFraction === undefined || remainingFraction === 0,
                isDisabled,
                tagDescription,
                resetTime,
                timeUntilReset,
                timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset)
            });
        }
    }

    return {
        timestamp: new Date(),
        promptCredits: baseSnapshot?.promptCredits,
        flowCredits: baseSnapshot?.flowCredits,
        models,
        planName: baseSnapshot?.planName,
        userEmail: baseSnapshot?.userEmail,
        rawUserStatus: baseSnapshot?.rawUserStatus || summaryResponse
    };
}

export function findAgyExecutable(): string {
    const isWin = process.platform === 'win32';
    const binName = isWin ? 'agy.exe' : 'agy';
    const candidates: string[] = [
        path.join(os.homedir(), '.gemini', 'bin', binName)
    ];

    if (isWin && process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin', binName));
    } else if (!isWin) {
        candidates.push('/usr/local/bin/agy', '/opt/homebrew/bin/agy');
    }

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // Ignore fs errors and continue
        }
    }

    return binName;
}

export async function fetchQuotaViaAgyCli(baseSnapshot?: QuotaSnapshot): Promise<QuotaSnapshot> {
    const agyExecutable = findAgyExecutable();
    const { stdout } = await execFileAsync(
        agyExecutable,
        ['-p', '/usage', '--output-format', 'json', '--print-timeout', '15s'],
        {
            timeout: 20000,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024
        }
    );

    const trimmed = (stdout || '').trim();
    const jsonStart = trimmed.indexOf('{');
    const jsonEnd = trimmed.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
        throw new Error('agy CLI /usage did not return valid JSON');
    }

    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    return parseQuotaSummaryResponse(parsed, baseSnapshot);
}

function parseModelQuota(config: any, userTeamsTier?: string, upgradeSubscriptionText?: string): ModelQuotaInfo {
    const quotaInfo = config.quotaInfo;
    const remainingFraction = quotaInfo?.remainingFraction;
    const resetTimeRaw = quotaInfo?.resetTime;
    const resetTime = resetTimeRaw ? new Date(resetTimeRaw) : new Date(0);
    const isValidResetTime = !isNaN(resetTime.getTime()) && resetTime.getTime() > 0;
    const timeUntilReset = isValidResetTime ? resetTime.getTime() - Date.now() : 0;
    const modelId = config.modelOrAlias?.model || config.modelOrAlias?.alias || config.modelId || config.label;

    const tagTitle: string | undefined = typeof config.tagTitle === 'string' && config.tagTitle.trim()
        ? config.tagTitle.trim()
        : undefined;
    const tagDescription: string | undefined = typeof config.tagDescription === 'string' && config.tagDescription.trim()
        ? config.tagDescription.trim()
        : (typeof config.tooltip === 'string' && config.tooltip.trim() ? config.tooltip.trim() : undefined);

    const allowedTiers: string[] | undefined = Array.isArray(config.allowedTiers) ? config.allowedTiers : undefined;
    const explicitlyDisabled = Boolean(
        config.disabled === true ||
        config.isDisabled === true ||
        config.unavailable === true ||
        config.isUnavailable === true
    );
    const tierRestricted = Boolean(
        userTeamsTier &&
        allowedTiers &&
        allowedTiers.length > 0 &&
        !allowedTiers.includes(userTeamsTier)
    );
    const missingQuotaInfo = !quotaInfo;
    const isDisabled = explicitlyDisabled || tierRestricted || missingQuotaInfo;

    let disabledReason: string | undefined;
    if (isDisabled) {
        const rawReason = config.disabledReason || config.unavailableReason || config.disabledMessage;
        if (typeof rawReason === 'string' && rawReason.trim()) {
            disabledReason = rawReason.trim();
        } else if (tierRestricted && upgradeSubscriptionText) {
            disabledReason = upgradeSubscriptionText;
        } else if (tagDescription) {
            disabledReason = tagDescription;
        }
    }

    const canonicalModelId: string | undefined = typeof config.modelId === 'string' && config.modelId.trim()
        ? config.modelId.trim()
        : undefined;

    const mimeMap = config.supportedMimeTypes && typeof config.supportedMimeTypes === 'object'
        ? config.supportedMimeTypes as Record<string, boolean>
        : undefined;
    const enabledMimes = mimeMap
        ? Object.keys(mimeMap).filter(k => mimeMap[k])
        : [];
    const hasImages = Boolean(config.supportsImages) || enabledMimes.some(m => m.startsWith('image/'));
    const hasDocuments = enabledMimes.some(m =>
        m === 'application/pdf' ||
        m.includes('msword') ||
        m.includes('officedocument') ||
        m.includes('opendocument') ||
        m === 'text/markdown' ||
        m === 'text/csv'
    );
    const hasAudio = enabledMimes.some(m => m.startsWith('audio/') || m.startsWith('video/audio/'));
    const hasVideo = enabledMimes.some(m => m === 'video/mp4' || m === 'video/webm' || m === 'video/quicktime');
    const capabilities: ModelCapabilities | undefined = (hasImages || hasDocuments || hasAudio || hasVideo)
        ? { images: hasImages, documents: hasDocuments, audio: hasAudio, video: hasVideo }
        : undefined;

    return {
        label: config.label,
        modelId,
        canonicalModelId,
        remainingFraction,
        remainingPercentage: remainingFraction !== undefined ? remainingFraction * 100 : undefined,
        isExhausted: isDisabled || remainingFraction === undefined || remainingFraction === 0,
        resetTime,
        timeUntilReset,
        timeUntilResetFormatted: formatTimeUntilReset(timeUntilReset),
        requestLimit: quotaInfo?.limit ?? quotaInfo?.maxRequestCount,
        requestUsage: quotaInfo?.usage ?? quotaInfo?.requestCount,
        tokenLimit: quotaInfo?.tokenLimit ?? quotaInfo?.maxTokens,
        tokenUsage: quotaInfo?.tokenUsage ?? quotaInfo?.tokensUsed,
        tagTitle,
        tagDescription,
        isDisabled,
        disabledReason,
        allowedTiers,
        capabilities
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
