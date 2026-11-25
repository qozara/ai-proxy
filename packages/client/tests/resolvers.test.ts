import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LruMemoryCache } from '../src/cache/LruMemoryCache.js';
import { AiError } from '../src/errors/AiError.js';
import { extractToolCallData } from '../src/resolvers/extractToolCallData.js';
import { createGenAiToolResolver } from '../src/resolvers/GenAiToolResolver.js';
import { createCompositeAiResolver } from '../src/resolvers/CompositeAiResolver.js';

describe('extractToolCallData', () => {
    it('extracts native AgentChatResponse tool_call objects and stringified arguments', () => {
        expect(
            extractToolCallData({
                type: 'tool_call',
                tool: 'addExpense',
                arguments: { amount: 42, description: 'Dinner' },
            })
        ).toEqual({
            toolName: 'addExpense',
            args: { amount: 42, description: 'Dinner' },
        });

        expect(
            extractToolCallData({
                type: 'tool_call',
                tool: 'addExpense',
                arguments: '{"amount": 15, "description": "Uber"}',
            })
        ).toEqual({
            toolName: 'addExpense',
            args: { amount: 15, description: 'Uber' },
        });
    });

    it('extracts OpenAI tool_calls and choices[0].message formats', () => {
        expect(
            extractToolCallData({
                tool_calls: [
                    {
                        function: {
                            name: 'decompose_dish',
                            arguments: '{"dish_name":"Locro","ingredients":[]}',
                        },
                    },
                ],
            })
        ).toEqual({
            toolName: 'decompose_dish',
            args: { dish_name: 'Locro', ingredients: [] },
        });

        expect(
            extractToolCallData({
                choices: [
                    {
                        message: {
                            tool_calls: [
                                {
                                    name: 'decompose_dish',
                                    arguments: { dish_name: 'Asado', ingredients: [] },
                                },
                            ],
                        },
                    },
                ],
            })
        ).toEqual({
            toolName: 'decompose_dish',
            args: { dish_name: 'Asado', ingredients: [] },
        });
    });

    it('extracts JSON wrapped in markdown fences from text content', () => {
        expect(
            extractToolCallData({
                type: 'text',
                content: 'Here you go:\n```json\n{"tool": "addExpense", "arguments": {"amount": 9}}\n```',
            })
        ).toEqual({
            toolName: 'addExpense',
            args: { amount: 9 },
        });
    });
});

describe('GenAiToolResolver', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('caches successful results and skips repeat network calls', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                type: 'tool_call',
                tool: 'decompose_dish',
                arguments: { dish_name: 'Locro', count: 5 },
            }),
        } as any);
        globalThis.fetch = fetchMock;

        const cache = new LruMemoryCache<string, { dish: string }>(10);
        const resolver = createGenAiToolResolver<{ query: string }, { dish: string }>({
            factoryConfig: {
                providerPreference: 'cloud',
                proxyUrl: 'https://ai.qozara.org',
            },
            cache,
            getCacheKey: (input) => input.query.trim().toLowerCase(),
            buildRequest: (input) => ({
                messages: [{ role: 'user', content: input.query }],
                tools: [{ name: 'decompose_dish', description: 'Decompose', parameters: {} }],
            }),
            parseResponse: (extracted) => (extracted ? { dish: extracted.args.dish_name } : null),
        });

        const first = await resolver.resolve({ query: 'Locro' });
        const second = await resolver.resolve({ query: '  locro  ' });

        expect(first).toEqual({ dish: 'Locro' });
        expect(second).toEqual({ dish: 'Locro' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('classifies provider errors and never caches failures', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
            json: async () => ({ code: 'RATE_LIMIT_EXCEEDED', message: 'Quota hit' }),
        } as any);

        const cache = new LruMemoryCache<string, { dish: string }>(10);
        const resolver = createGenAiToolResolver<{ query: string }, { dish: string }>({
            factoryConfig: {
                providerPreference: 'cloud',
                proxyUrl: 'https://ai.qozara.org',
            },
            cache,
            getCacheKey: (input) => input.query,
            buildRequest: (input) => ({ messages: [{ role: 'user', content: input.query }] }),
            parseResponse: () => ({ dish: 'ignored' }),
        });

        await expect(resolver.resolve({ query: 'Locro' })).rejects.toThrow(AiError);
        try {
            await resolver.resolve({ query: 'Locro' });
        } catch (err) {
            expect(err).toBeInstanceOf(AiError);
            expect((err as AiError).code).toBe('RATE_LIMIT_EXCEEDED');
        }
        expect(cache.size).toBe(0);
    });

    it('retries once via onAuthExpired when proxy returns 401 and distinguishes 403 FORBIDDEN_NOT_REGISTERED', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                json: async () => ({
                    code: 'UNAUTHORIZED_401',
                    message: 'Invalid or expired Google token',
                }),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    type: 'tool_call',
                    tool: 'decompose_dish',
                    arguments: { dish_name: 'Humita' },
                }),
            } as any);
        globalThis.fetch = fetchMock;

        const onAuthExpired = vi.fn().mockResolvedValue('fresh-token-after-401');

        const resolver = createGenAiToolResolver<{ query: string }, { dish: string }>({
            factoryConfig: {
                providerPreference: 'cloud',
                proxyUrl: 'https://ai.qozara.org',
            },
            getAuthToken: () => 'expired-initial-token',
            onAuthExpired,
            buildRequest: (input) => ({ messages: [{ role: 'user', content: input.query }] }),
            parseResponse: (extracted) => (extracted ? { dish: extracted.args.dish_name } : null),
        });

        const resolved = await resolver.resolve({ query: 'Humita' });
        expect(resolved).toEqual({ dish: 'Humita' });
        expect(onAuthExpired).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-token-after-401');

        // 403 FORBIDDEN_403 must NOT trigger onAuthExpired and must surface FORBIDDEN_NOT_REGISTERED
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 403,
            json: async () => ({
                code: 'FORBIDDEN_403',
                message: 'Your Google account is not registered for Qozara Intelligence free quota.',
            }),
        } as any);
        onAuthExpired.mockClear();

        await expect(resolver.resolve({ query: 'Empanada' })).rejects.toMatchObject({
            name: 'AiError',
            code: 'FORBIDDEN_NOT_REGISTERED',
        });
        expect(onAuthExpired).not.toHaveBeenCalled();
    });
});

describe('CompositeAiResolver', () => {
    it('short-circuits on symbolic resolution when shouldEscalate returns false', async () => {
        const genAiSpy = vi.fn();
        const resolver = createCompositeAiResolver<string, { items: string[]; unmatched: boolean }>({
            symbolicResolve: (input) => ({ items: [input], unmatched: false }),
            shouldEscalate: (res) => res.unmatched,
            genAiResolve: genAiSpy,
        });

        const result = await resolver.resolveWithMetadata('apple', undefined);
        expect(result.source).toBe('symbolic');
        expect(result.output).toEqual({ items: ['apple'], unmatched: false });
        expect(genAiSpy).not.toHaveBeenCalled();
    });

    it('escalates to GenAI when shouldEscalate returns true and supports graceful fallback', async () => {
        const resolver = createCompositeAiResolver<string, { items: string[]; unmatched: boolean }>({
            symbolicResolve: (input) => ({ items: [input], unmatched: true }),
            shouldEscalate: (res) => res.unmatched,
            genAiResolve: async (input) => {
                if (input === 'fail') throw new Error('Network offline');
                return { items: ['corn', 'beans'], unmatched: false };
            },
            onGenAiError: (_err, symbolicOutput) => symbolicOutput,
        });

        const escalated = await resolver.resolveWithMetadata('locro', undefined);
        expect(escalated.source).toBe('composite');
        expect(escalated.output).toEqual({ items: ['corn', 'beans'], unmatched: false });

        const degraded = await resolver.resolveWithMetadata('fail', undefined);
        expect(degraded.source).toBe('symbolic-fallback');
        expect(degraded.output).toEqual({ items: ['fail'], unmatched: true });
    });
});
