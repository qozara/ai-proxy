import { Context, Next } from 'hono';
import { env } from 'hono/adapter';
import { GoogleUser, validateGoogleToken } from '../lib/google-auth.js';

export type WorkerEnv = {
    Variables: {
        user?: GoogleUser;
        clientIp: string;
        authTier: 'authenticated' | 'anonymous' | 'byok';
    };
    Bindings: {
        KMS_SECRET: string;
        ADMIN_SECRET?: string;
        ALLOWED_USER_EMAILS?: string;
        ALLOWLIST_PEPPER?: string;
        ALLOWED_GOOGLE_CLIENT_IDS?: string;
        AUTH_FAILURE_LIMIT_REQUESTS?: string;
        GOOGLE_GENERATIVE_AI_API_KEY?: string;
        GOOGLE_GENERATIVE_AI_MODEL?: string;
        OLLAMA_AI_MODEL?: string;
        OLLAMA_BASE_URL?: string;
        KV_REST_API_URL?: string;
        KV_REST_API_TOKEN?: string;
        AI_RATE_LIMIT_REQUESTS?: string;
        AI_RATE_LIMIT_WINDOW?: string;
        GLOBAL_RATE_LIMIT_REQUESTS?: string;
        GLOBAL_RATE_LIMIT_WINDOW?: string;
        BYOK_BURST_LIMIT_REQUESTS?: string;
        BYOK_BURST_LIMIT_WINDOW?: string;
        AI_PROVIDER?: string;
        NODE_ENV?: string;
        ALLOW_MOCK_AUTH?: string;
        REQUIRE_EXPLICIT_ALLOWLIST_IN_TEST?: string;
    };
};

const AUTH_CLIENT_ERRORS = new Set([
    'Invalid Google token',
    'Malformed Google userinfo response',
    'Unverified Google email',
    'Unauthorized Google OAuth client audience',
]);

const IP_CHAR_REGEX = /^[0-9a-fA-F:.]+$/;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const MAX_AUTH_FAILURE_ENTRIES = 5_000;
const authFailureStore = new Map<string, { count: number; resetAt: number }>();

/**
 * Clears the per-IP authentication failure counter (intended for unit tests).
 */
export function resetAuthFailureShield(): void {
    authFailureStore.clear();
}

function extractIpFromHeader(raw: string | undefined, position: 'first' | 'last' = 'last'): string | null {
    if (!raw) return null;
    const candidates = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (candidates.length === 0) return null;
    const selected = position === 'first' ? candidates[0] : candidates[candidates.length - 1];
    if (selected.length <= 45 && IP_CHAR_REGEX.test(selected)) {
        return selected;
    }
    return null;
}

function recordAuthFailure(clientIp: string, now: number): void {
    const existing = authFailureStore.get(clientIp);
    if (existing && existing.resetAt > now) {
        authFailureStore.set(clientIp, {
            count: existing.count + 1,
            resetAt: existing.resetAt,
        });
        return;
    }

    if (!authFailureStore.has(clientIp) && authFailureStore.size >= MAX_AUTH_FAILURE_ENTRIES) {
        const oldestKey = authFailureStore.keys().next().value;
        if (oldestKey !== undefined) {
            authFailureStore.delete(oldestKey);
        }
    }

    authFailureStore.set(clientIp, {
        count: 1,
        resetAt: now + AUTH_FAILURE_WINDOW_MS,
    });
}

export function getBindings(c: Context<WorkerEnv>): WorkerEnv['Bindings'] {
    const rawEnv = c.env as Record<string, unknown> | undefined;
    if (rawEnv && Object.keys(rawEnv).length > 0) {
        return rawEnv as WorkerEnv['Bindings'];
    }
    return env(c) as WorkerEnv['Bindings'];
}

export function getClientIp(c: Context): string {
    const vercelIp = extractIpFromHeader(c.req.header('x-vercel-forwarded-for'), 'last');
    if (vercelIp) return vercelIp;

    const realIp = extractIpFromHeader(c.req.header('x-real-ip'), 'first');
    if (realIp) return realIp;

    const cfConnectingIp = extractIpFromHeader(c.req.header('cf-connecting-ip'), 'first');
    if (cfConnectingIp && (c.req.header('cf-ray') || !c.req.header('x-forwarded-for'))) {
        return cfConnectingIp;
    }

    const xffIp = extractIpFromHeader(c.req.header('x-forwarded-for'), 'last');
    if (xffIp) return xffIp;

    return '127.0.0.1';
}

/**
 * Optional authentication middleware:
 * - If Bearer token is present: validates Google token (guarded by per-IP failure shield), sets c.var.user and authTier='authenticated'.
 * - If Bearer token is missing: allows request through as authTier='anonymous' (enforced per-route).
 * - If Bearer token is malformed/invalid/unverified/wrong-audience: returns 401 Unauthorized (or 429 on flood).
 * - Supports 'mock-test-token' strictly in test environments (NODE_ENV === 'test' or ALLOW_MOCK_AUTH === 'true').
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
        return c.json({
            error: 'Unauthorized',
            message: 'Malformed Authorization header',
            code: 'UNAUTHORIZED_401',
        }, 401);
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token) {
        return c.json({
            error: 'Unauthorized',
            message: 'Empty Bearer token',
            code: 'UNAUTHORIZED_401',
        }, 401);
    }

    const bindings = getBindings(c);

    // Strictly restrict mock token to test suites or explicit opt-in flag
    if (token === 'mock-test-token') {
        const processEnv = typeof (globalThis as any).process !== 'undefined'
            ? (globalThis as any).process.env?.NODE_ENV
            : undefined;
        const runtimeEnv = bindings?.NODE_ENV ?? processEnv ?? 'production';
        const allowMock = runtimeEnv === 'test' || bindings?.ALLOW_MOCK_AUTH === 'true';

        if (allowMock) {
            c.set('user', {
                id: 'mock-user-123',
                email: 'developer@qozara.org',
                name: 'Qozara Developer',
                email_verified: true,
            });
            c.set('authTier', 'authenticated');
            return next();
        }
    }

    const maxFailures = Math.max(1, parseInt(bindings?.AUTH_FAILURE_LIMIT_REQUESTS || '15', 10) || 15);
    const now = Date.now();
    const failureState = authFailureStore.get(clientIp);
    if (failureState && failureState.resetAt > now && failureState.count >= maxFailures) {
        return c.json({
            error: 'Too Many Requests',
            message: 'Too many failed authentication attempts. Please try again later.',
            code: 'RATE_LIMIT_EXCEEDED',
        }, 429);
    }

    const allowedClientIds = (bindings?.ALLOWED_GOOGLE_CLIENT_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

    try {
        const user = await validateGoogleToken(token, {
            allowedClientIds,
            redisUrl: bindings?.KV_REST_API_URL,
            redisToken: bindings?.KV_REST_API_TOKEN,
        });
        c.set('user', user);
        c.set('authTier', 'authenticated');
        await next();
    } catch (error: any) {
        if (AUTH_CLIENT_ERRORS.has(error?.message)) {
            recordAuthFailure(clientIp, now);
            return c.json({
                error: 'Unauthorized',
                message: 'Invalid, unverified, or unauthorized Google token',
                code: 'UNAUTHORIZED_401',
            }, 401);
        }
        return c.json({
            error: 'Internal Server Error',
            message: 'Failed to authenticate token with upstream',
        }, 500);
    }
};
