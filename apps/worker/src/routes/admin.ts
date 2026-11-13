import { Hono, Context } from 'hono';
import { getBindings, getClientIp, WorkerEnv } from '../middleware/auth.js';
import {
    verifyAdminSecret,
    registerAllowedUsers,
    revokeAllowedUsers,
    checkAllowedUsers,
    listAllowedUserHashes,
} from '../lib/allowlist.js';
import { checkRateLimit } from '../lib/rate-limit.js';

type AdminAction = 'register' | 'revoke' | 'check' | 'list';

const ADMIN_HTML_CONSOLE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="referrer" content="no-referrer" />
  <title>Qozara Intelligence — Admin Allowlist Console</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f19;
      --card: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #10b981;
      --danger: #ef4444;
      --secondary: #374151;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .container {
      max-width: 680px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
    }
    h1 { margin: 0 0 6px; font-size: 1.25rem; }
    p.subtitle { margin: 0 0 20px; color: var(--muted); font-size: 0.875rem; }
    label { display: block; font-size: 0.8rem; font-weight: 600; color: var(--muted); margin-bottom: 6px; }
    input, textarea {
      width: 100%;
      background: #030712;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 0.9rem;
      margin-bottom: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    textarea { min-height: 92px; resize: vertical; }
    .actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
      color: #fff;
      background: var(--secondary);
      transition: opacity 0.15s ease;
    }
    button:hover { opacity: 0.9; }
    button.primary { background: var(--accent); color: #052e16; }
    button.danger { background: var(--danger); }
    pre {
      margin: 0;
      padding: 14px;
      border-radius: 10px;
      background: #030712;
      border: 1px solid var(--border);
      font-size: 0.8rem;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .note {
      margin-top: 14px;
      font-size: 0.78rem;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main class="container">
    <h1>Qozara Intelligence — Mode 1A Admin Console</h1>
    <p class="subtitle">Manage registered Qozara users in Upstash Redis. Only SHA-256 email hashes are stored at rest.</p>

    <label for="secret">ADMIN_SECRET (sent via X-Admin-Secret header, never in URL)</label>
    <input id="secret" type="password" placeholder="Enter your rotatable ADMIN_SECRET..." autocomplete="off" />

    <label for="emails">User Emails (comma or newline separated)</label>
    <textarea id="emails" placeholder="alice@gmail.com&#10;bob@qozara.org"></textarea>

    <div class="actions">
      <button type="button" class="primary" data-action="register">Register Users</button>
      <button type="button" data-action="check">Check Status</button>
      <button type="button" class="danger" data-action="revoke">Revoke Users</button>
      <button type="button" data-action="list">List Hashes</button>
    </div>

    <pre id="output">Ready. Enter ADMIN_SECRET and choose an action.</pre>
    <p class="note">Rotate <code>ADMIN_SECRET</code> anytime in Vercel, Cloudflare, or GitHub Environments without affecting existing registered user hashes.</p>
  </main>

  <script>
    const outputEl = document.getElementById('output');
    const secretEl = document.getElementById('secret');
    const emailsEl = document.getElementById('emails');

    function parseEmails(raw) {
      return raw.split(/[\\n,]+/).map(s => s.trim()).filter(Boolean);
    }

    async function runAction(action) {
      const secret = secretEl.value.trim();
      if (!secret) {
        outputEl.textContent = 'Error: Please enter ADMIN_SECRET first.';
        return;
      }

      const emails = parseEmails(emailsEl.value);
      if (action !== 'list' && emails.length === 0) {
        outputEl.textContent = 'Error: Please enter at least one email address.';
        return;
      }

      outputEl.textContent = 'Sending request...';
      try {
        const res = await fetch('/api/v1/admin/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Secret': secret
          },
          body: JSON.stringify({ action, emails })
        });
        const data = await res.json();
        outputEl.textContent = JSON.stringify({ httpStatus: res.status, ...data }, null, 2);
      } catch (err) {
        outputEl.textContent = 'Request failed: ' + (err && err.message ? err.message : String(err));
      }
    }

    document.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => runAction(btn.getAttribute('data-action')));
    });
  </script>
</body>
</html>`;

function normalizeAction(raw?: string | null): AdminAction | null {
    const val = (raw || '').trim().toLowerCase();
    if (val === 'register' || val === 'add') return 'register';
    if (val === 'revoke' || val === 'remove') return 'revoke';
    if (val === 'check') return 'check';
    if (val === 'list') return 'list';
    return null;
}

function parseEmailInputs(single?: unknown, multiple?: unknown): string[] {
    const collected: string[] = [];

    if (typeof single === 'string' && single.trim()) {
        collected.push(...single.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean));
    }

    if (Array.isArray(multiple)) {
        for (const item of multiple) {
            if (typeof item === 'string' && item.trim()) {
                collected.push(...item.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean));
            }
        }
    } else if (typeof multiple === 'string' && multiple.trim()) {
        collected.push(...multiple.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean));
    }

    return collected;
}

function extractAdminSecret(c: Context<WorkerEnv>): string | undefined {
    const authHeader = c.req.header('Authorization');
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
        return authHeader.replace(/^Bearer\s+/i, '').trim();
    }

    const headerSecret = c.req.header('X-Admin-Secret');
    if (headerSecret && headerSecret.trim()) {
        return headerSecret.trim();
    }

    const querySecret = c.req.query('secret');
    if (querySecret && querySecret.trim()) {
        return querySecret.trim();
    }

    return undefined;
}

async function executeAdminAction(
    c: Context<WorkerEnv>,
    actionRaw: string | null | undefined,
    emails: string[]
) {
    const bindings = getBindings(c);
    const clientIp = getClientIp(c);
    const failClosed = bindings.NODE_ENV !== 'test';

    const rate = await checkRateLimit(bindings, `admin-auth:${clientIp}`, 15, '1 m', failClosed);
    if (rate.error === 'RATE_LIMITER_UNAVAILABLE') {
        return c.json({
            error: 'Service Unavailable',
            message: 'Rate limiter unavailable for admin endpoint',
            code: 'SERVICE_UNAVAILABLE_503',
        }, 503);
    }
    if (!rate.success) {
        return c.json({
            error: 'Too Many Requests',
            message: 'Too many admin requests. Please try again later.',
            code: 'RATE_LIMIT_EXCEEDED',
        }, 429);
    }

    const expectedSecret = (bindings.ADMIN_SECRET || '').trim();
    if (expectedSecret.length < 16) {
        return c.json({
            error: 'Service Unavailable',
            message: 'ADMIN_SECRET is not configured or shorter than 16 characters',
            code: 'ADMIN_NOT_CONFIGURED',
        }, 503);
    }

    const providedSecret = extractAdminSecret(c);
    if (!verifyAdminSecret(providedSecret, expectedSecret)) {
        return c.json({
            error: 'Unauthorized',
            message: 'Invalid or missing admin secret',
            code: 'UNAUTHORIZED_401',
        }, 401);
    }

    const action = normalizeAction(actionRaw);
    if (!action) {
        return c.json({
            error: 'Bad Request',
            message: "Invalid or missing action. Use 'register', 'revoke', 'check', or 'list'.",
            code: 'BAD_REQUEST',
        }, 400);
    }

    try {
        switch (action) {
            case 'register': {
                const result = await registerAllowedUsers(emails, bindings);
                return c.json({ status: 'ok', action, ...result });
            }
            case 'revoke': {
                const result = await revokeAllowedUsers(emails, bindings);
                return c.json({ status: 'ok', action, ...result });
            }
            case 'check': {
                const results = await checkAllowedUsers(emails, bindings);
                return c.json({ status: 'ok', action, results });
            }
            case 'list': {
                const result = await listAllowedUserHashes(bindings);
                return c.json({ status: 'ok', action, ...result });
            }
        }
    } catch (err: any) {
        const msg = err?.message || 'Admin operation failed';
        if (msg.startsWith('ALLOWLIST_STORAGE_UNAVAILABLE')) {
            return c.json({
                error: 'Service Unavailable',
                message: msg,
                code: 'SERVICE_UNAVAILABLE_503',
            }, 503);
        }
        return c.json({
            error: 'Bad Request',
            message: msg,
            code: 'BAD_REQUEST',
        }, 400);
    }
}

export const adminRoutes = new Hono<WorkerEnv>();

// Enforce strict no-store & no-referrer headers on all admin endpoints and console
adminRoutes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    c.header('Pragma', 'no-cache');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    await next();
});

adminRoutes.get('/admin', (c) => {
    return c.html(ADMIN_HTML_CONSOLE);
});

adminRoutes.get('/api/v1/admin/users', async (c) => {
    const action = c.req.query('action');
    const emails = parseEmailInputs(c.req.query('email'), c.req.query('emails'));
    return executeAdminAction(c, action, emails);
});

adminRoutes.post('/api/v1/admin/users', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
        return c.json({
            error: 'Bad Request',
            message: 'Invalid JSON request body',
            code: 'BAD_REQUEST',
        }, 400);
    }

    const action = typeof body.action === 'string' ? body.action : undefined;
    const emails = parseEmailInputs(body.email, body.emails);
    return executeAdminAction(c, action, emails);
});
