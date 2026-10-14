import { AgentChatRequest, AgentChatResponse, AuthTokenGetter } from './providers/types.js';

export interface AgentClientChatOptions extends AgentChatRequest {
    ciphertext?: string;
    byokProvider?: string;
}

export class AgentClient {
    private base: string;

    constructor(
        baseUrl: string,
        private getAuthToken?: AuthTokenGetter
    ) {
        this.base = baseUrl.replace(/\/$/, '');
    }

    /**
     * Encrypts a personal API key using the edge proxy's KMS_SECRET.
     * Works completely unauthenticated (zero login required).
     */
    async encryptApiKey(apiKey: string): Promise<string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.getAuthToken) {
            const token = await this.getAuthToken();
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
        }

        const response = await fetch(`${this.base}/api/v1/agent/encrypt`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ apiKey }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({})) as { message?: string; error?: string };
            throw new Error(error.message || error.error || `Encryption failed (${response.status})`);
        }

        const result = await response.json() as { ciphertext: string };
        return result.ciphertext;
    }

    /**
     * Sends a chat request to the edge proxy.
     * Auth token is optional (unauthenticated clients can use BYOK or anonymous tier).
     */
    async chat(request: AgentClientChatOptions): Promise<AgentChatResponse> {
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
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({})) as any;
            return {
                type: 'text',
                error: error.code || error.message || error.error || `AI proxy request failed (${response.status})`,
            };
        }

        return await response.json() as AgentChatResponse;
    }
}
