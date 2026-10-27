import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerState } from './models.mjs';
import { complexity, rankModels, routeAI, routerStatus } from './router.mjs';
import { getJSON, resetMemoryStore, setJSON } from './store.mjs';

const ALL = {
    GROQ_API_KEY: 'gsk_test',
    GEMINI_API_KEY: 'gem_test',
    GEMINI_BILLING: 'off',
    CLOUDFLARE_API_TOKEN: 'cf_test',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_PLAN: 'free',
};
const providerOf = url =>
    url.includes('groq.com')
        ? 'groq'
        : url.includes('googleapis.com')
          ? 'gemini'
          : url.includes('cloudflare.com')
            ? 'cloudflare'
            : '?';
const reply = (content, headers = {}) => ({
    ok: true,
    status: 200,
    headers: new Headers(headers),
    json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
});
const failure = (status, headers = {}, text = '') => ({
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => text,
});

/** fetch that answers per provider with a queue of responses (last one repeats) */
function network(plan) {
    const calls = [];
    const fn = vi.fn(async (url, init) => {
        const p = providerOf(url);
        const body = JSON.parse(init.body);
        calls.push({ provider: p, model: body.model, body });
        const queue = plan[p] ?? [() => failure(500)];
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return next(body);
    });
    vi.stubGlobal('fetch', fn);
    return calls;
}
const chat = { task: 'chat', system: 'You are helpful.', user: 'Explain what a UGS course is.' };
const plan = {
    task: 'recommend',
    system: 'Plan.',
    user: '{"x":1}',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    validate: out => (out.json?.ok === true ? null : 'bad'),
};

beforeEach(() => resetMemoryStore());
afterEach(() => vi.unstubAllGlobals());

describe('which model a request goes to', () => {
    it('simple questions go to a fast model; complex planning to a reasoning model', async () => {
        const env = { GROQ_API_KEY: 'k' };
        expect(complexity('chat')).toBe(2);
        expect(complexity('recommend')).toBe(4);
        const simple = await rankModels({ ...chat, level: 2 }, env);
        expect(simple.ranked[0].model.id).toBe('groq:openai/gpt-oss-20b');
        const hard = await rankModels({ ...plan, level: 4, needsJson: true }, env);
        expect(hard.ranked[0].model.id).toBe('groq:openai/gpt-oss-120b');
        expect(hard.ranked.map(r => r.model.id)).not.toContain('groq:openai/gpt-oss-20b');
    });

    it('prefers Gemini for complex planning only when it may see student data', async () => {
        const allowed = await rankModels(
            { ...plan, level: 4, needsJson: true, containsStudentData: true },
            { ...ALL, GEMINI_ALLOW_STUDENT_DATA: 'true' }
        );
        expect(allowed.ranked[0].model.id).toBe('gemini:gemini-3.8-flash');
        const protectedRank = await rankModels({ ...plan, level: 4, needsJson: true, containsStudentData: true }, ALL);
        expect(protectedRank.ranked.some(r => r.model.provider === 'gemini')).toBe(false);
        expect(protectedRank.skipped.find(s => s.model === 'gemini:gemini-3.8-flash').reason).toMatch(/training/);
        // Cloudflare's small model is never used for level-4 planning
        expect(protectedRank.ranked.some(r => r.model.provider === 'cloudflare')).toBe(false);
    });

    it('measured results change the ranking (not a fixed order)', async () => {
        const env = { GROQ_API_KEY: 'k' };
        await setJSON('ai:model:groq:openai/gpt-oss-20b', { stats: { ok: 2, invalid: 40, failed: 10 } });
        const ranked = await rankModels({ ...chat, level: 2 }, env);
        expect(ranked.ranked[0].model.id).toBe('groq:openai/gpt-oss-120b');
    });

    it('manual mode tests one model; disabled providers are skipped', async () => {
        const manual = await rankModels(
            { ...chat, level: 2, mode: 'manual', manualModel: 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8' },
            ALL
        );
        expect(manual.ranked.map(r => r.model.id)).toEqual(['cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8']);
        const off = await rankModels({ ...chat, level: 2, disabledProviders: ['groq'] }, ALL);
        expect(off.ranked.some(r => r.model.provider === 'groq')).toBe(false);
    });
});

describe('strict free tier', () => {
    it('is on by default and needs confirmation that Gemini and Cloudflare cannot be billed', () => {
        expect(providerState('gemini', { GEMINI_API_KEY: 'x' }).eligible).toBe(false);
        expect(providerState('gemini', { GEMINI_API_KEY: 'x' }).reason).toMatch(/GEMINI_BILLING=off/);
        expect(providerState('cloudflare', { CLOUDFLARE_API_TOKEN: 'x', CLOUDFLARE_ACCOUNT_ID: 'a' }).eligible).toBe(
            false
        );
        expect(providerState('cloudflare', { ...ALL }).eligible).toBe(true);
        expect(providerState('groq', { GROQ_API_KEY: 'x', GROQ_PLAN: 'paid' }).eligible).toBe(false);
        expect(providerState('gemini', { GEMINI_API_KEY: 'x', STRICT_FREE_TIER: 'false' }).eligible).toBe(true);
    });

    it('OpenAI ChatGPT sign-in stays unavailable with the reason', () => {
        const s = providerState('openai', { OPENAI_CHATGPT_OAUTH_ENABLED: 'true' });
        expect(s.eligible).toBe(false);
        expect(s.reason).toMatch(/127\.0\.0\.1/);
    });

    it('a model near its free daily limit is skipped (15% kept in reserve)', async () => {
        const id = 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8';
        await setJSON(`ai:model:${id}`, {
            day: { date: new Date().toISOString().slice(0, 10), requests: 10, tokens: 0, neurons: 8600 },
        });
        const r = await rankModels({ ...chat, level: 2, mode: 'manual', manualModel: id }, ALL);
        expect(r.ranked).toHaveLength(0);
        expect(r.skipped.find(s => s.model === id).reason).toMatch(/free quota nearly used/);
    });
});

describe('failover and retries', () => {
    it('a rate-limited provider is skipped, honours Retry-After, and the same conversation goes to the next', async () => {
        const env = { ...ALL, GEMINI_ALLOW_STUDENT_DATA: 'true' };
        const calls = network({
            gemini: [() => failure(429, { 'retry-after': '120' })],
            groq: [() => reply('{"ok":true}')],
        });
        const out = await routeAI({ ...plan, containsStudentData: true }, env);
        expect(out.ok).toBe(true);
        expect(out.meta.model).toBe('groq:openai/gpt-oss-120b');
        expect(out.meta.fallback).toBe(true);
        expect(calls.map(c => c.provider)).toEqual(['gemini', 'groq']);
        // Test E: the second provider got exactly the same conversation
        expect(calls[1].body.messages).toEqual(calls[0].body.messages);
        const s = await getJSON('ai:model:gemini:gemini-3.8-flash');
        expect(s.cooldownUntil - Date.now()).toBeGreaterThan(100000);
        // the next request skips Gemini without calling it
        await routeAI({ ...plan, user: '{"x":2}', containsStudentData: true }, env);
        expect(calls.filter(c => c.provider === 'gemini')).toHaveLength(1);
    });

    it('Groq rate limits fall back to another free model for simple chat', async () => {
        const calls = network({
            groq: [() => failure(429, { 'retry-after': '30' })],
            cloudflare: [() => reply('A UGS course is…')],
        });
        const out = await routeAI(chat, {
            GROQ_API_KEY: 'k',
            CLOUDFLARE_API_TOKEN: 't',
            CLOUDFLARE_ACCOUNT_ID: 'a',
            CLOUDFLARE_PLAN: 'free',
        });
        expect(out.ok).toBe(true);
        expect(out.meta.provider).toBe('cloudflare');
        expect(calls.filter(c => c.provider === 'groq').length).toBeGreaterThanOrEqual(1);
    });

    it('rejected credentials are not retried; the next model answers', async () => {
        const calls = network({
            groq: [b => (b.model === 'openai/gpt-oss-20b' ? failure(401) : reply('fine'))],
        });
        const out = await routeAI(chat, { GROQ_API_KEY: 'k' });
        expect(out.ok).toBe(true);
        expect(calls.filter(c => c.model === 'openai/gpt-oss-20b')).toHaveLength(1);
        expect((await getJSON('ai:model:groq:openai/gpt-oss-20b')).cooldownReason).toBe('credentials rejected');
    });

    it('a timeout is retried once with backoff, then another model is used', async () => {
        const abort = () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        };
        const calls = network({ groq: [b => (b.model === 'openai/gpt-oss-20b' ? abort() : reply('ok'))] });
        const out = await routeAI(chat, { GROQ_API_KEY: 'k' });
        expect(out.ok).toBe(true);
        expect(calls.filter(c => c.model === 'openai/gpt-oss-20b')).toHaveLength(2);
        expect(out.meta.model).toBe('groq:openai/gpt-oss-120b');
    });

    it('invalid JSON or a failed check goes to another model instead of being shown', async () => {
        const env = { ...ALL, GEMINI_ALLOW_STUDENT_DATA: 'true' };
        network({ gemini: [() => reply('not json at all')], groq: [() => reply('{"ok":true}')] });
        const out = await routeAI(plan, env);
        expect(out.ok).toBe(true);
        expect(out.meta.attempts[0]).toMatchObject({ model: 'gemini:gemini-3.8-flash', outcome: 'invalid_output' });
        // (after that invalid reply Gemini already ranks lower, so start the next case fresh)
        resetMemoryStore();
        network({ gemini: [() => reply('{"ok":false}')], groq: [() => reply('{"ok":true}')] });
        const second = await routeAI({ ...plan, user: '{"y":1}' }, env);
        expect(second.meta.attempts.map(a => a.outcome)).toContain('invalid');
        expect(second.json).toEqual({ ok: true });
    });

    it('when every provider is unavailable it says so honestly, with a retry time', async () => {
        network({ groq: [() => failure(429, { 'retry-after': '45' })] });
        const out = await routeAI(chat, { GROQ_API_KEY: 'k' });
        expect(out.ok).toBe(false);
        expect(out.error.message).toMatch(/Nothing was charged/);
        expect(out.error.retryAfterSeconds).toBeGreaterThan(30);
        const none = await routeAI(chat, {});
        expect(none.ok).toBe(false);
        expect(none.error.category).toBe('none_available');
    });
});

describe('caching and concurrency', () => {
    it('identical concurrent requests share one model call; repeats come from the cache', async () => {
        const calls = network({ groq: [() => reply('{"ok":true}')] });
        const env = { GROQ_API_KEY: 'k' };
        const [a, b] = await Promise.all([
            routeAI({ ...plan, cache: true }, env),
            routeAI({ ...plan, cache: true }, env),
        ]);
        expect(a.ok && b.ok).toBe(true);
        expect(calls).toHaveLength(1);
        const again = await routeAI({ ...plan, cache: true }, env);
        expect(again.meta.cached).toBe(true);
        expect(calls).toHaveLength(1);
        // a changed request (new data or preferences) is never served from the old answer
        await routeAI({ ...plan, user: '{"x":1,"noFriday":true}', cache: true }, env);
        expect(calls).toHaveLength(2);
    });

    it('status shows providers, usage and decisions without secrets', async () => {
        network({ groq: [() => reply('hi')] });
        await routeAI(chat, { GROQ_API_KEY: 'k' });
        const status = await routerStatus({ GROQ_API_KEY: 'gsk_secret_value' });
        expect(JSON.stringify(status)).not.toContain('gsk_secret_value');
        expect(status.decisions.at(-1).ok).toBe(true);
        expect(status.providers.openai.eligible).toBe(false);
        expect(status.models.find(m => m.id === 'groq:openai/gpt-oss-20b').stats.ok).toBe(1);
    });
});
