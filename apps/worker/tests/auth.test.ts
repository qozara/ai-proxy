import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { optionalAuthMiddleware, WorkerEnv } from '../src/middleware/auth.js';

describe('Tiered Auth Middleware', () => {
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

    it('should reject malformed Authorization headers with 401', async () => {
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
    });

    it('should reject invalid upstream tokens with 401', async () => {
        const testApp = createTestApp();
        // Mock global fetch to return 401 from Google userinfo
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: 'invalid_token' }),
        } as any);

        try {
            const res = await testApp.request('/api/test', {
                method: 'GET',
                headers: {
                    Authorization: 'Bearer expired-or-invalid-token',
                },
            });

            expect(res.status).toBe(401);
            const data = await res.json() as any;
            expect(data.error).toBe('Unauthorized');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
