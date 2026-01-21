const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const masterFile = path.join(rootDir, 'package.nls.json');
const masterContent = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
const masterKeys = Object.keys(masterContent);

const files = fs.readdirSync(rootDir).filter(f => f.startsWith('package.nls.') && f !== 'package.nls.json' && f.endsWith('.json'));

let changes = false;

files.forEach(file => {
    const nlsPath = path.join(rootDir, file);
    let content = {};
    try {
        content = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));
    } catch (e) {
        console.error(`Error reading ${file}:`, e);
    }

    let fileChanged = false;

    masterKeys.forEach(key => {
        if (!content.hasOwnProperty(key)) {
            content[key] = masterContent[key];
            fileChanged = true;
            console.log(`[${file}] Added missing key: ${key}`);
        }
    });

    if (fileChanged) {
        fs.writeFileSync(nlsPath, JSON.stringify(content, null, 4));
        changes = true;
    }
});

if (!changes) {
    console.log("No missing keys found in any package.nls.*.json files.");
}
