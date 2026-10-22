#!/usr/bin/env node
/**
 * Static checks on the built extension before packaging (Chrome Web Store / MV3 policy):
 *  - MV3, strict CSP, no <all_urls>, only expected permissions and UT-related hosts
 *  - no remotely hosted scripts in HTML, no importScripts/import() from http(s)
 *  - no telemetry endpoints (Sentry DSN, analytics) shipped
 * Usage: node scripts/fastlane/security-check.mjs dist
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const dir = process.argv[2] || 'dist';
const errors = [];
const warnings = [];
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

const ALLOWED_PERMISSIONS = new Set(['storage', 'unlimitedStorage', 'scripting', 'alarms', 'notifications']);
const HOST_OK = /^(\*|https?):\/\/(\*\.)?([a-z0-9-]+\.)*(utexas\.edu|utexas\.collegescheduler\.com|bluera\.com)\//;

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
for (const p of manifest.permissions ?? []) if (!ALLOWED_PERMISSIONS.has(p)) errors.push(`unexpected permission: ${p}`);
const AI_HOST = 'https://longhorn-fastlane-plus.vercel.app/*';
for (const h of manifest.host_permissions ?? []) if (!HOST_OK.test(h) && h !== AI_HOST) errors.push(`unexpected host permission: ${h}`);
for (const cs of manifest.content_scripts ?? [])
    for (const m of cs.matches ?? []) if (!HOST_OK.test(m)) errors.push(`content script on non-UT host: ${m}`);
for (const war of manifest.web_accessible_resources ?? []) {
    for (const m of war.matches ?? [])
        if (m === '<all_urls>' || m === '*://*/*') errors.push(`web_accessible_resources exposed to all sites: ${m}`);
}
const csp = manifest.content_security_policy?.extension_pages ?? '';
if (!/script-src 'self'/.test(csp) || /unsafe-eval|https?:/.test(csp.replace("'wasm-unsafe-eval'", '')))
    errors.push(`weak CSP: ${csp}`);
if (manifest.description && manifest.description.length > 132) errors.push('description longer than 132 characters');

function walk(d) {
    return readdirSync(d).flatMap(f => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
    });
}

const files = walk(dir);
for (const file of files) {
    const rel = relative(dir, file);
    if (/sentry-toolbar/.test(rel) && !rel.endsWith('.map'))
        warnings.push(`dev-only file present (excluded from package): ${rel}`);
    if (!/\.(js|html|mjs|json)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.html')) {
        for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/g))
            if (/^(https?:)?\/\//.test(m[1])) errors.push(`${rel}: remote script ${m[1]}`);
    }
    if (/\.(js|mjs)$/.test(file)) {
        if (/importScripts\(\s*["']https?:/.test(text)) errors.push(`${rel}: importScripts from network`);
        if (/import\(\s*["']https?:\/\//.test(text)) errors.push(`${rel}: dynamic import from network`);
        if (
            /ingest\.(us\.)?sentry\.io|google-analytics\.com|googletagmanager\.com|segment\.io|mixpanel\.com/.test(text)
        ) {
            errors.push(`${rel}: telemetry/analytics endpoint present`);
        }
    }
}

for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
    for (const e of errors) console.error(`FAIL: ${e}`);
    process.exit(1);
}
console.log(`security check passed (${files.length} files, ${(manifest.permissions ?? []).length} permissions)`);
