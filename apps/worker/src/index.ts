import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { generateText, jsonSchema } from 'ai';
import { z } from 'zod';
import { dynamicCorsMiddleware } from './middleware/cors.js';
import { optionalAuthMiddleware, WorkerEnv, getClientIp, getBindings } from './middleware/auth.js';
import { encrypt, decrypt } from './lib/kms.js';
import { isUserAllowed } from './lib/allowlist.js';
import { checkRateLimit } from './lib/rate-limit.js';
import { ProviderFactory } from './providers/factory.js';
import { adminRoutes } from './routes/admin.js';

const MAX_MESSAGES_COUNT = 30;
const MAX_PROMPT_CHARS = 32_768;
const MAX_API_BODY_BYTES = 64 * 1024;
const HEALTH_CACHE_CONTROL = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';

const EncryptRequestSchema = z.object({
    apiKey: z.string().min(1, 'apiKey is required'),
});

const ChatRequestSchema = z.object({
    messages: z.array(z.any())
        .min(1, 'messages must not be empty')
        .max(MAX_MESSAGES_COUNT, `Too many messages (max ${MAX_MESSAGES_COUNT})`),
    systemPrompt: z.string().max(MAX_PROMPT_CHARS, 'systemPrompt too long').optional(),
    tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        parameters: z.any(),
    })).optional(),
    ciphertext: z.string().optional(),
    byokProvider: z.string().optional(),
}).refine((data) => {
    const totalChars = JSON.stringify(data.messages).length + (data.systemPrompt?.length || 0);
    return totalChars <= MAX_PROMPT_CHARS;
}, {
    message: `Total prompt payload exceeds maximum allowed size (${MAX_PROMPT_CHARS} characters)`,
});

const app = new Hono<WorkerEnv>();

// Apply dynamic CORS (*.qozara.org + localhost)
app.use('*', dynamicCorsMiddleware);

// Enforce 64 KB request body limit on all API routes before JSON parsing
app.use('/api/*', bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (c) => {
        return c.json({
            error: 'Payload Too Large',
            message: `Request body exceeds maximum allowed size (${MAX_API_BODY_BYTES} bytes)`,
            code: 'PAYLOAD_TOO_LARGE_413',
        }, 413);
    },
}));

// Public health checks with CDN cache headers to absorb volumetric floods
app.get('/', (c) => {
    c.header('Cache-Control', HEALTH_CACHE_CONTROL);
    return c.text('Qozara AI Proxy is Running');
});

app.get('/health', (c) => {
    c.header('Cache-Control', HEALTH_CACHE_CONTROL);
    return c.json({
        status: 'ok',
        service: 'qozara-ai-proxy',
        providers: ProviderFactory.listProviders(),
    });
});

// Mount Mode 1A Admin Console & User Allowlist Management Endpoints
app.route('/', adminRoutes);

// Optional Google OAuth middleware applied strictly to /api/v1/agent/*
app.use('/api/v1/agent/*', optionalAuthMiddleware);

/**
 * POST /api/v1/agent/encrypt
 * Stateless BYOK: Encrypts personal API key using edge KMS_SECRET.
 * Zero auth required, protected by IP burst rate limiting.
 */
app.post('/api/v1/agent/encrypt', async (c) => {
    const bindings = getBindings(c);
    const clientIp = c.get('clientIp') || getClientIp(c);

    // IP Burst Limiting (default 60 req/min)
    const burstLimit = parseInt(bindings.BYOK_BURST_LIMIT_REQUESTS || '60', 10);
    const burstWindow = (bindings.BYOK_BURST_LIMIT_WINDOW || '1 m') as any;
    const { success } = await checkRateLimit(bindings, `burst-encrypt:${clientIp}`, burstLimit, burstWindow, false);

    if (!success) {
        return c.json({
            error: 'Too Many Requests',
            message: 'Burst rate limit exceeded for encryption requests',
            code: 'RATE_LIMIT_EXCEEDED',
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
 *     - Requires authenticated Google user (401 UNAUTHORIZED_401 if missing)
 *     - Requires Mode 1A allowlist registration (403 FORBIDDEN_403 if not registered)
 *     - Enforces fail-closed per-user quota (20 req/24h) + global circuit breaker (500 req/24h)
 */
app.post('/api/v1/agent/chat', async (c) => {
    const bindings = getBindings(c);
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
        const { success } = await checkRateLimit(bindings, `burst-chat:${clientIp}`, burstLimit, burstWindow, false);

        if (!success) {
            return c.json({
                error: 'Too Many Requests',
                message: 'Burst rate limit exceeded for BYOK requests',
                code: 'RATE_LIMIT_EXCEEDED',
            }, 429);
        }
    } else if (provider.isCloud) {
        // --- QOZARA INTELLIGENCE MODE (Mode 1A Registered-User Gate) ---
        if (!user) {
            return c.json({
                error: 'Unauthorized',
                message: 'Authentication required for Qozara Intelligence. Please sign in with your registered Google account or provide a personal Gemini API key.',
                code: 'UNAUTHORIZED_401',
            }, 401);
        }

        const allowCheck = await isUserAllowed(user.email, bindings);
        if (allowCheck.error === 'ALLOWLIST_UNAVAILABLE') {
            return c.json({
                error: 'Service Unavailable',
                message: 'User allowlist service is temporarily unavailable.',
                code: 'SERVICE_UNAVAILABLE_503',
            }, 503);
        }

        if (!allowCheck.allowed) {
            return c.json({
                error: 'Forbidden',
                message: 'Your Google account is not registered for Qozara Intelligence free quota. Please contact the administrator to register your account or configure your personal Gemini API key in Settings.',
                code: 'FORBIDDEN_403',
            }, 403);
        }

        const failClosed = bindings.NODE_ENV !== 'test';

        // Per-User Sliding Window Rate Limit (default: 20 req/24h)
        const userLimit = parseInt(bindings.AI_RATE_LIMIT_REQUESTS || '20', 10);
        const userWindow = (bindings.AI_RATE_LIMIT_WINDOW || '1 d') as any;
        const userRate = await checkRateLimit(bindings, `ai-limit:user:${user.id}`, userLimit, userWindow, failClosed);

        if (userRate.error === 'RATE_LIMITER_UNAVAILABLE') {
            return c.json({
                error: 'Service Unavailable',
                message: 'Quota service temporarily unavailable. Please try again later.',
                code: 'SERVICE_UNAVAILABLE_503',
            }, 503);
        }

        if (!userRate.success) {
            return c.json({
                error: 'Too Many Requests',
                message: 'Daily quota exceeded for Qozara Intelligence. You can add your personal Gemini API key in settings for unlimited usage.',
                code: 'RATE_LIMIT_EXCEEDED',
            }, 429);
        }

        // Global Daily Circuit Breaker (default: 500 req/24h across all users)
        const globalLimit = parseInt(bindings.GLOBAL_RATE_LIMIT_REQUESTS || '500', 10);
        const globalWindow = (bindings.GLOBAL_RATE_LIMIT_WINDOW || '1 d') as any;
        const globalRate = await checkRateLimit(bindings, 'ai-limit:global', globalLimit, globalWindow, failClosed);

        if (globalRate.error === 'RATE_LIMITER_UNAVAILABLE') {
            return c.json({
                error: 'Service Unavailable',
                message: 'Quota service temporarily unavailable. Please try again later.',
                code: 'SERVICE_UNAVAILABLE_503',
            }, 503);
        }

        if (!globalRate.success) {
            return c.json({
                error: 'Too Many Requests',
                message: 'Global daily quota exceeded for Qozara Intelligence. Please try again later or configure your personal API key.',
                code: 'RATE_LIMIT_EXCEEDED',
            }, 429);
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
                parameters: jsonSchema(tool.parameters),
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
            maxOutputTokens: 1024,
            maxRetries: 0,
        });

        if (result.toolCalls && result.toolCalls.length > 0) {
            const call = result.toolCalls[0] as any;
            return c.json({
                type: 'tool_call',
                tool: call.toolName,
                arguments: call.input || call.args,
            });
        }

        return c.json({
            type: 'text',
            content: result.text,
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
                code: 'QUOTA_EXCEEDED',
            }, 429);
        }

        return c.json({
            error: 'Internal Server Error',
            message: 'LLM request failed',
        }, 500);
    }
});

export default app;
