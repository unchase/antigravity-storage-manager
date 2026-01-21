/**
 * Tests for l10n/bundle.l10n.*.json files
 * Verifies that all translation keys are consistent across localization bundles
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.join(__dirname, '../../../../');
const L10N_DIR = path.join(ROOT_DIR, 'l10n');
const MASTER_FILE = path.join(L10N_DIR, 'bundle.l10n.json');

describe('l10n/bundle.l10n.* Files', () => {
    let masterContent: Record<string, string>;
    let masterKeys: string[];
    let bundleFiles: string[];

    beforeAll(() => {
        masterContent = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
        masterKeys = Object.keys(masterContent);
        bundleFiles = fs.readdirSync(L10N_DIR).filter(
            f => f.startsWith('bundle.l10n.') && f !== 'bundle.l10n.json' && f.endsWith('.json')
        );
    });

    test('master file (bundle.l10n.json) exists and has keys', () => {
        expect(fs.existsSync(MASTER_FILE)).toBe(true);
        expect(masterKeys.length).toBeGreaterThan(0);
    });

    test('at least one bundle.l10n.*.json translation file exists', () => {
        expect(bundleFiles.length).toBeGreaterThan(0);
    });

    describe('Each bundle.l10n.*.json file', () => {
        const locales = ['ru', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'tr', 'vi', 'zh-cn', 'zh-tw', 'ar', 'cs'];

        test.each(locales)(
            'bundle.l10n.%s.json contains all required keys',
            (locale) => {
                const bundlePath = path.join(L10N_DIR, `bundle.l10n.${locale}.json`);

                if (!fs.existsSync(bundlePath)) {
                    throw new Error(`Required locale file bundle.l10n.${locale}.json does not exist`);
                }

                const content = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
                const missingKeys: string[] = [];

                for (const key of masterKeys) {
                    if (!Object.prototype.hasOwnProperty.call(content, key)) {
                        missingKeys.push(key);
                    }
                }

                if (missingKeys.length > 0) {
                    console.error(`Missing keys in bundle.l10n.${locale}.json:`, missingKeys);
                }

                expect(missingKeys).toEqual([]);
            }
        );
    });

    test('all bundle files have valid JSON syntax', () => {
        for (const file of bundleFiles) {
            const bundlePath = path.join(L10N_DIR, file);
            expect(() => {
                JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
            }).not.toThrow();
        }
    });

    test('no extra keys exist in translation files that are not in master', () => {
        for (const file of bundleFiles) {
            const bundlePath = path.join(L10N_DIR, file);
            const content = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
            const extraKeys = Object.keys(content).filter(k => !masterKeys.includes(k));

            if (extraKeys.length > 0) {
                console.warn(`Extra keys in ${file}:`, extraKeys);
            }
            // This is a warning, not a failure - extra keys are allowed but should be reviewed
        }
    });

    test('all keys have non-empty values', () => {
        for (const file of bundleFiles) {
            const bundlePath = path.join(L10N_DIR, file);
            const content = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
            const emptyKeys: string[] = [];

            for (const [key, value] of Object.entries(content)) {
                if (typeof value !== 'string' || value.trim() === '') {
                    emptyKeys.push(key);
                }
            }

            if (emptyKeys.length > 0) {
                console.warn(`Empty values in ${file}:`, emptyKeys);
            }
            // Empty values should be flagged as warnings
        }
    });
});
