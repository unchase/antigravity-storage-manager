import * as crypto from 'crypto';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for GCM
const SALT_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000;
const HEADER = Buffer.from('AGSYNC01'); // 8 bytes version header

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
export function encrypt(data: Buffer, password: string): Buffer {
    const salt = generateSalt();
    const iv = generateIV();
    const key = deriveKey(password, salt);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH
    });

    const encrypted = Buffer.concat([
        cipher.update(data),
        cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    // Combine all parts: header + salt + iv + authTag + encrypted
    return Buffer.concat([
        HEADER,
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
    if (!header.equals(HEADER)) {
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
        return decrypted;
    } catch {
        throw new Error('Decryption failed: incorrect password or corrupted data');
    }
}

/**
 * Encrypts a string and returns base64-encoded result
 */
export function encryptString(text: string, password: string): string {
    const data = Buffer.from(text, 'utf8');
    const encrypted = encrypt(data, password);
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
 * Generates a unique machine ID
 */
export function generateMachineId(): string {
    return crypto.randomUUID();
}

/**
 * Creates a hash of the password for verification purposes
 * (not for storage - only to verify same password is used across machines)
 */
export function hashPassword(password: string, salt: Buffer): string {
    const key = deriveKey(password, salt);
    return key.toString('hex');
}
