export interface ExtractedToolCall<TArgs = Record<string, any>> {
    toolName?: string;
    args: TArgs;
}

function parseJsonPayload(raw: unknown): any {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;

    const trimmed = raw.trim();
    if (!trimmed) return null;

    try {
        return JSON.parse(trimmed);
    } catch {
        const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenceMatch && fenceMatch[1]) {
            try {
                return JSON.parse(fenceMatch[1].trim());
            } catch {
                // Fall through to object brace extraction
            }
        }

        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            try {
                return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

export function extractToolCallData<TArgs = Record<string, any>>(
    response: unknown
): ExtractedToolCall<TArgs> | null {
    if (!response || typeof response !== 'object') {
        return null;
    }

    const res = response as Record<string, any>;

    // 1. Standard AgentChatResponse tool_call or direct arguments field
    if (res.arguments !== undefined && res.arguments !== null) {
        const parsed = parseJsonPayload(res.arguments);
        if (parsed && typeof parsed === 'object') {
            return {
                toolName: typeof res.tool === 'string' ? res.tool : undefined,
                args: parsed as TArgs,
            };
        }
    }

    // 2. Top-level OpenAI-style tool_calls array
    if (Array.isArray(res.tool_calls) && res.tool_calls.length > 0) {
        const call = res.tool_calls[0];
        const rawArgs = call?.function?.arguments ?? call?.arguments ?? call;
        const parsed = parseJsonPayload(rawArgs);
        if (parsed && typeof parsed === 'object') {
            return {
                toolName: call?.function?.name || call?.name || (typeof res.tool === 'string' ? res.tool : undefined),
                args: parsed as TArgs,
            };
        }
    }

    // 3. OpenAI Chat Completions choices[0].message shape
    const choiceMsg = res.choices?.[0]?.message;
    if (choiceMsg && typeof choiceMsg === 'object') {
        if (Array.isArray(choiceMsg.tool_calls) && choiceMsg.tool_calls.length > 0) {
            const call = choiceMsg.tool_calls[0];
            const rawArgs = call?.function?.arguments ?? call?.arguments;
            const parsed = parseJsonPayload(rawArgs);
            if (parsed && typeof parsed === 'object') {
                return {
                    toolName: call?.function?.name || call?.name,
                    args: parsed as TArgs,
                };
            }
        }
        if (choiceMsg.content) {
            const parsed = parseJsonPayload(choiceMsg.content);
            if (parsed && typeof parsed === 'object') {
                if (typeof parsed.tool === 'string' && parsed.arguments && typeof parsed.arguments === 'object') {
                    return { toolName: parsed.tool, args: parsed.arguments as TArgs };
                }
                return { args: parsed as TArgs };
            }
        }
    }

    // 4. Plain content string containing JSON or markdown code fence
    if (res.content) {
        const parsed = parseJsonPayload(res.content);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.tool === 'string' && parsed.arguments && typeof parsed.arguments === 'object') {
                return { toolName: parsed.tool, args: parsed.arguments as TArgs };
            }
            return {
                toolName: typeof res.tool === 'string' ? res.tool : undefined,
                args: parsed as TArgs,
            };
        }
    }

    return null;
}
