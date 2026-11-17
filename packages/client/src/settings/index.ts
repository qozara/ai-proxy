import { AgentClient } from '../AgentClient.js';
import { AiProviderFactory } from '../providers/AiProviderFactory.js';
import type {
    AuthTokenGetter,
    GenAiProviderPreference,
    LegacyAiProviderPreference,
} from '../providers/types.js';
import {
    DEFAULT_USER_AI_SETTINGS,
    isGenAiEnabled,
    normalizeProviderPreference,
    type UserAiSettings,
} from './normalize.js';

export {
    DEFAULT_USER_AI_SETTINGS,
    isGenAiEnabled,
    normalizeProviderPreference,
    type UserAiSettings,
};

export class AiKeyEncryptionService {
    /**
     * Encrypts a user's personal provider API key using the edge KMS proxy.
     * Returns a secure ciphertext string to store safely in local or cloud storage.
     */
    static async encryptApiKey(
        rawApiKey: string,
        proxyUrl: string,
        getAuthToken?: AuthTokenGetter
    ): Promise<string> {
        const trimmedKey = (rawApiKey || '').trim();
        if (!trimmedKey) {
            throw new Error('API key cannot be empty');
        }
        const cleanUrl = (proxyUrl || '').trim().replace(/\/+$/, '');
        if (!cleanUrl) {
            throw new Error('AI proxy URL is required to encrypt API key');
        }

        const client = new AgentClient(cleanUrl, getAuthToken);
        return await client.encryptApiKey(trimmedKey);
    }
}

export interface ValidateAndPrepareAiSettingsOptions {
    providerPreference: GenAiProviderPreference | LegacyAiProviderPreference | string;
    enableLocalAi?: boolean;
    rawApiKey?: string;
    existingEncryptedApiKey?: string;
    byokProvider?: string;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    proxyUrl?: string;
    getAuthToken?: AuthTokenGetter;
    probeAvailability?: boolean;
}

export interface PreparedAiSettingsResult {
    settings: UserAiSettings;
    isReachable: boolean;
    setupMessage: string | null;
}

export async function validateAndPrepareAiSettings(
    options: ValidateAndPrepareAiSettingsOptions
): Promise<PreparedAiSettingsResult> {
    const pref = normalizeProviderPreference(options.providerPreference);
    let encryptedApiKey = options.existingEncryptedApiKey;

    if (pref === 'byok' && options.rawApiKey && options.rawApiKey.trim()) {
        encryptedApiKey = await AiKeyEncryptionService.encryptApiKey(
            options.rawApiKey,
            options.proxyUrl || '',
            options.getAuthToken
        );
    }

    const enableLocalAi = Boolean(options.enableLocalAi);
    const trimmedOllamaUrl = options.ollamaBaseUrl?.trim() || undefined;
    const trimmedOllamaModel = options.ollamaModel?.trim() || undefined;
    const byokProvider = options.byokProvider?.trim() || 'google';

    const settings: UserAiSettings = {
        providerPreference: pref,
        enableLocalAi,
        ...(encryptedApiKey ? { encryptedApiKey } : {}),
        byokProvider,
        ...(trimmedOllamaUrl ? { ollamaBaseUrl: trimmedOllamaUrl } : {}),
        ...(trimmedOllamaModel ? { ollamaModel: trimmedOllamaModel } : {}),
    };

    const setupMessage = AiProviderFactory.getSetupMessage(pref, {
        baseUrl: trimmedOllamaUrl,
        ollamaModel: trimmedOllamaModel,
    });

    let isReachable = true;
    if (pref !== 'disabled' && options.probeAvailability !== false) {
        const provider = await AiProviderFactory.createProvider(
            {
                providerPreference: pref,
                enableLocalAi,
                encryptedApiKey,
                byokProvider,
                baseUrl: enableLocalAi ? trimmedOllamaUrl : undefined,
                ollamaModel: trimmedOllamaModel,
                proxyUrl: options.proxyUrl,
            },
            options.getAuthToken
        );
        isReachable = await provider.checkAvailability();
    }

    return {
        settings,
        isReachable,
        setupMessage,
    };
}
