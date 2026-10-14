import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../src/index.js';
import { encrypt } from '../src/lib/kms.js';
import * as aiModule from 'ai';

vi.mock('ai', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
        ...actual,
        generateText: vi.fn(),
    };
});

describe('Qozara AI Proxy API Integration', () => {
    const ENV = {
        KMS_SECRET: 'supersecretkmskeyexactly32bytes!',
        GOOGLE_GENERATIVE_AI_API_KEY: 'mock-google-key',
        GOOGLE_GENERATIVE_AI_MODEL: 'gemini-2.0-flash',
        NODE_ENV: 'test',
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('GET / should return service running message', async () => {
        const res = await app.request('/', { method: 'GET' }, ENV);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('Qozara AI Proxy is Running');
    });

    it('GET /health should return service status and registered providers', async () => {
        const res = await app.request('/health', { method: 'GET' }, ENV);
        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.status).toBe('ok');
        expect(data.service).toBe('qozara-ai-proxy');
        expect(data.providers).toContain('google');
        expect(data.providers).toContain('ollama');
    });

    it('POST /api/v1/agent/encrypt should encrypt API key without authentication', async () => {
        const res = await app.request('/api/v1/agent/encrypt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://app.quozen.qozara.org',
            },
            body: JSON.stringify({ apiKey: 'AIzaSyPersonalUserKey999' }),
        }, ENV);

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.ciphertext).toBeDefined();
        expect(typeof data.ciphertext).toBe('string');
    });

    it('POST /api/v1/agent/encrypt should return 400 for empty or invalid body', async () => {
        const res = await app.request('/api/v1/agent/encrypt', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        }, ENV);

        expect(res.status).toBe(400);
    });

    it('POST /api/v1/agent/chat with BYOK ciphertext should work unauthenticated', async () => {
        const ciphertext = await encrypt('AIzaSyDecryptedUserKey', ENV.KMS_SECRET);

        vi.mocked(aiModule.generateText).mockResolvedValueOnce({
            text: 'BYOK response generated successfully',
            toolCalls: [],
        } as any);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://quomida.qozara.org',
                // Notice: ZERO Authorization header! Unauthenticated BYOK
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello BYOK' }],
                ciphertext,
                byokProvider: 'google',
            }),
        }, ENV);

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.type).toBe('text');
        expect(data.content).toBe('BYOK response generated successfully');
    });

    it('POST /api/v1/agent/chat with tool calls should return formatted tool response', async () => {
        vi.mocked(aiModule.generateText).mockResolvedValueOnce({
            text: '',
            toolCalls: [{
                toolName: 'logMeal',
                input: { foodQuery: 'Avocado Toast', quantity: 1, unit: 'slice' },
            }],
        } as any);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer mock-test-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Log 1 slice of avocado toast' }],
                tools: [{
                    name: 'logMeal',
                    description: 'Logs food intake',
                    parameters: {
                        type: 'object',
                        properties: {
                            foodQuery: { type: 'string' },
                            quantity: { type: 'number' },
                            unit: { type: 'string' },
                        },
                        required: ['foodQuery'],
                    },
                }],
            }),
        }, ENV);

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.type).toBe('tool_call');
        expect(data.tool).toBe('logMeal');
        expect(data.arguments).toEqual({ foodQuery: 'Avocado Toast', quantity: 1, unit: 'slice' });
    });

    it('POST /api/v1/agent/chat should return 400 for corrupted ciphertext', async () => {
        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Hello' }],
                ciphertext: 'invalid-corrupted-ciphertext',
            }),
        }, ENV);

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.message).toBe('Invalid ciphertext');
    });

    it('POST /api/v1/agent/chat should handle upstream 429 quota errors gracefully', async () => {
        const upstreamError = new Error('Resource has been exhausted (e.g. check quota)');
        (upstreamError as any).statusCode = 429;
        vi.mocked(aiModule.generateText).mockRejectedValueOnce(upstreamError);

        const res = await app.request('/api/v1/agent/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer mock-test-token',
            },
            body: JSON.stringify({
                messages: [{ role: 'user', content: 'Trigger quota error' }],
            }),
        }, ENV);

        expect(res.status).toBe(429);
        const data = await res.json() as any;
        expect(data.code).toBe('QUOTA_EXCEEDED');
    });
});
