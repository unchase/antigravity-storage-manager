# Antigravity Storage Manager

<p align="center">
  <img src="https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/banner.png" alt="Antigravity Storage Manager">
</p>

<p align="center">
  <strong>Securely sync Antigravity Conversations with Google Drive. Parallel sync, quota monitoring, local backups, and advanced export/import tools.</strong><br>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=unchase.antigravity-storage-manager">
    <img src="https://img.shields.io/visual-studio-marketplace/v/unchase.antigravity-storage-manager" alt="VS Marketplace Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=unchase.antigravity-storage-manager">
    <img src="https://img.shields.io/visual-studio-marketplace/i/unchase.antigravity-storage-manager" alt="VS Marketplace Installs">
  </a>
  <a href="https://img.shields.io/open-vsx/v/unchase/antigravity-storage-manager">
    <img src="https://img.shields.io/open-vsx/v/unchase/antigravity-storage-manager" alt="Open VSX Version">
  </a>
  <a href="https://open-vsx.org/extension/unchase/antigravity-storage-manager">
    <img src="https://img.shields.io/open-vsx/dt/unchase/antigravity-storage-manager" alt="Open VSX Downloads">
  </a>
  <a href="https://github.com/unchase/antigravity-storage-manager/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/unchase/antigravity-storage-manager" alt="License">
  </a>
</p>

## Support

If you find this extension useful, consider supporting the development:

<a href="https://www.patreon.com/unchase">
  <img src="https://img.shields.io/badge/Patreon-Support-orange?logo=patreon" alt="Support on Patreon">
</a>
<a href="https://www.buymeacoffee.com/nikolaychebotov">
  <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-Support-yellow?logo=buymeacoffee" alt="Buy Me a Coffee">
</a>

---

## Features

![Status Bar Menu](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/screenshots/status-menu.png)

- ☁️ **Google Drive Sync** — Automatically sync conversations between devices with end-to-end encryption.
- ⚡ **Parallel Per-File Sync** — Fast differential sync with parallel processing and hash caching.
- 📦 **Export/Import** — Backup conversations to ZIP archives individually or in bulk with conflict detection.
- 📊 **Account & Quota Dashboard** — Comprehensive real-time tracking of consumption speed, remaining time estimates, and account status.
- 🌍 **Global Localization** — Native support for **15 languages** with 100% dashboard localization coverage (English, Russian, Chinese, Japanese, Korean, German, French, Arabic, and more).
- 🔄 **Live Updates** — Seamlessly syncs data between the status bar and dashboard every minute for up-to-the-second accuracy.
- 🔍 **Account Insights** — Monitor your Plan/Tier, specific feature availability (Web Search, Browser Tool), and raw Google API responses.
- 🚦 **Premium Status Indicators** — Colored icons (🟢/🟡/🟠/🔴) and visual scales `[██░░]` to track quota, model cycles, and sync health at a glance.
- 🛑 **Cancellation Support** — Abort long-running operations (Sync, Export, Backup) safely at any time.
- 🛠️ **Smart Configuration** — Auto-detects missing sync setup and prompts for configuration on startup. Hot-reloads on language changes.
- 🎨 **Command Palette** — All commands available via `Ctrl+Shift+P`

---

## Google Drive Synchronization (New!)

![Sync Statistics Dashboard](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/screenshots/sync-dashboard.png)

Keep your conversations synchronized across multiple machines using your Google Drive.

### Setup Sync
1. Run command `Antigravity Storage: Setup Google Drive Sync`
2. **Authentication**: Log in with your Google account.
3. **Session Setup**:
    - **New Session**: Create a new device entry (e.g., "Work Laptop").
    - **Resume Session**: Reconnect to an existing device ID from the list to avoid duplicates.
4. **Master Password**: Create or confirm your master password to encrypt your data.
5. **Done!** Conversations will automatically sync in the background.

👉 **[Detailed Setup Guide](https://github.com/unchase/antigravity-storage-manager/blob/master/SYNC_SETUP.md)**: Includes step-by-step instructions for configuring Google Cloud Console, adding test users, and troubleshooting.

### Security
- **Zero Knowledge**: All data is encrypted locally before being uploaded.
- **Master Password**: Only you know the password. It is stored securely in your OS keychain.
- **Limited Access**: The extension only accesses files it created (app-specific folder).

### Manual Sync
- Click the **AG Sync** button in the status bar
- Or run `Antigravity Storage: Sync Now`

### Manage Sync
- Click the **AG Sync** button in the status bar to open the menu.
- **Status Bar Tooltip**: Hover over "AG Sync" to see your Last Sync time and session Sync Count.
- **Devices Dashboard**: Run `Antigravity Storage: Show Statistics` (or `Ctrl+Alt+I`) to view the interactive dashboard:
    - **Connected Devices**: Visualize sessions grouped by machine (e.g., "Home PC").
    - **Status Indicators**: See which sessions are **Online** (Green) or **Offline** (Red) based on recent activity.
    - **Quota Tracking**: Monitor quota usage (Credits/Limits) for each active session.
    - **Manage Conversations**: Rename or Delete conversations directly from the list.
    - **Selective Sync**: Manually **Upload** (Local Only) or **Download** (Remote Only) individual conversations.
    - **Visual Analytics**: Interactive pie charts showing sync coverage (Local vs Synced, Remote vs Synced).
    - **Machine Management**:
      - **Delete (🗑️)**: Remove stale machines and their sessions.
      - **Force Push (🔄)**: Send a sync signal to other devices.
    - **User Info**: Displays the current user's email and plan (from Google AI Studio or Google Drive).
    - **Active Transfers**: Monitor ongoing uploads and downloads in real-time. **Click** on any item to open the conversation instantly.
    - **Force Sync (🚀)**: Manually trigger a forceful synchronization that bypasses local caches and flushes server buffers.
    - **Real-time Data**: Information is automatically refreshed during sync events; you can also use the **Refresh Data (🔄)** button to reload manually.
- **Status Bar**: The **AG Sync** icon updates dynamically (☁️ Cloud, 🔄 Spinning, ⚠️ Error, ✅ Check) to reflect the current state.
- **Shortcuts**: Default hotkeys are provided for common actions (e.g., `Ctrl+Alt+S` for Sync Now) and are displayed in the menu.

---

## Account & Quota Dashboard (New!)

![Quota Dashboard](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/images/quota-dashboard.png)

*(Fig. 1: Quota Dashboard showing models sorted by Quota)*

Monitor your AI usage limits and remaining credits directly within VS Code.

### Features
- **Real-time Synchronization**: The dashboard automatically refreshes data every minute, staying perfectly in sync with the status bar.
- **Plan & Tier Analysis**: View your exact plan name and tier description directly from authenticated Google API data.
- **Model Monitoring**: Pin specific models (e.g., Gemini 3 Pro, Claude Sonnet 4.5) to the status bar for quick access.
- **Feature Availability**: Check which tools (Web Search, MCP, Browser) are enabled for your current subscription level.
- **Visual Indicators**: Color-coded status dots (🟢/🟡/🟠/🔴) and high-resolution progress bars show usage at a glance.
- **Cycle Tracking**: High-tier models show a visual time scale `[████░░]` indicating positions within their specific quota cycles.
- **Detailed Statistics**: Precise counters for request usage and token limits for every model.

### Usage
1. Click the **AG Quota** (`AGQ`) indicator in the status bar (or run `Antigravity Quota: Show Quota`).
2. Pin/Unpin models by clicking on them in the menu.
3. The status bar auto-updates every minute.

### Status Bar & Settings

![Quota Tooltip](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/images/quota-tooltip.png)

*(Fig. 2: Rich Tooltip)*

- Hover over the database icon in the status bar to see a rich tooltip with pinned model details.
- Configure which models to pin in your User Settings.

![Quota Settings](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/images/quota-settings.png)

*(Fig. 3: Settings UI)*

---

## MCP Server Monitoring (New!)

![MCP Panel](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/images/mcp-panel.png)

*(Fig. 4: MCP Server Status Panel)*

Monitor your Model Context Protocol (MCP) server connections directly from the Sync Statistics Dashboard.

### Features
- **Connection Status**: Real-time status indicators (🟢 Connected, 🟡 Pending, 🔴 Error, ⚪ Disconnected) for each server.
- **Tool & Resource Overview**: Quickly see the number of tools and resources available on each MCP server.
- **Error Diagnostics**: Detailed error messages are displayed for servers that fail to connect.
- **Manual Refresh**: Reconnect to all configured MCP servers with a single click.

### Configuration
MCP servers are configured in `~/.gemini/antigravity/mcp/mcp_config.json`. The panel will automatically display all servers defined in your configuration.

---

## Proxy Configuration (New!)

If you are behind a corporate proxy, you can configure Antigravity to route its internal requests through your proxy server.

### Setup
1. Open Settings (`Ctrl+,`).
2. Search for `antigravity proxy`.
3. Configure:
    - **Proxy URL**: `http://my-proxy:8080`
    - **Username/Password**: (Optional) For authenticated proxies.
    - **Strict SSL**: Enable/disable certificate verification.
4. Run command `Antigravity: Apply Proxy Settings` to apply these settings to your VS Code profile globally.

> **Note**: This command updates the global `http.proxy` setting in VS Code to ensure the Antigravity Language Server respects your proxy configuration.

---

## Google Account Data (Advanced)

![Google Account Data](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/screenshots/google_account_data.png)

*(Fig. 5: Raw Account Data view)*

For power users and troubleshooting, you can view the raw JSON data received from the Google API. This includes detailed information about your account status, tier details, and all raw model quota limits.

### How to access:
1. Open the **AG Sync** menu from the status bar.
2. Select **Google Account Data**.
3. Or click the **View Raw JSON** button directly from the **Account Information** dashboard.

---

## Conversation Viewer

![Conversation Viewer](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/screenshots/conversation-viewer.png)

Need to review a long conversation without scrolling through the small chat window? Open any conversation in a full-screen, dedicated editor tab.

### Features
- **Distraction-Free Reading**: Full-width view optimized for readability.
- **Rich Markdown Support**: Code blocks, tables, and formatting rendered perfectly.
- **Syntax Highlighting**: Complete language support for all code snippets.
- **Quick Access**: Just click on any conversation in the **Sync Statistics** dashboard or use the `Antigravity Storage: Open Current Conversation` command.

---

## How It Works (Export/Import)

### 1. Quick Access via Status Bar
 
The extension adds **AG Export**, **AG Import**, and **AG Sync** buttons to your VS Code status bar:

![Status Bar Buttons](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/screenshots/status-bar-icons.png)

### 2. Command Palette Integration

All commands are available through the Command Palette (`Ctrl+Shift+P`). Just type "Antigravity Storage" to see all available actions.

![Command Palette](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/screenshots/command-palette.png)

### 3. Multi-Select Export

When exporting, you can select **multiple conversations at once** using the Space key.

![Export Dialog](https://raw.githubusercontent.com/unchase/antigravity-storage-manager/master/screenshots/export-dialog.png)

---

## Advanced Features

### 💾 Local Backup
Worried about the cloud? Create a full local backup anytime.
1. Run `Antigravity Storage: Backup All Conversations`
2. Choose a destination folder.
3. A single ZIP file containing **all** your conversations will be created.

### ⚔️ Conflict Resolution
If you edit the same conversation on two machines offline, a conflict copy is created.
1. Run `Antigravity Storage: Resolve Conflict Copies`
2. Select the conflicting conversation from the list.
3. Choose to **Keep Original** (delete copy) or **Keep Conflict** (overwrite original with copy).

---

## Installation

### From VS Code Marketplace
1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "Antigravity Storage Manager"
4. Click Install

### Requirements
- VS Code 1.96.0 or higher
- Google Account (for synchronization)

## Data Location

Conversations are stored locally in:
- **Brain data:** `~/.gemini/antigravity/brain/`
- **Conversation files:** `~/.gemini/antigravity/conversations/`

Synced data is stored in your Google Drive in the `AntigravitySync` folder.

## Keyboard Shortcuts

The extension comes with default keybindings for common actions:
- `Ctrl+Alt+S` (Windows/Linux) / `Cmd+Alt+S` (Mac): **Sync Now**
- `Ctrl+Alt+I` (Windows/Linux) / `Cmd+Alt+I` (Mac): **Show Sync Statistics**

### Customizing Shortcuts
You can customize these shortcuts to fit your workflow:
1. Open **Keyboard Shortcuts** (`Ctrl+K Ctrl+S`).
2. Type `antigravity` in the search bar.
3. Right-click on any command (e.g., `Antigravity Storage: Import Conversations`) and select **Change Keybinding**.


## Development

### Testing

Run all unit tests:
```bash
npm run test:unit
```

Run localization tests (validates all `package.nls.*.json` and `l10n/bundle.l10n.*.json` files):
```bash
npm run test:localization
```

Or run specific tests:
```bash
npm run test:nls    # Test package.nls.*.json files only
npm run test:l10n   # Test l10n/bundle.l10n.*.json files only
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## License

[MIT](LICENSE) © [unchase](https://github.com/unchase)
