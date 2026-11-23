# Contributing to Antigravity Storage Manager

Thank you for your interest in contributing to this VS Code extension!

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/)
- [VS Code](https://code.visualstudio.com/)

## Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/unchase/antigravity-storage-manager.git
   cd antigravity-storage-manager
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

   If standard `npm install` fails in your environment, use these commands to build manually:

      ```bash
   npm install --ignore-scripts
   npm install @esbuild/win32-x64 --ignore-scripts --save-optional
   node esbuild.js
   node node_modules/@vscode/vsce/vsce package --no-dependencies
   ```

3. **Build the extension:**
   ```bash
   npm run compile
   ```

## Development Workflow

1. Open the project folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Make changes to the source code
4. Reload the Extension Development Host to test changes

## Testing

This project uses **Jest** for unit testing.

- **Run Full Check (TypeScript, ESLint & Unit Tests):**
  ```bash
  npm run check
  ```

- **Run Unit Tests:**
  ```bash
  npm run test:unit
  ```

- **Run Linting:**
  ```bash
  npm run lint
  ```

- **Run Localization Tests:**
  ```bash
  npm run test:localization
  ```

Please ensure all checks and tests pass with no lint or localization errors before submitting a PR.

## Internationalization (i18n)

This extension supports **16 languages**: `en`, `ru`, `ar`, `cs`, `de`, `es`, `fr`, `it`, `ja`, `ko`, `pl`, `pt-br`, `tr`, `vi`, `zh-cn`, `zh-tw`.

When adding new user-facing strings:

1. For manifest strings (`package.json`): add the key and default English text to `package.nls.json`, translate it in all `package.nls.<lang>.json` files, and reference it as `%key%` in `package.json`.
2. For runtime strings (TypeScript): use `LocalizationManager.getInstance().t(...)` and add the key/translations to `l10n/bundle.l10n.json` and all `l10n/bundle.l10n.<lang>.json` files.
3. Verify localization completeness before submitting a PR:
   ```bash
   npm run sync:localization
   npm run test:localization
   ```

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Build with esbuild (development) |
| `npm run compile:production` | Build with esbuild (production, minified) |
| `npm run watch` | Watch mode for TypeScript |
| `npm run check` | Run TypeScript typecheck (`tsc --noEmit`), ESLint, and unit tests |
| `npm run test:unit` | Run unit tests with Jest (`--maxWorkers=2`) |
| `npm run test:localization` | Validate all `package.nls.*.json` and `l10n/bundle.l10n.*.json` bundles |
| `npm run sync:localization` | Check/sync missing NLS and l10n keys across all 16 locales |
| `npm run lint` | Run ESLint |
| `npm run package` | Production build and package `.vsix` |
| `npm run release:local` | Local build and GitHub release helper |
| `npm run mcp` | Start the built-in Antigravity Proxy MCP server |

## Packaging

To create a `.vsix` file:
```bash
npm run package
```

## Pull Request Guidelines

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. **Run checks** (`npm run check` and `npm run test:localization`) and ensure code quality
5. Commit with clear English messages
6. Push and create a Pull Request

## Project Structure

```
├── src/
│   ├── extension.ts        # Main entry point & commands
│   ├── sync.ts             # SyncManager logic
│   ├── localStorage.ts     # Local filesystem sync provider
│   ├── googleDrive.ts      # Google Drive sync provider
│   ├── googleAuth.ts       # Google OAuth2 handling
│   ├── ideState.ts         # IDE state.vscdb export/import & reindexing
│   ├── profileManager.ts   # Multi-account profile switching
│   ├── backup.ts           # Local ZIP backup logic
│   ├── conflicts.ts        # Conflict resolution
│   ├── crypto.ts           # AES-256-GCM encryption utilities
│   ├── markdownExporter.ts # Conversation Markdown export
│   ├── quota/              # Process/port detection (agy & language_server), quota service, status bar & webviews
│   ├── proxy/              # Antigravity Proxy manager & dashboard webview
│   ├── mcp/                # Built-in Antigravity Proxy MCP server
│   ├── telegram/           # Telegram bot integration & stats scheduler
│   ├── l10n/               # LocalizationManager
│   ├── diagnostics/        # DiagnosticsManager
│   └── test/               # Unit tests & API explorers
├── l10n/                   # Runtime translation bundles (16 languages)
├── dist/                   # Compiled output
├── package.json            # Extension manifest
├── package.nls*.json       # Manifest translations (16 languages)
├── jest.config.js          # Jest configuration
└── eslint.config.mjs       # ESLint configuration
```

## Questions?

Open an issue on GitHub if you have questions or suggestions.
