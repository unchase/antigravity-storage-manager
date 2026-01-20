# Antigravity Storage Manager

<p align="center">
  <img src="banner.png" alt="Antigravity Storage Manager">
</p>

<p align="center">
  <strong>Export and Import Antigravity/Cline conversation history with a single click.</strong><br>
  Backup your AI conversations to zip files and restore them anytime.
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

---

## Features

- ☁️ **Google Drive Sync** — Automatically sync conversations between devices
- 🔒 **End-to-End Encryption** — All synced data is encrypted using AES-256-GCM
- ⚡ **Smart Per-File Sync** — Only changed files are synced, not entire archives. Hash caching and parallel uploads for maximum speed.
- 📦 **Export Conversations** — Select one or multiple conversations and save them to a ZIP archive
- 💾 **Local Backup** — One-click backup of ALL conversations to a single local archive
- 📥 **Import Conversations** — Restore conversations from ZIP archives
- ✏️ **Rename Conversations** — Change conversation titles directly from VS Code
- ⚔️ **Advanced Conflict Resolution** — UI to manually resolve synchronization conflicts (Keep Local vs. Keep Remote)
- 🎯 **Status Bar Integration** — Quick access to Export, Import, and Sync
- 🎨 **Command Palette** — All commands available via `Ctrl+Shift+P`

---

## Google Drive Synchronization (New!)

Keep your conversations synchronized across multiple machines using your Google Drive.

### Setup Sync
1. Run command `Antigravity Storage: Setup Google Drive Sync`
2. **Create a Master Password**: This password is used to encrypt your data. You must use the same password on all machines.
3. **Authenticate**: Log in with your Google account.
4. **Done!** Conversations will automatically sync in the background.

👉 **[Detailed Setup Guide](SYNC_SETUP.md)**: Includes step-by-step instructions for configuring Google Cloud Console, adding test users, and troubleshooting.

### Security
- **Zero Knowledge**: All data is encrypted locally before being uploaded.
- **Master Password**: Only you know the password. It is stored securely in your OS keychain.
- **Limited Access**: The extension only accesses files it created (app-specific folder).

### Manual Sync
- Click the **AG Sync** button in the status bar
- Or run `Antigravity Storage: Sync Now`

### Manage Sync
- Run `Antigravity Storage: Manage Synced Conversations` to choose which conversations to sync.
- Default: All conversations are synchronized.

---

## How It Works (Export/Import)

### 1. Quick Access via Status Bar
 
The extension adds **AG Export**, **AG Import**, and **AG Sync** buttons to your VS Code status bar:

![Status Bar Buttons](screenshots/status-bar.png)

### 2. Command Palette Integration

All commands are available through the Command Palette (`Ctrl+Shift+P`). Just type "Antigravity Storage" to see all available actions.

![Command Palette](screenshots/command-palette.png)

### 3. Multi-Select Export

When exporting, you can select **multiple conversations at once** using the Space key.

![Export Dialog](screenshots/export-dialog.png)

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## License

[MIT](LICENSE) © [unchase](https://github.com/unchase)
