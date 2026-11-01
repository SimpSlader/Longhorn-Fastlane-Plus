/**
 * The tools Fastlane's copilot can call. They run here in the browser over data the extension already has:
 * UT's listed sections, historical grade distributions, Rate My Professors (when the student allows it), the
 * imported IDA through the shared academic model, the schedule solver and the graduation calculator. Each tool
 * returns compact, factual results for the model to reason over; schedules come only from the solver, so they
 * are conflict-free and follow the hard rules. Nothing here invents a section, a grade or a rating.
 */
import type { ParsedAudit } from '../audit/types';
import type { AcademicModel } from './academicModel';
import type { AiCandidate } from './aiCandidates';
import { chooseAiCandidates } from './aiCandidates';
import { type BackupPlan, buildBackups, sectionCounts } from './backups';
import { parseCourseQuery, resolveCourseCode, sectionMatchesQuery, subjectWords } from './courseSearch';
import { createDegreeMatcher, evaluateDegree } from './degreeRules';
import { estimateGpa, type GpaEstimate, gpaScore } from './gpaModel';
import type { GradeStat } from './grades';
import { graduationAnswer, graduationPlan, parseTerm, termName } from './graduation';
import type { DayCode } from './meetings';
import { formatMeeting } from './meetings';
import { enforceStated } from './plannerRules';
import {
    type ValidationContext,
    type ValidationReport,
    validateBackup,
    validatePlan,
    verdictText,
} from './planValidator';
import { checkPrerequisites } from './prerequisites';
import { fitsWith, refineIntent, replacementFits } from './proposal';
import { isCoreTag } from './requirementFit';
import { normalizeCourseCode } from './requirements';
import type { RmpRating } from './rmp';
import { splitProfessorName } from './rmp';
import {
    hardReason,
    isAsync,
    MIN_CREDITS,
    type ScheduleConstraints,
    type SolverCandidate,
    scoreSection,
    solveSchedule,
} from './scheduleSolver';
import { type SectionRecord, semesterKey, subjectOf } from './sections';
import { validateBuildArgs, validateModifyArgs } from './toolArgs';
import type { TravelEstimator } from './travel';

export interface ToolContext {
    catalog: SectionRecord[];
    term: string;
    audit: ParsedAudit | null;
    model: AcademicModel;
    taken: Set<string>;
    outstanding: string[];
    subjectIndex: Array<[string, string]>;
    gradeStat: (s: SectionRecord) => Promise<GradeStat | null>;
    /** null when Rate My Professors lookups are turned off */
    rmp: ((first: string, last: string) => Promise<RmpRating | null>) | null;
    /** the schedule on screen and how it was built (for follow-up changes) */
    current: { sections: SectionRecord[]; constraints: ScheduleConstraints; pool: SolverCandidate[] } | null;
    remember: (fact: string) => Promise<void>;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    /** hard rules the student stated in their own words (deterministic parse); the model cannot loosen them */
    stated?: ScheduleConstraints;
    /** walking-time estimate (tests inject one) */
    travel?: TravelEstimator;
    /** true when a newer instruction has arrived: results are dropped, never shown */
    isStale?: () => boolean;
    now?: number;
    /** when set, build_schedule records how long each phase took here */
    timings?: Record<string, number>;
}

/** Optional per-phase timing (milliseconds), filled in when a caller passes `ctx.timings`. */
async function lap<T>(ctx: ToolContext, label: string, work: () => Promise<T> | T): Promise<T> {
    const started = performance.now();
    try {
        return await work();
    } finally {
        if (ctx.timings) ctx.timings[label] = (ctx.timings[label] ?? 0) + (performance.now() - started);
    }
}

export interface ToolOutcome {
    /** what the model sees (kept small) */
    result: unknown;
    /** a schedule to put on the calendar */
    plan?: {
        sections: SectionRecord[];
        note: string;
        constraints: ScheduleConstraints;
        pool: SolverCandidate[];
        /** the independent validator's verdict for exactly these sections */
        validation: ValidationReport;
        /** the same request optimized three ways, each independently validated (one click to switch) */
        alternatives?: Array<{
            label: string;
            objective: string;
            sections: SectionRecord[];
            validation: ValidationReport;
        }>;
    };
}

const WEEKDAYS: DayCode[] = ['M', 'T', 'W', 'TH', 'F'];
const DAY_ALIASES: Record<string, DayCode> = {
    M: 'M',
    MON: 'M',
    MONDAY: 'M',
    T: 'T',
    TU: 'T',
    TUE: 'T',
    TUES: 'T',
    TUESDAY: 'T',
    W: 'W',
    WED: 'W',
    WEDNESDAY: 'W',
    TH: 'TH',
    THU: 'TH',
    THUR: 'TH',
    THURS: 'TH',
    THURSDAY: 'TH',
    F: 'F',
    FRI: 'F',
    FRIDAY: 'F',
};
const days = (list: unknown): DayCode[] =>
    Array.isArray(list)
        ? [
              ...new Set(
                  list
                      .map(
                          d =>
                              DAY_ALIASES[
                                  String(d)
                                      .toUpperCase()
                                      .replace(/[^A-Z]/g, '')
                              ]
                      )
                      .filter(Boolean) as DayCode[]
              ),
          ]
        : [];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []);
const when = (s: SectionRecord) =>
    s.meetings.length ? s.meetings.map(formatMeeting).join('; ') : 'online, no set times';
const mode = (s: SectionRecord) =>
    isAsync(s) ? 'online (asynchronous)' : s.modality === 'live-online' ? 'online at set times' : 'in person';
const clock = (v: unknown): number | null => {
    const m = String(v ?? '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let h = Number(m[1]);
    if (/pm/i.test(m[3] ?? '') && h < 12) h += 12;
    if (!m[3] && h >= 1 && h <= 7) h += 12;
    return h * 60 + Number(m[2] ?? 0);
};
const pad = (n: number) => String(n).padStart(5, '0');

async function aRate(ctx: ToolContext, s: SectionRecord) {
    const g = (await ctx.gradeStat(s))?.result;
    return g ? { percent: Math.round(g.percent), sample: g.graded } : null;
}

async function rating(ctx: ToolContext, instructor: string | undefined) {
    if (!ctx.rmp || !instructor) return null;
    const name = splitProfessorName(undefined, undefined, instructor);
    if (!name?.last) return null;
    try {
        const r = await ctx.rmp(name.first, name.last);
        return r && r.numRatings > 0
            ? {
                  quality: r.avgRating,
                  difficulty: r.avgDifficulty,
                  wouldTakeAgain: r.wouldTakeAgainPercent >= 0 ? Math.round(r.wouldTakeAgainPercent) : null,
                  ratings: r.numRatings,
              }
            : { quality: null, ratings: 0, note: 'no Rate My Professors match' };
    } catch {
        return null;
    }
}

const inTerm = (ctx: ToolContext) => ctx.catalog.filter(s => !ctx.term || semesterKey(s.semester) === ctx.term);

// ---------------------------------------------------------------------------------------------------------

function profile(ctx: ToolContext) {
    const m = ctx.model;
    const f = (x: { value: number | null; source: string }) => ({ value: x.value, source: x.source });
    return {
        program: m.degreeProgram,
        catalogYear: m.catalogYear,
        auditImported: m.auditTimestamp ? new Date(m.auditTimestamp).toISOString().slice(0, 10) : null,
        degreeTotalRequired: f(m.degreeTotalRequired),
        creditsEarned: f(m.degreeCreditsEarned),
        creditsInProgress: f(m.degreeCreditsInProgress),
        creditsProjectedAfterThisSemester: f(m.degreeCreditsProjected),
        creditsRemainingAfterThisSemester: f(m.degreeCreditsRemainingProjected),
        residence: { counted: m.utResidentCounted.value, required: m.utResidentRequired.value },
        upperDivision: { counted: m.upperDivisionCounted.value, required: m.upperDivisionRequired.value },
        targetGraduation: m.targetGraduation?.value ?? null,
        unfinishedRequirements: ctx.audit
            ? ctx.audit.requirements
                  .filter(r => r.status !== 'completed')
                  .slice(0, 25)
                  .map(r => r.text.slice(0, 140))
            : [],
        completedOrInProgressCourses: [...ctx.taken].slice(0, 60),
        notes: [...m.discrepancies, ...m.issues],
        gpa: 'kept in this browser only (see Degree progress); never sent to the AI',
    };
}

async function searchCourses(args: Record<string, unknown>, ctx: ToolContext) {
    const query = String(args.query ?? '')
        .toLowerCase()
        .trim();
    const subject = String(args.subject ?? '')
        .toUpperCase()
        .trim();
    const requirement = String(args.requirement ?? '')
        .toLowerCase()
        .trim();
    const allowed = days(args.days);
    const limit = Math.min(Number(args.limit) || 12, 20);
    const open = new Set(ctx.outstanding);
    const parsedQuery = parseCourseQuery(query);
    const subjectNames = subjectWords(ctx.subjectIndex);
    const degreeMatch = ctx.audit ? createDegreeMatcher(ctx.audit, { term: ctx.term, now: ctx.now }) : null;
    const sections = inTerm(ctx).filter(s => {
        if (subject && subjectOf(s.courseCode) !== subject) return false;
        if (query && !sectionMatchesQuery(s, parsedQuery, subjectNames)) return false;
        if ((args.onlineOnly || parsedQuery.online) && !(isAsync(s) || s.modality === 'live-online')) return false;
        if (allowed.length && !isAsync(s) && !s.meetings.every(m => m.days.every(d => allowed.includes(d))))
            return false;
        if (requirement) {
            const tags = s.requirementTags.map(t => t.toLowerCase());
            const wantsCore = /core/.test(requirement);
            const code = requirement.match(/\d{3}/)?.[0];
            if (/signature|ugs/.test(requirement)) return subjectOf(s.courseCode) === 'UGS';
            if (wantsCore && !tags.some(t => t.includes('core') && (!code || t.includes(code)))) return false;
            if (!wantsCore && !tags.some(t => t.includes(requirement))) return false;
        }
        return true;
    });
    const byCourse = new Map<string, SectionRecord[]>();
    for (const s of sections) {
        const k = normalizeCourseCode(s.courseCode);
        if (!byCourse.has(k)) byCourse.set(k, []);
        byCourse.get(k)!.push(s);
    }
    const courses = [...byCourse.entries()]
        .map(([code, list]) => ({ code, list, applies: degreeMatch ? degreeMatch(list[0]!) : [] }))
        .filter(c => !ctx.taken.has(c.code))
        .sort((a, b) => b.applies.length - a.applies.length || b.list.length - a.list.length)
        .slice(0, limit);
    const out = [];
    for (const c of courses) {
        const rates = (await Promise.all(c.list.slice(0, 4).map(s => aRate(ctx, s)))).filter(Boolean) as Array<{
            percent: number;
            sample: number;
        }>;
        out.push({
            code: c.code,
            title: c.list[0]!.title,
            credits: c.list[0]!.creditHours,
            sections: c.list.length,
            modes: [...new Set(c.list.map(mode))],
            countsToward: c.applies,
            bestHistoricalARate: rates.length ? Math.max(...rates.map(r => r.percent)) : null,
        });
    }
    return {
        semester: ctx.term || 'any listed',
        matches: byCourse.size,
        courses: out,
        note: out.length
            ? undefined
            : 'No listed course matched; UT’s course list for the semester may not be imported.',
    };
}

async function courseSections(args: Record<string, unknown>, ctx: ToolContext) {
    const code =
        resolveCourseCode(String(args.course ?? ''), inTerm(ctx), ctx.subjectIndex) ??
        normalizeCourseCode(String(args.course ?? ''));
    const list = inTerm(ctx)
        .filter(s => normalizeCourseCode(s.courseCode) === code)
        .sort((a, b) => a.uniqueId - b.uniqueId);
    if (!list.length)
        return { course: code, sections: [], note: 'No listed sections in the course data Fastlane has.' };
    const sections = [];
    for (const s of list.slice(0, 15))
        sections.push({
            unique: pad(s.uniqueId),
            when: when(s),
            mode: mode(s),
            instructor: s.instructors.join(', ') || 'TBA',
            historicalARate: await aRate(ctx, s),
            seatStatus: s.status
                ? `${s.status.value.toLowerCase()} when the student viewed it on ${new Date(s.status.observedAt).toISOString().slice(0, 10)}`
                : 'not checked',
        });
    const prereq = checkPrerequisites(list[0]!.prerequisites, ctx.taken, ctx.subjectIndex, ctx.audit?.courses);
    return {
        course: code,
        title: list[0]!.title,
        credits: list[0]!.creditHours,
        alreadyTakenOrInProgress: ctx.taken.has(code),
        countsToward: ctx.audit ? createDegreeMatcher(ctx.audit, { term: ctx.term, now: ctx.now })(list[0]!) : [],
        prerequisites: list[0]!.prerequisites
            ? { text: list[0]!.prerequisites.slice(0, 240), status: prereq.status }
            : null,
        listing: list[0]!.listing?.asOf
            ? `UT course list printed ${list[0]!.listing!.asOf}`
            : 'UT pages the student viewed',
        sections,
        moreSections: Math.max(0, list.length - 15),
    };
}

async function professor(args: Record<string, unknown>, ctx: ToolContext) {
    const raw = String(args.name ?? '').trim();
    const last = (splitProfessorName(undefined, undefined, raw)?.last ?? raw).toLowerCase();
    const taught = inTerm(ctx).filter(s => s.instructors.some(i => i.toLowerCase().includes(last)));
    const listedName = taught[0]?.instructors.find(i => i.toLowerCase().includes(last)) ?? raw;
    const courses = new Map<string, SectionRecord>();
    for (const s of taught)
        if (!courses.has(normalizeCourseCode(s.courseCode))) courses.set(normalizeCourseCode(s.courseCode), s);
    const grades = [];
    for (const [code, s] of [...courses.entries()].slice(0, 6))
        grades.push({ course: code, historicalARate: await aRate(ctx, s) });
    return {
        name: listedName,
        rateMyProfessors: ctx.rmp ? await rating(ctx, listedName) : 'turned off in the student’s settings',
        listedCourses: grades,
        note: 'A/A− rates are past grades in that course with this instructor; Rate My Professors ratings are student opinions.',
    };
}

// ---------------------------------------------------------------------------------------------------------

/** "Make my Tuesdays start later": per-day earliest start / latest end, merged over earlier windows. */
function mergeWindows(
    base: NonNullable<ScheduleConstraints['dayLimits']>,
    raw: unknown
): NonNullable<ScheduleConstraints['dayLimits']> {
    const out = { ...base };
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, v] of Object.entries(raw as Record<string, { from?: unknown; to?: unknown }>)) {
        const day = DAY_ALIASES[key.toUpperCase().replace(/[^A-Z]/g, '')];
        if (!day || !v) continue;
        const from = clock(v.from);
        const to = clock(v.to);
        out[day] = { ...out[day], ...(from != null ? { from } : {}), ...(to != null ? { to } : {}) };
    }
    return out;
}

function constraintsFrom(
    args: Record<string, unknown>,
    ctx: ToolContext,
    base?: ScheduleConstraints
): ScheduleConstraints {
    const only = days(args.onlyDays ?? args.changeOnlyDays);
    const credits = (args.changeCredits as { min?: number; max?: number } | undefined) ?? {};
    // 12 is only the default floor; a student who asks for a lighter load (say 9 hours) gets exactly that
    const askedMin = args.minCredits ?? credits.min;
    const minC = Math.max(1, Number(askedMin ?? base?.minCredits ?? MIN_CREDITS) || MIN_CREDITS);
    const maxC = Math.max(
        minC,
        Number(args.maxCredits ?? credits.max ?? base?.maxCredits ?? (askedMin != null ? Number(askedMin) : 16)) || 16
    );
    const onlineMin = args.onlineMin != null ? Number(args.onlineMin) : null;
    const onlineMax = args.onlineMax != null ? Number(args.onlineMax) : null;
    const counts: Record<string, number> = { ...(base?.subjectCounts ?? {}) };
    for (const [k, v] of Object.entries((args.exactCounts as Record<string, number> | undefined) ?? {}))
        counts[k.toUpperCase()] = Number(v);
    // "include one UGS" means exactly one: a second signature course would only repeat the requirement
    for (const subj of strings(args.includeSubjects).map(x => x.toUpperCase())) counts[subj] ??= 1;
    const from = clock(args.earliestStart);
    const to = clock(args.latestEnd);
    return {
        minCredits: minC,
        maxCredits: maxC,
        creditsRequested: args.minCredits != null || args.maxCredits != null || base?.creditsRequested === true,
        avoidDays: only.length
            ? WEEKDAYS.filter(d => !only.includes(d))
            : days(args.avoidDays).length
              ? days(args.avoidDays)
              : (base?.avoidDays ?? []),
        excludedSubjects: [
            ...new Set([...(base?.excludedSubjects ?? []), ...strings(args.excludeSubjects).map(x => x.toUpperCase())]),
        ],
        excludedTitleWords: base?.excludedTitleWords ?? [],
        excludedCourses: [
            ...new Set([...(base?.excludedCourses ?? []), ...strings(args.excludeCourses).map(normalizeCourseCode)]),
        ],
        term: ctx.term,
        online:
            onlineMin != null || onlineMax != null
                ? { min: onlineMin ?? 0, max: Math.max(onlineMin ?? 0, onlineMax ?? onlineMin ?? 0) }
                : (base?.online ?? null),
        backToBack: args.backToBack != null ? !!args.backToBack : (base?.backToBack ?? false),
        timeWindow: from != null || to != null ? { from: from ?? 0, to: to ?? 24 * 60 } : (base?.timeWindow ?? null),
        dayLimits: mergeWindows(base?.dayLimits ?? {}, args.dayWindows),
        requiredCourses: [
            ...new Set([
                ...(base?.requiredCourses ?? []),
                ...strings(args.requiredCourses).map(
                    n => resolveCourseCode(n, inTerm(ctx), ctx.subjectIndex) ?? normalizeCourseCode(n)
                ),
            ]),
        ],
        coreOnly: args.coreOnly != null ? !!args.coreOnly : (base?.coreOnly ?? false),
        // default: degree requirements first, then eligible electives to reach the credit total — unless the student says no
        allowElectives: args.allowElectives != null ? !!args.allowElectives : (base?.allowElectives ?? true),
        subjectCounts: counts,
        maxOnline: onlineMax != null ? onlineMax : base?.maxOnline,
        excludedSections: base?.excludedSections ?? [],
        maxGapMinutes: args.maxGapMinutes != null ? Number(args.maxGapMinutes) : base?.maxGapMinutes,
        checkTravel: true,
        requirementSource: base?.requirementSource,
    };
}

interface Scored extends SolverCandidate {
    grade: { percent: number; sample: number; source?: string } | null;
    gpa?: GpaEstimate | null;
}

async function candidatePool(
    args: Record<string, unknown>,
    ctx: ToolContext,
    c: ScheduleConstraints
): Promise<Scored[]> {
    const eligible = inTerm(ctx).filter(s => !hardReason(s, c) && !ctx.taken.has(normalizeCourseCode(s.courseCode)));
    const input = {
        sections: eligible,
        term: ctx.term,
        taken: ctx.taken,
        outstanding: ctx.outstanding,
        audit: ctx.audit,
        active: [],
        avoidFriday: false,
        preferAsync: (c.online?.min ?? 0) > 0,
        subjectIndex: ctx.subjectIndex,
    };
    const opts = {
        signal: ctx.signal,
        onProgress: ctx.onProgress,
        limit: c.coreOnly ? 140 : 90,
        asyncShare: Math.max(6, (c.online?.max ?? 2) * 5),
    };
    const chosen: AiCandidate[] = [];
    const grades = new Map<number, GradeStat | null>();
    const add = (r: { chosen: AiCandidate[]; grades: Map<number, GradeStat | null> }) => {
        for (const x of r.chosen) if (!chosen.some(y => y.section.uniqueId === x.section.uniqueId)) chosen.push(x);
        for (const [k, v] of r.grades) grades.set(k, v);
    };
    add(await chooseAiCandidates({ ...input, subject: '' }, ctx.gradeStat, opts));
    // required subjects and preferred courses are always in the pool, even if they didn't rank in the top
    const required = new Set([
        ...strings(args.includeSubjects).map(x => x.toUpperCase()),
        ...Object.keys(c.subjectCounts ?? {}),
    ]);
    for (const subj of required)
        add(await chooseAiCandidates({ ...input, subject: subj }, ctx.gradeStat, { ...opts, limit: 25 }));
    for (const code of [...strings(args.preferCourses).map(normalizeCourseCode), ...(c.requiredCourses ?? [])]) {
        const list = eligible.filter(s => normalizeCourseCode(s.courseCode) === code);
        if (list.length)
            add(
                await chooseAiCandidates({ ...input, sections: list, subject: '' }, ctx.gradeStat, {
                    ...opts,
                    limit: 10,
                })
            );
    }
    if (c.allowElectives && !c.coreOnly)
        // electives: the best-graded options regardless of requirement, so degree classes don't crowd them out
        add(
            await chooseAiCandidates({ ...input, outstanding: [], subject: '' }, ctx.gradeStat, { ...opts, limit: 70 })
        );
    const prefer = new Set([...strings(args.preferCourses).map(normalizeCourseCode), ...(c.requiredCourses ?? [])]);
    const ratingCache = new Map<string, Awaited<ReturnType<typeof rating>>>();
    const out: Scored[] = [];
    for (const [i, x] of chosen.entries()) {
        if (x.prerequisite.status === 'unmet') continue;
        const stat = grades.get(x.section.uniqueId);
        const g = stat?.result;
        // without an imported audit, only the listing's own Core tag is available — and says so
        const applies = c.coreOnly && !ctx.audit ? x.section.requirementTags.filter(isCoreTag) : x.applies;
        const gpa = stat?.counts
            ? estimateGpa({ counts: stat.counts, scope: stat.scope, semesters: stat.semesters })
            : null;
        let score = scoreSection({
            applies,
            coreFocus: !!args.coreFocus || !!c.coreOnly,
            gradePercent: g?.percent ?? null,
            gradeSample: g?.graded ?? 0,
            easyGrades: args.prioritizeGrades !== false,
            aiPicked: false,
            creditHours: x.section.creditHours,
            courseCode: x.section.courseCode,
            prerequisite: x.prerequisite.status,
            // counts give the confidence-aware model; older stats without counts keep the percentage fallback
            gpa: gpa ?? undefined,
        });
        if (prefer.has(normalizeCourseCode(x.section.courseCode))) score += 15;
        // professor quality is secondary context only: a small nudge, never the GPA signal
        if (args.prioritizeRatings && ctx.rmp && i < 40) {
            const who = x.section.instructors[0] ?? '';
            if (!ratingCache.has(who)) ratingCache.set(who, await rating(ctx, who));
            const r = ratingCache.get(who);
            if (r && typeof r.quality === 'number' && r.ratings >= 5) score += (r.quality - 3.5) * 2;
        }
        out.push({
            section: x.section,
            applies,
            prerequisite: x.prerequisite.status,
            score,
            grade: g ? { percent: Math.round(g.percent), sample: g.graded, source: stat?.source } : null,
            gpa,
        });
    }
    return out;
}

function validationContext(ctx: ToolContext, pool: Scored[]): ValidationContext {
    const byId = new Map(pool.map(p => [p.section.uniqueId, p]));
    return {
        applies: s => byId.get(s.uniqueId)?.applies ?? [],
        audit: ctx.audit,
        auditAvailable: !!ctx.audit,
        pendingCredit: ctx.audit?.transfer.pending.map(p => p.code) ?? [],
        catalog: ctx.catalog,
        gradeClaims: pool
            .filter(p => p.grade)
            .map(p => ({
                uniqueId: p.section.uniqueId,
                percent: p.grade!.percent,
                sample: p.grade!.sample,
                source: p.grade!.source ?? 'grade dataset',
            })),
        now: ctx.now,
        travel: ctx.travel,
    };
}

const compactReport = (r: ValidationReport) => ({
    allRulesMet: r.allRulesMet,
    hardRulesPass: r.hardOk,
    verdict: verdictText(r),
    checks: r.checks.map(k => `${k.status.toUpperCase()}: ${k.label} — ${k.detail}`.slice(0, 220)),
    instruction:
        'Report this verdict exactly. Say "all rules met" only if allRulesMet is true; otherwise list what is unverified or failed.',
});

async function describePlan(
    ctx: ToolContext,
    sections: SectionRecord[],
    pool: Scored[],
    c: ScheduleConstraints,
    requested: string[],
    report: ValidationReport
) {
    const bySection = new Map(pool.map(p => [p.section.uniqueId, p]));
    const classes = [];
    const degree = evaluateDegree(ctx.audit, sections, { term: ctx.term, now: ctx.now });
    for (const s of sections) {
        const p = bySection.get(s.uniqueId);
        classes.push({
            code: s.courseCode,
            title: s.title,
            unique: pad(s.uniqueId),
            credits: s.creditHours,
            when: when(s),
            mode: mode(s),
            instructor: s.instructors.join(', ') || 'TBA',
            historicalARate: p?.grade ?? (await aRate(ctx, s)),
            gpaOutlook: p?.gpa
                ? {
                      expectedGradePoints: Number(p.gpa.expectedGradePoints.toFixed(2)),
                      chanceOfA: Math.round(p.gpa.pA * 100),
                      confidence: p.gpa.confidence,
                      basis: p.gpa.rationale,
                  }
                : 'no historical grade data: not estimated',
            rateMyProfessors: await rating(ctx, s.instructors[0]),
            countsToward: degree.courses.find(x => x.uniqueId === s.uniqueId)?.contributions.map(x => x.tag) ?? [],
            // never let an elective read as if it advanced the degree
            kind: (() => {
                const tags = degree.courses.find(x => x.uniqueId === s.uniqueId)?.contributions ?? [];
                if (tags.length) return 'requirement';
                return (c.requiredCourses ?? []).includes(normalizeCourseCode(s.courseCode)) ? 'requested' : 'elective';
            })(),
            degree: (() => {
                const d = degree.courses.find(x => x.uniqueId === s.uniqueId);
                return d
                    ? {
                          status: d.status,
                          plannedHours: d.degreeCredits,
                          requirements: d.contributions.map(c => c.tag),
                          warnings: d.warnings,
                      }
                    : { status: 'unverified' };
            })(),
            sectionRecord: s.listing?.asOf
                ? `Registrar course list as of ${s.listing.asOf}`
                : `seen on UT's site ${new Date(s.capturedAt).toISOString().slice(0, 10)}`,
            seatStatus: s.status
                ? `${s.status.value.toLowerCase()} when viewed ${new Date(s.status.observedAt).toISOString().slice(0, 10)}`
                : 'not checked',
        });
    }
    const gradeMap = new Map<number, number | null>(pool.map(p => [p.section.uniqueId, p.grade?.percent ?? null]));
    const backups: BackupPlan = buildBackups({
        plan: sections,
        candidates: inTerm(ctx).filter(s => !hardReason(s, c)),
        outstanding: ctx.outstanding,
        audit: ctx.audit,
        taken: ctx.taken,
        gradeOf: s => gradeMap.get(s.uniqueId) ?? null,
        sectionCounts: sectionCounts(inTerm(ctx)),
    });
    const vctx = validationContext(ctx, pool);
    // a backup is only offered if swapping it in leaves a schedule that passes the same hard rules
    const passes = (b: BackupPlan['general'][number], replaces?: SectionRecord) =>
        replaces
            ? validateBackup(sections, replaces, b.section, c, vctx).hardOk
            : sections.some(r => validateBackup(sections, r, b.section, c, vctx).hardOk);
    const brief = async (b: BackupPlan['general'][number]) => ({
        code: b.section.courseCode,
        unique: pad(b.section.uniqueId),
        when: when(b.section),
        instructor: b.section.instructors.join(', ') || 'TBA',
        historicalARate: gradeMap.get(b.section.uniqueId) ?? (await aRate(ctx, b.section))?.percent ?? null,
        why: b.why,
    });
    const credits = sections.reduce((n, s) => n + s.creditHours, 0);
    const missing = requested.filter(subj => !sections.some(s => subjectOf(s.courseCode) === subj));
    return {
        semester: ctx.term || 'listed semester',
        totalCredits: credits,
        validation: compactReport(report),
        electives: {
            count: classes.filter(x => x.kind === 'elective').length,
            hours: classes.filter(x => x.kind === 'elective').reduce((n, x) => n + x.credits, 0),
        },
        classes,
        backups: {
            perClass: await Promise.all(
                backups.perClass.map(async g => ({
                    for: g.for.courseCode,
                    options: await Promise.all(g.backups.filter(b => passes(b, g.for)).map(brief)),
                }))
            ),
            general: await Promise.all(backups.general.filter(b => passes(b)).map(brief)),
        },
        couldNotInclude: missing.length
            ? missing.map(subj => `${subj}: no listed section fits around the rest of the rules`)
            : [],
        note: 'On the calendar with backups. Every backup was re-checked against the same rules. Seats not checked live.',
    };
}

/** Applies what the student actually said on top of the model's request; the model cannot loosen it. */
const CONSTRAINT_ARGS = new Set([
    'minCredits',
    'maxCredits',
    'onlyDays',
    'avoidDays',
    'onlineMin',
    'onlineMax',
    'coreOnly',
    'allowElectives',
    'exactCounts',
    'includeSubjects',
    'excludeSubjects',
    'excludeCourses',
    'requiredCourses',
    'earliestStart',
    'latestEnd',
    'dayWindows',
    'changeOnlyDays',
    'changeCredits',
    'backToBack',
    'maxGapMinutes',
]);

function withStated(c: ScheduleConstraints, ctx: ToolContext, args: Record<string, unknown> = {}): ScheduleConstraints {
    // The model's reading of the request is authoritative. Keyword matching is only a fallback for a call that
    // carries no constraints at all (a sign the model skipped them); it never overrides a stated field.
    const modelGaveConstraints = Object.keys(args).some(k => CONSTRAINT_ARGS.has(k));
    const merged =
        ctx.stated && !modelGaveConstraints
            ? enforceStated(c, ctx.stated, {
                  coreOnly: args.coreOnly != null,
                  allowElectives: args.allowElectives === true,
              })
            : c;
    return { ...merged, requirementSource: merged.coreOnly && !ctx.audit ? 'listing' : 'audit' };
}

function badArguments(issues: Array<{ field: string; problem: string }>): ToolOutcome {
    return {
        result: {
            error: 'The arguments were rejected before anything ran.',
            issues: issues.map(i => `${i.field}: ${i.problem}`),
            instruction: 'Call the tool again with corrected arguments. Nothing was changed.',
        },
    };
}

type Relaxation = {
    label: string;
    /** lower = gentler to give up first */
    weight: number;
    change: (c: ScheduleConstraints) => ScheduleConstraints | null;
};

/** The one-rule-at-a-time relaxations offered (never applied) when no schedule satisfies everything. */
function relaxations(c: ScheduleConstraints): Relaxation[] {
    const out: Relaxation[] = [];
    const extraDay = (['W', 'M', 'F'] as DayCode[]).find(d => c.avoidDays.includes(d));
    if (extraDay)
        out.push({
            label: `Allow ${({ W: 'Wednesday', M: 'Monday', F: 'Friday' } as Record<string, string>)[extraDay]} classes`,
            weight: 4,
            change: x => ({ ...x, avoidDays: x.avoidDays.filter(d => d !== extraDay) }),
        });
    if (c.maxGapMinutes != null)
        out.push({
            label: `Allow gaps up to ${Math.max(60, c.maxGapMinutes + 15)} minutes`,
            weight: 1,
            change: x => ({ ...x, maxGapMinutes: Math.max(60, c.maxGapMinutes! + 15) }),
        });
    if (c.minCredits > MIN_CREDITS)
        out.push({
            label: `Try ${MIN_CREDITS}–${c.maxCredits} credits while keeping your other rules`,
            weight: 2,
            change: x => ({ ...x, minCredits: MIN_CREDITS }),
        });
    if (c.coreOnly)
        out.push({
            label: 'Allow classes that do not count toward core',
            weight: 6,
            change: x => ({ ...x, coreOnly: false }),
        });
    if (!c.allowElectives && !c.coreOnly)
        out.push({
            label: 'Fill the remaining credits with electives (ranked by GPA outlook)',
            weight: 3,
            change: x => ({ ...x, allowElectives: true }),
        });
    for (const code of c.requiredCourses ?? [])
        out.push({
            label: `Give up requiring ${code}`,
            weight: 9,
            change: x => ({ ...x, requiredCourses: (x.requiredCourses ?? []).filter(r => r !== code) }),
        });
    if (c.maxOnline != null)
        out.push({
            label: `Allow ${c.maxOnline + 1} asynchronous online classes`,
            weight: 3,
            change: x => ({ ...x, maxOnline: c.maxOnline! + 1 }),
        });
    out.push({
        weight: 5,
        label: `Widen credits to ${Math.max(MIN_CREDITS, c.minCredits - 1)}–${c.maxCredits + 1}`,
        change: x => ({ ...x, minCredits: Math.max(MIN_CREDITS, c.minCredits - 1), maxCredits: c.maxCredits + 1 }),
    });
    if (Object.keys(c.subjectCounts ?? {}).length)
        out.push({
            weight: 7,
            label: `Drop the exact-count rule (${Object.entries(c.subjectCounts!)
                .map(([k, n]) => `${n} ${k}`)
                .join(', ')})`,
            change: x => ({ ...x, subjectCounts: {} }),
        });
    if (c.checkTravel !== false)
        out.push({
            weight: 8,
            label: 'Allow tight walks between buildings (unchecked)',
            change: x => ({ ...x, checkTravel: false }),
        });
    return out;
}

/** Closest alternatives, each solved and validated under its own single relaxation, labeled as needing permission. */
async function closestAlternatives(args: Record<string, unknown>, ctx: ToolContext, c: ScheduleConstraints) {
    const found = [];
    for (const r of relaxations(c)) {
        const relaxed = r.change(c);
        if (!relaxed) continue;
        const pool = await candidatePool(args, ctx, relaxed);
        const result = await solveSchedule(pool, relaxed, { audit: ctx.audit, signal: ctx.signal, maxNodes: 40_000 });
        if (!result.best) continue;
        const report = validatePlan(result.best.sections, relaxed, validationContext(ctx, pool));
        if (!report.hardOk) continue;
        found.push({
            requiresPermissionTo: r.label,
            notOnCalendar: true,
            totalCredits: result.best.credits,
            classes: result.best.sections.map(s => ({
                code: s.courseCode,
                unique: pad(s.uniqueId),
                when: when(s),
                credits: s.creditHours,
            })),
        });
        if (found.length >= 3) break;
    }
    return found;
}

/** The student's hard rules in one readable list, so a failure always shows what was being enforced. */
function rulesSummary(c: ScheduleConstraints): string {
    const parts = [`${c.minCredits}–${c.maxCredits} credit hours`];
    if (c.avoidDays.length) {
        const ok = (['M', 'T', 'W', 'TH', 'F'] as DayCode[]).filter(d => !c.avoidDays.includes(d));
        parts.push(`meetings only on ${ok.join('/')}`);
    }
    if (c.coreOnly) parts.push('every class fills an outstanding core requirement');
    else if (c.allowElectives)
        parts.push('degree requirements first, remaining credits filled with electives ranked by GPA outlook');
    for (const [k, n] of Object.entries(c.subjectCounts ?? {})) parts.push(`exactly ${n} ${k}`);
    if (c.excludedSubjects.length) parts.push(`no ${c.excludedSubjects.join(', ')}`);
    if (c.maxOnline != null) parts.push(`at most ${c.maxOnline} asynchronous online`);
    if (c.maxGapMinutes != null) parts.push(`maximum ${c.maxGapMinutes}-minute gap between classes`);
    parts.push('no overlaps', 'enough time to walk between buildings');
    return `Rules being enforced: ${parts.join('; ')}.`;
}

type SolveExtras = Parameters<typeof solveSchedule>[2];

/**
 * Solves with the student's must-have classes placed first: each one gets the best section that still lets a
 * complete schedule exist, then the rest is optimized around them. A must-have is exempt from the degree and
 * core-only filters (the student asked for it by name) but never from days, overlaps, walking time or credits.
 */
async function solveWithRequired(
    pool: Scored[],
    c: ScheduleConstraints,
    ctx: ToolContext,
    extra: SolveExtras = {}
): Promise<Awaited<ReturnType<typeof solveSchedule>> & { failedRequired?: string }> {
    const required = c.requiredCourses ?? [];
    const base: SolveExtras = {
        audit: ctx.audit,
        signal: ctx.signal,
        travel: ctx.travel,
        exempt: new Set(required),
        ...extra,
    };
    // Each must-have class gets a section, but committing to the single best-scoring section first can lock in a
    // worse WEEK (gaps, conflicts with better choices). So the first must-have tries its few best sections, each is
    // completed into a full schedule, and the best complete schedule wins; later must-haves are placed greedily.
    const trial = (fixed: SectionRecord[]) =>
        solveSchedule(pool, c, { ...base, fixed, maxNodes: 6_000, timeLimitMs: 2_000, keep: 1 });
    let failedRequired: string | undefined;
    let sets: SectionRecord[][] = [[...(extra?.fixed ?? [])]];
    for (const [position, code] of required.entries()) {
        const next: SectionRecord[][] = [];
        for (const fixed of sets) {
            if (fixed.some(x => normalizeCourseCode(x.courseCode) === code)) {
                next.push(fixed);
                continue;
            }
            const options = pool
                .filter(p => normalizeCourseCode(p.section.courseCode) === code && fitsWith(p.section, fixed))
                .sort((a, b) => b.score - a.score)
                .slice(0, 8);
            let kept = 0;
            for (const o of options) {
                if (!(await trial([...fixed, o.section])).best) continue;
                next.push([...fixed, o.section]);
                // breadth only for the first must-have; the rest are placed greedily
                if (++kept >= (position === 0 ? 4 : 1)) break;
            }
        }
        if (!next.length) {
            failedRequired = code;
            break;
        }
        sets = next;
    }
    const placements = failedRequired ? [] : sets;
    if (failedRequired) {
        const none = await solveSchedule([], c, base);
        return { ...none, failedRequired };
    }
    let best: Awaited<ReturnType<typeof solveSchedule>> | null = null;
    for (const fixed of placements.length ? placements : [[]]) {
        const result = await solveSchedule(pool, c, { ...base, fixed });
        if (result.best && (!best?.best || result.best.score > best.best.score)) best = result;
    }
    return best ?? solveSchedule(pool, c, { ...base, fixed: [] });
}

type Objective = 'gpa' | 'convenience' | 'degree';
const OBJECTIVE_LABEL: Record<Objective, string> = {
    gpa: 'GPA-first: highest expected grades',
    convenience: 'Convenience-first: tightest, most compact week',
    degree: 'Degree-progress-first: most requirement-filling classes',
};

/** Re-weights one candidate for an objective; the hard rules are untouched. */
function rescore(p: Scored, objective: Objective): Scored {
    const g = gpaScore(p.gpa ?? undefined);
    const score =
        objective === 'gpa'
            ? p.score + g
            : objective === 'convenience'
              ? p.score - g * 0.8
              : p.score + p.applies.length * 3;
    return { ...p, score };
}

/** The same request optimized three ways; only different, fully validated schedules are returned. */
async function alternativeSchedules(ctx: ToolContext, pool: Scored[], c: ScheduleConstraints, best: SectionRecord[]) {
    const key = (list: SectionRecord[]) =>
        list
            .map(s => s.uniqueId)
            .sort()
            .join(',');
    const seen = new Set([key(best)]);
    const out = [];
    const full: Array<{ label: string; objective: string; sections: SectionRecord[]; validation: ValidationReport }> =
        [];
    for (const objective of ['gpa', 'convenience', 'degree'] as Objective[]) {
        const rules = objective === 'convenience' ? { ...c, backToBack: true } : c;
        const run = await solveSchedule(
            pool.map(p => rescore(p, objective)),
            rules,
            { audit: ctx.audit, signal: ctx.signal, travel: ctx.travel, maxNodes: 60_000, timeLimitMs: 3_000, keep: 2 }
        );
        const pick = [run.best, ...run.alternatives].find(p => p && !seen.has(key(p.sections)));
        if (!pick) continue;
        const report = validatePlan(pick.sections, c, validationContext(ctx, pool));
        if (!report.hardOk) continue;
        seen.add(key(pick.sections));
        const byId = new Map(pool.map(p => [p.section.uniqueId, p]));
        const points = pick.sections
            .map(s => byId.get(s.uniqueId)?.gpa?.expectedGradePoints)
            .filter((x): x is number => x != null);
        full.push({ label: OBJECTIVE_LABEL[objective], objective, sections: pick.sections, validation: report });
        out.push({
            label: OBJECTIVE_LABEL[objective],
            totalCredits: pick.credits,
            gapMinutes: Math.round(pick.gapMinutes),
            averageExpectedGradePoints: points.length
                ? Number((points.reduce((a, b) => a + b, 0) / points.length).toFixed(2))
                : null,
            degreeClasses: pick.sections.filter(s => (byId.get(s.uniqueId)?.applies.length ?? 0) > 0).length,
            onlineClasses: pick.sections.filter(isAsync).length,
            allRulesPass: report.hardOk,
            classes: pick.sections.map(s => ({ code: s.courseCode, unique: pad(s.uniqueId), when: when(s) })),
        });
    }
    return { summaries: out, full };
}

/** Where the sections went: how many survive each rule, so an empty result says which rule emptied it. */
function funnel(ctx: ToolContext, c: ScheduleConstraints): string[] {
    const matcher = ctx.audit ? createDegreeMatcher(ctx.audit, { term: c.term }) : null;
    let cur = inTerm(ctx).filter(s => !ctx.taken.has(normalizeCourseCode(s.courseCode)));
    const stages: Array<[string, SectionRecord[]]> = [[`${ctx.term || 'cached'} sections not already taken`, cur]];
    const step = (label: string, keep: (s: SectionRecord) => boolean) => {
        cur = cur.filter(keep);
        stages.push([label, cur]);
    };
    step('meet your day, time and exclusion rules', s => !hardReason(s, c));
    step(matcher ? 'also fill a requirement your degree audit still needs' : 'also carry a Core designation', s =>
        matcher ? matcher(s).length > 0 : s.requirementTags.some(isCoreTag)
    );
    if (c.coreOnly)
        step('also fill an outstanding Core requirement', s =>
            (matcher ? matcher(s) : s.requirementTags).some(t => isCoreTag(t))
        );
    const lines: string[] = [];
    let flagged = false;
    for (const [label, list] of stages) {
        const courses = new Set(list.map(s => normalizeCourseCode(s.courseCode))).size;
        const dead = !flagged && list.length === 0;
        if (dead) flagged = true;
        lines.push(
            `${list.length.toLocaleString()} sections (${courses.toLocaleString()} courses) ${label}${dead ? ' ← nothing is left after this rule' : ''}`
        );
    }
    for (const subj of Object.keys(c.subjectCounts ?? {})) {
        const counts = stages.map(([, list]) => list.filter(s => subjectOf(s.courseCode) === subj).length);
        lines.push(`${subj} sections at each step above: ${counts.join(' → ')}`);
    }
    return lines;
}

/**
 * When nothing satisfies every rule: find the schedule that breaks the FEWEST (and gentlest) rules, searching
 * relaxations of one, two, then three rules for up to ~30 seconds. The result is shown as a draft and validated
 * against the ORIGINAL rules, so the report names exactly which rules it does not follow.
 */
async function bestEffort(args: Record<string, unknown>, ctx: ToolContext, c: ScheduleConstraints) {
    const rules = relaxations(c);
    const combos: Relaxation[][] = [[]];
    for (let i = 0; i < rules.length; i++) {
        combos.push([rules[i]!]);
        for (let j = i + 1; j < rules.length; j++) {
            combos.push([rules[i]!, rules[j]!]);
            for (let k = j + 1; k < rules.length; k++) combos.push([rules[i]!, rules[j]!, rules[k]!]);
        }
    }
    combos.splice(0, 1); // the unrelaxed search already failed
    const cost = (x: Relaxation[]) => x.reduce((n, r) => n + r.weight, 0);
    combos.sort((a, b) => a.length - b.length || cost(a) - cost(b));
    const deadline = Date.now() + 30_000;
    const pools = new Map<string, Scored[]>();
    let tried = 0;
    let level = 0;
    for (const combo of combos) {
        if (Date.now() > deadline || ctx.signal?.aborted) break;
        if (level && combo.length > level) break; // a gentler (fewer-rule) answer was already found
        let relaxed: ScheduleConstraints | null = c;
        for (const r of combo) relaxed = relaxed ? r.change(relaxed) : null;
        if (!relaxed) continue;
        tried++;
        ctx.onProgress?.(`No schedule fits every rule — searching the closest ones (${tried} combinations)…`);
        const key = JSON.stringify([
            relaxed.avoidDays,
            relaxed.coreOnly,
            Object.keys(relaxed.subjectCounts ?? {}),
            relaxed.maxOnline,
        ]);
        let pool = pools.get(key);
        if (!pool) {
            pool = await candidatePool(args, ctx, relaxed);
            pools.set(key, pool);
        }
        if (!pool.length) continue;
        const result = await solveWithRequired(pool, relaxed, ctx, { maxNodes: 80_000, timeLimitMs: 4_000 });
        if (!result.best) continue;
        level = combo.length;
        return { sections: result.best.sections, pool, relaxed, broken: combo.map(r => r.label), tried };
    }
    return { sections: null, tried };
}

async function build(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const checked = validateBuildArgs(rawArgs);
    if (!checked.ok) return badArguments(checked.issues);
    const args = checked.args;
    const c = withStated(constraintsFrom(args, ctx), ctx, args);
    ctx.onProgress?.('Finding classes that fit your rules…');
    const pool = await lap(ctx, 'pool', () => candidatePool(args, ctx, c));
    const required = Object.keys(c.subjectCounts ?? {});
    ctx.onProgress?.('Building a schedule that follows every rule…');
    const objective = ['gpa', 'convenience', 'degree'].includes(String(args.objective))
        ? (args.objective as Objective)
        : null;
    const ranked = objective ? pool.map(p => rescore(p, objective)) : pool;
    const result = pool.length
        ? await lap(ctx, 'solve', () =>
              solveWithRequired(ranked, objective === 'convenience' ? { ...c, backToBack: true } : c, ctx, {
                  maxNodes: 400_000,
                  timeLimitMs: 15_000,
              })
          )
        : null;
    if (!result?.best) {
        const reasons = [
            rulesSummary(c),
            ...(result?.failedRequired
                ? [`Could not place ${result.failedRequired}: none of its sections fit with the rest of your rules.`]
                : []),
            ...funnel(ctx, c),
            ...(result?.report?.reasons ?? []),
        ];
        const degreeIssues = evaluateDegree(ctx.audit, [], { term: ctx.term, now: ctx.now }).issues.slice(0, 2);
        const near = await bestEffort(args, ctx, c);
        if (near.sections && near.pool && near.relaxed) {
            const report = validatePlan(near.sections, c, validationContext(ctx, near.pool));
            const description = await describePlan(ctx, near.sections, near.pool, near.relaxed, required, report);
            return {
                result: {
                    ...description,
                    incomplete: true,
                    notice: `No schedule follows every rule, so this is the closest one I found after checking ${near.tried} rule combinations. It is a draft on your calendar, not a schedule that meets your rules.`,
                    rulesItDoesNotFollow: near.broken,
                    reasons: [...reasons, ...degreeIssues],
                    note: 'Your original rules stay in place for the next request. Nothing was registered or saved.',
                },
                plan: {
                    sections: near.sections,
                    note: `Closest schedule found — does not follow: ${near.broken.join('; ')}. ${verdictText(report)}`,
                    constraints: c,
                    pool: near.pool,
                    validation: report,
                },
            };
        }
        return {
            result: {
                error: 'I couldn’t build any schedule from the cached sections, even after relaxing up to three rules.',
                reasons: [...reasons, ...degreeIssues],
                suggestions: [
                    'Import or refresh the requested semester’s course list and your current IDA.',
                    'The line marked “nothing is left after this rule” is the rule that emptied the list.',
                ],
                note: `Checked ${near.tried} rule combinations.`,
            },
        };
    }
    const report = validatePlan(result.best.sections, c, validationContext(ctx, pool));
    if (!report.hardOk)
        return {
            result: {
                error: 'The solver’s schedule failed independent validation and was discarded.',
                failures: report.failures,
            },
        };
    if (ctx.isStale?.()) return { result: { error: 'A newer instruction arrived; this result was discarded.' } };
    const description = await lap(ctx, 'describe+backups', () =>
        describePlan(ctx, result.best!.sections, pool, c, required, report)
    );
    const alternatives = await lap(ctx, 'alternatives', () =>
        alternativeSchedules(ctx, pool, c, result.best!.sections)
    );
    const byId = new Map(pool.map(p => [p.section.uniqueId, p]));
    const recommendedPoints = result.best.sections
        .map(s => byId.get(s.uniqueId)?.gpa?.expectedGradePoints)
        .filter((x): x is number => x != null);
    const recommended = {
        label: 'Recommended',
        totalCredits: result.best.credits,
        gapMinutes: Math.round(result.best.gapMinutes),
        averageExpectedGradePoints: recommendedPoints.length
            ? Number((recommendedPoints.reduce((a, b) => a + b, 0) / recommendedPoints.length).toFixed(2))
            : null,
        degreeClasses: result.best.sections.filter(s => (byId.get(s.uniqueId)?.applies.length ?? 0) > 0).length,
        onlineClasses: result.best.sections.filter(isAsync).length,
    };
    return {
        result: {
            ...description,
            understood: rulesSummary(c),
            recommended,
            alternatives: alternatives.summaries,
        },
        plan: {
            sections: result.best.sections,
            note: `Built from ${pool.length} real UT sections. ${verdictText(report)}`,
            constraints: c,
            pool,
            validation: report,
            alternatives: alternatives.full,
        },
    };
}

/**
 * "Find me an easier professor for economics": keep the course and the rest of the week, change only which
 * section (and so which instructor) it is. Candidates are real sections of the same course that fit around
 * the other classes; they are ranked by the confidence-aware GPA outlook (and Rate My Professors when
 * available). If nothing is genuinely better the schedule is left alone and the numbers are shown.
 */
async function swapSection(
    args: Record<string, unknown>,
    ctx: ToolContext,
    c: ScheduleConstraints
): Promise<ToolOutcome> {
    const current = ctx.current!;
    const code =
        resolveCourseCode(String(args.swapSectionFor), current.sections, ctx.subjectIndex) ??
        resolveCourseCode(String(args.swapSectionFor), inTerm(ctx), ctx.subjectIndex);
    const target = current.sections.find(s => normalizeCourseCode(s.courseCode) === code);
    if (!code || !target)
        return {
            result: {
                error: `“${String(args.swapSectionFor)}” is not one of the classes on your schedule, so there is no section to swap. The calendar is unchanged.`,
            },
        };
    const goal = String(args.sectionGoal ?? 'easier');
    const rest = current.sections.filter(s => s.uniqueId !== target.uniqueId);
    const extra = await candidatePool(
        { preferCourses: [code], prioritizeGrades: true, prioritizeRatings: goal !== 'easier' },
        ctx,
        { ...c, requiredCourses: [code] }
    );
    const pool = [...(current.pool as Scored[])];
    for (const e of extra) if (!pool.some(p => p.section.uniqueId === e.section.uniqueId)) pool.push(e);
    const byId = new Map(pool.map(p => [p.section.uniqueId, p]));
    const outlook = (s: SectionRecord) => byId.get(s.uniqueId)?.gpa?.rankValue ?? null;
    const who = (s: SectionRecord) => s.instructors.join(', ') || 'TBA';
    const sameCourse = pool
        .map(p => p.section)
        .filter(s => normalizeCourseCode(s.courseCode) === code && s.uniqueId !== target.uniqueId);
    const ratings = new Map<string, number | null>();
    for (const s of [target, ...sameCourse]) {
        const r = await rating(ctx, s.instructors[0]);
        ratings.set(s.instructors[0] ?? '', r && typeof r.quality === 'number' && r.ratings >= 3 ? r.quality : null);
    }
    const goalValue = (s: SectionRecord) => {
        const g = outlook(s);
        const r = ratings.get(s.instructors[0] ?? '') ?? null;
        if (goal === 'better rated') return r ?? -Infinity;
        return g ?? -Infinity;
    };
    const strict = goal === 'easier' || goal === 'better rated';
    const startOf = (s: SectionRecord) => Math.min(...s.meetings.map(m => m.start));
    const endOf = (s: SectionRecord) => Math.max(...s.meetings.map(m => m.end));
    const online = (s: SectionRecord) => s.modality === 'async-online' || s.modality === 'live-online';
    const meets = (s: SectionRecord) =>
        goal === 'online'
            ? online(s)
            : goal === 'in-person'
              ? !online(s)
              : goal === 'earlier'
                ? s.meetings.length > 0 && target.meetings.length > 0 && endOf(s) < endOf(target)
                : goal === 'later'
                  ? s.meetings.length > 0 && target.meetings.length > 0 && startOf(s) > startOf(target)
                  : true;
    const fits = sameCourse.filter(
        s =>
            !hardReason(s, c) &&
            fitsWith(s, rest) &&
            (strict ? who(s) !== who(target) && goalValue(s) > goalValue(target) : meets(s))
    );
    const options = [...fits].sort((a, b) => goalValue(b) - goalValue(a));
    const describe = (s: SectionRecord) => ({
        unique: pad(s.uniqueId),
        instructor: who(s),
        when: when(s),
        gpaOutlook: outlook(s) != null ? Number(outlook(s)!.toFixed(2)) : 'no grade data',
        rateMyProfessors: ratings.get(s.instructors[0] ?? '') ?? 'none on file',
    });
    const best = options[0];
    if (!best)
        return {
            result: {
                error: strict
                    ? `No other ${code} section both fits around your other classes and has a better ${goal === 'easier' ? 'grade outlook' : 'rating'} than ${who(target)}. The calendar is unchanged.`
                    : `No other ${code} section is ${goal} and fits around your other classes and rules. The calendar is unchanged.`,
                current: describe(target),
                otherSections: sameCourse.slice(0, 6).map(describe),
            },
        };
    const sections = current.sections.map(s => (s.uniqueId === target.uniqueId ? best : s));
    const report = validatePlan(sections, c, validationContext(ctx, pool));
    if (!report.hardOk)
        return {
            result: {
                error: 'The swapped schedule failed validation; the calendar is unchanged.',
                failures: report.failures,
            },
        };
    const description = await describePlan(ctx, sections, pool, c, [], report);
    return {
        result: {
            ...description,
            changed: {
                removed: [`${target.courseCode} (${pad(target.uniqueId)}, ${who(target)})`],
                added: [`${best.courseCode} (${pad(best.uniqueId)}, ${who(best)})`],
            },
            understood: rulesSummary(c),
        },
        plan: {
            sections,
            note: `Swapped ${code} to section ${pad(best.uniqueId)} (${who(best)}). ${verdictText(report)}`,
            constraints: c,
            pool,
            validation: report,
        },
    };
}

async function modify(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const checked = validateModifyArgs(rawArgs);
    if (!checked.ok) return badArguments(checked.issues);
    const args = { ...checked.args };
    // A section goal ("easier", "online"…) on a class that is already on the schedule can only mean "same course,
    // different section" — the model named the right class and goal but picked the wrong argument for it.
    if (args.sectionGoal && !args.swapSectionFor && ctx.current) {
        const named = String(args.addCourse ?? args.replaceCourse ?? '');
        const code = named ? resolveCourseCode(named, ctx.current.sections, ctx.subjectIndex) : null;
        if (code && ctx.current.sections.some(s => normalizeCourseCode(s.courseCode) === code)) {
            args.swapSectionFor = code;
            args.addCourse = undefined;
            args.replaceCourse = undefined;
        }
    }
    if (!ctx.current?.sections.length)
        return { result: { error: 'There is no schedule on screen yet; call build_schedule first.' } };
    // earlier rules carry over; only what this change mentions is edited
    // The constraints already on screen are the source of truth for a follow-up: keyword matching over the chat is
    // never layered on top (it could re-apply an old phrase and silently overwrite a rule the student kept).
    let c = withStated(constraintsFrom(args, ctx, ctx.current.constraints), { ...ctx, stated: undefined }, args);
    const another = !!args.anotherOption;
    if (another)
        c = {
            ...c,
            excludedSections: [
                ...new Set([...(c.excludedSections ?? []), ...ctx.current.sections.map(s => s.uniqueId)]),
            ],
        };
    if (args.swapSectionFor) return swapSection(args, ctx, c);
    const removeList = strings(args.remove);
    const removedCourses = removeList.filter(x => /\d/.test(x)).map(normalizeCourseCode);
    const removedSubjects = removeList.filter(x => !/\d/.test(x)).map(x => x.toUpperCase());
    // "drop the signature course": removing the class that satisfied an exact subject count lowers that count too,
    // otherwise the old "exactly one UGS" rule would make the request impossible
    const subjectCounts = { ...(c.subjectCounts ?? {}) };
    for (const subj of Object.keys(subjectCounts)) {
        const gone = removedSubjects.includes(subj) || removedCourses.some(x => subjectOf(x) === subj);
        if (gone && !('exactCounts' in args))
            subjectCounts[subj] = removedSubjects.includes(subj)
                ? 0 // the whole subject is being dropped
                : ctx.current.sections.filter(
                      s =>
                          subjectOf(s.courseCode) === subj &&
                          !removedCourses.includes(normalizeCourseCode(s.courseCode))
                  ).length;
    }
    c = {
        ...c,
        subjectCounts,
        excludedCourses: [...new Set([...c.excludedCourses, ...removedCourses])],
        // a class that is being removed or swapped for a different course is no longer a must-have
        requiredCourses: (c.requiredCourses ?? []).filter(
            r =>
                !removedCourses.includes(r) &&
                r !==
                    (args.replaceCourse
                        ? (resolveCourseCode(String(args.replaceCourse), inTerm(ctx), ctx.subjectIndex) ??
                          normalizeCourseCode(String(args.replaceCourse)))
                        : '')
        ),
        excludedSubjects: [...new Set([...c.excludedSubjects, ...removedSubjects])],
    };
    let pool = ctx.current.pool as Scored[];
    if (another) pool = await candidatePool({ prioritizeGrades: true }, ctx, c);
    const addSubject = String(args.addSubject ?? '').toUpperCase();
    const nameOf = (text: unknown) =>
        resolveCourseCode(String(text), inTerm(ctx), ctx.subjectIndex) ?? normalizeCourseCode(String(text));
    const addCourse = args.addCourse ? nameOf(args.addCourse) : '';
    if (addSubject || addCourse) {
        const extra = await candidatePool(
            { ...args, includeSubjects: addSubject ? [addSubject] : [], preferCourses: addCourse ? [addCourse] : [] },
            ctx,
            c
        );
        pool = [...pool, ...extra.filter(e => !pool.some(p => p.section.uniqueId === e.section.uniqueId))];
    }
    const keep = another ? [] : ctx.current.sections.filter(s => !hardReason(s, c));
    const replace = args.replaceCourse ? nameOf(args.replaceCourse) : '';
    const target = replace ? ctx.current.sections.find(s => normalizeCourseCode(s.courseCode) === replace) : undefined;
    let fixed: SectionRecord[] = [];
    if (addCourse) {
        const listed = inTerm(ctx).filter(x => normalizeCourseCode(x.courseCode) === addCourse);
        if (!listed.length)
            return {
                result: {
                    error: `No ${ctx.term || 'listed'} course matches “${String(args.addCourse)}” in the cached course list. The calendar is unchanged.`,
                    reasons: ['Check the spelling, or search by subject (for example NTR) to see what is listed.'],
                },
            };
        // "add X" means X must be on the schedule: it becomes a must-have and the rest is re-optimized around it.
        // The credit range is never changed silently — if X only fits by going over, the student is asked.
        c = { ...c, requiredCourses: [...new Set([...(c.requiredCourses ?? []), addCourse])] };
    }
    if (addSubject) {
        const wanted = pool
            .filter(p => subjectOf(p.section.courseCode) === addSubject)
            .filter(p =>
                fitsWith(
                    p.section,
                    keep.filter(k => k !== target)
                )
            )
            .sort((a, b) => b.score - a.score)[0];
        if (!wanted)
            return {
                result: {
                    error: `No ${addSubject} class can join the schedule around the classes being kept. The calendar is unchanged.`,
                    reasons: [
                        'Remove or replace a conflicting class (say which), or relax a rule, and I will try again.',
                    ],
                },
            };
        fixed = [wanted.section];
    }
    const reason = String(args.replaceReason ?? 'any');
    const intent = refineIntent(reason === 'better professor' ? 'better professor' : reason);
    const gradeOf = (s: SectionRecord) =>
        (pool as Scored[]).find(p => p.section.uniqueId === s.uniqueId)?.grade?.percent ?? null;
    const objective = ['gpa', 'convenience', 'degree'].includes(String(args.objective))
        ? (args.objective as Objective)
        : null;
    const result = await solveWithRequired(
        pool
            .filter(
                p =>
                    p.section.uniqueId !== target?.uniqueId &&
                    !(replace && normalizeCourseCode(p.section.courseCode) === replace)
            )
            .map(p => (objective ? rescore(p, objective) : p)),
        c,
        ctx,
        {
            fixed,
            stable: another ? undefined : new Set(keep.filter(k => k !== target).map(k => k.uniqueId)),
            allowNew: target
                ? s => replacementFits(s, target, intent, gradeOf) || reason === 'any' || reason === 'better professor'
                : undefined,
        }
    );
    if (!result.best && addCourse) {
        const widened = { ...c, maxCredits: c.maxCredits + 3 };
        const wide = await solveWithRequired(
            pool.filter(p => p.section.uniqueId !== target?.uniqueId),
            widened,
            ctx,
            { fixed, stable: new Set(keep.filter(k => k !== target).map(k => k.uniqueId)) }
        );
        if (wide.best)
            return {
                result: {
                    error: `${addCourse} can only be added by going to ${wide.best.credits} credit hours (you asked for ${c.minCredits}–${c.maxCredits}), or by dropping a class you said to keep. The calendar is unchanged.`,
                    closestAlternatives: [
                        {
                            requiresPermissionTo: `Allow up to ${widened.maxCredits} credit hours`,
                            notOnCalendar: true,
                            totalCredits: wide.best.credits,
                            classes: wide.best.sections.map(x => ({
                                code: x.courseCode,
                                unique: pad(x.uniqueId),
                                when: when(x),
                                credits: x.creditHours,
                            })),
                        },
                    ],
                },
            };
    }
    if (!result.best)
        return {
            result: {
                error: 'That change leaves no complete schedule that follows every rule. The calendar is unchanged.',
                reasons: [
                    ...(result.report?.reasons ?? []),
                    ...evaluateDegree(ctx.audit, [], { term: ctx.term, now: ctx.now }).issues.slice(0, 2),
                ],
            },
        };
    const report = validatePlan(result.best.sections, c, validationContext(ctx, pool));
    if (!report.hardOk)
        return {
            result: {
                error: 'The changed schedule failed independent validation and was discarded; the calendar is unchanged.',
                failures: report.failures,
            },
        };
    if (ctx.isStale?.()) return { result: { error: 'A newer instruction arrived; this result was discarded.' } };
    const description = await describePlan(
        ctx,
        result.best.sections,
        pool as Scored[],
        c,
        addSubject ? [addSubject] : [],
        report
    );
    const before = new Set(ctx.current.sections.map(s => s.uniqueId));
    const after = new Set(result.best.sections.map(s => s.uniqueId));
    return {
        result: {
            ...description,
            understood: rulesSummary(c),
            changed: {
                removed: ctx.current.sections
                    .filter(s => !after.has(s.uniqueId))
                    .map(s => `${s.courseCode} (${pad(s.uniqueId)})`),
                added: result.best.sections
                    .filter(s => !before.has(s.uniqueId))
                    .map(s => `${s.courseCode} (${pad(s.uniqueId)})`),
            },
        },
        plan: {
            sections: result.best.sections,
            note: `Updated as asked; other classes kept where they still fit. ${verdictText(report)}`,
            constraints: c,
            pool,
            validation: report,
        },
    };
}

function graduation(args: Record<string, unknown>, ctx: ToolContext) {
    const target =
        parseTerm(String(args.target ?? '')) ??
        (ctx.model.targetGraduation ? parseTerm(ctx.model.targetGraduation.value) : null);
    if (!target) return { error: 'No target term given or saved; ask which term the student wants to graduate in.' };
    const summers = strings(args.summerCredits)
        .map(Number)
        .filter(n => Number.isFinite(n) && n > 0);
    const plan = graduationPlan(ctx.model, target, summers.length ? { summerHours: [0, ...summers] } : {});
    if ('missing' in plan) return { error: plan.missing };
    return {
        currentTerm: termName(plan.current),
        target: termName(plan.target),
        fallSpringSemestersLeft: plan.longTerms.map(termName),
        summersBeforeThen: plan.summers.map(termName),
        creditsRemaining: plan.remaining,
        averagePerSemester: plan.scenarios,
        notes: plan.notes,
        readyAnswer: graduationAnswer(plan, ctx.model),
    };
}

export const TOOL_LABELS: Record<string, string> = {
    get_student_profile: 'Reading your degree audit…',
    search_courses: 'Searching UT courses…',
    get_course_sections: 'Looking up sections…',
    get_professor: 'Checking professor ratings and grades…',
    build_schedule: 'Building your schedule…',
    modify_schedule: 'Updating your schedule…',
    graduation_plan: 'Working out your graduation math…',
    remember: 'Saving that…',
};

/** Runs one tool call. Errors come back as results so the model can explain or try something else. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    try {
        switch (name) {
            case 'get_student_profile':
                return { result: profile(ctx) };
            case 'search_courses':
                return { result: await searchCourses(args, ctx) };
            case 'get_course_sections':
                return { result: await courseSections(args, ctx) };
            case 'get_professor':
                return { result: await professor(args, ctx) };
            case 'build_schedule':
                return await build(args, ctx);
            case 'modify_schedule':
                return await modify(args, ctx);
            case 'graduation_plan':
                return { result: graduation(args, ctx) };
            case 'remember': {
                const fact = String(args.fact ?? '')
                    .trim()
                    .slice(0, 160);
                if (fact) await ctx.remember(fact);
                return { result: { saved: fact } };
            }
            default:
                return { result: { error: `Unknown tool ${name}` } };
        }
    } catch (e) {
        if (ctx.signal?.aborted) throw e;
        return { result: { error: e instanceof Error ? e.message : 'The tool failed.' } };
    }
}
