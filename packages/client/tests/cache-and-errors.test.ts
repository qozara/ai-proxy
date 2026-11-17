import { describe, it, expect } from 'vitest';
import { LruMemoryCache } from '../src/cache/LruMemoryCache.js';
import {
    AiError,
    AiCommandError,
    AiMealError,
    classifyAiError,
} from '../src/errors/AiError.js';

describe('LruMemoryCache', () => {
    it('throws when capacity is <= 0', () => {
        expect(() => new LruMemoryCache(0)).toThrow();
        expect(() => new LruMemoryCache(-5)).toThrow();
    });

    it('evicts the least recently used entry when exceeding capacity', () => {
        const cache = new LruMemoryCache<string, number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        expect(cache.size).toBe(2);

        // Touch 'a' so 'b' becomes LRU
        expect(cache.get('a')).toBe(1);

        cache.set('c', 3);
        expect(cache.has('b')).toBe(false);
        expect(cache.get('a')).toBe(1);
        expect(cache.get('c')).toBe(3);
    });

    it('updates existing keys without increasing size and clears cleanly', () => {
        const cache = new LruMemoryCache<string, string>(2);
        cache.set('k1', 'v1');
        cache.set('k1', 'v2');
        expect(cache.size).toBe(1);
        expect(cache.get('k1')).toBe('v2');

        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.get('k1')).toBeUndefined();
    });
});

describe('AiError & classifyAiError', () => {
    it('exports AiCommandError and AiMealError aliases of AiError', () => {
        const err = new AiError('RATE_LIMIT_EXCEEDED', 'Quota exceeded');
        expect(err).toBeInstanceOf(AiError);
        expect(err).toBeInstanceOf(AiCommandError);
        expect(err).toBeInstanceOf(AiMealError);
        expect(classifyAiError(err)).toBe(err);
    });

    it('classifies rate limit, disabled, no items, network, auth, and parse errors', () => {
        expect(classifyAiError(new Error('429 Too Many Requests')).code).toBe('RATE_LIMIT_EXCEEDED');
        expect(classifyAiError(new Error('RATE_LIMIT_EXCEEDED')).code).toBe('RATE_LIMIT_EXCEEDED');
        expect(classifyAiError(new Error('GenAI is disabled')).code).toBe('AI_DISABLED');
        expect(classifyAiError(new Error('AI is disabled')).code).toBe('AI_DISABLED');
        expect(classifyAiError(new Error('Could not extract food items')).code).toBe('NO_ITEMS_PARSED');
        expect(classifyAiError(new Error('Failed to fetch')).code).toBe('NETWORK_ERROR');
        expect(classifyAiError(new Error('ECONNREFUSED 127.0.0.1:11434')).code).toBe('NETWORK_ERROR');
        expect(classifyAiError(new Error('HTTP 401 Unauthorized')).code).toBe('AUTHENTICATION_REQUIRED');
        expect(classifyAiError(new Error('Invalid access token provided')).code).toBe('AUTHENTICATION_REQUIRED');
        expect(classifyAiError(new Error('Malformed output')).code).toBe('PARSE_FAILED');
    });

    it('handles long adversarial token-like strings without ReDoS backtracking', () => {
        const adversarial = 'invalid ' + 'x'.repeat(25000);
        const start = performance.now();
        const classified = classifyAiError(new Error(adversarial));
        const elapsed = performance.now() - start;

        expect(classified.code).toBe('PARSE_FAILED');
        expect(elapsed).toBeLessThan(100);
    });
});
