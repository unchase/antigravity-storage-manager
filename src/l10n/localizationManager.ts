import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface IL10nBundle {
    [key: string]: string;
}

export class LocalizationManager {
    private static instance: LocalizationManager;
    private bundle: IL10nBundle = {};
    private currentLanguage: string = 'en';
    private extensionPath: string = '';

    private constructor() { }

    public static getInstance(): LocalizationManager {
        if (!LocalizationManager.instance) {
            LocalizationManager.instance = new LocalizationManager();
        }
        return LocalizationManager.instance;
    }

    public initialize(context: vscode.ExtensionContext) {
        this.extensionPath = context.extensionPath;
        this.loadBundle();

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-storage-manager.language')) {
                this.loadBundle();
            }
        });
    }

    private loadBundle() {
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const configuredLang = config.get<string>('language', 'auto');

        if (configuredLang === 'auto') {
            // Fallback to vscode's built-in l10n logic (or just use system language to pick our file)
            // But vscode.l10n.t only works if we use the bundle.l10n.json standard.
            // Since we want custom override, we should respect 'auto' as "use vscode.env.language"
            this.currentLanguage = vscode.env.language;
        } else {
            this.currentLanguage = configuredLang;
        }

        // Map vs code language codes to our supported files
        // e.g. 'en-US' -> 'en', 'ru-RU' -> 'ru'
        let langCode = this.currentLanguage.split('-')[0].toLowerCase();

        // Handle specific regional codes if needed, or map generic
        const supported = [
            'en', 'zh', 'ja', 'de', 'es', 'fr', 'it', 'ko', 'pt', 'ru', 'tr', 'pl', 'cs', 'ar', 'vi'
        ];
        // Note: zh-cn and zh-tw are usually distinct.
        // vscode uses 'zh-cn' and 'zh-tw'. splitting by '-' might lose that.
        // Let's rely on full code for zh?
        if (this.currentLanguage.toLowerCase().startsWith('zh-')) {
            langCode = this.currentLanguage.toLowerCase();
        }

        // Portuguese (Brazil) is pt-br
        if (this.currentLanguage.toLowerCase() === 'pt-br') {
            langCode = 'pt-br';
        }

        if (!supported.includes(langCode) && !langCode.startsWith('zh') && langCode !== 'pt-br') {
            langCode = 'en'; // Default fallback
        }

        const bundleFileName = langCode === 'en' ? 'bundle.l10n.json' : `bundle.l10n.${langCode}.json`;
        const bundlePath = path.join(this.extensionPath, 'l10n', bundleFileName);

        try {
            if (fs.existsSync(bundlePath)) {
                const content = fs.readFileSync(bundlePath, 'utf8');
                this.bundle = JSON.parse(content);
                console.log(`LocalizationManager: Loaded ${bundleFileName}`);
            } else {
                console.warn(`LocalizationManager: Bundle ${bundleFileName} not found, falling back to empty (keys will be used)`);
                this.bundle = {};
            }
        } catch (error) {
            console.error(`LocalizationManager: Failed to load bundle ${bundleFileName}`, error);
            this.bundle = {};
        }
    }

    public t(key: string, ...args: any[]): string {
        let text = this.bundle[key] || key;

        // Simple placeholder replacement {0}, {1}, etc.
        if (args.length > 0) {
            text = text.replace(/\{(\d+)\}/g, (match, index) => {
                return typeof args[index] !== 'undefined' ? args[index] : match;
            });
        }

        return text;
    }

    public getLocale(): string {
        return this.currentLanguage;
    }
}
