import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('vscode', () => ({
    l10n: {
        t: (str: string, ...args: any[]) => str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')
    },
    window: {
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        withProgress: jest.fn()
    },
    workspace: {
        getConfiguration: jest.fn(() => ({ get: jest.fn() }))
    },
    CancellationError: class CancellationError extends Error {
        constructor() { super('Cancelled'); }
    }
}), { virtual: true });

import {
    isValidSqliteFile,
    validateExtractedDirectory,
    replaceSqliteFileSafely
} from '../../ideState';

describe('IDE State Security & SQLite Safety', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-idestate-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('isValidSqliteFile validates SQLite magic header', () => {
        const validFile = path.join(tempDir, 'valid.vscdb');
        const header = Buffer.from('SQLite format 3\0extra-sqlite-pages');
        fs.writeFileSync(validFile, header);
        expect(isValidSqliteFile(validFile)).toBe(true);

        const invalidFile = path.join(tempDir, 'corrupt.vscdb');
        fs.writeFileSync(invalidFile, 'NOT_A_DATABASE_FILE');
        expect(isValidSqliteFile(invalidFile)).toBe(false);

        const missingFile = path.join(tempDir, 'missing.vscdb');
        expect(isValidSqliteFile(missingFile)).toBe(false);
    });

    test('replaceSqliteFileSafely rejects corrupt SQLite and cleans old -wal/-shm on valid replace', () => {
        const destFile = path.join(tempDir, 'state.vscdb');
        const destWal = `${destFile}-wal`;
        const destShm = `${destFile}-shm`;
        fs.writeFileSync(destFile, Buffer.from('SQLite format 3\0old-data'));
        fs.writeFileSync(destWal, 'stale-wal');
        fs.writeFileSync(destShm, 'stale-shm');

        // Corrupt source must fail and leave existing DB untouched
        const corruptSrc = path.join(tempDir, 'bad.vscdb');
        fs.writeFileSync(corruptSrc, 'garbage');
        expect(() => replaceSqliteFileSafely(corruptSrc, destFile)).toThrow(/Invalid SQLite/i);
        expect(fs.readFileSync(destFile).toString()).toContain('old-data');

        // Valid source replaces DB and deletes stale -wal and -shm
        const goodSrc = path.join(tempDir, 'good.vscdb');
        fs.writeFileSync(goodSrc, Buffer.from('SQLite format 3\0new-clean-data'));
        replaceSqliteFileSafely(goodSrc, destFile);

        expect(fs.readFileSync(destFile).toString()).toContain('new-clean-data');
        expect(fs.existsSync(destWal)).toBe(false);
        expect(fs.existsSync(destShm)).toBe(false);
    });

    test('validateExtractedDirectory enforces file count and total size limits', () => {
        const subDir = path.join(tempDir, 'archive');
        fs.mkdirSync(subDir);
        fs.writeFileSync(path.join(subDir, 'a.txt'), '1234567890');
        fs.writeFileSync(path.join(subDir, 'b.txt'), '1234567890');

        // Within limits -> succeeds
        expect(() => validateExtractedDirectory(subDir, 10, 1024)).not.toThrow();

        // Exceeds file count limit -> throws
        expect(() => validateExtractedDirectory(subDir, 1, 1024)).toThrow(/file count|limit|exceed/i);

        // Exceeds total byte size limit -> throws
        expect(() => validateExtractedDirectory(subDir, 10, 10)).toThrow(/size|limit|exceed/i);
    });
});
