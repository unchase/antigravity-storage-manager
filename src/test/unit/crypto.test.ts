
import * as assert from 'assert';
import * as crypto from '../../crypto';

describe('Crypto Compression Tests', () => {

    test('Encrypting with compression should produce AGSYNC02 header', () => {
        const data = Buffer.from('Test data for compression');
        const password = 'test-password';
        const encrypted = crypto.encrypt(data, password, true); // useCompression = true

        const header = encrypted.subarray(0, 8);
        assert.strictEqual(header.toString(), 'AGSYNC02');
    });

    test('Encrypting without compression should produce AGSYNC01 header', () => {
        const data = Buffer.from('Test data for compression');
        const password = 'test-password';
        const encrypted = crypto.encrypt(data, password, false); // useCompression = false

        const header = encrypted.subarray(0, 8);
        assert.strictEqual(header.toString(), 'AGSYNC01');
    });

    test('Should match decrypted content (Compressed)', () => {
        const originalText = 'Large text content '.repeat(100);
        const data = Buffer.from(originalText);
        const password = 'test-password';

        const encrypted = crypto.encrypt(data, password, true);
        const decrypted = crypto.decrypt(encrypted, password);

        assert.strictEqual(decrypted.toString(), originalText);
    });

    test('Should match decrypted content (Uncompressed)', () => {
        const originalText = 'Large text content '.repeat(100);
        const data = Buffer.from(originalText);
        const password = 'test-password';

        const encrypted = crypto.encrypt(data, password, false);
        const decrypted = crypto.decrypt(encrypted, password);

        assert.strictEqual(decrypted.toString(), originalText);
    });

    test('Compressed size should be smaller for compressible data', () => {
        const originalText = 'Same content '.repeat(1000);
        const data = Buffer.from(originalText);
        const password = 'test-password';

        const encryptedCompressed = crypto.encrypt(data, password, true);
        const encryptedUncompressed = crypto.encrypt(data, password, false);

        // Compressed should be significantly smaller
        assert.ok(encryptedCompressed.length < encryptedUncompressed.length / 2, `Compressed ${encryptedCompressed.length} should be much smaller than ${encryptedUncompressed.length}`);
    });
});
