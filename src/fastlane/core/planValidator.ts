/**
 * The independent final check. It runs after optimization and before any schedule is shown or described, and it
 * does not trust the solver, the model or the text: every rule is re-derived from the sections themselves.
 *
 * Each check is "pass", "fail" or "unverified". A schedule with any "fail" is never presented as valid.
 * "All rules met" (`allRulesMet`) requires every check to pass — "unverified" (missing audit, stale data, an
 * unmapped building, a grade claim without counts) keeps it false. The UI renders this report; the model's
 * prose cannot change it.
 */
import { assignRequirements, fillableTags } from './requirementFit';
import { describeRequirement, normalizeCourseCode } from './requirements';
import type { ScheduleConstraints } from './scheduleSolver';
import { isAsync } from './scheduleSolver';
import { type SectionRecord, semesterKey, subjectOf } from './sections';
import { campusTravelMinutes, type TravelEstimator, transitions } from './travel';

export type CheckStatus = 'pass' | 'fail' | 'unverified';

export interface Check {
    id:
        | 'semester'
        | 'credits'
        | 'unique'
        | 'subject-count'
        | 'requirements'
        | 'redundant'
        | 'exclusions'
        | 'days'
        | 'overlap'
        | 'travel'
        | 'sections'
        | 'degree-audit'
        | 'freshness'
        | 'grade-claims';
    label: string;
    status: CheckStatus;
    detail: string;
}

export interface ValidationReport {
    checks: Check[];
    /** no check failed: the schedule may be shown as a schedule */
    hardOk: boolean;
    /** every check passed AND every needed record was verified: the only state that may say "All rules met" */
    allRulesMet: boolean;
    credits: number;
    failures: string[];
    unverified: string[];
}

/** A grade statistic that some caller wants to quote about a section. */
export interface GradeClaim {
    uniqueId: number;
    percent?: number | null;
    sample?: number;
    source?: string;
}

export interface ValidationContext {
    /** outstanding requirement tags this student's audit says each section fills */
    applies: (s: SectionRecord) => string[];
    /** true when a parsed degree audit was available */
    auditAvailable: boolean;
    /** transfer / exam credits still pending (never counted as awarded) — shown, not assumed */
    pendingCredit?: string[];
    /** every real section the extension knows for the term, to check identifiers against */
    catalog?: SectionRecord[];
    gradeClaims?: GradeClaim[];
    now?: number;
    /** records older than this are "stale" (default 7 days) */
    staleAfterMs?: number;
    travel?: TravelEstimator;
}

const DAY = 24 * 60 * 60 * 1000;
const DAY_WORD = {
    M: 'Monday',
    T: 'Tuesday',
    W: 'Wednesday',
    TH: 'Thursday',
    F: 'Friday',
    S: 'Saturday',
    SU: 'Sunday',
};
const label = (s: SectionRecord) => `${s.courseCode} (${String(s.uniqueId).padStart(5, '0')})`;
const list = (xs: string[]) => xs.join('; ');

export function validatePlan(
    sections: SectionRecord[],
    c: ScheduleConstraints,
    ctx: ValidationContext
): ValidationReport {
    const checks: Check[] = [];
    const add = (id: Check['id'], text: string, failures: string[], unverified: string[] = [], ok = 'ok') =>
        checks.push({
            id,
            label: text,
            status: failures.length ? 'fail' : unverified.length ? 'unverified' : 'pass',
            detail: failures.length ? list(failures) : unverified.length ? list(unverified) : ok,
        });
    const now = ctx.now ?? Date.now();
    const credits = sections.reduce((n, s) => n + s.creditHours, 0);

    // semester
    const terms = new Set(sections.map(s => semesterKey(s.semester)));
    const semesterBad: string[] = [];
    if (terms.size > 1) semesterBad.push(`mixed semesters: ${[...terms].join(', ')}`);
    if (c.term)
        for (const s of sections)
            if (semesterKey(s.semester) !== c.term) semesterBad.push(`${label(s)} is not ${c.term}`);
    add('semester', c.term ? `${c.term} only` : 'One semester', semesterBad, [], [...terms].join(', ') || 'no classes');

    // credit range (asynchronous classes count in full)
    const creditBad: string[] = [];
    if (credits < c.minCredits) creditBad.push(`${credits} credit hours is below ${c.minCredits}`);
    if (credits > c.maxCredits) creditBad.push(`${credits} credit hours is above ${c.maxCredits}`);
    add('credits', `${c.minCredits}–${c.maxCredits} credit hours`, creditBad, [], `${credits} credit hours`);

    // uniqueness
    const seen = new Set<string>();
    const dup: string[] = [];
    const ids = new Set<number>();
    for (const s of sections) {
        const code = normalizeCourseCode(s.courseCode);
        if (seen.has(code)) dup.push(`${s.courseCode} appears twice`);
        if (ids.has(s.uniqueId)) dup.push(`unique ${s.uniqueId} appears twice`);
        seen.add(code);
        ids.add(s.uniqueId);
    }
    add('unique', 'No repeated course', dup);

    // exact per-subject counts (e.g. one UGS)
    const countBad: string[] = [];
    for (const [subj, n] of Object.entries(c.subjectCounts ?? {})) {
        const have = sections.filter(s => subjectOf(s.courseCode) === subj).length;
        if (have !== n) countBad.push(`${have} ${subj} class${have === 1 ? '' : 'es'}, exactly ${n} required`);
    }
    if (Object.keys(c.subjectCounts ?? {}).length)
        add(
            'subject-count',
            `Exactly ${list(Object.entries(c.subjectCounts!).map(([k, n]) => `${n} ${k}`))}`,
            countBad
        );

    // requirement fit: every class advances an outstanding core requirement, none repeats another's
    const dedicated = assignRequirements(sections, ctx.applies, !!c.coreOnly);
    if (c.coreOnly) {
        const nothing = sections.filter(s => !fillableTags(ctx.applies(s), true).length);
        add(
            'requirements',
            'Every class fills an outstanding core requirement',
            nothing.map(s => `${label(s)} does not advance any outstanding core requirement`),
            [],
            list(
                sections.map(s => `${s.courseCode} → ${describeRequirement(dedicated.assigned.get(s.uniqueId) ?? '?')}`)
            )
        );
        const repeats = dedicated.unassigned.filter(s => fillableTags(ctx.applies(s), true).length);
        add(
            'redundant',
            'No requirement filled twice',
            repeats.map(s => `${label(s)} only repeats a requirement another class already fills`)
        );
    }

    // exclusions
    const excluded: string[] = [];
    for (const s of sections) {
        if (c.excludedSubjects.includes(subjectOf(s.courseCode))) excluded.push(`${label(s)} is an excluded subject`);
        if (c.excludedCourses.includes(normalizeCourseCode(s.courseCode))) excluded.push(`${label(s)} is excluded`);
        if (c.excludedSections?.includes(s.uniqueId)) excluded.push(`${label(s)} was ruled out`);
        for (const w of c.excludedTitleWords)
            if (new RegExp(`\\b${w.replace(/[^a-z ]/gi, '')}\\b`, 'i').test(s.title))
                excluded.push(`${label(s)} matches excluded "${w}"`);
    }
    add('exclusions', 'No excluded subjects or courses', excluded);

    // days and times: only allowed days; online-async has no manufactured meetings
    const dayBad: string[] = [];
    for (const s of sections) {
        if (isAsync(s)) continue;
        if (!s.meetings.length) dayBad.push(`${label(s)} has no listed meeting times`);
        for (const m of s.meetings) {
            if (m.end <= m.start) dayBad.push(`${label(s)} has an invalid time range`);
            for (const d of m.days) if (c.avoidDays.includes(d)) dayBad.push(`${label(s)} meets on ${DAY_WORD[d]}`);
            if (c.timeWindow && (m.start < c.timeWindow.from || m.end > c.timeWindow.to))
                dayBad.push(`${label(s)} is outside the allowed times`);
        }
    }
    if (c.maxOnline != null) {
        const n = sections.filter(isAsync).length;
        if (n > c.maxOnline) dayBad.push(`${n} asynchronous online classes, at most ${c.maxOnline} allowed`);
    }
    add('days', 'Only allowed meeting days and times', [...new Set(dayBad)]);

    // overlaps
    const overlaps: string[] = [];
    for (let i = 0; i < sections.length; i++)
        for (let j = i + 1; j < sections.length; j++)
            for (const a of sections[i]!.meetings)
                for (const b of sections[j]!.meetings)
                    if (a.days.some(d => b.days.includes(d)) && a.start < b.end && b.start < a.end)
                        overlaps.push(`${sections[i]!.courseCode} overlaps ${sections[j]!.courseCode}`);
    add('overlap', 'No time overlaps', [...new Set(overlaps)]);

    // walking between classes
    if (c.checkTravel !== false) {
        const legs = transitions(sections, ctx.travel ?? campusTravelMinutes);
        const tooFar = legs
            .filter(t => t.feasible === false)
            .map(
                t =>
                    `${DAY_WORD[t.day]}: ${t.from.section.courseCode} (${t.from.building}) → ${t.to.section.courseCode} (${t.to.building}) needs about ${t.needed} min, ${t.gap} available`
            );
        const unknown = legs
            .filter(t => t.feasible === null)
            .map(
                t =>
                    `${t.from.section.courseCode} → ${t.to.section.courseCode} (${t.from.building} → ${t.to.building}): walking time unknown`
            );
        add('travel', 'Enough time to walk between classes', tooFar, [...new Set(unknown)]);
    }

    // identifiers: a real section of the right course in the term
    const byId = new Map((ctx.catalog ?? []).map(s => [s.uniqueId, s]));
    const idBad: string[] = [];
    const idUnknown: string[] = [];
    for (const s of sections) {
        if (!Number.isInteger(s.uniqueId) || s.uniqueId < 1 || s.uniqueId > 99999)
            idBad.push(`${s.courseCode} has no valid unique number`);
        else if (ctx.catalog) {
            const real = byId.get(s.uniqueId);
            if (!real) idBad.push(`${label(s)} is not in the course data Fastlane has`);
            else if (normalizeCourseCode(real.courseCode) !== normalizeCourseCode(s.courseCode))
                idBad.push(`unique ${s.uniqueId} is ${real.courseCode} in the course data, not ${s.courseCode}`);
        } else idUnknown.push(`${label(s)}: no course data to check against`);
        if (!s.course) idBad.push(`${label(s)} cannot be placed on a UT schedule`);
    }
    add('sections', 'Real, identifiable sections', idBad, idUnknown);

    // degree audit
    const auditUnverified: string[] = [];
    if (c.coreOnly || Object.keys(c.subjectCounts ?? {}).length) {
        if (!ctx.auditAvailable)
            auditUnverified.push(
                'No degree audit imported: requirement fit uses the course listing only, not your audit.'
            );
        else if (c.requirementSource === 'listing')
            auditUnverified.push('Requirement fit was matched from course listings, not your audit.');
    }
    if (ctx.pendingCredit?.length)
        auditUnverified.push(`Pending credit is not counted as awarded: ${list(ctx.pendingCredit)}`);
    add('degree-audit', 'Matches your degree audit', [], auditUnverified);

    // freshness of the records behind the schedule
    const stale = ctx.staleAfterMs ?? 7 * DAY;
    const old: string[] = [];
    for (const s of sections) {
        const asOf = s.listing?.asOf ? Date.parse(s.listing.asOf) : NaN;
        const seen = Math.max(s.capturedAt || 0, Number.isFinite(asOf) ? asOf : 0);
        if (!seen) old.push(`${s.courseCode}: capture time unknown`);
        else if (now - seen > stale)
            old.push(
                `${s.courseCode}: last seen ${new Date(seen).toISOString().slice(0, 10)} (${Math.floor((now - seen) / DAY)} days ago)`
            );
    }
    add('freshness', 'Section data is recent', [], old);

    // grade claims must have real counts behind them
    const claimBad: string[] = [];
    for (const g of ctx.gradeClaims ?? []) {
        const s = sections.find(x => x.uniqueId === g.uniqueId);
        if (g.percent != null && (!g.sample || g.sample <= 0 || !g.source))
            claimBad.push(`${s ? s.courseCode : g.uniqueId}: a grade percentage without a sample or source`);
    }
    add('grade-claims', 'Grade figures have data behind them', claimBad);

    const failures = checks.filter(k => k.status === 'fail').map(k => `${k.label}: ${k.detail}`);
    const unverified = checks.filter(k => k.status === 'unverified').map(k => `${k.label}: ${k.detail}`);
    return {
        checks,
        hardOk: failures.length === 0 && sections.length > 0,
        allRulesMet: failures.length === 0 && unverified.length === 0 && sections.length > 0,
        credits,
        failures,
        unverified,
    };
}

/** One honest sentence for the top of the schedule, from the report alone. */
export function verdictText(r: ValidationReport): string {
    if (r.allRulesMet) return 'All rules met — checked independently against your constraints and records.';
    if (!r.hardOk) return `Rules NOT met: ${r.failures.join(' · ')}`;
    return `Hard rules pass, but not everything could be verified: ${r.unverified.join(' · ')}`;
}

/** Every backup must pass the same checks as the schedule it would replace (swapped in for the section it backs up). */
export function validateBackup(
    plan: SectionRecord[],
    replaces: SectionRecord,
    backup: SectionRecord,
    c: ScheduleConstraints,
    ctx: ValidationContext
): ValidationReport {
    return validatePlan(
        plan.map(s => (s.uniqueId === replaces.uniqueId ? backup : s)),
        c,
        ctx
    );
}
