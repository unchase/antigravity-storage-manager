const fs = require('fs');
const path = require('path');

const l10nDir = __dirname;
const sourceFile = path.join(l10nDir, 'bundle.l10n.json');
const sourceContent = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

const files = fs.readdirSync(l10nDir).filter(f => f.startsWith('bundle.l10n.') && f.endsWith('.json') && f !== 'bundle.l10n.json');

console.log('Checking for untranslated keys (value === english value)...');

const missingTranslations = {};

files.forEach(file => {
    const lang = file.replace('bundle.l10n.', '').replace('.json', '');
    const filePath = path.join(l10nDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const missing = {};
    let count = 0;

    // Skip English
    if (lang === 'en' || lang === 'json') return;

    Object.keys(content).forEach(key => {
        // loose check: if value is identical to English source
        // And length > 2
        // And not purely a placeholder or proper noun (heuristic)
        if (sourceContent[key] && content[key] === sourceContent[key] && content[key].length > 2) {
            missing[key] = sourceContent[key];
            count++;
        }
    });

    if (count > 0) {
        missingTranslations[lang] = missing;
    }
});

fs.writeFileSync(path.join(l10nDir, 'missing_translations.json'), JSON.stringify(missingTranslations, null, 2));
console.log('Generated l10n/missing_translations.json');
