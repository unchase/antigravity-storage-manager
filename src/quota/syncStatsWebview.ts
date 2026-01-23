import * as vscode from 'vscode';
import { LocalizationManager } from '../l10n/localizationManager';
import { SyncManifest } from '../googleDrive';

export interface ActiveTransfer {
    conversationId: string;
    conversationTitle: string;
    type: 'upload' | 'download';
    startTime?: number;
    progress?: number; // 0-100
}

export interface SyncStatsData {
    localConversations: any[];
    remoteManifest: SyncManifest;
    localCount: number;
    remoteCount: number;
    lastSync: string;
    machines: any[];
    loadTime: number;
    currentMachineId: string;
    driveQuota?: { used: number; limit: number };
    activeTransfers?: ActiveTransfer[];
}

export class SyncStatsWebview {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static readonly viewType = 'syncStats';
    private static extensionUri: vscode.Uri | undefined;
    private static devicesSort = { col: 'lastSync', dir: 'desc' as 'asc' | 'desc' };
    private static convsSort = { col: 'modified', dir: 'desc' as 'asc' | 'desc' };

    public static show(context: vscode.ExtensionContext, data: SyncStatsData, onMessage: (message: any) => void, preserveFocus: boolean = false): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SyncStatsWebview.currentPanel) {
            SyncStatsWebview.currentPanel.reveal(column, preserveFocus);
            SyncStatsWebview.currentPanel.webview.html = SyncStatsWebview.getHtmlContent(data);
            return;
        }

        const lm = LocalizationManager.getInstance();
        const panel = vscode.window.createWebviewPanel(
            SyncStatsWebview.viewType,
            lm.t('Antigravity Sync Statistics'),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')]
            }
        );

        SyncStatsWebview.extensionUri = context.extensionUri;

        SyncStatsWebview.currentPanel = panel;
        panel.webview.html = SyncStatsWebview.getHtmlContent(data);

        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'openPatreon') {
                vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
            } else if (message.command === 'openCoffee') {
                vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
            } else {
                onMessage(message);
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(
            () => {
                SyncStatsWebview.currentPanel = undefined;
            },
            undefined,
            context.subscriptions
        );
    }

    public static update(data: SyncStatsData): void {
        if (SyncStatsWebview.currentPanel) {
            SyncStatsWebview.currentPanel.webview.html = SyncStatsWebview.getHtmlContent(data);
        }
    }

    public static updateSort(table: 'devices' | 'conversations', col: string): void {
        const sort = table === 'devices' ? SyncStatsWebview.devicesSort : SyncStatsWebview.convsSort;
        if (sort.col === col) {
            sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            sort.col = col;
            sort.dir = 'asc';
        }
    }

    public static isVisible(): boolean {
        return !!SyncStatsWebview.currentPanel;
    }

    private static getHtmlContent(data: SyncStatsData): string {
        const lm = LocalizationManager.getInstance();
        const now = Date.now();

        // Sort machines
        const sortedMachines = [...data.machines];
        const dSort = SyncStatsWebview.devicesSort;
        sortedMachines.sort((a, b) => {
            let valA: any, valB: any;
            switch (dSort.col) {
                case 'name': valA = a.name || ''; valB = b.name || ''; break;
                case 'syncs': valA = a.syncCount || 0; valB = b.syncCount || 0; break;
                case 'data':
                    valA = (a.uploadCount || 0) + (a.downloadCount || 0);
                    valB = (b.uploadCount || 0) + (b.downloadCount || 0);
                    break;
                case 'lastSync': valA = new Date(a.lastSync).getTime(); valB = new Date(b.lastSync).getTime(); break;
                default: valA = 0; valB = 0;
            }
            if (valA < valB) return dSort.dir === 'asc' ? -1 : 1;
            if (valA > valB) return dSort.dir === 'asc' ? 1 : -1;
            return 0;
        });

        // Group machines by name (maintaining sorted order within groups or overall)
        const machineGroups = new Map<string, any[]>();
        sortedMachines.forEach(m => {
            const name = m.name || lm.t('Unknown Device');
            if (!machineGroups.has(name)) machineGroups.set(name, []);
            machineGroups.get(name)!.push(m);
        });

        const formatBytes = (bytes: number) => {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        const syncedCount = data.localConversations.filter(l => data.remoteManifest.conversations.some(r => r.id === l.id)).length;
        const localPct = data.localCount > 0 ? (syncedCount / data.localCount) * 100 : 0;
        const remotePct = data.remoteCount > 0 ? (syncedCount / data.remoteCount) * 100 : 0;

        // Use Codicon class names for file icons
        const getFileIcon = (filename: string): string => {
            const ext = filename.split('.').pop()?.toLowerCase();
            switch (ext) {
                case 'md': case 'txt': case 'log': return 'file';
                case 'json': return 'json';
                case 'js': case 'ts': case 'py': case 'java': case 'c': case 'cpp': case 'h': case 'cs': case 'go': case 'rs': case 'php': return 'file-code';
                case 'html': case 'css': case 'xml': case 'scss': case 'less': return 'file-code';
                case 'jpg': case 'png': case 'gif': case 'svg': case 'webp': case 'bmp': case 'ico': return 'file-media';
                case 'zip': case 'gz': case 'tar': case 'rar': case '7z': return 'file-zip';
                case 'yaml': case 'yml': case 'toml': case 'ini': case 'conf': return 'settings-gear';
                default: return 'file';
            }
        };

        // Generate Codicons CSS URI
        let codiconsUri = '';
        if (SyncStatsWebview.currentPanel && SyncStatsWebview.extensionUri) {
            const codiconsPath = vscode.Uri.joinPath(SyncStatsWebview.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
            codiconsUri = SyncStatsWebview.currentPanel.webview.asWebviewUri(codiconsPath).toString();
        }

        const cspSource = SyncStatsWebview.currentPanel?.webview.cspSource || '';

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; img-src ${cspSource} data:;">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            ${codiconsUri ? `<link href="${codiconsUri}" rel="stylesheet" />` : ''}
            <style>
                :root {
                    --bg: var(--vscode-editor-background);
                    --fg: var(--vscode-editor-foreground);
                    --card-bg: var(--vscode-editor-lineHighlightBackground);
                    --border: var(--vscode-panel-border);
                    --accent: var(--vscode-button-background);
                    --accent-fg: var(--vscode-button-foreground);
                    --accent-hover: var(--vscode-button-hoverBackground);
                    --success: var(--vscode-testing-iconPassed);
                    --warning: var(--vscode-testing-iconQueued);
                    --error: var(--vscode-testing-iconFailed);
                    --text-secondary: var(--vscode-descriptionForeground);
                    --link: var(--vscode-textLink-foreground);
                    --font: var(--vscode-font-family, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
                }

                body {
                    font-family: var(--font);
                    background-color: var(--bg);
                    color: var(--fg);
                    padding: 30px;
                    margin: 0;
                    line-height: 1.6;
                    overflow-x: hidden;
                }

                .container { max-width: 1200px; margin: 0 auto; }

                /* Header */
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 40px;
                    animation: fadeInDown 0.5s ease-out;
                }

                h1 { margin: 0; font-size: 28px; font-weight: 300; letter-spacing: -0.5px; opacity: 0.9; }
                h1 strong { font-weight: 700; color: var(--accent); }

                .header-actions { display: flex; gap: 12px; align-items: center; }
                .last-sync { font-size: 12px; opacity: 0.6; }

                /* Stats Grid */
                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
                    gap: 24px;
                    margin-bottom: 40px;
                }


                .card {
                    background: var(--card-bg);
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    padding: 24px;
                    position: relative;
                    overflow: hidden;
                    transition: transform 0.2s, box-shadow 0.2s;
                    animation: fadeInUp 0.5s ease-out backwards;
                }
                .card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
                
                .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px; font-weight: 600; }
                .card-value { font-size: 32px; font-weight: 700; margin-bottom: 4px; }
                .card-subtitle { font-size: 12px; opacity: 0.6; }

                .progress-mini {
                    height: 4px; border-radius: 2px; background: rgba(255,255,255,0.05); margin-top: 15px; position: relative;
                }
                .progress-mini-fill { height: 100%; border-radius: 2px; background: var(--accent); position: absolute; left: 0; top: 0; transition: width 1s ease-out; }

                /* Storage Section */
                .storage-section {
                    background: linear-gradient(135deg, var(--card-bg), rgba(255,255,255,0.02));
                    border: 1px solid var(--border);
                    border-radius: 12px;
                    padding: 24px;
                    margin-bottom: 40px;
                    display: flex;
                    align-items: center;
                    gap: 30px;
                    animation: fadeIn 0.8s ease-out;
                }
                .storage-icon { font-size: 40px; opacity: 0.8; }
                .storage-info { flex-grow: 1; }
                .storage-title { font-weight: 600; margin-bottom: 5px; }
                .storage-stats { font-size: 13px; opacity: 0.7; display: flex; justify-content: space-between; margin-bottom: 8px; }
                .storage-bar { height: 10px; background: rgba(0,0,0,0.2); border-radius: 5px; overflow: hidden; }
                .storage-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--success)); transition: width 1s; }

                /* Tables & Lists */
                .section-title { font-size: 18px; font-weight: 600; margin-bottom: 20px; color: var(--fg); opacity: 0.9; }

                .data-container { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 40px; }
                
                table { width: 100%; border-collapse: collapse; text-align: left; }
                th { padding: 16px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.6; border-bottom: 1px solid var(--border); font-weight: 600; }
                th.sortable { cursor: pointer; user-select: none; transition: opacity 0.2s; position: relative; padding-right: 24px; }
                th.sortable:hover { opacity: 1; color: var(--accent); }
                th.sort-active { opacity: 1; color: var(--accent); }
                .sort-indicator { 
                    position: absolute; right: 8px; top: 50%; transform: translateY(-50%); 
                    font-size: 10px; opacity: 0.5;
                }
                th.sort-active .sort-indicator { opacity: 1; }
                
                td { padding: 16px; border-bottom: 1px solid var(--border); font-size: 13px; }
                tr:last-child td { border-bottom: none; }
                tr:hover td { background: rgba(255,255,255,0.02); }

                .group-header { background: rgba(255,255,255,0.03) !important; font-weight: 700; cursor: pointer; user-select: none; }
                .group-header td { padding: 12px 16px; border-left: 4px solid var(--accent); }
                .collapse-icon { display: inline-block; transition: transform 0.2s; margin-right: 8px; opacity: 0.5; }
                .collapsed .collapse-icon { transform: rotate(-90deg); }
                .collapsed-row { display: none; }

                .status-dot {
                    width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 10px;
                    box-shadow: 0 0 8px currentColor;
                }
                .pulse { animation: pulse 2s infinite; }

                .badge { padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; background: rgba(255,255,255,0.1); }
                .badge.success { background: var(--success); color: #fff; }
                .badge.warning { background: var(--warning); color: #000; }
                .badge.accent { background: var(--accent); color: var(--accent-fg); }

                /* Buttons */
                .btn {
                    background: var(--accent); color: var(--accent-fg); border: none; padding: 8px 16px;
                    border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 600;
                    display: inline-flex; align-items: center; gap: 8px; transition: all 0.2s;
                }
                .btn:hover { background: var(--accent-hover); transform: translateY(-1px); }
                .btn:active { transform: translateY(0); }
                
                .btn-icon { background: none; border: none; color: inherit; cursor: pointer; padding: 4px; border-radius: 4px; opacity: 0.6; transition: 0.2s; }
                .btn-icon:hover { opacity: 1; background: rgba(255,255,255,0.1); }
                .btn-icon.danger:hover { color: var(--error); background: rgba(255,0,0,0.1); }

                /* Animations */
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes fadeInDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }

                .link { color: var(--link); text-decoration: none; font-weight: 600; cursor: pointer; }
                .link:hover { text-decoration: underline; }

                .file-list-row { display: none; background: rgba(0,0,0,0.1); }
                .file-list-wrapper { max-height: 300px; overflow-y: auto; padding: 10px; }
                .file-item { display: flex; justify-content: space-between; padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; align-items: center; }
                .file-item:last-child { border-bottom: none; }
                .file-item:hover { background: rgba(255,255,255,0.05); }
                .file-icon { font-size: 16px; margin-right: 8px; min-width: 20px; text-align: center; }

                .meta-info { font-size: 11px; opacity: 0.6; margin-top: 4px; display: flex; align-items: center; gap: 8px; }

                ::-webkit-scrollbar { width: 10px; }
                ::-webkit-scrollbar-track { background: transparent; }
                ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; }
                ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.1); }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Antigravity <strong>${lm.t('Sync')}</strong></h1>
                    <div class="header-actions">
                        <button class="btn" onclick="postCommand('openPatreon')" title="${lm.t('Support on Patreon')}" style="padding: 8px 12px; min-width: 40px; justify-content: center;">🧡</button>
                        <button class="btn" onclick="postCommand('openCoffee')" title="${lm.t('Buy Me a Coffee')}" style="padding: 8px 12px; min-width: 40px; justify-content: center;">☕</button>
                        <div style="width: 1px; height: 24px; background: var(--border); margin: 0 4px;"></div>
                        <span class="last-sync">${lm.t('Last Update')}: ${lm.formatDateTime(new Date())}</span>
                        <button class="btn" onclick="postCommand('refresh')">🔄 ${lm.t('Refresh')}</button>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="card" style="animation-delay: 0.1s">
                        <div class="card-label">${lm.t('Local Library')}</div>
                        <div class="card-value">${data.localCount}</div>
                        <div class="card-subtitle">${syncedCount} ${lm.t('synced with cloud')}</div>
                        <div class="progress-mini"><div class="progress-mini-fill" style="width: ${localPct}%"></div></div>
                    </div>
                    <div class="card" style="animation-delay: 0.2s">
                        <div class="card-label">${lm.t('Cloud Library')}</div>
                        <div class="card-value">${data.remoteCount}</div>
                        <div class="card-subtitle">${syncedCount} ${lm.t('synced locally')}</div>
                        <div class="progress-mini"><div class="progress-mini-fill" style="width: ${remotePct}%"></div></div>
                    </div>
                    <div class="card" style="animation-delay: 0.3s">
                        <div class="card-label">${lm.t('Sync Network')}</div>
                        <div class="card-value">${data.machines.length}</div>
                        <div class="card-subtitle">${Array.from(machineGroups.keys()).length} ${lm.t('unique devices')}</div>
                    </div>
                    <div class="card" style="animation-delay: 0.4s">
                        <div class="card-label">${lm.t('Performance')}</div>
                        <div class="card-value">${data.loadTime}ms</div>
                        <div class="card-subtitle">${lm.t('remote fetch latency')}</div>
                    </div>
                </div>

                ${data.driveQuota ? `
                <div class="storage-section">
                    <div class="storage-icon">☁️</div>
                    <div class="storage-info">
                        <div class="storage-title">${lm.t('Google Drive Storage')}</div>
                        <div class="storage-stats">
                            <span>${formatBytes(data.driveQuota.used)} ${lm.t('of')} ${formatBytes(data.driveQuota.limit)}</span>
                            <span>${((data.driveQuota.used / data.driveQuota.limit) * 100).toFixed(1)}%</span>
                        </div>
                        <div class="storage-bar">
                            <div class="storage-bar-fill" style="width: ${(data.driveQuota.used / data.driveQuota.limit) * 100}%"></div>
                        </div>
                    </div>
                </div>
                ` : ''}

                ${data.activeTransfers && data.activeTransfers.length > 0 ? `
                <div class="section-title">${lm.t('Active Transfers')}</div>
                <div class="data-container" style="background: linear-gradient(135deg, var(--card-bg), rgba(100,200,255,0.05)); border: 1px solid rgba(100,200,255,0.2);">
                    <table>
                        <tbody>
                            ${data.activeTransfers.map(t => {
            const startTime = t.startTime ? new Date(t.startTime).toLocaleTimeString(lm.getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
            return `
                                <tr>
                                    <td style="width: 40px; text-align: center;">
                                        <span class="pulse" style="font-size: 18px;">${t.type === 'upload' ? '⬆️' : '⬇️'}</span>
                                    </td>
                                    <td>
                                        <div class="link" onclick="postCommand('openConversation', {id:'${t.conversationId}'})">${t.conversationTitle}</div>
                                        <div style="font-size: 11px; opacity: 0.6; font-family: monospace">${t.conversationId}</div>
                                        ${startTime ? `<div style="font-size: 10px; opacity: 0.5;">${lm.t('Started at {0}', startTime)}</div>` : ''}
                                    </td>
                                    <td style="width: 150px">
                                        <div style="display: flex; align-items: center; gap: 10px;">
                                            <span class="badge ${t.type === 'upload' ? 'accent' : 'success'}">${t.type === 'upload' ? lm.t('Uploading') : lm.t('Downloading')}</span>
                                        </div>
                                    </td>
                                </tr>
                                `;
        }).join('')}
                        </tbody>
                    </table>
                </div>
                ` : ''}

                <div class="section-title">${lm.t('Devices & Active Sessions')}</div>
                <div class="data-container">
                    <table>
                        <thead>
                            <tr>
                                <th class="sortable ${SyncStatsWebview.devicesSort.col === 'name' ? 'sort-active' : ''}" onclick="postCommand('sort', {table:'devices', col:'name'})">
                                    ${lm.t('Device')} ${SyncStatsWebview.devicesSort.col === 'name' ? `<span class="sort-indicator">${SyncStatsWebview.devicesSort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
                                </th>
                                <th class="sortable ${SyncStatsWebview.devicesSort.col === 'syncs' ? 'sort-active' : ''}" style="width: 15%" onclick="postCommand('sort', {table:'devices', col:'syncs'})">
                                    ${lm.t('Syncs')} ${SyncStatsWebview.devicesSort.col === 'syncs' ? `<span class="sort-indicator">${SyncStatsWebview.devicesSort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
                                </th>
                                <th class="sortable ${SyncStatsWebview.devicesSort.col === 'data' ? 'sort-active' : ''}" style="width: 15%" onclick="postCommand('sort', {table:'devices', col:'data'})">
                                    ${lm.t('Data')} ${SyncStatsWebview.devicesSort.col === 'data' ? `<span class="sort-indicator">${SyncStatsWebview.devicesSort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
                                </th>
                                <th class="sortable ${SyncStatsWebview.devicesSort.col === 'lastSync' ? 'sort-active' : ''}" style="width: 20%" onclick="postCommand('sort', {table:'devices', col:'lastSync'})">
                                    ${lm.t('Last Active')} ${SyncStatsWebview.devicesSort.col === 'lastSync' ? `<span class="sort-indicator">${SyncStatsWebview.devicesSort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
                                </th>
                                <th style="text-align:right; width: 15%">${lm.t('Actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${Array.from(machineGroups.entries()).map(([name, group], gIdx) => {
            const groupId = `group-${gIdx}`;
            const isCurrentGroup = group.some(m => m.isCurrent);
            return `
                                    <tr class="group-header" onclick="toggleGroup('${groupId}')">
                                        <td colspan="5">
                                            <span class="collapse-icon" id="icon-${groupId}">▼</span>
                                            ${name} ${isCurrentGroup ? `<span class="badge accent" style="margin-left:10px">${lm.t('This Machine')}</span>` : ''}
                                            <span style="float:right; opacity:0.5; font-weight:400; font-size:11px">${group.length} ${lm.t('sessions')}</span>
                                        </td>
                                    </tr>
                                    ${group.map(m => {
                const isOnline = (now - new Date(m.lastSync).getTime()) < 600000;
                return `
                                            <tr class="session-row ${groupId}" style="${m.isCurrent ? 'background: rgba(255,255,255,0.05)' : ''}">
                                                <td style="padding-left: 32px">
                                                    <span class="status-dot ${isOnline ? 'pulse' : ''}" style="color: ${isOnline ? 'var(--success)' : 'var(--error)'}; background: currentColor"></span>
                                                    <span title="${m.id}" style="font-family: monospace; cursor: help;">${m.id.substring(0, 8)}...</span>
                                                    ${m.isCurrent ? `<b>(${lm.t('Active Now')})</b>` : ''}
                                                </td>
                                                <td>${m.syncCount}</td>
                                                <td>
                                                    <span title="${lm.t('Uploads')}">⬆️ ${m.uploadCount || 0}</span>
                                                    <span title="${lm.t('Downloads')}" style="margin-left:8px">⬇️ ${m.downloadCount || 0}</span>
                                                </td>
                                                <td>${lm.formatDateTime(m.lastSync)}</td>
                                                <td style="text-align:right">
                                                    ${!m.isCurrent ? `
                                                        <button class="btn-icon danger" onclick="postCommand('deleteMachine', {id:'${m.fileId}', name:'${m.name}'})" title="${lm.t('Remove machine')}">🗑️</button>
                                                        <button class="btn-icon" onclick="postCommand('deleteMachineConversations', {id:'${m.id}', name:'${m.name}'})" title="${lm.t('Clear Files')}">🧹</button>
                                                        <button class="btn-icon" onclick="postCommand('forceRemoteSync', {id:'${m.id}', name:'${m.name}'})" title="${lm.t('Ping Device')}">🔄</button>
                                                    ` : '-'}
                                                </td>
                                            </tr>
                                        `;
            }).join('')}
                                `;
        }).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="section-title">${lm.t('Conversations')}</div>
                <div class="data-container">
                    <table>
                        <thead>
                            <tr>
                                <th class="sortable ${SyncStatsWebview.convsSort.col === 'title' ? 'sort-active' : ''}" onclick="postCommand('sort', {table:'conversations', col:'title'})">
                                    ${lm.t('Content')} ${SyncStatsWebview.convsSort.col === 'title' ? `<span class="sort-indicator">${SyncStatsWebview.convsSort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
                                </th>
                                <th class="sortable ${SyncStatsWebview.convsSort.col === 'status' ? 'sort-active' : ''}" style="width: 15%" onclick="postCommand('sort', {table:'conversations', col:'status'})">
                                    ${lm.t('Status')} ${SyncStatsWebview.convsSort.col === 'status' ? `<span class="sort-indicator">${SyncStatsWebview.convsSort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
                                </th>
                                <th class="sortable ${SyncStatsWebview.convsSort.col === 'modified' ? 'sort-active' : ''}" style="width: 25%" onclick="postCommand('sort', {table:'conversations', col:'modified'})">
                                    ${lm.t('Modified')} ${SyncStatsWebview.convsSort.col === 'modified' ? `<span class="sort-indicator">${SyncStatsWebview.convsSort.dir === 'asc' ? '▲' : '▼'}</span>` : ''}
                                </th>
                                <th style="text-align:right; width: 20%">${lm.t('Actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${(() => {
                const allIds = new Set([
                    ...data.localConversations.map(c => c.id),
                    ...data.remoteManifest.conversations.map(c => c.id)
                ]);

                const convList = Array.from(allIds).map(id => {
                    const local = data.localConversations.find(c => c.id === id);
                    const remote = data.remoteManifest.conversations.find(c => c.id === id);
                    const title = remote?.title || local?.title || id;

                    let statusType = 0; // Synced
                    if (!remote) statusType = 1; // Local Only
                    else if (!local) statusType = 2; // Cloud Only

                    return { id, local, remote, title, statusType };
                });

                // Sort conversations
                const cSort = SyncStatsWebview.convsSort;
                convList.sort((a, b) => {
                    let valA: any, valB: any;
                    switch (cSort.col) {
                        case 'title': valA = a.title.toLowerCase(); valB = b.title.toLowerCase(); break;
                        case 'status': valA = a.statusType; valB = b.statusType; break;
                        case 'modified':
                            valA = new Date(a.remote?.lastModified || a.local?.lastModified || 0).getTime();
                            valB = new Date(b.remote?.lastModified || b.local?.lastModified || 0).getTime();
                            break;
                        default: valA = 0; valB = 0;
                    }
                    if (valA < valB) return cSort.dir === 'asc' ? -1 : 1;
                    if (valA > valB) return cSort.dir === 'asc' ? 1 : -1;
                    return 0;
                });

                return convList.map(({ id, local, remote, title, statusType }) => {
                    let statusBadge = '';
                    if (statusType === 0) statusBadge = `<span class="badge success">${lm.t('Synced')}</span>`;
                    else if (statusType === 2) statusBadge = `<span class="badge warning">${lm.t('Cloud Only')}</span>`;
                    else statusBadge = `<span class="badge accent">${lm.t('Local Only')}</span>`;

                    const modDate = remote?.lastModified || local?.lastModified || '';
                    const createdInfo = remote && remote.createdByName ? `${lm.t('Created by {0} on {1}', remote.createdByName, lm.formatDateTime(remote.createdAt || ''))}` : '';

                    const files = local?.files || remote?.fileHashes;
                    // For remote, fileHashes is object {path: info}, local files is object {path: info} too

                    let fileListHtml = '';
                    if (files) {
                        // Sort files by filename (basename)
                        const fileEntries = Object.entries(files).sort((a, b) => {
                            const nameA = a[0].split('/').pop()?.toLowerCase() || '';
                            const nameB = b[0].split('/').pop()?.toLowerCase() || '';
                            return nameA.localeCompare(nameB);
                        });
                        if (fileEntries.length > 0) {
                            fileListHtml = fileEntries.map(([fPath, fInfo]) => {
                                const size = (fInfo as any).size || 0;
                                const icon = getFileIcon(fPath);
                                return `<div class="file-item" onclick="event.stopPropagation(); postCommand('openConversationFile', {id: '${id}', file: '${fPath}'})">
                                        <div style="display:flex; align-items:center;">
                                            <i class="codicon codicon-${icon} file-icon" style="margin-right: 6px;"></i>
                                            <span>${fPath.split('/').pop()}</span>
                                            <span style="opacity:0.4; font-size:10px; margin-left:8px; font-family:monospace">${fPath}</span>
                                        </div>
                                        <div style="display:flex; align-items:center;">
                                            <span style="opacity:0.5; font-family:monospace; margin-right: 10px;">${formatBytes(size)}</span>
                                            <button class="btn-icon danger" onclick="event.stopPropagation(); postCommand('deleteConversationFile', {id:'${id}', file:'${fPath}'})" title="${lm.t('Delete')}">🗑️</button>
                                        </div>
                                    </div>`;
                            }).join('');
                        }
                    }

                    return `
                                        <tr onclick="toggleFiles('${id}')" style="cursor: pointer">
                                            <td>
                                                <div class="link" onclick="event.stopPropagation(); postCommand('openConversation', {id:'${id}'})">${title}</div>
                                                <div title="${id}" style="font-size:11px; opacity:0.5; font-family:monospace; display: inline-block;">${id.substring(0, 8)}...</div>
                                                ${createdInfo ? `<div class="meta-info">👤 ${createdInfo}</div>` : ''}
                                            </td>
                                            <td>${statusBadge}</td>
                                            <td>${modDate ? lm.formatDateTime(modDate) : '-'}</td>
                                            <td style="text-align:right">
                                                <button class="btn-icon" onclick="event.stopPropagation(); postCommand('renameConversation', {id:'${id}', title:'${title.replace(/'/g, "\\'")}'})" title="${lm.t('Rename')}">✏️</button>
                                                ${!remote ? `<button class="btn-icon" onclick="event.stopPropagation(); postCommand('pushConversation', {id:'${id}'})" title="${lm.t('Upload')}">⬆️</button>` : ''}
                                                ${!local ? `<button class="btn-icon" onclick="event.stopPropagation(); postCommand('pullConversation', {id:'${id}'})" title="${lm.t('Download')}">⬇️</button>` : ''}
                                                <button class="btn-icon danger" onclick="event.stopPropagation(); postCommand('deleteConversation', {id:'${id}', title:'${title.replace(/'/g, "\\'")}'})" title="${lm.t('Delete')}">🗑️</button>
                                            </td>
                                        </tr>
                                        ${fileListHtml ? `
                                        <tr id="files-${id}" class="file-list-row">
                                            <td colspan="4" style="padding: 0;">
                                                <div class="file-list-wrapper">
                                                    ${fileListHtml}
                                                </div>
                                            </td>
                                        </tr>
                                        ` : ''}
                                    `;
                }).join('');
            })()}
                        </tbody>
                    </table>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                function postCommand(command, data = {}) {
                    vscode.postMessage({ command, ...data });
                }

                function toggleGroup(groupId) {
                    const rows = document.querySelectorAll('.' + groupId);
                    const header = event.currentTarget;
                    const icon = document.getElementById('icon-' + groupId);
                    
                    header.classList.toggle('collapsed');
                    rows.forEach(row => {
                        row.classList.toggle('collapsed-row');
                    });
                }
                
                function toggleFiles(id) {
                    const el = document.getElementById('files-' + id);
                    if (el) {
                        el.style.display = el.style.display === 'table-row' ? 'none' : 'table-row';
                    }
                }
            </script>
        </body>
        </html>`;
    }
}
