/**
 * Fastlane's opt-in degree advisor. The extension computes every number (hours left, ACC room, semester
 * scenarios, McCombs prerequisite status) from the imported IDA in the browser and sends only those facts,
 * course codes and requirement text; the model explains them in plain words. No IDA files, grades, GPA or
 * student identity are accepted. GROQ_API_KEY and FASTLANE_AI_ACCESS_CODE are server-only variables.
 */
import {
    cors,
    publicMeta,
    readAuthorized,
    routingFrom,
    safeString,
    send,
    sendUnavailable,
    tooMany,
} from './_ai/http.mjs';
import { routeAI } from './_ai/router.mjs';

export { safeString };

export const maxDuration = 30;

const MAX_BODY_BYTES = 30_000;

import { groundingProblem, responseSchema, SYSTEM_PROMPT, sanitize } from './_ai/tasks/advise.mjs';

export { groundingProblem, SYSTEM_PROMPT, sanitize } from './_ai/tasks/advise.mjs';

export default async function handler(req, res) {
    if (!cors(req, res)) return;
    const body = readAuthorized(req, res, MAX_BODY_BYTES);
    if (!body || tooMany(req, res, 8)) return;
    const data = sanitize(body);
    if (!data) return send(res, 400, { error: 'Ask a question first.' });
    const result = await routeAI({
        task: 'advise',
        system: SYSTEM_PROMPT,
        user: JSON.stringify(data),
        schema: responseSchema,
        schemaName: 'fastlane_advice',
        maxTokens: 1400,
        temperature: 0.2,
        containsStudentData: true,
        routing: routingFrom(body),
        cache: true,
        validate: out => groundingProblem(out.json?.answer, data.facts),
    });
    if (!result.ok) return sendUnavailable(res, result);
    const answer = typeof result.json?.answer === 'string' ? result.json.answer.slice(0, 2400).trim() : '';
    return send(res, 200, { answer, meta: publicMeta(result.meta) });
}
