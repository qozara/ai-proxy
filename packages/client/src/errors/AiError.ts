export type AiErrorCode =
    | 'RATE_LIMIT_EXCEEDED'
    | 'AI_DISABLED'
    | 'NO_ITEMS_PARSED'
    | 'NETWORK_ERROR'
    | 'AUTHENTICATION_REQUIRED'
    | 'PARSE_FAILED';

export class AiError extends Error {
    constructor(
        public readonly code: AiErrorCode,
        message: string,
        public readonly cause?: unknown
    ) {
        super(message);
        this.name = 'AiError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export { AiError as AiCommandError, AiError as AiMealError };

export function classifyAiError(err: unknown): AiError {
    if (err instanceof AiError) {
        return err;
    }

    const msg = err instanceof Error ? err.message : String(err);

    if (/RATE_LIMIT|quota|Too Many Requests|429/i.test(msg)) {
        return new AiError('RATE_LIMIT_EXCEEDED', msg, err);
    }
    if (/AI is disabled|GenAI is disabled/i.test(msg)) {
        return new AiError('AI_DISABLED', msg, err);
    }
    if (/no food items|Could not extract/i.test(msg)) {
        return new AiError('NO_ITEMS_PARSED', msg, err);
    }
    if (/Failed to fetch|Network error|ECONNREFUSED|ENOTFOUND|timeout|unreachable/i.test(msg)) {
        return new AiError('NETWORK_ERROR', msg, err);
    }
    if (
        /Unauthorized|401|403|Forbidden|expired Google token/i.test(msg) ||
        (/invalid/i.test(msg) && /token/i.test(msg))
    ) {
        return new AiError('AUTHENTICATION_REQUIRED', msg, err);
    }

    return new AiError('PARSE_FAILED', msg, err);
}
