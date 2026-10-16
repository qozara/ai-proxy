import { Hono } from 'hono';
import { env } from 'hono/adapter';
import { generateText, jsonSchema } from 'ai';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { z } from 'zod';
import { dynamicCorsMiddleware } from './middleware/cors.js';
import { optionalAuthMiddleware, WorkerEnv, getClientIp } from './middleware/auth.js';
import { encrypt, decrypt } from './lib/kms.js';
import { ProviderFactory } from './providers/factory.js';

const EncryptRequestSchema = z.object({
    apiKey: z.string().min(1, 'apiKey is required'),
});

const ChatRequestSchema = z.object({
    messages: z.array(z.any()),
    systemPrompt: z.string().optional(),
    tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        parameters: z.any(),
    })).optional(),
    ciphertext: z.string().optional(),
    byokProvider: z.string().optional(),
});

const app = new Hono<WorkerEnv>();

// Apply dynamic CORS (*.qozara.org + localhost)
app.use('*', dynamicCorsMiddleware);

// Public health checks
app.get('/', (c) => {
    return c.text('Qozara AI Proxy is Running');
});

app.get('/health', (c) => {
    return c.json({
        status: 'ok',
        service: 'qozara-ai-proxy',
        providers: ProviderFactory.listProviders(),
    });
});

// Helper: check Upstash Redis rate limiter
async function checkRateLimit(
    bindings: WorkerEnv['Bindings'],
    key: string,
    requests: number,
    window: any
): Promise<{ success: boolean; limit: number; remaining: number }> {
    const { KV_REST_API_URL, KV_REST_API_TOKEN } = bindings;
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
        return { success: true, limit: requests, remaining: requests };
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
        return await ratelimit.limit(key);
    } catch (err) {
        console.warn('Rate limiter warning (failing open):', err);
        return { success: true, limit: requests, remaining: requests };
    }
}

// Optional auth applied to /api/*
app.use('/api/*', optionalAuthMiddleware);

/**
 * POST /api/v1/agent/encrypt
 * Stateless BYOK: Encrypts personal API key using edge KMS_SECRET.
 * Zero auth required, protected by IP burst rate limiting.
 */
app.post('/api/v1/agent/encrypt', async (c) => {
    const bindings = (c.env || env(c)) as WorkerEnv['Bindings'];
    const clientIp = c.get('clientIp') || getClientIp(c);

    // IP Burst Limiting (default 60 req/min)
    const burstLimit = parseInt(bindings.BYOK_BURST_LIMIT_REQUESTS || '60', 10);
    const burstWindow = (bindings.BYOK_BURST_LIMIT_WINDOW || '1 m') as any;
    const { success } = await checkRateLimit(bindings, `burst-encrypt:${clientIp}`, burstLimit, burstWindow);

    if (!success) {
        return c.json({
            error: 'Too Many Requests',
            message: 'Burst rate limit exceeded for encryption requests',
            code: 'RATE_LIMIT_EXCEEDED'
        }, 429);
    }

    const body = await c.req.json().catch(() => null);
    const validation = EncryptRequestSchema.safeParse(body);

    if (!validation.success) {
        return c.json({
            error: 'Bad Request',
            message: 'Invalid request body',
            issues: validation.error.issues,
        }, 400);
    }

    const { apiKey } = validation.data;
    const { KMS_SECRET } = bindings;

    if (!KMS_SECRET) {
        return c.json({ error: 'Internal Server Error', message: 'KMS_SECRET not configured' }, 500);
    }

    try {
        const ciphertext = await encrypt(apiKey, KMS_SECRET);
        return c.json({ ciphertext });
    } catch (err: any) {
        console.error('Encryption failed:', err);
        return c.json({ error: 'Internal Server Error', message: err?.message || 'Encryption failed' }, 500);
    }
});

/**
 * POST /api/v1/agent/chat
 * Tiered routing:
 * - BYOK (ciphertext present): Decrypted via KMS_SECRET. IP burst limited. No Google auth required.
 * - Qozara Intelligence (no ciphertext):
 *     - Authenticated: 20 req/24h per user.id
 *     - Anonymous: 5 req/24h per clientIp
 */
app.post('/api/v1/agent/chat', async (c) => {
    const bindings = (c.env || env(c)) as WorkerEnv['Bindings'];
    const clientIp = c.get('clientIp') || getClientIp(c);
    const user = c.get('user');

    const body = await c.req.json().catch(() => null);
    const requestValidation = ChatRequestSchema.safeParse(body);

    if (!requestValidation.success) {
        return c.json({
            error: 'Bad Request',
            message: 'Invalid request body',
            issues: requestValidation.error.issues,
        }, 400);
    }

    const { messages, systemPrompt, tools, ciphertext, byokProvider } = requestValidation.data;

    let activeApiKey: string | undefined;
    const providerId = (ciphertext && byokProvider) ? byokProvider : (bindings.AI_PROVIDER || 'google');
    const provider = ProviderFactory.getProvider(providerId);

    if (!provider) {
        return c.json({ error: 'Not Found', message: `AI Provider '${providerId}' not supported` }, 404);
    }

    if (ciphertext) {
        // --- BYOK MODE ---
        const { KMS_SECRET } = bindings;
        if (!KMS_SECRET) {
            return c.json({ error: 'Internal Server Error', message: 'KMS_SECRET not configured' }, 500);
        }

        try {
            activeApiKey = await decrypt(ciphertext, KMS_SECRET);
        } catch {
            return c.json({ error: 'Bad Request', message: 'Invalid ciphertext' }, 400);
        }

        // IP burst protection against KMS oracle abuse
        const burstLimit = parseInt(bindings.BYOK_BURST_LIMIT_REQUESTS || '60', 10);
        const burstWindow = (bindings.BYOK_BURST_LIMIT_WINDOW || '1 m') as any;
        const { success } = await checkRateLimit(bindings, `burst-chat:${clientIp}`, burstLimit, burstWindow);

        if (!success) {
            return c.json({
                error: 'Too Many Requests',
                message: 'Burst rate limit exceeded for BYOK requests',
                code: 'RATE_LIMIT_EXCEEDED'
            }, 429);
        }
    } else {
        // --- QOZARA INTELLIGENCE MODE ---
        if (provider.isCloud) {
            if (user) {
                // Tier 1: Authenticated Google User (default: 20 req/24h)
                const limit = parseInt(bindings.AI_RATE_LIMIT_REQUESTS || '20', 10);
                const window = (bindings.AI_RATE_LIMIT_WINDOW || '1 d') as any;
                const { success } = await checkRateLimit(bindings, `ai-limit:user:${user.id}`, limit, window);

                if (!success) {
                    return c.json({
                        error: 'Too Many Requests',
                        message: 'Daily quota exceeded for Qozara Intelligence. You can add your personal Gemini API key in settings for unlimited usage.',
                        code: 'RATE_LIMIT_EXCEEDED'
                    }, 429);
                }
            } else {
                // Tier 2: Anonymous Local-First User (default: 5 req/24h)
                const limit = parseInt(bindings.ANONYMOUS_RATE_LIMIT_REQUESTS || '5', 10);
                const window = (bindings.ANONYMOUS_RATE_LIMIT_WINDOW || '1 d') as any;
                const { success } = await checkRateLimit(bindings, `ai-limit:anon:${clientIp}`, limit, window);

                if (!success) {
                    return c.json({
                        error: 'Too Many Requests',
                        message: 'Anonymous daily quota exceeded (5/day). Sign in for 20/day or provide your personal Gemini key.',
                        code: 'RATE_LIMIT_EXCEEDED'
                    }, 429);
                }
            }
        }
    }

    // Prepare provider configuration
    const providerConfig = provider.getTeamConfig(bindings);
    if (activeApiKey) {
        providerConfig.apiKey = activeApiKey;
    }

    const validation = provider.validateConfig(providerConfig);
    if (!validation.isValid) {
        return c.json({ error: 'Internal Server Error', message: validation.error || 'Invalid LLM configuration' }, 500);
    }

    // Convert tool format: array -> Record<string, { description, parameters }>
    const formattedTools: Record<string, any> = {};
    if (Array.isArray(tools)) {
        tools.forEach((tool: any) => {
            formattedTools[tool.name] = {
                description: tool.description,
                parameters: jsonSchema(tool.parameters)
            };
        });
    }

    try {
        const modelInstance = provider.getLanguageModel(providerConfig);

        const result = await generateText({
            model: modelInstance,
            system: systemPrompt,
            messages,
            tools: formattedTools,
            maxRetries: 0
        });

        if (result.toolCalls && result.toolCalls.length > 0) {
            const call = result.toolCalls[0] as any;
            return c.json({
                type: 'tool_call',
                tool: call.toolName,
                arguments: call.input || call.args
            });
        }

        return c.json({
            type: 'text',
            content: result.text
        });
    } catch (error: any) {
        console.error('LLM Request Error:', error);

        if (
            error?.statusCode === 429 ||
            error?.message?.toLowerCase().includes('quota') ||
            error?.message?.toLowerCase().includes('429') ||
            error?.message?.toLowerCase().includes('resource_exhausted')
        ) {
            return c.json({
                error: 'Too Many Requests',
                message: 'Upstream quota exceeded',
                code: 'QUOTA_EXCEEDED'
            }, 429);
        }

        return c.json({
            error: 'Internal Server Error',
            message: 'LLM request failed'
        }, 500);
    }
});

export default app;
