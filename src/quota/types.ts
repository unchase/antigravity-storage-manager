
export interface ModelQuotaInfo {
    label: string;
    modelId: string;
    remainingFraction?: number;
    remainingPercentage?: number;
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: number;
    timeUntilResetFormatted: string;
    requestLimit?: number;
    requestUsage?: number;
    tokenLimit?: number;
    tokenUsage?: number;
}

export interface PromptCreditsInfo {
    available: number;
    monthly: number;
    usedPercentage: number;
    remainingPercentage: number;
}

export interface QuotaSnapshot {
    timestamp: Date;
    promptCredits?: PromptCreditsInfo;
    models: ModelQuotaInfo[];
    planName?: string;
    userEmail?: string;
    projectId?: string;
    error?: string;
}

// API Response Types
export interface UserStatusResponse {
    userStatus?: {
        planStatus?: {
            planInfo?: {
                monthlyPromptCredits?: string | number;
            };
            availablePromptCredits?: string | number;
        };
        cascadeModelConfigData?: {
            clientModelConfigs?: any[];
        };
        userTier?: {
            name?: string;
        };
    };
}

// Strategy Interface
export interface IPlatformStrategy {
    getProcessListCommand(processName: string): string;
    parseProcessInfo(stdout: string): { pid: number; extensionPort: number; csrfToken: string } | null;
    getPortListCommand(pid: number): string;
    parseListeningPorts(stdout: string): number[];
    getErrorMessages(): { processNotFound: string; commandNotAvailable: string; requirements: string[] };
    ensurePortCommandAvailable(): Promise<void>;
}
