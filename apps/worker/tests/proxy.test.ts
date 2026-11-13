import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSismember = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRatelimitLimit = vi.fn();

vi.mock('@upstash/redis', () => ({
    Redis: vi.fn().mockImplementation(function () {
        return {
            sismember: mockSismember,
            get: mockRedisGet,
            set: mockRedisSet,
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

vi.mock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
        ...actual,
        generateText: vi.fn(),
    };
});

import app from '../src/index.js';
import { encrypt } from '../src/lib/kms.js';
import { resetRateLimitShield } from '../src/lib/rate-limit.js';
import { clearGoogleTokenMemoryCache } from '../src/lib/google-auth.js';
import { resetAuthFailureShield } from '../src/middleware/auth.js';
import * as aiModule from 'ai';

describe('Qozara AI Proxy API Integration', () => {
    const ENV = {
        KMS_SECRET: 'supersecretkmskeyexactly32bytes!',
        GOOGLE_GENERATIVE_AI_API_KEY: 'mock-google-key',
        GOOGLE_GENERATIVE_AI_MODEL: 'gemini-2.0-flash',
        NODE_ENV: 'test',
    };

    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.clearAllMocks();
        resetRateLimitShield();
        clearGoogleTokenMemoryCache();
        resetAuthFailureShield();
        globalThis.fetch = originalFetch;
        mockRatelimitLimit.mockResolvedValue({ success: true, limit: 20, remaining: 19 });
        mockRedisGet.mockResolvedValue(null);
        mockRedisSet.mockResolvedValue('OK');
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('GET / should return service running message', async () => {
        const res = await app.request('/', { method: 'GET' }, ENV);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('Qozara AI Proxy is Running');
    });

    it('GET /health should return service status and registered providers', async () => {
        const res = await app.request('/health', { method: 'GET' }, ENV);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.status).toBe('ok');
        expect(data.service).toBe('qozara-ai-proxy');
        expect(data.providers).toContain('google');
        expect(data.providers).toContain('ollama');
    });

    it('POST /api/v1/agent/encrypt should encrypt API key without authentication', async () => {
        const res = await app.request('/api/v1/agent/encrypt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://app.quozen.qozara.org',
            },
            body: JSON.stringify({ apiKey: 'AIzaSyPersonalUserKey999' }),
        }, ENV);

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.ciphertext).toBeDefined();
        expect(typeof data.ciphertext).toBe('string');
    });

    it('POST /api/v1/agent/encrypt should return 400 for empty or invalid body', async () => {
        const res = await app.request('/api/v1/agent/encrypt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        }, ENV);

        expect(res.status).toBe(400);
    });

    it('POST /api/v1/agent/chat with BYOK ciphertext should work unauthenticated', async () => {
        const ciphertext = await encrypt('AIzaSyDecryptedUserKey', ENV.KMS_SECRET);

        vi.mocked(aiModule.generateText).mockResolvedValueOnce({
            text: 'BYOK response generated successfully',
            toolCalls: [],
        } as any);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://quomida.qozara.org',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello BYOK' }],
                ciphertext,
                byokProvider: 'google',
            }),
        }, ENV);

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.type).toBe('text');
        expect(data.content).toBe('BYOK response generated successfully');
    });

    it('POST /api/v1/agent/chat without ciphertext and without auth should return 401 UNAUTHORIZED_401', async () => {
        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://quomida.qozara.org',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Log lunch' }],
            }),
        }, ENV);

        expect(res.status).toBe(401);
        const data = await res.json() as any;
        expect(data.code).toBe('UNAUTHORIZED_401');
        expect(aiModule.generateText).not.toHaveBeenCalled();
    });

    it('POST /api/v1/agent/chat for authenticated but unregistered Google user should return 403 FORBIDDEN_403', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                sub: 'google-stranger-1',
                email: 'stranger@gmail.com',
                name: 'Stranger',
                email_verified: true,
            }),
        } as any);
        mockSismember.mockResolvedValueOnce(0);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer valid-stranger-google-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Free quota please' }],
            }),
        }, {
            ...ENV,
            NODE_ENV: 'production',
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        });

        expect(res.status).toBe(403);
        const data = await res.json() as any;
        expect(data.code).toBe('FORBIDDEN_403');
        expect(aiModule.generateText).not.toHaveBeenCalled();
    });

    it('POST /api/v1/agent/chat for registered Google user (via Redis allowlist) should return 200', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                sub: 'google-registered-1',
                email: 'registered@qozara.org',
                name: 'Registered User',
                email_verified: true,
            }),
        } as any);
        mockSismember.mockResolvedValueOnce(1);
        vi.mocked(aiModule.generateText).mockResolvedValueOnce({
            text: 'Welcome registered user',
            toolCalls: [],
        } as any);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer valid-registered-google-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello Qozara' }],
            }),
        }, {
            ...ENV,
            NODE_ENV: 'production',
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        });

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.content).toBe('Welcome registered user');
        expect(aiModule.generateText).toHaveBeenCalledWith(
            expect.objectContaining({ maxOutputTokens: 1024 })
        );
    });

    it('POST /api/v1/agent/chat for user registered via static ALLOWED_USER_EMAILS should succeed', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                sub: 'google-static-1',
                email: 'alice@qozara.org',
                name: 'Alice',
                email_verified: true,
            }),
        } as any);
        vi.mocked(aiModule.generateText).mockResolvedValueOnce({
            text: 'Static allowlist ok',
            toolCalls: [],
        } as any);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer valid-alice-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello' }],
            }),
        }, {
            ...ENV,
            NODE_ENV: 'production',
            ALLOWED_USER_EMAILS: 'alice@qozara.org',
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        });

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.content).toBe('Static allowlist ok');
    });

    it('POST /api/v1/agent/chat should fail closed with 503 if Redis rate limiter fails in production', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                sub: 'google-alice',
                email: 'alice@qozara.org',
                name: 'Alice',
                email_verified: true,
            }),
        } as any);
        mockRatelimitLimit.mockRejectedValueOnce(new Error('Upstash outage'));

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer valid-alice-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello' }],
            }),
        }, {
            ...ENV,
            NODE_ENV: 'production',
            ALLOWED_USER_EMAILS: 'alice@qozara.org',
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        });

        expect(res.status).toBe(503);
        const data = await res.json() as any;
        expect(data.code).toBe('SERVICE_UNAVAILABLE_503');
        expect(aiModule.generateText).not.toHaveBeenCalled();
    });

    it('POST /api/v1/agent/chat should reject global circuit breaker exhaustion with 429', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                sub: 'google-alice',
                email: 'alice@qozara.org',
                name: 'Alice',
                email_verified: true,
            }),
        } as any);
        mockRatelimitLimit
            .mockResolvedValueOnce({ success: true, limit: 20, remaining: 19 })
            .mockResolvedValueOnce({ success: false, limit: 500, remaining: 0 });

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer valid-alice-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello' }],
            }),
        }, {
            ...ENV,
            NODE_ENV: 'production',
            ALLOWED_USER_EMAILS: 'alice@qozara.org',
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        });

        expect(res.status).toBe(429);
        const data = await res.json() as any;
        expect(data.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(aiModule.generateText).not.toHaveBeenCalled();
    });

    it('POST /api/v1/agent/chat should reject oversized message arrays or payloads with 400', async () => {
        const tooManyMessages = Array.from({ length: 31 }, (_, i) => ({
            role: 'user',
            content: `msg ${i}`,
        }));

        const resCount = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer mock-test-token',
            },
            body: JSON.stringify({ messages: tooManyMessages }),
        }, ENV);
        expect(resCount.status).toBe(400);

        const resChars = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer mock-test-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'a'.repeat(33000) }],
            }),
        }, ENV);
        expect(resChars.status).toBe(400);
    });

    it('POST /api/v1/agent/chat with tool calls should return formatted tool response', async () => {
        vi.mocked(aiModule.generateText).mockResolvedValueOnce({
            text: '',
            toolCalls: [{
                toolName: 'logMeal',
                input: { foodQuery: 'Avocado Toast', quantity: 1, unit: 'slice' },
            }],
        } as any);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer mock-test-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Log 1 slice of avocado toast' }],
                tools: [{
                    name: 'logMeal',
                    description: 'Logs food intake',
                    parameters: {
                        type: 'object',
                        properties: {
                            foodQuery: { type: 'string' },
                            quantity: { type: 'number' },
                            unit: { type: 'string' },
                        },
                        required: ['foodQuery'],
                    },
                }],
            }),
        }, ENV);

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.type).toBe('tool_call');
        expect(data.tool).toBe('logMeal');
        expect(data.arguments).toEqual({ foodQuery: 'Avocado Toast', quantity: 1, unit: 'slice' });
    });

    it('POST /api/v1/agent/chat should return 400 for corrupted ciphertext', async () => {
        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello' }],
                ciphertext: 'invalid-corrupted-ciphertext',
            }),
        }, ENV);

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.message).toBe('Invalid ciphertext');
    });

    it('POST /api/v1/agent/chat should handle upstream 429 quota errors gracefully', async () => {
        const upstreamError = new Error('Resource has been exhausted (e.g. check quota)');
        (upstreamError as any).statusCode = 429;
        vi.mocked(aiModule.generateText).mockRejectedValueOnce(upstreamError);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer mock-test-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Trigger quota error' }],
            }),
        }, ENV);

        expect(res.status).toBe(429);
        const data = await res.json() as any;
        expect(data.code).toBe('QUOTA_EXCEEDED');
    });

    it('GET / and GET /health should set CDN Cache-Control headers to absorb volumetric floods', async () => {
        const expectedCache = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';

        const rootRes = await app.request('/', { method: 'GET' }, ENV);
        expect(rootRes.status).toBe(200);
        expect(rootRes.headers.get('Cache-Control')).toBe(expectedCache);

        const healthRes = await app.request('/health', { method: 'GET' }, ENV);
        expect(healthRes.status).toBe(200);
        expect(healthRes.headers.get('Cache-Control')).toBe(expectedCache);
    });

    it('POST /api/v1/agent/chat should reject oversized payloads (> 64 KB) with 413 before JSON parsing', async () => {
        const hugeContent = 'x'.repeat(70 * 1024);
        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer mock-test-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: hugeContent }],
            }),
        }, ENV);

        expect(res.status).toBe(413);
        const data = await res.json() as any;
        expect(data.code).toBe('PAYLOAD_TOO_LARGE_413');
        expect(aiModule.generateText).not.toHaveBeenCalled();
    });

    it('POST /api/v1/agent/chat should fail closed with 503 in production when Redis env vars are missing', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                sub: 'google-alice',
                email: 'alice@qozara.org',
                name: 'Alice',
                email_verified: true,
            }),
        } as any);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer valid-alice-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello' }],
            }),
        }, {
            ...ENV,
            NODE_ENV: 'production',
            ALLOWED_USER_EMAILS: 'alice@qozara.org',
        });

        expect(res.status).toBe(503);
        const data = await res.json() as any;
        expect(data.code).toBe('SERVICE_UNAVAILABLE_503');
        expect(aiModule.generateText).not.toHaveBeenCalled();
    });

    it('should shield Upstash Redis in memory by dropping repeat 429 flood requests without extra Redis calls', async () => {
        mockRatelimitLimit.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0 });

        const res1 = await app.request('/api/v1/agent/encrypt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-real-ip': '203.0.113.200',
            },
            body: JSON.stringify({ apiKey: 'AIzaSyFloodKey1' }),
        }, {
            ...ENV,
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        });

        expect(res1.status).toBe(429);
        expect(mockRatelimitLimit).toHaveBeenCalledTimes(1);

        const res2 = await app.request('/api/v1/agent/encrypt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-real-ip': '203.0.113.200',
            },
            body: JSON.stringify({ apiKey: 'AIzaSyFloodKey2' }),
        }, {
            ...ENV,
            KV_REST_API_URL: 'https://redis.example.com',
            KV_REST_API_TOKEN: 'token',
        });

        expect(res2.status).toBe(429);
        expect(mockRatelimitLimit).toHaveBeenCalledTimes(1);
    });
});
