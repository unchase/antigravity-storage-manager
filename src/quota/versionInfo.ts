
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface VersionInfo {
    extensionVersion: string;
    ideName: string;
    productName?: string;
    ideVersion: string;
    vscodeOssVersion: string;
    os: string;
}

class VersionInfoService {
    private static instance: VersionInfoService;
    private versionInfo: VersionInfo | null = null;

    private constructor() { }

    static getInstance(): VersionInfoService {
        if (!VersionInfoService.instance) {
            VersionInfoService.instance = new VersionInfoService();
        }
        return VersionInfoService.instance;
    }

    initialize(context: vscode.ExtensionContext): void {
        const extensionVersion = context.extension.packageJSON.version || 'unknown';
        const ideName = vscode.env.appName || 'unknown';
        const vscodeOssVersion = vscode.version || 'unknown';

        let ideVersion = 'unknown';
        let productName: string | undefined;
        try {
            const productJsonPath = path.join(vscode.env.appRoot, 'product.json');
            if (fs.existsSync(productJsonPath)) {
                const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
                ideVersion = productJson.ideVersion || productJson.version || 'unknown';
                productName = productJson.nameLong || productJson.applicationName || productJson.nameShort;
            }
        } catch (e) {
            console.warn('VersionInfo', 'Failed to read product.json:', e);
        }

        let os = 'unknown';
        switch (process.platform) {
            case 'win32':
                os = 'windows';
                break;
            case 'darwin':
                os = 'darwin';
                break;
            case 'linux':
                os = 'linux';
                break;
            default:
                os = process.platform;
        }

        this.versionInfo = {
            extensionVersion,
            ideName,
            productName,
            ideVersion,
            vscodeOssVersion,
            os,
        };
    }

    getVersionInfo(): VersionInfo {
        if (!this.versionInfo) {
            // Return placeholder if not initialized to avoid crash, though ideally initialized
            return {
                extensionVersion: 'unknown',
                ideName: 'unknown',
                ideVersion: 'unknown',
                vscodeOssVersion: 'unknown',
                os: 'unknown'
            };
        }
        return this.versionInfo;
    }

    getIdeVersion(): string {
        return this.versionInfo?.ideVersion || 'unknown';
    }

    getIdeName(): string {
        return this.versionInfo?.ideName || 'unknown';
    }

    getExtensionVersion(): string {
        return this.versionInfo?.extensionVersion || 'unknown';
    }

    getOs(): string {
        return this.versionInfo?.os || 'unknown';
    }
}

export const versionInfo = VersionInfoService.getInstance();
