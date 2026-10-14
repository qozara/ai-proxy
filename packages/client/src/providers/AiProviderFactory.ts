import { AiFactoryConfig, AiProvider, AuthTokenGetter } from './types.js';
import { ProxyAiProvider } from './ProxyAiProvider.js';
import { WindowAiProvider } from './WindowAiProvider.js';
import { LocalOllamaProvider } from './LocalOllamaProvider.js';

export class DisabledAiProvider implements AiProvider {
    readonly id = 'disabled';
    readonly mode = 'disabled';
    async chat() {
        return { type: 'text' as const, error: 'AI is disabled' };
    }
    async checkAvailability() {
        return false;
    }
    getSetupMessage() {
        return null;
    }
}

export class AiProviderFactory {
    static async createProvider(config: AiFactoryConfig, getAuthToken?: AuthTokenGetter): Promise<AiProvider> {
        const { providerPreference, encryptedApiKey, baseUrl, proxyUrl, byokProvider } = config;

        // Forced Disable
        if (providerPreference === 'disabled') {
            return new DisabledAiProvider();
        }

        // 1. Explicit Selection: BYOK Cloud
        if (providerPreference === 'byok' && encryptedApiKey && proxyUrl) {
            return new ProxyAiProvider(proxyUrl, getAuthToken, encryptedApiKey, byokProvider);
        }

        // 2. Explicit Selection: Local Ollama
        if (providerPreference === 'local') {
            return new LocalOllamaProvider(baseUrl, config.ollamaModel);
        }

        // 3. Explicit Selection: Local Browser AI
        if (providerPreference === 'local-browser') {
            return new WindowAiProvider();
        }

        // 4. Explicit Selection: Cloud (Qozara Intelligence / BYOK based on config)
        if (providerPreference === 'cloud' && proxyUrl) {
            return new ProxyAiProvider(proxyUrl, getAuthToken, encryptedApiKey, byokProvider);
        }

        // 5. "Auto" Mode Polymorphic Fallback Waterfall:
        // BYOK -> window.ai -> Local Ollama -> Qozara Intelligence Cloud Proxy
        if (providerPreference === 'auto') {
            // a) If BYOK ciphertext exists and proxy is set, prioritize user's own key
            if (encryptedApiKey && proxyUrl) {
                return new ProxyAiProvider(proxyUrl, getAuthToken, encryptedApiKey, byokProvider);
            }

            // b) If Window AI (Gemini Nano on-device) is available
            const windowProvider = new WindowAiProvider();
            if (await windowProvider.checkAvailability()) {
                return windowProvider;
            }

            // c) If Local Ollama daemon is active
            const localProvider = new LocalOllamaProvider(baseUrl, config.ollamaModel);
            if (await localProvider.checkAvailability()) {
                return localProvider;
            }

            // d) Last resort: Qozara Intelligence edge proxy
            if (proxyUrl) {
                return new ProxyAiProvider(proxyUrl, getAuthToken, undefined, byokProvider);
            }
        }

        return new DisabledAiProvider();
    }

    static getSetupMessage(providerId: string, config?: Partial<AiFactoryConfig>): string | null {
        switch (providerId) {
            case 'local':
            case 'local-ollama':
                return new LocalOllamaProvider(config?.baseUrl, config?.ollamaModel).getSetupMessage();
            case 'local-browser':
            case 'window-ai':
                return new WindowAiProvider().getSetupMessage();
            case 'byok':
                return 'Enter your Gemini API key below. It will be encrypted and stored solely in your personal storage.';
            case 'cloud':
                return 'Using Qozara Intelligence (Rate-limited).';
            default:
                return null;
        }
    }
}
