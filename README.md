# Antigravity Storage Manager

<p align="center">
  <img src="banner.png" alt="Antigravity Storage Manager">
</p>

<p align="center">
  <strong>Export and Import Antigravity/Cline conversation history with a single click.</strong><br>
  Backup your AI conversations to zip files and restore them anytime.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=antigravity.antigravity-storage-manager">
    <img src="https://img.shields.io/visual-studio-marketplace/v/antigravity.antigravity-storage-manager" alt="VS Marketplace Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=antigravity.antigravity-storage-manager">
    <img src="https://img.shields.io/visual-studio-marketplace/i/antigravity.antigravity-storage-manager" alt="VS Marketplace Installs">
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

- 📦 **Export Conversations** — Select one or multiple conversations and save them to a ZIP archive
- 📥 **Import Conversations** — Restore conversations from ZIP archives with conflict resolution
- ✏️ **Rename Conversations** — Change conversation titles directly from VS Code
- 🔄 **Conflict Resolution** — Choose to Overwrite, Rename, or Skip when importing duplicates
- 🎯 **Status Bar Integration** — Quick access buttons in the VS Code status bar
- 🎨 **Command Palette** — All commands available via `Ctrl+Shift+P`

---

## How It Works

### 1. Quick Access via Status Bar

The extension adds **AG Export** and **AG Import** buttons to your VS Code status bar for one-click access:

![Status Bar Buttons](screenshots/status-bar.png)

### 2. Command Palette Integration

All commands are available through the Command Palette (`Ctrl+Shift+P`). Just type "Antigravity" to see all available actions:

![Command Palette](screenshots/command-palette.png)

### 3. Multi-Select Export

When exporting, you can select **multiple conversations at once** using the Space key. The list shows conversation IDs and their last modification dates:

![Export Dialog](screenshots/export-dialog.png)

---

## Installation

### From VS Code Marketplace
1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "Antigravity Storage Manager"
4. Click Install

### From VSIX
1. Download the `.vsix` file from [Releases](https://github.com/unchase/antigravity-storage-manager/releases)
2. Open VS Code
3. Press `Ctrl+Shift+P` → "Extensions: Install from VSIX..."
4. Select the downloaded file

---

## Usage

### Export Conversations
1. Press `Ctrl+Shift+P` and type "Antigravity: Export Conversations"
2. Select one or more conversations (use Space to multi-select)
3. Choose save location for the ZIP file

### Import Conversations
1. Press `Ctrl+Shift+P` and type "Antigravity: Import Conversations"
2. Select one or more ZIP files
3. If a conversation already exists, choose: **Overwrite**, **Rename**, or **Skip**

### Rename Conversation
1. Press `Ctrl+Shift+P` and type "Antigravity: Rename Conversation"
2. Select the conversation to rename
3. Enter the new title

---

## Requirements

- VS Code 1.96.0 or higher
- Antigravity or Cline extension (optional, for sidebar integration)

## Data Location

Conversations are stored in:
- **Brain data:** `~/.gemini/antigravity/brain/`
- **Conversation files:** `~/.gemini/antigravity/conversations/`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

## License

[MIT](LICENSE) © [unchase](https://github.com/unchase)
