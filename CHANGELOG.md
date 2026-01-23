# Changelog

All notable changes to the **Antigravity Storage Manager** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
