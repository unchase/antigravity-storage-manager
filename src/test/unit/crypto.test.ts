import * as crypto from '../../../src/crypto';

describe('Crypto Utils', () => {
    const password = 'test-password';
    const salt = crypto.generateSalt();

    test('generateSalt returns buffer of correct length', () => {
        const salt = crypto.generateSalt();
        expect(Buffer.isBuffer(salt)).toBe(true);
        expect(salt.length).toBe(32);
    });

    test('hashPassword returns consistent hash for same input', () => {
        const hash1 = crypto.hashPassword(password, salt);
        const hash2 = crypto.hashPassword(password, salt);
        expect(hash1).toBe(hash2);
    });

    test('encrypt and decrypt round trip works', () => {
        const data = Buffer.from('Hello, World!');
        const encrypted = crypto.encrypt(data, password);
        const decrypted = crypto.decrypt(encrypted, password);
        expect(decrypted.toString()).toBe(data.toString());
    });

    test('decrypt with wrong password fails', () => {
        const data = Buffer.from('Secret Data');
        const encrypted = crypto.encrypt(data, password);
        expect(() => {
            crypto.decrypt(encrypted, 'wrong-password');
        }).toThrow();
    });

    test('computeHash returns distinct hashes for different content', () => {
        const content1 = Buffer.from('content1');
        const content2 = Buffer.from('content2');
        const hash1 = crypto.computeHash(content1);
        const hash2 = crypto.computeHash(content2);
        expect(hash1).not.toBe(hash2);
    });
});
