import { createOllama } from 'ai-sdk-ollama';
import { AiSdkAdapter, ProviderConfig } from './types.js';
import { LanguageModel } from 'ai';

export class OllamaProvider implements AiSdkAdapter {
    readonly id = 'ollama';
    readonly isCloud = false;

    getLanguageModel(config: ProviderConfig): LanguageModel {
        const ollama = createOllama({
            baseURL: config.baseUrl || 'http://localhost:11434/api',
        });
        return ollama(config.model);
    }

    validateConfig(_config: ProviderConfig): { isValid: boolean; error?: string } {
        return { isValid: true };
    }

    getTeamConfig(bindings: any): ProviderConfig {
        return {
            baseUrl: bindings.OLLAMA_BASE_URL || 'http://localhost:11434/api',
            model: bindings.OLLAMA_AI_MODEL || 'llama3.2',
        };
    }
}
