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
    private readonly MAX_POINTS = 50; // Keep last 50 points
    private readonly STORAGE_KEY = 'quotaUsageHistory';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadHistory();
    }

    private loadHistory() {
        const data = this.context.globalState.get<ModelUsageHistory[]>(this.STORAGE_KEY, []);
        data.forEach(item => {
            this.history.set(item.modelId, item.points);
        });
    }

    private saveHistory() {
        const data: ModelUsageHistory[] = [];
        this.history.forEach((points, modelId) => {
            data.push({ modelId, points });
        });
        this.context.globalState.update(this.STORAGE_KEY, data);
    }

    public track(snapshot: QuotaSnapshot) {
        let changed = false;
        const now = Date.now();

        snapshot.models.forEach(model => {
            if (model.remainingPercentage !== undefined) {
                const points = this.history.get(model.modelId) || [];

                // Add new point
                // Only add if it's different enough or enough time passed (e.g. 5 mins)
                // to avoid noise. But for now, let's just add every successful fetch (1 min interval).
                // Actually, if value hasn't changed, maybe skip to save space? 
                // But we need time progression to calculate speed 0 if usage is 0.

                points.push({ timestamp: now, usage: 100 - model.remainingPercentage });

                // Prune old points (older than 24h?) or just by count
                // Let's keep by count for simplicity first
                if (points.length > this.MAX_POINTS) {
                    points.shift();
                }

                this.history.set(model.modelId, points);
                changed = true;
            }
        });

        if (changed) {
            this.saveHistory();
        }
    }

    public getEstimation(modelId: string): { speedPerHour: number, estimatedTimeRemainingMs: number | null } | null {
        const points = this.history.get(modelId);
        if (!points || points.length < 2) return null;

        // Calculate speed based on first and last point in the window
        // Or linear regression for better accuracy?
        // Let's do simple slope between oldest and newest in our window
        const newest = points[points.length - 1];
        const oldest = points[0];

        const timeDiffHours = (newest.timestamp - oldest.timestamp) / (1000 * 60 * 60);
        if (timeDiffHours < 0.1) return null; // Not enough time span

        const usageDiff = newest.usage - oldest.usage; // usage is consumed %, so it should increase

        // If usage decreased (reset happened), we need to handle that.
        // Simple heuristic: if newest < oldest, reset happened.
        // In that case, find the dip and calculate from there.
        // For now, if reset detected, just return null or restart calculation from dip.
        if (usageDiff < 0) {
            // Reset detected in window using simple check. 
            // Let's find the reset point.
            let resetIndex = -1;
            for (let i = 1; i < points.length; i++) {
                if (points[i].usage < points[i - 1].usage) {
                    resetIndex = i;
                }
            }
            if (resetIndex !== -1 && resetIndex < points.length - 1) {
                // Use data after reset
                const postResetOldest = points[resetIndex];
                const postResetNewest = points[points.length - 1];
                const prTimeDiff = (postResetNewest.timestamp - postResetOldest.timestamp) / (1000 * 60 * 60);
                if (prTimeDiff < 0.05) return null;

                const prUsageDiff = postResetNewest.usage - postResetOldest.usage;
                const speed = prUsageDiff / prTimeDiff;
                return this.calcResult(speed, newest.usage);
            }
            return null;
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
