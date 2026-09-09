const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd, options = {}) {
    console.log(`> ${cmd}`);
    return execSync(cmd, { stdio: 'inherit', ...options });
}

function runCapture(cmd, options = {}) {
    return execSync(cmd, { encoding: 'utf8', ...options }).trim();
}

function findGhCli() {
    try {
        execSync('gh --version', { stdio: 'ignore' });
        return 'gh';
    } catch {
        const standardPath = 'C:\\Program Files\\GitHub CLI\\gh.exe';
        if (fs.existsSync(standardPath)) {
            return `"${standardPath}"`;
        }
        throw new Error('GitHub CLI (gh) not found in PATH or at default installation path.');
    }
}

async function main() {
    const rootDir = __dirname;
    const pkgPath = path.join(rootDir, 'package.json');
    const changelogPath = path.join(rootDir, 'CHANGELOG.md');

    if (!fs.existsSync(pkgPath)) {
        console.error('package.json not found');
        process.exit(1);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const version = pkg.version;
    const tag = `v${version}`;
    console.log(`=== Releasing Antigravity Storage Manager ${tag} locally ===`);

    const gh = findGhCli();
    console.log(`Using GitHub CLI: ${gh}`);

    // 1. Extract Release Notes from CHANGELOG.md
    let releaseNotes = '';
    if (fs.existsSync(changelogPath)) {
        const changelog = fs.readFileSync(changelogPath, 'utf8');
        const lines = changelog.split('\n');
        let capturing = false;
        const capturedLines = [];

        const versionHeaderRegex = new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`);
        for (const line of lines) {
            if (versionHeaderRegex.test(line)) {
                capturing = true;
                continue;
            } else if (capturing && line.startsWith('## [')) {
                break;
            }
            if (capturing) {
                capturedLines.push(line);
            }
        }
        const body = capturedLines.join('\n').trim();
        releaseNotes = `## Antigravity Storage Manager ${tag}\n\n${body}`;
    }

    if (!releaseNotes) {
        releaseNotes = `Release ${tag}`;
    }

    // 2. Build production bundle & package VSIX
    console.log('\n--- Building and Packaging VSIX ---');
    run('npm run compile:production', { cwd: rootDir });
    run('npx @vscode/vsce package --no-dependencies', { cwd: rootDir });

    const vsixFiles = fs.readdirSync(rootDir).filter(f => f.endsWith('.vsix') && f.includes(version));
    if (vsixFiles.length === 0) {
        console.error(`Error: No .vsix file found for version ${version}`);
        process.exit(1);
    }
    const vsixFile = vsixFiles[0];
    const vsixPath = path.join(rootDir, vsixFile);
    console.log(`Packaged artifact: ${vsixFile}`);

    // 3. Ensure git tag exists and is pushed
    console.log('\n--- Checking Git Tag ---');
    const existingTags = runCapture('git tag --list', { cwd: rootDir }).split('\n').map(t => t.trim());
    if (!existingTags.includes(tag)) {
        console.log(`Creating git tag ${tag}...`);
        run(`git tag ${tag}`, { cwd: rootDir });
        run(`git push origin ${tag}`, { cwd: rootDir });
    } else {
        console.log(`Tag ${tag} already exists locally.`);
    }

    // 4. Create or update GitHub Release using gh CLI
    console.log('\n--- Publishing Release to GitHub ---');
    const tempNotesFile = path.join(rootDir, '.release_notes_tmp.md');
    fs.writeFileSync(tempNotesFile, releaseNotes, 'utf8');

    let commitMsg = '';
    try {
        commitMsg = runCapture('git log -1 --format=%s', { cwd: rootDir });
    } catch {
        commitMsg = `Release ${tag}`;
    }

    try {
        let releaseExists = false;
        try {
            execSync(`${gh} release view ${tag}`, { stdio: 'ignore', cwd: rootDir });
            releaseExists = true;
        } catch {
            releaseExists = false;
        }

        if (releaseExists) {
            console.log(`Release ${tag} already exists on GitHub, updating assets and notes...`);
            run(`${gh} release upload ${tag} "${vsixPath}" --clobber`, { cwd: rootDir });
            run(`${gh} release edit ${tag} --title "${tag} - ${commitMsg}" --notes-file "${tempNotesFile}"`, { cwd: rootDir });
        } else {
            console.log(`Creating new release ${tag} on GitHub...`);
            run(`${gh} release create ${tag} "${vsixPath}" --title "${tag} - ${commitMsg}" --notes-file "${tempNotesFile}"`, { cwd: rootDir });
        }
        console.log(`\n🎉 Success! Release ${tag} published to GitHub without using GitHub Actions minutes:`);
        console.log(`https://github.com/unchase/antigravity-storage-manager/releases/tag/${tag}`);
    } finally {
        if (fs.existsSync(tempNotesFile)) {
            fs.unlinkSync(tempNotesFile);
        }
    }
}

main().catch(err => {
    console.error('Release failed:', err.message);
    process.exit(1);
});
