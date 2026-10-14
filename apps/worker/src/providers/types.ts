import { LanguageModel } from 'ai';

export interface ProviderConfig {
    apiKey?: string;
    baseUrl?: string;
    model: string;
}

export interface AiSdkAdapter {
    readonly id: string;
    readonly isCloud: boolean;
    getLanguageModel(config: ProviderConfig): LanguageModel;
    validateConfig(config: ProviderConfig): { isValid: boolean; error?: string };
    getTeamConfig(bindings: any): ProviderConfig;
}
