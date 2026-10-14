import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiProviderFactory } from '../src/providers/AiProviderFactory.js';
import { LocalOllamaProvider } from '../src/providers/LocalOllamaProvider.js';

describe('AiProviderFactory & Fallback Logic', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('should create DisabledAiProvider when preference is disabled', async () => {
        const provider = await AiProviderFactory.createProvider({
            providerPreference: 'disabled',
        });

        expect(provider.id).toBe('disabled');
        expect(provider.mode).toBe('disabled');
        expect((await provider.chat({ messages: [] })).error).toBe('AI is disabled');
    });

    it('should create ProxyAiProvider with mode byok when explicit byok is selected', async () => {
        const provider = await AiProviderFactory.createProvider({
            providerPreference: 'byok',
            encryptedApiKey: 'ciphertext-123',
            proxyUrl: 'https://ai.qozara.org',
        });

        expect(provider.id).toBe('cloud-proxy');
        expect(provider.mode).toBe('byok');
    });

    it('should create LocalOllamaProvider when local is selected', async () => {
        const provider = await AiProviderFactory.createProvider({
            providerPreference: 'local',
            baseUrl: 'http://localhost:11434/api',
            ollamaModel: 'qwen2.5:0.5b',
        });

        expect(provider.id).toBe('local-ollama');
        expect(provider.mode).toBe('local-ollama');
    });

    it('should dynamically extract arbitrary client tools in LocalOllamaProvider without hardcoded schemas', async () => {
        const provider = new LocalOllamaProvider('http://localhost:11434/api', 'qwen2.5:0.5b');

        // Mock Ollama chat endpoint returning JSON with custom tool name
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                message: {
                    content: JSON.stringify({
                        logMeal: { foodQuery: 'Empanada de carne', quantity: 2, unit: 'unit' },
                    }),
                },
            }),
        } as any);

        const response = await provider.chat({
            messages: [{ role: 'user', content: '2 empanadas' }],
            tools: [{
                name: 'logMeal',
                description: 'Logs food intake',
                parameters: {},
            }],
        });

        expect(response.type).toBe('tool_call');
        expect(response.tool).toBe('logMeal');
        expect(response.arguments).toEqual({
            foodQuery: 'Empanada de carne',
            quantity: 2,
            unit: 'unit',
        });
    });

    it('should follow polymorphic waterfall in auto mode: BYOK first', async () => {
        const provider = await AiProviderFactory.createProvider({
            providerPreference: 'auto',
            encryptedApiKey: 'ciphertext-exists',
            proxyUrl: 'https://ai.qozara.org',
        });

        expect(provider.id).toBe('cloud-proxy');
        expect(provider.mode).toBe('byok');
    });

    it('should fall back to Qozara Intelligence cloud proxy when no local provider is available', async () => {
        // Mock fetch to return false for Ollama checkAvailability
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

        const provider = await AiProviderFactory.createProvider({
            providerPreference: 'auto',
            proxyUrl: 'https://ai.qozara.org',
        });

        expect(provider.id).toBe('cloud-proxy');
        expect(provider.mode).toBe('cloud');
    });
});
