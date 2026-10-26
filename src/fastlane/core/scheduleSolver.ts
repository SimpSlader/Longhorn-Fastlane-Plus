/**
 * Constraint-based schedule builder for Fastlane's AI planner.
 *
 * The AI may interpret preferences and rank useful courses, but this code decides what a schedule is:
 *  - Hard constraints are never traded away: at least 12 UT credits and the student's credit range, only the
 *    allowed meeting days (asynchronous online classes have no meetings and always fit), excluded subjects and
 *    courses, no time conflicts or duplicate courses, one semester, real listed sections only, and no section
 *    whose printed prerequisite is clearly missing.
 *  - Among valid schedules it optimizes, in order of weight: verified degree requirements, historical A rates
 *    (shrunk toward an average when the sample is small), the requested number of online classes, compactness
 *    (few gaps, strongly when the student asked for back-to-back classes), and keeping classes from the current
 *    proposal when refining.
 *  - The search is a bounded depth-first branch and bound that yields to the browser, so Chrome never freezes.
 *  - When no schedule satisfies every hard constraint, it says exactly why and what to change instead of
 *    returning something invalid.
 */
import type { DayCode, Meeting } from './meetings';
import { normalizeCourseCode } from './requirements';
import { type SectionRecord, semesterKey, subjectOf } from './sections';

export const MIN_CREDITS = 12;
export const DEFAULT_MAX_CREDITS = 16;
/** credits above this get a small penalty when the student set no range (default target 12–15) */
const DEFAULT_TARGET_MAX = 15;

export interface ScheduleConstraints {
    minCredits: number;
    maxCredits: number;
    /** true when the student gave the range (then any credit total inside it is equally good) */
    creditsRequested: boolean;
    /** no scheduled meetings on these days */
    avoidDays: DayCode[];
    excludedSubjects: string[];
    excludedTitleWords: string[];
    /** normalized course codes */
    excludedCourses: string[];
    /** "Spring 2027"; empty = any (but one semester per schedule) */
    term: string;
    /** wanted number of fully asynchronous online classes (a preference, not a hard rule) */
    online: { min: number; max: number } | null;
    backToBack: boolean;
    /** latest start / earliest end limits from "morning only" style preferences (hard), minutes */
    timeWindow?: { from: number; to: number } | null;
    /** one day allowed only part of the time ("Friday mornings are fine"), minutes */
    dayLimits?: Partial<Record<DayCode, { from?: number; to?: number }>>;
}

export interface SolverCandidate {
    section: SectionRecord;
    /** desirability of the section on its own (degree fit, grades, AI pick…) */
    score: number;
    /** IDA requirement tags this section is verified to match */
    applies: string[];
    prerequisite: 'met' | 'unmet' | 'check' | 'none';
}

export type HardReason =
    | 'cancelled'
    | 'not-plannable'
    | 'semester'
    | 'excluded-subject'
    | 'excluded-title'
    | 'excluded-course'
    | 'day'
    | 'time-window'
    | 'times-unknown'
    | 'no-credit'
    | 'graduate'
    | 'prerequisite';

const DAY_WORD: Record<DayCode, string> = {
    M: 'Monday',
    T: 'Tuesday',
    W: 'Wednesday',
    TH: 'Thursday',
    F: 'Friday',
    S: 'Saturday',
    SU: 'Sunday',
};

export const isAsync = (s: SectionRecord) => s.modality === 'async-online' && s.meetings.length === 0;

/** UT course numbers: the last two digits 80–99 are graduate courses, 20–79 upper division. */
function courseLevel(courseCode: string): 'lower' | 'upper' | 'graduate' {
    const digits = Number(courseCode.match(/(\d)(\d\d)[A-Z]*$/)?.[2] ?? 0);
    return digits >= 80 ? 'graduate' : digits >= 20 ? 'upper' : 'lower';
}
export const isUpperDivision = (courseCode: string) => courseLevel(courseCode) === 'upper';

const titleHas = (title: string, word: string) => new RegExp(`\\b${word.replace(/[^a-z ]/gi, '')}\\b`, 'i').test(title);

/** The first hard rule a section breaks on its own, or null when it may appear in a schedule. */
export function hardReason(
    s: SectionRecord,
    c: ScheduleConstraints,
    prerequisite: SolverCandidate['prerequisite'] = 'none'
): HardReason | null {
    if (s.status?.value === 'CANCELLED') return 'cancelled';
    if (!s.course) return 'not-plannable';
    if (c.term && semesterKey(s.semester) !== c.term) return 'semester';
    if (s.creditHours <= 0) return 'no-credit';
    // an undergraduate plan never includes graduate courses
    if (courseLevel(s.courseCode) === 'graduate') return 'graduate';
    if (c.excludedSubjects.includes(subjectOf(s.courseCode))) return 'excluded-subject';
    if (c.excludedTitleWords.some(w => titleHas(s.title, w))) return 'excluded-title';
    if (c.excludedCourses.includes(normalizeCourseCode(s.courseCode))) return 'excluded-course';
    if (!isAsync(s)) {
        // anything that is not fully asynchronous must have known meeting times to be checked at all
        if (!s.meetings.length) return 'times-unknown';
        if (s.meetings.some(m => m.days.some(d => c.avoidDays.includes(d)))) return 'day';
        if (c.timeWindow && s.meetings.some(m => m.start < c.timeWindow!.from || m.end > c.timeWindow!.to))
            return 'time-window';
        const limits = c.dayLimits ?? {};
        if (
            s.meetings.some(m =>
                m.days.some(d => {
                    const l = limits[d];
                    return !!l && ((l.to != null && m.end > l.to) || (l.from != null && m.start < l.from));
                })
            )
        )
            return 'time-window';
    }
    if (prerequisite === 'unmet') return 'prerequisite';
    return null;
}

function overlap(a: Meeting, b: Meeting): boolean {
    return a.days.some(d => b.days.includes(d)) && a.start < b.end && b.start < a.end;
}

function clash(s: SectionRecord, chosen: SectionRecord[]): boolean {
    return chosen.some(o => o.meetings.some(m => s.meetings.some(n => overlap(m, n))));
}

/** Minutes of waiting between consecutive classes on the same day (a 15-minute passing period is free). */
export function gapMinutes(sections: SectionRecord[]): number {
    let total = 0;
    const byDay = new Map<DayCode, Array<[number, number]>>();
    for (const s of sections)
        for (const m of s.meetings)
            for (const d of m.days) {
                const list = byDay.get(d) ?? [];
                list.push([m.start, m.end]);
                byDay.set(d, list);
            }
    for (const list of byDay.values()) {
        list.sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < list.length; i++) {
            const gap = list[i]![0] - list[i - 1]![1];
            if (gap > 15) total += gap - 15;
        }
    }
    return total;
}

/** Score of a whole schedule beyond its sections: gaps, online count, credit target, stability. */
function scheduleBonus(
    sections: SectionRecord[],
    c: ScheduleConstraints,
    stable?: Set<number>,
    stableWeight = 4
): number {
    const credits = sections.reduce((n, s) => n + s.creditHours, 0);
    const asyncCount = sections.filter(isAsync).length;
    let bonus = -(gapMinutes(sections) / 60) * (c.backToBack ? 3 : 0.6);
    if (c.online) {
        const miss = asyncCount < c.online.min ? c.online.min - asyncCount : Math.max(0, asyncCount - c.online.max);
        // "preferably 1–2 online" is a strong preference: each class outside it costs more than a great grade earns
        bonus += miss === 0 ? 2 : -8 * miss;
    }
    if (!c.creditsRequested && credits > DEFAULT_TARGET_MAX) bonus -= 1.5;
    // a real semester is a few substantial classes, not many one-credit fillers
    bonus -= Math.max(0, sections.length - 4) * 1.5;
    if (stable) bonus += sections.filter(s => stable.has(s.uniqueId)).length * stableWeight;
    return bonus;
}

/** Desirability of one section on its own. Grades are shrunk toward 65% when the sample is small. */
export function scoreSection(input: {
    applies: string[];
    coreFocus: boolean;
    gradePercent: number | null;
    gradeSample: number;
    easyGrades: boolean;
    aiPicked: boolean;
    /** AI thinks it may count toward a Core requirement (unverified: a small nudge only) */
    possibleCore?: boolean;
    creditHours?: number;
    courseCode?: string;
    prerequisite?: SolverCandidate['prerequisite'];
}): number {
    let score = 0;
    const verified = input.applies.length > 0;
    // fillers and unverified upper-division courses rarely move a degree forward
    if ((input.creditHours ?? 3) < 3 && !verified) score -= 3;
    if (input.courseCode && isUpperDivision(input.courseCode) && !verified) score -= 2;
    if (input.prerequisite === 'check') score -= 1.5;
    const core = input.applies.some(t => /^core\b/i.test(t));
    if (input.applies.length) score += input.coreFocus ? (core ? 7 : 2.5) : 4.5;
    const n = Math.max(0, input.gradeSample);
    const shrunk = input.gradePercent == null ? 60 : (input.gradePercent * n + 65 * 20) / (n + 20);
    score += (shrunk - 50) * (input.easyGrades ? 0.14 : 0.03);
    if (input.aiPicked) score += 1.5;
    if (input.coreFocus && !core && input.possibleCore) score += 1.5;
    return score;
}

export interface SchedulePlan {
    sections: SectionRecord[];
    credits: number;
    score: number;
    gapMinutes: number;
    asyncCount: number;
}

export interface ScheduleValidation {
    ok: boolean;
    /** hard-constraint failures: a schedule with any of these is never presented as valid */
    errors: string[];
    /** soft issues to show next to a valid schedule */
    warnings: string[];
    credits: number;
    asyncCount: number;
    gapMinutes: number;
}

/** Checks a finished schedule against every rule. Used for solver output, manual edits and refinements. */
export function validateSchedule(
    sections: SectionRecord[],
    c: ScheduleConstraints,
    facts: Map<number, Pick<SolverCandidate, 'applies' | 'prerequisite'>> = new Map()
): ScheduleValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const credits = sections.reduce((n, s) => n + s.creditHours, 0);
    const asyncCount = sections.filter(isAsync).length;
    if (credits < c.minCredits)
        errors.push(`${credits} credits is below the ${c.minCredits}-credit minimum for this plan.`);
    if (credits > c.maxCredits) errors.push(`${credits} credits is above your ${c.maxCredits}-credit maximum.`);
    const terms = new Set(sections.map(s => semesterKey(s.semester)));
    if (terms.size > 1) errors.push(`Classes from more than one semester: ${[...terms].join(', ')}.`);
    const seen = new Set<string>();
    for (const [i, s] of sections.entries()) {
        const label = `${s.courseCode} (${String(s.uniqueId).padStart(5, '0')})`;
        const reason = hardReason(s, { ...c, term: c.term }, facts.get(s.uniqueId)?.prerequisite);
        if (reason === 'day') {
            const bad = [...new Set(s.meetings.flatMap(m => m.days).filter(d => c.avoidDays.includes(d)))];
            errors.push(`${label} meets on ${bad.map(d => DAY_WORD[d]).join(' and ')}.`);
        } else if (reason === 'excluded-subject' || reason === 'excluded-title' || reason === 'excluded-course')
            errors.push(`${label} is a course you asked to leave out.`);
        else if (reason === 'times-unknown')
            errors.push(`${label} has no listed meeting times, so its days can't be checked.`);
        else if (reason === 'prerequisite')
            errors.push(`${label}'s printed prerequisite is not among your completed courses.`);
        else if (reason === 'time-window') errors.push(`${label} is outside your preferred class times.`);
        else if (reason === 'cancelled') errors.push(`${label} is cancelled.`);
        else if (reason === 'graduate') errors.push(`${label} is a graduate course.`);
        const code = normalizeCourseCode(s.courseCode);
        if (seen.has(code)) errors.push(`${s.courseCode} appears twice.`);
        seen.add(code);
        const other = sections.slice(0, i).find(o => clash(s, [o]));
        if (other) errors.push(`${label} overlaps ${other.courseCode}.`);
        if (facts.get(s.uniqueId)?.prerequisite === 'check')
            warnings.push(`Check ${s.courseCode}'s printed prerequisite yourself.`);
    }
    if (c.online) {
        if (asyncCount < c.online.min || asyncCount > c.online.max)
            warnings.push(
                `${asyncCount} asynchronous online class${asyncCount === 1 ? '' : 'es'} (you asked for ${c.online.min === c.online.max ? c.online.min : `${c.online.min}–${c.online.max}`}).`
            );
    }
    const unverified = sections.filter(s => !(facts.get(s.uniqueId)?.applies.length ?? 0));
    if (unverified.length)
        warnings.push(
            `${unverified.map(s => s.courseCode).join(', ')} ${unverified.length === 1 ? 'has' : 'have'} no verified IDA requirement match (possible elective).`
        );
    const gaps = gapMinutes(sections);
    if (c.backToBack && gaps > 30) warnings.push(`${Math.round(gaps)} minutes of gaps between classes in the week.`);
    return { ok: errors.length === 0, errors, warnings, credits, asyncCount, gapMinutes: gaps };
}

export interface ScheduleSuggestion {
    text: string;
    /** the settings change it proposes, applied when the student clicks it */
    patch: Partial<Pick<ScheduleConstraints, 'avoidDays' | 'maxCredits' | 'online' | 'excludedSubjects'>>;
}

export interface NoScheduleReport {
    reasons: string[];
    suggestions: ScheduleSuggestion[];
    /** most credits any valid (conflict-free, rule-following) combination reached */
    bestCredits: number;
}

export interface SolveResult {
    best: SchedulePlan | null;
    alternatives: SchedulePlan[];
    report: NoScheduleReport | null;
    explored: number;
}

export class SolveCancelled extends Error {
    constructor() {
        super('Cancelled');
        this.name = 'SolveCancelled';
    }
}

const pause = () => new Promise<void>(ok => setTimeout(ok, 0));

/**
 * Finds the best valid schedules. `fixed` sections are always kept (refinement); `stable` sections get a bonus
 * so a re-plan changes as little as possible; `allowNew` limits which sections may newly join (e.g. "an earlier
 * class" when replacing one).
 */
export async function solveSchedule(
    candidates: SolverCandidate[],
    c: ScheduleConstraints,
    options: {
        fixed?: SectionRecord[];
        stable?: Set<number>;
        allowNew?: (s: SectionRecord) => boolean;
        signal?: AbortSignal;
        /** how strongly to keep `stable` classes (lower lets "make it easier" swap more) */
        stableWeight?: number;
        maxNodes?: number;
        keep?: number;
        /** counts of sections removed by each hard rule over the whole catalog, for the explanation */
        removedBy?: Partial<Record<HardReason, number>>;
    } = {}
): Promise<SolveResult> {
    const fixed = options.fixed ?? [];
    const stableWeight = options.stableWeight ?? 4;
    const keep = options.keep ?? 3;
    const maxNodes = options.maxNodes ?? 150_000;
    const fixedCodes = new Set(fixed.map(s => normalizeCourseCode(s.courseCode)));
    const fixedIds = new Set(fixed.map(s => s.uniqueId));
    const term = c.term || (fixed[0] ? semesterKey(fixed[0].semester) : '');
    const pool = candidates
        .filter(x => !fixedIds.has(x.section.uniqueId) && !fixedCodes.has(normalizeCourseCode(x.section.courseCode)))
        .filter(x => !hardReason(x.section, { ...c, term }, x.prerequisite))
        .filter(x => !options.allowNew || options.stable?.has(x.section.uniqueId) || options.allowNew(x.section))
        .filter(x => !clash(x.section, fixed))
        // classes already in the proposal are tried first, so a re-plan changes as little as possible
        .sort(
            (a, b) =>
                b.score +
                (options.stable?.has(b.section.uniqueId) ? stableWeight : 0) -
                (a.score + (options.stable?.has(a.section.uniqueId) ? stableWeight : 0))
        );

    const fixedCredits = fixed.reduce((n, s) => n + s.creditHours, 0);
    const fixedScore = fixed.reduce(
        (n, s) => n + (candidates.find(x => x.section.uniqueId === s.uniqueId)?.score ?? 0),
        0
    );
    const best: SchedulePlan[] = [];
    let bestCredits = fixedCredits;
    let explored = 0;
    const chosen: SolverCandidate[] = [];
    const codes = new Set<string>();
    // optimistic bonus a schedule can still earn (online match + stability are already in scores/bonus)
    const BONUS_MAX = 2 + (options.stable ? stableWeight * options.stable.size : 0);

    const record = () => {
        const sections = [...fixed, ...chosen.map(x => x.section)];
        const score =
            fixedScore +
            chosen.reduce((n, x) => n + x.score, 0) +
            scheduleBonus(sections, c, options.stable, stableWeight);
        const key = sections
            .map(s => s.uniqueId)
            .sort()
            .join(',');
        if (
            best.some(
                p =>
                    p.sections
                        .map(s => s.uniqueId)
                        .sort()
                        .join(',') === key
            )
        )
            return;
        best.push({
            sections,
            credits: sections.reduce((n, s) => n + s.creditHours, 0),
            score,
            gapMinutes: gapMinutes(sections),
            asyncCount: sections.filter(isAsync).length,
        });
        best.sort((a, b) => b.score - a.score);
        if (best.length > keep) best.length = keep;
    };

    const maxPerClass = Math.max(1, ...pool.map(x => x.score));
    const minCreditsPerClass = Math.max(1, Math.min(...pool.map(x => x.section.creditHours), 3));

    const dfs = async (start: number, credits: number, sum: number): Promise<void> => {
        if (++explored % 2000 === 0) {
            if (options.signal?.aborted) throw new SolveCancelled();
            await pause();
        }
        if (explored > maxNodes) return;
        if (credits >= c.minCredits && credits <= c.maxCredits) record();
        if (credits >= c.maxCredits || chosen.length >= 7) return;
        const slots = Math.floor((c.maxCredits - credits) / minCreditsPerClass);
        if (best.length >= keep && sum + fixedScore + slots * maxPerClass + BONUS_MAX <= best.at(-1)!.score) return;
        for (let i = start; i < pool.length; i++) {
            const x = pool[i]!;
            const s = x.section;
            if (credits + s.creditHours > c.maxCredits) continue;
            const code = normalizeCourseCode(s.courseCode);
            if (codes.has(code)) continue;
            if (term && semesterKey(s.semester) !== term) continue;
            if (
                clash(
                    s,
                    chosen.map(y => y.section)
                )
            )
                continue;
            chosen.push(x);
            codes.add(code);
            const next = credits + s.creditHours;
            if (next <= c.maxCredits) bestCredits = Math.max(bestCredits, next);
            await dfs(i + 1, next, sum + x.score);
            chosen.pop();
            codes.delete(code);
            if (explored > maxNodes) return;
        }
    };
    await dfs(0, fixedCredits, 0);

    if (best.length) return { best: best[0]!, alternatives: best.slice(1), report: null, explored };
    return { best: null, alternatives: [], report: explain(pool, c, bestCredits, options.removedBy ?? {}), explored };
}

function explain(
    pool: SolverCandidate[],
    c: ScheduleConstraints,
    bestCredits: number,
    removedBy: Partial<Record<HardReason, number>>
): NoScheduleReport {
    const reasons: string[] = [];
    const suggestions: ScheduleSuggestion[] = [];
    const distinctCredits = [...new Map(pool.map(x => [normalizeCourseCode(x.section.courseCode), x])).values()].reduce(
        (n, x) => n + x.section.creditHours,
        0
    );
    const range = c.minCredits === c.maxCredits ? `${c.minCredits}` : `${c.minCredits}–${c.maxCredits}`;
    if (distinctCredits < c.minCredits)
        reasons.push(
            `Only ${distinctCredits} credits of different courses fit all of your rules, short of ${c.minCredits}.`
        );
    else
        reasons.push(
            `The most credits that fit all of your rules without time conflicts is ${bestCredits}, short of ${range}.`
        );
    if (c.avoidDays.some(d => ['M', 'T', 'W', 'TH', 'F'].includes(d))) {
        const allowed = (['M', 'T', 'W', 'TH', 'F'] as DayCode[]).filter(d => !c.avoidDays.includes(d));
        if (removedBy.day)
            reasons.push(
                `${removedBy.day.toLocaleString()} matching sections meet on days you ruled out (only ${allowed.map(d => DAY_WORD[d]).join(' and ') || 'no weekdays'} allowed).`
            );
        const extra = (['W', 'M', 'F', 'T', 'TH'] as DayCode[]).find(d => c.avoidDays.includes(d));
        if (extra)
            suggestions.push({
                text: `Allow classes on ${DAY_WORD[extra]}`,
                patch: { avoidDays: c.avoidDays.filter(d => d !== extra) },
            });
    }
    if (removedBy['excluded-subject'] || removedBy['excluded-title'])
        reasons.push(
            `${((removedBy['excluded-subject'] ?? 0) + (removedBy['excluded-title'] ?? 0)).toLocaleString()} sections are in subjects you excluded (${c.excludedSubjects.join(', ')}).`
        );
    if (removedBy.prerequisite)
        reasons.push(`${removedBy.prerequisite} sections have a printed prerequisite you have not taken.`);
    if (c.maxCredits < 15)
        suggestions.push({ text: `Widen the credit range to ${c.minCredits}–15`, patch: { maxCredits: 15 } });
    const onlineMax = c.online?.max ?? 0;
    suggestions.push({
        text:
            onlineMax === 0
                ? 'Allow asynchronous online classes (no meeting days)'
                : `Allow up to ${onlineMax + 1} asynchronous online classes`,
        patch: { online: { min: c.online?.min ?? 0, max: onlineMax + 1 } },
    });
    if (c.excludedSubjects.length)
        suggestions.push({
            text: `Allow ${c.excludedSubjects[0]} classes again`,
            patch: { excludedSubjects: c.excludedSubjects.slice(1) },
        });
    return { reasons, suggestions, bestCredits };
}

/** Counts how many catalog sections each hard rule removes (for explanations); cheap, one pass. */
export function hardFilterCounts(
    sections: SectionRecord[],
    c: ScheduleConstraints
): Partial<Record<HardReason, number>> {
    const out: Partial<Record<HardReason, number>> = {};
    for (const s of sections) {
        const r = hardReason(s, c);
        if (r) out[r] = (out[r] ?? 0) + 1;
    }
    return out;
}
