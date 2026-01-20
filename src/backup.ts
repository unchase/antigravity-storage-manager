import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import archiver from 'archiver';

const EXT_NAME = 'antigravity-storage-manager';

export class BackupManager {
    private storageRoot: string;
    private brainDir: string;
    private convDir: string;
    private timer: NodeJS.Timeout | undefined;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext, storageRoot: string) {
        this.context = context;
        this.storageRoot = storageRoot;
        this.brainDir = path.join(storageRoot, 'brain');
        this.convDir = path.join(storageRoot, 'conversations');
    }

    /**
     * Initialize backup manager
     */
    initialize() {
        // Run initial check after a short delay to let VS Code startup finish
        setTimeout(() => this.checkAndSchedule(), 10000);

        // Listen for config changes
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`${EXT_NAME}.backup`)) {
                    this.checkAndSchedule();
                }
            })
        );
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

        const intervalHours = config.get<number>('interval', 24);
        const intervalMs = intervalHours * 60 * 60 * 1000;

        console.log(`Antigravity Backups: Enabled. Interval: ${intervalHours}h`);

        this.timer = setInterval(() => {
            this.performScheduledBackup();
        }, intervalMs);

        // Also check if we should run now (missed window or first run)
        this.checkLastBackupTime(intervalMs);
    }

    private async checkLastBackupTime(intervalMs: number) {
        const lastBackupTime = this.context.globalState.get<string>('lastBackupTime');
        const now = Date.now();

        if (!lastBackupTime || (now - new Date(lastBackupTime).getTime() > intervalMs)) {
            await this.performScheduledBackup();
        }
    }

    private async performScheduledBackup() {
        try {
            await this.backupNow();
        } catch (error: any) {
            console.error('Scheduled backup failed:', error);
        }
    }

    /**
     * Perform immediate backup
     */
    async backupNow(targetPath?: string): Promise<string> {
        const config = vscode.workspace.getConfiguration(`${EXT_NAME}.backup`);

        let backupDir = targetPath;
        if (!backupDir) {
            backupDir = config.get<string>('path');
            if (!backupDir || backupDir.trim() === '') {
                backupDir = path.join(this.storageRoot, 'backups');
            }
        }

        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `backup-${timestamp}.zip`;
        const filePath = path.join(backupDir, filename);

        await this.createZip(filePath);

        // Update last backup time
        await this.context.globalState.update('lastBackupTime', new Date().toISOString());

        // Enforce retention
        await this.cleanOldBackups(backupDir);

        return filePath;
    }

    private createZip(zipPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', resolve);
            archive.on('error', reject);

            archive.pipe(output);

            if (fs.existsSync(this.brainDir)) {
                archive.directory(this.brainDir, 'brain');
            }
            if (fs.existsSync(this.convDir)) {
                archive.directory(this.convDir, 'conversations');
            }

            archive.finalize();
        });
    }

    private async cleanOldBackups(backupDir: string) {
        const config = vscode.workspace.getConfiguration(`${EXT_NAME}.backup`);
        const retention = config.get<number>('retention', 10);

        if (retention <= 0) return;

        try {
            const files = fs.readdirSync(backupDir)
                .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
                .map(f => ({
                    name: f,
                    path: path.join(backupDir, f),
                    time: fs.statSync(path.join(backupDir, f)).mtime.getTime()
                }))
                .sort((a, b) => b.time - a.time); // Newest first

            if (files.length > retention) {
                const toDelete = files.slice(retention);
                for (const file of toDelete) {
                    fs.unlinkSync(file.path);
                    console.log(`Deleted old backup: ${file.name}`);
                }
            }
        } catch (e) {
            console.error('Failed to clean old backups:', e);
        }
    }
}
