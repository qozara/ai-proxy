import { AiProvider, AgentChatRequest, AgentChatResponse } from './types.js';

export class WindowAiProvider implements AiProvider {
    readonly id = 'window-ai';
    readonly mode = 'local-browser';

    async chat(request: AgentChatRequest): Promise<AgentChatResponse> {
        try {
            if (!this.isSupported()) {
                return { type: 'text', error: 'window.ai not supported' };
            }

            const capabilities = await (globalThis as any).window?.ai.languageModel.capabilities();
            if (capabilities.available !== 'readily') {
                return { type: 'text', error: 'window.ai model not ready' };
            }

            const session = await (globalThis as any).window?.ai.languageModel.create({
                systemPrompt: request.systemPrompt
            });

            const prompt = request.messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\nAssistant:';

            const response = await session.prompt(prompt);
            session.destroy();

            let cleanResponse = response.trim();
            if (cleanResponse.includes('```json')) {
                cleanResponse = cleanResponse.split('```json')[1].split('```')[0].trim();
            } else if (cleanResponse.includes('```')) {
                cleanResponse = cleanResponse.split('```')[1].split('```')[0].trim();
            }

            try {
                const parsed = JSON.parse(cleanResponse);
                if (parsed.tool && parsed.arguments) {
                    return {
                        type: 'tool_call',
                        tool: parsed.tool,
                        arguments: parsed.arguments
                    };
                }
                if (parsed.type === 'tool_call') {
                    return parsed as AgentChatResponse;
                }
                return { type: 'text', content: response };
            } catch {
                return { type: 'text', content: response };
            }
        } catch (error: any) {
            return { type: 'text', error: error.message || 'Window AI error' };
        }
    }

    async checkAvailability(): Promise<boolean> {
        if (!this.isSupported()) return false;
        try {
            const capabilities = await (globalThis as any).window?.ai.languageModel.capabilities();
            return capabilities.available === 'readily';
        } catch {
            return false;
        }
    }

    getSetupMessage(): string | null {
        if (this.isSupported()) return null;
        return "To enable Local Browser AI: 1. Use Chrome Dev/Canary. 2. Enable 'Prompt API for Gemini Nano' in chrome://flags. 3. Enable 'Enables optimization guide on device' in chrome://flags. 4. Relaunch and wait for model download in chrome://components.";
    }

    private isSupported(): boolean {
        return typeof globalThis !== 'undefined' && !!(globalThis as any).window?.ai?.languageModel;
    }
}
