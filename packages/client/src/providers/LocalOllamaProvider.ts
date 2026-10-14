import { AiProvider, AgentChatRequest, AgentChatResponse } from './types.js';

export class LocalOllamaProvider implements AiProvider {
    readonly id = 'local-ollama';
    readonly mode = 'local-ollama';
    private model: string;
    private base: string;

    constructor(
        baseUrl: string = 'http://localhost:11434/api',
        model: string = 'qwen2.5:0.5b'
    ) {
        this.base = baseUrl.replace(/\/$/, '');
        this.model = model;
    }

    async chat(request: AgentChatRequest): Promise<AgentChatResponse> {
        try {
            const bodyPayload: any = {
                model: this.model,
                messages: [
                    { role: 'system', content: request.systemPrompt },
                    ...request.messages
                ],
                stream: false
            };

            if (request.tools && request.tools.length > 0) {
                bodyPayload.tools = request.tools.map((t: any) => ({
                    type: 'function',
                    function: {
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters
                    }
                }));
            } else {
                bodyPayload.format = 'json';
            }

            const chatUrl = this.base.endsWith('/api') ? `${this.base}/chat` : `${this.base}/api/chat`;

            const response = await fetch(chatUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(bodyPayload)
            });

            if (!response.ok) {
                let errorMsg = `Ollama failed (${response.status})`;
                try {
                    const errBody = await response.json() as any;
                    if (errBody.error) errorMsg += `: ${errBody.error}`;
                } catch {
                    // Ignore JSON parse error in error handler
                }
                return { type: 'text', error: errorMsg };
            }

            const data = await response.json() as any;

            // Native Ollama tool calling format
            if (data.message?.tool_calls && data.message.tool_calls.length > 0) {
                const call = data.message.tool_calls[0].function;
                return {
                    type: 'tool_call',
                    tool: call.name,
                    arguments: call.arguments
                };
            }

            const content = data.message?.content || '';

            try {
                const parsed = JSON.parse(content);

                // Pattern 1 & 2: { tool: "name", arguments: { ... } } or { action/type/tool_used: "name", ...args }
                const toolName = parsed.tool || parsed.action || parsed.type || parsed.tool_used;
                if (toolName) {
                    const args = parsed.arguments || { ...parsed };
                    if (args === parsed) {
                        delete (args as any).tool;
                        delete (args as any).action;
                        delete (args as any).type;
                        delete (args as any).tool_used;
                    }
                    return {
                        type: 'tool_call',
                        tool: toolName as string,
                        arguments: args
                    };
                }

                // Dynamic Pattern 3: Match root key against any registered tool from request
                const requestedTools: string[] = (request.tools || []).map((t: any) => t.name);
                for (const tool of requestedTools) {
                    const key = Object.keys(parsed).find(k => k.toLowerCase() === tool.toLowerCase());
                    if (key) {
                        return {
                            type: 'tool_call',
                            tool: tool,
                            arguments: parsed[key]
                        };
                    }
                }

                return { type: 'text', content };
            } catch {
                return { type: 'text', content };
            }
        } catch (error: any) {
            return { type: 'text', error: error.message || 'Local Ollama error' };
        }
    }

    async checkAvailability(): Promise<boolean> {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 2000);
            const tagsUrl = this.base.endsWith('/api') ? `${this.base}/tags` : `${this.base}/api/tags`;
            const response = await fetch(tagsUrl, { signal: controller.signal });
            clearTimeout(id);
            return response.ok;
        } catch {
            return false;
        }
    }

    getSetupMessage(): string | null {
        return `Note: Start Ollama with OLLAMA_ORIGINS="*" ollama serve to allow browser connections. Make sure you have pulled the model '${this.model}'.`;
    }
}
