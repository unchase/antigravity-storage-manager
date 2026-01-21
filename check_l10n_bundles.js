const fs = require('fs');
const path = require('path');

const l10nDir = path.join(__dirname, 'l10n');
const masterFile = path.join(l10nDir, 'bundle.l10n.json');

if (!fs.existsSync(masterFile)) {
    console.error('Master file not found:', masterFile);
    process.exit(1);
}

const masterContent = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
const masterKeys = Object.keys(masterContent);

const files = fs.readdirSync(l10nDir).filter(f => f.startsWith('bundle.l10n.') && f !== 'bundle.l10n.json' && f.endsWith('.json'));

let totalChanges = 0;

files.forEach(file => {
    const filePath = path.join(l10nDir, file);
    let content = {};
    try {
        content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error(`Error reading ${file}:`, e);
        return;
    }

    let fileChanged = false;
    let addedKeysCount = 0;

    masterKeys.forEach(key => {
        if (!content.hasOwnProperty(key)) {
            content[key] = masterContent[key];
            fileChanged = true;
            addedKeysCount++;
        }
    });

    if (fileChanged) {
        // Sort keys to match master order if possible, or just append
        const newContent = {};
        masterKeys.forEach(key => {
            if (content.hasOwnProperty(key)) {
                newContent[key] = content[key];
            }
        });

        // Add any extra keys that might be in the file but not in master
        Object.keys(content).forEach(key => {
            if (!newContent.hasOwnProperty(key)) {
                newContent[key] = content[key];
            }
        });

        fs.writeFileSync(filePath, JSON.stringify(newContent, null, 4) + '\n');
        console.log(`[${file}] Added ${addedKeysCount} missing keys.`);
        totalChanges++;
    }
});

if (totalChanges === 0) {
    console.log("No missing keys found in any bundle.l10n.*.json files.");
} else {
    console.log(`Updated ${totalChanges} bundle files.`);
}
