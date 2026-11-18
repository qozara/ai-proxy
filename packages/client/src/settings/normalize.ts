import type { GenAiProviderPreference } from '../providers/types.js';

export interface UserAiSettings {
    providerPreference: GenAiProviderPreference;
    enableLocalAi?: boolean;
    encryptedApiKey?: string;
    byokProvider?: string;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
}

export const DEFAULT_USER_AI_SETTINGS: UserAiSettings = {
    providerPreference: 'auto',
    enableLocalAi: false,
    byokProvider: 'google',
    ollamaBaseUrl: 'http://localhost:11434/api',
};

export function normalizeProviderPreference(
    provider?: string | null,
    enabled?: boolean
): GenAiProviderPreference {
    if (enabled === false) {
        return 'disabled';
    }

    switch ((provider || '').trim()) {
        case 'disabled':
            return 'disabled';
        case 'byok':
            return 'byok';
        case 'local':
        case 'ollama':
            return 'local';
        case 'local-browser':
        case 'window.ai':
            return 'local-browser';
        case 'cloud':
        case 'qozara-intelligence':
            return 'cloud';
        case 'auto':
        default:
            return 'auto';
    }
}

export function isGenAiEnabled(
    settings?: {
        providerPreference?: string | null;
        provider?: string | null;
        enabled?: boolean;
    } | null
): boolean {
    if (!settings) {
        return true;
    }
    return normalizeProviderPreference(
        settings.providerPreference ?? settings.provider,
        settings.enabled
    ) !== 'disabled';
}
