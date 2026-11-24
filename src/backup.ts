import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LocalizationManager } from './l10n/localizationManager';

import archiver from 'archiver';
import { getStoragePaths } from './utils';

const EXT_NAME = 'antigravity-storage-manager';
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // Cap setInterval tick at 24h to prevent 32-bit timer overflow

function isPathInside(parent: string, child: string): boolean {
    const resolvedParent = path.resolve(parent);
    const resolvedChild = path.resolve(child);
    const rel = path.relative(resolvedParent, resolvedChild);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class BackupManager implements vscode.Disposable {
    private explicitStorageRoot?: string;
    private startupTimer: NodeJS.Timeout | undefined;
    private timer: NodeJS.Timeout | undefined;
    private isBackingUp: boolean = false;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext, storageRoot?: string) {
        this.context = context;
        this.explicitStorageRoot = storageRoot;
    }

    private getStorageRoot(): string {
        return this.explicitStorageRoot || getStoragePaths().storageRoot;
    }

    private getBrainDir(): string {
        return this.explicitStorageRoot ? path.join(this.explicitStorageRoot, 'brain') : getStoragePaths().brainDir;
    }

    private getConvDir(): string {
        return this.explicitStorageRoot ? path.join(this.explicitStorageRoot, 'conversations') : getStoragePaths().convDir;
    }

    /**
     * Initialize backup manager
     */
    initialize() {
        // Run initial check after a short delay to let VS Code startup finish
        this.startupTimer = setTimeout(() => {
            this.startupTimer = undefined;
            this.checkAndSchedule();
        }, 10000);

        // Listen for config changes
        this.context.subscriptions.push(
            this,
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`${EXT_NAME}.backup`)) {
                    this.checkAndSchedule();
                }
            })
        );
    }

    dispose(): void {
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = undefined;
        }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private checkAndSchedule() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        const config = vscode.workspace.getConfiguration(`${EXT_NAME}.backup`);
        const enabled = config.get<boolean>('enabled', false);

        if (!enabled) {
            console.log('Antigravity Backups: Disabled');
            return;
        }

        const rawIntervalHours = config.get<number>('interval', 24);
        const intervalHours = (typeof rawIntervalHours === 'number' && Number.isFinite(rawIntervalHours) && rawIntervalHours >= 1)
            ? rawIntervalHours
            : 24;
        const intervalMs = intervalHours * 60 * 60 * 1000;
        const tickMs = Math.min(intervalMs, MAX_INTERVAL_MS);

        console.log(`Antigravity Backups: Enabled. Interval: ${intervalHours}h`);

        this.timer = setInterval(() => {
            this.checkLastBackupTime(intervalMs).catch(err => {
                console.error('Scheduled backup tick error:', err);
            });
        }, tickMs);

        // Also check if we should run now (missed window or first run)
        this.checkLastBackupTime(intervalMs).catch(err => {
            console.error('Initial scheduled backup check error:', err);
        });
    }

    private async checkLastBackupTime(intervalMs: number) {
        const lastBackupTime = this.context.globalState.get<string>('lastBackupTime');
        const now = Date.now();
        const lastMs = lastBackupTime ? new Date(lastBackupTime).getTime() : NaN;

        if (!lastBackupTime || Number.isNaN(lastMs) || (now - lastMs > intervalMs)) {
            await this.performScheduledBackup();
        }
    }

    private async performScheduledBackup() {
        if (this.isBackingUp) {
            return;
        }
        try {
            await this.backupNow();
        } catch (error: any) {
            if (error instanceof vscode.CancellationError) {
                return;
            }
            const lm = LocalizationManager.getInstance();
            vscode.window.showErrorMessage(lm.t('Scheduled backup failed: {0}', error.message));
        }
    }

    /**
     * Perform immediate backup.
     * Supports both a destination directory (auto-generates `backup-<timestamp>.zip` + retention)
     * and an explicit `.zip` file path (writes directly to that file without deleting sibling backups).
     */
    async backupNow(targetPath?: string, token?: vscode.CancellationToken): Promise<string> {
        if (token?.isCancellationRequested) throw new vscode.CancellationError();
        if (this.isBackingUp) {
            throw new Error('A backup is already in progress');
        }

        this.isBackingUp = true;
        try {
            const config = vscode.workspace.getConfiguration(`${EXT_NAME}.backup`);
            const isExplicitZipFile = Boolean(targetPath && targetPath.toLowerCase().endsWith('.zip'));

            let backupDir: string;
            let filePath: string;

            if (isExplicitZipFile && targetPath) {
                filePath = path.resolve(targetPath);
                backupDir = path.dirname(filePath);
            } else {
                let dir = targetPath;
                if (!dir) {
                    dir = config.get<string>('path');
                    if (!dir || dir.trim() === '') {
                        dir = path.join(this.getStorageRoot(), 'backups');
                    }
                }
                backupDir = path.resolve(dir);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                filePath = path.join(backupDir, `backup-${timestamp}.zip`);
            }

            const brainDir = this.getBrainDir();
            const convDir = this.getConvDir();
            if (isPathInside(brainDir, backupDir) || isPathInside(convDir, backupDir)) {
                throw new Error('Backup destination cannot be inside brain or conversations directory');
            }

            if (token?.isCancellationRequested) throw new vscode.CancellationError();

            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            await this.createZipAtomically(filePath, token);

            if (token?.isCancellationRequested) throw new vscode.CancellationError();

            await this.context.globalState.update('lastBackupTime', new Date().toISOString());

            // Only enforce retention for managed backup directories, not arbitrary Save As targets
            if (!isExplicitZipFile) {
                await this.cleanOldBackups(backupDir);
            }

            return filePath;
        } finally {
            this.isBackingUp = false;
        }
    }

    private createZipAtomically(zipPath: string, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
        const tmpPath = `${zipPath}.${process.pid}.${Date.now()}.tmp`;

        return new Promise((resolve, reject) => {
            let settled = false;
            let cancelled = false;
            let cancelSub: vscode.Disposable | undefined;

            const cleanupTmp = () => {
                try {
                    if (fs.existsSync(tmpPath)) {
                        fs.unlinkSync(tmpPath);
                    }
                } catch {
                    // Best effort
                }
            };

            const finish = (err?: unknown) => {
                if (settled) return;
                settled = true;
                cancelSub?.dispose();
                if (err) {
                    cleanupTmp();
                    reject(err);
                } else {
                    resolve();
                }
            };

            const output = fs.createWriteStream(tmpPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            if (token) {
                cancelSub = token.onCancellationRequested(() => {
                    cancelled = true;
                    archive.abort();
                    output.close(() => {
                        finish(new vscode.CancellationError());
                    });
                });
            }

            output.on('error', (err) => finish(err));
            archive.on('error', (err) => {
                output.close(() => finish(err));
            });
            archive.on('warning', (warn) => {
                console.warn('Backup archive warning:', warn.message);
            });

            output.on('close', () => {
                if (cancelled) {
                    finish(new vscode.CancellationError());
                    return;
                }
                try {
                    fs.renameSync(tmpPath, zipPath);
                    finish();
                } catch (err) {
                    finish(err);
                }
            });

            archive.pipe(output);

            const brainDir = this.getBrainDir();
            const convDir = this.getConvDir();
            if (fs.existsSync(brainDir)) {
                archive.directory(brainDir, 'brain');
            }
            if (fs.existsSync(convDir)) {
                // Exclude ephemeral SQLite shared-memory index files (.db-shm)
                archive.glob('**/*', {
                    cwd: convDir,
                    ignore: ['**/*.db-shm']
                }, { prefix: 'conversations' });
            }

            archive.finalize();
        });
    }

    private async cleanOldBackups(backupDir: string) {
        const config = vscode.workspace.getConfiguration(`${EXT_NAME}.backup`);
        const rawRetention = config.get<number>('retention', 10);
        const keep = typeof rawRetention === 'number' && Number.isFinite(rawRetention)
            ? Math.floor(rawRetention)
            : 10;

        if (keep <= 0) return;

        try {
            const entries = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('backup-') && f.endsWith('.zip'));

            const files: Array<{ name: string; path: string; time: number }> = [];
            for (const f of entries) {
                const full = path.join(backupDir, f);
                try {
                    const st = fs.lstatSync(full);
                    if (st.isFile()) {
                        files.push({ name: f, path: full, time: st.mtime.getTime() });
                    }
                } catch {
                    // Skip broken symlinks or vanished files
                }
            }

            files.sort((a, b) => b.time - a.time); // Newest first

            if (files.length > keep) {
                const toDelete = files.slice(keep);
                for (const file of toDelete) {
                    try {
                        fs.unlinkSync(file.path);
                        console.log(`Deleted old backup: ${file.name}`);
                    } catch {
                        // Ignore individual unlink failures
                    }
                }
            }
        } catch (e: any) {
            const lm = LocalizationManager.getInstance();
            vscode.window.showErrorMessage(lm.t('Failed to clean old backups: {0}', e.message));
        }
    }
}
