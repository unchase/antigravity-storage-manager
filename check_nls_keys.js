const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, 'package.json');
const packageNlsPath = path.join(__dirname, 'package.nls.json');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const packageNls = JSON.parse(fs.readFileSync(packageNlsPath, 'utf8'));

// 1. Extract used keys from package.json
const usedKeys = new Set();
function scanForKeys(obj) {
    if (typeof obj === 'string') {
        const match = obj.match(/^%([^%]+)%$/);
        if (match) {
            usedKeys.add(match[1]);
        }
    } else if (typeof obj === 'object' && obj !== null) {

        for (const key in obj) {
            scanForKeys(obj[key]);
        }
    }
}
scanForKeys(packageJson);
console.log(`Found ${usedKeys.size} used keys in package.json`);

// 2. Check for unused keys in package.nls.json

const definedKeys = Object.keys(packageNls);
const unusedKeys = definedKeys.filter(key => !usedKeys.has(key));

console.log('--- Unused keys in package.nls.json (not referenced in package.json) ---');
if (unusedKeys.length > 0) {
    unusedKeys.forEach(key => console.log(key));
} else {
    console.log('None');
}

// 3. Check other package.nls.*.json files
const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.startsWith('package.nls.') && f.endsWith('.json') && f !== 'package.nls.json');

console.log('\n--- checking other package.nls.*.json files ---');
files.forEach(file => {
    const filePath = path.join(dir, file);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const keys = Object.keys(content);

    // Keys in this file but not in main nls (extras)
    const extraKeys = keys.filter(k => !definedKeys.includes(k));

    // Keys in main nls but not in this file (missing)
    const missingKeys = definedKeys.filter(k => !keys.includes(k));

    // Unused keys (from step 2) that are present in this file
    const unusedInFile = keys.filter(k => unusedKeys.includes(k));

    if (extraKeys.length > 0 || missingKeys.length > 0 || unusedInFile.length > 0) {
        console.log(`\nResults for ${file}:`);
        if (extraKeys.length > 0) {
            console.log(`  Extra keys (not in package.nls.json):`);
            extraKeys.forEach(k => console.log(`    ${k}`));
        }
        if (missingKeys.length > 0) {
            console.log(`  Missing keys (present in package.nls.json but missing here):`);
            missingKeys.forEach(k => console.log(`    ${k}`));
        }
        if (unusedInFile.length > 0) {
            console.log(`  Unused keys (present here but not used in package.json):`);
            unusedInFile.forEach(k => console.log(`    ${k}`));
        }
    } else {
        console.log(`${file}: OK`);
    }
});
