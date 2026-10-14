import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from '../src/middleware/cors.js';
import app from '../src/index.js';

describe('CORS Dynamic Origin Middleware', () => {
    it('should allow production and staging *.qozara.org subdomains', () => {
        expect(isAllowedOrigin('https://qozara.org')).toBe(true);
        expect(isAllowedOrigin('https://ai.qozara.org')).toBe(true);
        expect(isAllowedOrigin('https://app.quozen.qozara.org')).toBe(true);
        expect(isAllowedOrigin('https://quomida.qozara.org')).toBe(true);
        expect(isAllowedOrigin('https://staging.app.quozen.qozara.org')).toBe(true);
    });

    it('should allow local development origins', () => {
        expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
        expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
        expect(isAllowedOrigin('http://localhost:8788')).toBe(true);
        expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    });

    it('should reject non-qozara origins and spoofing attempts', () => {
        expect(isAllowedOrigin('https://attacker.org')).toBe(false);
        expect(isAllowedOrigin('https://qozara.org.attacker.com')).toBe(false);
        expect(isAllowedOrigin('http://qozara.org')).toBe(false); // Insecure HTTP disallowed for prod
        expect(isAllowedOrigin('https://evil-qozara.org')).toBe(false);
        expect(isAllowedOrigin(undefined)).toBe(false);
    });

    it('should respond with 204 and CORS headers on OPTIONS preflight', async () => {
        const res = await app.request('/api/v1/agent/chat', {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://app.quozen.qozara.org',
                'Access-Control-Request-Method': 'POST',
            },
        });

        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.quozen.qozara.org');
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    it('should NOT add Access-Control-Allow-Origin for unauthorized origins', async () => {
        const res = await app.request('/health', {
            method: 'GET',
            headers: {
                Origin: 'https://malicious-site.com',
            },
        });

        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
});
