import * as assert from 'assert';
import * as crypto from '../../crypto';

describe('Crypto Compression & Security Tests', () => {
    test('Encrypting with compression should produce AGSYNC02 header', () => {
        const data = Buffer.from('Test data for compression');
        const password = 'test-password';
        const encrypted = crypto.encrypt(data, password, true);

        const header = encrypted.subarray(0, 8);
        assert.strictEqual(header.toString(), 'AGSYNC02');
    });

    test('Encrypting without compression should produce AGSYNC01 header', () => {
        const data = Buffer.from('Test data for compression');
        const password = 'test-password';
        const encrypted = crypto.encrypt(data, password, false);

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

        assert.ok(
            encryptedCompressed.length < encryptedUncompressed.length / 2,
            `Compressed ${encryptedCompressed.length} should be much smaller than ${encryptedUncompressed.length}`
        );
    });

    test('encryptV3 produces AGSYNC03 header and roundtrips both compressed and uncompressed', () => {
        const password = 'strong-password-123';
        const data = Buffer.from('Hello AGSYNC03 '.repeat(50));

        const encCompressed = crypto.encryptV3(data, password, true);
        expect(encCompressed.subarray(0, 8).toString()).toBe('AGSYNC03');
        expect(crypto.decrypt(encCompressed, password).toString()).toBe(data.toString());

        const encRaw = crypto.encryptV3(data, password, false);
        expect(encRaw.subarray(0, 8).toString()).toBe('AGSYNC03');
        expect(crypto.decrypt(encRaw, password).toString()).toBe(data.toString());
    });

    test('AGSYNC03 rejects header/flags tampering via GCM AAD', () => {
        const password = 'strong-password-123';
        const encrypted = Buffer.from(crypto.encryptV3(Buffer.from('sensitive payload'), password, true));

        // Flip compression flag byte (offset 8)
        const tampered = Buffer.from(encrypted);
        tampered[8] = tampered[8] ^ 0x01;

        expect(() => crypto.decrypt(tampered, password)).toThrow(/Decryption failed/i);
    });

    test('rejects empty password in encrypt and encryptV3', () => {
        expect(() => crypto.encrypt(Buffer.from('data'), '')).toThrow(/password/i);
        expect(() => crypto.encryptV3(Buffer.from('data'), '')).toThrow(/password/i);
    });

    test('rejects wrong password with clear decryption error', () => {
        const encrypted = crypto.encrypt(Buffer.from('secret'), 'correct-pass', true);
        expect(() => crypto.decrypt(encrypted, 'wrong-pass')).toThrow(/Decryption failed/i);
    });

    test('compress and decompress enforce MAX_DECOMPRESSED_BYTES against gzip bombs', () => {
        // Compress a 1MB zero buffer and test custom maxBytes limit
        const zeros = Buffer.alloc(1024 * 1024, 0);
        const compressed = crypto.compress(zeros);
        expect(compressed.length).toBeLessThan(10000);

        expect(() => crypto.decompress(compressed, 1024)).toThrow(/larger than|size limit|maxOutputLength|length/i);
        expect(crypto.decompress(compressed, 2 * 1024 * 1024).length).toBe(zeros.length);
    });

    test('generateMachineId always returns 32-char hex string', () => {
        const id = crypto.generateMachineId();
        expect(id).toMatch(/^[a-f0-9]{32}$/);
    });
});
