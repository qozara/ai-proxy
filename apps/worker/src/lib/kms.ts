/**
 * Handles KMS-style envelope encryption/decryption using AES-256-GCM.
 * Enforces use of a 32-byte high-entropy secret.
 */

async function getEncryptionKey(secret: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);

    if (keyData.byteLength !== 32) {
        throw new Error(
            `Invalid KMS_SECRET: Expected 32 bytes, but got ${keyData.byteLength}. ` +
            `The KMS_SECRET must be exactly 32 bytes of cryptographically random data. ` +
            `You can generate one using: openssl rand -base64 32`
        );
    }

    return await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function encrypt(text: string, secret: string): Promise<string> {
    const key = await getEncryptionKey(secret);
    const encoder = new TextEncoder();
    const data = encoder.encode(text);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
    );

    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    // Browser and Edge Worker compatible base64 encoding
    let binary = '';
    for (let i = 0; i < combined.byteLength; i++) {
        binary += String.fromCharCode(combined[i]);
    }
    return btoa(binary);
}

export async function decrypt(ciphertextBase64: string, secret: string): Promise<string> {
    const key = await getEncryptionKey(secret);

    let binary: string;
    try {
        binary = atob(ciphertextBase64);
    } catch {
        throw new Error('Invalid ciphertext: malformed base64');
    }

    const combined = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        combined[i] = binary.charCodeAt(i);
    }

    if (combined.length < 13) {
        throw new Error('Invalid ciphertext: payload too short');
    }

    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        data
    );

    return new TextDecoder().decode(decrypted);
}
