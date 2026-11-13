import { Redis } from '@upstash/redis';
import { sha256Hex } from './allowlist.js';

export interface GoogleUser {
    id: string;
    email: string;
    name: string;
    picture?: string;
    email_verified?: boolean;
}

export interface ValidateGoogleTokenOptions {
    allowedClientIds?: string[];
    redisUrl?: string;
    redisToken?: string;
}

const TOKEN_CACHE_TTL_SECONDS = 300;
const TOKEN_CACHE_PREFIX = 'qozara-token-cache-v1';
const NEGATIVE_CACHE_TTL_MS = 60_000;
const MAX_NEGATIVE_CACHE_ENTRIES = 1_000;

const negativeTokenCache = new Map<string, { errorMsg: string; expiresAt: number }>();

/**
 * Clears the in-memory negative token cache (intended for unit tests).
 */
export function clearGoogleTokenMemoryCache(): void {
    negativeTokenCache.clear();
}

function recordNegativeToken(tokenHash: string, errorMsg: string): void {
    if (!negativeTokenCache.has(tokenHash) && negativeTokenCache.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
        const oldestKey = negativeTokenCache.keys().next().value;
        if (oldestKey !== undefined) {
            negativeTokenCache.delete(oldestKey);
        }
    }
    negativeTokenCache.set(tokenHash, {
        errorMsg,
        expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
    });
}

/**
 * Validates a Google OAuth2 access token by querying Google's userinfo endpoint,
 * enforcing verified email status, optionally checking OAuth client audience
 * (`aud`/`azp`), caching verified identities in Upstash Redis for 5 minutes,
 * and negative-caching rejected tokens in memory for 60 seconds.
 */
export async function validateGoogleToken(
    token: string,
    options?: ValidateGoogleTokenOptions
): Promise<GoogleUser> {
    const allowedClientIds = (options?.allowedClientIds || [])
        .map((id) => id.trim())
        .filter(Boolean);

    const audienceScope = allowedClientIds.slice().sort().join(',');
    const tokenHash = await sha256Hex(`${TOKEN_CACHE_PREFIX}:${audienceScope}:${token}`);

    const neg = negativeTokenCache.get(tokenHash);
    if (neg) {
        if (neg.expiresAt > Date.now()) {
            throw new Error(neg.errorMsg);
        }
        negativeTokenCache.delete(tokenHash);
    }

    let redis: Redis | null = null;
    const cacheKey = `auth-cache:${tokenHash}`;

    if (options?.redisUrl && options?.redisToken) {
        try {
            redis = new Redis({
                url: options.redisUrl,
                token: options.redisToken,
            });
            const cached = await redis.get<GoogleUser>(cacheKey);
            if (cached && cached.id && cached.email && cached.email_verified !== false) {
                return cached;
            }
        } catch {
            // Fall through to live Google verification if cache read fails
        }
    }

    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
            recordNegativeToken(tokenHash, 'Invalid Google token');
        }
        throw new Error('Invalid Google token');
    }

    const data = await response.json() as any;

    if ((!data.sub && !data.id) || typeof data.email !== 'string' || !data.email.trim()) {
        recordNegativeToken(tokenHash, 'Malformed Google userinfo response');
        throw new Error('Malformed Google userinfo response');
    }

    if (data.email_verified === false) {
        recordNegativeToken(tokenHash, 'Unverified Google email');
        throw new Error('Unverified Google email');
    }

    if (allowedClientIds.length > 0) {
        const tokenInfoRes = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
            { headers: { Accept: 'application/json' } }
        );

        if (!tokenInfoRes.ok) {
            if (tokenInfoRes.status >= 400 && tokenInfoRes.status < 500) {
                recordNegativeToken(tokenHash, 'Invalid Google token');
            }
            throw new Error('Invalid Google token');
        }

        const tokenInfo = await tokenInfoRes.json() as any;
        const matchesAudience =
            (typeof tokenInfo?.aud === 'string' && allowedClientIds.includes(tokenInfo.aud)) ||
            (typeof tokenInfo?.azp === 'string' && allowedClientIds.includes(tokenInfo.azp));

        if (!matchesAudience) {
            recordNegativeToken(tokenHash, 'Unauthorized Google OAuth client audience');
            throw new Error('Unauthorized Google OAuth client audience');
        }
    }

    const user: GoogleUser = {
        id: data.sub || data.id,
        email: data.email.trim(),
        name: data.name || data.email.split('@')[0] || 'User',
        picture: data.picture,
        email_verified: data.email_verified ?? true,
    };

    if (redis) {
        try {
            await redis.set(cacheKey, user, { ex: TOKEN_CACHE_TTL_SECONDS });
        } catch {
            // Non-fatal cache write failure
        }
    }

    return user;
}
