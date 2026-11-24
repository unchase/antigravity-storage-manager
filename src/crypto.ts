import * as crypto from 'crypto';
import * as os from 'os';
import * as zlib from 'zlib';
import { LocalizationManager } from './l10n/localizationManager';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for GCM (v1/v2 compatibility)
const IV_LENGTH_V3 = 12; // 96 bits standard NIST GCM IV (v3)
const SALT_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_ITERATIONS_V3 = 600000;
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MB gzip bomb guard
const HEADER = Buffer.from('AGSYNC01'); // 8 bytes version header
const HEADER_V2 = Buffer.from('AGSYNC02'); // 8 bytes version header (Compressed)
const HEADER_V3 = Buffer.from('AGSYNC03'); // 8 bytes version header (AAD + 12-byte IV + 600k PBKDF2 + flag byte)

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
export function deriveKey(password: string, salt: Buffer, iterations: number = PBKDF2_ITERATIONS): Buffer {
    return crypto.pbkdf2Sync(
        password,
        salt,
        iterations,
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
    if (!password) {
        throw new Error('Encryption password cannot be empty');
    }

    const salt = generateSalt();
    const iv = generateIV();
    const key = deriveKey(password, salt);

    try {
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
    } finally {
        key.fill(0);
    }
}

/**
 * Encrypts data using the hardened AGSYNC03 format:
 * Header(8) + Flags(1: bit0=compressed) + Salt(32) + IV(12) + AuthTag(16) + Ciphertext
 * Authenticates Header + Flags + Salt + IV via GCM AAD and uses 600k PBKDF2 iterations.
 */
export function encryptV3(data: Buffer, password: string, useCompression: boolean = true): Buffer {
    if (!password) {
        throw new Error('Encryption password cannot be empty');
    }

    const salt = generateSalt();
    const iv = crypto.randomBytes(IV_LENGTH_V3);
    const key = deriveKey(password, salt, PBKDF2_ITERATIONS_V3);

    try {
        let dataToEncrypt = data;
        let flagsByte = 0;

        if (useCompression) {
            try {
                dataToEncrypt = compress(data);
                flagsByte = 1;
            } catch (e) {
                console.error('Compression failed, falling back to uncompressed', e);
            }
        }

        const flags = Buffer.from([flagsByte]);
        const aad = Buffer.concat([HEADER_V3, flags, salt, iv]);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH
        });
        cipher.setAAD(aad);

        const encrypted = Buffer.concat([
            cipher.update(dataToEncrypt),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();

        return Buffer.concat([
            HEADER_V3,
            flags,
            salt,
            iv,
            authTag,
            encrypted
        ]);
    } finally {
        key.fill(0);
    }
}

/**
 * Decrypts data that was encrypted with encrypt (AGSYNC01/AGSYNC02) or encryptV3 (AGSYNC03).
 * Throws an error if the password is incorrect or data is corrupted.
 */
export function decrypt(encryptedData: Buffer, password: string): Buffer {
    const headerOffset = HEADER.length;
    if (encryptedData.length < headerOffset) {
        throw new Error('Encrypted data is too short');
    }

    const header = encryptedData.subarray(0, headerOffset);
    const isV3 = header.equals(HEADER_V3);
    const isV2 = header.equals(HEADER_V2);
    const isV1 = header.equals(HEADER);

    if (!isV1 && !isV2 && !isV3) {
        throw new Error('Invalid file format or unsupported version');
    }

    let key: Buffer;
    let decrypted: Buffer;
    let isCompressed = isV2;

    if (isV3) {
        const flagsOffset = headerOffset + 1;
        const saltOffset = flagsOffset + SALT_LENGTH;
        const ivOffset = saltOffset + IV_LENGTH_V3;
        const authTagOffset = ivOffset + AUTH_TAG_LENGTH;

        if (encryptedData.length < authTagOffset) {
            throw new Error('Encrypted data is too short');
        }

        const flags = encryptedData.subarray(headerOffset, flagsOffset);
        isCompressed = (flags[0] & 1) === 1;
        const salt = encryptedData.subarray(flagsOffset, saltOffset);
        const iv = encryptedData.subarray(saltOffset, ivOffset);
        const authTag = encryptedData.subarray(ivOffset, authTagOffset);
        const encrypted = encryptedData.subarray(authTagOffset);

        key = deriveKey(password, salt, PBKDF2_ITERATIONS_V3);
        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
                authTagLength: AUTH_TAG_LENGTH
            });
            decipher.setAAD(Buffer.concat([header, flags, salt, iv]));
            decipher.setAuthTag(authTag);
            decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);
        } catch {
            const lm = LocalizationManager.getInstance();
            throw new Error(lm.t('Decryption failed: incorrect password or corrupted data'));
        } finally {
            key.fill(0);
        }
    } else {
        const saltOffset = headerOffset + SALT_LENGTH;
        const ivOffset = saltOffset + IV_LENGTH;
        const authTagOffset = ivOffset + AUTH_TAG_LENGTH;

        if (encryptedData.length < authTagOffset) {
            throw new Error('Encrypted data is too short');
        }

        const salt = encryptedData.subarray(headerOffset, saltOffset);
        const iv = encryptedData.subarray(saltOffset, ivOffset);
        const authTag = encryptedData.subarray(ivOffset, authTagOffset);
        const encrypted = encryptedData.subarray(authTagOffset);

        key = deriveKey(password, salt);
        try {
            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
                authTagLength: AUTH_TAG_LENGTH
            });
            decipher.setAuthTag(authTag);
            decrypted = Buffer.concat([
                decipher.update(encrypted),
                decipher.final()
            ]);
        } catch {
            const lm = LocalizationManager.getInstance();
            throw new Error(lm.t('Decryption failed: incorrect password or corrupted data'));
        } finally {
            key.fill(0);
        }
    }

    if (isCompressed) {
        try {
            return decompress(decrypted);
        } catch (err: any) {
            throw new Error(`Decompression failed: ${err?.message || String(err)}`);
        }
    }

    return decrypted;
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
 * Decompress data using Gzip with a maximum output limit to prevent gzip bombs (OOM)
 */
export function decompress(data: Buffer, maxOutputLength: number = MAX_DECOMPRESSED_BYTES): Buffer {
    return zlib.gunzipSync(data, { maxOutputLength });
}

/**
 * Generates a PERSISTENT machine ID based on hostname + username
 * This ensures the same machine gets the same ID even after extension reinstall
 */
export function generateMachineId(): string {
    let username = process.env.USER || process.env.USERNAME || 'user';
    try {
        username = os.userInfo().username || username;
    } catch {
        // Fallback to env username in containers/WSL without /etc/passwd entry
    }
    const identifier = `${os.hostname()}-${username}`;
    return computeMd5Hash(Buffer.from(identifier)).substring(0, 32);
}

/**
 * Creates a hash of the password for verification purposes
 * (not for storage - only to verify same password is used across machines)
 */
export function hashPassword(password: string, salt: Buffer): string {
    const key = deriveKey(password, salt);
    try {
        return key.toString('hex');
    } finally {
        key.fill(0);
    }
}
