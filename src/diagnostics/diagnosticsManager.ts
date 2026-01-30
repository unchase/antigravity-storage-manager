import * as https from 'https';
import { GoogleAuthProvider } from '../googleAuth';
import { QuotaManager } from '../quota/quotaManager';
import { LocalizationManager } from '../l10n/localizationManager';

import { AntigravityClient } from '../quota/antigravityClient';

export interface DiagnosticResult {
    id: string;
    label: string;
    status: 'pass' | 'fail' | 'warn';
    message: string;
    details?: string;
}

export class DiagnosticsManager {
    private authProvider: GoogleAuthProvider;
    private quotaManager: QuotaManager;
    private client: AntigravityClient;

    constructor(authProvider: GoogleAuthProvider, quotaManager: QuotaManager) {
        this.authProvider = authProvider;
        this.quotaManager = quotaManager;
        this.client = new AntigravityClient();
    }

    public async runDiagnostics(): Promise<DiagnosticResult[]> {
        const results: DiagnosticResult[] = [];

        // 1. Check Internet Connectivity
        results.push(await this.checkInternet());

        // 2. Check Auth Status
        results.push(this.checkAuth());

        // 3. Check Quota System (Local Port)
        results.push(await this.checkQuotaSystem());

        // 4. Check Server Heartbeat
        results.push(await this.checkHeartbeat());

        // 5. Check Drive API Latency (if authenticated)
        if (this.authProvider.isAuthenticated()) {
            results.push(await this.checkDriveLatency());
        }

        return results;
    }

    private async checkInternet(): Promise<DiagnosticResult> {
        const lm = LocalizationManager.getInstance();
        return new Promise((resolve) => {
            const start = Date.now();
            https.get('https://www.google.com', { timeout: 5000 }, (res) => {
                const duration = Date.now() - start;
                resolve({
                    id: 'internet',
                    label: lm.t('Internet Connectivity'),
                    status: res.statusCode === 200 ? 'pass' : 'warn',
                    message: res.statusCode === 200 ? lm.t('Connected ({0}ms)', duration) : lm.t('Status Code: {0}', res.statusCode),
                });
            }).on('error', (err) => {
                resolve({
                    id: 'internet',
                    label: lm.t('Internet Connectivity'),
                    status: 'fail',
                    message: lm.t('Connection failed'),
                    details: err.message
                });
            });
        });
    }

    private checkAuth(): DiagnosticResult {
        const lm = LocalizationManager.getInstance();
        const isAuth = this.authProvider.isAuthenticated();
        return {
            id: 'auth',
            label: lm.t('Google Drive Authentication'),
            status: isAuth ? 'pass' : 'warn',
            message: isAuth ? lm.t('Authenticated') : lm.t('Not signed in'),
            details: isAuth ? undefined : lm.t('Sync features will be disabled')
        };
    }

    private async checkQuotaSystem(): Promise<DiagnosticResult> {
        const lm = LocalizationManager.getInstance();
        try {
            // We can try to get quota snapshop directly
            const snapshot = await this.quotaManager.getQuota();
            return {
                id: 'quota',
                label: lm.t('Antigravity Language Server'),
                status: 'pass',
                message: lm.t('Connected'),
                details: snapshot ? lm.t('Plan: {0}', snapshot.planName) : undefined
            };
        } catch (e: any) {
            return {
                id: 'quota',
                label: lm.t('Antigravity Language Server'),
                status: 'fail',
                message: lm.t('Connection failed'),
                details: e.message
            };
        }
    }

    private async checkHeartbeat(): Promise<DiagnosticResult> {
        const lm = LocalizationManager.getInstance();
        try {
            const res = await this.client.getHeartbeat();
            return {
                id: 'heartbeat',
                label: lm.t('Server Heartbeat'),
                status: 'pass',
                message: lm.t('Pulse Detected'),
                details: res.uuid ? `UUID: ${res.uuid}` : undefined
            };
        } catch (e: any) {
            return {
                id: 'heartbeat',
                label: lm.t('Server Heartbeat'),
                status: 'fail',
                message: lm.t('No Pulse'),
                details: e.message
            };
        }
    }

    private async checkDriveLatency(): Promise<DiagnosticResult> {
        const lm = LocalizationManager.getInstance();
        try {
            const client = this.authProvider.getOAuth2Client();
            if (!client) throw new Error('No client');

            const start = Date.now();
            // Perform a lightweight call, e.g. get user info or about
            await this.authProvider.getUserInfo();
            const duration = Date.now() - start;

            let status: 'pass' | 'warn' | 'fail' = 'pass';
            if (duration > 2000) status = 'warn';
            if (duration > 5000) status = 'fail';

            return {
                id: 'latency',
                label: lm.t('Google Drive Latency'),
                status: status,
                message: `${duration}ms`,
                details: status === 'warn' ? lm.t('High latency detected') : undefined
            };
        } catch (e: any) {
            return {
                id: 'latency',
                label: lm.t('Google Drive Latency'),
                status: 'fail',
                message: lm.t('Request failed'),
                details: e.message
            };
        }
    }
}
