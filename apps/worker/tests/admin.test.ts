import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSismember = vi.fn();
const mockSadd = vi.fn();
const mockSrem = vi.fn();
const mockSmembers = vi.fn();
const mockRatelimitLimit = vi.fn();

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

vi.mock('@upstash/ratelimit', () => {
    const RatelimitMock = vi.fn().mockImplementation(function () {
        return {
            limit: mockRatelimitLimit,
        };
    }) as any;
    RatelimitMock.slidingWindow = vi.fn().mockReturnValue('sliding-window');
    return { Ratelimit: RatelimitMock };
});

import app from '../src/index.js';
import { hashUserEmail } from '../src/lib/allowlist.js';
import { parseCliArgs, runCliCommand } from '../src/lib/cli-runner.js';
import { resetRateLimitShield } from '../src/lib/rate-limit.js';

describe('Admin Allowlist Endpoints & CLI Runner', () => {
    const ADMIN_SECRET = 'qozara-rotatable-admin-secret-2026';
    const ENV = {
        KMS_SECRET: 'supersecretkmskeyexactly32bytes!',
        ADMIN_SECRET,
        KV_REST_API_URL: 'https://redis.example.com',
        KV_REST_API_TOKEN: 'redis-token',
        ALLOWED_USER_EMAILS: 'founder@qozara.org',
        NODE_ENV: 'test',
    };

    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.clearAllMocks();
        resetRateLimitShield();
        globalThis.fetch = originalFetch;
        mockRatelimitLimit.mockResolvedValue({ success: true, limit: 15, remaining: 14 });
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('GET /admin should serve self-contained HTML admin console with strict no-cache and no-referrer headers', async () => {
        const res = await app.request('/admin', { method: 'GET' }, ENV);

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/html');
        expect(res.headers.get('Cache-Control')).toContain('no-store');
        expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(res.headers.get('X-Frame-Options')).toBe('DENY');

        const html = await res.text();
        expect(html).toContain('Qozara Intelligence');
        expect(html).toContain('/api/v1/admin/users');
    });

    it('should reject missing or invalid ADMIN_SECRET with 401 and security headers', async () => {
        const resMissing = await app.request('/api/v1/admin/users?action=list', { method: 'GET' }, ENV);
        expect(resMissing.status).toBe(401);
        expect(resMissing.headers.get('Cache-Control')).toContain('no-store');
        expect(resMissing.headers.get('Referrer-Policy')).toBe('no-referrer');

        const resWrong = await app.request('/api/v1/admin/users?action=list&secret=wrong-secret-value', {
            method: 'GET',
        }, ENV);
        expect(resWrong.status).toBe(401);
    });

    it('should return 503 if ADMIN_SECRET is not configured or shorter than 16 chars', async () => {
        const resUnconfigured = await app.request('/api/v1/admin/users?action=list&secret=anything', {
            method: 'GET',
        }, {
            ...ENV,
            ADMIN_SECRET: undefined,
        });
        expect(resUnconfigured.status).toBe(503);

        const resShort = await app.request('/api/v1/admin/users?action=list&secret=short', {
            method: 'GET',
        }, {
            ...ENV,
            ADMIN_SECRET: 'short',
        });
        expect(resShort.status).toBe(503);
    });

    it('GET /api/v1/admin/users should support browser URL bar register, check, revoke, and list', async () => {
        const aliceHash = await hashUserEmail('alice@example.com');

        // 1. Register
        mockSadd.mockResolvedValueOnce(1);
        const regRes = await app.request(
            `/api/v1/admin/users?action=register&email=Alice@Example.com&secret=${ADMIN_SECRET}`,
            { method: 'GET' },
            ENV
        );
        expect(regRes.status).toBe(200);
        expect(regRes.headers.get('Cache-Control')).toContain('no-store');
        expect(regRes.headers.get('Referrer-Policy')).toBe('no-referrer');
        const regData = await regRes.json() as any;
        expect(regData.status).toBe('ok');
        expect(regData.action).toBe('register');
        expect(regData.added).toBe(1);
        expect(regData.hashes).toEqual([{ email: 'alice@example.com', hash: aliceHash }]);

        // 2. Check
        mockSismember.mockResolvedValueOnce(1);
        const checkRes = await app.request(
            `/api/v1/admin/users?action=check&email=alice@example.com&secret=${ADMIN_SECRET}`,
            { method: 'GET' },
            ENV
        );
        expect(checkRes.status).toBe(200);
        const checkData = await checkRes.json() as any;
        expect(checkData.results[0]).toEqual(
            expect.objectContaining({ email: 'alice@example.com', hash: aliceHash, allowed: true })
        );

        // 3. List
        mockSmembers.mockResolvedValueOnce([aliceHash]);
        const listRes = await app.request(
            `/api/v1/admin/users?action=list&secret=${ADMIN_SECRET}`,
            { method: 'GET' },
            ENV
        );
        expect(listRes.status).toBe(200);
        const listData = await listRes.json() as any;
        expect(listData.redisCount).toBe(1);
        expect(listData.redisHashes).toEqual([aliceHash]);
        expect(listData.staticCount).toBe(1);

        // 4. Revoke
        mockSrem.mockResolvedValueOnce(1);
        const revokeRes = await app.request(
            `/api/v1/admin/users?action=revoke&email=alice@example.com&secret=${ADMIN_SECRET}`,
            { method: 'GET' },
            ENV
        );
        expect(revokeRes.status).toBe(200);
        const revokeData = await revokeRes.json() as any;
        expect(revokeData.removed).toBe(1);
    });

    it('POST /api/v1/admin/users should support Authorization Bearer and X-Admin-Secret headers with batch emails', async () => {
        const h1 = await hashUserEmail('a@qozara.org');
        const h2 = await hashUserEmail('b@qozara.org');
        mockSadd.mockResolvedValueOnce(2);

        const resBearer = await app.request('/api/v1/admin/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${ADMIN_SECRET}`,
            },
            body: JSON.stringify({
                action: 'register',
                emails: ['a@qozara.org', 'b@qozara.org'],
            }),
        }, ENV);

        expect(resBearer.status).toBe(200);
        const dataBearer = await resBearer.json() as any;
        expect(dataBearer.added).toBe(2);
        expect(dataBearer.hashes.map((x: any) => x.hash)).toEqual([h1, h2]);

        mockSmembers.mockResolvedValueOnce([h1, h2]);
        const resHeader = await app.request('/api/v1/admin/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Secret': ADMIN_SECRET,
            },
            body: JSON.stringify({ action: 'list' }),
        }, ENV);

        expect(resHeader.status).toBe(200);
        const dataHeader = await resHeader.json() as any;
        expect(dataHeader.redisCount).toBe(2);
    });

    it('should rate limit excessive admin auth requests with 429', async () => {
        mockRatelimitLimit.mockResolvedValueOnce({ success: false, limit: 15, remaining: 0 });

        const res = await app.request('/api/v1/admin/users?action=list&secret=anything', {
            method: 'GET',
        }, ENV);

        expect(res.status).toBe(429);
    });

    describe('CLI Runner (parseCliArgs & runCliCommand)', () => {
        it('should parse CLI arguments and flags accurately', () => {
            const parsed = parseCliArgs([
                'register',
                'alice@example.com',
                'bob@example.com',
                '--url',
                'http://localhost:8788',
                '--secret',
                ADMIN_SECRET,
            ]);

            expect(parsed).toEqual({
                action: 'register',
                emails: ['alice@example.com', 'bob@example.com'],
                proxyUrl: 'http://localhost:8788',
                secret: ADMIN_SECRET,
            });
        });

        it('should dispatch register, revoke, check, and list commands to admin API', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ status: 'ok', action: 'register', added: 1, hashes: [] }),
            });
            globalThis.fetch = mockFetch as any;

            const result = await runCliCommand({
                action: 'register',
                emails: ['alice@example.com'],
                proxyUrl: 'https://ai.qozara.org/',
                secret: ADMIN_SECRET,
            });

            expect(result.status).toBe('ok');
            expect(mockFetch).toHaveBeenCalledWith(
                'https://ai.qozara.org/api/v1/admin/users',
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${ADMIN_SECRET}`,
                    },
                    body: JSON.stringify({
                        action: 'register',
                        emails: ['alice@example.com'],
                    }),
                })
            );
        });
    });
});
