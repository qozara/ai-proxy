#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, runCliCommand } from '../dist/src/lib/cli-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');

function loadVarsFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const vars = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && !(key in process.env)) {
            vars[key] = value;
        }
    }
    return vars;
}

async function main() {
    const fileVars = {
        ...loadVarsFile(path.resolve(workerRoot, '../../.env')),
        ...loadVarsFile(path.join(workerRoot, '.dev.vars')),
    };

    const proxyUrl = process.env.AI_PROXY_URL || fileVars.AI_PROXY_URL || 'https://ai.qozara.org';
    const secret = process.env.ADMIN_SECRET || fileVars.ADMIN_SECRET;

    const parsed = parseCliArgs(process.argv.slice(2), { proxyUrl, secret });
    const result = await runCliCommand({
        action: parsed.action,
        emails: parsed.emails,
        proxyUrl: parsed.proxyUrl,
        secret: parsed.secret || '',
    });

    console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
    console.error(`Error: ${err?.message || String(err)}`);
    process.exit(1);
});
