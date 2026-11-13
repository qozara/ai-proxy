import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSismember = vi.fn();
const mockSadd = vi.fn();
const mockSrem = vi.fn();
const mockSmembers = vi.fn();

vi.mock('@upstash/redis', () => ({
    Redis: vi.fn().mockImplementation(function () {
        return {
            sismember: mockSismember,
            sadd: mockSadd,
            srem: mockSrem,
            smembers: mockSmembers,
        };
    }),
}));

import {
    ALLOWLIST_REDIS_KEY,
    normalizeEmail,
    hashUserEmail,
    verifyAdminSecret,
    parseStaticAllowedSet,
    isUserAllowed,
    registerAllowedUsers,
    revokeAllowedUsers,
    checkAllowedUsers,
    listAllowedUserHashes,
} from '../src/lib/allowlist.js';

describe('Allowlist & Crypto Utilities', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('normalizeEmail & hashUserEmail', () => {
        it('should normalize emails by trimming and lowercasing', () => {
            expect(normalizeEmail('  Alice.Smith@Example.COM  ')).toBe('alice.smith@example.com');
        });

        it('should reject invalid or empty email addresses', () => {
            expect(() => normalizeEmail('')).toThrow();
            expect(() => normalizeEmail('not-an-email')).toThrow();
            expect(() => normalizeEmail('alice@')).toThrow();
            expect(() => normalizeEmail('@example.com')).toThrow();
        });

        it('should compute deterministic 64-char hex SHA-256 hash independent of case/whitespace', async () => {
            const hash1 = await hashUserEmail('Alice@Qozara.org');
            const hash2 = await hashUserEmail('  alice@qozara.org  ');
            const hash3 = await hashUserEmail('bob@qozara.org');

            expect(hash1).toMatch(/^[0-9a-f]{64}$/);
            expect(hash1).toBe(hash2);
            expect(hash1).not.toBe(hash3);
        });

        it('should use HMAC-SHA256 when ALLOWLIST_PEPPER is provided', async () => {
            const unpeppered = await hashUserEmail('Alice@Qozara.org');
            const peppered1 = await hashUserEmail('Alice@Qozara.org', 'my-secret-pepper');
            const peppered2 = await hashUserEmail('alice@qozara.org', 'other-pepper');

            expect(peppered1).toMatch(/^[0-9a-f]{64}$/);
            expect(peppered1).not.toBe(unpeppered);
            expect(peppered1).not.toBe(peppered2);

            mockSismember.mockResolvedValueOnce(1);
            const res = await isUserAllowed('alice@qozara.org', {
                KV_REST_API_URL: 'https://redis.example.com',
                KV_REST_API_TOKEN: 'token',
                ALLOWLIST_PEPPER: 'my-secret-pepper',
            });
            expect(res).toEqual({ allowed: true, source: 'redis' });
            expect(mockSismember).toHaveBeenCalledWith(ALLOWLIST_REDIS_KEY, peppered1);
        });
    });

    describe('verifyAdminSecret', () => {
        const validSecret = 'qozara-super-secret-admin-key-2026';

        it('should return true for an exact matching secret >= 16 chars', () => {
            expect(verifyAdminSecret(validSecret, validSecret)).toBe(true);
        });

        it('should return false for empty, short, or mismatched secrets', () => {
            expect(verifyAdminSecret(undefined, validSecret)).toBe(false);
            expect(verifyAdminSecret('', validSecret)).toBe(false);
            expect(verifyAdminSecret('wrong-secret-key-2026', validSecret)).toBe(false);
            expect(verifyAdminSecret(validSecret + 'x', validSecret)).toBe(false);
            expect(verifyAdminSecret('short-secret', 'short-secret')).toBe(false);
            expect(verifyAdminSecret(validSecret, undefined)).toBe(false);
        });
    });

    describe('parseStaticAllowedSet', () => {
        it('should parse comma-separated raw emails and precomputed SHA-256 hashes', async () => {
            const bobHash = await hashUserEmail('bob@example.com');
            const set = await parseStaticAllowedSet(` Alice@Example.com , ${bobHash.toUpperCase()} , invalid-entry `);

            expect(set.size).toBe(2);
            expect(set.has(await hashUserEmail('alice@example.com'))).toBe(true);
            expect(set.has(bobHash)).toBe(true);
        });
    });

    describe('isUserAllowed', () => {
        it('should allow user present in static ALLOWED_USER_EMAILS without querying Redis', async () => {
            const res = await isUserAllowed('Alice@Example.com', {
                ALLOWED_USER_EMAILS: 'alice@example.com, bob@example.com',
            });

            expect(res).toEqual({ allowed: true, source: 'env' });
            expect(mockSismember).not.toHaveBeenCalled();
        });

        it('should check Upstash Redis set using hashed email when not in static env', async () => {
            const expectedHash = await hashUserEmail('carlos@example.com');
            mockSismember.mockResolvedValueOnce(1);

            const res = await isUserAllowed('Carlos@Example.com', {
                KV_REST_API_URL: 'https://redis.example.com',
                KV_REST_API_TOKEN: 'token',
            });

            expect(res).toEqual({ allowed: true, source: 'redis' });
            expect(mockSismember).toHaveBeenCalledWith(ALLOWLIST_REDIS_KEY, expectedHash);
        });

        it('should return allowed: false when Redis reports user is not a member', async () => {
            mockSismember.mockResolvedValueOnce(0);

            const res = await isUserAllowed('stranger@example.com', {
                KV_REST_API_URL: 'https://redis.example.com',
                KV_REST_API_TOKEN: 'token',
            });

            expect(res).toEqual({ allowed: false, source: 'redis' });
        });

        it('should fail closed with ALLOWLIST_UNAVAILABLE when Redis throws an error', async () => {
            mockSismember.mockRejectedValueOnce(new Error('Redis connection timeout'));

            const res = await isUserAllowed('alice@example.com', {
                KV_REST_API_URL: 'https://redis.example.com',
                KV_REST_API_TOKEN: 'token',
            });

            expect(res).toEqual({ allowed: false, error: 'ALLOWLIST_UNAVAILABLE' });
        });

        it('should fail closed when neither Redis nor ALLOWED_USER_EMAILS is configured in production', async () => {
            const res = await isUserAllowed('alice@example.com', {
                NODE_ENV: 'production',
            });

            expect(res).toEqual({ allowed: false, error: 'ALLOWLIST_UNAVAILABLE' });
        });
    });

    describe('Admin Redis CRUD helpers', () => {
        const redisBindings = {
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
            ALLOWED_USER_EMAILS: 'static@example.com',
        };

        it('should register hashed emails in Redis Set', async () => {
            const h1 = await hashUserEmail('a@qozara.org');
            const h2 = await hashUserEmail('b@qozara.org');
            mockSadd.mockResolvedValueOnce(2);

            const result = await registerAllowedUsers(['A@qozara.org', 'b@qozara.org'], redisBindings);

            expect(mockSadd).toHaveBeenCalledWith(ALLOWLIST_REDIS_KEY, h1, h2);
            expect(result.added).toBe(2);
            expect(result.hashes).toEqual([
                { email: 'a@qozara.org', hash: h1 },
                { email: 'b@qozara.org', hash: h2 },
            ]);
        });

        it('should revoke hashed emails from Redis Set', async () => {
            const h1 = await hashUserEmail('a@qozara.org');
            mockSrem.mockResolvedValueOnce(1);

            const result = await revokeAllowedUsers(['a@qozara.org'], redisBindings);

            expect(mockSrem).toHaveBeenCalledWith(ALLOWLIST_REDIS_KEY, h1);
            expect(result.removed).toBe(1);
            expect(result.hashes).toEqual([{ email: 'a@qozara.org', hash: h1 }]);
        });

        it('should check allowlist status for multiple emails', async () => {
            mockSismember.mockResolvedValueOnce(0);

            const results = await checkAllowedUsers(['static@example.com', 'unknown@example.com'], redisBindings);

            expect(results[0].allowed).toBe(true);
            expect(results[0].source).toBe('env');
            expect(results[1].allowed).toBe(false);
        });

        it('should list Redis and static hashes', async () => {
            const h1 = await hashUserEmail('a@qozara.org');
            const staticHash = await hashUserEmail('static@example.com');
            mockSmembers.mockResolvedValueOnce([h1]);

            const list = await listAllowedUserHashes(redisBindings);

            expect(list.redisCount).toBe(1);
            expect(list.redisHashes).toEqual([h1]);
            expect(list.staticCount).toBe(1);
            expect(list.staticHashes).toEqual([staticHash]);
        });
    });
});
