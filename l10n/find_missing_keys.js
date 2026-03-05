const fs = require('fs');
const path = require('path');

const l10nDir = __dirname;
const sourceFile = path.join(l10nDir, 'bundle.l10n.json');
const sourceContent = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const sourceKeys = Object.keys(sourceContent);

const files = fs.readdirSync(l10nDir).filter(f => f.startsWith('bundle.l10n.') && f.endsWith('.json') && f !== 'bundle.l10n.json');

const report = {};

files.forEach(file => {
    const lang = file.replace('bundle.l10n.', '').replace('.json', '');
    const filePath = path.join(l10nDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const targetKeys = Object.keys(content);

    const missing = sourceKeys.filter(key => !targetKeys.includes(key));
    const sameAsEnglish = sourceKeys.filter(key => targetKeys.includes(key) && content[key] === sourceContent[key] && content[key].length > 2);

    if (missing.length > 0 || sameAsEnglish.length > 0) {
        report[lang] = {
            missing,
            sameAsEnglish
        };
    }
});

fs.writeFileSync(path.join(l10nDir, 'localization_report.json'), JSON.stringify(report, null, 2));
console.log('Report generated in l10n/localization_report.json');
