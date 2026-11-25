import {
    AiProvider,
    AgentChatRequest,
    AgentChatResponse,
    AuthTokenGetter,
    AuthTokenRefresher,
} from './types.js';

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
        private byokProvider?: string,
        private onAuthExpired?: AuthTokenRefresher
    ) {
        this.base = (proxyUrl || '').replace(/\/$/, '');
    }

    private async sendChatRequest(
        request: AgentChatRequest,
        tokenOverride?: string | null
    ): Promise<Response> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        const token =
            tokenOverride !== undefined
                ? tokenOverride
                : this.getAuthToken
                  ? await this.getAuthToken()
                  : null;

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        return fetch(`${this.base}/api/v1/agent/chat`, {
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
    }

    async chat(request: AgentChatRequest): Promise<AgentChatResponse> {
        try {
            let response = await this.sendChatRequest(request);

            // 1-shot automatic token refresh retry on 401 in Qozara Cloud AI mode
            if (response.status === 401 && !this.encryptedApiKey && this.onAuthExpired) {
                const refreshedToken = await this.onAuthExpired();
                if (refreshedToken && refreshedToken.trim()) {
                    response = await this.sendChatRequest(request, refreshedToken.trim());
                }
            }

            if (!response.ok) {
                const error = (await response.json().catch(() => ({}))) as {
                    code?: string;
                    message?: string;
                    error?: string;
                };
                return {
                    type: 'text',
                    error:
                        error.code ||
                        error.message ||
                        error.error ||
                        `Proxy request failed (${response.status})`,
                    errorCode: error.code,
                    errorMessage: error.message,
                    status: response.status,
                };
            }

            return (await response.json()) as AgentChatResponse;
        } catch (error: any) {
            return {
                type: 'text',
                error: error.message || 'Network error communicating with AI proxy',
            };
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
