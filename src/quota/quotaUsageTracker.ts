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

import { TelegramService } from '../telegram/telegramService';

export class QuotaUsageTracker {
    private context: vscode.ExtensionContext;
    private history: Map<string, UsagePoint[]> = new Map();
    private readonly MAX_POINTS = 50; // Legacy fixed count
    private readonly STORAGE_KEY = 'quotaUsageHistory';
    private historyRetentionDays: number = 7;
    private telegramService: TelegramService;

    constructor(context: vscode.ExtensionContext, telegramService: TelegramService) {
        this.context = context;
        this.telegramService = telegramService;

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
            let validPoints = points.filter(p => p.timestamp >= cutoff);

            // Enforce MAX_POINTS
            if (validPoints.length > this.MAX_POINTS) {
                // Keep the most recent ones
                validPoints = validPoints.slice(validPoints.length - this.MAX_POINTS);
            }

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

                    // Detect Reset
                    // If current usage is significantly less than last usage (e.g. dropped from > 80% to < 10% or just strictly < previous)
                    // Robust check: dropped by at least 10% and is now low (< 20%) OR just simply dropped if it was exhausted.
                    // Let's use a simple heuristic: if usage dropped by > 50% OR (was > 90% and now < 50%)
                    if (this.telegramService.isConfigured()) {
                        if (lastPoint.usage > 50 && currentUsage < 10) {
                            this.telegramService.sendBroadcast(`✅ Quota Reset Detected for *${model.label}*\n\nPrevious Usage: ${lastPoint.usage.toFixed(1)}%\nCurrent Usage: ${currentUsage.toFixed(1)}%`);
                        } else if (model.remainingPercentage !== undefined && lastPoint.usage > 99 && currentUsage < 99) {
                            // Was exhausted, now not
                            this.telegramService.sendBroadcast(`✅ Quota Restored for *${model.label}*`);
                        }
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

        const recentPoints = points.slice(startIndex);
        if (recentPoints.length < 2) return null;

        // Detect reset: if we find a point where usage < previous usage (significantly),
        // we should only consider points AFTER the reset.
        // Or, simpler: if the total usage diff is negative, try to find the reset point.

        let validStart = 0;
        for (let i = 1; i < recentPoints.length; i++) {
            if (recentPoints[i].usage < recentPoints[i - 1].usage) {
                // Drop detected (reset). Start estimation from this point.
                validStart = i;
            }
        }

        const usagePoints = recentPoints.slice(validStart);

        if (usagePoints.length < 2) {
            // Not enough data since reset
            return null;
        }

        const newest = usagePoints[usagePoints.length - 1];
        const oldest = usagePoints[0];

        const timeDiffHours = (newest.timestamp - oldest.timestamp) / (1000 * 60 * 60);
        if (timeDiffHours < 0.1) return null;

        const usageDiff = newest.usage - oldest.usage;
        if (usageDiff < 0) return null; // Should not happen with logic above

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
