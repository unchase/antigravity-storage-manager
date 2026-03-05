const fs = require('fs');
const path = require('path');

const l10nDir = __dirname;
const sourceFile = path.join(l10nDir, 'bundle.l10n.json');

if (!fs.existsSync(sourceFile)) {
    console.error('Source file bundle.l10n.json not found!');
    process.exit(1);
}

const sourceContent = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const sourceKeys = Object.keys(sourceContent).sort();

const files = fs.readdirSync(l10nDir).filter(f => f.startsWith('bundle.l10n.') && f.endsWith('.json') && f !== 'bundle.l10n.json');

console.log(`Source keys count: ${sourceKeys.length}`);

files.forEach(file => {
    const filePath = path.join(l10nDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const keys = Object.keys(content);

    const missingKeys = sourceKeys.filter(k => !content.hasOwnProperty(k));
    const extraKeys = keys.filter(k => !sourceContent.hasOwnProperty(k));

    console.log(`\nChecking ${file}:`);
    console.log(`  Keys: ${keys.length}`);
    if (missingKeys.length > 0) {
        console.log(`  MISSING keys (${missingKeys.length}):`);
        missingKeys.forEach(k => console.log(`    - "${k}"`));
    } else {
        console.log(`  No missing keys.`);
    }

    if (extraKeys.length > 0) {
        console.log(`  EXTRA keys (${extraKeys.length}):`);
        // Limit output for extra keys if too many
        if (extraKeys.length > 10) {
            extraKeys.slice(0, 10).forEach(k => console.log(`    - "${k}"`));
            console.log(`    ... and ${extraKeys.length - 10} more`);
        } else {
            extraKeys.forEach(k => console.log(`    - "${k}"`));
        }
    }
});
