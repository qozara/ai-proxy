import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { AiSdkAdapter, ProviderConfig } from './types.js';
import { LanguageModel } from 'ai';

export class GoogleProvider implements AiSdkAdapter {
    readonly id = 'google';
    readonly isCloud = true;

    getLanguageModel(config: ProviderConfig): LanguageModel {
        const google = createGoogleGenerativeAI({
            apiKey: config.apiKey,
        });
        return google(config.model);
    }

    validateConfig(config: ProviderConfig): { isValid: boolean; error?: string } {
        if (!config.apiKey) {
            return { isValid: false, error: 'Missing GOOGLE_GENERATIVE_AI_API_KEY or BYOK key' };
        }
        return { isValid: true };
    }

    getTeamConfig(bindings: any): ProviderConfig {
        return {
            apiKey: bindings.GOOGLE_GENERATIVE_AI_API_KEY,
            model: bindings.GOOGLE_GENERATIVE_AI_MODEL || 'gemini-2.0-flash',
        };
    }
}
