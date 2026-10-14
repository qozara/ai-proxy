import { AiSdkAdapter } from './types.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';

const providers: Record<string, AiSdkAdapter> = {
    google: new GoogleProvider(),
    ollama: new OllamaProvider(),
};

/**
 * Registry for AI Providers. Designed for extensible plug-in adapters (e.g. Workers AI, vLLM).
 */
export const ProviderFactory = {
    getProvider(id: string): AiSdkAdapter | undefined {
        return providers[id];
    },

    registerProvider(provider: AiSdkAdapter): void {
        providers[provider.id] = provider;
    },

    listProviders(): string[] {
        return Object.keys(providers);
    },
};
