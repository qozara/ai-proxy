import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import type { WorkerEnv } from '../middleware/auth.js';

export interface RateLimitResult {
    success: boolean;
    limit: number;
    remaining: number;
    error?: 'RATE_LIMITER_UNAVAILABLE';
}

interface MemoryRateEntry {
    count: number;
    resetAt: number;
    blockedUntil: number;
}

const MAX_MEMORY_ENTRIES = 5_000;
const MAX_SHIELD_BLOCK_MS = 60_000;
const memoryRateStore = new Map<string, MemoryRateEntry>();

/**
 * Clears the isolate in-memory rate-limit shield (intended for unit tests).
 */
export function resetRateLimitShield(): void {
    memoryRateStore.clear();
}

function parseWindowMs(window: unknown): number {
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
        return window;
    }
    if (typeof window === 'string') {
        const match = window.trim().match(/^(\d+)\s*([smhd])$/i);
        if (match) {
            const amount = parseInt(match[1], 10);
            const unit = match[2].toLowerCase();
            const multipliers: Record<string, number> = {
                s: 1_000,
                m: 60_000,
                h: 3_600_000,
                d: 86_400_000,
            };
            return amount * (multipliers[unit] || 60_000);
        }
    }
    return 60_000;
}

function setBoundedEntry(key: string, value: MemoryRateEntry): void {
    if (!memoryRateStore.has(key) && memoryRateStore.size >= MAX_MEMORY_ENTRIES) {
        const oldestKey = memoryRateStore.keys().next().value;
        if (oldestKey !== undefined) {
            memoryRateStore.delete(oldestKey);
        }
    }
    memoryRateStore.set(key, value);
}

function checkInMemoryLimit(key: string, requests: number, windowMs: number, now: number): RateLimitResult {
    const existing = memoryRateStore.get(key);
    const active = existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + windowMs, blockedUntil: 0 };

    const nextCount = active.count + 1;
    if (nextCount > requests) {
        setBoundedEntry(key, {
            count: nextCount,
            resetAt: active.resetAt,
            blockedUntil: active.resetAt,
        });
        return { success: false, limit: requests, remaining: 0 };
    }

    setBoundedEntry(key, {
        count: nextCount,
        resetAt: active.resetAt,
        blockedUntil: 0,
    });
    return { success: true, limit: requests, remaining: Math.max(0, requests - nextCount) };
}

/**
 * Checks Upstash Redis sliding-window rate limits with an isolate in-memory flood shield.
 * - Drops repeat already-blocked keys in-memory without extra Redis commands.
 * - `failClosed = false`: enforces in-memory fallback when Redis is unconfigured, and fails open on Redis errors.
 * - `failClosed = true`: returns `RATE_LIMITER_UNAVAILABLE` if Redis env vars are missing or Redis errors.
 */
export async function checkRateLimit(
    bindings: Pick<WorkerEnv['Bindings'], 'KV_REST_API_URL' | 'KV_REST_API_TOKEN'>,
    key: string,
    requests: number,
    window: any,
    failClosed: boolean = false
): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = parseWindowMs(window);

    // Isolate flood shield: drop repeat requests already rate-limited without hitting Upstash Redis
    const shielded = memoryRateStore.get(key);
    if (shielded && shielded.blockedUntil > now) {
        return { success: false, limit: requests, remaining: 0 };
    }

    const { KV_REST_API_URL, KV_REST_API_TOKEN } = bindings;
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
        if (failClosed) {
            return { success: false, limit: 0, remaining: 0, error: 'RATE_LIMITER_UNAVAILABLE' };
        }
        return checkInMemoryLimit(key, requests, windowMs, now);
    }

    try {
        const redis = new Redis({
            url: KV_REST_API_URL,
            token: KV_REST_API_TOKEN,
        });
        const ratelimit = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(requests, window),
        });
        const result = await ratelimit.limit(key);

        if (!result.success) {
            setBoundedEntry(key, {
                count: requests + 1,
                resetAt: now + Math.min(windowMs, MAX_SHIELD_BLOCK_MS),
                blockedUntil: now + Math.min(windowMs, MAX_SHIELD_BLOCK_MS),
            });
        }

        return result;
    } catch (err) {
        if (failClosed) {
            console.error('Rate limiter error (failing closed):', err);
            return { success: false, limit: 0, remaining: 0, error: 'RATE_LIMITER_UNAVAILABLE' };
        }
        console.warn('Rate limiter warning (failing open):', err);
        return { success: true, limit: requests, remaining: requests };
    }
}
