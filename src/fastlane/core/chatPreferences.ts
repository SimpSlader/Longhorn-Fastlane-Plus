/**
 * Reads scheduling preferences from the student's own planning messages, so the AI step and the local
 * candidate filters agree. Preferences carry over between follow-up messages; a later message can lift an
 * earlier one ("Fridays are fine"). Courses the student plans to take elsewhere (e.g. at ACC) are only left out
 * of suggestions — they are never treated as earned or transferred UT credit.
 */
import type { DayCode } from './meetings';

const DAYS: Array<[DayCode, RegExp]> = [
    ['M', /\bmondays?\b|\bmon\b/],
    ['T', /\btuesdays?\b|\btues?\b/],
    ['W', /\bwednesdays?\b|\bwed\b/],
    ['TH', /\bthursdays?\b|\bthu(?:rs)?\b/],
    ['F', /\bfridays?\b|\bfri\b/],
    ['S', /\bsaturdays?\b|\bsat\b/],
    ['SU', /\bsundays?\b|\bsun\b/],
];

/** Course nicknames students commonly use; anything else must be written as a course code. */
const NICKNAMES: Array<[RegExp, string]> = [
    [/\bmacro(?:economics)?\b/, 'ECO 304L'],
    [/\bmicro(?:economics)?\b/, 'ECO 304K'],
];

function daysIn(fragment: string): DayCode[] {
    const found = DAYS.filter(([, pattern]) => pattern.test(fragment)).map(([day]) => day);
    if (/\bmwf\b|\bm\s*\/\s*w\s*\/\s*f\b/.test(fragment)) found.push('M', 'W', 'F');
    if (/\btth\b|\bt\s*\/\s*th\b/.test(fragment)) found.push('T', 'TH');
    return [...new Set(found)];
}

/** Only exclusion wording counts: mentioning Tuesday alone does not mean avoid Tuesday. */
export function requestedDaysOff(request: string): DayCode[] {
    const text = request.toLowerCase();
    const out = new Set<DayCode>();
    const re =
        /(?:no\s+class(?:es)?(?:\s+on)?|avoid(?:ing)?|not\s+on|free\s+on|nothing\s+on|off\s+on|without)\s*([^.;!?]{1,110})/g;
    for (let m = re.exec(text); m; m = re.exec(text)) for (const d of daysIn(m[1] ?? '')) out.add(d);
    return [...out];
}

/** Days the student says are acceptable again ("Fridays are fine", "I can do Monday"). */
export function requestedDaysAllowed(request: string): DayCode[] {
    const text = request.toLowerCase();
    const out = new Set<DayCode>();
    const re =
        /([^.;!?]{1,60}?)\s+(?:is|are)\s+(?:fine|ok(?:ay)?|good)|(?:can do|okay with|ok with|fine with)\s+([^.;!?]{1,60})/g;
    for (let m = re.exec(text); m; m = re.exec(text)) for (const d of daysIn(m[1] ?? m[2] ?? '')) out.add(d);
    return [...out];
}

export interface PlanningPreferences {
    avoidDays: DayCode[];
    /** wanted number of fully asynchronous online classes, if stated */
    asyncCount: { min: number; max: number } | null;
    preferAsync: boolean;
    /** "easy professors", "easy A": rank by historical grade rate (never a promise) */
    easyGrades: boolean;
    timeOfDay: 'any' | 'morning' | 'afternoon' | 'evening';
    /** courses to leave out because the student plans to take them elsewhere (not credit) */
    plannedElsewhere: Array<{ code: string; where: string }>;
    /** courses the student asked not to see */
    excludedCourses: string[];
}

export const EMPTY_PREFERENCES: PlanningPreferences = {
    avoidDays: [],
    asyncCount: null,
    preferAsync: false,
    easyGrades: false,
    timeOfDay: 'any',
    plannedElsewhere: [],
    excludedCourses: [],
};

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, a: 1, an: 1 };

/** Course codes in free text, limited to real subject codes ("eco 304l" → "ECO 304L"). */
export function courseCodesIn(text: string, subjects: Set<string>): string[] {
    const out: string[] = [];
    const upper = ` ${text.toUpperCase()} `;
    const re = /\b([A-Z](?: ?[A-Z]){0,2})\s?(\d{3}[A-Z]{0,2})\b/g;
    for (let m = re.exec(upper); m; m = re.exec(upper)) {
        const subject = (m[1] ?? '').trim();
        const squeezed = subject.replace(/\s+/g, '');
        const code = subjects.has(subject) ? subject : [...subjects].find(s => s.replace(/\s+/g, '') === squeezed);
        if (code) out.push(`${code} ${m[2]}`);
    }
    const lower = text.toLowerCase();
    for (const [pattern, code] of NICKNAMES) if (pattern.test(lower)) out.push(code);
    return [...new Set(out)];
}

/** Preferences from one message, applied on top of the earlier conversation. */
export function applyPlanningMessage(
    previous: PlanningPreferences,
    message: string,
    subjects: Set<string>
): PlanningPreferences {
    const text = message.toLowerCase();
    const allowed = requestedDaysAllowed(message);
    const avoid = new Set([...previous.avoidDays.filter(d => !allowed.includes(d)), ...requestedDaysOff(message)]);
    for (const d of allowed) avoid.delete(d);

    let asyncCount = previous.asyncCount;
    const count = text.match(
        /\b(\d|one|two|three|four|an?)(?:\s*(?:-|–|to|or)\s*(\d|one|two|three|four))?\s+(?:fully\s+)?(?:async(?:hronous)?|online)\b/
    );
    if (count) {
        const lo = Number(count[1]) || NUMBER_WORDS[count[1] ?? ''] || 1;
        const hi = count[2] ? Number(count[2]) || NUMBER_WORDS[count[2]] || lo : lo;
        asyncCount = { min: Math.min(lo, hi), max: Math.max(lo, hi) };
    }
    if (/\bno\s+(?:async(?:hronous)?|online)\b|\bin[- ]person only\b/.test(text)) asyncCount = { min: 0, max: 0 };

    const wants = (period: string) => new RegExp(`\\b(?:only|prefer|like|want)\\b[^.]*\\b${period}s?\\b`).test(text);
    const timeOfDay = wants('morning')
        ? 'morning'
        : wants('afternoon')
          ? 'afternoon'
          : wants('evening')
            ? 'evening'
            : previous.timeOfDay;

    // "I'm planning to take Macro through ACC", "taking ECO 304L at Austin Community College"
    const plannedElsewhere = [...previous.plannedElsewhere];
    const elsewhere =
        /([^.;!?]*?)\b(?:through|at|via|from)\s+(acc|austin community college|a community college|another (?:school|college))\b/g;
    for (let m = elsewhere.exec(text); m; m = elsewhere.exec(text)) {
        const where = /community|acc/.test(m[2] ?? '') ? 'ACC' : 'another school';
        for (const code of courseCodesIn(m[1] ?? '', subjects))
            if (!plannedElsewhere.some(p => p.code === code)) plannedElsewhere.push({ code, where });
    }
    // "not ECO 304L", "skip HIS 315K", "already took GOV 310L", "exclude …"
    const excludedCourses = [...previous.excludedCourses];
    const exclude =
        /\b(?:not|skip|exclude|without|already (?:took|taken|have)|don'?t (?:want|need))\s+([^.;!?]{1,80})/g;
    for (let m = exclude.exec(text); m; m = exclude.exec(text))
        for (const code of courseCodesIn(m[1] ?? '', subjects))
            if (!excludedCourses.includes(code) && !plannedElsewhere.some(p => p.code === code))
                excludedCourses.push(code);

    return {
        avoidDays: [...avoid],
        asyncCount,
        preferAsync: (asyncCount?.min ?? 0) > 0 || (previous.preferAsync && asyncCount?.max !== 0),
        easyGrades:
            previous.easyGrades ||
            /\beasy\b|\beasiest\b|\bhigh(?:est)? (?:grades?|gpa)\b|\bgood grades?\b|\bgenerous grad/.test(text),
        timeOfDay,
        plannedElsewhere,
        excludedCourses,
    };
}

/** Preferences after a whole conversation (oldest message first). */
export function planningPreferences(messages: string[], subjects: Set<string>): PlanningPreferences {
    return messages.reduce((prefs, message) => applyPlanningMessage(prefs, message, subjects), EMPTY_PREFERENCES);
}

/** Plain-language summary of what Fastlane understood, shown before the student sends. */
export function describePreferences(p: PlanningPreferences, dayNames: Record<DayCode, string>): string[] {
    const out: string[] = [];
    if (p.avoidDays.length) out.push(`No classes on ${p.avoidDays.map(d => dayNames[d]).join(', ')}`);
    if (p.asyncCount)
        out.push(
            p.asyncCount.max === 0
                ? 'No online-only classes'
                : `${p.asyncCount.min === p.asyncCount.max ? p.asyncCount.min : `${p.asyncCount.min}–${p.asyncCount.max}`} asynchronous online ${p.asyncCount.max === 1 ? 'class' : 'classes'}`
        );
    else if (p.preferAsync) out.push('Prefers asynchronous online classes');
    if (p.easyGrades) out.push('Prefers historically generous grading (based on past grades, not a guarantee)');
    if (p.timeOfDay !== 'any') out.push(`${p.timeOfDay[0]?.toUpperCase()}${p.timeOfDay.slice(1)} classes`);
    for (const c of p.plannedElsewhere)
        out.push(
            `Leaving out ${c.code}: you plan to take it at ${c.where} (not counted as UT credit until it is awarded)`
        );
    if (p.excludedCourses.length) out.push(`Leaving out ${p.excludedCourses.join(', ')}`);
    return out;
}
