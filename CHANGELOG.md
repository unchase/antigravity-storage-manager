# Changelog

All notable changes to the **Antigravity Storage Manager** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.2.3] - 2026-01-18

### Added
- Initial release of Antigravity Storage Manager.
- Export conversations to ZIP.
- Import conversations from ZIP with conflict resolution.
- Rename conversations.
- Status Bar integration for quick Export/Import.
