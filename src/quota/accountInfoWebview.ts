import * as vscode from 'vscode';
import { LocalizationManager } from '../l10n/localizationManager';
import { QuotaSnapshot } from './types';
import { formatResetTime, formatDuration, getCycleDuration } from './utils';
import { QuotaUsageTracker } from './quotaUsageTracker';
import { StoredAccount } from '../googleAuth';

export class AccountInfoWebview {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static latestSnapshot: QuotaSnapshot | undefined;
    private static latestTracker: QuotaUsageTracker | undefined;
    private static latestAccounts: StoredAccount[] = [];
    private static latestCurrentAccountId: string | null = null;
    private static readonly viewType = 'accountInfo';

    public static show(
        context: vscode.ExtensionContext,
        snapshot: QuotaSnapshot,
        tracker?: QuotaUsageTracker,
        accounts: StoredAccount[] = [],
        currentAccountId: string | null = null
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        AccountInfoWebview.latestSnapshot = snapshot;
        if (tracker) AccountInfoWebview.latestTracker = tracker;
        AccountInfoWebview.latestAccounts = accounts;
        AccountInfoWebview.latestCurrentAccountId = currentAccountId;

        // If we already have a panel, show it
        if (AccountInfoWebview.currentPanel) {
            AccountInfoWebview.currentPanel.reveal(column);
            AccountInfoWebview.currentPanel.webview.html = AccountInfoWebview.getHtmlContent(snapshot);
            return;
        }

        const lm = LocalizationManager.getInstance();
        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            AccountInfoWebview.viewType,
            lm.t('Account Information'),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'node_modules'), vscode.Uri.joinPath(context.extensionUri, 'media')]
            }
        );

        AccountInfoWebview.currentPanel = panel;
        panel.webview.html = AccountInfoWebview.getHtmlContent(snapshot);

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'viewRawJson': {
                        const dataToView = AccountInfoWebview.latestSnapshot?.rawUserStatus || AccountInfoWebview.latestSnapshot || snapshot;
                        vscode.workspace.openTextDocument({
                            content: JSON.stringify(dataToView, null, 2),
                            language: 'json'
                        }).then(doc => {
                            vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
                        });
                        return;
                    }
                    case 'openPlan':
                        vscode.env.openExternal(vscode.Uri.parse('https://one.google.com/ai'));
                        return;
                    case 'openPatreon':
                        vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
                        return;
                    case 'openCoffee':
                        vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
                        return;
                    case 'togglePin': {
                        const modelId = message.modelId;
                        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                        const pinned = [...(config.get<string[]>('quota.pinnedModels') || [])];
                        const idx = pinned.indexOf(modelId);
                        if (idx >= 0) {
                            pinned.splice(idx, 1);
                        } else {
                            pinned.push(modelId);
                        }
                        config.update('quota.pinnedModels', pinned, vscode.ConfigurationTarget.Global);
                        return;
                    }
                    case 'addAccount':
                        vscode.commands.executeCommand('antigravity-storage-manager.addAccount');
                        return;
                    case 'switchAccount':
                        vscode.commands.executeCommand('antigravity-storage-manager.switchAccount', message.accountId);
                        return;
                    case 'removeAccount':
                        vscode.window.showWarningMessage(
                            lm.t('Are you sure you want to remove account {0}?', message.email),
                            { modal: true },
                            lm.t('Remove'),
                            lm.t('Cancel')
                        ).then(selection => {
                            if (selection === lm.t('Remove')) {
                                vscode.commands.executeCommand('antigravity-storage-manager.removeAccount', message.accountId);
                            }
                        });
                        return;
                }
            },
            undefined,
            context.subscriptions
        );

        // Reset when the panel is closed
        panel.onDidDispose(
            () => {
                AccountInfoWebview.currentPanel = undefined;
            },
            undefined,
            context.subscriptions
        );
    }

    public static update(
        snapshot: QuotaSnapshot,
        tracker?: QuotaUsageTracker,
        accounts?: StoredAccount[],
        currentAccountId?: string | null
    ): void {
        AccountInfoWebview.latestSnapshot = snapshot;
        if (tracker) AccountInfoWebview.latestTracker = tracker;
        if (accounts) AccountInfoWebview.latestAccounts = accounts;
        if (currentAccountId !== undefined) AccountInfoWebview.latestCurrentAccountId = currentAccountId;

        if (AccountInfoWebview.currentPanel) {
            AccountInfoWebview.currentPanel.webview.html = AccountInfoWebview.getHtmlContent(snapshot);
        }
    }

    private static getHtmlContent(snapshot: QuotaSnapshot): string {

        const l = LocalizationManager.getInstance();
        const data = snapshot.rawUserStatus?.userStatus || snapshot.rawUserStatus || {};
        const planInfo = data.planStatus?.planInfo;
        const userTier = data.userTier;

        // Accounts HTML
        const accountsHtml = AccountInfoWebview.latestAccounts.map(acc => {
            const isActive = acc.id === AccountInfoWebview.latestCurrentAccountId;
            const activeBadge = isActive ? `<span class="account-badge active">${l.t('Active')}</span>` : '';
            const actions = isActive
                ? ''
                : `<button class="icon-btn switch-btn" onclick="postCommand('switchAccount', {accountId: '${acc.id}'})" title="${l.t('Switch to {0}', acc.email)}">🔄</button>
                   <button class="icon-btn remove-btn" onclick="postCommand('removeAccount', {accountId: '${acc.id}', email: '${acc.email}'})" title="${l.t('Remove Account')}">🗑️</button>`;

            return `
            <div class="account-row ${isActive ? 'active-row' : ''}">
                <div class="account-info">
                    <div class="account-name">${acc.name} ${activeBadge}</div>
                    <div class="account-email">${acc.email}</div>
                </div>
                <div class="account-actions">
                    ${actions}
                </div>
            </div>`;
        }).join('');

        // Credits calculations
        const promptCredits = snapshot.promptCredits;
        const promptPercent = promptCredits?.remainingPercentage ?? 0;

        // Model quotas
        const pinnedIds = vscode.workspace.getConfiguration('antigravity-storage-manager').get<string[]>('quota.pinnedModels') || [];
        const models = [...(snapshot.models || [])].sort((a, b) => {
            const aPinned = pinnedIds.includes(a.modelId) || pinnedIds.includes(a.label);
            const bPinned = pinnedIds.includes(b.modelId) || pinnedIds.includes(b.label);
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;
            return 0;
        });

        // Features
        const featuresList = [
            { id: 'webSearch', name: l.t('Web Search'), enabled: planInfo?.cascadeWebSearchEnabled },
            { id: 'browser', name: l.t('Browser Tool'), enabled: planInfo?.browserEnabled },
            { id: 'kb', name: l.t('Knowledge Base'), enabled: planInfo?.knowledgeBaseEnabled },
            { id: 'autorun', name: l.t('Auto-run Commands'), enabled: planInfo?.cascadeCanAutoRunCommands },
            { id: 'commit', name: l.t('Generate Commit Messages'), enabled: planInfo?.canGenerateCommitMessages },
            { id: 'mcp', name: l.t('MCP Servers'), enabled: planInfo?.defaultTeamConfig?.allowMcpServers },
        ];

        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
        const warningThreshold = config.get<number>('quota.thresholds.warning') ?? config.get<number>('quota.warningThreshold') ?? 50;
        const criticalThreshold = config.get<number>('quota.thresholds.critical') ?? config.get<number>('quota.criticalThreshold') ?? 30;
        const dangerThreshold = config.get<number>('quota.thresholds.danger') ?? config.get<number>('quota.dangerThreshold') ?? 0;

        const getStatusIcon = (pct: number, isExhausted: boolean): string => {
            if (isExhausted || pct <= dangerThreshold) return '🔴';
            if (pct < criticalThreshold) return '🟠';
            if (pct < warningThreshold) return '🟡';
            return '🟢';
        };

        const getProgressBarColor = (pct: number, isExhausted: boolean): string => {
            if (isExhausted || pct <= dangerThreshold) return 'var(--danger)';
            if (pct < criticalThreshold) return 'var(--warning-dark)';
            if (pct < warningThreshold) return 'var(--warning)';
            return 'var(--success)';
        };

        const modelsHtml = models.map(model => {
            const pct = model.remainingPercentage ?? 0;
            const statusIcon = getStatusIcon(pct, model.isExhausted);
            const color = getProgressBarColor(pct, model.isExhausted);
            const resetTimeStr = formatResetTime(model.resetTime);

            let cycleInfo = '';
            const isHighTier = model.label.includes('Pro') || model.label.includes('Ultra') || model.label.includes('Thinking') || model.label.includes('Opus');
            if (isHighTier && model.timeUntilReset > 0) {
                const cycleDuration = getCycleDuration(model.label);
                const progress = Math.max(0, Math.min(1, 1 - (model.timeUntilReset / cycleDuration)));
                const progressPct = (progress * 100).toFixed(1);
                // Use HTML progress bar instead of ASCII
                cycleInfo = `<div class="cycle-info">${l.t('Cycle')}: <div class="cycle-bar-wrapper"><div class="cycle-bar" style="width: ${progressPct}%;"></div></div> <span class="time">(${formatDuration(model.timeUntilReset)} ${l.t('left')})</span></div>`;
            }

            const stats = [];
            if (model.requestUsage !== undefined && model.requestLimit) {
                stats.push(`${l.t('Requests')}: <b>${model.requestUsage} / ${model.requestLimit}</b>`);
            }
            if (model.tokenUsage !== undefined && model.tokenLimit) {
                stats.push(`${l.t('Tokens')}: <b>${model.tokenUsage} / ${model.tokenLimit}</b>`);
            }

            // Estimation
            let estimationInfo = '';
            if (AccountInfoWebview.latestTracker) {
                const est = AccountInfoWebview.latestTracker.getEstimation(model.modelId);
                if (!(model.isExhausted || pct === 0) && est && est.speedPerHour > 0.1) {
                    estimationInfo += `<div>${l.t('Speed')}: <b>~${est.speedPerHour.toFixed(1)}%${l.t('/h')}</b></div>`;
                    if (est.estimatedTimeRemainingMs) {
                        const timeRem = formatDuration(est.estimatedTimeRemainingMs);
                        estimationInfo += `<div>${l.t('Estimated Remaining Time')}: <b>~${timeRem}</b></div>`;
                    }
                }
            }

            const isPinned = pinnedIds.includes(model.modelId) || pinnedIds.includes(model.label);

            return `
                <div class="model-row ${isPinned ? 'pinned-row' : ''}">
                    <div class="model-header">
                        <div style="display:flex; align-items:center; gap:8px;">
                             ${isPinned
                    ? `<div class="pin-btn pinned" onclick="postCommand('togglePin', {modelId: '${model.modelId}'})" title="${l.t('Unpin')}">📌</div>`
                    : `<div class="pin-btn unpinned" onclick="postCommand('togglePin', {modelId: '${model.modelId}'})" title="${l.t('Pin')}">📍</div>`
                }
                             <span class="model-title">${statusIcon} ${model.label}</span>
                        </div>
                        <span class="model-reset">${resetTimeStr}</span>
                    </div>
                    <div class="model-stats-row">
                        <div class="quota-container">
                            <span class="quota-label">${l.t('Quota Left')}:</span>
                            <div class="progress-bar-wrapper">
                                <div class="progress-bar" style="width: ${pct}%; background: ${color};"></div>
                            </div>
                            <span class="quota-value" style="color: ${color};">${pct.toFixed(1)}%</span>
                        </div>
                        <div class="usage-stats">
                            ${stats.length > 0 ? stats.join(' &nbsp;|&nbsp; ') : ''}
                            ${estimationInfo ? `<div style="margin-top:4px; display:flex; gap:16px; opacity:0.8">${estimationInfo}</div>` : ''}
                        </div>
                    </div>
                    ${cycleInfo}
                    ${(() => {
                    // Chart Rendering Logic
                    if (!AccountInfoWebview.latestTracker) return '';
                    const history = AccountInfoWebview.latestTracker.getHistory(model.modelId);
                    if (!history || history.length < 2) return '';

                    const width = 200;
                    const height = 40;
                    const padding = 2;

                    // Sort by time
                    history.sort((a, b) => a.timestamp - b.timestamp);

                    // Limit to last 7 days (or config) - though tracker already does pruning
                    const minTime = history[0].timestamp;
                    const maxTime = history[history.length - 1].timestamp;
                    const timeRange = maxTime - minTime;

                    if (timeRange <= 0) return ''; // No duration

                    const points = history.map(p => {
                        const x = padding + ((p.timestamp - minTime) / timeRange) * (width - 2 * padding);
                        const y = height - padding - ((p.usage / 100) * (height - 2 * padding));
                        return `${x},${y}`;
                    }).join(' ');

                    // Area path (close the loop)
                    const firstPt = points.split(' ')[0];
                    const lastPt = points.split(' ').pop();
                    const areaPath = `${points} ${lastPt?.split(',')[0]},${height} ${firstPt?.split(',')[0]},${height}`;

                    return `
                        <div class="chart-container" title="${l.t('Usage History')}">
                             <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
                                <defs>
                                    <linearGradient id="grad-${model.modelId}" x1="0%" y1="0%" x2="0%" y2="100%">
                                        <stop offset="0%" style="stop-color:${color};stop-opacity:0.3" />
                                        <stop offset="100%" style="stop-color:${color};stop-opacity:0" />
                                    </linearGradient>
                                </defs>
                                <path d="${points}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" />
                                <polygon points="${areaPath}" fill="url(#grad-${model.modelId})" />
                             </svg>
                        </div>`;
                })()}
                </div>
            `;
        }).join('');

        const featuresHtml = featuresList.map(f => `
            <div class="feature-card ${f.enabled ? 'enabled' : 'disabled'}">
                <div class="feature-top">
                    <span class="feature-name">${f.name}</span>
                    <span class="feature-badge">${f.enabled ? l.t('Enabled') : l.t('Disabled')}</span>
                </div>
            </div>
        `).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${l.t('Account Information')}</title>
    <style>
        :root {
            --bg-main: #0d1117;
            --bg-card: #161b22;
            --bg-hover: #21262d;
            --border: #30363d;
            --text-main: #c9d1d9;
            --text-dim: #8b949e;
            --accent: #2f81f7;
            --accent-glow: rgba(47, 129, 247, 0.15);
            --success: #238636;
            --warning: #d29922;
            --warning-dark: #9e6a03;
            --danger: #da3633;
            --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        }

        body {
            background-color: var(--bg-main);
            color: var(--text-main);
            font-family: var(--font);
            margin: 0;
            padding: 24px;
            display: flex;
            justify-content: center;
        }

        .dashboard {
            width: 100%;
            max-width: 960px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 32px;
        }

        .header h1 {
            font-size: 24px;
            font-weight: 600;
            margin: 0;
        }

        .header-btns {
            display: flex;
            gap: 12px;
        }

        .btn {
            background: var(--bg-card);
            border: 1px solid var(--border);
            color: var(--text-main);
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn:hover {
            background: var(--bg-hover);
            border-color: var(--text-dim);
        }

        .section-title {
            font-size: 14px;
            font-weight: 500;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 16px;
            margin-top: 32px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .action-link {
            text-decoration: none;
            color: var(--accent);
            cursor: pointer;
            font-size: 12px;
            text-transform: none;
        }

        /* Accounts List */
         .accounts-container {
            display: flex;
            flex-direction: column;
            gap: 12px;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 24px;
        }

        .account-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            background: rgba(255,255,255,0.03);
            border-radius: 8px;
            border: 1px solid transparent;
        }

        .account-row.active-row {
            border-color: var(--success);
            background: rgba(35, 134, 54, 0.05);
        }

        .account-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .account-name {
            font-weight: 600;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .account-email {
            font-size: 12px;
            color: var(--text-dim);
        }

        .account-badge {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 4px;
            text-transform: uppercase;
            font-weight: 700;
        }

        .account-badge.active {
            background: var(--success);
            color: white;
        }

        .account-actions {
            display: flex;
            gap: 8px;
        }

        .icon-btn {
            background: transparent;
            border: none;
            color: var(--text-dim);
            cursor: pointer;
            font-size: 16px;
            padding: 4px;
            border-radius: 4px;
            transition: all 0.2s;
        }
        
        .icon-btn:hover {
            background: var(--bg-hover);
            color: var(--text-main);
        }
        
        .remove-btn:hover {
            color: var(--danger);
            background: rgba(218, 54, 51, 0.1);
        }

        /* Profile Card */
        .profile-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px;
        }

        .profile-box {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .p-label {
            font-size: 12px;
            color: var(--text-dim);
        }

        .p-value {
            font-size: 16px;
            font-weight: 600;
        }

        .plan-tag {
            background: var(--accent);
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 14px;
            display: inline-block;
        }

        /* Credits Card */
        .credits-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px;
        }

        .credit-row {
            margin-bottom: 24px;
        }

        .credit-row:last-child {
            margin-bottom: 0;
        }

        .cred-info {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
        }

        .cred-title {
            font-weight: 600;
        }

        .cred-val {
            color: var(--text-dim);
            font-size: 13px;
        }

        .bar-outer {
            height: 10px;
            background: var(--border);
            border-radius: 5px;
            overflow: hidden;
            position: relative;
        }

        .bar-inner {
            height: 100%;
            border-radius: 5px;
            transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Models List */
        .models-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .model-row {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 18px 24px;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .model-row:hover {
            border-color: var(--accent);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }

        .model-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 14px;
        }

        .model-title {
            font-size: 16px;
            font-weight: 600;
        }

        .model-reset {
            font-size: 13px;
            color: var(--text-dim);
        }

        .pin-btn { 
            cursor: pointer; 
            transition: all 0.2s; 
            font-size: 16px; 
            user-select: none; 
            display: flex; 
            align-items: center; 
            justify-content: center;
            width: 24px;
            height: 24px;
            border-radius: 4px;
        }
        .pin-btn:hover { background: var(--bg-hover); transform: scale(1.1); }
        
        /* Pinned State (Active) */
        .pin-btn.pinned { 
            opacity: 1; 
            color: var(--accent);
            text-shadow: 0 0 10px rgba(47, 129, 247, 0.4); 
        }
        
        /* Unpinned State (Inactive/Add) */
        .pin-btn.unpinned { 
            opacity: 0.3; 
            filter: grayscale(100%);
        }
        .pin-btn.unpinned:hover {
            opacity: 1;
            color: var(--text-main);
            filter: grayscale(0%);
        }
        
        .model-row.pinned-row { border-color: rgba(47, 129, 247, 0.4); background: rgba(47, 129, 247, 0.03); }

        .model-stats-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
        }

        .quota-container {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-grow: 1;
            max-width: 400px;
        }

        .quota-label {
            font-size: 13px;
            color: var(--text-dim);
            white-space: nowrap;
        }

        .progress-bar-wrapper {
            height: 8px;
            background: var(--border);
            border-radius: 4px;
            flex-grow: 1;
            overflow: hidden;
        }

        .progress-bar {
            height: 100%;
            border-radius: 4px;
        }

        .quota-value {
            font-size: 14px;
            font-weight: 700;
            min-width: 50px;
            text-align: right;
        }

        .usage-stats {
            font-size: 13px;
            color: var(--text-dim);
        }

        .usage-stats b {
            color: var(--text-main);
        }

        .cycle-info {
            margin-top: 14px;
            padding-top: 12px;
            border-top: 1px solid var(--border);
            font-size: 12px;
            color: var(--text-dim);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        /* Styled Cycle Progress Bar */
        .cycle-bar-wrapper {
            height: 6px;
            width: 80px;
            background: var(--border);
            border-radius: 3px;
            overflow: hidden;
            display: inline-block;
        }

        .cycle-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--accent), #58a6ff);
            border-radius: 3px;
            transition: width 0.3s ease;
        }

        /* Features */
        .features-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 12px;
        }

        .feature-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 14px 18px;
        }

        .feature-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .feature-name {
            font-weight: 500;
        }

        .feature-badge {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .feature-card.enabled {
            border-left: 4px solid var(--success);
        }
        .feature-card.enabled .feature-badge {
            background: rgba(35, 134, 54, 0.15);
            color: #3fb950;
        }

        .feature-card.disabled .feature-badge {
            background: rgba(218, 54, 51, 0.15);
            color: #f85149;
        }

        .chart-container {
            height: 48px;
            width: 100%;
            margin-top: 12px;
            border-top: 1px dashed var(--border);
            padding-top: 8px;
            opacity: 0.8;
            transition: opacity 0.2s;
        }
        .chart-container:hover {
            opacity: 1;
        }
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="header">
            <h1>${l.t('Account Information')}</h1>
            <div class="header-btns">
                <button class="btn" onclick="postCommand('openPatreon')" title="${l.t('Support on Patreon')}" style="padding: 6px 10px;">🧡</button>
                <button class="btn" onclick="postCommand('openCoffee')" title="${l.t('Buy Me a Coffee')}" style="padding: 6px 10px;">☕</button>
                <div style="width: 1px; height: 24px; background: var(--border); margin: 0 4px;"></div>
                <button class="btn" onclick="openPlan()">${l.t('Upgrade Plan')}</button>
                <button class="btn" onclick="viewRawJson()">${l.t('View Raw JSON')}</button>
            </div>
        </div>


        <div class="section-title">
            <span>${l.t('Google Drive Sync Accounts')}</span>
            <span class="action-link" onclick="postCommand('addAccount')">+ ${l.t('Add Drive Account')}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 8px; margin-top: -12px;">
            ${l.t('Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.')}
        </div>
        <div class="accounts-container">
            ${accountsHtml}
            
            ${snapshot.syncStats ? `
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; gap: 24px; font-size: 12px; color: var(--text-dim);">
                <div>
                     <span style="font-weight: 600; color: var(--text-main);">${(snapshot.syncStats.totalSize / 1024 / 1024).toFixed(2)} MB</span> 
                     ${l.t('Used')}
                </div>
                <div>
                     <span style="font-weight: 600; color: var(--text-main);">${snapshot.syncStats.conversationCount}</span> 
                     ${l.t('Conversations')}
                </div>
                ${snapshot.syncStats.lastModified ? `
                <div style="margin-left: auto;">
                     ${l.t('Last Update')}: <span style="font-weight: 600; color: var(--text-main);">${new Date(snapshot.syncStats.lastModified).toLocaleString()}</span>
                </div>` : ''}
            </div>` : ''}
        </div>


        <div class="section-title">${l.t('Profile')}</div>
        <div class="profile-container">
            <div class="profile-box">
                <span class="p-label">${l.t('Name')}</span>
                <span class="p-value">${snapshot.rawUserStatus?.name || 'alex turk'}</span>
            </div>
            <div class="profile-box">
                <span class="p-label">${l.t('Email')}</span>
                <span class="p-value">${snapshot.userEmail || snapshot.rawUserStatus?.email || 'N/A'}</span>
            </div>
            <div class="profile-box">
                <span class="p-label">${l.t('Plan')}</span>
                <div><span class="plan-tag">${userTier?.name || 'Free'}</span></div>
            </div>
            <div class="profile-box">
                <span class="p-label">${l.t('Tier')}</span>
                <span class="p-value">${userTier?.description || 'Free'}</span>
            </div>
        </div>

        ${vscode.workspace.getConfiguration('antigravity-storage-manager').get('showCreditsBalance', false) ? `
        <div class="section-title">${l.t('Credits Balance')}</div>
        <div class="credits-card">
            <div class="credit-row">
                <div class="cred-info">
                    <span class="cred-title">${l.t('Prompt Credits')}</span>
                    <span class="cred-val">${promptCredits?.available?.toLocaleString() || '0'} / ${promptCredits?.monthly?.toLocaleString() || '0'}</span>
                </div>
                <div class="bar-outer">
                    <div class="bar-inner" style="width: ${promptPercent}%; background: ${getProgressBarColor(promptPercent, false)};"></div>
                </div>
            </div>
        </div>
        ` : ''}

        <div class="section-title">${l.t('Model Quotas')}</div>
        <div class="models-list">
            ${modelsHtml}
        </div>

        <div class="section-title">${l.t('Features')}</div>
        <div class="features-grid">
            ${featuresHtml}
        </div>

        <div style="margin-top: 48px; text-align: center; color: var(--text-dim); font-size: 12px; border-top: 1px solid var(--border); padding-top: 24px;">
            ${l.t('Last updated: {0}', formatResetTime(new Date(snapshot.timestamp)))}
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function postCommand(command, data = {}) {
            vscode.postMessage({ command, ...data });
        }
        function viewRawJson() { vscode.postMessage({ command: 'viewRawJson' }); }
        function openPlan() { vscode.postMessage({ command: 'openPlan' }); }
    </script>
</body>
</html>`;
    }
}
