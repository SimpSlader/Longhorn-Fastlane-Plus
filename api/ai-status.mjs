/**
 * Status for the extension's AI dashboard: which providers are set up and eligible, per-model usage against
 * free limits, measured quality, cooldowns, recent routing decisions and totals. Never returns keys, prompts or
 * student data. With { test: "groq" } it sends one tiny request through that provider to check it works.
 */
import { cors, publicMeta, readAuthorized, send, tooMany } from './_ai/http.mjs';
import { MODELS, OPENAI_UNAVAILABLE, strictFreeTier } from './_ai/models.mjs';
import { routeAI, routerStatus } from './_ai/router.mjs';
import { storeKind } from './_ai/store.mjs';

export const maxDuration = 30;

export default async function handler(req, res) {
    if (!cors(req, res)) return;
    const body = readAuthorized(req, res, 2000);
    if (!body || tooMany(req, res, 20)) return;
    if (typeof body.test === 'string') {
        const model = MODELS.find(m => m.provider === body.test);
        if (!model) return send(res, 400, { error: 'Unknown provider.' });
        const result = await routeAI({
            task: 'test',
            system: 'You are a connection check.',
            user: 'Reply with the single word OK.',
            maxTokens: 20,
            routing: { mode: 'manual', model: body.model || model.id },
        });
        return send(res, 200, {
            ok: result.ok,
            message: result.ok ? `Answered in ${result.meta.latencyMs} ms.` : result.error.message,
            meta: publicMeta(result.meta),
        });
    }
    const status = await routerStatus();
    return send(res, 200, {
        strictFreeTier: strictFreeTier(),
        storage: storeKind(),
        openai: { enabled: false, reason: OPENAI_UNAVAILABLE },
        ...status,
    });
}
