import { AiFactoryConfig, AiProvider, AuthTokenGetter } from './types.js';
import { ProxyAiProvider } from './ProxyAiProvider.js';
import { WindowAiProvider } from './WindowAiProvider.js';
import { LocalOllamaProvider } from './LocalOllamaProvider.js';
import { normalizeProviderPreference } from '../settings/normalize.js';

export class DisabledAiProvider implements AiProvider {
    readonly id = 'disabled';
    readonly mode = 'disabled';
    async chat() {
        return { type: 'text' as const, error: 'GenAI is disabled' };
    }
    async checkAvailability() {
        return false;
    }
    getSetupMessage() {
        return 'Generative AI is disabled. Natural language parsing runs 100% offline using built-in deterministic AI.';
    }
}

export class AiProviderFactory {
    static async createProvider(config: AiFactoryConfig, getAuthToken?: AuthTokenGetter): Promise<AiProvider> {
        const { providerPreference, encryptedApiKey, baseUrl, proxyUrl, byokProvider, enableLocalAi } = config;
        const normalizedPreference = normalizeProviderPreference(providerPreference);
        const isLocalAiOptedIn = Boolean(enableLocalAi);

        // Forced Disable
        if (normalizedPreference === 'disabled') {
            return new DisabledAiProvider();
        }

        // 1. Explicit Selection: BYOK Cloud
        if (normalizedPreference === 'byok' && encryptedApiKey && proxyUrl) {
            return new ProxyAiProvider(proxyUrl, getAuthToken, encryptedApiKey, byokProvider);
        }

        // 2. Explicit Selection: Local Ollama (strictly opt-in via enableLocalAi)
        if (normalizedPreference === 'local') {
            if (isLocalAiOptedIn) {
                return new LocalOllamaProvider(baseUrl, config.ollamaModel);
            }
            return new DisabledAiProvider();
        }

        // 3. Explicit Selection: Local Browser AI
        if (normalizedPreference === 'local-browser') {
            return new WindowAiProvider();
        }

        // 4. Explicit Selection: Cloud (Qozara Intelligence / BYOK based on config)
        if (normalizedPreference === 'cloud' && proxyUrl) {
            return new ProxyAiProvider(proxyUrl, getAuthToken, encryptedApiKey, byokProvider);
        }

        // 5. "Auto" Mode Polymorphic Fallback Waterfall:
        // BYOK -> window.ai -> Local Ollama (opt-in only) -> Qozara Intelligence Cloud Proxy
        if (normalizedPreference === 'auto') {
            // a) If BYOK ciphertext exists and proxy is set, prioritize user's own key
            if (encryptedApiKey && proxyUrl) {
                return new ProxyAiProvider(proxyUrl, getAuthToken, encryptedApiKey, byokProvider);
            }

            // b) If Window AI (Gemini Nano on-device) is available
            const windowProvider = new WindowAiProvider();
            if (await windowProvider.checkAvailability()) {
                return windowProvider;
            }

            // c) If Local Ollama daemon is active (only probe when explicitly opted in)
            if (isLocalAiOptedIn) {
                const localProvider = new LocalOllamaProvider(baseUrl, config.ollamaModel);
                if (await localProvider.checkAvailability()) {
                    return localProvider;
                }
            }

            // d) Last resort: Qozara Intelligence edge proxy
            if (proxyUrl) {
                return new ProxyAiProvider(proxyUrl, getAuthToken, undefined, byokProvider);
            }
        }

        return new DisabledAiProvider();
    }

    static getSetupMessage(providerId: string, config?: Partial<AiFactoryConfig>): string | null {
        switch ((providerId || '').trim()) {
            case 'local':
            case 'local-ollama':
            case 'ollama':
                return new LocalOllamaProvider(config?.baseUrl, config?.ollamaModel).getSetupMessage();
            case 'local-browser':
            case 'window-ai':
            case 'window.ai':
                return new WindowAiProvider().getSetupMessage();
            case 'byok':
                return 'Enter your Gemini API key below. It will be encrypted and stored solely in your personal storage.';
            case 'cloud':
            case 'qozara-intelligence':
                return 'Using Qozara Intelligence (Requires registered Qozara Google account).';
            case 'disabled':
                return 'Generative AI is disabled. Natural language parsing runs 100% offline using built-in deterministic AI.';
            default:
                return null;
        }
    }
}
