export type CliAction = 'register' | 'revoke' | 'check' | 'list';

export interface ParsedCliArgs {
    action: CliAction;
    emails: string[];
    proxyUrl: string;
    secret?: string;
}

export interface RunCliOptions {
    action: CliAction;
    emails: string[];
    proxyUrl: string;
    secret: string;
}

const VALID_ACTIONS = new Set<string>(['register', 'add', 'revoke', 'remove', 'check', 'list']);

export function parseCliArgs(
    argv: string[],
    defaults?: { proxyUrl?: string; secret?: string }
): ParsedCliArgs {
    let proxyUrl = (defaults?.proxyUrl || 'https://ai.qozara.org').trim();
    let secret = defaults?.secret?.trim() || undefined;
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--url' && argv[i + 1]) {
            proxyUrl = argv[++i].trim();
        } else if (arg.startsWith('--url=')) {
            proxyUrl = arg.slice('--url='.length).trim();
        } else if (arg === '--secret' && argv[i + 1]) {
            secret = argv[++i].trim();
        } else if (arg.startsWith('--secret=')) {
            secret = arg.slice('--secret='.length).trim();
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    const rawAction = (positional[0] || '').toLowerCase();
    if (!VALID_ACTIONS.has(rawAction)) {
        throw new Error(
            `Invalid or missing command '${rawAction}'. Usage: npm run users -- <register|revoke|check|list> [emails...] [--url <proxyUrl>] [--secret <adminSecret>]`
        );
    }

    const action: CliAction =
        rawAction === 'add' ? 'register' :
        rawAction === 'remove' ? 'revoke' :
        (rawAction as CliAction);

    const emails = positional
        .slice(1)
        .flatMap((entry) => entry.split(','))
        .map((e) => e.trim())
        .filter(Boolean);

    if (action !== 'list' && emails.length === 0) {
        throw new Error(`Action '${action}' requires at least one email address.`);
    }

    return {
        action,
        emails,
        proxyUrl: proxyUrl.replace(/\/+$/, ''),
        ...(secret ? { secret } : {}),
    };
}

export async function runCliCommand(options: RunCliOptions): Promise<any> {
    const baseUrl = (options.proxyUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
        throw new Error('Proxy URL is required (--url or AI_PROXY_URL).');
    }

    const secret = (options.secret || '').trim();
    if (!secret) {
        throw new Error('ADMIN_SECRET is required (--secret, ADMIN_SECRET env var, or apps/worker/.dev.vars).');
    }

    const response = await fetch(`${baseUrl}/api/v1/admin/users`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
            action: options.action,
            emails: options.emails,
        }),
    });

    const payload = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
        throw new Error(payload.message || payload.error || `Admin request failed (${response.status})`);
    }

    return payload;
}
