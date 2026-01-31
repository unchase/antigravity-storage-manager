
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalizationManager } from './l10n/localizationManager';

export interface Profile {
    name: string;
    filePath: string;
    lastUsed: number;
}

export class ProfileManager {
    private context: vscode.ExtensionContext;
    private configDir: string | null = null;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public async initialize(): Promise<void> {
        this.configDir = await this.detectConfigDir();
    }

    private async detectConfigDir(): Promise<string | null> {
        const roaming = process.env.APPDATA;
        if (!roaming) return null;

        const candidates: string[] = [];

        // 1. Standalone App (Official Agent) - Highest Priority
        const standalonePaths = [
            path.join(roaming, 'Antigravity', 'User', 'globalStorage'),
            path.join(roaming, 'Codeium', 'User', 'globalStorage')
        ];

        for (const p of standalonePaths) {
            candidates.push(p);
        }

        // 2. VS Code Extensions
        // Try common locations for extensions global storage
        const commonRoots = [
            path.join(roaming, 'Code', 'User', 'globalStorage'),
            path.join(roaming, 'Code - Insiders', 'User', 'globalStorage'),
            // Antigravity IDE specific?
            path.join(roaming, 'Antigravity', 'User', 'globalStorage')
        ];

        for (const storageRoot of commonRoots) {
            if (fs.existsSync(storageRoot)) {
                try {
                    const subdirs = fs.readdirSync(storageRoot);
                    for (const d of subdirs) {
                        const lowerName = d.toLowerCase();

                        // STRICT EXCLUSION:
                        // Exclude our own extension by ID and name parts
                        if (lowerName.includes('unchase.antigravity-storage-manager') ||
                            lowerName.includes('antigravity-storage-manager')) {
                            continue;
                        }

                        // Look for Antigravity or Codeium target extensions
                        // We want the ONE that holds the AUTH state (Google Auth, etc.)
                        // Usually 'Codeium.antigravity' or 'Antigravity.agent'
                        if (lowerName.includes('antigravity') || lowerName.includes('codeium')) {
                            candidates.push(path.join(storageRoot, d));
                        }
                    }
                } catch (e) {
                    console.error(`Error reading storage root ${storageRoot}:`, e);
                }
            }
        }

        // Filter candidates:
        // 1. Must exist and be a directory
        // 2. Must NOT be our own globalStorageUri (extra safety)
        // 3. Must NOT be inside our profiles directory
        const myStoragePath = this.context.globalStorageUri.fsPath.toLowerCase();

        const validCandidates = candidates
            .filter(p => {
                if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return false;
                const pLower = p.toLowerCase();

                // Exclude self (Context Storage)
                if (pLower === myStoragePath) return false;

                // Exclude self (Extension Install Dir - if somehow checking there)
                // Filter out anything that looks like THIS extension
                if (pLower.includes('antigravity-storage-manager')) return false;

                return true;
            })
            .map(p => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime); // Newest first

        if (validCandidates.length > 0) {
            console.log('ProfileManager: Detected candidates:', validCandidates);
            return validCandidates[0].path;
        }

        return null;
    }

    private getProfilesDir(): string {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const customPath = config.get<string>('profilesDirectory');

        if (customPath && customPath.trim().length > 0) {
            // Simple expansion of ~ to home dir
            if (customPath.startsWith('~')) {
                return path.join(os.homedir(), customPath.slice(1));
            }
            return customPath;
        }

        // Default: globalStorage/profiles
        return path.join(this.context.globalStorageUri.fsPath, 'profiles');
    }

    public async debugProfileInfo(): Promise<void> {
        const dbg = await this.detectConfigDir();
        const profiles = await this.loadProfiles();
        const profilesDir = this.getProfilesDir();

        let files: string[] = [];
        try {
            if (fs.existsSync(profilesDir)) {
                files = fs.readdirSync(profilesDir);
            }
        } catch (e: any) {
            files = [`Error: ${e.message}`];
        }

        const msg = `Config Dir: ${dbg || 'NOT FOUND'}\nProfiles Dir: ${profilesDir}\nLoaded Profiles: ${profiles.map(p => p.name).join(', ')}\nFile Listing: ${files.join(', ')}`;
        console.log(msg);
        vscode.window.showInformationMessage(msg, { modal: true });
    }

    public async saveProfile(name: string): Promise<void> {
        if (!this.configDir) await this.initialize();
        if (!this.configDir) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Could not locate Antigravity configuration directory to back up.'));
            return;
        }

        // Create profiles directory in OUR extension's storage
        const profilesDir = this.getProfilesDir();
        if (!fs.existsSync(profilesDir)) {
            fs.mkdirSync(profilesDir, { recursive: true });
        }

        // Sanitize profile name for file system
        const safeName = name.replace(/[^a-z0-9]/gi, '_');
        const profilePath = path.join(profilesDir, safeName);

        // Remove existing if any (fresh snapshot)
        if (fs.existsSync(profilePath)) {
            fs.rmSync(profilePath, { recursive: true, force: true });
        }
        fs.mkdirSync(profilePath);

        // Backup ALL files recursively
        try {
            this.copyRecursiveSync(this.configDir, profilePath);
        } catch (e: any) {
            throw new Error('Failed to backup configuration: ' + e.message);
        }

        // Save metadata
        const profiles = await this.loadProfiles();
        const existingIndex = profiles.findIndex(p => p.name === name);
        const profileData = { name, filePath: profilePath, lastUsed: Date.now() };

        if (existingIndex >= 0) {
            profiles[existingIndex] = profileData;
        } else {
            profiles.push(profileData);
        }

        await this.context.secrets.store('antigravity.profiles', JSON.stringify(profiles));
    }

    public async switchProfile(name: string): Promise<void> {
        if (!this.configDir) await this.initialize();
        if (!this.configDir) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Could not locate Antigravity configuration directory.'));
            return;
        }

        const profiles = await this.loadProfiles();
        const profile = profiles.find(p => p.name === name);
        if (!profile) throw new Error(`Profile "${name}" not found.`);

        // Restore files (overwrite existing)
        try {
            this.copyRecursiveSync(profile.filePath, this.configDir);
        } catch (e: any) {
            console.error(`Failed to restore profile:`, e);
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to restore profile: {0}', e.message));
            return;
        }

        // Delay updating metadata until success
        profile.lastUsed = Date.now();
        await this.context.secrets.store('antigravity.profiles', JSON.stringify(profiles));

        // Prompt for Reload, AND THEN Kill
        // This avoids the issue where killing the process stops execution before the prompt
        const reload = LocalizationManager.getInstance().t('Reload Window');

        const selection = await vscode.window.showInformationMessage(
            LocalizationManager.getInstance().t('Profile "{0}" applied. Restart required. You must manually start Antigravity after the window reloads.', name),
            { modal: true },
            reload
        );

        if (selection === reload) {
            // Now we kill and reload
            try {
                await this.killAntigravityProcess();
                // Wait for process release
                await new Promise(r => setTimeout(r, 2000));
            } catch (e: any) {
                console.warn('Failed to kill Antigravity process:', e);
            }

            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    }

    private async killAntigravityProcess(): Promise<void> {
        return new Promise((resolve) => {
            const cmd = process.platform === 'win32'
                ? 'taskkill /IM Antigravity.exe /F'
                : 'pkill -f Antigravity';

            require('child_process').exec(cmd, (err: any) => {
                // Ignore errors (process might not be running)
                if (err) {
                    console.log('Antigravity process kill result:', err.message);
                } else {
                    console.log('Antigravity process killed successfully.');
                }
                resolve();
            });
        });
    }

    private async startAntigravityProcess(): Promise<void> {
        const exePath = await this.detectExecutablePath();
        if (!exePath) {
            console.warn('Antigravity Executable not found. Skipping auto-restart.');
            return;
        }

        console.log(`Starting Antigravity from: ${exePath}`);
        const { spawn } = require('child_process');

        // Spawn detached to let it run independently
        const child = spawn(exePath, [], {
            detached: true,
            stdio: 'ignore'
        });

        child.unref();
    }

    private async detectExecutablePath(): Promise<string | null> {
        if (process.platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA;
            const programFiles = process.env.ProgramFiles;
            const candidates: string[] = [];

            if (localAppData) {
                // %LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe
                candidates.push(path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'));
            }

            // Checking Program Files just in case
            if (programFiles) {
                candidates.push(path.join(programFiles, 'Antigravity', 'Antigravity.exe'));
            }

            for (const p of candidates) {
                if (fs.existsSync(p)) return p;
            }
        }
        // Add macOS/Linux logic if needed later
        return null;
    }

    private copyRecursiveSync(src: string, dest: string) {
        // Safety guard: Don't copy if dest is inside src
        if (path.resolve(dest).startsWith(path.resolve(src))) {
            console.error(`Preventing recursive copy: ${dest} is inside ${src}`);
            return;
        }

        const stats = fs.statSync(src);
        const isDirectory = stats.isDirectory();

        if (isDirectory) {
            if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest, { recursive: true });
            }
            fs.readdirSync(src).forEach((childItemName) => {
                // Skip 'profiles' folder if we are copying from our own storage root (generic safety)
                if (childItemName === 'profiles') return;

                this.copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
            });
        } else {
            fs.copyFileSync(src, dest);
        }
    }

    public async loadProfiles(): Promise<Profile[]> {
        let profiles: Profile[] = [];
        try {
            const str = await this.context.secrets.get('antigravity.profiles');
            if (str) profiles = JSON.parse(str);
        } catch {
            console.warn('Failed to parse profiles secret');
        }

        // Self-healing: Sync with disk
        const profilesDir = this.getProfilesDir();
        let diskParamsChanged = false;

        if (fs.existsSync(profilesDir)) {
            const onDisk = new Set(fs.readdirSync(profilesDir).filter(f => {
                try {
                    return fs.statSync(path.join(profilesDir, f)).isDirectory();
                } catch { return false; }
            }));

            // 1. Validate existing profiles from secrets
            const validProfiles: Profile[] = [];
            for (const p of profiles) {
                // Logic must match saveProfile sanitization
                const safeName = p.name.replace(/[^a-z0-9]/gi, '_');
                if (onDisk.has(safeName)) {
                    // Found on disk!
                    // Update path to ensure it's current (handles portable mode/folder moves)
                    const currentPath = path.join(profilesDir, safeName);
                    if (p.filePath !== currentPath) {
                        p.filePath = currentPath;
                        diskParamsChanged = true;
                    }
                    validProfiles.push(p);
                    onDisk.delete(safeName); // Mark as handled
                }
            }

            if (validProfiles.length !== profiles.length) {
                diskParamsChanged = true;
                profiles = validProfiles;
            }

            // 2. Add orphaned folders as new profiles
            // Since we can't recover the original name (spaces etc) from the safe name,
            // we just use the folder name as the profile name.
            for (const dirName of onDisk) {
                profiles.push({
                    name: dirName,
                    filePath: path.join(profilesDir, dirName),
                    lastUsed: 0
                });
                diskParamsChanged = true;
            }
        } else {
            if (profiles.length > 0) {
                profiles = [];
                diskParamsChanged = true;
            }
        }

        // Update secrets if we healed something
        if (diskParamsChanged) {
            this.context.secrets.store('antigravity.profiles', JSON.stringify(profiles));
        }

        return profiles;
    }

    public async deleteProfile(name: string): Promise<void> {
        const profiles = await this.loadProfiles();
        const newProfiles = profiles.filter(p => p.name !== name);
        await this.context.secrets.store('antigravity.profiles', JSON.stringify(newProfiles));

        // Should also delete the folder on disk
        const profile = profiles.find(p => p.name === name);
        if (profile && fs.existsSync(profile.filePath)) {
            fs.rmSync(profile.filePath, { recursive: true, force: true });
        }
    }

    public async showProfilePicker() {
        const profiles = await this.loadProfiles();
        const lm = LocalizationManager.getInstance();

        // Sort by last used
        profiles.sort((a, b) => b.lastUsed - a.lastUsed);

        const items: (vscode.QuickPickItem & { profile?: Profile, isAction?: boolean })[] = profiles.map(p => ({
            label: `$(account) ${p.name}`,
            description: new Date(p.lastUsed).toLocaleString(),
            profile: p
        }));

        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

        items.push({
            label: `$(plus) ${lm.t('Save Current Profile')}`,
            description: lm.t('Save current authentication state as a new profile'),
            isAction: true,
            profile: null as any // marker
        });

        if (items.length > 2) { // More than just the "Save" button
            items.push({
                label: `$(trash) ${lm.t('Delete Profile')}`,
                description: lm.t('Remove a saved profile'),
                isAction: true,
                profile: { name: 'DELETE_ACTION' } as any
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: lm.t('Select a profile to switch to or save current state')
        });

        if (selected) {
            if (selected.profile && !selected.isAction) {
                await this.switchProfile(selected.profile.name);
            } else if (selected.label.includes('Save Current Profile')) {
                const name = await vscode.window.showInputBox({
                    placeHolder: lm.t('Enter profile name (e.g. "Personal")'),
                    validateInput: (value) => {
                        return value && value.trim().length > 0 ? null : lm.t('Name cannot be empty');
                    }
                });
                if (name) {
                    await this.saveProfile(name);
                    vscode.window.showInformationMessage(lm.t('Profile "{0}" saved.', name));
                }
            } else if (selected.label.includes('Delete Profile')) {
                const toDelete = await vscode.window.showQuickPick(profiles.map(p => p.name), {
                    placeHolder: lm.t('Select profile to delete')
                });
                if (toDelete) {
                    await this.deleteProfile(toDelete);
                    vscode.window.showInformationMessage(lm.t('Profile "{0}" deleted.', toDelete));
                }
            }
        }
    }
}
