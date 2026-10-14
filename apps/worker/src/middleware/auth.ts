import { Context, Next } from 'hono';
import { GoogleUser, validateGoogleToken } from '../lib/google-auth.js';

export type WorkerEnv = {
    Variables: {
        user?: GoogleUser;
        clientIp: string;
        authTier: 'authenticated' | 'anonymous' | 'byok';
    };
    Bindings: {
        KMS_SECRET: string;
        GOOGLE_GENERATIVE_AI_API_KEY?: string;
        GOOGLE_GENERATIVE_AI_MODEL?: string;
        OLLAMA_AI_MODEL?: string;
        OLLAMA_BASE_URL?: string;
        KV_REST_API_URL?: string;
        KV_REST_API_TOKEN?: string;
        AI_RATE_LIMIT_REQUESTS?: string;
        AI_RATE_LIMIT_WINDOW?: string;
        ANONYMOUS_RATE_LIMIT_REQUESTS?: string;
        ANONYMOUS_RATE_LIMIT_WINDOW?: string;
        BYOK_BURST_LIMIT_REQUESTS?: string;
        BYOK_BURST_LIMIT_WINDOW?: string;
        AI_PROVIDER?: string;
        NODE_ENV?: string;
    };
};

export function getClientIp(c: Context): string {
    return (
        c.req.header('cf-connecting-ip') ||
        c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
        '127.0.0.1'
    );
}

/**
 * Optional authentication middleware:
 * - If Bearer token is present: validates Google token, sets c.var.user and authTier='authenticated'.
 * - If Bearer token is missing: allows request through as authTier='anonymous'.
 * - If Bearer token is malformed/invalid: returns 401 Unauthorized.
 * - Supports 'mock-test-token' in test/development environments.
 */
export const optionalAuthMiddleware = async (c: Context<WorkerEnv>, next: Next) => {
    const clientIp = getClientIp(c);
    c.set('clientIp', clientIp);

    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
        c.set('authTier', 'anonymous');
        return next();
    }

    if (!authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized', message: 'Malformed Authorization header' }, 401);
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token) {
        return c.json({ error: 'Unauthorized', message: 'Empty Bearer token' }, 401);
    }

    // Support for testing / dev mocking
    if (token === 'mock-test-token') {
        const env = (c.env as any)?.NODE_ENV || 'production';
        const isTest = typeof (globalThis as any).process !== 'undefined' && (globalThis as any).process.env?.NODE_ENV === 'test';
        if (isTest || env === 'development') {
            c.set('user', {
                id: 'mock-user-123',
                email: 'developer@qozara.org',
                name: 'Qozara Developer',
            });
            c.set('authTier', 'authenticated');
            return next();
        }
    }

    try {
        const user = await validateGoogleToken(token);
        c.set('user', user);
        c.set('authTier', 'authenticated');
        await next();
    } catch (error: any) {
        if (error.message === 'Invalid Google token' || error.message === 'Malformed Google userinfo response') {
            return c.json({ error: 'Unauthorized', message: 'Invalid or expired Google token' }, 401);
        }
        return c.json({ error: 'Internal Server Error', message: 'Failed to authenticate token with upstream' }, 500);
    }
};
