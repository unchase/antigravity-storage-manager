import * as vscode from 'vscode';
import { exec } from 'child_process';
import { LocalizationManager } from './l10n/localizationManager';

const EXT_NAME = 'antigravity-storage-manager';
const STORAGE_KEY = `${EXT_NAME}.savedProfiles`;

/**
 * Manages VS Code profiles for quick switching between Antigravity accounts.
 * Note: Switching profiles requires opening a new VS Code window.
 */
export class ProfileManager {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Get list of saved profile names
     */
    async getSavedProfiles(): Promise<string[]> {
        return this.context.globalState.get<string[]>(STORAGE_KEY, []);
    }

    /**
     * Save a new profile name
     */
    async saveProfile(name: string): Promise<void> {
        const profiles = await this.getSavedProfiles();
        if (!profiles.includes(name)) {
            profiles.push(name);
            await this.context.globalState.update(STORAGE_KEY, profiles);
        }
    }

    /**
     * Remove a profile from saved list
     */
    async removeProfile(name: string): Promise<void> {
        const profiles = await this.getSavedProfiles();
        const index = profiles.indexOf(name);
        if (index > -1) {
            profiles.splice(index, 1);
            await this.context.globalState.update(STORAGE_KEY, profiles);
        }
    }

    /**
     * Open VS Code with specific profile (opens new window)
     */
    openWithProfile(profileName: string): void {
        const lm = LocalizationManager.getInstance();

        // Use 'code' CLI to open with profile
        const command = `code --profile "${profileName}"`;

        exec(command, (error) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to open profile: ${error.message}`);
            } else {
                vscode.window.showInformationMessage(lm.t('Opening VS Code with profile: {0}', profileName));
            }
        });
    }

    /**
     * Show QuickPick for profile selection
     */
    async showProfilePicker(): Promise<void> {
        const lm = LocalizationManager.getInstance();
        const profiles = await this.getSavedProfiles();

        interface ProfileItem extends vscode.QuickPickItem {
            action?: 'add' | 'remove' | 'open';
            profileName?: string;
        }

        const items: ProfileItem[] = [];

        // Add "Add New Profile" option
        items.push({
            label: `$(add) ${lm.t('Add New Profile')}`,
            description: lm.t('Enter profile name'),
            action: 'add'
        });

        // Add "Remove Profile" option if there are profiles
        if (profiles.length > 0) {
            items.push({
                label: `$(trash) ${lm.t('Remove Profile')}`,
                description: lm.t('Select profile to remove'),
                action: 'remove'
            });

            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

            // Add existing profiles
            for (const profile of profiles) {
                items.push({
                    label: `$(window) ${profile}`,
                    description: lm.t('Open VS Code with different profile'),
                    action: 'open',
                    profileName: profile
                });
            }
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: lm.t('Select a profile or add new'),
            title: lm.t('Switch Profile')
        });

        if (!selected) return;

        if (selected.action === 'add') {
            const newName = await vscode.window.showInputBox({
                prompt: lm.t('Enter profile name'),
                placeHolder: 'e.g., Work, Personal, Test',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return lm.t('Profile name cannot be empty');
                    }
                    return null;
                }
            });

            if (newName) {
                await this.saveProfile(newName.trim());
                vscode.window.showInformationMessage(lm.t('Profile added: {0}', newName.trim()));

                // Ask if user wants to open it now
                const openNow = await vscode.window.showInformationMessage(
                    lm.t('Opening VS Code with profile: {0}', newName.trim()) + '?',
                    lm.t('Open'),
                    lm.t('Cancel')
                );

                if (openNow === lm.t('Open')) {
                    this.openWithProfile(newName.trim());
                }
            }
        } else if (selected.action === 'remove') {
            if (profiles.length === 0) {
                vscode.window.showWarningMessage(lm.t('No saved profiles'));
                return;
            }

            const toRemove = await vscode.window.showQuickPick(
                profiles.map(p => ({ label: p })),
                {
                    placeHolder: lm.t('Select profile to remove'),
                    title: lm.t('Remove Profile')
                }
            );

            if (toRemove) {
                await this.removeProfile(toRemove.label);
                vscode.window.showInformationMessage(lm.t('Profile removed: {0}', toRemove.label));
            }
        } else if (selected.action === 'open' && selected.profileName) {
            this.openWithProfile(selected.profileName);
        }
    }
}
