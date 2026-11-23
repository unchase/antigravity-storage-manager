import * as vscode from 'vscode';
import { LocalizationManager } from '../l10n/localizationManager';
import { QuotaSnapshot, ModelQuotaInfo } from './types';
import { formatResetTime, formatDuration, getCycleDuration, isHighTierModel, isGeminiModel, compareModels } from './utils';
import { QuotaUsageTracker } from './quotaUsageTracker';
import { StoredAccount } from '../googleAuth';

export class AccountInfoWebview {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static latestSnapshot: QuotaSnapshot | undefined;
    private static latestTracker: QuotaUsageTracker | undefined;
    private static latestAccounts: StoredAccount[] = [];
    private static latestCurrentAccountId: string | null = null;
    private static expandedGroups: Set<string> = new Set();
    private static onRefreshCallback: (() => Promise<void>) | undefined;
    private static readonly viewType = 'accountInfo';

    public static show(
        context: vscode.ExtensionContext,
        snapshot: QuotaSnapshot,
        tracker?: QuotaUsageTracker,
        accounts: StoredAccount[] = [],
        currentAccountId: string | null = null,
        onRefresh?: () => Promise<void>
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        AccountInfoWebview.latestSnapshot = snapshot;
        if (tracker) AccountInfoWebview.latestTracker = tracker;
        AccountInfoWebview.latestAccounts = accounts;
        AccountInfoWebview.latestCurrentAccountId = currentAccountId;
        if (onRefresh) AccountInfoWebview.onRefreshCallback = onRefresh;

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
                    case 'openPlan': {
                        const rawStatus = AccountInfoWebview.latestSnapshot?.rawUserStatus;
                        const tierUri = rawStatus?.userStatus?.userTier?.upgradeSubscriptionUri || rawStatus?.userTier?.upgradeSubscriptionUri;
                        const targetUrl = typeof tierUri === 'string' && /^https?:\/\//i.test(tierUri)
                            ? tierUri
                            : 'https://one.google.com/ai';
                        vscode.env.openExternal(vscode.Uri.parse(targetUrl));
                        return;
                    }
                    case 'refresh': {
                        if (AccountInfoWebview.onRefreshCallback) {
                            AccountInfoWebview.onRefreshCallback().catch(err => {
                                console.error('AccountInfoWebview refresh failed:', err);
                            });
                        }
                        return;
                    }
                    case 'openSyncStats':
                        vscode.commands.executeCommand('antigravity-storage-manager.showSyncStats');
                        return;
                    case 'switchProfile':
                        vscode.commands.executeCommand('antigravity-storage-manager.switchProfile');
                        return;
                    case 'copyText': {
                        if (typeof message.text === 'string' && message.text.length > 0) {
                            vscode.env.clipboard.writeText(message.text);
                            vscode.window.showInformationMessage(lm.t('Copied to clipboard: {0}', message.text));
                        }
                        return;
                    }
                    case 'setAllGroups': {
                        if (Array.isArray(message.groupIds)) {
                            if (message.expanded) {
                                for (const id of message.groupIds) {
                                    if (typeof id === 'string') AccountInfoWebview.expandedGroups.add(id);
                                }
                            } else {
                                AccountInfoWebview.expandedGroups.clear();
                            }
                        }
                        return;
                    }
                    case 'openPatreon':
                        vscode.env.openExternal(vscode.Uri.parse('https://www.patreon.com/unchase'));
                        return;
                    case 'openCoffee':
                        vscode.env.openExternal(vscode.Uri.parse('https://www.buymeacoffee.com/nikolaychebotov'));
                        return;
                    case 'openRepo':
                        vscode.env.openExternal(vscode.Uri.parse('https://github.com/unchase/antigravity-storage-manager'));
                        return;
                    case 'togglePin': {
                        const modelId = message.modelId;
                        const modelLabel = message.modelLabel;
                        const config = vscode.workspace.getConfiguration('antigravity-storage-manager');
                        const pinned = [...(config.get<string[]>('quota.pinnedModels') || [])];
                        const idIdx = typeof modelId === 'string' ? pinned.indexOf(modelId) : -1;
                        const labelIdx = typeof modelLabel === 'string' ? pinned.indexOf(modelLabel) : -1;
                        if (idIdx >= 0 || labelIdx >= 0) {
                            const updated = pinned.filter(p => p !== modelId && p !== modelLabel);
                            config.update('quota.pinnedModels', updated, vscode.ConfigurationTarget.Global);
                        } else if (modelLabel || modelId) {
                            pinned.push(modelLabel || modelId);
                            config.update('quota.pinnedModels', pinned, vscode.ConfigurationTarget.Global);
                        }
                        return;
                    }
                    case 'toggleGroup': {
                        const groupId = message.groupId;
                        if (typeof groupId === 'string') {
                            if (message.expanded) {
                                AccountInfoWebview.expandedGroups.add(groupId);
                            } else {
                                AccountInfoWebview.expandedGroups.delete(groupId);
                            }
                        }
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
                AccountInfoWebview.expandedGroups.clear();
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
        const config = vscode.workspace.getConfiguration('antigravity-storage-manager'); // Moved up
        const data = snapshot.rawUserStatus?.userStatus || snapshot.rawUserStatus || {};
        const planInfo = data.planStatus?.planInfo;
        const userTier = data.userTier;

        // Proxy info
        const proxyUrl = config.get<string>('proxy.url');
        const proxyDisplay = proxyUrl ? proxyUrl : l.t('None');
        const proxyLabel = l.t('Proxy');

        const escapeAttr = (str: string): string =>
            str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const escapeJs = (str: string): string =>
            str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
        const escapeJsAttr = (str: string): string =>
            escapeAttr(escapeJs(str));

        // Accounts HTML
        const accountsHtml = AccountInfoWebview.latestAccounts.map(acc => {
            const isActive = acc.id === AccountInfoWebview.latestCurrentAccountId;
            const activeBadge = isActive ? `<span class="account-badge active">${escapeAttr(l.t('Active'))}</span>` : '';
            const actions = isActive
                ? ''
                : `<button class="icon-btn switch-btn" onclick="postCommand('switchAccount', {accountId: '${escapeJsAttr(acc.id)}'})" title="${escapeAttr(l.t('Switch to {0}', acc.email))}">🔄</button>
                   <button class="icon-btn remove-btn" onclick="postCommand('removeAccount', {accountId: '${escapeJsAttr(acc.id)}', email: '${escapeJsAttr(acc.email)}'})" title="${escapeAttr(l.t('Remove Account'))}">🗑️</button>`;

            return `
            <div class="account-row ${isActive ? 'active-row' : ''}">
                <div class="account-info">
                    <div class="account-name">${escapeAttr(acc.name)} ${activeBadge}</div>
                    <div class="account-email">${escapeAttr(acc.email)}</div>
                </div>
                <div class="account-actions">
                    ${actions}
                </div>
            </div>`;
        }).join('');

        // Credits calculations
        const promptCredits = snapshot.promptCredits;
        const promptPercent = promptCredits?.remainingPercentage ?? 0;

        let flowCredits = snapshot.flowCredits;
        if (!flowCredits && data.planStatus) {
            const mFlow = Number(planInfo?.monthlyFlowCredits);
            const aFlow = Number(data.planStatus?.availableFlowCredits);
            if (!isNaN(mFlow) && mFlow > 0 && !isNaN(aFlow)) {
                flowCredits = {
                    available: aFlow,
                    monthly: mFlow,
                    usedPercentage: ((mFlow - aFlow) / mFlow) * 100,
                    remainingPercentage: (aFlow / mFlow) * 100
                };
            }
        }
        const flowPercent = flowCredits?.remainingPercentage ?? 0;
        const flexPurchaseAmount = planInfo?.monthlyFlexCreditPurchaseAmount !== undefined
            ? Number(planInfo.monthlyFlexCreditPurchaseAmount)
            : undefined;
        const canBuyMoreCredits = Boolean(planInfo?.canBuyMoreCredits);

        // Model quotas grouped identically to Antigravity Quota Usage QuickPick (collapsed by default)
        const pinnedIds = config.get<string[]>('quota.pinnedModels') || [];
        const allModels = [...(snapshot.models || [])];

        // Profile extras from rawUserStatus
        const rawAvatar = typeof data.profilePictureUrl === 'string' && data.profilePictureUrl.startsWith('data:image/')
            ? data.profilePictureUrl
            : undefined;
        const displayName = data.name || 'N/A';
        const displayEmail = snapshot.userEmail || data.email || 'N/A';
        const defaultModelRef: string | undefined = data.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model;
        const defaultModelMatch = defaultModelRef
            ? allModels.find(m => m.modelId === defaultModelRef || m.canonicalModelId === defaultModelRef)
            : undefined;
        const defaultModelLabel = defaultModelMatch?.label || defaultModelRef;
        const telemetryDisabled = typeof data.disableTelemetry === 'boolean' ? data.disableTelemetry : undefined;
        const upgradeSubText: string | undefined = typeof userTier?.upgradeSubscriptionText === 'string' && userTier.upgradeSubscriptionText.trim()
            ? userTier.upgradeSubscriptionText.trim()
            : undefined;

        const modelGroups: Array<{ id: string; name: string; models: ModelQuotaInfo[] }> = [
            { id: 'claude-gpt', name: 'Claude & GPT-OSS', models: [] },
            { id: 'gemini', name: 'Gemini', models: [] }
        ];

        for (const m of allModels) {
            if (isGeminiModel(m.label, m.modelId)) {
                modelGroups[1].models.push(m);
            } else {
                modelGroups[0].models.push(m);
            }
        }

        const activeGroups = modelGroups.filter(g => g.models.length > 0);
        for (const g of activeGroups) {
            g.models.sort((a, b) => {
                if (Boolean(a.isDisabled) !== Boolean(b.isDisabled)) {
                    return a.isDisabled ? 1 : -1;
                }
                const aPinned = pinnedIds.includes(a.modelId) || pinnedIds.includes(a.label);
                const bPinned = pinnedIds.includes(b.modelId) || pinnedIds.includes(b.label);
                if (aPinned && !bPinned) return -1;
                if (!aPinned && bPinned) return 1;
                return compareModels(a, b, 'quota');
            });
        }
        activeGroups.sort((a, b) => compareModels(a.models[0], b.models[0], 'quota'));

        // Deprecation / Notice banner items (deduplicated by tagDescription)
        const noticeMap = new Map<string, { tagTitle: string; description: string; models: string[]; hasPinned: boolean }>();
        for (const m of allModels) {
            if (m.tagTitle && /leaving|notice|deprecated/i.test(m.tagTitle) && m.tagDescription) {
                const key = `${m.tagTitle}::${m.tagDescription}`;
                const baseName = m.label.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)$/i, '');
                const isPinnedModel = pinnedIds.includes(m.modelId) || pinnedIds.includes(m.label);
                const existing = noticeMap.get(key);
                if (existing) {
                    if (!existing.models.includes(baseName)) existing.models.push(baseName);
                    if (isPinnedModel) existing.hasPinned = true;
                } else {
                    noticeMap.set(key, {
                        tagTitle: m.tagTitle,
                        description: m.tagDescription,
                        models: [baseName],
                        hasPinned: isPinnedModel
                    });
                }
            }
        }
        const noticesHtml = noticeMap.size > 0
            ? `<div class="notices-banner">
                <div class="notices-banner-title">⚠️ ${l.t('Model Deprecation Notices')}</div>
                ${Array.from(noticeMap.values()).map(n => `
                    <div class="notice-item">
                        <span class="model-tag notice">${escapeAttr(n.tagTitle)}</span>
                        <span class="notice-models">${n.hasPinned ? '📌 ' : ''}${escapeAttr(n.models.join(', '))}:</span>
                        <span class="notice-desc">${escapeAttr(n.description)}</span>
                    </div>
                `).join('')}
            </div>`
            : '';

        // Plan Limits
        const formatLimitVal = (raw: any, suffix: string = ''): string | null => {
            if (raw === undefined || raw === null || raw === '') return null;
            const num = Number(raw);
            if (isNaN(num)) return String(raw);
            if (num < 0) return l.t('Unlimited');
            return `${num.toLocaleString()}${suffix ? ' ' + suffix : ''}`;
        };
        const planLimits = [
            { label: l.t('Max Chat Input Tokens'), value: formatLimitVal(planInfo?.maxNumChatInputTokens) },
            { label: l.t('Custom Instructions'), value: formatLimitVal(planInfo?.maxCustomChatInstructionCharacters, l.t('chars')) },
            { label: l.t('Premium Messages'), value: formatLimitVal(planInfo?.maxNumPremiumChatMessages) },
            { label: l.t('Pinned Context Items'), value: formatLimitVal(planInfo?.maxNumPinnedContextItems) }
        ].filter(item => item.value !== null);

        const planLimitsHtml = planLimits.length > 0
            ? `<div class="section-title">${l.t('Plan Limits')}</div>
               <div class="limits-grid">
                   ${planLimits.map(item => `
                       <div class="limit-card">
                           <span class="p-label">${item.label}</span>
                           <span class="limit-value">${item.value}</span>
                       </div>
                   `).join('')}
               </div>`
            : '';

        // Features
        const featuresList = [
            { id: 'webSearch', name: l.t('Web Search'), enabled: planInfo?.cascadeWebSearchEnabled },
            { id: 'browser', name: l.t('Browser Tool'), enabled: planInfo?.browserEnabled },
            { id: 'expBrowser', name: l.t('Experimental Browser'), enabled: planInfo?.defaultTeamConfig?.allowBrowserExperimentalFeatures },
            { id: 'kb', name: l.t('Knowledge Base'), enabled: planInfo?.knowledgeBaseEnabled },
            { id: 'autorun', name: l.t('Auto-run Commands'), enabled: planInfo?.cascadeCanAutoRunCommands },
            { id: 'commit', name: l.t('Generate Commit Messages'), enabled: planInfo?.canGenerateCommitMessages },
            { id: 'mcp', name: l.t('MCP Servers'), enabled: planInfo?.defaultTeamConfig?.allowMcpServers },
            { id: 'fastAutocomplete', name: l.t('Fast Autocomplete'), enabled: planInfo?.hasAutocompleteFastMode },
            { id: 'tabToJump', name: l.t('Tab to Jump'), enabled: planInfo?.hasTabToJump },
            { id: 'backgroundAgents', name: l.t('Background Agents'), enabled: planInfo?.canAllowCascadeInBackground },
        ];

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

        const renderModelRow = (model: ModelQuotaInfo): string => {
            const pct = model.remainingPercentage ?? 0;
            const statusIcon = getStatusIcon(pct, model.isExhausted);
            const color = getProgressBarColor(pct, model.isExhausted);
            const resetTimeStr = formatResetTime(model.resetTime);

            let cycleInfo = '';
            const isHighTier = isHighTierModel(model.label);
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

            const isDisabled = Boolean(model.isDisabled);
            const isPinned = !isDisabled && (pinnedIds.includes(model.modelId) || pinnedIds.includes(model.label));
            const tooltipText = isDisabled
                ? (model.disabledReason || model.tagDescription || l.t('This model is currently unavailable.'))
                : model.tagDescription;

            const badgeLabel = isDisabled ? l.t('Unavailable') : model.tagTitle;
            const badgeClass = isDisabled
                ? 'unavailable'
                : (model.tagTitle && /leaving|notice|deprecated/i.test(model.tagTitle) ? 'notice' : 'new');
            const badgeHtml = badgeLabel
                ? `<span class="model-tag ${badgeClass}" ${tooltipText ? `data-tooltip="${escapeAttr(tooltipText)}" title="${escapeAttr(tooltipText)}"` : ''}>${escapeAttr(badgeLabel)}${tooltipText ? ' <span class="tag-info-icon">ⓘ</span>' : ''}</span>`
                : (tooltipText ? `<span class="model-tag notice" data-tooltip="${escapeAttr(tooltipText)}" title="${escapeAttr(tooltipText)}"><span class="tag-info-icon">ⓘ</span></span>` : '');

            const pinHtml = isDisabled
                ? `<div class="pin-btn disabled-pin" aria-disabled="true" title="${escapeAttr(tooltipText || l.t('Unavailable'))}">🔒</div>`
                : (isPinned
                    ? `<div class="pin-btn pinned" onclick="postCommand('togglePin', {modelId: '${escapeJsAttr(model.modelId)}', modelLabel: '${escapeJsAttr(model.label)}'})" title="${escapeAttr(l.t('Unpin'))}">📌</div>`
                    : `<div class="pin-btn unpinned" onclick="postCommand('togglePin', {modelId: '${escapeJsAttr(model.modelId)}', modelLabel: '${escapeJsAttr(model.label)}'})" title="${escapeAttr(l.t('Pin'))}">📍</div>`);

            const capIcons: string[] = [];
            if (model.capabilities?.images) capIcons.push(`<span class="cap-icon" title="${escapeAttr(l.t('Images'))}">🖼️</span>`);
            if (model.capabilities?.documents) capIcons.push(`<span class="cap-icon" title="${escapeAttr(l.t('Documents'))}">📄</span>`);
            if (model.capabilities?.audio) capIcons.push(`<span class="cap-icon" title="${escapeAttr(l.t('Audio'))}">🎵</span>`);
            if (model.capabilities?.video) capIcons.push(`<span class="cap-icon" title="${escapeAttr(l.t('Video'))}">🎬</span>`);
            const capsHtml = capIcons.length > 0 ? `<span class="model-caps">${capIcons.join('')}</span>` : '';

            const copyIdValue = model.canonicalModelId || model.modelId;
            const modelIdChipHtml = copyIdValue
                ? `<span class="copy-chip" onclick="event.stopPropagation(); copyText('${escapeJsAttr(copyIdValue)}')" title="${escapeAttr(l.t('Click to copy'))}">${escapeAttr(copyIdValue)} 📋</span>`
                : '';

            return `
                <div class="model-row ${isPinned ? 'pinned-row' : ''} ${isDisabled ? 'disabled-row' : ''}" data-label="${escapeAttr((model.label + ' ' + copyIdValue).toLowerCase())}" data-pinned="${isPinned ? 'true' : 'false'}" ${isDisabled && tooltipText ? `title="${escapeAttr(tooltipText)}"` : ''}>
                    <div class="model-header">
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                             ${pinHtml}
                             <span class="model-title">${isDisabled ? '🚫' : statusIcon} ${escapeAttr(model.label)}</span>
                             ${badgeHtml}
                             ${capsHtml}
                             ${modelIdChipHtml}
                        </div>
                        <span class="model-reset">${isDisabled ? escapeAttr(l.t('Unavailable')) : escapeAttr(resetTimeStr)}</span>
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

                    const safeGradId = model.modelId.replace(/[^a-zA-Z0-9_-]/g, '_');

                    return `
                        <div class="chart-container" title="${escapeAttr(l.t('Usage History'))}">
                             <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
                                <defs>
                                    <linearGradient id="grad-${safeGradId}" x1="0%" y1="0%" x2="0%" y2="100%">
                                        <stop offset="0%" style="stop-color:${color};stop-opacity:0.3" />
                                        <stop offset="100%" style="stop-color:${color};stop-opacity:0" />
                                    </linearGradient>
                                </defs>
                                <path d="${points}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" />
                                <polygon points="${areaPath}" fill="url(#grad-${safeGradId})" />
                             </svg>
                        </div>`;
                })()}
                </div>
            `;
        };

        const modelsHtml = activeGroups.map(group => {
            const isExpanded = AccountInfoWebview.expandedGroups.has(group.id);
            const availableModels = group.models.filter(m => !m.isDisabled);
            const effectiveModels = availableModels.length > 0 ? availableModels : group.models;

            const groupPct = Math.min(...effectiveModels.map(m => m.remainingPercentage ?? 0));
            const groupExhausted = effectiveModels.every(m => m.isExhausted) || groupPct === 0;
            const groupStatusIcon = getStatusIcon(groupPct, groupExhausted);
            const groupColor = getProgressBarColor(groupPct, groupExhausted);

            const primaryModel = effectiveModels.find(m => m.timeUntilReset > 0) || effectiveModels[0];
            const primaryResetDate = primaryModel?.resetTime ? new Date(primaryModel.resetTime) : null;
            const groupResetStr = primaryResetDate && !isNaN(primaryResetDate.getTime()) && primaryResetDate.getTime() > 0
                ? formatResetTime(primaryResetDate)
                : '';

            const pinnedCount = group.models.filter(m => !m.isDisabled && (pinnedIds.includes(m.modelId) || pinnedIds.includes(m.label))).length;
            const highTierModel = effectiveModels.find(m => isHighTierModel(m.label) && m.timeUntilReset > 0);
            let groupCycleInfo = '';
            if (highTierModel) {
                const cycleDuration = getCycleDuration(highTierModel.label);
                const progress = Math.max(0, Math.min(1, 1 - (highTierModel.timeUntilReset / cycleDuration)));
                const progressPct = (progress * 100).toFixed(1);
                groupCycleInfo = `<div class="group-cycle-info">${l.t('Cycle')}: <div class="cycle-bar-wrapper"><div class="cycle-bar" style="width: ${progressPct}%;"></div></div> <span class="time">(${formatDuration(highTierModel.timeUntilReset)} ${l.t('left')})</span></div>`;
            }

            const innerRowsHtml = group.models.map(renderModelRow).join('');

            return `
                <div class="model-group ${isExpanded ? 'expanded' : ''}" id="group-${group.id}" data-user-expanded="${isExpanded ? 'true' : 'false'}">
                    <div class="model-group-header" onclick="toggleModelGroup('${group.id}')">
                        <div class="model-group-top">
                            <div class="model-group-title-wrap">
                                <span class="group-chevron">${isExpanded ? '▼' : '▶'}</span>
                                <span class="model-group-title">${groupStatusIcon} ${escapeAttr(group.name)}</span>
                                <span class="group-count-badge">${escapeAttr(l.t('{0} model(s)', group.models.length))}</span>
                                ${pinnedCount > 0 ? `<span class="group-pin-badge" title="${escapeAttr(l.t('Pinned Models Quota'))}">📌 ${pinnedCount}</span>` : ''}
                            </div>
                            ${groupResetStr ? `<span class="model-reset">${escapeAttr(groupResetStr)}</span>` : ''}
                        </div>
                        <div class="model-group-summary">
                            <div class="quota-container">
                                <span class="quota-label">${l.t('Quota Left')}:</span>
                                <div class="progress-bar-wrapper">
                                    <div class="progress-bar" style="width: ${groupPct}%; background: ${groupColor};"></div>
                                </div>
                                <span class="quota-value" style="color: ${groupColor};">${groupPct.toFixed(1)}%</span>
                            </div>
                            ${groupCycleInfo}
                        </div>
                    </div>
                    <div class="model-group-body">
                        ${innerRowsHtml}
                    </div>
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
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px 24px;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px;
        }

        .profile-box {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
        }

        .p-label {
            font-size: 12px;
            color: var(--text-dim);
        }

        .p-value {
            font-size: 16px;
            font-weight: 600;
            overflow-wrap: anywhere;
            word-break: break-word;
        }

        .plan-tag {
            background: var(--accent);
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 14px;
            display: inline-block;
            white-space: nowrap;
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

        /* Models List & Collapsible Groups */
        .models-list {
            display: flex;
            flex-direction: column;
            gap: 14px;
        }

        .model-group {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            transition: border-color 0.2s;
        }

        .model-group:hover {
            border-color: rgba(47, 129, 247, 0.5);
        }

        .model-group-header {
            padding: 18px 24px;
            border-radius: 12px;
            cursor: pointer;
            user-select: none;
            transition: background 0.15s;
        }

        .model-group.expanded .model-group-header {
            border-radius: 12px 12px 0 0;
        }

        .model-group-header:hover {
            background: rgba(255, 255, 255, 0.02);
        }

        .model-group-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
        }

        .model-group-title-wrap {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
        }

        .group-chevron {
            display: inline-block;
            width: 14px;
            font-size: 11px;
            color: var(--text-dim);
            transition: transform 0.2s;
        }

        .model-group-title {
            font-size: 16px;
            font-weight: 600;
            color: var(--text-main);
        }

        .group-count-badge {
            font-size: 11px;
            font-weight: 500;
            color: var(--text-dim);
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--border);
            padding: 2px 8px;
            border-radius: 999px;
        }

        .group-pin-badge {
            font-size: 11px;
            font-weight: 600;
            color: #79c0ff;
            background: rgba(47, 129, 247, 0.14);
            border: 1px solid rgba(47, 129, 247, 0.35);
            padding: 2px 8px;
            border-radius: 999px;
        }

        .model-group-summary {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
            padding-left: 24px;
        }

        .group-cycle-info {
            font-size: 12px;
            color: var(--text-dim);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .model-group-body {
            display: none;
            flex-direction: column;
            gap: 10px;
            padding: 14px 16px 16px 16px;
            border-top: 1px solid var(--border);
            border-radius: 0 0 12px 12px;
            background: rgba(0, 0, 0, 0.18);
        }

        .model-group.expanded .model-group-body {
            display: flex;
        }

        .model-row {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 16px 20px;
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
        .model-row.disabled-row { opacity: 0.55; filter: grayscale(45%); cursor: not-allowed; }
        .model-row.disabled-row:hover { border-color: var(--border); box-shadow: none; }
        .pin-btn.disabled-pin { opacity: 0.45; cursor: not-allowed; }
        .pin-btn.disabled-pin:hover { background: transparent; transform: none; }

        .model-tag {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 11px;
            font-weight: 500;
            padding: 2px 8px;
            border-radius: 999px;
            border: 1px solid var(--border);
            background: rgba(255, 255, 255, 0.06);
            color: var(--text-dim);
            cursor: default;
        }
        .model-tag.new {
            background: rgba(47, 129, 247, 0.14);
            border-color: rgba(47, 129, 247, 0.35);
            color: #79c0ff;
        }
        .model-tag.notice {
            background: rgba(210, 153, 34, 0.14);
            border-color: rgba(210, 153, 34, 0.35);
            color: #e3b341;
        }
        .model-tag.unavailable {
            background: rgba(218, 54, 51, 0.14);
            border-color: rgba(218, 54, 51, 0.35);
            color: #f85149;
        }
        .tag-info-icon { font-size: 11px; opacity: 0.85; }
        .model-tag[data-tooltip]:hover::after {
            content: attr(data-tooltip);
            position: absolute;
            left: 50%;
            bottom: calc(100% + 8px);
            transform: translateX(-50%);
            background: #1c2128;
            color: var(--text-main);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 400;
            line-height: 1.4;
            width: max-content;
            max-width: 280px;
            white-space: normal;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
            z-index: 100;
            pointer-events: none;
        }

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

        /* Avatar & Profile Extras */
        .profile-identity {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .profile-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            object-fit: cover;
            border: 1px solid var(--border);
            flex-shrink: 0;
        }
        .copyable-value {
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: color 0.15s;
        }
        .copyable-value:hover {
            color: #79c0ff;
        }
        .copy-icon-hint {
            font-size: 12px;
            opacity: 0.55;
        }
        .copyable-value:hover .copy-icon-hint {
            opacity: 1;
        }
        .upgrade-hint {
            font-size: 11px;
            color: var(--text-dim);
            margin-top: 4px;
            line-height: 1.35;
        }
        .telemetry-badge {
            display: inline-block;
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 999px;
            width: fit-content;
        }
        .telemetry-badge.off {
            background: rgba(35, 134, 54, 0.15);
            color: #3fb950;
        }
        .telemetry-badge.on {
            background: rgba(210, 153, 34, 0.15);
            color: #e3b341;
        }

        /* Model Quotas Toolbar */
        .quotas-toolbar {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .search-input {
            background: var(--bg-card);
            border: 1px solid var(--border);
            color: var(--text-main);
            border-radius: 6px;
            padding: 5px 10px;
            font-size: 12px;
            outline: none;
            min-width: 170px;
        }
        .search-input:focus {
            border-color: var(--accent);
        }
        .toolbar-btn {
            background: var(--bg-card);
            border: 1px solid var(--border);
            color: var(--text-dim);
            border-radius: 6px;
            padding: 5px 10px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .toolbar-btn:hover {
            color: var(--text-main);
            border-color: var(--text-dim);
            background: var(--bg-hover);
        }
        .toolbar-btn.active {
            color: #79c0ff;
            border-color: rgba(47, 129, 247, 0.5);
            background: rgba(47, 129, 247, 0.14);
        }

        /* Deprecation Notices Banner */
        .notices-banner {
            background: rgba(210, 153, 34, 0.08);
            border: 1px solid rgba(210, 153, 34, 0.35);
            border-radius: 10px;
            padding: 12px 16px;
            margin-bottom: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .notices-banner-title {
            font-size: 12px;
            font-weight: 600;
            color: #e3b341;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }
        .notice-item {
            display: flex;
            align-items: baseline;
            flex-wrap: wrap;
            gap: 6px;
            font-size: 12px;
            line-height: 1.4;
        }
        .notice-models {
            font-weight: 600;
            color: var(--text-main);
        }
        .notice-desc {
            color: var(--text-dim);
        }

        /* Capabilities & Copyable Model ID */
        .model-caps {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            opacity: 0.85;
        }
        .cap-icon {
            cursor: default;
        }
        .copy-chip {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 10px;
            color: var(--text-dim);
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 1px 6px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .copy-chip:hover {
            color: var(--text-main);
            border-color: var(--accent);
            background: rgba(47, 129, 247, 0.12);
        }

        /* Plan Limits Grid */
        .limits-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
            gap: 12px;
        }
        .limit-card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 14px 18px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .limit-value {
            font-size: 16px;
            font-weight: 600;
            color: var(--text-main);
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
                <button class="btn" onclick="postCommand('openRepo')" title="${l.t('Star on GitHub')}" style="padding: 6px 10px;">⭐</button>
                <div style="width: 1px; height: 24px; background: var(--border); margin: 0 4px;"></div>
                <button class="btn" onclick="postCommand('refresh')" title="${l.t('Refresh')}" style="padding: 6px 10px;">🔄</button>
                <button class="btn" onclick="postCommand('openSyncStats')" title="${l.t('Show Statistics')}" style="padding: 6px 10px;">📊</button>
                <button class="btn" onclick="postCommand('switchProfile')">👤 ${l.t('Switch Profile')}</button>
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
                     ${l.t('Last Update')}: <span style="font-weight: 600; color: var(--text-main);">${l.formatDateTime(snapshot.syncStats.lastModified)}</span>
                </div>` : ''}
            </div>` : ''}
        </div>


        <div class="section-title">
            <span>${l.t('Profile')}</span>
            <span class="action-link" onclick="postCommand('switchProfile')">🔄 ${l.t('Switch Profile')}</span>
        </div>
        <div class="profile-container">
            <div class="profile-box">
                <span class="p-label">${l.t('Name')}</span>
                <div class="profile-identity">
                    ${rawAvatar ? `<img class="profile-avatar" src="${escapeAttr(rawAvatar)}" alt="Avatar" />` : ''}
                    <span class="p-value">${escapeAttr(displayName)}</span>
                </div>
            </div>
            <div class="profile-box">
                <span class="p-label">${l.t('Email')}</span>
                ${displayEmail !== 'N/A'
                ? `<span class="p-value copyable-value" onclick="copyText('${escapeJsAttr(displayEmail)}')" title="${escapeAttr(l.t('Click to copy'))}">${escapeAttr(displayEmail)} <span class="copy-icon-hint">📋</span></span>`
                : `<span class="p-value">N/A</span>`}
            </div>
            <div class="profile-box">
                <span class="p-label">${l.t('Plan')}</span>
                <div><span class="plan-tag">${escapeAttr(userTier?.name || 'Free')}</span></div>
                ${upgradeSubText ? `<div class="upgrade-hint">${escapeAttr(upgradeSubText)}</div>` : ''}
            </div>
            <div class="profile-box">
                <span class="p-label">${l.t('Tier')}</span>
                <span class="p-value">${escapeAttr(userTier?.description || 'Free')}</span>
            </div>
            ${defaultModelLabel ? `
            <div class="profile-box">
                <span class="p-label">${l.t('Default Model')}</span>
                <span class="p-value">${escapeAttr(defaultModelLabel)}</span>
            </div>` : ''}
            ${telemetryDisabled !== undefined ? `
            <div class="profile-box">
                <span class="p-label">${l.t('Telemetry')}</span>
                <span class="telemetry-badge ${telemetryDisabled ? 'off' : 'on'}">${telemetryDisabled ? l.t('Disabled') : l.t('Enabled')}</span>
            </div>` : ''}
            <div class="profile-box">
                <span class="p-label">${proxyLabel}</span>
                <span class="p-value">${escapeAttr(proxyDisplay)}</span>
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
            ${flowCredits ? `
            <div class="credit-row">
                <div class="cred-info">
                    <span class="cred-title">${l.t('Flow Credits')}</span>
                    <span class="cred-val">${flowCredits.available.toLocaleString()} / ${flowCredits.monthly.toLocaleString()}</span>
                </div>
                <div class="bar-outer">
                    <div class="bar-inner" style="width: ${flowPercent}%; background: ${getProgressBarColor(flowPercent, false)};"></div>
                </div>
            </div>` : ''}
            ${flexPurchaseAmount && flexPurchaseAmount > 0 ? `
            <div class="credit-row" style="padding-top: 12px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
                <span class="cred-title">${l.t('Flex Credits')}</span>
                <span class="cred-val">+${flexPurchaseAmount.toLocaleString()}${canBuyMoreCredits ? ` • ${l.t('Available to purchase')}` : ''}</span>
            </div>` : ''}
        </div>
        ` : ''}

        <div class="section-title">
            <span>${l.t('Model Quotas')}</span>
            <div class="quotas-toolbar">
                <input id="model-search" class="search-input" type="text" placeholder="${escapeAttr(l.t('Search models...'))}" oninput="applyModelFilters()" />
                <button id="pinned-filter-btn" class="toolbar-btn" onclick="togglePinnedFilter()">📌 ${l.t('Pinned only')}</button>
                <button class="toolbar-btn" onclick="setAllModelGroups(true)">${l.t('Expand All')}</button>
                <button class="toolbar-btn" onclick="setAllModelGroups(false)">${l.t('Collapse All')}</button>
            </div>
        </div>
        ${noticesHtml}
        <div class="models-list">
            ${modelsHtml}
        </div>

        ${planLimitsHtml}

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
        let pinnedOnlyFilter = false;
        function postCommand(command, data = {}) {
            vscode.postMessage({ command, ...data });
        }
        function copyText(text) {
            postCommand('copyText', { text });
        }
        function toggleModelGroup(groupId) {
            const el = document.getElementById('group-' + groupId);
            if (!el) return;
            const expanded = el.classList.toggle('expanded');
            el.setAttribute('data-user-expanded', expanded ? 'true' : 'false');
            const chevron = el.querySelector('.group-chevron');
            if (chevron) chevron.textContent = expanded ? '▼' : '▶';
            postCommand('toggleGroup', { groupId, expanded });
        }
        function setAllModelGroups(expanded) {
            const groups = document.querySelectorAll('.model-group');
            const groupIds = [];
            groups.forEach(el => {
                const id = el.id.replace(/^group-/, '');
                groupIds.push(id);
                el.classList.toggle('expanded', expanded);
                el.setAttribute('data-user-expanded', expanded ? 'true' : 'false');
                const chevron = el.querySelector('.group-chevron');
                if (chevron) chevron.textContent = expanded ? '▼' : '▶';
            });
            postCommand('setAllGroups', { groupIds, expanded });
        }
        function togglePinnedFilter() {
            pinnedOnlyFilter = !pinnedOnlyFilter;
            const btn = document.getElementById('pinned-filter-btn');
            if (btn) btn.classList.toggle('active', pinnedOnlyFilter);
            applyModelFilters();
        }
        function applyModelFilters() {
            const input = document.getElementById('model-search');
            const query = (input ? input.value : '').trim().toLowerCase();
            const isFiltering = query.length > 0 || pinnedOnlyFilter;
            document.querySelectorAll('.model-group').forEach(groupEl => {
                let visibleCount = 0;
                groupEl.querySelectorAll('.model-row').forEach(rowEl => {
                    const label = rowEl.getAttribute('data-label') || '';
                    const isPinned = rowEl.getAttribute('data-pinned') === 'true';
                    const matchesQuery = !query || label.includes(query);
                    const matchesPin = !pinnedOnlyFilter || isPinned;
                    const visible = matchesQuery && matchesPin;
                    rowEl.style.display = visible ? '' : 'none';
                    if (visible) visibleCount++;
                });
                groupEl.style.display = visibleCount > 0 ? '' : 'none';
                const chevron = groupEl.querySelector('.group-chevron');
                if (isFiltering && visibleCount > 0) {
                    groupEl.classList.add('expanded');
                    if (chevron) chevron.textContent = '▼';
                } else if (!isFiltering) {
                    const userExpanded = groupEl.getAttribute('data-user-expanded') === 'true';
                    groupEl.classList.toggle('expanded', userExpanded);
                    if (chevron) chevron.textContent = userExpanded ? '▼' : '▶';
                }
            });
        }
        function viewRawJson() { vscode.postMessage({ command: 'viewRawJson' }); }
        function openPlan() { vscode.postMessage({ command: 'openPlan' }); }
    </script>
</body>
</html>`;
    }
}
