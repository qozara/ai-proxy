import { LruMemoryCache } from '../cache/LruMemoryCache.js';
import { classifyAiError } from '../errors/AiError.js';
import { AiProviderFactory } from '../providers/AiProviderFactory.js';
import type {
    AgentChatRequest,
    AgentChatResponse,
    AiFactoryConfig,
    AuthTokenGetter,
    AuthTokenRefresher,
} from '../providers/types.js';
import { extractToolCallData, type ExtractedToolCall } from './extractToolCallData.js';

export interface GenAiToolResolverConfig<TInput, TOutput, TArgs = Record<string, any>> {
    factoryConfig: AiFactoryConfig | ((input: TInput) => AiFactoryConfig | Promise<AiFactoryConfig>);
    getAuthToken?: AuthTokenGetter;
    onAuthExpired?: AuthTokenRefresher;
    cache?: LruMemoryCache<string, TOutput> | null;
    cacheCapacity?: number;
    getCacheKey?: (input: TInput) => string | null;
    buildRequest: (input: TInput) => AgentChatRequest | Promise<AgentChatRequest>;
    parseResponse: (
        extracted: ExtractedToolCall<TArgs> | null,
        rawResponse: AgentChatResponse,
        input: TInput
    ) => TOutput | null | Promise<TOutput | null>;
}

export class GenAiToolResolver<TInput, TOutput, TArgs = Record<string, any>> {
    readonly kind = 'genai' as const;
    private readonly cache: LruMemoryCache<string, TOutput> | null;

    constructor(private readonly config: GenAiToolResolverConfig<TInput, TOutput, TArgs>) {
        if (config.cache === null) {
            this.cache = null;
        } else if (config.cache) {
            this.cache = config.cache;
        } else if (config.getCacheKey) {
            this.cache = new LruMemoryCache<string, TOutput>(config.cacheCapacity ?? 50);
        } else {
            this.cache = null;
        }
    }

    clearCache(): void {
        this.cache?.clear();
    }

    async resolve(input: TInput): Promise<TOutput | null> {
        const cacheKey = this.config.getCacheKey ? this.config.getCacheKey(input) : null;

        if (this.cache && cacheKey) {
            const cached = this.cache.get(cacheKey);
            if (cached !== undefined && cached !== null) {
                return cached;
            }
        }

        try {
            const resolvedFactoryConfig =
                typeof this.config.factoryConfig === 'function'
                    ? await this.config.factoryConfig(input)
                    : this.config.factoryConfig;

            const provider = this.config.onAuthExpired
                ? await AiProviderFactory.createProvider(
                      resolvedFactoryConfig,
                      this.config.getAuthToken,
                      this.config.onAuthExpired
                  )
                : await AiProviderFactory.createProvider(
                      resolvedFactoryConfig,
                      this.config.getAuthToken
                  );

            const request = await this.config.buildRequest(input);
            const response = await provider.chat(request);

            if (!response) {
                return null;
            }

            if (response.error) {
                const detail = response.errorMessage
                    ? `${response.error}: ${response.errorMessage}`
                    : response.error;
                throw classifyAiError(new Error(detail));
            }

            const extracted = extractToolCallData<TArgs>(response);
            const result = await this.config.parseResponse(extracted, response, input);

            if (result !== null && result !== undefined && this.cache && cacheKey) {
                this.cache.set(cacheKey, result);
            }

            return result ?? null;
        } catch (err) {
            throw classifyAiError(err);
        }
    }
}

export function createGenAiToolResolver<TInput, TOutput, TArgs = Record<string, any>>(
    config: GenAiToolResolverConfig<TInput, TOutput, TArgs>
): GenAiToolResolver<TInput, TOutput, TArgs> {
    return new GenAiToolResolver<TInput, TOutput, TArgs>(config);
}
