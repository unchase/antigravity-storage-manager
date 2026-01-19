const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: !production,
    minify: production
}).catch(() => process.exit(1));
