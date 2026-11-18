import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    AiKeyEncryptionService,
    DEFAULT_USER_AI_SETTINGS,
    isGenAiEnabled,
    normalizeProviderPreference,
    validateAndPrepareAiSettings,
} from '../src/settings/index.js';

describe('Settings Utilities & Draft-Validate-Persist', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('normalizes legacy and canonical provider preferences accurately', () => {
        expect(normalizeProviderPreference(undefined)).toBe('auto');
        expect(normalizeProviderPreference('qozara-intelligence')).toBe('cloud');
        expect(normalizeProviderPreference('cloud')).toBe('cloud');
        expect(normalizeProviderPreference('ollama')).toBe('local');
        expect(normalizeProviderPreference('local')).toBe('local');
        expect(normalizeProviderPreference('window.ai')).toBe('local-browser');
        expect(normalizeProviderPreference('local-browser')).toBe('local-browser');
        expect(normalizeProviderPreference('byok')).toBe('byok');
        expect(normalizeProviderPreference('disabled')).toBe('disabled');
        expect(normalizeProviderPreference('qozara-intelligence', false)).toBe('disabled');
    });

    it('determines GenAI enabled status across legacy and canonical shapes', () => {
        expect(isGenAiEnabled(undefined)).toBe(true);
        expect(isGenAiEnabled(DEFAULT_USER_AI_SETTINGS)).toBe(true);
        expect(isGenAiEnabled({ providerPreference: 'disabled' })).toBe(false);
        expect(isGenAiEnabled({ provider: 'qozara-intelligence', enabled: false })).toBe(false);
        expect(isGenAiEnabled({ provider: 'qozara-intelligence', enabled: true })).toBe(true);
    });

    it('validates inputs in AiKeyEncryptionService and calls edge /encrypt', async () => {
        await expect(AiKeyEncryptionService.encryptApiKey('  ', 'https://ai.qozara.org')).rejects.toThrow(
            'API key cannot be empty'
        );
        await expect(AiKeyEncryptionService.encryptApiKey('AIza123', '')).rejects.toThrow(
            'AI proxy URL is required'
        );

        globalThis.fetch = vi.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ciphertext: 'enc-xyz' }),
        } as any);

        const cipher = await AiKeyEncryptionService.encryptApiKey('  AIza123  ', 'https://ai.qozara.org/');
        expect(cipher).toBe('enc-xyz');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://ai.qozara.org/api/v1/agent/encrypt',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ apiKey: 'AIza123' }),
            })
        );
    });

    it('validateAndPrepareAiSettings encrypts new BYOK key and probes availability', async () => {
        globalThis.fetch = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ ciphertext: 'encrypted-byok-key' }),
            } as any)
            .mockResolvedValueOnce({
                ok: true,
            } as any);

        const result = await validateAndPrepareAiSettings({
            providerPreference: 'byok',
            rawApiKey: 'AIza-personal',
            proxyUrl: 'https://ai.qozara.org',
        });

        expect(result.isReachable).toBe(true);
        expect(result.settings).toEqual({
            providerPreference: 'byok',
            enableLocalAi: false,
            encryptedApiKey: 'encrypted-byok-key',
            byokProvider: 'google',
        });
        expect(result.setupMessage).toContain('Gemini API key');
    });

    it('validateAndPrepareAiSettings handles disabled without external probes and marks local unreachable if opt-in is false', async () => {
        const fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy;

        const disabledRes = await validateAndPrepareAiSettings({
            providerPreference: 'disabled',
        });
        expect(disabledRes.isReachable).toBe(true);
        expect(disabledRes.settings.providerPreference).toBe('disabled');
        expect(disabledRes.setupMessage).toContain('Generative AI is disabled');
        expect(fetchSpy).not.toHaveBeenCalled();

        const localOptOutRes = await validateAndPrepareAiSettings({
            providerPreference: 'local',
            enableLocalAi: false,
            ollamaBaseUrl: 'http://localhost:11434/api',
        });
        expect(localOptOutRes.isReachable).toBe(false);
        expect(localOptOutRes.settings.enableLocalAi).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
