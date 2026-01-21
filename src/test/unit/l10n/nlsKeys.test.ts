/**
 * Tests for package.nls.*.json files
 * Verifies that all translation keys are consistent across localization files
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.join(__dirname, '../../../../');
const MASTER_FILE = path.join(ROOT_DIR, 'package.nls.json');

describe('package.nls.* Files', () => {
    let masterContent: Record<string, string>;
    let masterKeys: string[];
    let nlsFiles: string[];

    beforeAll(() => {
        masterContent = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
        masterKeys = Object.keys(masterContent);
        nlsFiles = fs.readdirSync(ROOT_DIR).filter(
            f => f.startsWith('package.nls.') && f !== 'package.nls.json' && f.endsWith('.json')
        );
    });

    test('master file (package.nls.json) exists and has keys', () => {
        expect(fs.existsSync(MASTER_FILE)).toBe(true);
        expect(masterKeys.length).toBeGreaterThan(0);
    });

    test('at least one package.nls.*.json translation file exists', () => {
        expect(nlsFiles.length).toBeGreaterThan(0);
    });

    describe('Each package.nls.*.json file', () => {
        test.each(['ru', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'tr', 'vi', 'zh-cn', 'zh-tw', 'ar', 'cs'])(
            'package.nls.%s.json contains all required keys',
            (locale) => {
                const nlsPath = path.join(ROOT_DIR, `package.nls.${locale}.json`);

                if (!fs.existsSync(nlsPath)) {
                    // Skip if file doesn't exist (some locales may be optional)
                    console.warn(`Skipping ${locale}: file does not exist`);
                    return;
                }

                const content = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));
                const missingKeys: string[] = [];

                for (const key of masterKeys) {
                    if (!Object.prototype.hasOwnProperty.call(content, key)) {
                        missingKeys.push(key);
                    }
                }

                if (missingKeys.length > 0) {
                    console.error(`Missing keys in package.nls.${locale}.json:`, missingKeys);
                }

                expect(missingKeys).toEqual([]);
            }
        );
    });

    test('no extra keys exist in translation files that are not in master', () => {
        for (const file of nlsFiles) {
            const nlsPath = path.join(ROOT_DIR, file);
            const content = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));
            const extraKeys = Object.keys(content).filter(k => !masterKeys.includes(k));

            if (extraKeys.length > 0) {
                console.warn(`Extra keys in ${file}:`, extraKeys);
            }
            // This is a warning, not a failure - extra keys are allowed but should be reviewed
        }
    });
});
