import * as vscode from 'vscode';
import { QuotaSnapshot } from './types';

interface UsagePoint {
    timestamp: number;
    usage: number; // Percentage (0-100) or raw units if available
}

interface ModelUsageHistory {
    modelId: string;
    points: UsagePoint[];
}

export class QuotaUsageTracker {
    private context: vscode.ExtensionContext;
    private history: Map<string, UsagePoint[]> = new Map();
    private readonly MAX_POINTS = 50; // Legacy fixed count
    private readonly STORAGE_KEY = 'quotaUsageHistory';
    private historyRetentionDays: number = 7;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.updateConfig();
        this.loadHistory();

        // Listen for config changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-storage-manager.quota.historyRetentionDays')) {
                this.updateConfig();
            }
        });
    }

    private updateConfig() {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        this.historyRetentionDays = config.get<number>('quota.historyRetentionDays', 7);
    }

    private loadHistory() {
        const data = this.context.globalState.get<ModelUsageHistory[]>(this.STORAGE_KEY, []);
        data.forEach(item => {
            this.history.set(item.modelId, item.points);
        });

        // Prune on load
        this.pruneHistory();
    }

    private saveHistory() {
        const data: ModelUsageHistory[] = [];
        this.history.forEach((points, modelId) => {
            data.push({ modelId, points });
        });
        this.context.globalState.update(this.STORAGE_KEY, data);
    }

    private pruneHistory() {
        const cutoff = Date.now() - (this.historyRetentionDays * 24 * 60 * 60 * 1000);
        this.history.forEach((points, modelId) => {
            // Filter points older than cutoff
            const validPoints = points.filter(p => p.timestamp >= cutoff);

            // Optimization: If we have too many points (e.g. > 500 for 7 days), maybe downsample?
            // For now, let's just keep them. 1 point per minute = 1440 per day.
            // That's too much for storage?
            // Maybe we should only store if changed significantly or at minimum interval (e.g. 1 hour).
            // But we want resolution.
            // Let's enforce minimum interval of 15 minutes between points if value hasn't changed much?
            // Actually, `track` method calls every minute. We should rate limit storage there.

            this.history.set(modelId, validPoints);
        });
    }

    public track(snapshot: QuotaSnapshot) {
        let changed = false;
        const now = Date.now();
        const minInterval = 10 * 60 * 1000; // 10 minutes interval to save space

        snapshot.models.forEach(model => {
            if (model.remainingPercentage !== undefined) {
                const points = this.history.get(model.modelId) || [];
                const lastPoint = points.length > 0 ? points[points.length - 1] : null;

                // Add point if:
                // 1. No points
                // 2. Value changed significantly (> 0.1%)
                // 3. Time elapsed > minInterval

                const currentUsage = 100 - model.remainingPercentage;

                let shouldAdd = false;
                if (!lastPoint) {
                    shouldAdd = true;
                } else {
                    const timeDiff = now - lastPoint.timestamp;
                    const usageDiff = Math.abs(currentUsage - lastPoint.usage);

                    if (usageDiff > 0.1 || timeDiff > minInterval) {
                        shouldAdd = true;
                    }
                }

                if (shouldAdd) {
                    points.push({ timestamp: now, usage: currentUsage });
                    this.history.set(model.modelId, points);
                    changed = true;
                }
            }
        });

        if (changed) {
            this.pruneHistory();
            this.saveHistory();
        }
    }

    public getHistory(modelId: string): UsagePoint[] {
        return this.history.get(modelId) || [];
    }

    public getEstimation(modelId: string): { speedPerHour: number, estimatedTimeRemainingMs: number | null } | null {
        const points = this.history.get(modelId);
        if (!points || points.length < 2) return null;

        // Calculate speed based on last 24h or available window
        const now = Date.now();
        const oneDayAgo = now - (24 * 60 * 60 * 1000);

        let startIndex = 0;
        // Find first point within last 24h
        for (let i = 0; i < points.length; i++) {
            if (points[i].timestamp >= oneDayAgo) {
                startIndex = i;
                break;
            }
        }

        // If all points are older than 24h (shouldn't happen with pruning/tracking), use last few
        // If we only have 1 point in last 24h, we need previous point to estimate speed?

        const recentPoints = points.slice(startIndex);
        if (recentPoints.length < 2) return null;

        const newest = recentPoints[recentPoints.length - 1];
        const oldest = recentPoints[0];

        const timeDiffHours = (newest.timestamp - oldest.timestamp) / (1000 * 60 * 60);
        if (timeDiffHours < 0.1) return null;

        const usageDiff = newest.usage - oldest.usage;

        if (usageDiff < 0) {
            // Reset detected
            return null; // TODO: handle reset better
        }

        const speed = usageDiff / timeDiffHours; // % per hour
        return this.calcResult(speed, newest.usage);
    }

    private calcResult(speed: number, currentUsage: number) {
        if (speed <= 0) return { speedPerHour: 0, estimatedTimeRemainingMs: null };

        const remainingUsage = 100 - currentUsage;
        const hoursRemaining = remainingUsage / speed;

        return {
            speedPerHour: speed,
            estimatedTimeRemainingMs: hoursRemaining * 60 * 60 * 1000
        };
    }
}
