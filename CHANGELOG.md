# Changelog

All notable changes to the **Antigravity Storage Manager** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.14.4] - 2026-07-01
### Quota Monitoring
- **Rich Tooltip Restoration**: Fixed an issue where hovering over the `🚀 AGQ` status bar button did not display the rich quota report tooltip when no models were pinned. The tooltip now dynamically displays all active quotas under the generic "Quota" header when the pinned models list is empty.
- **Gemini Models Grouping**: Consolidated all Gemini models (including new `Gemini 3.5 Flash` and `Gemini 3.1 Pro` variants) into a single "Gemini" group in the Quota webview, QuickPick, and Statistics Dashboard to reflect their shared server quota.
- **Consolidated Quota Reports**: Grouped duplicate quota display blocks sharing identical resource limits (e.g. Gemini subgroups or Claude & GPT-OSS) into single consolidated blocks in both the rich tooltip and Telegram Bot notifications, reducing visual noise.

### Bug Fixes
- **Profile Manager Lint Error**: Fixed a TypeScript linting error in `src/profileManager.ts` where `configBases` was declared with `let` instead of `const`, resolving build issues.

## [0.14.3] - 2026-04-05
### Local Storage Provider ([#11](https://github.com/unchase/antigravity-storage-manager/issues/11))
- **Local Sync**: Added a full local filesystem storage provider as an alternative to Google Drive. Conversations can now be synced to any local or network-attached directory.
- **New Setting `sync.storageProvider`**: Dropdown selector (`google-drive` / `local`) to choose the sync backend.
- **New Setting `sync.localPath`**: Path to the local directory for sync storage (visible only when provider is `local`).
- **`StorageService` Interface**: Introduced a common storage abstraction (`StorageService`) implemented by both `GoogleDriveService` and the new `LocalStorageService`. The `SyncManager` now dynamically selects the provider at startup based on settings.
- **`LocalStorageService`**: Full implementation mirroring the Google Drive API — manifest, machine states, per-file conversation sync, lock files, and storage info.

### Keep Local Files ([#8](https://github.com/unchase/antigravity-storage-manager/issues/8))
- **New Setting `sync.keepLocalFiles`** (default: `true`): When enabled, local files are preserved during sync even if they were deleted on the remote side. Conversely, remote files are not deleted if they are missing locally.
- **Pull Protection**: `pullConversationPerFile` skips deletion of local files that were removed remotely.
- **Push Protection**: `pushConversation` skips deletion of remote files that are absent locally.

### Workspace Name-Based Mapping ([#6](https://github.com/unchase/antigravity-storage-manager/issues/6))
- **Improved Reindexing**: The `reindexConversations` command now checks the remote manifest for conversations that are missing locally.
- **Name-Based Matching**: Remote conversations are matched against local ones by title (case-insensitive), resolving workspace migration issues where conversation IDs change but titles remain the same.
- **Automatic Re-linking**: When title-matched conversations are found, users can click "Re-link All" to automatically merge remote data into local workspace folders — no manual file copying required.
- **Pull Missing**: If unmatched remote conversations are found, the user is offered a "Pull Missing" action to download them.

### Authentication UX ([#15](https://github.com/unchase/antigravity-storage-manager/issues/15))
- **Actionable Error Messages**: OAuth error pages now display specific troubleshooting hints based on error type:
  - `access_denied` — Guidance on granting permissions and organization approval.
  - `invalid_client` — Instructions to verify Client ID/Secret and enable Google Drive API.
  - `redirect_uri_mismatch` — Exact localhost URL to add in Google Cloud Console.
- **VS Code Notifications**: Error notifications now include **"Open Setup Guide"** and **"Retry"** action buttons for quick recovery.

### Backup Restoration ([#17](https://github.com/unchase/antigravity-storage-manager/issues/17))
- **Auto-Reindex on Import**: After importing conversations from a backup ZIP, the extension automatically runs `reindexConversations` to link restored conversations to the current workspace.

### Markdown Export ([#16](https://github.com/unchase/antigravity-storage-manager/issues/16))
- **New Command `Export as Markdown`**: Export conversations as readable `.md` files instead of binary `.pb` archives.
  - Extracts conversation messages from `.pb` protobuf data using heuristic role-based grouping (User/Assistant/System).
  - Includes brain artifacts (`task.md`, `walkthrough.md`, etc.) in the exported file.
  - Supports batch export with progress indicator and cancellation.
  - Output directory selection via native file picker.

### Settings UX
- **Grouped Settings**: All extension settings are now organized into 8 logical sections in the Settings UI: **General**, **Sync**, **Google Authentication**, **Backup**, **Quota**, **Network Proxy**, **Antigravity Proxy**, and **Telegram**. Previously, all ~35 settings were displayed in a single flat list.
- **Ordered Properties**: Settings within each section are logically ordered by importance and usage frequency.

### Localization
- Added full translations for all new settings, section titles, and UI strings across all 16 supported languages.

## [0.14.2] - 2026-03-08
### Improvements
- **Human-Readable AI Model Names**: Chat messages now display full model names (e.g., "Gemini 3.1 Pro (High)") instead of raw M-codes (e.g., "M37"). Uses dynamic lookup from the Language Server's `GetUserStatus` API with correct prefix stripping for reliable matching.
- **Session Grouping**: Virtual profiles are now excluded from the session rows in "Devices & Active Sessions" — they are already displayed in the quota section above. This eliminates duplicate entries and reduces visual clutter.
- **Redundant Separators**: Removed extra horizontal borders between quota profiles in the scrollable container and between profile headers.
- **Grouped Quota in Header**: Mini-quota indicators in profile headers are now grouped by model family (e.g., "Claude/GPT", "Gemini 3.1 Pro") instead of showing each model individually. Displays the minimum remaining percentage per group.
- **Reset Time for Exhausted Quotas**: Models/groups with 0% remaining now show the localized reset time in parentheses (e.g., "Claude/GPT: 0% (Today 10:55 AM)").
- **Usage History for All Profiles**: The usage history chart now displays for all profiles (including virtual/linked accounts), not just the current device's main account.

### Bug Fixes
- **MCP Servers Panel**: Fixed the "MCP Servers" section in the Sync Statistics Dashboard always showing "No MCP servers configured" even when MCP servers were actively connected. Added fallback logic to read server entries from `~/.gemini/antigravity/mcp_config.json` when the Language Server API returns an empty response.
- **MCP Commands Filter**: Fixed the "MCP Commands" section in the Proxy Dashboard to correctly display custom user-created proxy workflows by checking file contents for proxy tool invocations instead of strictly hardcoding `ag-proxy.md`.
- **Model Name Mapping**: Fixed incorrect model name display caused by two issues: (1) static M-code mappings were stale — M-codes are reassigned by the server over time (e.g., M18 changed from "Gemini 3.1 Pro" to "Gemini 3 Flash"); (2) dynamic lookup failed to match because `MODEL_PLACEHOLDER_` prefix was not stripped from both the raw name and the snapshot's `modelId`.
- **Session Count**: The session counter in device group headers no longer counts virtual profiles, showing only real session entries.
- **Usage History Chart**: Fixed the history chart never rendering due to an undefined `isCurrentGroup` variable — replaced with the correct `isMainAccount` condition. Also fixed zero-usage bars displaying with incorrect minimum height.
- **Usage History Tooltip**: Fixed empty tooltip on hover — the `#tooltip` DOM element was missing (never created), and the `showTooltip` function called `lm.t()` on the client side where `lm` (LocalizationManager) doesn't exist, causing a JS error.
- **Profile Usage Tracking**: `QuotaUsageTracker` now supports per-profile history storage using `profilePrefix`, enabling usage tracking across virtual profiles.

## [0.14.1] - 2026-03-06
### Improvements
- **Multiprofile Quota Display**: The "Devices & Active Sessions" section now intelligently displays combined quota usage for all accounts linked to the active profiles on that specific device, providing a complete picture of available resources.
- **Collapsible Quotas**: Added ability to collapse quota details for other profiles, keeping only the current account expanded by default for better readability.
- **Quota Scrollbar**: Inactive profiles' quota usage blocks are now wrapped in a scrollable container with a maximum height of 480px. This prevents the dashboard from endlessly vertically expanding when multiple profiles or machines are linked, ensuring a cleaner UI.
- **Model Version Updates**: Updated model references from Gemini 3/Flash to Gemini 3.1 Pro/Flash across the application to reflect the latest model versions.
- **Quota Cache Fix**: Fixed an issue where the displayed quota wouldn't update after switching accounts. The QuotaService is now re-initialized properly when the Antigravity language_server process changes.
- **Model Updates**: Upgraded all references of Claude Sonnet 4.5 and Claude Opus 4.5 to their latest 4.6 versions across the extension and localizations.
- **Configurable UI**: Added a new setting `antigravity-storage-manager.ui.showExportImportStatusBarItems` to allow users to hide the "AG Export" and "AG Import" buttons from the status bar for a cleaner workspace.
- **Pinned Models Fix**: Completely overhauled the `pinnedModels` settings validation. The extension now allows cleanly saving custom model IDs without VS Code Settings UI throwing validation errors. Pinned models now always save and display human-readable labels instead of raw technical IDs (e.g., `Claude Opus 4.6 (Thinking) [M8]`).
- **Test Suite Optimization**: Restricted Jest to use `--maxWorkers=2` to prevent tests from hanging indefinitely on resource-constrained development machines.

### Bug Fixes
- **Test Quota Accounts**: Fixed an issue where the "Select Account..." dropdown in the Test Quota section of the Antigravity Proxy Dashboard remained empty, preventing users from testing quotas.
- **Infinite Quota Loading**: Resolved a `ReferenceError` exception in the Dashboard Webview that caused the Quota display modal to hang indefinitely on "Loading..." when testing quotas.

## [0.14.0] - 2026-03-06
### Sync Safety & Pre-Sync Backups
- **Critical Fix**: Resolved a bug where conversations could be overwritten by **older versions** from another device during sync pull operations.
  - **Per-File Timestamp Check**: `pullConversationPerFile` now compares `lastModified` timestamps and **skips** remote files that are older than local versions.
  - **Conflict Escalation**: `processSyncItem` now treats a "remote changed only" case as a **conflict** (instead of a blind pull) when the remote `lastModified` is older than local — preventing silent data loss.
- **Pre-Sync Backups**: Before any pull overwrites local data, a targeted backup of the affected conversation (brain directory + `.pb` file) is automatically created with metadata.
  - **Configurable Settings**:
    - `sync.preSyncBackup` (default: `true`) — Enable/disable pre-sync backups.
    - `sync.preSyncBackupRetention` (default: `20`) — Maximum number of backup snapshots per conversation.
    - `sync.preSyncBackupPath` (default: `~/.gemini/antigravity/sync-backups/`) — Custom backup storage location.
  - **Auto-Cleanup**: Old backups are automatically pruned based on the retention limit.

### Bug Fixes
- **Fix [#7](https://github.com/unchase/antigravity-storage-manager/issues/7)**: Fixed sync configuration state lost on restart — master password key was stored as `ag-sync-master-password` but read as `antigravity-storage-manager.sync.masterPassword`. Unified to a single key with automatic migration from legacy key.
- **Fix [#9](https://github.com/unchase/antigravity-storage-manager/issues/9)**: Fixed `profilesDirectory` detection on macOS and Linux — `detectConfigDir()` previously relied exclusively on `%APPDATA%` (Windows-only). Now supports `~/Library/Application Support/` (macOS), `~/.config/` / `$XDG_CONFIG_HOME` (Linux), hidden dot-directories (`~/.antigravity/`, `~/.codeium/`, `~/.windsurf/`), and extended IDE coverage (Windsurf, Cursor, VSCodium). Includes multi-level fallback via `globalStorageUri`.
- **Fix [#12](https://github.com/unchase/antigravity-storage-manager/issues/12)**: Fixed PortDetector failing on ARM64 Windows devices (Surface Pro, Snapdragon X) — process name was hardcoded to `language_server_windows_x64.exe`. Now detects ARM64 architecture and uses fallback process name search.
- **Fix**: Fixed IDE crash on macOS when switching profiles — `pkill -f Antigravity` was killing the IDE itself. Now only kills the `language_server` process.

### Antigravity Proxy MCP Server
- **Built-in MCP Server**: Added a Model Context Protocol (MCP) server that wraps the Antigravity Proxy, allowing AI agents to interact with the proxy directly.
- **MCP Commands**: Added command management to interact with the proxy directly from Antigravity conversations.
- **New Tools**:
    - `proxy_status`: Check if the proxy is running and view configured providers.
    - `list_models`: Retrieve a list of available AI models from the proxy.
    - `chat_completion`: Send chat messages to AI models via the proxy.
    - `get_quota`: View quota usage for Antigravity, Gemini CLI, and Codex providers.
- **New Dashboard Providers**: Added support for **Anthropic (Claude)**, **Qwen**, **Gemini CLI**, and **Kimi (Moonshot)** in the Antigravity Proxy Dashboard.
- **Profile Enhancements**:
    - **Quota Display**: Saved profiles now display their quota in the "Switch Profile" view.
    - **Account Linking**: Added the ability to link an Antigravity account to a specific profile for seamless switching within the provider.
- **Improvements**: General bug fixes and UI enhancements for the dashboard.
- **Integration**: Seamless integration with MCP-compliant clients (e.g., Claude for Desktop), providing a standard interface for Antigravity Proxy.

### Sync & Dashboard Bug Fixes
- **Extension Host Freeze**: Fixed a critical issue where the `.pb` parser would print excessive debugging logs to the console upon finding empty blocks, causing the extension host to become completely unresponsive during sync operations.
- **Dashboard Service Worker Error**: Resolved `Could not register service worker: InvalidStateError` that occurred when the dashboard webview's HTML was updated too quickly during initialization. Implemented a rendering delay to ensure secure resources (like the Skeleton Loader) can register properly in VS Code 1.95+.
- **Performance Optimization**: Accelerated the loading of the Conversations list in the Sync Dashboard by deferring heavy `md5` hashing of `.pb` file contents.
- **File List Visibility**: Fixed a bug where skipping the aforementioned file hashing optimizations incorrectly resulted in `0 B` file sizes and empty file lists within the dashboard.
- **UI Responsiveness**:
    - **Data Tables**: Enabled horizontal scrolling (`overflow-x: auto`) for large data tables (e.g., Connected Devices) to prevent layout breakage on smaller IDE window widths.
    - **Quota Cards**: Switched the Quota Usage section to CSS Grid, allowing model cards to wrap responsively down to 240px instead of overflowing.
    - **Preview Cleaning**: Removed the empty `Conversation Preview` container from the active conversation expansion to streamline the UI.

---

## [0.13.0] - 2026-02-04
### Antigravity Proxy – Unified AI Gateway
Introducing the **Antigravity Proxy**, a powerful local proxy server that unifies access to multiple AI providers (Antigravity, GitHub Copilot, Claude, Codex, Gemini, Z.AI, Kiro, Vertex, and more) through a single OpenAI-compatible endpoint.

#### Dashboard & Management
- **Visual Dashboard**: Modern, interactive dashboard (`Antigravity Proxy Dashboard` command) with glassmorphism design, provider cards, and status indicators.
- **Provider Cards**: Each AI provider is displayed as a card with:
    - **Status Badge**: Connected (🟢), Not Configured (⚪), or Error (🔴)
    - **Actions**: Sign In, Configure, Test Connection, Delete Auth
    - **Multi-Account Support**: Manage multiple authentication tokens per provider (e.g., multiple Antigravity or Codex accounts)
- **API Keys Management**: Generate, view, enable/disable, and delete local API keys directly from the dashboard.
- **Management Secret Key**: Securely manage the proxy's Web UI password with reveal, change, and reset options.

#### Provider Support
- **OAuth Providers**: One-click Sign In via OAuth for:
    - **Antigravity** (Google AI Studio)
    - **Codex** (OpenAI Codex CLI)
    - **GitHub Copilot** (using VS Code's built-in GitHub authentication)
- **API Key Providers**: Configure by entering an API key for:
    - **Claude** (Anthropic)
    - **Gemini** (Google AI)
    - **Z.AI** (GLM-4 Plus, GLM-4.7, GLM-4.6)
    - **Vertex** (Google Cloud)
    - **Kiro** (AWS)
- **Model Selection**: Choose the active model for Z.AI directly from the dashboard.
- **Test Connection**: Quickly test any configured provider with a single click.

#### Proxy Control
- **Start/Stop/Restart**: Control the proxy lifecycle directly from the dashboard or via commands (`Antigravity Proxy: Start`, `Stop`, `Install`).
- **Status Bar**: Real-time status indicator (`AG Proxy: ON/OFF/Starting/Error`) in the VS Code status bar.
- **Auto-Start**: Optionally auto-start the proxy when VS Code launches (`proxy.enabled` setting).
- **Output Channel**: Dedicated "Antigravity Proxy" output channel for logs and debugging.

#### Auto-Installation
- **One-Click Install**: Automatically downloads and installs the correct `cliproxy` binary for your platform (Windows, macOS, Linux) from GitHub Releases.
- **Update Support**: Easily update to the latest version by re-running the install command.

#### Configuration
- **Auto-Config**: Automatically generates `config.yaml` with sensible defaults and random API keys on first run.
- **Upstream Proxy**: Configure an upstream proxy URL (`proxy.upstreamUrl` setting) for corporate environments.
- **Custom Binary Path**: Override the default binary location via `proxy.binaryPath` setting.
- **Port**: Configurable port (default: 8317) via `proxy.port` setting.

#### Port Conflict Handling
- **Smart Detection**: Automatically detects "address already in use" errors when starting the proxy.
- **Kill Process**: Offers a one-click option to kill the process occupying the port and retry.

#### Integration & UX
- **Auth File Watcher**: The dashboard automatically refreshes when auth files are added, removed, or modified in the `auth-dir`.
- **Open Config**: Direct access to `config.yaml` from the dashboard for advanced users.
- **Show Logs**: View proxy logs in the Output panel from the dashboard.
- **Localization**: Full localization of all dashboard elements across all 16 supported languages.

---

## [0.12.6] - 2026-02-02
### Fixes & Improvements
- **Startup Stability**: Fixed an issue where the "Failed to get/decrypt manifest" error could appear on startup if the user was not authenticated.
- **Localization**: Added full localization for the "Reindex Conversations" command and its description across all 16 supported languages.

## [0.12.5] - 2026-02-02
### Network Stability
- **SSL/Network Retry Logic**: Implemented robust retry mechanism for Google Drive API operations to automatically recover from `SSLV3_ALERT_BAD_RECORD_MAC`, `ECONNRESET`, and other transient network errors.
  - **Zero-Touch Recovery**: The extension will now automatically attempt to retry failed uploads up to 3 times with exponential backoff (1s, 2s, 4s), preventing sync failures on unstable connections.
- **Log Localization**: Network retry logs are now fully localized into all 16 supported languages.

## [0.12.4] - 2026-02-02
### Authentication & Error Handling
- **Smart Error Recovery**: Implemented sophisticated handling for `invalid_grant` (expired session) and `Permission denied` (missing scope) errors.
  - **Auto-Protection**: The extension now automatically signs out to prevent invalid states and prompts the user to re-authenticate with a single click.
  - **Clear Guidance**: Users receive specific, localized instructions on why the error occurred (e.g., "Google Drive session expired").
- **Localized Logs**: Technical error logs (`console.warn`) for authentication issues are now fully localized into all 16 supported languages, making debugging easier for non-English users.

### Code Quality
- **Linting**: Resolved unused variable warnings in `ProfileManager` to ensure codebase cleanliness.

## [0.12.3] - 2026-02-01
### Profile Switching
- **Standalone IDE Fix**: Restored correct configuration directory detection for Standalone Antigravity/Codeium IDEs, fixing an issue where profiles could not be found or saved.
- **Smart Filtering**: Added explicit exclusions for heavy and system-locked folders (`.dotnet`, `ms-dotnettools`, `node_modules`) during profile backup. This completely eliminates `EBUSY` errors caused by the .NET runtime and significantly reduces profile storage size.
- **UI Fix**: Resolved a false positive "Profile Saved" notification that appeared even when the backup operation failed.

## [0.12.2] - 2026-02-01
### Profile Switching
- **EBUSY Fix**: Resolved a common error during profile switching where locked files (like the .NET runtime) in the `globalStorage` directory would block the entire operation.
- **Improved Detection**: The extension now specifically targets Antigravity and Codeium configuration subdirectories instead of scanning the entire global storage root, significantly reducing the chance of encountering locked files from other extensions.
- **Robustness**: Added automatic skipping for busy or locked files (`EBUSY`/`EPERM`), allowing the profile switch to complete successfully even when some non-critical files are in use.

## [0.12.1] - 2026-02-01
### Port Detection (Windows 11)
- **Stability Fix**: Resolved a critical issue in `PortDetector` on Windows 11 where the "Failed to get/decrypt manifest" error frequently occurred due to `findstr` pipe failures. Switched to direct `netstat -ano` output processing in TypeScript for 100% reliability.

### Sync Visibility & Migration
- **Reindex Conversations**: Introduced a new command to manually re-scan the brain directory. This helps restore conversations that may have become "invisible" after an OS migration or workspace relocation.
- **Smart Titles**: Improved metadata extraction to handle cross-platform path differences and automatically clean up leading badges like `[Draft]` from conversation names.

### Dashboard & UX
- **Focus Management**: Prevented the Sync Statistics dashboard from stealing focus or auto-opening when it was previously closed by the user.
- **Throttled Updates**: Added a 2-second update throttle to the dashboard UI to prevent flickering and excessive resource usage during intense multi-file sync operations.

### Testing
- **Jest Migration**: Standardized utility unit tests to use Jest, ensuring better compatibility with the extension's CI/CD pipeline.

## [0.12.0] - 2026-01-31
### Telegram Notifications & Bot Integration
- **Interactive Bot**: The Antigravity Telegram bot is now fully interactive!
    - **/stats**: View full system statistics (CPU, memory, uptime).
    - **/sync**: Trigger a manual sync directly from Telegram.
    - **/ping**: Verify bot connectivity.
- **Smart Notifications**:
    - **Quota Alerts**: Get notified immediately when your quota resets or falls below critical thresholds.
    - **Periodic Stats**: Configure automatic delivery of system statistics at your preferred interval.
    - **Visuals**: Notifications now include ASCII progress bars for Quota and Reset Cycles, plus the linked account email.
- **Username Support**: Simplified configuration by allowing `usernames` in addition to `userIds`. The bot automatically resolves usernames to Chat IDs upon first interaction.
- **Security & UX**: Unauthorized users now receive a helpful "Access Denied" message containing their Chat ID, making setup easier.
- **Localization**: All bot messages and commands are fully localized into 15 languages.
- **Enhanced Stats**: Periodic reports now include the linked Google account email for clarity in multi-account setups.
- **Consistent Reporting**: Telegram messages now perfectly match the VS Code status bar tooltip, including:
    - **Visual Parity**: Identical progress bars, status icons (🔴/🟠/🟡/🟢), and layout.
    - **Detailed Stats**: Speed (~%/h), Estimated Remaining Time, and Cycle progress are now included in all Telegram reports.

### Localization
- **Fix**: Restored English localization bundle that was accidentally overwritten.
- **Coverage**: Added missing keys for Profile management and Telegram features across all supported languages.

---

## [0.11.1] - 2026-01-31
### Bug Fixes
- **Conversation Titles**: Fixed an issue where the "View Current Conversation" tab and Sync Dashboard displayed unreadable GUIDs. Now consistently prioritizes the **Server Title** > **Local Title** > **ID**, ensuring human-readable names are always shown.

## [0.11.0] - 2026-01-31
### Profile Switching
- **Multi-Account Support**: Seamlessly switch between different Antigravity profiles, each with its own separate authentication, quotas, and limits. Perfect for users with multiple Google accounts.
- **Custom Profile Storage**: Added `antigravity.profiles.profilesDirectory` setting to specify a custom folder for storing profiles.
  - **Persistent Storage**: By default, profiles are stored in the extension's global storage. Using a custom directory allows you to keep profiles safe even if the extension is uninstalled.
  - **Warning**: If you use the default storage location, all saved profiles will be deleted if the extension is uninstalled.
- **Improved UX**: The profile switcher now clearly indicates which profile is active and provides a direct way to create, delete, or switch profiles via the QuickPick menu.
- **Manual Restart**: updated the post-switch message to clearly inform users that a manual restart of the Antigravity process is required after window reload.

---

## [0.10.3] - 2026-01-31
### MCP Panel
- **MCP Server Status**: Added a new **MCP Servers** panel to the Sync Statistics Dashboard, displaying:
    - **Server List**: All configured MCP servers with their names, IDs, and connection status.
    - **Status Indicators**: Visual icons (🟢/🟡/🔴/⚪) for Connected, Pending, Error, and Disconnected states.
    - **Tool & Resource Counts**: Number of available tools and resources for each server.
    - **Error Display**: Detailed error messages for servers that fail to connect.
    - **Refresh Button**: Manually reconnect to all MCP servers with a single click.
- **Localization**: Complete MCP panel translations across all 16 supported languages (English, Russian, German, Chinese, Japanese, Korean, French, Spanish, Italian, Portuguese, Polish, Vietnamese, Arabic, Czech, Turkish).

### Bug Fixes
- **Remote Conversation Titles**: Fixed an issue where remote-only conversations displayed GUIDs instead of their actual titles. Now correctly prioritizes real titles over IDs from the manifest.
- **Lint Warning**: Removed unused `statusColor` variable in `syncStatsWebview.ts`.

## [0.10.2] - 2026-01-30
### Sync Statistics
- **Instant Loading**: Implemented a skeleton loader for the Sync Statistics dashboard. The view now opens instantly with a placeholder UI while data loads in the background, significantly improving perceived performance.
- **Silent Refresh**: Data loading is now seamless and non-blocking, removing intrusive progress notifications when the dashboard is already visible.

### Sync Performance
- **Setup Optimization**: Validated `machines` and `conversations` folders are now cached by ID, reducing the number of Google Drive API calls during setup from ~7 to ~2.
- **Parallel Execution**: Initial folder checks are now performed in parallel, speeding up the connection process.

### Bug Fixes
- **Interaction Handlers**: Restored missing message handlers (`openConversation`, `viewPb`, `deleteConversation`) in the Sync Statistics logic, fixing unresponsive clicks and actions in the dashboard.

## [0.10.1] - 2026-01-30
### Sync & Dashboard
- **Force Sync**: Added **Force Sync** capability (🚀) to bypass local caches and flush server-side buffers, ensuring absolute data consistency with the cloud.
- **Improved Machine Recognition**: Enhanced current device identification during sync setup to avoid incorrect **"Different Device"** labels. Now checks both `sync.machineName` and stored `machineId` with trimmed, case-insensitive logic.
- **Active Conversation**: The currently active conversation is now highlighted in the Sync Statistics dashboard with a cursor target icon (🎯) and bold text.
- **Data Origin**: Added a new **"Origin"** column (🏠/📥/☁️) to clearly distinguish between locally created, imported, and cloud-only conversations.
- **Compact Header**: Redesigned the dashboard header to be more compact, using icon-based actions and a simplified timestamp to save vertical space.
- **Accuracy**: Fixed an issue where conversation modification times were inaccurate. Now uses the precise filesystem timestamp of the underlying `.pb` file.
- **Device Collapse Persistence**: The collapsed/expanded state of devices in the Sync Statistics dashboard is now remembered across reloads using `localStorage`.

### Chat & UX
- **Resizable Messages**: Long chat messages can now be vertically resized, making it easier to read extensive code blocks or explanations.
  - **Double-Click Reset**: Double-click on the resize handle to reset the message block to its default height.
  - **View Toggle Reset**: Switching between TEXT and JSON views automatically resets the message height.
- **Improved Cleared History**:
  - **Flexible Expansion**: The "Cleared History" content now fills the available height effectively when expanded.
  - **Auto-Sizing**: Automatically increases text box height to at least 400px when expanding archived content for better visibility.
  - **Token Usage**: Restored messages in history groups now display detailed **Token Usage** statistics (📥 Input, 📤 Output, 🧠 Thinking, 💾 Cached) and latency timers.
- **Show Content Button**: Added a "Show content" button for cleared/archived messages, allowing quick access to the underlying JSON data.
- **Collapsible Error Details**: Error messages with JSON details now display them in a collapsed `<details>` block by default, keeping the UI clean.
- **Missing Files**: Standardized the visual style for missing or deleted files in the chat view (strikethrough + dimmed), improving clarity.

### Diagnostics
- **Server Heartbeat**: Added a "Server Heartbeat" check to the Diagnostics Manager (`Run Diagnostics`), probing the Language Server's responsiveness via the internal API.

## [0.10.0] - 2026-01-30 
### Chat & Conversations
- **Alternative Chat View**: Introduced a specialized viewer for browsing conversation history directly within the extension, independent of the main UI. It supports full Markdown rendering, code highlighting, and optimized layouts.

### User Interface Enhancements
- **Attachment UI**:
    - **Sticky Labels**: Filenames are now pinned to the bottom of attachment thumbnails with a premium glassmorphism effect.
    - **Vertical Centering**: Image previews are perfectly centered, and file icons are neatly aligned.
    - **Copy Path**: Added a quick "Copy Path" button (📋) to all attachment labels.
- **Zoom Controls**: Added a visual zoom level indicator (e.g., "1.0x") next to the font size controls in code views, updating dynamically.
- **Improved UX**:
    - **Response Time**: Refined the "Response time" display to be cleaner (no parentheses) and "look-back" based (shows only on AI messages).
    - **Deduplication**: Fixed an issue where tool call descriptions and errors could appear twice in the chat stream.
    - **Error Details**: Enhanced error reporting to merge high-level user messages with technical details for better debugging.

### Bug Fixes
- **Tool Rendering**: Resolved duplicate rendering of tool call summaries (like `task_boundary`) by handling them atomically.

---

## [0.9.6] - 2026-01-27
### Sync & Dashboard
- **Google Drive Storage**: Enhanced the storage breakdown section to include the total size of your Antigravity backup and its percentage of used space.
- **Quota Display**: Completely revamped the quota blocks with a modern grid layout, circular SVG charts, and grouped models for better readability.
- **Localization**: Added native "Source" field translations across all 16 supported languages.

### Bug Fixes
- **Dashboard**: Fixed an issue where the conversation list was missing from the Sync Statistics view. Restored full visibility of synced files per device.

## [0.9.5] - 2026-01-26
### Sync & Dashboard
- **Session Resumption**: Removed restriction preventing users from resuming a session if the machine name was changed. Now allows reconnecting to any existing session regardless of name mismatch, with appropriate UI feedback.

### Localization
- **Complete Coverage**: Achieved 100% translation coverage across all 16 supported languages.
- **Refinement**: Fixed all remaining untranslated keys (including "Different Device" indicators and dashboard labels), ensuring a fully native experience for all users.

## [0.9.4] - 2026-01-26
### Sync & Dashboard
- **Conflict Resolution Enrichment**: The manual conflict resolution dialog now displays detailed file size and modification time comparisons for both versions, assisting in better decision-making.
- **Quota History Alignment**: Quota usage history charts are now perfectly aligned across all models by filling in missing days with zero usage (standard 14-day window).
- **Localization**: Added full native translations for the new conflict metadata strings across 14 additional languages (Arabic, Czech, German, Spanish, French, Italian, Japanese, Korean, Polish, Portuguese, Turkish, Vietnamese, Chinese Simplified, and Chinese Traditional).

## [0.9.3] - 2026-01-26
### Community & Support
- **Complete GitHub Star Integration**: Added the "Star on GitHub" (⭐) button to all remaining UI touchpoints:
    - **Sync QuickPick**: Title bar of the "Setup Sync" and conversation selection dialogs.
    - **Quota Usage**: Title bar of the quota monitoring window.
    - **Management Menus**: "Manage Authorized Machines" and "Export Conversations" dialogs.
    - **Main Menu**: The main "Antigravity Storage Manager" command menu.
    - **Auth Success**: The browser confirmation page after successful Google login.
- **Localization**: Added native translations for "Star on GitHub" across all 16 supported languages.

### Bug Fixes
- **Sync Statistics**: Fixed an issue where the "Google Drive Storage" section displayed the AI Studio account email instead of the active Drive Sync account email.
- **Localization**: Resolved a duplicate key issue in the Russian localization bundle.

## [0.9.2] - 2026-01-25
### Quota & Dashboard
- **Redesigned Quota Cards**: Completely overhauled the quota display in the Sync Statistics dashboard.
    - **Circular Charts**: Replaced linear progress bars with elegant SVG donut charts for quota usage.
    - **Daily History**: New bar chart visualization showing usage history aggregated by day used.
    - **Premium Aesthetics**: Improved typography, spacing, and glassmorphism effects for a modern look.
    - **Layout Fixes**: Resolved card overlap issues on smaller screens and refined "No detailed stats" display.

### Quota & UI
- **Pinned Model Icon**: Improved the placement of the pinned model icon (📌), moving it to the left of the model name for better visibility and alignment.
- **Localization**: Added missing localization for "Max Usage" and "Cycle" across all 16 supported languages.

### Bug Fixes
- **Localization Duplicates**: Fixed an issue where duplicate "Cycle" keys caused lint warnings in localization bundles.
- **Quota Scope**: Resolved a potential reference error (`isPinnedA` is not defined) in the quota display logic.

## [0.9.1] - 2026-01-25
### Multi-Device Quota Display
- **Cross-Device Visibility**: The Sync Statistics dashboard now displays quota usage, email, and plan info for **all** synced devices, not just the current one.
- **Per-Device Quotas**: Each device in the "Devices & Active Sessions" list now shows its own quota bars, user email, and tariff if available.
- **Enhanced Quota Cards**: Quota model cards now display:
    - **Reset Time**: When each model's quota will reset
    - **Cycle Bar**: Visual progress bar for Pro/Ultra/Thinking/Opus models showing cycle progress
    - **Usage Stats**: Request count (e.g., "123/500") when available
    - **Improved Styling**: Cards now have background, padding, and cleaner layout

### Bug Fixes
- **Shared Session Visibility**: Fixed an issue where devices sharing the same Session ID would only show one device when the other had synced last. Now all known devices are correctly displayed using manifest data as fallback.
- **Quota Visibility**: Resolved an issue where "Ghost" devices (conflicting IDs) were missing their quota information in the Sync Statistics dashboard.

## [0.9.0] - 2026-01-25
### Profile Switcher
- **New Command**: Added `Switch VS Code Profile` command to quickly open VS Code with a different profile.
- **Profile Management**: Save, select, and remove profiles via QuickPick UI.
- **Multi-Account Support**: Easily switch between different Antigravity accounts by leveraging VS Code's profile system.

### Localization
- **Missing Strings Fixed**: Added 35+ missing localization keys for:
  - **Diagnostics**: `Run Diagnostics`, `Clear Cache`, `Internet Connectivity`, `Authenticated`, `Not signed in`, etc.
  - **Profile Switcher**: `Switch Profile`, `Add New Profile`, `Remove Profile`, `Enter profile name`, etc.
- **Translations**: Complete Russian and German translations for all new strings.

### Proxy Support
- **Proxy Configuration Helper**: New command `Antigravity: Apply Proxy Settings` (`antigravity-storage-manager.applyProxy`) allows applying Antigravity-specific proxy configuration (including authentication) to your current VS Code profile.
- **Proxy Authentication**: Added support for username/password authentication in proxy URL via new `proxy.username` and `proxy.password` settings.
- **Account Dashboard**: Active proxy URL is now displayed in the "Profile" section of the Account Information dashboard for better visibility.
- **Strict SSL**: Configurable SSL verification (`proxy.strictSSL`) for proxy connections.

### Bug Fixes
- **Startup Crash**: Fixed a critical issue where the extension would fail to activate with a "password argument must be of type string" error if sync was not fully configured.

---

## [0.8.1] - 2026-01-24
### Quota & Account Dashboard
- **Visual Usage Graphs**: Added beautiful area charts to the Account Dashboard showing quota usage history for each model over time.
- **Configurable History**: Added `antigravity.config.quota.historyRetentionDays` setting (default: 7 days) to control how long usage data is kept.
- **Grouped Thresholds**: Quota threshold settings (Warning, Critical, Danger) are now logically grouped in settings for better usability.

### Diagnostics & Maintenance
- **System Diagnostics**: New `Run Diagnostics` command checks internet connectivity, Google Drive authentication, and local quota service health.
- **Cache Cleaning**: Added `Clear Cache` command to remove temporary files and reset internal metadata caches.
- **Network Health**: Dashboard now utilizes diagnostics to report connection status.

### Configuration
- **Flexible Pinning**: Removed strict validation for `pinnedModels`, allowing users to pin new or custom model IDs without errors.
- **Localization**: Added native translations for all new features (Diagnostics, Cache, History) across all 16 supported languages.

## [0.8.0] - 2026-01-24
### Localization
- **Decryption Errors**: Fixed hardcoded English error messages in the decryption module. "Failed to get/decrypt manifest" and "Decryption failed" are now fully localized across all 16 supported languages.
- **Russian Translations**: Added missing translations for permission errors and decryption failures in the Russian bundle.

### Account Dashboard
- **Sync Usage Stats**:
    - **Usage Metrics**: The "Google Drive Sync Accounts" card now displays total cloud storage used by synchronized conversations (in MB/GB) and the total number of synced dialogues.
    - **Last Sync**: Added "Last Update" timestamp showing exactly when the remote manifest was last modified.
- **Localization**: Added native translations for new stats terms ("Used", "Sync Usage", "Last Update") across all 16 supported languages.

### Optimization
- **Build Size**: Reduced extension package size by optimizing `esbuild.js` (minification, map exclusion) and refining `.vscodeignore` to exclude unnecessary development assets.

---

## [0.7.13] - 2026-01-24
### Localization & UX
- **Smart Formatting**: Performance metrics (load times) > 1000ms are now automatically formatted in seconds (e.g., `1.5s`) for better readability.
- **Unit Localization**: Added native localization for:
    - **Time Units**: `ms`, `s` (milliseconds, seconds).
    - **Storage Units**: `B`, `KB`, `MB`, `GB`, `TB` (e.g., `ГБ`, `МБ` for Russian, `Go`, `Mo` for French).

## [0.7.12] - 2026-01-24
### Quota & Dashboard
- **Remote Quota Visibility**:
    - **Persistence**: Usage quotas (model requests, tokens, limits) are now securely synced to Google Drive.
    - **Cross-Device Monitoring**: The Sync Statistics dashboard now displays the quota usage of *other* connected devices in your sync network.
    - **Shared Session Detection**: Automatically detects and alerts if another device is using your Session ID (e.g., due to cloning configs), displaying it as a distinct "Ghost" session to prevent confusion.
- **Configurable Thresholds**: Warning (Yellow), Critical (Orange), and Danger (Red) quota thresholds are now fully customizable via settings.

## [0.7.10] - 2026-01-24
### Bug Fixes
- **Sync Statistics Icons**: Fixed an issue where file icons in the Sync Statistics dashboard were not displaying correctly. Replaced dependency on external fonts with high-quality **inline SVG icons** (VS Code Seti style).
- **Sync Dashboard Improvements**: Added display of total conversation size, user account info (email, plan), and compact quota usage indicators for the current device.
- **Improved File Recognition**: Added proper icon mapping for additional file types (`.pb`, `.jsx`, `.tsx`, `.jpeg`) in the dashboard.
- **Localization**: Added missing translations for "Quota Usage", "User", and "Plan" across all supported languages.
- **Dialog Enhancements**: Added support/donate buttons to Export, Rename, and Device Management dialogs.
- **Device Management**: Added intelligent sorting (Status, Last Sync, Name) to the "Manage Authorized Deletion Machines" list.
- **Quota Source**: User email is now sourced directly from the Quota API (Google AI Studio) for accuracy, falling back to Google Drive account only if unavailable.
- **Error Logging**: Localized error messages in `console.error` logs for better debugging in non-English locales.
- **Code Quality**: Resolved `require()` import usage in crypto module to comply with strict linting rules.

## [0.7.9] - 2026-01-23
### UX Improvements
- **Status Bar Visibility**: Status bar now remains visible after disconnecting from sync, showing the warning icon (⚠) instead of disappearing.
- **Session Selection Fix**: Fixed an issue where session selection dialog was skipped after reconnecting. Now properly shows "Resume/New Session" options.

## [0.7.8] - 2026-01-23 
### Sync Logic
- **Robust Sync Logic**:
    - **Fixed redundant uploads**: Resolved an issue where files were re-uploaded during sync even when they were already synchronized. Hash cache is now properly updated after pulling and uploading files.
    - **Persistent Machine ID**: Machine ID is now based on hostname + username hash, ensuring the same device always gets the same ID even after extension reinstall. This prevents duplicate device entries and redundant file uploads.
    - **Smart Push**: Manifest is only updated when files are actually uploaded or deleted, skipping no-op operations.

## [0.7.7] - 2026-01-23
### Sync Logic & Dashboard Improvements
- **Robust Sync Logic**:
    - **Precise Modification Tracking**: Replaced directory-level monitoring with per-file `max(mtime)` tracking, ensuring sync triggers only when actual content changes.
    - **Sync Loop Prevention**: Metadata-only updates (titles) now preserve existing timestamps, preventing redundant sync cycles across devices.
- **Dashboard Enhancements**:
    - **Time Localization**: All timestamps now respect the user's localized format via `LocalizationManager`.
    - **File Sorting**: Files within conversation expansion lists are now sorted alphabetically by name.
    - **Fixed Transfer Counts**: Resolved issues where upload/download counts for the current session were not updating in real-time.
- **Bug Fixes**:
    - Fixed lint errors in `accountInfoWebview.ts` and test files related to unused variables and empty blocks.
    - Localized `formatRelativeTime` strings ("Just now", "{0} days ago").
- **UX & Localization**:
    - **Refined Sync Notifications**: Progress notifications now display conversation titles instead of cryptic IDs (e.g., `Analyzing "My Project"...`), with full localization across all 15 supported languages.
    - **Improved Legibility**: Conversation titles in notifications are now wrapped in double quotes for better visual separation.

## [0.7.6] - 2026-01-23
### Dashboard & UI Logic
- **Sync Dashboard 2.0**:
    - **Detailed File View**: Each conversation now features a collapsible file list, allowing inspection of individual files, their sizes, and sync status.
    - **Transfer Stats**: Added "Uploads" and "Downloads" columns to the Connected Devices table, tracking session-based file transfer counts.
    - **Enhanced Metadata**: Conversations now display "Created by [User]" and precise timestamps for better context.
    - **Smart UX**: Resolved a focus-stealing issue where auto-refreshing the dashboard would interrupt typing in the editor.
    - **Action Tooltips**: Added descriptive tooltips to all dashboard buttons (Rename, Delete, Ping, etc.) for better accessibility.
- **Community Support**:
    - Integrated "Support on Patreon" and "Buy Me a Coffee" buttons across the extension's UI:
        - **Account Dashboard**: Header actions.
        - **Sync Statistics**: Header actions.
        - **Quota Menu**: Title bar icon buttons.
        - **Authentication**: Success confirmation page.
- **Localization**:
    - **Complete Coverage**: Localized all new dashboard components (file lists, stats columns, badges) into all 16 supported languages.
    - **Support Links**: Translated tooltips for support buttons.
    - Added full native localization for the new "Create Backup Now" command across all 15 supported languages.

### UI & UX
- **Refined Cycle Bar**: Updated cycle heuristics for models. **Gemini 3 Pro**, **Opus**, and **Thinking** models now correctly reflect a **5-hour cycle duration** (previously 24h or inaccurate), providing a true visual representation of quota reset times.
- **Active Transfers**: Clicking on a transfer item (upload/download) in the "Active Transfers" section of the Sync Dashboard now directly opens the corresponding conversation.

### Quota & Account Dashboard
- **Model Pinning**: Pin your favorite models directly from the Account Dashboard (📌) to prioritize them in the list and status bar.
- **Usage Insights**: Added "Speed" (~%/h) and "Estimated Time Remaining" to the Account Dashboard for models with active usage.
- **Privacy Options**: Added `antigravity.showCreditsBalance` setting (default: `false`) to hide credit balance from the dashboard and status bar.

## [0.7.5] - 2026-01-22
### Sync Statistics Dashboard (Major Upgrade)
- **Premium Design**: Completely overhauled the dashboard with a modern glassmorphism aesthetic, featuring vibrant gradients, interactive cards, and subtle animations.
- **Improved Visualization**:
    - Replaced basic data metrics with a sleek "Sync Network" overview.
    - Integrated a professional storage visualization for Google Drive with a dynamic progress bar.
    - Added pulsing status indicators to clearly differentiate online and offline device sessions.
- **Session Grouping**: Devices are now intelligently grouped by name, making it significantly easier to manage multiple sessions across different machines.
- **Interactive Actions**:
    - Added **"Clear Files"** (🧹) functionality to delete remote conversations specifically associated with a device session.
    - Enhanced confirmation dialogs for destructive actions to ensure data safety.
- **Technical Refinement**: 
    - Decoupled UI logic into a dedicated `SyncStatsWebview` class for better performance and maintainability.
    - Fixed several critical TypeScript and linting issues identified in the dashboard logic.
- **Active Transfers**: Added a dedicated real-time "Active Transfers" section to the Sync Statistics Dashboard, showing ongoing uploads and downloads with pulsing status indicators.
- **Dynamic Refresh**: The dashboard now automatically refreshes whenever a sync operation starts or finishes, providing immediate visual feedback.

### Localization & Internationalization
- **Full Dashboard Localization**: Completed localization of all remaining dashboard components (headers, table columns, action labels, time formats) for all 15 supported languages.
- **Improved Russian Translation**: Proofread and corrected several translation keys to ensure professional terminology.
- **Error Localization**: Localized internal processing errors (e.g., "Failed to get conversation title") to improve transparency for non-English users.

### UI & UX
- **Performance Updates**: The dashboard now supports real-time data refreshing synchronized with background sync events.
- **Consistency**: Unified the visual language with the recently updated Account Dashboard for a seamless premium experience.
- **Rendering Fix**: Replaced progress bar characters with high-compatibility Unicode symbols to ensure consistent rendering across different operating systems and fonts.
- **Refined Styles**: Improved the "Active Transfers" card aesthetics with vibrant icons and pulsing animations.

### Bug Fixes
- **Type Safety**: Restored missing methods (`isVisible`) and fixed lexical declarations in webview message handlers.
- **Cleanup**: Removed unused imports and optimized dashboard loading latency.

## [0.7.4] - 2026-01-22
### User Interface
- **Smart Menus**: The "AG Sync" menu now intelligently disables items requiring Google Drive connection when disconnected, showing a "Requires Sync Setup" indicator.
- **Visual Feedback**: Disabled operations are marked with a lock icon 🔒 instead of their usual icon.

### Authentication & Security
- **Smart Auth Flow**: 
    - Automatically checks for missing `client_id` or `client_secret` before attempting to sign in.
    - Provides a direct "Open Settings" button if credentials are invalid, preventing failed browser redirects.
- **Localized Errors**: All authentication errors (User Cancelled, Timeout, Port In Use) are now fully localized.

### Localization
- **Full Localization**: Completed translation of the "Account Information" dashboard and "Google Account Data" into all 15 supported languages.
- **Comprehensive Coverage**: Added and localized strings for Account Plan, Cycle Info, Usage Stats, and the "Google Account Data" menu item.
- **Consistency**: All localization bundles are now fully synchronized and verified for integrity.

### Account Dashboard (New!)
- **Real-time Updates**: The dashboard now automatically refreshes data every minute, synchronized with the status bar's polling.
- **Premium UI**: Completely redesigned the "Account Information" dashboard with a modern, dark "GitHub-style" aesthetic and improved micro-animations.
- **Enhanced Quotas**: Added status indicators (🟢/🟡/🟠/🔴), cycle progress bars, and detailed request/token usage statistics for all models.
- **Accurate Plan Info**: Correctly identifies and displays "Plan" and "Tier" directly from Google API data.
- **Live Raw Data**: The "View Raw JSON" function now always presents the most current snapshot from the last update.

### Quota Interface
- **Status Bar Consistency**: The dashboard visuals now perfectly match the premium feel of the status bar tooltip.
- **Progress Bar**: Fixed progress bar rendering (replaced `▓` with `█` for better readability).

### Device Management
- **Authorized Machines**: Added details to the "Manage Authorized Deletion Machines" list:
    - Online/Offline status (🟢/🔴).
    - Last sync time.
    - Current session duration.

### Code Quality
- **Linting**: Fixed linting errors (`formatDate`).

## [0.7.3] - 2026-01-21
### Sync & Performance
- **Sync Feedback**: 
    - Added a "Fetching data from Google Drive..." notification when requesting remote data.
    - Status bar tooltip now correctly reflects the "Fetching..." state during remote operations.
- **Cache Optimization**: Opening the conversation list now respects the `sync.useMetadataCache` setting, effectively preventing unnecessary Google Drive requests when cached data is available.

### Sorting & Selection
- **Refined Sorting UI**: 
    - Completely overhauled the "Setup Sync" conversation selection to use a rich QuickPick interface with sorting and detailed timestamps.
    - Added **"Sort by Name"** option to all conversation lists (`Manage Conversations`, `Setup`, `Connect to Session`).
    - Standardized sorting labels to explicitly state **"Sort by Date and Time"** for clarity.
- **Advanced Sorting Logic**:
    - Implemented stable sorting with tie-breakers: "Name" sort falls back to ID, and "Duration" sort falls back to Date.
    - Fixed an issue where the sort button in the "Connect to Session" dialog would not trigger a visual update.
- **UI Cleanup**: Removed the redundant "Sync All Conversations" item from the Manage Conversations list (superseded by the "Select All" checkbox).

### Devices Dashboard
- **Interactivity Fix**: Resolved an issue where dashboard buttons (Delete, Purge, Sync) were not responsive due to message passing errors.
- **Status Indicators**: 
    - Added "Online/Offline" status dots for each session based on recent activity.
    - Added "Sync Count" display for each machine.
- **Quota & Grouping**:
    - Displaying quota usage (Credits/Limits) directly in the dashboard sessions.
    - Improved session grouping logic (by Machine Name) and fixed potential duplicate entries.
    - Added "UID" column for clearer session identification.

### UI Enhancements
- **Conversation Details**: Improved visual formatting in QuickPicks using distinct separators (` | ` and ` • `) for Status, Created, and Modified dates.
- **Status Tooltips**: Added explicit text labels (e.g., "Synced", "Local Only") to conversation details to explain status icons.
- **AG Sync Menu**: Redesigned the menu with visual separators and regrouped items for better accessibility. 
- **Settings UX**: The `Authorized Remote Delete Machine Ids` setting now features a `markdownDescription` with a direct command link.

### Localization
- **100% Coverage**: Completed and verified full translation bundles for all 15 supported languages.
- **Sync Results**: Fully localized the sync completion message (including `{0} pushed` and `{0} pulled` counts).
- **Localization Refactoring**: Standardized all user-facing strings in `src/sync.ts` to use the `LocalizationManager`.
- **Testing**: Added `npm run check` script that runs type checking, linting, and unit tests in one command.
- **Validation**: Added `check_l10n_bundles.js` and `check_nls_keys.js` to ensure translation integrity.

### Sync Statistics Dashboard
- **Session Grouping**: Devices are now grouped in the "Connected Devices" table by name, with collapsible session lists.
- **Session Sorting**: Sessions within each device are sorted by last activity (current session first).
- **Activity Info**: Each session now displays "Last Active" timestamp and calculated "Duration".
- **Status Indicators**: Added a "Syncs" column with green/red status dots to indicate online/offline sessions.
- **Collapsible Groups**: Device groups can be expanded/collapsed by clicking on the header.

### Testing
- **Localization Tests**: Added automated tests for verifying `package.nls.*.json` and `l10n/bundle.l10n.*.json` files.
    - `npm run test:l10n` — Run all localization bundle tests.
    - `npm run test:nls` — Run package.nls key consistency tests.
    - `npm run test:localization` — Run all localization tests.

### Quota Display Improvements
- **Time until Reset**: Models in the Quota Usage window now show the time remaining until quota reset (e.g., `in 15m`).
- **Estimation Logic**: The "Estimated Remaining Time" is now hidden when the quota is fully exhausted (0%) to avoid clutter.
- **Enhanced Cycle Bar**: Improved the "Cycle" visual scale `[▓▓▓░░░]` to include **Opus** and **Thinking** models, and more accurately reflects cycle reset windows for Pro/Ultra tiers.
- **Visual Consistency**: Unified the progress bar style using the `▓` character across all tooltip scales.

### UI Improvements
- **Conversation List**: 
    - Added "Modified" and "Created" dates to the Synchronization selection list for better context.
    - Fixed a bug in the "Rename Conversation" dialog where sorting would unexpectedly close the window.
- **Selection & Sorting**:
    - "Select All" and individual selections are now persisted correctly when changing the sort order in multi-select lists (e.g., Export, Sync).
    - Sorting by "Created Date" or "Modified Date" now correctly refreshes the list without resetting the selection state.

### Performance
- **Optimized Export**: The "Export Conversations" command now utilizes cached metadata for status badges, significantly reducing initial load time and eliminating unnecessary Google Drive requests.

### Bug Fixes
- **Dashboard Rename**: Fixed an issue where renaming a conversation via the Dashboard did not immediately reflect the new title.
- **Dashboard Refresh**: Fixed the "Refresh Data" button in the Sync Statistics dashboard to properly reload data from Google Drive.

## [0.7.2] - 2026-01-21
### Remote Management
- **Remote Deletion**: Authorized machines can now delete conversations created by other machines directly from the Sync Dashboard.
- **Authorization**: New "Manage Authorized Deletion Machines" command to control which devices have delete permissions.
- **UI**: Added "Purge" button (🧹) to the Sync Dashboard for authorized machines.
- **Easier Configuration**: Added clickable command link in the `Authorized Remote Delete Machine Ids` setting description to quickly open the management picker.

### Localization Improvements
- **Persistent Sync Sessions**: When setting up sync, users can now choose to reconnect to a previously used device ID (resume session) or create a new one. This prevents duplicate device entries in the dashboard.
- **Smart Setup Prompt**: Warning style prompt with "Setup Sync" and "Cancel" buttons if sync is unconfigured.
- **Enhanced List View**: Conversation list now displays the full creation time (date + time) instead of just relative time.
- **Configuration Prompt**: Reload window prompt when language setting is changed to apply changes immediately.
- **Quota Grouping**: Organized quota usage menu into logical groups (Claude/GPT, Gemini Pro, Gemini Flash) for better readability.
- **Export Dialog**: Fixed "Created" label localization and ensured dates are formatted according to the selected extension language (not system locale).
- **Localization**: Fully translated extension into 16 languages (Arabic, Czech, German, Spanish, French, Italian, Japanese, Korean, Polish, Portuguese (Brazil), Turkish, Vietnamese, Chinese Simplified, Chinese Traditional, English, Russian). All UI elements, commands, and configuration descriptions are now native.

## [0.7.0] - 2026-01-21
### Localization & Internationalization
- **16 Languages Support**: Added native localization for: English, Russian, Chinese (Simplified/Traditional), Japanese, Korean, German, French, Spanish, Italian, Portuguese (Brazil), Turkish, Polish, Czech, Arabic, and Vietnamese.
- **Smart Formatting**: Dates and times (e.g., "Tomorrow 09:00", "Last Sync") are now formatted according to the user's locale.
- **Comprehensive Coverage**: Translated all Status Bar items, Menus, Notifications, Popups, and Settings descriptions.

### Quota Dashboard Enhancements
- **Quota Estimations**: Added "Speed" (usage/hour) and "Estimated Remaining Time" to Model Tooltips.
- **Visual Time Scale**: Pro/Ultra models now display a visual progress bar `[████░░]` showing time elapsed in the current cycle.
- **Detailed Usage**: Quota Usage window now shows granular Request count and Token usage stats per model.
- **Colored Status Indicators**: Quota status icon now changes color (Red/Orange/Yellow/Green) based on remaining percentage.
- **Visual Progress**: "Remaining" field in tooltips now includes the visual progress bar `[██░░]`.

### UX Improvements
- **Sync Progress**: Added visual progress bar `▓▓░░` for Sync Quota in the status bar tooltip.
- **Live Sync info**: "AG Sync" tooltip now duplicates the live upload/download progress counts.
- **Better Formatting**: Sync Statistics now display load times in a more readable format (seconds/ms).
- **Keybinding**: Added `Ctrl+Alt+Q` (Mac: `Cmd+Alt+Q`) shortcut to directly open the Antigravity Quota view.
- **Chat Refresh**: Added a "Reload Window" prompt after syncing to ensure new conversations appear in the list.
- **Menu**: Added keybinding hint `(Ctrl+Alt+Q)` to the **Show Quota** menu item for better discoverability.
- **Smart Setup**: Added a warning prompt on startup if sync is enabled but not configured, guiding the user to setup.
- **Configuration**: Added "Reload Window" prompt when changing the extension language to apply changes immediately.
- **UI**: "Next Sync" and "Resets" timers now automatically hide if the time has passed to reduce clutter.

### Bug Fixes
- **Sync Titles**: Resolved issue where Sync Statistics displayed outdated conversation titles. Titles are prioritized from local `task.md`.
- **Sorting**: Fixed "Sort by Reset Time" behavior in Quota Usage window.
- **Validation**: Fixed validation error for `pinnedModels` setting to support readable labels and custom IDs.
- **Localization**: Fixed duplicate keys in language bundles (ru, ja, de, etc.) to prevent potential conflicts.

### Localization Improvements
- **Locale-Aware Dates**: All date/time displays now format according to the user's selected locale (e.g., "21.01.2026" for Russian, "1/21/2026" for English).
- **Conversation Picker**: Added creation/modification dates to conversation selection during sync setup, sorted by newest first.
- **Dashboard**: Localized "by {machine}" text in the Modified column.
- **Rename Dialog**: Improved UX with localized title and confirmation prompt hint.
- **Load Time**: Localized "ms" and "s" units in the "Data loaded in" display.

### Quota Tooltip
- **Remaining Time**: Shows "0" when quota is fully exhausted (0%) instead of hiding the field.

### Code Quality
- **Tests**: Added unit tests for `LocalizationManager` (`formatDateTime`, `formatDate`, `getLocale`, `t`).
- **Translations**: Added new strings to all 14 language bundles: `by`, `Created`, `Modified`, `ms`, `s`, status tooltips.

---

## [0.6.0] - 2026-01-20
- **Feature**: Parallel Sync! Uploads and downloads now run in parallel chains for significantly faster synchronization.
    - **Configurable**: Added `sync.concurrency` setting (default 3, max 10) to control parallelism.
- **Feature**: Cancellation Support. All long-running operations (Sync, Export, Backup) are now interceptable via the "Cancel" button.
    - Graceful rollback and cleanup of partial operations.
- **Quota**: Added "Antigravity Quota Dashboard" in status bar for tracking AI credit usage.
- **UX**: Enhanced Sync Statistics Dashboard.
    - **Sorting**: Added clickable headers to sort tables by Title, Size, Date, etc.
    - **Smart Titles**: Conversations now display their actual readable titles (from `task.md`) instead of just IDs, even for remote items.
    - **Visuals**: Added visual sort indicators (▲/▼) and hover effects.
- **Fix**: Setup Wizard now allows cancellation.
- **Localization**: Added full English and Russian localization support.
    - **Configurable**: Switch language in settings (`antigravity-storage-manager.language`) without restarting VS Code.
- **Visuals**:
    - **Colored Icons**: Quota status now uses colored circles (🟢/🟡/🔴) for better visibility.
    - **Time Scale**: Visual progress bar for Pro/Ultra models showing time remaining in current cycle.

---

## [0.5.0] - 2026-01-20
- **UI/UX**: Major overhaul of Sync Statistics and Status Bar.
    - **Status Bar**: Added Sync Count and Last Sync time to tooltip. Added icons to Import/Export buttons.
    - **Menu**: Added dynamic keybinding hints to all menu items.
    - **Enhanced Sync Statistics**:
    - **Interactive Dashboard**: Rename (`Rename`) and Delete (`Delete`) conversations directly from the webview.
    - **Selective Sync**: Manually uploading ("Upload") local-only conversations and downloading ("Download") remote-only conversations.
    - **Machine Management**: Added ability to **Delete** stale machines and **Force Push** sync signals to remote devices.
    - **Data Insights**: Added "Downloads" column to Connected Machines and improved data size visualization (MB metrics for uploads/downloads).
    - **Usability**: Added global **Refresh** button and scrollable file lists for detailed breakdown.
    - **Progress Reporting**: Replaced generic "Fetching remote data..." with granular status updates (e.g., "Scanning...", "Syncing 'Title'...") for better visibility.
- **Smart Status Bar**:
    - **Dynamic Icons**: Status bar icon now changes to reflect state: Idle (☁️/✅), Syncing (🔄), Error (⚠️).
    - **Idle Check**: Shows a checkmark (`$(check)`) when idle if a successful sync has occurred this session.
    - **Rich Tooltip**: Hover to see detailed status, last sync time, and session sync count.
- **Code Quality**:
    - **Linting**: Fixed various linting errors and improved code stability.
    - **Tests**: Added new unit tests for statistics calculation logic (`sync_stats.test.ts`).
    - **Documentation**: Updated `README.md` with new screenshots, feature descriptions, and a "Buy Me a Coffee" support link.
- **Feature**: Smart Error Handling.
    - Added detection for "Not found in Drive" errors.
    - Added suggestions dialog to automatically fix manifest inconsistencies.
- **Configuration**: Added `sync.suggestSolutions` setting to enable/disable error suggestions.

---

## [0.4.14] - 2026-01-20
- **Feature**: Per-file differential sync! Only changed files are uploaded/downloaded instead of entire conversation archives.
    - Dramatically reduces bandwidth usage for small edits.
    - Each file is encrypted individually and stored in Google Drive.
    - Backward compatible with legacy ZIP format.

## [0.4.13] - 2026-01-20
- **Performance**: Major sync optimization overhaul:
    - **Async I/O**: File operations now use asynchronous methods (`fs.promises`) to prevent blocking the editor.
    - **Hash Caching**: File hashes are cached based on modification time (`mtime`), avoiding redundant hash calculations.
    - **Parallel Sync**: Conversations are now synced in parallel chunks (up to 5 concurrent) for faster synchronization.
    - **MD5 Content Hashing**: Switched to MD5 for content-based change detection, reducing unnecessary uploads when content hasn't changed.
- **Tests**: Added unit tests for `computeMd5Hash` function.

## [0.4.12] - 2026-01-20
- **Feature**: Dynamic sync status bar! Now shows the specific sync stage (e.g., "Fetching remote data...", "Compressing...", "Uploading...").
- **Fix**: Resolved "Show Statistics" button not working in the status bar menu.

## [0.4.11] - 2026-01-20
- **Fix**: Resolved a potential error when disconnecting sync (null check fix).

## [0.4.10] - 2026-01-20
- **UI**: Consolidated all Antigravity commands into a single Status Bar menu. Clicking "AG Sync" now opens a quick access menu for Sync, Backup, Import/Export, and Settings.
- **UX**: Status bar tooltip now shows real-time progress during sync (e.g., "Uploading [conversation]...").

## [0.4.9] - 2026-01-20
- **Feature**: Enhanced "Sync Statistics" dashboard with a detailed conversation list.
    - View which conversations are synced on multiple machines.
    - See modification dates, originator (machine that created it), and file sizes.
    - Visual badges for Imported vs Local content.

## [0.4.8] - 2026-01-20
- **Fix**: Fixed issue where "Setting up sync storage..." would appear to hang during the initial sync.
- **Improvement**: Setup wizard now shows detailed progress for the initial synchronization.

## [0.4.7] - 2026-01-20
- **Feature**: Added detailed progress reporting during sync (compressing, encrypting, uploading/downloading).

## [0.4.6] - 2026-01-20
- **Fix**: Resolved crash during setup ("password argument must be string") by initializing password in memory immediately.
- **UX**: Authentication notification is now transient and closes automatically on success.
- **UX**: "Show Sync Statistics" now prompts to Setup Sync if not configured.

## [0.4.5] - 2026-01-20
- **Fix**: Resolved issue where Setup would bypass authentication check, leading to errors.

## [0.4.4] - 2026-01-20
- **Fix**: Implemented aggressive credential restoration to prevent "No access token" errors in all sync scenarios.

## [0.4.3] - 2026-01-20
- **Fix**: Fixed critical bug where reloading credentials would wipe active session tokens, causing authentication failures.

## [0.4.2] - 2026-01-20
- **Fix**: Resolved "No access, refresh token" error during initial sync setup by fixing authentication client staleness.

## [0.4.1] - 2026-01-20
- **Feature**: Added **Sync Statistics View** to monitor connected machines and sync status.
- **Improvement**: Enhanced "Join Existing Sync" flow with conversation selection.
- **Improvement**: Improved sync logic to automatically pull new remote conversations.
- **Fix**: Improved error reporting in Sync Status Bar.

## [0.4.0] - 2026-01-20
- **Feature**: Added **Internationalization (i18n)** support. Extension is now available in English and Russian.
- **Feature**: Added **Scheduled Local Backups**. Configure backup interval, custom path, and retention policy to keep your conversations safe automatically.
- **Feature**: Added `Antigravity Storage: Backup All Conversations` command for one-click full backup.
- **Dev**: Added automated testing infrastructure with Jest.

---

## [0.3.6] - 2026-01-19
- **Feature**: Added `Backup All Conversations` command for one-click local zip backup.
- **Feature**: Added `Resolve Conflict Copies` command with UI to handle sync conflicts.
- **Refactor**: Optimized `SyncManager` architecture for better maintainability.
- **Support**: Added sponsorship links for Patreon support.

## [0.3.4] - 2026-01-19
- **Security**: Added manifest locking mechanism to prevent concurrent sync corruption.
- **UX**: Added `sync.machineName` setting to customize machine name in sync status.
- **UX**: Added `sync.silent` setting to suppress auto-sync success notifications.
- **Performance**: Improved conversation list loading with asynchronous processing.
- **UI**: Display relative time (e.g., "2 hours ago") for conversation modifications.

## [0.3.3] - 2026-01-19
### Fixed
- **Sync**: Resolved "Failed to get remote manifest" error by fixing encrypted manifest decryption logic.
- **OAuth**: Fixed "Missing required parameter: client_id" error by dynamically reloading credentials.
- **Documentation**: Added Troubleshooting section for OAuth Error 403 (App not verified) in `SYNC_SETUP.md`.
- **Documentation**: Added direct link to Setup Guide in `README.md` and included missing screenshots.

## [0.3.2] - 2026-01-19
### Fixed
- **OAuth Authorization**: Resolved "401 invalid_client" error by moving Google OAuth credentials to user-configurable settings.
- **Documentation**: Enhanced `SYNC_SETUP.md` with step-by-step screenshots for Google Cloud Console configuration.
- **README**: Restored and updated screenshots for features.

## [0.3.0] - 2026-01-19
### Added
- **Google Drive Synchronization**: Sync your conversation history across multiple devices securely.
- **End-to-End Encryption**: All synced data is encrypted using AES-256-GCM.
- **Sync Commands**:
  - `Antigravity Storage: Setup Google Drive Sync`
  - `Antigravity Storage: Sync Now`
  - `Antigravity Storage: Manage Synced Conversations`
  - `Antigravity Storage: Disconnect Google Drive Sync`
- **Configuration**:
  - `antigravity-storage-manager.sync.autoSync`: Enable/disable auto-sync.
  - `antigravity-storage-manager.sync.syncInterval`: Set sync interval (default 5 min).
  - `antigravity-storage-manager.sync.showStatusBar`: Toggle status bar sync icon.
- **Documentation**: Added `SYNC_SETUP.md` with detailed setup instructions.

### Changed
- Renamed all command categories from `Antigravity` to `Antigravity Storage` for better organization in the Command Palette.
- Updated `README.md` with sync features and usage instructions.

---

## [0.2.3] - 2026-01-18
### Added
- Initial release of Antigravity Storage Manager.
- Export conversations to ZIP.
- Import conversations from ZIP with conflict resolution.
- Rename conversations.
- Status Bar integration for quick Export/Import.
