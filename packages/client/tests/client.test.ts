import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentClient } from '../src/AgentClient.js';

describe('AgentClient SDK', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('should encrypt API key without requiring auth token', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ciphertext: 'mock-encrypted-ciphertext' }),
        } as any);

        const client = new AgentClient('https://ai.qozara.org');
        const ciphertext = await client.encryptApiKey('my-secret-gemini-key');

        expect(ciphertext).toBe('mock-encrypted-ciphertext');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://ai.qozara.org/api/v1/agent/encrypt',
            expect.objectContaining({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: 'my-secret-gemini-key' }),
            })
        );
    });

    it('should attach Bearer token if getAuthToken is provided and returns a token', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ciphertext: 'ciphertext-with-auth' }),
        } as any);

        const client = new AgentClient('https://ai.qozara.org', () => 'user-token-xyz');
        const ciphertext = await client.encryptApiKey('my-secret-gemini-key');

        expect(ciphertext).toBe('ciphertext-with-auth');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://ai.qozara.org/api/v1/agent/encrypt',
            expect.objectContaining({
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer user-token-xyz',
                },
            })
        );
    });

    it('should handle chat responses with tool calls', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                type: 'tool_call',
                tool: 'addExpense',
                arguments: { amount: 45, description: 'Lunch' },
            }),
        } as any);

        const client = new AgentClient('https://ai.qozara.org');
        const response = await client.chat({
            messages: [{ role: 'user', content: 'Lunch for 45' }],
            tools: [{ name: 'addExpense', description: 'Add expense', parameters: {} }],
        });

        expect(response.type).toBe('tool_call');
        expect(response.tool).toBe('addExpense');
        expect(response.arguments).toEqual({ amount: 45, description: 'Lunch' });
    });

    it('should return error object on failed HTTP response', async () => {
        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 429,
            json: async () => ({ code: 'RATE_LIMIT_EXCEEDED', message: 'Quota exceeded' }),
        } as any);

        const client = new AgentClient('https://ai.qozara.org');
        const response = await client.chat({
            messages: [{ role: 'user', content: 'Hello' }],
        });

        expect(response.type).toBe('text');
        expect(response.error).toBe('RATE_LIMIT_EXCEEDED');
    });
});
