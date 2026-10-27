/**
 * Opt-in IDA review endpoint. Accepts parsed requirement summaries, never raw IDA HTML/PDF.
 * Suggestions have no effect until explicitly accepted in the extension.
 */
import { timingSafeEqual } from 'node:crypto';
import { publicMeta, routingFrom, sendUnavailable } from './_ai/http.mjs';
import { routeAI } from './_ai/router.mjs';
export const maxDuration = 30;
const counters = new Map();
function reply(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
}
function equals(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

import { cleanAudit, formatAuditReview, SYSTEM_PROMPT, schema } from './_ai/tasks/audit-review.mjs';

export { supportedTag } from './_ai/tasks/audit-review.mjs';
export default async function handler(req, res) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowed =
        /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || origin === 'https://longhorn-fastlane-plus.vercel.app';
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return reply(res, allowed ? 204 : 403, {});
    if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
    if (origin && !allowed) return reply(res, 403, { error: 'Origin not allowed' });
    if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.CLOUDFLARE_API_TOKEN)
        return reply(res, 503, { error: 'No AI provider is configured.' });
    const secret = process.env.FASTLANE_AI_ACCESS_CODE?.trim();
    if (!secret || secret.length < 8) return reply(res, 503, { error: 'Fastlane AI invite code is not configured.' });
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return reply(res, 400, { error: 'Invalid JSON.' });
    }
    if (JSON.stringify(body ?? {}).length > 26000) return reply(res, 413, { error: 'Review too large.' });
    if (!body || typeof body.accessCode !== 'string' || !equals(body.accessCode.trim(), secret))
        return reply(res, 401, { error: 'Enter the Fastlane AI invite code.' });
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0];
    const now = Date.now();
    for (const [addr, entry] of counters) if (now - entry.at > 60000) counters.delete(addr);
    const count = counters.get(ip) ?? { at: now, n: 0 };
    if (++count.n > 4) return reply(res, 429, { error: 'Try again later.' });
    counters.set(ip, count);
    const data = cleanAudit(body);
    if (!data?.requirements.length) return reply(res, 400, { error: 'No requirements to review.' });
    try {
        const routed = await routeAI({
            task: 'audit-review',
            system: SYSTEM_PROMPT,
            user: JSON.stringify(data),
            schema,
            schemaName: 'fastlane_audit_review',
            maxTokens: 2200,
            temperature: 0.1,
            containsStudentData: true,
            routing: routingFrom(body),
            validate: out => (Array.isArray(out.json?.suggestions) ? null : 'missing suggestions'),
        });
        if (!routed.ok) return sendUnavailable(res, routed);
        return reply(res, 200, { ...formatAuditReview(routed.json ?? {}, data), meta: publicMeta(routed.meta) });
    } catch {
        return reply(res, 502, { error: 'Review did not finish. Saved IDA was not changed.' });
    }
}
