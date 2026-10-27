/**
 * Graduation planning, done in code: the current term from the date, the fall/spring terms and the summers left
 * before a target graduation term, and the average UT load per long semester for different summer totals.
 * Averages are exact (one decimal), not rounded up per semester; the answer says they assume this semester's
 * classes are passed, and notes upper-division and residence hours still needed. No AI does this arithmetic.
 */
import type { AcademicModel } from './academicModel';

export type Season = 'Spring' | 'Summer' | 'Fall';
export interface Term {
    season: Season;
    year: number;
}

const ORDER: Record<Season, number> = { Spring: 0, Summer: 1, Fall: 2 };
const key = (t: Term) => t.year * 3 + ORDER[t.season];
export const termName = (t: Term) => `${t.season} ${t.year}`;

/** The term underway on a date: Jan–May spring, Jun–Aug summer, Sep–Dec fall. */
export function currentTerm(now = new Date()): Term {
    const m = now.getMonth() + 1;
    return { season: m <= 5 ? 'Spring' : m <= 8 ? 'Summer' : 'Fall', year: now.getFullYear() };
}

function next(t: Term): Term {
    if (t.season === 'Spring') return { season: 'Summer', year: t.year };
    if (t.season === 'Summer') return { season: 'Fall', year: t.year };
    return { season: 'Spring', year: t.year + 1 };
}

/** "Spring 2029", "spring '29", "May 2029", "fall 2028", "summer 2028"; a bare year means its spring. */
export function parseTerm(text: string): Term | null {
    const t = text.toLowerCase();
    const m = t.match(/\b(spring|fall|autumn|summer|may|december|dec|august|aug)\s*'?\s*(20\d\d|\d\d)\b/);
    if (m) {
        const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
        const word = m[1]!;
        const season: Season = /spring|may/.test(word) ? 'Spring' : /summer|aug/.test(word) ? 'Summer' : 'Fall';
        return { season, year };
    }
    const bare = t.match(/\b(?:graduat\w*|finish\w*|done|by|in)\b[^.?!]{0,30}?\b(20[2-4]\d)\b/);
    return bare ? { season: 'Spring', year: Number(bare[1]) } : null;
}

/** Terms after the current one, through the target: long semesters and summers listed separately. */
export function termsUntil(target: Term, now = new Date()): { long: Term[]; summers: Term[] } {
    const long: Term[] = [];
    const summers: Term[] = [];
    let t = next(currentTerm(now));
    for (let i = 0; i < 40 && key(t) <= key(target); i++) {
        if (t.season === 'Summer') summers.push(t);
        else long.push(t);
        t = next(t);
    }
    return { long, summers };
}

export interface GraduationPlan {
    current: Term;
    target: Term;
    longTerms: Term[];
    summers: Term[];
    remaining: number;
    /** summer hours (total across the summers available) → average UT hours per long semester */
    scenarios: Array<{ summerHours: number; perSemester: number }>;
    notes: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function graduationPlan(
    model: AcademicModel,
    target: Term,
    opts: { now?: Date; summerHours?: number[] } = {}
): GraduationPlan | { missing: string } {
    const now = opts.now ?? new Date();
    const remaining = model.degreeCreditsRemainingProjected.value;
    if (remaining == null)
        return {
            missing:
                'I don’t have your degree total and the credits counted toward it, so I can’t do this math without guessing. Tell me (for example “120 total, 22 counted including this semester”) or import your IDA.',
        };
    const { long, summers } = termsUntil(target, now);
    if (!long.length)
        return { missing: `${termName(target)} isn’t after the current term (${termName(currentTerm(now))}).` };
    const options = (opts.summerHours ?? [0, 6, 12, 18, 24]).filter(h => h === 0 || summers.length > 0);
    const scenarios = options.map(summerHours => ({
        summerHours,
        perSemester: round1(Math.max(0, remaining - summerHours) / long.length),
    }));
    const notes: string[] = [];
    const heaviest = scenarios[0]!.perSemester;
    if (heaviest > 17)
        notes.push(
            `Without summers that's about ${heaviest} credits a semester, a heavy load; check your college's maximum course load before planning above 17.`
        );
    const ud = model.upperDivisionRequired.value;
    const udDone = model.upperDivisionCounted.value;
    if (ud != null && udDone != null && ud > udDone)
        notes.push(
            `${ud - udDone} of those hours must be upper-division (${udDone} of ${ud} counted so far), which ACC courses (lower-division) can't cover.`
        );
    const res = model.utResidentRequired.value;
    const resDone = model.utResidentCounted.value;
    if (res != null && resDone != null && res > resDone)
        notes.push(
            `You still need ${res - resDone} hours in residence at UT (${resDone} of ${res} counted), so most remaining hours should be UT courses.`
        );
    if (summers.length) notes.push(`Summers before then: ${summers.map(termName).join(' and ')}.`);
    return { current: currentTerm(now), target, longTerms: long, summers, remaining, scenarios, notes };
}

/** The answer in plain words, with a small table; numbers come only from the plan. */
export function graduationAnswer(plan: GraduationPlan, model: AcademicModel): string {
    const projected = model.degreeCreditsProjected.value;
    const total = model.degreeTotalRequired.value;
    const lead =
        projected != null && total != null
            ? `With ${projected} of your ${total} credits counted after ${termName(plan.current)}, you have **${plan.remaining} left**`
            : `You have **${plan.remaining} credits left**`;
    const rows = plan.scenarios.map(
        s =>
            `| ${s.summerHours === 0 ? 'No summer classes' : `${s.summerHours} summer credits`} | ${plan.remaining - s.summerHours} | **${s.perSemester}** |`
    );
    return [
        `${lead} over **${plan.longTerms.length} fall/spring semesters** (${plan.longTerms.map(termName).join(', ')}) to graduate in ${termName(plan.target)}.`,
        ['| Plan | Credits for fall/spring | Average per semester |', '|---|---|---|', ...rows].join('\n'),
        ...plan.notes,
        '_These assume you pass this semester’s classes. Averages aren’t a schedule: real semesters come in whole courses, and prerequisites and course offerings decide what fits where._',
    ].join('\n\n');
}
