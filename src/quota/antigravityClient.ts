import * as https from 'https';
import { ProcessPortDetector } from './processPortDetector';


export interface SearchResult {
    cascadeId: string;
    title: string;
    matches: SearchMatch[];
    lastModified: number;
    // Enriched fields
    status?: string;
    stepCount?: number;
    branch?: string;
    repo?: string;
}

export interface SearchMatch {
    text: string;
    role: 'user' | 'model';
    timestamp?: number;
}
// ... existing code ...
// ... existing code ...

export class AntigravityClient {
    private portDetector: ProcessPortDetector;
    private connectionInfo: { port: number; token: string } | null = null;

    constructor() {
        this.portDetector = new ProcessPortDetector();
    }

    private async ensureConnection(): Promise<{ port: number; token: string }> {
        if (this.connectionInfo) return this.connectionInfo;

        const info = await this.portDetector.detectProcessInfo();
        if (!info) {
            throw new Error('Antigravity Language Server not found. Please ensure the extension is running.');
        }

        this.connectionInfo = { port: info.connectPort, token: info.csrfToken };
        return this.connectionInfo;
    }

    private async request(method: string, body: any): Promise<any> {
        const { port, token } = await this.ensureConnection();

        return new Promise((resolve, reject) => {
            const requestBody = JSON.stringify(body);
            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: `/exa.language_server_pb.LanguageServerService/${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': token
                },
                rejectUnauthorized: false
            };

            const req = https.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () => {
                    const responseBody = Buffer.concat(chunks).toString();
                    if (res.statusCode === 200) {
                        try {
                            resolve(JSON.parse(responseBody));
                        } catch {
                            reject(new Error(`Failed to parse response: ${responseBody}`));
                        }
                    } else {
                        reject(new Error(`API Error ${res.statusCode}: ${responseBody}`));
                    }
                });
            });

            req.on('error', (e) => reject(e));
            req.write(requestBody);
            req.end();
        });
    }

    /**
     * Search across all conversations
     */
    async search(query: string): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        const queryLower = query.toLowerCase();

        try {
            // 1. Get all conversations
            // API: GetAllCascadeTrajectories
            const trajectories = await this.request('GetAllCascadeTrajectories', {});

            // Response might have trajectorySummaries as an array OR a Map (object)
            let list: any[] = [];
            const rawSummaries = trajectories.trajectorySummaries;

            if (Array.isArray(rawSummaries)) {
                list = rawSummaries;
            } else if (rawSummaries && typeof rawSummaries === 'object') {
                // The key is the cascadeId, the value is the summary object
                list = Object.entries(rawSummaries).map(([key, value]: [string, any]) => ({
                    ...value,
                    cascadeId: key // Inject key as cascadeId if missing
                }));
            }

            // If still empty try fallback keys if any (defensive)
            if (list.length === 0 && trajectories.cascadeTrajectories) {
                list = trajectories.cascadeTrajectories;
            }
            // Usually GetAll returns metadata.

            // Limit concurrent searches to avoid overwhelming the local server
            const batchSize = 5;
            for (let i = 0; i < list.length; i += batchSize) {
                const batch = list.slice(i, i + batchSize);
                await Promise.all(batch.map(async (item: any) => {
                    try {
                        const cascadeId = item.cascadeId;
                        if (!cascadeId) return;

                        // Fetch full trajectory
                        // API: GetCascadeTrajectory
                        const result = await this.request('GetCascadeTrajectory', {
                            cascadeId: cascadeId
                        });

                        const steps = result.trajectory?.steps || [];
                        const matches: SearchMatch[] = [];

                        for (const step of steps) {
                            let text = '';
                            let role: 'user' | 'model' = 'user';

                            if (step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
                                role = 'user';
                                if (step.userInput && Array.isArray(step.userInput.items) && step.userInput.items.length > 0) {
                                    text = step.userInput.items[0].text?.content || '';
                                } else if (step.userInput?.userResponse) {
                                    text = step.userInput.userResponse;
                                }
                            } else if (step.type === 'CORTEX_STEP_TYPE_MODEL_RESPONSE') {
                                role = 'model';
                                if (step.modelResponse && step.modelResponse.content && Array.isArray(step.modelResponse.content)) {
                                    text = step.modelResponse.content.map((c: any) => c.text?.content || '').join('\n');
                                } else if (step.modelResponse?.text) {
                                    text = step.modelResponse.text;
                                }
                            } else if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
                                role = 'model';
                                text = step.plannerResponse?.thinking || '';
                            } else {
                                text = step.message?.text || step.text || '';
                                role = step.header?.sender === 'USER' ? 'user' : 'model';
                            }

                            if (text && text.toLowerCase().includes(queryLower)) {
                                matches.push({
                                    text: text.substring(0, 1000) + (text.length > 1000 ? '...' : ''),
                                    role: role
                                });
                            }
                        }

                        if (matches.length > 0) {
                            // Extract workspace info
                            let branch: string | undefined;
                            let repo: string | undefined;
                            if (item.workspaces && item.workspaces.length > 0) {
                                branch = item.workspaces[0].branchName;
                                if (item.workspaces[0].repository) {
                                    repo = item.workspaces[0].repository.computedName;
                                }
                            }

                            results.push({
                                cascadeId: cascadeId,
                                title: item.summary || item.name || item.title || cascadeId,
                                matches: matches,
                                lastModified: item.lastModifiedTime ? new Date(item.lastModifiedTime).getTime() : Date.now(),
                                status: item.status,
                                stepCount: item.stepCount,
                                branch: branch,
                                repo: repo
                            });
                        }

                    } catch {
                        // Ignore error for single item
                        console.error(`Failed to search ${item.cascadeId}`); // removed _e
                    }
                }));
            }

        } catch (e) {
            console.error('Search failed', e);
            throw e;
        }

        return results;
    }

    /**
     * Get full conversation history using the non-paginated API
     */
    async getConversationMessages(cascadeId: string): Promise<any[]> {
        try {
            const result = await this.request('GetCascadeTrajectory', {
                cascadeId: cascadeId
            });
            return result.trajectory?.steps || [];
        } catch (e) {
            console.error(`Failed to fetch full trajectory for ${cascadeId}, falling back to steps API`, e);
            const details = await this.request('GetCascadeTrajectorySteps', {
                cascadeId: cascadeId,
                startIndex: 0,
                endIndex: 10000
            });
            return details.steps || details.step || [];
        }
    }

    /**
     * Get token usage metadata for a conversation
     */
    async getTrajectoryMetadata(cascadeId: string): Promise<any[]> {
        try {
            const result = await this.request('GetCascadeTrajectoryGeneratorMetadata', {
                cascadeId: cascadeId
            });
            return result.generatorMetadata || [];
        } catch (e) {
            console.error(`Failed to fetch metadata for ${cascadeId}`, e);
            return [];
        }
    }
    /**
     * Get details for a specific user trajectory (often contains missing text for steps)
     */
    async getUserTrajectory(trajectoryId: string): Promise<any> {
        try {
            return await this.request('GetUserTrajectory', {
                trajectoryId: trajectoryId
            });
        } catch (e) {
            console.error(`Failed to fetch user trajectory ${trajectoryId}`, e);
            return null;
        }
    }
}
