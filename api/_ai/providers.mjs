/**
 * One adapter for every provider. Groq, Gemini and Cloudflare Workers AI all offer OpenAI-compatible chat
 * completions, so a request is built once and only the URL, key and a few options differ. Errors come back
 * classified (rate limit with its retry time, bad credentials, timeout, server error) for the router.
 */

export class ProviderError extends Error {
    /** @param {'rate_limit'|'auth'|'timeout'|'server'|'bad_request'|'invalid_output'|'network'} category */
    constructor(category, message, { status = 0, retryAfterMs = 0 } = {}) {
        super(message);
        this.category = category;
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

function endpoint(provider, env) {
    if (provider === 'groq') return { url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY };
    if (provider === 'gemini')
        return {
            url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            key: env.GEMINI_API_KEY,
        };
    if (provider === 'cloudflare')
        return {
            url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID ?? '')}/ai/v1/chat/completions`,
            key: env.CLOUDFLARE_API_TOKEN,
        };
    throw new ProviderError('bad_request', `Unknown provider ${provider}`);
}

/** Seconds or an HTTP date in Retry-After, Gemini's "retryDelay": "17s", or Groq's reset headers. */
export function retryAfterMs(headers, body) {
    const get = name => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
    const header = get('retry-after');
    if (header) {
        const seconds = Number(header);
        if (Number.isFinite(seconds)) return seconds * 1000;
        const at = Date.parse(header);
        if (Number.isFinite(at)) return Math.max(0, at - Date.now());
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    const delay = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
    if (delay) return Number(delay[1]) * 1000;
    const reset = get('x-ratelimit-reset-requests') || get('x-ratelimit-reset-tokens');
    const m = reset?.match(/^(?:(\d+)m)?(\d+(?:\.\d+)?)s$/);
    if (m) return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000;
    return 0;
}

/** Remaining requests/tokens the provider reports, when it does (Groq sends x-ratelimit-* headers). */
function remainingFrom(headers) {
    const get = name => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
    const req = Number(get('x-ratelimit-remaining-requests'));
    const tok = Number(get('x-ratelimit-remaining-tokens'));
    return {
        ...(Number.isFinite(req) && get('x-ratelimit-remaining-requests') != null ? { requests: req } : {}),
        ...(Number.isFinite(tok) && get('x-ratelimit-remaining-tokens') != null ? { tokens: tok } : {}),
    };
}

/** The limits the provider reports for this organization (Groq: requests per day, tokens per minute). */
function limitsFrom(headers) {
    const get = name => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
    const rpd = Number(get('x-ratelimit-limit-requests'));
    const tpm = Number(get('x-ratelimit-limit-tokens'));
    return {
        ...(get('x-ratelimit-limit-requests') != null && Number.isFinite(rpd) && rpd > 0 ? { rpd } : {}),
        ...(get('x-ratelimit-limit-tokens') != null && Number.isFinite(tpm) && tpm > 0 ? { tpm } : {}),
    };
}

/** First JSON object in a reply (for models without a native JSON mode). */
export function extractJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
        throw new ProviderError('invalid_output', 'The model did not return JSON.');
    }
}

/**
 * @param {object} m model entry from models.mjs
 * @param {{ system: string, user: string, schema?: object, schemaName?: string, maxTokens?: number, temperature?: number, signal?: AbortSignal }} req
 */
export async function callModel(m, req, env = process.env) {
    const { url, key } = endpoint(m.provider, env);
    const system =
        req.schema && !m.nativeJson
            ? `${req.system}\n\nReply with ONLY one JSON object matching this JSON Schema, no other text:\n${JSON.stringify(req.schema)}`
            : req.system;
    const body = {
        model: m.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 1400,
        // a multi-turn conversation (with tool calls and results) or a single prompt
        messages: req.messages
            ? [{ role: 'system', content: system }, ...req.messages]
            : [
                  { role: 'system', content: system },
                  { role: 'user', content: req.user },
              ],
    };
    if (req.tools?.length) {
        body.tools = req.tools;
        body.tool_choice = 'auto';
    }
    if (m.provider === 'groq') {
        delete body.max_tokens;
        body.max_completion_tokens = req.maxTokens ?? 1400;
        body.reasoning_effort = 'low';
    }
    if (m.provider === 'gemini') body.reasoning_effort = m.model === 'gemini-3.1-flash-lite' ? 'minimal' : 'low';
    if (req.schema && m.nativeJson)
        body.response_format = {
            type: 'json_schema',
            json_schema: { name: req.schemaName ?? 'fastlane_response', strict: true, schema: req.schema },
        };
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            signal: req.signal,
            body: JSON.stringify(body),
        });
    } catch (e) {
        if (req.signal?.aborted || e?.name === 'AbortError')
            throw new ProviderError('timeout', 'The model took too long.');
        throw new ProviderError('network', 'Could not reach the provider.');
    }
    if (!response.ok) {
        let detail = '';
        try {
            detail = await response.text();
        } catch {}
        const status = response.status ?? 0;
        if (status === 429)
            throw new ProviderError('rate_limit', 'Rate limited.', {
                status,
                retryAfterMs: retryAfterMs(response.headers, detail),
            });
        if (status === 401 || status === 403)
            throw new ProviderError('auth', 'The provider rejected the credentials.', { status });
        if (status === 413 || /request too large|reduce your message size/i.test(detail))
            throw new ProviderError('bad_request', 'The request is too large for this model’s free limit.', { status });
        if (status === 400 || status === 404 || status === 422)
            throw new ProviderError('bad_request', 'The provider rejected the request.', { status });
        if (status === 408 || status === 504) throw new ProviderError('timeout', 'The provider timed out.', { status });
        throw new ProviderError('server', 'The provider had an error.', { status });
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message ?? {};
    const text = message.content ?? payload?.result?.response ?? '';
    // tools the model wants run (arguments arrive as JSON text)
    const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
        .filter(c => c?.function?.name)
        .map((c, i) => {
            let args = {};
            try {
                args =
                    typeof c.function.arguments === 'string'
                        ? JSON.parse(c.function.arguments || '{}')
                        : (c.function.arguments ?? {});
            } catch {
                args = { _unparsed: String(c.function.arguments).slice(0, 500) };
            }
            return { id: String(c.id ?? `call_${i}`), name: String(c.function.name), arguments: args };
        });
    if (!toolCalls.length && (typeof text !== 'string' || !text.trim()))
        throw new ProviderError('invalid_output', 'The model returned nothing.');
    const usage = {
        input:
            Number(payload?.usage?.prompt_tokens) ||
            Math.ceil((system.length + (req.user ?? JSON.stringify(req.messages ?? '')).length) / 4),
        output: Number(payload?.usage?.completion_tokens) || Math.ceil(String(text ?? '').length / 4),
    };
    return {
        text: typeof text === 'string' ? text : '',
        toolCalls,
        json: req.schema && !toolCalls.length ? extractJson(text) : undefined,
        usage,
        remaining: remainingFrom(response.headers),
        reported: limitsFrom(response.headers),
    };
}
