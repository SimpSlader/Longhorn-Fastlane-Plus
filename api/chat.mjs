/**
 * Fastlane's general conversation: explanations, follow-ups and anything that isn't a schedule, a degree plan
 * or a fact the extension answers itself. The extension sends only what the question needs (recent turns,
 * saved memory, the shown plan's public course facts, and computed hour totals when relevant); the router
 * picks a free model. GPA, grades, names and IDA files are never accepted.
 */
import { cors, publicMeta, readAuthorized, routingFrom, send, sendUnavailable, tooMany } from './_ai/http.mjs';
import { routeAI } from './_ai/router.mjs';

export const maxDuration = 30;
const MAX_BODY_BYTES = 20_000;

import { SYSTEM_PROMPT, sanitize } from './_ai/tasks/chat.mjs';

export { SYSTEM_PROMPT, sanitize } from './_ai/tasks/chat.mjs';

export default async function handler(req, res) {
    if (!cors(req, res)) return;
    const body = readAuthorized(req, res, MAX_BODY_BYTES);
    if (!body || tooMany(req, res, 12)) return;
    const data = sanitize(body);
    if (!data) return send(res, 400, { error: 'Say something first.' });
    const result = await routeAI({
        task: 'chat',
        system: SYSTEM_PROMPT,
        user: JSON.stringify(data),
        maxTokens: 900,
        temperature: 0.4,
        containsStudentData: !!data.academic || data.memory.length > 0,
        routing: routingFrom(body),
        validate: out => (out.text.trim().length ? null : 'empty answer'),
    });
    if (!result.ok) return sendUnavailable(res, result);
    return send(res, 200, { answer: result.text.slice(0, 4000).trim(), meta: publicMeta(result.meta) });
}
