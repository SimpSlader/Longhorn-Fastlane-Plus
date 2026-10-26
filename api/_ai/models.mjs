/**
 * Every model the router may use, with what it is good for and the free-tier limits it must stay under.
 * Limits are starting safety ceilings (Groq per organization; Gemini per
 * project; Cloudflare 10,000 Neurons a day per account). Providers change them: the live values in each
 * console win, and AI_LIMITS_JSON can override any of them without a code change.
 */

/** @typedef {{ rpm?: number, rpd?: number, tpm?: number, tpd?: number, neuronsPerDay?: number }} Limits */

export const MODELS = [
    {
        id: 'groq:openai/gpt-oss-20b',
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        label: 'GPT-OSS 20B (Groq)',
        tier: 'fast',
        maxLevel: 3,
        context: 131072,
        nativeJson: true,
        latencyMs: 900,
        // starting quality per complexity level (1–5); replaced by measured results as they come in
        prior: [0.8, 0.78, 0.72, 0.6, 0.5],
        limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
    },
    {
        id: 'groq:openai/gpt-oss-120b',
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        label: 'GPT-OSS 120B (Groq)',
        tier: 'reasoning',
        maxLevel: 5,
        context: 131072,
        nativeJson: true,
        latencyMs: 1800,
        prior: [0.8, 0.8, 0.82, 0.85, 0.85],
        limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
    },
    {
        id: 'gemini:gemini-3.8-flash',
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        tier: 'reasoning',
        maxLevel: 5,
        context: 1000000,
        nativeJson: true,
        latencyMs: 2600,
        prior: [0.78, 0.8, 0.84, 0.87, 0.88],
        limits: { rpm: 10, rpd: 250, tpm: 250000 },
        // Google may use free-tier inputs to improve its products (human review possible)
        trainsOnFreeTier: true,
    },
    {
        id: 'gemini:gemini-3.1-flash-lite',
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite',
        label: 'Gemini 3.1 Flash-Lite',
        tier: 'fast',
        maxLevel: 3,
        context: 1000000,
        nativeJson: true,
        latencyMs: 1200,
        prior: [0.78, 0.76, 0.72, 0.62, 0.55],
        limits: { rpm: 15, rpd: 1000, tpm: 250000 },
        trainsOnFreeTier: true,
    },
    {
        id: 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8',
        provider: 'cloudflare',
        model: '@cf/meta/llama-3.1-8b-instruct-fp8',
        label: 'Llama 3.1 8B (Cloudflare)',
        tier: 'fast',
        maxLevel: 2,
        context: 32000,
        nativeJson: false,
        latencyMs: 1300,
        prior: [0.7, 0.62, 0.5, 0.35, 0.3],
        limits: { rpm: 300, neuronsPerDay: 10000 },
        // conservative Neuron estimate per million tokens (Cloudflare bills this model's tokens as Neurons)
        neuronsPerMillion: { input: 4200, output: 36000 },
    },
];

export const PROVIDERS = {
    groq: { label: 'Groq', keys: ['GROQ_API_KEY'] },
    gemini: { label: 'Google Gemini', keys: ['GEMINI_API_KEY'] },
    cloudflare: { label: 'Cloudflare Workers AI', keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] },
    openai: { label: 'OpenAI (Sign in with ChatGPT)', keys: [] },
};

/** Why OpenAI's ChatGPT sign-in stays off for Fastlane (from developers.openai.com/siwc, read 2026-10-26). */
export const OPENAI_UNAVAILABLE =
    'Not available: OpenAI’s ChatGPT plan sharing is documented for open-source apps that run locally (sign-in returns to 127.0.0.1 and tokens must stay out of browser storage). Fastlane is a browser extension with a hosted server, which OpenAI routes to its interest form for approval first. It stays off until OpenAI approves it.';

/** Limits after any AI_LIMITS_JSON override, e.g. {"gemini:gemini-3.8-flash":{"rpd":500}}. */
export function limitsFor(model, env = process.env) {
    try {
        const extra = env.AI_LIMITS_JSON ? JSON.parse(env.AI_LIMITS_JSON)[model.id] : null;
        return { ...model.limits, ...(extra && typeof extra === 'object' ? extra : {}) };
    } catch {
        return model.limits;
    }
}

export const strictFreeTier = (env = process.env) => env.STRICT_FREE_TIER !== 'false';

/**
 * Whether a provider may be used right now: its keys are set and, in strict free mode, the owner confirmed
 * that the account cannot be billed (Gemini: no billing on the project; Cloudflare: the Workers Free plan,
 * where requests stop at the daily allocation instead of being charged). Groq's free plan has no card.
 */
export function providerState(provider, env = process.env) {
    if (provider === 'openai') return { configured: false, eligible: false, reason: OPENAI_UNAVAILABLE };
    const spec = PROVIDERS[provider];
    const missing = spec.keys.filter(k => !env[k]);
    if (missing.length)
        return { configured: false, eligible: false, reason: `Add ${missing.join(' and ')} in Vercel.` };
    if (env[`AI_DISABLE_${provider.toUpperCase()}`] === 'true')
        return { configured: true, eligible: false, reason: 'Turned off by the owner.' };
    if (!strictFreeTier(env)) return { configured: true, eligible: true, reason: '' };
    if (provider === 'gemini' && env.GEMINI_BILLING !== 'off')
        return {
            configured: true,
            eligible: false,
            reason: 'Strict free mode: set GEMINI_BILLING=off after checking the key’s Google Cloud project has no billing account (a billed project is charged per request).',
        };
    if (provider === 'cloudflare' && env.CLOUDFLARE_PLAN !== 'free')
        return {
            configured: true,
            eligible: false,
            reason: 'Strict free mode: set CLOUDFLARE_PLAN=free after checking the account is on Workers Free (Workers Paid bills past 10,000 Neurons a day).',
        };
    if (provider === 'groq' && env.GROQ_PLAN === 'paid')
        return { configured: true, eligible: false, reason: 'Strict free mode: GROQ_PLAN=paid, so Groq is not used.' };
    return { configured: true, eligible: true, reason: '' };
}
