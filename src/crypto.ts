import * as crypto from 'crypto';
import * as os from 'os';
import * as zlib from 'zlib';
import { LocalizationManager } from './l10n/localizationManager';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for GCM
const SALT_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000;
const HEADER = Buffer.from('AGSYNC01'); // 8 bytes version header
const HEADER_V2 = Buffer.from('AGSYNC02'); // 8 bytes version header (Compressed)

/**
 * File format:
 * +--------+------+----------+------------+---------+
 * | Header | Salt | IV       | AuthTag    | Data    |
 * | 8 bytes| 32 B | 16 bytes | 16 bytes   | N bytes |
 * +--------+------+----------+------------+---------+
 */

/**
 * Derives a 256-bit key from a password using PBKDF2
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
        password,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        'sha256'
    );
}

/**
 * Generates a cryptographically secure random salt
 */
export function generateSalt(): Buffer {
    return crypto.randomBytes(SALT_LENGTH);
}

/**
 * Generates a cryptographically secure random IV
 */
export function generateIV(): Buffer {
    return crypto.randomBytes(IV_LENGTH);
}

/**
 * Encrypts data using AES-256-GCM with password-based key derivation
 * Returns a buffer containing: header + salt + iv + authTag + encryptedData
 */
export function encrypt(data: Buffer, password: string, useCompression: boolean = true): Buffer {
    const salt = generateSalt();
    const iv = generateIV();
    const key = deriveKey(password, salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH
    });

    let dataToEncrypt = data;
    let header = HEADER;

    if (useCompression) {
        try {
            dataToEncrypt = compress(data);
            header = HEADER_V2;
        } catch (e) {
            console.error('Compression failed, falling back to uncompressed', e);
            // Fallback to uncompressed
        }
    }

    const encrypted = Buffer.concat([
        cipher.update(dataToEncrypt),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    // Combine all parts: header + salt + iv + authTag + encrypted
    return Buffer.concat([
        header,
        salt,
        iv,
        authTag,
        encrypted
    ]);
}

/**
 * Decrypts data that was encrypted with the encrypt function
 * Throws an error if the password is incorrect or data is corrupted
 */
export function decrypt(encryptedData: Buffer, password: string): Buffer {
    const headerOffset = HEADER.length;
    const saltOffset = headerOffset + SALT_LENGTH;
    const ivOffset = saltOffset + IV_LENGTH;
    const authTagOffset = ivOffset + AUTH_TAG_LENGTH;

    // Validate minimum size
    if (encryptedData.length < authTagOffset) {
        throw new Error('Encrypted data is too short');
    }

    // Validate header
    const header = encryptedData.subarray(0, headerOffset);
    if (!header.equals(HEADER) && !header.equals(HEADER_V2)) {
        throw new Error('Invalid file format or unsupported version');
    }

    // Extract components
    const salt = encryptedData.subarray(headerOffset, saltOffset);
    const iv = encryptedData.subarray(saltOffset, ivOffset);
    const authTag = encryptedData.subarray(ivOffset, authTagOffset);
    const encrypted = encryptedData.subarray(authTagOffset);

    // Derive key from password
    const key = deriveKey(password, salt);

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH
    });
    decipher.setAuthTag(authTag);

    try {
        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);

        // If version 2, decompress
        if (header.equals(HEADER_V2)) {
            return decompress(decrypted);
        }

        return decrypted;
    } catch {
        const lm = LocalizationManager.getInstance();
        throw new Error(lm.t('Decryption failed: incorrect password or corrupted data'));
    }
}

/**
 * Encrypts a string and returns base64-encoded result
 */
export function encryptString(text: string, password: string): string {
    const data = Buffer.from(text, 'utf8');
    // Don't compress short strings by default unless configured, but keeping logic internal.
    // For strings (passwords etc) usually disabling compression is safer or just overhead.
    // However, function signature didn't change, so it uses default useCompression=true inside encrypt.
    // Let's force false for small strings or just let it be?
    // Given usage for secrets, maybe false is better. but 'encrypt' default is true.
    // Let's explicitly pass false for simple string encryption to avoid overhead on small details.
    const encrypted = encrypt(data, password, false);
    return encrypted.toString('base64');
}

/**
 * Decrypts a base64-encoded encrypted string
 */
export function decryptString(encryptedBase64: string, password: string): string {
    const data = Buffer.from(encryptedBase64, 'base64');
    const decrypted = decrypt(data, password);
    return decrypted.toString('utf8');
}

/**
 * Computes SHA-256 hash of data
 */
export function computeHash(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Computes MD5 hash of data
 */
export function computeMd5Hash(data: Buffer): string {
    return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Compress data using Gzip
 */
export function compress(data: Buffer): Buffer {
    return zlib.gzipSync(data);
}

/**
 * Decompress data using Gzip
 */
export function decompress(data: Buffer): Buffer {
    return zlib.gunzipSync(data);
}

/**
 * Generates a PERSISTENT machine ID based on hostname + username
 * This ensures the same machine gets the same ID even after extension reinstall
 */
export function generateMachineId(): string {
    const identifier = `${os.hostname()}-${os.userInfo().username}`;
    return computeMd5Hash(Buffer.from(identifier)).substring(0, 32);
}

/**
 * Creates a hash of the password for verification purposes
 * (not for storage - only to verify same password is used across machines)
 */
export function hashPassword(password: string, salt: Buffer): string {
    const key = deriveKey(password, salt);
    return key.toString('hex');
}
