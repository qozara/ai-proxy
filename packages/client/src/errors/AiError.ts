export type AiErrorCode =
    | 'RATE_LIMIT_EXCEEDED'
    | 'AI_DISABLED'
    | 'NO_ITEMS_PARSED'
    | 'NETWORK_ERROR'
    | 'FORBIDDEN_NOT_REGISTERED'
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

    // 1. Explicit status / proxy error codes first so words like "free quota" in 401/403 messages never misfire
    if (/FORBIDDEN_403|\b403\b|Forbidden|not registered for Qozara Intelligence/i.test(msg)) {
        return new AiError('FORBIDDEN_NOT_REGISTERED', msg, err);
    }
    if (
        /UNAUTHORIZED_401|\b401\b|Unauthorized|expired Google token/i.test(msg) ||
        (/invalid/i.test(msg) && /token/i.test(msg))
    ) {
        return new AiError('AUTHENTICATION_REQUIRED', msg, err);
    }
    if (/RATE_LIMIT|\b429\b|Too Many Requests|quota exceeded|quota reached|exhausted/i.test(msg)) {
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

    return new AiError('PARSE_FAILED', msg, err);
}
