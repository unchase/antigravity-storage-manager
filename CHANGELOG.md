# Changelog

All notable changes to the **Antigravity Storage Manager** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
