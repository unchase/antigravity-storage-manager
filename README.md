# Antigravity Storage Manager

**Export and Import your Antigravity/Cline conversation history with a single click.**

![VS Code](https://img.shields.io/badge/VS%20Code-1.96+-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## Features

- 📤 **Export Conversations** — Save any conversation to a `.zip` archive
- 📥 **Import Conversations** — Restore conversations from backup files
- 🔄 **Status Bar Buttons** — Quick access from the bottom status bar
- 🎯 **Command Palette** — Access via `Ctrl+Shift+P` → "AG: Export/Import"
- ⚡ **Pure JavaScript** — No PowerShell or external tools required

## Usage

### Export a Conversation

1. Click **"AG Export"** in the status bar (bottom right), or
2. Press `Ctrl+Shift+P` and type "AG: Export Conversation"
3. Select a conversation from the list
4. Choose where to save the `.zip` file

### Import a Conversation

1. Click **"AG Import"** in the status bar (bottom right), or
2. Press `Ctrl+Shift+P` and type "AG: Import Conversation"
3. Select a `.zip` archive created by this extension
4. Reload VS Code when prompted

## Installation

### From VSIX

1. Download the latest `.vsix` file
2. In VS Code, press `Ctrl+Shift+X` (Extensions)
3. Click `...` → "Install from VSIX..."
4. Select the downloaded file

### From Source

```bash
git clone https://github.com/unchase/antigravity-storage-manager.git
cd antigravity-storage-manager
npm install
npm run package
```

## Requirements

- VS Code 1.96.0 or higher
- Antigravity, Cline, or Claude Dev extension

## Where are conversations stored?

This extension works with the standard Antigravity storage location:

```
~/.gemini/antigravity/
├── brain/           # Conversation metadata and artifacts
│   └── <conv-id>/
└── conversations/   # Conversation message data
    └── <conv-id>.pb
```

## License

MIT © [unchase](https://github.com/unchase)
