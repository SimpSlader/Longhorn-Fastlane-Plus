/**
 * Academic figures a student states in the chat ("I have 22 hours counted toward my degree", "120 total",
 * "13 in residence, no upper-division yet", "I want to graduate in Spring 2029"). They are recorded as the
 * student's own figures with the time they were said, used for planning ahead of stale records, and kept beside
 * (never written over) the imported IDA.
 */
import type { ConfirmedFacts, FactKey } from './academicModel';
import { parseTerm, termName } from './graduation';

const N = String.raw`(\d{1,3})`;
const H = String.raw`(?:credit hours?|credits?|hours?|hrs|chs?)`;

const RULES: Array<[FactKey, RegExp]> = [
    // "120 total hours required", "my degree requires 120", "120 hours to graduate"
    [
        'degreeTotalRequired',
        new RegExp(
            String.raw`\b${N}\s*(?:total\s*)?${H}?\s*(?:total\s*)?(?:are\s*)?(?:required|needed)(?: (?:for|to) (?:the |my )?(?:degree|graduate))?\b|\bdegree (?:requires|needs) ${N}\b|\b${N} ${H} to graduate\b`,
            'i'
        ),
    ],
    // "13 in residence", "13 UT residency hours", "13 residence hours counted"
    [
        'utResidentCounted',
        new RegExp(
            String.raw`\b${N}\s*(?:ut\s*)?(?:in[- ]residence|residen(?:cy|t|ce))\s*${H}?(?!\s*(?:are\s*)?required)`,
            'i'
        ),
    ],
    // "60 hours in residence required"
    [
        'utResidentRequired',
        new RegExp(
            String.raw`\b${N}\s*${H}?\s*(?:ut\s*)?(?:in[- ]residence|residen(?:cy|ce))\s*${H}?\s*(?:are\s*)?required`,
            'i'
        ),
    ],
    // "39 upper-division hours required", "24 upper-division hours in residence"
    [
        'upperDivisionResidentRequired',
        new RegExp(String.raw`\b${N}\s*${H}?\s*(?:of\s*)?upper[- ]division\s*${H}?\s*(?:ut\s*)?in[- ]residence`, 'i'),
    ],
    [
        'upperDivisionRequired',
        new RegExp(String.raw`\b${N}\s*${H}?\s*(?:of\s*)?upper[- ]division\s*${H}?\s*(?:are\s*)?required`, 'i'),
    ],
    // "I have 22 hours counted", "22 credits toward my degree (including in progress)"
    [
        'degreeCreditsProjected',
        new RegExp(
            String.raw`\b${N}\s*${H}?\s*(?:counted|count(?:ing)?|applied)\s*(?:toward|towards|to)?\s*(?:my|the)?\s*degree|\b${N}\s*${H}\s*(?:toward|towards)\s*(?:my|the)\s*degree|\b${N}\s*${H}?\s*(?:including|with) (?:what i'?m taking|in[- ]progress|my current)`,
            'i'
        ),
    ],
    // "98 remaining", "98 left"
    ['degreeCreditsRemainingProjected', new RegExp(String.raw`\b${N}\s*${H}?\s*(?:remaining|left|to go)\b`, 'i')],
    // "I've completed/earned 9", "9 completed"
    [
        'degreeCreditsEarned',
        new RegExp(
            String.raw`\b(?:i(?:'ve| have)?\s*(?:completed|earned|finished|passed)|completed|earned)\s*${N}\s*${H}?|\b${N}\s*${H}?\s*(?:completed|earned|finished|done)\b`,
            'i'
        ),
    ],
    // "taking 13", "13 in progress", "currently enrolled in 13"
    [
        'degreeCreditsInProgress',
        new RegExp(
            String.raw`\b(?:taking|enrolled in|registered for)\s*${N}\s*${H}?|\b${N}\s*${H}?\s*(?:in[- ]progress|this semester|currently)\b`,
            'i'
        ),
    ],
];

export interface Statement {
    facts: ConfirmedFacts;
    /** "use what I'm telling you": the student asserts they are the source of truth */
    authoritative: boolean;
}

/** Figures the student states in a message (empty when they state none). */
export function statedFacts(message: string, at = Date.now()): Statement {
    const t = message.toLowerCase().replace(/[–—]/g, '-');
    const facts: ConfirmedFacts = {};
    const taken = new Set<number>();
    for (const [field, re] of RULES) {
        const m = re.exec(t);
        if (!m) continue;
        const raw = m.slice(1).find(Boolean);
        if (!raw) continue;
        // one number feeds one field ("13 in residence" isn't also "13 in progress")
        const pos = m.index + m[0].indexOf(raw);
        if (taken.has(pos)) continue;
        taken.add(pos);
        facts[field] = { value: Number(raw), at };
    }
    if (
        /\bno upper[- ]division\b|\b(?:zero|0) upper[- ]division\b|\bnone (?:of it )?(?:is )?upper[- ]division\b/.test(
            t
        )
    )
        facts.upperDivisionCounted = { value: 0, at };
    const target = /\bgraduat|\bfinish\b|\bdone by\b/.test(t) ? parseTerm(t) : null;
    if (target) facts.targetGraduation = { value: termName(target), at };
    return {
        facts,
        authoritative:
            /\b(?:source of truth|use what i(?:'m| am) telling you|trust me|i(?:'m| am) right|go by what i (?:say|said))\b/.test(
                t
            ),
    };
}

/** Newer statements replace older ones field by field; nothing else is forgotten. */
export function mergeFacts(previous: ConfirmedFacts, update: ConfirmedFacts): ConfirmedFacts {
    return { ...previous, ...update };
}

export const hasFacts = (f: ConfirmedFacts) => Object.keys(f).length > 0;
