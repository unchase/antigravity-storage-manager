
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalizationManager } from './l10n/localizationManager';

export interface Profile {
    name: string;
    filePath: string;
    lastUsed: number;
    antigravityEmail?: string; // Email of the Antigravity account associated with this profile
    quotaCache?: ProfileQuotaCache;
}

export interface ProfileQuotaCache {
    timestamp: number;
    models: {
        modelId: string;
        label: string;
        remainingPercentage?: number;
        isExhausted?: boolean;
        resetTime?: string; // ISO string
        timeUntilReset?: number;
    }[];
}

export class ProfileManager {
    private configDir: string;
    private readonly profilesDirectory: string | undefined; // Original property

    private getAntigravityEmails?: () => Promise<string[]>;
    private addAntigravityAccount?: () => Promise<string | undefined>; // Callback to add new account
    private onQuotaRefresh?: () => Promise<void>;

    public get activeProfile(): string | undefined {
        return this.context.globalState.get<string>('antigravity.activeProfile');
    }

    private async setActiveProfile(name: string | undefined): Promise<void> {
        await this.context.globalState.update('antigravity.activeProfile', name);
    }

    constructor(
        private context: vscode.ExtensionContext,
        getAntigravityEmails?: () => Promise<string[]>, // Callback to get active account email
        addAntigravityAccount?: () => Promise<string | undefined> // Callback to add new account
    ) {
        this.configDir = '';
        this.profilesDirectory = vscode.workspace.getConfiguration('antigravity-storage-manager').get<string>('profilesDirectory');
        this.getAntigravityEmails = getAntigravityEmails;
        this.addAntigravityAccount = addAntigravityAccount;
    }

    public setQuotaRefreshCallback(callback: () => Promise<void>) {
        this.onQuotaRefresh = callback;
    }

    public async initialize(): Promise<void> {
        const detectedConfigDir = await this.detectConfigDir();
        if (detectedConfigDir) {
            this.configDir = detectedConfigDir;
        }
    }

    private async detectConfigDir(): Promise<string | null> {
        // Cross-platform base directories (fixes #9 — macOS/Linux support)
        let configBases: string[] = [];

        if (process.platform === 'win32') {
            const roaming = process.env.APPDATA;
            if (roaming) {
                configBases.push(roaming);
            }
        } else if (process.platform === 'darwin') {
            // macOS: ~/Library/Application Support/
            configBases.push(path.join(os.homedir(), 'Library', 'Application Support'));
        } else {
            // Linux: ~/.config/
            const xdgConfig = process.env.XDG_CONFIG_HOME;
            if (xdgConfig) {
                configBases.push(xdgConfig);
            }
            configBases.push(path.join(os.homedir(), '.config'));
        }

        if (configBases.length === 0) return null;

        const candidates: string[] = [];

        // IDE names to search (covers all known VS Code forks)
        const ideNames = [
            'Code', 'Code - Insiders',
            'Antigravity',
            'Codeium', 'Windsurf',
            'Cursor',
            'Codium', 'VSCodium'
        ];

        // Build platform-aware search paths
        const commonRoots: string[] = [];
        const standaloneRoots: string[] = [];

        for (const base of configBases) {
            for (const ide of ideNames) {
                commonRoots.push(path.join(base, ide, 'User', 'globalStorage'));
            }

            // Standalone App Roots (non-VS Code based IDEs)
            standaloneRoots.push(
                path.join(base, 'Antigravity', 'User', 'globalStorage'),
                path.join(base, 'Codeium', 'User', 'globalStorage'),
                path.join(base, 'Windsurf', 'User', 'globalStorage')
            );
        }

        // Hidden dot-directories in home folder (some IDEs use this on macOS/Linux)
        // e.g. ~/.antigravity/, ~/.codeium/, ~/.windsurf/
        const home = os.homedir();
        const dotDirNames = ['.antigravity', '.codeium', '.windsurf'];
        for (const dotDir of dotDirNames) {
            const dotPath = path.join(home, dotDir);
            if (fs.existsSync(dotPath)) {
                // Check for globalStorage inside the dot-directory
                const gsPath = path.join(dotPath, 'User', 'globalStorage');
                if (fs.existsSync(gsPath)) {
                    commonRoots.push(gsPath);
                    standaloneRoots.push(gsPath);
                }
                // Also check for data subdirectory directly (e.g. ~/.antigravity/antigravity/)
                try {
                    const subDirs = fs.readdirSync(dotPath);
                    for (const d of subDirs) {
                        const fullPath = path.join(dotPath, d);
                        try {
                            if (fs.statSync(fullPath).isDirectory()) {
                                const lowerName = d.toLowerCase();
                                if (lowerName === 'antigravity' || lowerName === 'codeium' || lowerName === 'windsurf') {
                                    standaloneRoots.push(fullPath);
                                }
                                // Also scan for globalStorage inside
                                const innerGs = path.join(fullPath, 'User', 'globalStorage');
                                if (fs.existsSync(innerGs)) {
                                    commonRoots.push(innerGs);
                                }
                            }
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
            }
        }


        // 1. Check for Standalone App Roots (Direct usage)
        for (const root of standaloneRoots) {
            if (fs.existsSync(root)) {
                candidates.push(root);
            }
        }

        // 2. Scan for Subdirectories (Extension mode)
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

                        // Check full path to avoid re-adding the root itself if it was already added
                        const fullPath = path.join(storageRoot, d);
                        if (candidates.includes(fullPath)) continue;

                        // Look for Antigravity or Codeium target extensions
                        if (lowerName.includes('antigravity') || lowerName.includes('codeium')) {
                            candidates.push(fullPath);
                        }
                    }
                } catch {
                    // ignore read errors
                }
            }
        }

        // 3. Fallback: use globalStorageUri parent to scan for sibling extensions
        const myStoragePath = this.context.globalStorageUri.fsPath;
        const parentStorageDir = path.dirname(myStoragePath);
        if (fs.existsSync(parentStorageDir) && !commonRoots.includes(parentStorageDir)) {
            try {
                const subdirs = fs.readdirSync(parentStorageDir);
                for (const d of subdirs) {
                    const lowerName = d.toLowerCase();
                    if (lowerName.includes('antigravity-storage-manager')) continue;

                    const fullPath = path.join(parentStorageDir, d);
                    if (candidates.includes(fullPath)) continue;

                    if (lowerName.includes('antigravity') || lowerName.includes('codeium')) {
                        candidates.push(fullPath);
                    }
                }
            } catch {
                // ignore
            }
        }

        // Filter candidates:
        // 1. Must exist and be a directory
        // 2. Must NOT be our own globalStorageUri (extra safety)
        // 3. Must NOT be inside our profiles directory
        const myStoragePathLower = myStoragePath.toLowerCase();

        const validCandidates = candidates
            .filter(p => {
                if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return false;
                const pLower = p.toLowerCase();

                // Exclude self (Context Storage)
                if (pLower === myStoragePathLower) return false;

                // Exclude self (Extension Install Dir - if somehow checking there)
                // Filter out anything that looks like THIS extension
                if (pLower.includes('antigravity-storage-manager')) return false;

                return true;
            })
            // Quick heuristic: Prefer paths that actually contain Antigravity data
            // But for now, mtime is a decent proxy for "active"
            .map(p => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime); // Newest first

        if (validCandidates.length > 0) {
            console.log('ProfileManager: Detected candidates:', validCandidates);
            return validCandidates[0].path;
        }

        // 4. Ultimate fallback: use our own extension's globalStorage parent directory
        // This allows profile save to work even if no Antigravity/Codeium extension is found
        if (fs.existsSync(parentStorageDir)) {
            console.log('ProfileManager: Using fallback globalStorage parent:', parentStorageDir);
            return parentStorageDir;
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

    public async saveProfile(name?: string): Promise<void> {
        if (!this.configDir) await this.initialize();
        if (!this.configDir) {
            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Could not locate Antigravity configuration directory to back up.'));
            throw new Error('Config directory not found');
        }

        // 1. Ask for profile name if not provided
        if (!name) {
            name = await vscode.window.showInputBox({
                prompt: LocalizationManager.getInstance().t('Enter profile name'),
                placeHolder: 'MyProfile'
            });
        }

        if (!name) return; // User cancelled

        // Create profiles directory in OUR extension's storage (already done in constructor, but good to ensure)
        const profilesDir = this.getProfilesDir();
        if (!fs.existsSync(profilesDir)) {
            fs.mkdirSync(profilesDir, { recursive: true });
        }

        // Sanitize profile name for file system
        const safeName = name.replace(/[^a-z0-9]/gi, '_');
        const profilePath = path.join(profilesDir, safeName);

        // Check if profile exists
        const profiles = await this.loadProfiles();
        const existingProfile = profiles.find(p => p.name === name);
        if (existingProfile) {
            const overwrite = await vscode.window.showWarningMessage(
                LocalizationManager.getInstance().t('Profile "{0}" already exists. Overwrite?', name),
                LocalizationManager.getInstance().t('Yes'),
                LocalizationManager.getInstance().t('No')
            );
            if (overwrite !== LocalizationManager.getInstance().t('Yes')) return; // User chose not to overwrite
        }

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

        // 2. Determine Antigravity Email Association
        let antigravityEmail: string | undefined;

        if (this.getAntigravityEmails) {
            try {
                const emails = await this.getAntigravityEmails();

                // Always show QuickPick now, even if empty, because we have "Add Account"
                const items: (vscode.QuickPickItem & { isAction?: boolean })[] = [
                    {
                        label: '$(plus) ' + LocalizationManager.getInstance().t('Add Account'),
                        description: LocalizationManager.getInstance().t('Log in to a new Antigravity account'),
                        isAction: true
                    },
                    {
                        label: '$(circle-slash) ' + LocalizationManager.getInstance().t('None'),
                        description: LocalizationManager.getInstance().t('Do not associate with any account')
                    }
                ];

                if (emails.length > 0) {
                    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
                    items.push(...emails.map(email => {
                        // Try to find a profile with this email to show quota
                        const relatedProfile = profiles
                            .filter(p => p.antigravityEmail === email)
                            .sort((a, b) => b.lastUsed - a.lastUsed)[0];

                        let detail = LocalizationManager.getInstance().t('Associate with this account');
                        if (relatedProfile) {
                            const quotaInfo = this.getProfileQuotaDetails(relatedProfile);
                            if (quotaInfo) {
                                detail = quotaInfo;
                            }
                        }

                        return {
                            label: `$(account) ${email}`,
                            description: detail
                        };
                    }));
                }

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: LocalizationManager.getInstance().t('Select Antigravity account to associate with this profile'),
                    ignoreFocusOut: true
                });

                if (selected) {
                    if (selected.isAction && selected.label.includes(LocalizationManager.getInstance().t('Add Account'))) {
                        // Trigger Auth Flow via Callback
                        if (this.addAntigravityAccount) {
                            try {
                                antigravityEmail = await this.addAntigravityAccount();
                                if (antigravityEmail) {
                                    vscode.window.showInformationMessage(LocalizationManager.getInstance().t('Authenticated as {0}', antigravityEmail));

                                    // CRITICAL FIX: Re-backup configuration because tokens have changed!
                                    try {
                                        // We need to re-copy configDir to profilePath to capture the new tokens
                                        // Since profilePath already exists and has files, 
                                        // copyRecursiveSync will overwrite existing files (like tokens.json) 
                                        // which is exactly what we want.
                                        this.copyRecursiveSync(this.configDir, profilePath);
                                        console.log('Re-synced profile backup with new authentication tokens.');
                                    } catch (e: any) {
                                        console.error('Failed to re-sync profile after auth:', e);
                                        vscode.window.showWarningMessage(LocalizationManager.getInstance().t('Warning: New tokens might not be saved to profile backup.'));
                                    }
                                } else {
                                    vscode.window.showWarningMessage(LocalizationManager.getInstance().t('Authentication failed or cancelled.'));
                                    antigravityEmail = undefined;
                                }
                            } catch (e: any) {
                                vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Failed to add account: {0}', e.message));
                                antigravityEmail = undefined;
                            }
                        } else {
                            vscode.window.showErrorMessage(LocalizationManager.getInstance().t('Add Account feature is not available.'));
                            antigravityEmail = undefined;
                        }
                    } else if (selected.label.includes(LocalizationManager.getInstance().t('None'))) {
                        antigravityEmail = undefined;
                    } else {
                        // Extract email from label (remove icon)
                        antigravityEmail = selected.label.replace('$(account) ', '').trim();
                    }
                } else {
                    // User cancelled selection - save without association.
                    antigravityEmail = undefined;
                }
            } catch (e) {
                console.warn('Failed to get Antigravity emails:', e);
            }
        }

        // Save metadata
        const existingIndex = profiles.findIndex(p => p.name === name);
        const profileData: Profile = {
            name,
            filePath: profilePath,
            lastUsed: Date.now(),
            antigravityEmail
        };

        if (existingIndex >= 0) {
            profiles[existingIndex] = profileData;
        } else {
            profiles.push(profileData);
        }

        await this.context.secrets.store('antigravity.profiles', JSON.stringify(profiles));
        await this.setActiveProfile(name);

        if (this.onQuotaRefresh) {
            this.onQuotaRefresh().catch(e => console.error('Failed to refresh quota after profile save:', e));
        }
    }

    public async findProfileForAntigravityEmail(email: string): Promise<Profile | undefined> {
        const profiles = await this.loadProfiles();
        return profiles.find(p => p.antigravityEmail === email);
    }

    public async updateProfileQuota(profileName: string, snapshot: any): Promise<void> {
        if (!snapshot || !snapshot.models) return;

        const profiles = await this.loadProfiles();
        const profileIndex = profiles.findIndex(p => p.name === profileName);
        if (profileIndex === -1) return;

        const profile = profiles[profileIndex];

        // Filter and map models for cache
        const models = snapshot.models.map((m: any) => ({
            modelId: m.modelId,
            label: m.label,
            remainingPercentage: m.remainingPercentage,
            isExhausted: m.isExhausted,
            resetTime: m.resetTime ? new Date(m.resetTime).toISOString() : undefined,
            timeUntilReset: m.timeUntilReset
        }));

        profile.quotaCache = {
            timestamp: Date.now(),
            models: models
        };

        // Save back to secrets
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
        await this.setActiveProfile(name);

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
            let cmd: string;
            if (process.platform === 'win32') {
                // Kill only language_server processes, NOT the IDE itself (Antigravity.exe).
                // Try both x64 and arm64 variants; ignore errors if process not found.
                cmd = 'taskkill /IM language_server_windows_x64.exe /F 2>nul & taskkill /IM language_server_windows_arm64.exe /F 2>nul & exit /b 0';
            } else {
                // On macOS/Linux: kill only the language_server process, NOT the IDE itself.
                // Using 'pkill -f Antigravity' would kill the IDE we're running inside of!
                cmd = 'pkill -f language_server || true';
            }

            // eslint-disable-next-line @typescript-eslint/no-require-imports
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
        // eslint-disable-next-line @typescript-eslint/no-require-imports
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

        // Filter out unrelated/problematic folders
        const shouldIgnore = (name: string) => {
            const lower = name.toLowerCase();
            return lower.startsWith('ms-dotnet') ||
                lower.startsWith('vscode-dotnet') ||
                lower === '.dotnet' ||
                lower === 'node_modules' ||
                lower.includes('antigravity-storage-manager');
        };

        const stats = fs.statSync(src);

        const isDirectory = stats.isDirectory();

        if (isDirectory) {
            if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest, { recursive: true });
            }
            fs.readdirSync(src).forEach((childItemName) => {
                // Skip 'profiles' folder if we are copying from our own storage root (generic safety)
                if (childItemName === 'profiles') return;
                if (shouldIgnore(childItemName)) return;

                this.copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
            });
        } else {
            try {
                fs.copyFileSync(src, dest);
            } catch (e: any) {
                if (e.code === 'EBUSY' || e.code === 'EPERM') {
                    console.warn(`Skipping locked file: ${src}`);
                } else {
                    throw e;
                }
            }
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

        if (this.activeProfile === name) {
            await this.setActiveProfile(undefined);
        }

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

        const items: (vscode.QuickPickItem & { profile?: Profile, isAction?: boolean })[] = profiles.map(p => {
            const description = LocalizationManager.getInstance().formatDateTime(p.lastUsed);
            let detail = '';

            if (p.quotaCache && p.quotaCache.models) {
                const info = this.getProfileQuotaDetails(p);
                if (info) detail = info;
            }

            return {
                label: `$(account) ${p.name}${p.antigravityEmail ? ` (${p.antigravityEmail})` : ''}`,
                description: description,
                detail: detail,
                profile: p
            };
        });

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
                await this.promptForSaveProfile();
            } else if (selected.profile && selected.profile.name === 'DELETE_ACTION') {
                const toDelete = await vscode.window.showQuickPick(profiles.map(p => p.name), {
                    placeHolder: lm.t('Select profile to delete')
                });
                if (toDelete) {
                    const confirm = await vscode.window.showWarningMessage(
                        lm.t('Are you sure you want to delete profile "{0}"?', toDelete),
                        { modal: true },
                        lm.t('Yes'),
                        lm.t('No')
                    );
                    if (confirm === lm.t('Yes')) {
                        await this.deleteProfile(toDelete);
                        vscode.window.showInformationMessage(lm.t('Profile "{0}" deleted.', toDelete));
                    }
                }
            }
        }
    }

    public async promptForSaveProfile(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const profiles = await this.loadProfiles();

        const items: (vscode.QuickPickItem & { profile?: Profile, isCreate?: boolean })[] = [
            {
                label: `$(plus) ${lm.t('Create New Profile')}`,
                description: lm.t('Save as a new profile'),
                isCreate: true
            }
        ];

        if (profiles.length > 0) {
            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            items.push(...profiles.map(p => {
                let description = p.antigravityEmail || lm.t('No account');
                const quotaInfo = this.getProfileQuotaDetails(p);
                if (quotaInfo) {
                    description += `  |  ${quotaInfo}`;
                }

                return {
                    label: `$(account) ${p.name}`,
                    description: description,
                    detail: lm.t('Overwrite existing profile'),
                    profile: p
                };
            }));
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: lm.t('Select to create new or overwrite existing profile')
        });

        if (!selected) return;

        let profileName: string | undefined;

        if (selected.isCreate) {
            profileName = await vscode.window.showInputBox({
                placeHolder: lm.t('Enter profile name (e.g. "Personal")'),
                validateInput: (value) => {
                    return value && value.trim().length > 0 ? null : lm.t('Name cannot be empty');
                }
            });
        } else if (selected.profile) {
            const confirm = await vscode.window.showWarningMessage(
                lm.t('Are you sure you want to overwrite profile "{0}"?', selected.profile.name),
                { modal: true },
                lm.t('Yes'),
                lm.t('Cancel')
            );
            if (confirm === lm.t('Yes')) {
                profileName = selected.profile.name;
            }
        }

        if (profileName) {
            try {
                await this.saveProfile(profileName);
                vscode.window.showInformationMessage(lm.t('Profile "{0}" saved.', profileName));
            } catch (e: any) {
                vscode.window.showErrorMessage(lm.t('Failed to save profile: {0}', e.message));
            }
        }
    }

    private getProfileQuotaDetails(p: Profile): string | undefined {
        if (!p.quotaCache || !p.quotaCache.models) return undefined;

        const lm = LocalizationManager.getInstance();
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const pinned = config.get<string[]>('quota.pinnedModels') || [];

        if (pinned.length > 0) {
            const cachedModels = p.quotaCache.models.filter(m => pinned.includes(m.modelId) || pinned.includes(m.label));

            if (cachedModels.length > 0) {
                const parts: string[] = [];
                const now = Date.now();

                for (const m of cachedModels) {
                    let status = '';

                    // Check reset time
                    let isReset = false;
                    if (m.resetTime) {
                        const resetDate = new Date(m.resetTime);
                        if (now > resetDate.getTime()) {
                            isReset = true;
                        }
                    }

                    if (isReset) {
                        status = `$(refresh) ${m.label}: ${lm.t('Reset')}`;
                    } else {
                        let pct = m.remainingPercentage !== undefined ? `${m.remainingPercentage.toFixed(0)}%` : '?';
                        if (pct === '?' && m.isExhausted) {
                            pct = '0%';
                        }

                        let icon = '$(check)';
                        if (m.isExhausted || (m.remainingPercentage !== undefined && m.remainingPercentage === 0)) icon = '$(error)';
                        else if (m.remainingPercentage !== undefined && m.remainingPercentage < 30) icon = '$(flame)';

                        status = `${icon} ${m.label}: ${pct}`;

                        if (m.resetTime) {
                            const resetDate = new Date(m.resetTime);
                            if (resetDate.getTime() > now) {
                                const dateStr = resetDate.toLocaleDateString(lm.getLocale(), { day: '2-digit', month: '2-digit' });
                                const timeStr = resetDate.toLocaleTimeString(lm.getLocale(), { hour: '2-digit', minute: '2-digit' });
                                status += ` (${lm.t('Reset at {0}', `${dateStr} ${timeStr}`)})`;
                            }
                        }
                    }
                    parts.push(status);
                }

                if (parts.length > 0) {
                    return parts.join('  |  ');
                }
            }
        }
        return undefined;
    }
}
