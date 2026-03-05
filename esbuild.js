const esbuild = require('esbuild');

const production = process.argv.includes('--production');

const extensionBuild = esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: !production,
    minify: production
});

const mcpBuild = esbuild.build({
    entryPoints: ['src/mcp/proxyMcpServer.ts'],
    bundle: true,
    outfile: 'dist/mcp/proxyMcpServer.js',
    external: ['vscode', 'fsevents'], // MCP server runs in standalone node, but might share code importing vscode types
    format: 'cjs',
    platform: 'node',
    sourcemap: !production,
    minify: production
});

Promise.all([extensionBuild, mcpBuild]).catch(() => process.exit(1));
