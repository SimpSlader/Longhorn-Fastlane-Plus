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
    if (/\bmw\b|\bm\s*\/\s*w\b/.test(fragment)) found.push('M', 'W');
    if (/\btth\b|\btt\b|\bt\s*\/\s*th\b|\btu\s*\/\s*th\b/.test(fragment)) found.push('T', 'TH');
    return [...new Set(found)];
}

const WEEK: DayCode[] = ['M', 'T', 'W', 'TH', 'F', 'S', 'SU'];

/**
 * Days the student limits classes to: "classes only on Tuesdays and Thursdays", "Tuesdays and Thursdays only",
 * "only T/Th", "TTh only". Returns null when the message sets no such limit.
 */
export function requestedOnlyDays(request: string): DayCode[] | null {
    const text = request.toLowerCase();
    const patterns = [
        /\bonly\s+(?:on\s+|have\s+|take\s+|want\s+)?((?:(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|mon|tues?|wed|thu(?:rs)?|fri|mwf|tth|t\/th|m\/w\/f|m\/w|mw|and|or|&|,|\/|\s)+))/,
        /\b((?:(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|mwf|tth|t\/th|m\/w\/f|mw|and|or|&|,|\/|\s)+))\s+only\b/,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        const days = m ? daysIn(m[1] ?? '') : [];
        if (days.length) return days;
    }
    return null;
}

/** Only exclusion wording counts: mentioning Tuesday alone does not mean avoid Tuesday. */
export function requestedDaysOff(request: string): DayCode[] {
    const text = request.toLowerCase();
    const out = new Set<DayCode>();
    const only = requestedOnlyDays(request);
    if (only) for (const d of WEEK) if (!only.includes(d)) out.add(d);
    const re =
        /(?:no\s+class(?:es)?(?:\s+on)?|avoid(?:ing)?|not\s+on|free\s+on|nothing\s+on|off\s+on|without)\s*([^.;!?]{1,110})/g;
    for (let m = re.exec(text); m; m = re.exec(text)) for (const d of daysIn(m[1] ?? '')) out.add(d);
    // "no MWF", "no Fridays"
    const bare =
        /\bno\s+((?:mwf|m\/w\/f|mw|tth|t\/th|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|mon|tues?|wed|thu(?:rs)?|fri|and|or|&|\/|\s)+)/g;
    for (let m = bare.exec(text); m; m = bare.exec(text)) for (const d of daysIn(m[1] ?? '')) out.add(d);
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
    /** requested credit hours, e.g. "12–13 credit hours"; null = default 12–15 (never fewer than 12) */
    credits: { min: number; max: number; floor?: boolean } | null;
    /** subject codes the student excluded ("no history classes" → HIS, plus subjects named History) */
    excludedSubjects: string[];
    /** words that exclude courses by title ("no history classes" also leaves out courses titled History) */
    excludedTitleWords: string[];
    /** "back to back", "no gaps": cluster classes with little time between them */
    backToBack: boolean;
    /** "core complete": unfinished Core Curriculum requirements come first */
    coreFocus: boolean;
    /** the student plans some courses at ACC without naming them (never counted as credit) */
    accPlanned: boolean;
    /** "recommend some harder classes to take through ACC": suggest ACC courses from UT's TCCN table */
    accSuggest: boolean;
}

export const EMPTY_PREFERENCES: PlanningPreferences = {
    avoidDays: [],
    asyncCount: null,
    preferAsync: false,
    easyGrades: false,
    timeOfDay: 'any',
    plannedElsewhere: [],
    excludedCourses: [],
    credits: null,
    excludedSubjects: [],
    excludedTitleWords: [],
    backToBack: false,
    coreFocus: false,
    accPlanned: false,
    accSuggest: false,
};

/** Credit-hour range in a message: "12–13 credit hours", "12 to 15 hours", "15 credits", "at least 12 credits". */
export function requestedCredits(message: string): { min: number; max: number; floor?: boolean } | null {
    const t = message.toLowerCase();
    const range = t.match(
        /\b(?:(minimum of|minimum|min(?:imum)? of|at least|no less than)\s+)?(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*(?:credit|credits|credit hours|hours|hrs|sch)\b/
    );
    if (range) {
        const a = Number(range[2]);
        const b = Number(range[3]);
        // "a minimum of 12–13 credits" sets a floor, not a ceiling: more is fine up to the usual maximum
        if (range[1]) return { min: Math.min(a, b), max: Math.max(a, b, 16), floor: true };
        return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    const atLeast = t.match(
        /\b(?:at least|minimum of|min(?:imum)?|no less than)\s*(\d{1,2})\s*(?:credit|credits|credit hours|hours|hrs)\b/
    );
    if (atLeast) return { min: Number(atLeast[1]), max: Math.max(Number(atLeast[1]), 16), floor: true };
    const single = t.match(/\b(\d{1,2})\s*(?:credit|credits|credit hours|hours|hrs)\b/);
    // a lone small number ("3 hours") is about a class, not the semester load
    if (single && Number(single[1]) >= 6) return { min: Number(single[1]), max: Number(single[1]) };
    return null;
}

/** Subjects named in "no history classes", "remove history", "drop the econ class", "nothing in economics". */
export function requestedSubjectExclusions(
    message: string,
    subjects: Array<{ code: string; name: string }>
): { codes: string[]; words: string[] } {
    const t = ` ${message.toLowerCase().replace(/[.!?;]/g, ' . ')} `;
    const codes = new Set<string>();
    const words = new Set<string>();
    const subjectFor = (word: string) => {
        const byCode = subjects.find(s => s.code.toLowerCase() === word);
        if (byCode) return { codes: [byCode.code], word: '' };
        const clean = word.replace(/[^a-z ]/g, '').trim();
        if (clean.length < 3) return null;
        const named = subjects.filter(s => new RegExp(`\\b${clean}\\b`).test(s.name.toLowerCase()));
        return named.length ? { codes: named.map(s => s.code), word: clean } : null;
    };
    // the class noun is optional ("remove history"), so a phrase ends at punctuation or a joining word
    const re =
        /\b(?:no more|no|not|skip|avoid|without|exclude|nothing in|remove|drop|delete|take out|get rid of|don'?t want|do not want)\s+(?:any|the|my|all|those|that|these|this)?\s*([a-z][a-z ,&/-]{1,50}?)\s*(?:\b(?:classes|courses|class|course)\b|[.,]|\b(?:but|please|so|because|from|and keep|then|instead)\b|$)/g;
    for (let m = re.exec(t); m; m = re.exec(t)) {
        const phrase = (m[1] ?? '').trim();
        for (const part of phrase.split(/\s*(?:,|\/|\bor\b|\band\b|&)\s*/)) {
            const word = part.trim();
            if (word.length < 2) continue;
            // the whole phrase first ("computer science"), then its first word ("history stuff")
            const found = subjectFor(word) ?? subjectFor(word.split(' ')[0] ?? '');
            if (!found) continue;
            for (const c of found.codes) codes.add(c);
            if (found.word) words.add(found.word);
        }
    }
    return { codes: [...codes], words: [...words] };
}

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
    subjects: Set<string>,
    subjectNames: Array<{ code: string; name: string }> = []
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
    // "give me 1 more online class"
    const more = text.match(/\b(\d|one|two|an?)\s+more\s+(?:fully\s+)?(?:async(?:hronous)?|online)\b/);
    if (more) {
        const n = Number(more[1]) || NUMBER_WORDS[more[1] ?? ''] || 1;
        const base = asyncCount?.min ?? 0;
        asyncCount = { min: base + n, max: Math.max(asyncCount?.max ?? 0, base + n) };
    }

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
        /\b(?:not|skip|exclude|without|remove|drop|delete|take out|get rid of|already (?:took|taken|have)|don'?t (?:want|need))\s+([^.;!?]{1,80})/g;
    for (let m = exclude.exec(text); m; m = exclude.exec(text))
        for (const code of courseCodesIn(m[1] ?? '', subjects))
            if (!excludedCourses.includes(code) && !plannedElsewhere.some(p => p.code === code))
                excludedCourses.push(code);

    const exclusions = requestedSubjectExclusions(message, subjectNames);
    const allowedAgain =
        /\b([a-z]+) (?:classes |courses )?(?:are|is) (?:fine|ok(?:ay)?)\b/.exec(text) ??
        /\b(?:add|bring|put) ([a-z]+) (?:classes |courses )?back\b/.exec(text);
    const excludedSubjects = [...new Set([...previous.excludedSubjects, ...exclusions.codes])];
    const excludedTitleWords = [...new Set([...previous.excludedTitleWords, ...exclusions.words])];
    if (allowedAgain) {
        const word = allowedAgain[1] ?? '';
        const lifted = requestedSubjectExclusions(`no ${word} classes`, subjectNames);
        for (const c of lifted.codes)
            if (excludedSubjects.includes(c)) excludedSubjects.splice(excludedSubjects.indexOf(c), 1);
        for (const w of lifted.words)
            if (excludedTitleWords.includes(w)) excludedTitleWords.splice(excludedTitleWords.indexOf(w), 1);
    }
    return {
        credits: requestedCredits(message) ?? previous.credits,
        excludedSubjects: excludedSubjects.filter(Boolean),
        excludedTitleWords: excludedTitleWords.filter(Boolean),
        backToBack:
            previous.backToBack ||
            /\bback[- ]to[- ]back\b|\bno (?:awkward )?gaps\b|\bcompact\b|\bminimi[sz]e (?:the )?gaps\b|\bclustered\b/.test(
                text
            ),
        coreFocus:
            previous.coreFocus || /\bcore[- ]complete\b|\bcore (?:curriculum|requirements?|classes)\b/.test(text),
        accSuggest:
            previous.accSuggest ||
            (/\b(?:acc|austin community college|community college)\b/.test(text) &&
                /\b(?:recommend|suggest|which|what|harder|hard|get ahead|could take|should take|options?)\b/.test(
                    text
                )),
        accPlanned:
            previous.accPlanned ||
            /\b(?:through|at|via)\s+(?:acc|austin community college|a community college)\b/.test(text),
        avoidDays: [...avoid],
        asyncCount,
        preferAsync: (asyncCount?.min ?? 0) > 0 || (previous.preferAsync && asyncCount?.max !== 0),
        easyGrades:
            previous.easyGrades ||
            /\beasy\b|\beasier\b|\beasiest\b|\bhigh(?:est)? (?:grades?|gpa)\b|\bgood grades?\b|\bgenerous grad|\bhigh a\b|\bhigh (?:a|a's) (?:grades?|rates?)\b|\bprotect (?:my )?gpa\b|\blots of a'?s\b|\bmostly a'?s\b|\bmostly a['’]?s\b|\bhigh(?:est)? grades?\b|\bprioriti[sz]e (?:high )?grades?\b/.test(
                text
            ),
        timeOfDay,
        plannedElsewhere,
        excludedCourses,
    };
}

/** Preferences after a whole conversation (oldest message first). */
export function planningPreferences(
    messages: string[],
    subjects: Set<string>,
    subjectNames: Array<{ code: string; name: string }> = []
): PlanningPreferences {
    return messages.reduce(
        (prefs, message) => applyPlanningMessage(prefs, message, subjects, subjectNames),
        EMPTY_PREFERENCES
    );
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
    if (p.credits)
        out.push(
            p.credits.floor
                ? `At least ${p.credits.min} credit hours (more is fine if the classes are worth it)`
                : `${p.credits.min === p.credits.max ? p.credits.min : `${p.credits.min}–${p.credits.max}`} credit hours`
        );
    if (p.excludedSubjects.length)
        out.push(
            `No ${p.excludedTitleWords.length ? `${p.excludedTitleWords.join(', ')} classes (` : ''}${p.excludedSubjects.join(', ')}${p.excludedTitleWords.length ? ' and courses titled that way)' : ' classes'}`
        );
    if (p.coreFocus) out.push('Unfinished Core Curriculum requirements first');
    if (p.backToBack) out.push('Back-to-back classes with as few gaps as possible');
    if (p.accSuggest) out.push('Suggest harder classes to take at ACC (from UT’s official transfer table)');
    else if (p.accPlanned && !p.plannedElsewhere.length)
        out.push('Some classes planned at ACC (not counted as UT credit until it is awarded)');
    return out;
}
