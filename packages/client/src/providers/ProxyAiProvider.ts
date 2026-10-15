import { AiProvider, AgentChatRequest, AgentChatResponse, AuthTokenGetter } from './types.js';

export class ProxyAiProvider implements AiProvider {
    readonly id = 'cloud-proxy';
    private base: string;

    get mode(): 'byok' | 'cloud' {
        return this.encryptedApiKey ? 'byok' : 'cloud';
    }

    constructor(
        proxyUrl: string = '',
        private getAuthToken?: AuthTokenGetter,
        private encryptedApiKey?: string,
        private byokProvider?: string
    ) {
        this.base = (proxyUrl || '').replace(/\/$/, '');
    }

    async chat(request: AgentChatRequest): Promise<AgentChatResponse> {
        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };

            if (this.getAuthToken) {
                const token = await this.getAuthToken();
                if (token) {
                    headers['Authorization'] = `Bearer ${token}`;
                }
            }

            const response = await fetch(`${this.base}/api/v1/agent/chat`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    messages: request.messages,
                    systemPrompt: request.systemPrompt,
                    tools: request.tools,
                    ciphertext: this.encryptedApiKey,
                    byokProvider: this.byokProvider,
                }),
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({})) as any;
                return {
                    type: 'text',
                    error: error.code || error.message || error.error || `Proxy request failed (${response.status})`,
                };
            }

            return await response.json() as AgentChatResponse;
        } catch (error: any) {
            return { type: 'text', error: error.message || 'Network error communicating with AI proxy' };
        }
    }

    async checkAvailability(): Promise<boolean> {
        if (!this.base) return false;
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${this.base}/health`, { signal: controller.signal });
            clearTimeout(id);
            return response.ok;
        } catch {
            return false;
        }
    }

    getSetupMessage(): string | null {
        return null;
    }
}
