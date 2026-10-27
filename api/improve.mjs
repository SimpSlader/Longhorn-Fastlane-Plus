/**
 * "Improve my message": rewrites a student's draft into a clear, specific request for Fastlane's planner.
 * It may fix typos, spell out abbreviations and order the details, but it must not add, drop or change any
 * preference: a programmatic check rejects rewrites with new numbers, days or course codes and the router
 * then tries another model. Only the draft (and, if given, the courses in the shown plan) is sent.
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

export const maxDuration = 30;

export const SYSTEM_PROMPT = `Rewrite a UT Austin student's draft message to Fastlane, a course-planning assistant, so Fastlane understands it on the first try.

Rules:
- Keep the student's own format, order and voice. If they wrote paragraphs, return paragraphs in the same order; if they wrote a list, keep the list. Never turn prose into a list, never regroup, never summarize.
- Keep EVERY request, question, preference, number, example and detail, including side questions (graduation timing, summer classes, credit hours per semester, ACC, tips). Keep nuance ("a minimum of 12 to 13, preferably around 15" stays that way). Never drop a part, however long the message.
- Add nothing they didn't say: no new credit numbers, days, times, subjects, courses, professors or goals.
- Only clean up: fix spelling, grammar and punctuation; remove filler ("um", "like", "uh", repeated words); split run-on sentences; spell out abbreviations (fri → Friday, MWF → Monday, Wednesday and Friday, TTh → Tuesday and Thursday, async → fully online (asynchronous), creds/hrs → credit hours, gov → government) and fix obvious speech-to-text slips (for example "ACCU" → "ACC").
- First person, no preamble or quotes.
Return JSON: improved (the rewritten message) and changes (up to 4 very short notes on what you clarified).`;

const schema = {
    type: 'object',
    properties: {
        improved: { type: 'string' },
        changes: { type: 'array', items: { type: 'string' } },
    },
    required: ['improved', 'changes'],
    additionalProperties: false,
};

const DAY_WORDS = [
    ['M', /\bmon(?:day)?s?\b|\bmwf?\b|\bm\/w/],
    ['T', /\btue(?:s|sday)?s?\b|\btth\b|\btt\b|\bt\/th/],
    ['W', /\bwed(?:nesday)?s?\b|\bmwf?\b|\bm\/w/],
    ['TH', /\bthu(?:rs?|rsday)?s?\b|\btth\b|\btt\b|\bt\/th/],
    ['F', /\bfri(?:day)?s?\b|\bmwf\b/],
];
const days = text => new Set(DAY_WORDS.filter(([, re]) => re.test(text.toLowerCase())).map(([d]) => d));
const WORD_NUMBERS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    eighteen: 18,
};
const numbers = text =>
    new Set([
        ...(text.match(/\d+/g) ?? []).map(Number),
        ...(
            text
                .toLowerCase()
                .match(
                    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen)\b/g
                ) ?? []
        ).map(w => WORD_NUMBERS[w]),
    ]);
/** Topics that must survive a rewrite when the draft mentions them. */
const TOPICS = [
    ['ACC', /\bacc\b|austin community college|community college/i],
    ['summer', /\bsummers?\b/i],
    ['graduating', /\bgraduat/i],
    ['transferring', /\btransfer/i],
    ['GPA', /\bgpa\b|grade point/i],
    ['professors', /\bprofessors?\b|\bprofs?\b|rate ?my ?prof|\brmp\b/i],
    ['core', /\bcore\b/i],
    ['online classes', /\bonline\b|\basync/i],
    ['back-to-back classes', /back[- ]to[- ]back|\bgaps?\b/i],
    ['tips', /\btips?\b|\btricks?\b|recommendations?|advice/i],
    ['credit hours per semester', /per semester|a semester|each semester/i],
];
const codes = text =>
    new Set(
        (text.toUpperCase().match(/\b[A-Z]{1,3}(?: [A-Z])?\s?\d{3}[A-Z]?\b/g) ?? []).map(c => c.replace(/\s+/g, ''))
    );

/** Why a rewrite can't be shown (it added something), or null when it only clarified the draft. */
export function addedSomething(draft, rewritten) {
    if (typeof rewritten !== 'string' || !rewritten.trim()) return 'empty rewrite';
    // list markers ("1. ", "2) ") are layout, not numbers the student said
    const improved = rewritten.replace(/^\s*\d+[.)]\s+/gm, '');
    if (improved.length > Math.max(400, draft.length * 4)) return 'rewrite too long';
    const before = numbers(draft);
    const after = numbers(improved);
    for (const n of after) if (!before.has(n)) return `added the number ${n}`;
    const d0 = days(draft);
    for (const d of days(improved)) if (!d0.has(d)) return `added a day (${d})`;
    const c0 = codes(draft);
    for (const c of codes(improved)) if (!c0.has(c)) return `added a course (${c})`;
    // nothing the student asked about may disappear
    for (const n of before) if (n > 1 && !after.has(n)) return `dropped the number ${n}`;
    for (const [topic, re] of TOPICS) if (re.test(draft) && !re.test(improved)) return `dropped ${topic}`;
    const words = t => t.split(/\s+/).filter(Boolean).length;
    if (words(draft) > 40 && words(improved) < words(draft) * 0.3) return 'dropped too much of the message';
    return null;
}

export default async function handler(req, res) {
    if (!cors(req, res)) return;
    const body = readAuthorized(req, res, 12000);
    if (!body || tooMany(req, res, 12)) return;
    const draft = safeString(body.draft, 4000);
    if (!draft) return send(res, 400, { error: 'Type a message first.' });
    const plan = Array.isArray(body.plan)
        ? body.plan
              .slice(0, 8)
              .map(c => safeString(c, 20))
              .filter(Boolean)
        : [];
    const result = await routeAI({
        task: 'improve',
        system: SYSTEM_PROMPT,
        user: JSON.stringify({ draft, currentPlanCourses: plan }),
        schema,
        schemaName: 'fastlane_improved_message',
        maxTokens: 1800,
        temperature: 0.2,
        containsStudentData: false,
        routing: routingFrom(body),
        cache: true,
        validate: out => addedSomething(draft, out.json?.improved),
    });
    if (!result.ok) return sendUnavailable(res, result);
    return send(res, 200, {
        improved: safeString(result.json.improved, 4000),
        changes: (Array.isArray(result.json.changes) ? result.json.changes : [])
            .slice(0, 4)
            .map(c => safeString(c, 80)),
        meta: publicMeta(result.meta),
    });
}
