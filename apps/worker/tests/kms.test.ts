import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../src/lib/kms.js';

describe('Edge KMS AES-256-GCM', () => {
    const VALID_SECRET = '12345678901234567890123456789012'; // exactly 32 bytes

    it('should successfully encrypt and decrypt a string', async () => {
        const text = 'AIzaSyExampleGeminiApiKey1234567890';
        const ciphertext = await encrypt(text, VALID_SECRET);

        expect(ciphertext).toBeDefined();
        expect(typeof ciphertext).toBe('string');
        expect(ciphertext).not.toBe(text);

        const decrypted = await decrypt(ciphertext, VALID_SECRET);
        expect(decrypted).toBe(text);
    });

    it('should produce different ciphertexts for the same plaintext due to random IV', async () => {
        const text = 'my-secret-api-key';
        const c1 = await encrypt(text, VALID_SECRET);
        const c2 = await encrypt(text, VALID_SECRET);

        expect(c1).not.toBe(c2);
        expect(await decrypt(c1, VALID_SECRET)).toBe(text);
        expect(await decrypt(c2, VALID_SECRET)).toBe(text);
    });

    it('should throw an error if KMS_SECRET is not 32 bytes', async () => {
        const shortSecret = 'too-short';
        await expect(encrypt('test', shortSecret)).rejects.toThrow(/Expected 32 bytes/);

        const longSecret = 'this-secret-is-definitely-way-too-long-for-32-bytes-validation!';
        await expect(encrypt('test', longSecret)).rejects.toThrow(/Expected 32 bytes/);
    });

    it('should fail decryption if wrong secret is used', async () => {
        const text = 'sensitive-data';
        const ciphertext = await encrypt(text, VALID_SECRET);
        const wrongSecret = 'abcdefghijklmnopqrstuvwxyz012345'; // different 32 bytes

        await expect(decrypt(ciphertext, wrongSecret)).rejects.toThrow();
    });

    it('should support base64-encoded 32-byte secret', async () => {
        const base64Secret = btoa(VALID_SECRET);
        const text = 'secret-key-123';
        const ciphertext = await encrypt(text, base64Secret);
        const decrypted = await decrypt(ciphertext, base64Secret);
        expect(decrypted).toBe(text);
    });

    it('should support hex-encoded 32-byte secret', async () => {
        const hexSecret = Array.from(new TextEncoder().encode(VALID_SECRET))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        const text = 'secret-key-hex';
        const ciphertext = await encrypt(text, hexSecret);
        const decrypted = await decrypt(ciphertext, hexSecret);
        expect(decrypted).toBe(text);
    });

    it('should fail decryption on corrupted or truncated ciphertext', async () => {
        await expect(decrypt('invalid-base64-!!!', VALID_SECRET)).rejects.toThrow();
        await expect(decrypt('dG9vc2hvcnQ=', VALID_SECRET)).rejects.toThrow(/payload too short/);
    });
});
