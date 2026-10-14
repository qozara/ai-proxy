import { Context, Next } from 'hono';

const ALLOWED_ORIGIN_REGEX = /^https:\/\/([a-z0-9-]+\.)*qozara\.org$/;
const LOCALHOST_REGEX = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    return ALLOWED_ORIGIN_REGEX.test(origin) || LOCALHOST_REGEX.test(origin);
}

export const dynamicCorsMiddleware = async (c: Context, next: Next) => {
    const origin = c.req.header('Origin');

    if (origin && isAllowedOrigin(origin)) {
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
        c.header('Access-Control-Max-Age', '86400');
        c.header('Vary', 'Origin');
    }

    if (c.req.method === 'OPTIONS') {
        return c.body(null, 204);
    }

    await next();
};
