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

3. **Build the extension:**
   ```bash
   npm run compile
   ```

## Development Workflow

1. Open the project folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Make changes to `src/extension.ts`
4. Reload the Extension Development Host to test changes

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Build with esbuild (development) |
| `npm run compile:production` | Build with esbuild (production, minified) |
| `npm run watch` | Watch mode for TypeScript |

## Packaging

To create a `.vsix` file:
```bash
node node_modules/@vscode/vsce/vsce package --no-dependencies
```

## Pull Request Guidelines

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test thoroughly using F5
5. Commit with clear messages
6. Push and create a Pull Request

## Project Structure

```
├── src/
│   └── extension.ts    # Main extension code
├── dist/               # Compiled output (esbuild bundle)
├── package.json        # Extension manifest
├── esbuild.js          # Build configuration
└── tsconfig.json       # TypeScript configuration
```

## Questions?

Open an issue on GitHub if you have questions or suggestions.
