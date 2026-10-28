/** Shared request handling for Fastlane's AI endpoints: CORS for the extension, the invite code, a light
 * per-IP guard, and turning router failures into honest HTTP answers. */
import { timingSafeEqual } from 'node:crypto';

export function send(res, status, data, extra = {}) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
    res.end(JSON.stringify(data));
}

export function safeString(value, length = 160) {
    return typeof value === 'string'
        ? value
              .slice(0, length)
              .split('')
              .map(c => (c.charCodeAt(0) < 32 && c !== '\n' ? ' ' : c))
              .join('')
              .trim()
        : '';
}

export function secureEqual(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** CORS for the extension; returns false when the request was fully answered (preflight or refusal). */
export function cors(req, res, methods = 'POST, OPTIONS') {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowed =
        /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || origin === 'https://longhorn-fastlane-plus.vercel.app';
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', methods);
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        send(res, allowed ? 204 : 403, {});
        return false;
    }
    if (req.method !== 'POST') {
        send(res, 405, { error: 'Method not allowed' });
        return false;
    }
    if (origin && !allowed) {
        send(res, 403, { error: 'Origin not allowed' });
        return false;
    }
    return true;
}

/** Parses the body and checks the invite code; answers the request itself when either fails. */
export function readAuthorized(req, res, maxBytes) {
    const inviteCode = process.env.FASTLANE_AI_ACCESS_CODE?.trim();
    if (!inviteCode || inviteCode.length < 8) {
        send(res, 503, { error: 'Owner must configure FASTLANE_AI_ACCESS_CODE (at least 8 characters) in Vercel.' });
        return null;
    }
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        send(res, 400, { error: 'Request body must be JSON' });
        return null;
    }
    if (JSON.stringify(body ?? {}).length > maxBytes) {
        send(res, 413, { error: 'Request is too large' });
        return null;
    }
    if (!body || typeof body.accessCode !== 'string' || !secureEqual(body.accessCode.trim(), inviteCode)) {
        send(res, 401, { error: 'Enter the Fastlane AI invite code.' });
        return null;
    }
    return body;
}

const hits = new Map();
/** Best-effort per-instance guard against bursts; the router enforces the providers' real limits. */
export function tooMany(req, res, perMinute) {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0];
    const now = Date.now();
    for (const [address, entry] of hits) if (now - entry.since > 60000) hits.delete(address);
    const count = hits.get(ip) ?? { since: now, n: 0 };
    if (count.n >= perMinute) {
        send(res, 429, { error: 'Too many AI requests. Retry in one minute.' }, { 'Retry-After': '60' });
        return true;
    }
    count.n += 1;
    hits.set(ip, count);
    return false;
}

const MODES = ['auto', 'fastest', 'quality', 'preserve', 'manual'];
/** The student's router settings, bounded. */
export function routingFrom(body) {
    const r = body?.routing && typeof body.routing === 'object' ? body.routing : {};
    return {
        mode: MODES.includes(r.mode) ? r.mode : 'auto',
        model: safeString(r.model, 80),
        disabledProviders: Array.isArray(r.disabledProviders)
            ? r.disabledProviders.filter(p => ['groq', 'gemini', 'cloudflare'].includes(p))
            : [],
    };
}

/** A failed routing becomes 429 (rate limits, with Retry-After) or 503, never a fake success. */
export function sendUnavailable(res, result) {
    const rateLimited = result.meta?.attempts?.some(
        a => a.outcome === 'rate_limit' || a.outcome === 'rate_limit_waited'
    );
    return send(
        res,
        rateLimited ? 429 : 503,
        {
            error: result.error.message,
            retryAfterSeconds: result.error.retryAfterSeconds,
            meta: publicMeta(result.meta),
        },
        { 'Retry-After': String(result.error.retryAfterSeconds ?? 30) }
    );
}

/** What the extension may see about how a request was served. */
export function publicMeta(meta) {
    if (!meta) return undefined;
    return {
        requestId: meta.requestId,
        task: meta.task,
        level: meta.level,
        provider: meta.provider ?? null,
        model: meta.model ?? null,
        label: meta.label ?? null,
        latencyMs: meta.latencyMs,
        cached: !!meta.cached,
        fallback: !!meta.fallback,
        validation: meta.validation ?? 'failed',
        usage: meta.usage ?? null,
        attempts: (meta.attempts ?? []).map(a => ({ model: a.model, outcome: a.outcome })),
    };
}
