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
   npm install --ignore-scripts
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

- **Run Unit Tests:**
  ```bash
  npm run test:unit
  ```

- **Run Linting:**
  ```bash
  npm run lint
  ```

Please ensure all tests pass and there are no lint errors before submitting a PR.

## Internationalization (i18n)

This extension supports multiple languages (currently English and Russian).
When adding new user-facing strings:

1. Add the string ID and default English text to `package.nls.json`.
2. Add the Russian translation to `package.nls.ru.json`.
3. Use `%key%` format in `package.json`.
4. Use `vscode.l10n.t()` in TypeScript code.

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Build with esbuild (development) |
| `npm run compile:production` | Build with esbuild (production, minified) |
| `npm run watch` | Watch mode for TypeScript |
| `npm run test:unit` | Run unit tests with Jest |
| `npm run lint` | Run ESLint |

## Packaging

To create a `.vsix` file:
```bash
node node_modules/@vscode/vsce/vsce package --no-dependencies
```

## Pull Request Guidelines

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. **Run tests** and ensure code quality
5. Commit with clear messages
6. Push and create a Pull Request

## Project Structure

```
├── src/
│   ├── extension.ts    # Main entry point
│   ├── sync.ts         # SyncManager logic
│   ├── backup.ts       # BackupManager logic
│   ├── conflicts.ts    # Conflict resolution
│   ├── crypto.ts       # Encryption utilities
│   ├── googleAuth.ts   # OAuth handling
│   ├── googleDrive.ts  # Drive API interaction
│   └── test/           # Test files
├── dist/               # Compiled output
├── package.json        # Extension manifest
├── package.nls.json    # English strings
├── package.nls.ru.json # Russian strings
└── jest.config.js      # Jest configuration
```

## Questions?

Open an issue on GitHub if you have questions or suggestions.
