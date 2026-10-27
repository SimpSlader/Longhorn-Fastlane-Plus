/**
 * Fastlane's opt-in recommendation proxy. This code runs on Vercel, never in the Chrome extension.
 * GROQ_API_KEY and FASTLANE_AI_ACCESS_CODE are server-only environment variables.
 * No complete IDA files, student identity or browser storage values are accepted.
 */
import { cors, publicMeta, readAuthorized, routingFrom, send, sendUnavailable, tooMany } from './_ai/http.mjs';
import { routeAI } from './_ai/router.mjs';

import { responseSchema, SYSTEM_PROMPT, safeString, sanitize } from './_ai/tasks/recommend.mjs';

export { SYSTEM_PROMPT } from './_ai/tasks/recommend.mjs';
export const maxDuration = 30;
const MAX_BODY_BYTES = 45_000;

export default async function handler(req, res) {
    if (!cors(req, res)) return;
    if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.CLOUDFLARE_API_TOKEN)
        return send(res, 503, { error: 'No AI provider is configured. Add GROQ_API_KEY in Vercel.' });
    const body = readAuthorized(req, res, MAX_BODY_BYTES);
    if (!body || tooMany(req, res, 6)) return;
    const data = sanitize(body);
    if (!data || data.candidates.length === 0)
        return send(res, 400, { error: 'Provide verified UT course sections to analyze.' });
    const candidates = new Set(data.candidates.map(c => c.id));
    const result = await routeAI({
        task: 'recommend',
        system: SYSTEM_PROMPT,
        user: JSON.stringify(data),
        schema: responseSchema,
        schemaName: 'fastlane_recommendations',
        maxTokens: 1800,
        temperature: 0.1,
        containsStudentData: true,
        routing: routingFrom(body),
        cache: true,
        // a reply that mostly names sections we never sent is a hallucination: ask another model
        validate: out => {
            const recs = out.json?.recommendations;
            if (!Array.isArray(recs)) return 'missing recommendations';
            const unknown = recs.filter(r => !candidates.has(r?.id)).length;
            return recs.length && unknown > recs.length / 2 ? 'named sections that were not supplied' : null;
        },
    });
    if (!result.ok) return sendUnavailable(res, result);
    const parsed = result.json ?? {};
    const used = new Set();
    const recommendations = (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
        .filter(r => r && Number.isSafeInteger(r.id) && candidates.has(r.id) && !used.has(r.id) && used.add(r.id))
        .slice(0, 12)
        .map(r => ({
            id: r.id,
            reason: safeString(r.reason, 250),
            requirement: safeString(r.requirement, 110),
            confidence: ['high', 'possible', 'unlikely'].includes(r.confidence) ? r.confidence : 'possible',
            warning: safeString(r.warning, 200),
        }));
    return send(res, 200, {
        recommendations,
        summary: safeString(parsed.summary, 350),
        source: 'Verified locally cached UT sections; degree applicability is advisory',
        meta: publicMeta(result.meta),
    });
}
