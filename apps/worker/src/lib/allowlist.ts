import { Redis } from '@upstash/redis';

export const ALLOWLIST_REDIS_KEY = 'qozara:allowed_users';
export const ALLOWLIST_HASH_PREFIX = 'qozara-allowlist-v1:';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const MIN_ADMIN_SECRET_LENGTH = 16;

export interface AllowlistBindings {
    KV_REST_API_URL?: string;
    KV_REST_API_TOKEN?: string;
    ALLOWED_USER_EMAILS?: string;
    ALLOWLIST_PEPPER?: string;
    NODE_ENV?: string;
    REQUIRE_EXPLICIT_ALLOWLIST_IN_TEST?: string;
}

export interface AllowlistCheckResult {
    allowed: boolean;
    source?: 'env' | 'redis' | 'test';
    error?: 'ALLOWLIST_UNAVAILABLE';
}

export interface EmailHashEntry {
    email: string;
    hash: string;
}

/**
 * Normalizes and validates an email address for deterministic allowlist hashing.
 */
export function normalizeEmail(email: string): string {
    const normalized = (email || '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalized)) {
        throw new Error(`Invalid email address: '${email}'`);
    }
    return normalized;
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * Computes a lowercase hexadecimal SHA-256 digest using standard Web Crypto.
 */
export async function sha256Hex(input: string): Promise<string> {
    const encoded = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return bytesToHex(new Uint8Array(digest));
}

/**
 * Computes a lowercase hexadecimal HMAC-SHA256 digest using a secret pepper.
 */
export async function hmacSha256Hex(secret: string, input: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
    return bytesToHex(new Uint8Array(signature));
}

/**
 * Hashes a normalized user email with a domain-separation prefix (and optional HMAC pepper)
 * so zero PII is persisted in Redis while remaining invariant to ADMIN_SECRET/KMS_SECRET rotation.
 */
export async function hashUserEmail(email: string, pepper?: string): Promise<string> {
    const normalized = normalizeEmail(email);
    const prefixed = `${ALLOWLIST_HASH_PREFIX}${normalized}`;
    const trimmedPepper = pepper?.trim();
    if (trimmedPepper) {
        return hmacSha256Hex(trimmedPepper, prefixed);
    }
    return sha256Hex(prefixed);
}

/**
 * Constant-time comparison for admin secrets. Enforces minimum secret length.
 */
export function verifyAdminSecret(
    provided: string | undefined | null,
    expected: string | undefined | null
): boolean {
    const expectedTrimmed = (expected || '').trim();
    if (expectedTrimmed.length < MIN_ADMIN_SECRET_LENGTH) {
        return false;
    }

    const providedTrimmed = (provided || '').trim();
    if (!providedTrimmed) {
        return false;
    }

    const encoder = new TextEncoder();
    const a = encoder.encode(providedTrimmed);
    const b = encoder.encode(expectedTrimmed);

    let mismatch = a.length ^ b.length;
    for (let i = 0; i < b.length; i++) {
        const aByte = i < a.length ? a[i] : 0;
        mismatch |= aByte ^ b[i];
    }

    return mismatch === 0;
}

/**
 * Parses comma-separated emails or precomputed 64-char SHA-256/HMAC-SHA256 hashes from env.
 */
export async function parseStaticAllowedSet(rawEnv?: string, pepper?: string): Promise<Set<string>> {
    const hashes = new Set<string>();
    if (!rawEnv || !rawEnv.trim()) {
        return hashes;
    }

    const entries = rawEnv.split(',');
    for (const raw of entries) {
        const trimmed = raw.trim();
        if (!trimmed) continue;

        if (SHA256_HEX_REGEX.test(trimmed)) {
            hashes.add(trimmed.toLowerCase());
            continue;
        }

        if (EMAIL_REGEX.test(trimmed.toLowerCase())) {
            hashes.add(await hashUserEmail(trimmed, pepper));
        }
    }

    return hashes;
}

function getRedisClient(bindings: AllowlistBindings): Redis | null {
    const { KV_REST_API_URL, KV_REST_API_TOKEN } = bindings;
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
        return null;
    }
    return new Redis({
        url: KV_REST_API_URL,
        token: KV_REST_API_TOKEN,
    });
}

function requireRedisClient(bindings: AllowlistBindings): Redis {
    const redis = getRedisClient(bindings);
    if (!redis) {
        throw new Error('ALLOWLIST_STORAGE_UNAVAILABLE: Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN) is required for dynamic allowlist management');
    }
    return redis;
}

async function resolveEmailHashEntries(emails: string[], pepper?: string): Promise<EmailHashEntry[]> {
    const seen = new Set<string>();
    const entries: EmailHashEntry[] = [];

    for (const raw of emails) {
        const normalized = normalizeEmail(raw);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        entries.push({
            email: normalized,
            hash: await hashUserEmail(normalized, pepper),
        });
    }

    return entries;
}

/**
 * Checks whether an authenticated Google email belongs to the Mode 1A allowlist.
 * Fails closed (`ALLOWLIST_UNAVAILABLE`) when storage is unavailable in production.
 */
export async function isUserAllowed(
    email: string,
    bindings: AllowlistBindings
): Promise<AllowlistCheckResult> {
    let normalized: string;
    let emailHash: string;
    try {
        normalized = normalizeEmail(email);
        emailHash = await hashUserEmail(normalized, bindings.ALLOWLIST_PEPPER);
    } catch {
        return { allowed: false };
    }

    const staticSet = await parseStaticAllowedSet(bindings.ALLOWED_USER_EMAILS, bindings.ALLOWLIST_PEPPER);
    if (staticSet.has(emailHash)) {
        return { allowed: true, source: 'env' };
    }

    const redis = getRedisClient(bindings);
    if (redis) {
        try {
            const isMember = await redis.sismember(ALLOWLIST_REDIS_KEY, emailHash);
            return { allowed: Number(isMember) === 1, source: 'redis' };
        } catch (err) {
            console.error('Allowlist Redis check failed (failing closed):', err);
            return { allowed: false, error: 'ALLOWLIST_UNAVAILABLE' };
        }
    }

    if (
        bindings.NODE_ENV === 'test' &&
        normalized === 'developer@qozara.org' &&
        bindings.REQUIRE_EXPLICIT_ALLOWLIST_IN_TEST !== 'true'
    ) {
        return { allowed: true, source: 'test' };
    }

    if (staticSet.size > 0) {
        return { allowed: false, source: 'env' };
    }

    return { allowed: false, error: 'ALLOWLIST_UNAVAILABLE' };
}

/**
 * Registers one or more user emails (stored only as SHA-256/HMAC-SHA256 hashes) in Redis.
 */
export async function registerAllowedUsers(
    emails: string[],
    bindings: AllowlistBindings
): Promise<{ added: number; hashes: EmailHashEntry[] }> {
    const redis = requireRedisClient(bindings);
    const entries = await resolveEmailHashEntries(emails, bindings.ALLOWLIST_PEPPER);
    if (entries.length === 0) {
        throw new Error('At least one valid email is required');
    }

    const hashes = entries.map((e) => e.hash);
    const added = await redis.sadd(ALLOWLIST_REDIS_KEY, hashes[0], ...hashes.slice(1));
    return { added: Number(added), hashes: entries };
}

/**
 * Revokes one or more user emails from the Redis allowlist.
 */
export async function revokeAllowedUsers(
    emails: string[],
    bindings: AllowlistBindings
): Promise<{ removed: number; hashes: EmailHashEntry[] }> {
    const redis = requireRedisClient(bindings);
    const entries = await resolveEmailHashEntries(emails, bindings.ALLOWLIST_PEPPER);
    if (entries.length === 0) {
        throw new Error('At least one valid email is required');
    }

    const hashes = entries.map((e) => e.hash);
    const removed = await redis.srem(ALLOWLIST_REDIS_KEY, ...hashes);
    return { removed: Number(removed), hashes: entries };
}

/**
 * Checks registration status for one or more user emails against env and Redis.
 */
export async function checkAllowedUsers(
    emails: string[],
    bindings: AllowlistBindings
): Promise<Array<{ email: string; hash: string; allowed: boolean; source?: string; error?: string }>> {
    const entries = await resolveEmailHashEntries(emails, bindings.ALLOWLIST_PEPPER);
    if (entries.length === 0) {
        throw new Error('At least one valid email is required');
    }

    const results: Array<{ email: string; hash: string; allowed: boolean; source?: string; error?: string }> = [];
    for (const entry of entries) {
        const check = await isUserAllowed(entry.email, bindings);
        results.push({
            email: entry.email,
            hash: entry.hash,
            allowed: check.allowed,
            ...(check.source ? { source: check.source } : {}),
            ...(check.error ? { error: check.error } : {}),
        });
    }
    return results;
}

/**
 * Lists all registered user hashes from Redis and static configuration.
 */
export async function listAllowedUserHashes(
    bindings: AllowlistBindings
): Promise<{
    redisConfigured: boolean;
    redisCount: number;
    redisHashes: string[];
    staticCount: number;
    staticHashes: string[];
}> {
    const staticSet = await parseStaticAllowedSet(bindings.ALLOWED_USER_EMAILS, bindings.ALLOWLIST_PEPPER);
    const staticHashes = Array.from(staticSet);

    const redis = getRedisClient(bindings);
    if (!redis) {
        return {
            redisConfigured: false,
            redisCount: 0,
            redisHashes: [],
            staticCount: staticHashes.length,
            staticHashes,
        };
    }

    const redisHashes = await redis.smembers<string[]>(ALLOWLIST_REDIS_KEY);
    const normalizedRedisHashes = Array.isArray(redisHashes) ? redisHashes : [];

    return {
        redisConfigured: true,
        redisCount: normalizedRedisHashes.length,
        redisHashes: normalizedRedisHashes,
        staticCount: staticHashes.length,
        staticHashes,
    };
}
