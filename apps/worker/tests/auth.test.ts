import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();

vi.mock('@upstash/redis', () => ({
    Redis: vi.fn().mockImplementation(function () {
        return {
            get: mockRedisGet,
            set: mockRedisSet,
        };
    }),
}));

import {
    optionalAuthMiddleware,
    getClientIp,
    resetAuthFailureShield,
    WorkerEnv,
} from '../src/middleware/auth.js';
import { clearGoogleTokenMemoryCache } from '../src/lib/google-auth.js';

describe('Tiered Auth Middleware', () => {
    const originalFetch = globalThis.fetch;

    function createTestApp() {
        const testApp = new Hono<WorkerEnv>();
        testApp.use('/api/*', optionalAuthMiddleware);
        testApp.get('/api/test', (c) => {
            return c.json({
                authTier: c.get('authTier'),
                user: c.get('user') || null,
                clientIp: c.get('clientIp'),
            });
        });
        return testApp;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        clearGoogleTokenMemoryCache();
        resetAuthFailureShield();
        globalThis.fetch = originalFetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('should allow unauthenticated requests with anonymous tier', async () => {
        const testApp = createTestApp();
        const res = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                'x-forwarded-for': '203.0.113.195',
            },
        });

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.authTier).toBe('anonymous');
        expect(data.user).toBeNull();
        expect(data.clientIp).toBe('203.0.113.195');
    });

    it('should authenticate mock-test-token in test environment', async () => {
        const testApp = createTestApp();
        const res = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer mock-test-token',
            },
        });

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.authTier).toBe('authenticated');
        expect(data.user.email).toBe('developer@qozara.org');
    });

    it('should reject mock-test-token in development and production environments', async () => {
        const testApp = createTestApp();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'invalid_token' }),
        } as any);

        const devRes = await testApp.request('/api/test', {
            method: 'GET',
            headers: { Authorization: 'Bearer mock-test-token' },
        }, { KMS_SECRET: 'supersecretkmskeyexactly32bytes!', NODE_ENV: 'development' });

        expect(devRes.status).toBe(401);

        const prodRes = await testApp.request('/api/test', {
            method: 'GET',
            headers: { Authorization: 'Bearer mock-test-token' },
        }, { KMS_SECRET: 'supersecretkmskeyexactly32bytes!', NODE_ENV: 'production' });

        expect(prodRes.status).toBe(401);
    });

    it('should reject malformed Authorization headers with 401 and UNAUTHORIZED_401 code', async () => {
        const testApp = createTestApp();
        const res = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Basic not-a-bearer-token',
            },
        });

        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.error).toBe('Unauthorized');
        expect(data.code).toBe('UNAUTHORIZED_401');
    });

    it('should reject invalid upstream tokens with 401', async () => {
        const testApp = createTestApp();
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'invalid_token' }),
        } as any);

        const res = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer expired-or-invalid-token',
            },
        });

        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.error).toBe('Unauthorized');
        expect(data.code).toBe('UNAUTHORIZED_401');
    });

    it('should reject Google accounts with email_verified: false or missing email', async () => {
        const testApp = createTestApp();
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                sub: 'google-123',
                email: 'unverified@example.com',
                email_verified: false,
            }),
        } as any);

        const res = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer unverified-email-token',
            },
        });

        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.code).toBe('UNAUTHORIZED_401');
    });

    it('should reject Google tokens from unauthorized OAuth Client IDs when ALLOWED_GOOGLE_CLIENT_IDS is set', async () => {
        const testApp = createTestApp();
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    sub: 'google-123',
                    email: 'alice@example.com',
                    email_verified: true,
                }),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    aud: 'evil-third-party-client-id.apps.googleusercontent.com',
                    azp: 'evil-third-party-client-id.apps.googleusercontent.com',
                }),
            } as any);

        const res = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer third-party-token',
            },
        }, {
            KMS_SECRET: 'supersecretkmskeyexactly32bytes!',
            ALLOWED_GOOGLE_CLIENT_IDS: 'quozen-client-id.apps.googleusercontent.com, quomida-client-id.apps.googleusercontent.com',
        });

        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.code).toBe('UNAUTHORIZED_401');
    });

    it('should accept Google tokens matching ALLOWED_GOOGLE_CLIENT_IDS and cache them in Redis', async () => {
        const testApp = createTestApp();
        mockRedisGet.mockResolvedValueOnce(null);
        mockRedisSet.mockResolvedValueOnce('OK');

        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    sub: 'google-456',
                    email: 'alice@example.com',
                    name: 'Alice',
                    email_verified: true,
                }),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    aud: 'quomida-client-id.apps.googleusercontent.com',
                    azp: 'quomida-client-id.apps.googleusercontent.com',
                }),
            } as any);

        const env = {
            KMS_SECRET: 'supersecretkmskeyexactly32bytes!',
            ALLOWED_GOOGLE_CLIENT_IDS: 'quozen-client-id.apps.googleusercontent.com,quomida-client-id.apps.googleusercontent.com',
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        };

        const res1 = await testApp.request('/api/test', {
            method: 'GET',
            headers: { Authorization: 'Bearer valid-quomida-token' },
        }, env);

        expect(res1.status).toBe(200);
        const data1 = await res1.json() as any;
        expect(data1.user.email).toBe('alice@example.com');
        expect(mockRedisSet).toHaveBeenCalledWith(
            expect.stringMatching(/^auth-cache:[0-9a-f]{64}$/),
            expect.objectContaining({ id: 'google-456', email: 'alice@example.com' }),
            { ex: 300 }
        );

        // Second request should hit Redis cache without calling fetch
        mockRedisGet.mockResolvedValueOnce({
            id: 'google-456',
            email: 'alice@example.com',
            name: 'Alice',
            email_verified: true,
        });
        globalThis.fetch = vi.fn();

        const res2 = await testApp.request('/api/test', {
            method: 'GET',
            headers: { Authorization: 'Bearer valid-quomida-token' },
        }, env);

        expect(res2.status).toBe(200);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('getClientIp should extract rightmost IP from multi-hop x-forwarded-for and resist header spoofing', async () => {
        const testApp = createTestApp();

        // Spoofed first IP prepended to x-forwarded-for should NOT be trusted over proxy-appended rightmost IP
        const resXff = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                'x-forwarded-for': '198.51.100.99, 203.0.113.45',
            },
        });
        expect(((await resXff.json()) as any).clientIp).toBe('203.0.113.45');

        // x-vercel-forwarded-for / x-real-ip takes priority over spoofed cf-connecting-ip without cf-ray
        const resVercel = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                'cf-connecting-ip': '198.51.100.1',
                'x-vercel-forwarded-for': '203.0.113.77',
                'x-forwarded-for': '198.51.100.1, 203.0.113.77',
            },
        });
        expect(((await resVercel.json()) as any).clientIp).toBe('203.0.113.77');

        // cf-connecting-ip is trusted when accompanied by cf-ray
        const resCf = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                'cf-ray': '8a1b2c3d4e5f-MIA',
                'cf-connecting-ip': '203.0.113.88',
                'x-forwarded-for': '10.0.0.1, 203.0.113.88',
            },
        });
        expect(((await resCf.json()) as any).clientIp).toBe('203.0.113.88');
        expect(typeof getClientIp).toBe('function');
    });

    it('should negative-cache invalid Google tokens in memory to prevent repeated upstream hits', async () => {
        const testApp = createTestApp();
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'invalid_token' }),
        } as any);
        globalThis.fetch = fetchMock;

        const res1 = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer repeated-bogus-token',
                'x-real-ip': '203.0.113.10',
            },
        });
        expect(res1.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const res2 = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer repeated-bogus-token',
                'x-real-ip': '203.0.113.10',
            },
        });
        expect(res2.status).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should rate-limit per-IP authentication failures after threshold with 429 before calling upstream', async () => {
        const testApp = createTestApp();
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'invalid_token' }),
        } as any);
        globalThis.fetch = fetchMock;

        for (let i = 0; i < 15; i++) {
            const res = await testApp.request('/api/test', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer random-invalid-token-${i}`,
                    'x-real-ip': '203.0.113.250',
                },
            });
            expect(res.status).toBe(401);
        }
        expect(fetchMock).toHaveBeenCalledTimes(15);

        const blockedRes = await testApp.request('/api/test', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer random-invalid-token-15',
                'x-real-ip': '203.0.113.250',
            },
        });
        expect(blockedRes.status).toBe(429);
        const data = (await blockedRes.json()) as any;
        expect(data.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(fetchMock).toHaveBeenCalledTimes(15);
    });
});
