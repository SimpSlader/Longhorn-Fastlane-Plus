/**
 * Fastlane's AI router. Every AI request goes through routeAI(): it picks the best eligible model for the
 * task from measured results (not a fixed order), stays inside free-tier limits with headroom, skips models
 * that are rate limited or failing, falls back automatically, retries only transient failures (bounded, with
 * jitter), and returns either a validated answer or an honest "temporarily unavailable". No extra AI call is
 * ever made to choose a model. Schedules are still built and checked by the extension's own code.
 */
import { createHash, randomUUID } from 'node:crypto';
import { limitsFor, MODELS, providerState } from './models.mjs';
import { callModel, ProviderError } from './providers.mjs';
import { getJSON, setJSON } from './store.mjs';

/** Share of each free limit kept in reserve. */
export const HEADROOM = 0.15;
const PRIOR_WEIGHT = 5;
const MAX_ATTEMPTS = 4;
const inFlight = new Map();

/** Complexity 1–5 for a task, nudged up for very large inputs. */
export function complexity(task, inputChars = 0) {
    const base =
        {
            agent: 4,
            test: 1,
            improve: 3,
            chat: 2,
            explain: 2,
            'audit-review': 3,
            filter: 3,
            advise: 4,
            recommend: 4,
            optimize: 5,
        }[task] ?? 3;
    return Math.min(5, base + (inputChars > 40000 ? 1 : 0));
}

/** Score weights: quality dominates hard planning; speed and quota matter more for simple questions. */
export function weightsFor(level, mode = 'auto') {
    if (mode === 'fastest') return { quality: 0.2, reliability: 0.15, quota: 0.1, latency: 0.5, features: 0.05 };
    if (mode === 'quality') return { quality: 0.7, reliability: 0.15, quota: 0.05, latency: 0.05, features: 0.05 };
    if (mode === 'preserve') return { quality: 0.2, reliability: 0.15, quota: 0.5, latency: 0.1, features: 0.05 };
    if (level >= 4) return { quality: 0.55, reliability: 0.2, quota: 0.1, latency: 0.1, features: 0.05 };
    if (level <= 2) return { quality: 0.25, reliability: 0.2, quota: 0.25, latency: 0.25, features: 0.05 };
    return { quality: 0.4, reliability: 0.2, quota: 0.2, latency: 0.15, features: 0.05 };
}

const today = () => new Date().toISOString().slice(0, 10);
const minute = () => Math.floor(Date.now() / 60000);

async function stateOf(id) {
    const s = (await getJSON(`ai:model:${id}`)) ?? {};
    const day = s.day?.date === today() ? s.day : { date: today(), requests: 0, tokens: 0, neurons: 0 };
    const min = s.minute?.at === minute() ? s.minute : { at: minute(), requests: 0, tokens: 0 };
    return {
        ...s,
        day,
        minute: min,
        stats: s.stats ?? {},
        cooldownUntil: s.cooldownUntil ?? 0,
    };
}
const saveState = (id, s) => setJSON(`ai:model:${id}`, s, 3 * 24 * 3600);

/** Limits the provider itself reported (Groq sends them with every reply) win over published defaults. */
export function effectiveLimits(model, s, env = process.env) {
    const l = { ...limitsFor(model, env) };
    if (s.reported?.rpd) l.rpd = s.reported.rpd;
    if (s.reported?.tpm) l.tpm = s.reported.tpm;
    return l;
}

/**
 * Fraction (0–1) of the tightest free limit used, counting this request's estimate. Per-minute figures only
 * shape the ranking: the provider enforces them itself (a 429 then cools the model down), so they never block
 * a request in advance. Daily caps (requests, tokens, Cloudflare Neurons) do, with headroom kept in reserve.
 */
export function usedFraction(model, s, estimate, env = process.env, { daily = false } = {}) {
    const l = effectiveLimits(model, s, env);
    const parts = [];
    if (!daily && l.rpm) parts.push((s.minute.requests + 1) / l.rpm);
    if (!daily && l.tpm) parts.push((s.minute.tokens + estimate.tokens) / l.tpm);
    if (l.rpd) parts.push((s.day.requests + 1) / l.rpd);
    if (l.tpd) parts.push((s.day.tokens + estimate.tokens) / l.tpd);
    if (l.neuronsPerDay) parts.push((s.day.neurons + estimate.neurons) / l.neuronsPerDay);
    // the provider said this minute's requests are used up
    if (s.remaining?.requests != null && s.remainingAt === minute()) parts.push(s.remaining.requests <= 0 ? 1 : 0);
    return parts.length ? Math.max(...parts) : 0;
}

function neurons(model, input, output) {
    const r = model.neuronsPerMillion;
    return r ? (input * r.input + output * r.output) / 1e6 : 0;
}

export function scoreModel(model, s, level, mode, fraction, inputTokens) {
    const st = s.stats;
    const judged = (st.ok ?? 0) + (st.invalid ?? 0) + (st.failed ?? 0);
    const prior = model.prior[level - 1] ?? 0.5;
    const quality = (prior * PRIOR_WEIGHT + (st.ok ?? 0)) / (PRIOR_WEIGHT + judged);
    const reliability =
        ((st.ok ?? 0) + 1) / ((st.ok ?? 0) + (st.failed ?? 0) + (st.rateLimited ?? 0) + (st.invalid ?? 0) + 2);
    const quota = Math.max(0, 1 - fraction);
    const latency = 1 / (1 + (st.latencyMs ?? model.latencyMs) / 2000);
    const features = (inputTokens < model.context * 0.5 ? 0.6 : 0.2) + (model.nativeJson ? 0.4 : 0.2);
    const w = weightsFor(level, mode);
    return (
        quality * w.quality +
        reliability * w.reliability +
        quota * w.quota +
        latency * w.latency +
        features * w.features
    );
}

/** Models that can take this request, best first, with why the others were left out. */
export async function rankModels(request, env = process.env) {
    const { level, mode = 'auto', manualModel, disabledProviders = [], containsStudentData, needsJson } = request;
    const needsTools = !!request.tools?.length;
    const inputTokens = Math.ceil(
        ((request.system?.length ?? 0) + (request.user?.length ?? JSON.stringify(request.messages ?? '').length)) / 4
    );
    // replies are usually far shorter than the maximum allowed, so half of it is a fair estimate
    const estimate = { tokens: inputTokens + Math.round((request.maxTokens ?? 1400) / 2), neurons: 0 };
    const ranked = [];
    const skipped = [];
    for (const model of MODELS) {
        const provider = providerState(model.provider, env);
        const skip = reason => skipped.push({ model: model.id, reason });
        if (!provider.eligible) {
            skip(provider.reason);
            continue;
        }
        if (disabledProviders.includes(model.provider)) {
            skip('turned off in your settings');
            continue;
        }
        if (mode === 'manual' && manualModel && manualModel !== model.id) {
            skip('manual selection');
            continue;
        }
        if (level > model.maxLevel && mode !== 'manual') {
            skip(`not used for level-${level} tasks`);
            continue;
        }
        if (inputTokens > model.context * 0.8) {
            skip('request too large for its context');
            continue;
        }
        if (containsStudentData && model.trainsOnFreeTier && env.GEMINI_ALLOW_STUDENT_DATA !== 'true') {
            skip('free tier may use inputs for training, so it gets no student data');
            continue;
        }
        if (needsTools && !model.tools) {
            skip('no reliable tool calling');
            continue;
        }
        if (needsJson && !model.nativeJson && level >= 4) {
            skip('no native JSON mode for a structured planning answer');
            continue;
        }
        const s = await stateOf(model.id);
        if (s.cooldownUntil > Date.now()) {
            skip(`cooling down (${s.cooldownReason ?? 'recent errors'})`);
            continue;
        }
        const est = { ...estimate, neurons: neurons(model, inputTokens, request.maxTokens ?? 1400) };
        if (usedFraction(model, s, est, env, { daily: true }) > 1 - HEADROOM) {
            skip('daily free limit nearly used (15% kept in reserve)');
            continue;
        }
        const fraction = usedFraction(model, s, est, env);
        ranked.push({
            model,
            state: s,
            score: scoreModel(model, s, level, mode, fraction, inputTokens),
            estimate: est,
        });
    }
    ranked.sort((a, b) => b.score - a.score);
    return { ranked, skipped };
}

async function record(model, update) {
    const s = await stateOf(model.id);
    const st = s.stats;
    if (update.outcome === 'ok') {
        st.ok = (st.ok ?? 0) + 1;
        st.lastOk = Date.now();
        st.latencyMs = Math.round(st.latencyMs ? st.latencyMs * 0.7 + update.latencyMs * 0.3 : update.latencyMs);
    } else if (update.outcome === 'invalid') st.invalid = (st.invalid ?? 0) + 1;
    else if (update.outcome === 'rate_limit') st.rateLimited = (st.rateLimited ?? 0) + 1;
    else st.failed = (st.failed ?? 0) + 1;
    if (update.outcome !== 'ok') {
        st.lastError = Date.now();
        st.lastErrorCategory = update.outcome;
    }
    if (update.usage) {
        s.day.requests += 1;
        s.minute.requests += 1;
        s.day.tokens += update.usage.input + update.usage.output;
        s.minute.tokens += update.usage.input + update.usage.output;
        s.day.neurons += neurons(model, update.usage.input, update.usage.output);
    } else if (update.outcome !== 'rate_limit') {
        s.day.requests += 1;
        s.minute.requests += 1;
    }
    if (update.remaining) {
        s.remaining = update.remaining;
        s.remainingAt = minute();
    }
    if (update.reported && Object.keys(update.reported).length)
        s.reported = { ...s.reported, ...update.reported, at: Date.now() };
    if (update.cooldownMs) {
        s.cooldownUntil = Date.now() + update.cooldownMs;
        s.cooldownReason =
            update.outcome === 'rate_limit'
                ? 'rate limited'
                : update.outcome === 'auth'
                  ? 'credentials rejected'
                  : 'errors';
    }
    s.stats = st;
    await saveState(model.id, s);
}

async function logDecision(entry) {
    const list = ((await getJSON('ai:decisions')) ?? []).slice(-29);
    list.push(entry);
    await setJSON('ai:decisions', list, 7 * 24 * 3600);
    const totals = (await getJSON('ai:totals')) ?? {};
    const bump = k => {
        totals[k] = (totals[k] ?? 0) + 1;
    };
    bump('requests');
    if (entry.cached) bump('cacheHits');
    if (entry.fallback) bump('fallbacks');
    if (!entry.ok) bump('unavailable');
    if (entry.attempts?.some(a => a.outcome === 'rate_limit')) bump('rateLimitEvents');
    if (entry.model) totals[`model:${entry.model}`] = (totals[`model:${entry.model}`] ?? 0) + 1;
    await setJSON('ai:totals', totals, 30 * 24 * 3600);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/**
 * @param {{ task: string, system: string, user: string, schema?: object, schemaName?: string, maxTokens?: number,
 *   temperature?: number, validate?: (out: {text: string, json?: any}) => string | null, containsStudentData?: boolean,
 *   routing?: { mode?: string, model?: string, disabledProviders?: string[] }, cache?: boolean, deadlineMs?: number }} request
 */
export async function routeAI(request, env = process.env) {
    const routing = request.routing ?? {};
    const level = complexity(
        request.task,
        (request.system?.length ?? 0) + (request.user?.length ?? JSON.stringify(request.messages ?? '').length)
    );
    const cacheKey = request.cache
        ? `ai:cache:${hash([request.task, request.system, request.user, request.schema ?? null])}`
        : null;
    if (cacheKey) {
        const hit = await getJSON(cacheKey);
        if (hit) {
            const meta = { ...hit.meta, requestId: randomUUID(), cached: true, latencyMs: 0 };
            await logDecision({
                at: Date.now(),
                task: request.task,
                level,
                model: hit.meta.model,
                ok: true,
                cached: true,
                reason: 'same request answered recently',
            });
            return { ok: true, text: hit.text, json: hit.json, meta };
        }
        // two identical requests at once share one model call
        if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    }
    const run = dispatch(request, routing, level, cacheKey, env);
    if (cacheKey) {
        inFlight.set(cacheKey, run);
        run.finally(() => inFlight.delete(cacheKey));
    }
    return run;
}

async function dispatch(request, routing, level, cacheKey, env) {
    const requestId = randomUUID();
    const started = Date.now();
    const deadline = started + (request.deadlineMs ?? 25000);
    const { ranked, skipped } = await rankModels(
        {
            ...request,
            level,
            mode: routing.mode,
            manualModel: routing.model,
            disabledProviders: routing.disabledProviders ?? [],
            needsJson: !!request.schema,
        },
        env
    );
    const attempts = [];
    let rateLimitedUntil = 0;
    for (const candidate of ranked) {
        if (attempts.length >= MAX_ATTEMPTS || Date.now() > deadline - 1500) break;
        const { model } = candidate;
        // one quick retry for a transient failure on the same model, then move on
        for (let tryNo = 0; tryNo < 2; tryNo++) {
            if (attempts.length >= MAX_ATTEMPTS || Date.now() > deadline - 1500) break;
            const t0 = Date.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), Math.min(18000, deadline - Date.now()));
            try {
                const out = await callModel(model, { ...request, signal: controller.signal }, env);
                const problem = request.validate ? request.validate(out) : null;
                if (problem) {
                    attempts.push({ model: model.id, outcome: 'invalid', detail: problem });
                    await record(model, {
                        outcome: 'invalid',
                        usage: out.usage,
                        remaining: out.remaining,
                        reported: out.reported,
                    });
                    break; // try the next model rather than asking the same one again
                }
                const latencyMs = Date.now() - t0;
                attempts.push({ model: model.id, outcome: 'ok', latencyMs });
                await record(model, {
                    outcome: 'ok',
                    latencyMs,
                    usage: out.usage,
                    remaining: out.remaining,
                    reported: out.reported,
                });
                const meta = {
                    requestId,
                    task: request.task,
                    level,
                    provider: model.provider,
                    model: model.id,
                    label: model.label,
                    latencyMs: Date.now() - started,
                    usage: out.usage,
                    attempts,
                    fallback: attempts.length > 1,
                    cached: false,
                    validation: request.validate ? 'passed' : 'not-required',
                };
                if (cacheKey) await setJSON(cacheKey, { text: out.text, json: out.json, meta }, 600);
                await logDecision({
                    at: Date.now(),
                    task: request.task,
                    level,
                    model: model.id,
                    ok: true,
                    fallback: meta.fallback,
                    attempts: attempts.map(a => ({ model: a.model, outcome: a.outcome })),
                    reason: `best score for a level-${level} ${request.task} request${meta.fallback ? ' after fallback' : ''}`,
                });
                return { ok: true, text: out.text, json: out.json, toolCalls: out.toolCalls ?? [], meta };
            } catch (e) {
                const err = e instanceof ProviderError ? e : new ProviderError('invalid_output', 'Unreadable reply.');
                attempts.push({ model: model.id, outcome: err.category });
                if (err.category === 'rate_limit') {
                    const wait = Math.max(err.retryAfterMs || 60000, 5000);
                    rateLimitedUntil = rateLimitedUntil
                        ? Math.min(rateLimitedUntil, Date.now() + wait)
                        : Date.now() + wait;
                    await record(model, { outcome: 'rate_limit', cooldownMs: wait });
                    break;
                }
                if (err.category === 'auth') {
                    await record(model, { outcome: 'auth', cooldownMs: 15 * 60000 });
                    break;
                }
                if (err.category === 'bad_request' || err.category === 'invalid_output') {
                    await record(model, { outcome: err.category === 'invalid_output' ? 'invalid' : 'failed' });
                    break;
                }
                // timeout / server / network: retry once after a short, jittered backoff
                const repeated = attempts.filter(a => a.model === model.id && a.outcome === err.category).length > 1;
                await record(model, { outcome: 'failed', cooldownMs: repeated ? 60000 : 0 });
                if (tryNo === 0 && !repeated) await sleep(250 + Math.random() * 500);
                else break;
            } finally {
                clearTimeout(timer);
            }
        }
    }
    const retryAfterSeconds = rateLimitedUntil ? Math.ceil((rateLimitedUntil - Date.now()) / 1000) : 30;
    const meta = {
        requestId,
        task: request.task,
        level,
        attempts,
        skipped,
        latencyMs: Date.now() - started,
        cached: false,
    };
    await logDecision({
        at: Date.now(),
        task: request.task,
        level,
        model: null,
        ok: false,
        attempts: attempts.map(a => ({ model: a.model, outcome: a.outcome })),
        reason: ranked.length
            ? 'every eligible model failed or was rate limited'
            : 'no eligible model (free limits, cooldowns or setup)',
    });
    return {
        ok: false,
        error: {
            category: ranked.length ? 'all_failed' : 'none_available',
            message: ranked.length
                ? 'Every free AI model is busy or failing right now. Nothing was charged; try again shortly.'
                : `No free AI model can take this request right now. ${whyNone(skipped)} Nothing was charged.`,
            retryAfterSeconds,
        },
        meta,
    };
}

const PROVIDER_LABEL = { groq: 'Groq', gemini: 'Gemini', cloudflare: 'Cloudflare' };

/** One reason per provider, e.g. "Groq: turned off in your settings. Gemini: Add GEMINI_API_KEY in Vercel." */
export function whyNone(skipped) {
    const byProvider = new Map();
    for (const s of skipped) {
        const provider = s.model.split(':')[0];
        if (!byProvider.has(provider)) byProvider.set(provider, new Set());
        byProvider.get(provider).add(s.reason);
    }
    return [...byProvider.entries()]
        .map(
            ([p, reasons]) =>
                `${PROVIDER_LABEL[p] ?? p}: ${[...reasons].filter(r => r !== 'manual selection').join('; ') || 'not selected'}.`
        )
        .join(' ');
}

/** Status for the dashboard: never includes keys, prompts or student data. */
export async function routerStatus(env = process.env) {
    const providers = {};
    for (const [id] of Object.entries({ groq: 1, gemini: 1, cloudflare: 1, openai: 1 }))
        providers[id] = providerState(id, env);
    const models = [];
    for (const model of MODELS) {
        const s = await stateOf(model.id);
        models.push({
            id: model.id,
            provider: model.provider,
            label: model.label,
            tier: model.tier,
            maxLevel: model.maxLevel,
            limits: limitsFor(model, env),
            today: s.day,
            stats: s.stats,
            cooldownUntil: s.cooldownUntil > Date.now() ? s.cooldownUntil : 0,
            cooldownReason: s.cooldownUntil > Date.now() ? s.cooldownReason : '',
            trainsOnFreeTier: !!model.trainsOnFreeTier,
        });
    }
    return {
        providers,
        models,
        decisions: (await getJSON('ai:decisions')) ?? [],
        totals: (await getJSON('ai:totals')) ?? {},
    };
}
