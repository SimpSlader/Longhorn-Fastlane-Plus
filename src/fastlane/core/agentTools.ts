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
import { createDegreeMatcher, evaluateDegree } from './degreeRules';
import { estimateGpa, type GpaEstimate } from './gpaModel';
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
    const degreeMatch = ctx.audit ? createDegreeMatcher(ctx.audit, { term: ctx.term, now: ctx.now }) : null;
    const sections = inTerm(ctx).filter(s => {
        if (subject && subjectOf(s.courseCode) !== subject) return false;
        if (query && !`${s.courseCode} ${s.title}`.toLowerCase().includes(query)) return false;
        if (args.onlineOnly && !(isAsync(s) || s.modality === 'live-online')) return false;
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
    const code = normalizeCourseCode(String(args.course ?? ''));
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

function constraintsFrom(
    args: Record<string, unknown>,
    ctx: ToolContext,
    base?: ScheduleConstraints
): ScheduleConstraints {
    const only = days(args.onlyDays ?? args.changeOnlyDays);
    const credits = (args.changeCredits as { min?: number; max?: number } | undefined) ?? {};
    const minC = Math.max(
        MIN_CREDITS,
        Number(args.minCredits ?? credits.min ?? base?.minCredits ?? MIN_CREDITS) || MIN_CREDITS
    );
    const maxC = Math.max(minC, Number(args.maxCredits ?? credits.max ?? base?.maxCredits ?? 16) || 16);
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
        dayLimits: base?.dayLimits ?? {},
        coreOnly: args.coreOnly != null ? !!args.coreOnly : (base?.coreOnly ?? false),
        subjectCounts: counts,
        maxOnline: onlineMax != null ? onlineMax : base?.maxOnline,
        excludedSections: base?.excludedSections ?? [],
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
    for (const code of strings(args.preferCourses).map(normalizeCourseCode)) {
        const list = eligible.filter(s => normalizeCourseCode(s.courseCode) === code);
        if (list.length)
            add(
                await chooseAiCandidates({ ...input, sections: list, subject: '' }, ctx.gradeStat, {
                    ...opts,
                    limit: 10,
                })
            );
    }
    const prefer = new Set(strings(args.preferCourses).map(normalizeCourseCode));
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
function withStated(c: ScheduleConstraints, ctx: ToolContext): ScheduleConstraints {
    const merged = ctx.stated ? enforceStated(c, ctx.stated) : c;
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

type Relaxation = { label: string; change: (c: ScheduleConstraints) => ScheduleConstraints | null };

/** The one-rule-at-a-time relaxations offered (never applied) when no schedule satisfies everything. */
function relaxations(c: ScheduleConstraints): Relaxation[] {
    const out: Relaxation[] = [];
    const extraDay = (['W', 'M', 'F'] as DayCode[]).find(d => c.avoidDays.includes(d));
    if (extraDay)
        out.push({
            label: `Allow ${({ W: 'Wednesday', M: 'Monday', F: 'Friday' } as Record<string, string>)[extraDay]} classes`,
            change: x => ({ ...x, avoidDays: x.avoidDays.filter(d => d !== extraDay) }),
        });
    if (c.maxGapMinutes != null)
        out.push({
            label: `Allow gaps up to ${Math.max(60, c.maxGapMinutes + 15)} minutes`,
            change: x => ({ ...x, maxGapMinutes: Math.max(60, c.maxGapMinutes! + 15) }),
        });
    if (c.minCredits > MIN_CREDITS)
        out.push({
            label: `Try ${MIN_CREDITS}–${c.maxCredits} credits while keeping your other rules`,
            change: x => ({ ...x, minCredits: MIN_CREDITS }),
        });
    if (c.coreOnly)
        out.push({ label: 'Allow classes that do not count toward core', change: x => ({ ...x, coreOnly: false }) });
    if (c.maxOnline != null)
        out.push({
            label: `Allow ${c.maxOnline + 1} asynchronous online classes`,
            change: x => ({ ...x, maxOnline: c.maxOnline! + 1 }),
        });
    out.push({
        label: `Widen credits to ${Math.max(MIN_CREDITS, c.minCredits - 1)}–${c.maxCredits + 1}`,
        change: x => ({ ...x, minCredits: Math.max(MIN_CREDITS, c.minCredits - 1), maxCredits: c.maxCredits + 1 }),
    });
    if (Object.keys(c.subjectCounts ?? {}).length)
        out.push({
            label: `Drop the exact-count rule (${Object.entries(c.subjectCounts!)
                .map(([k, n]) => `${n} ${k}`)
                .join(', ')})`,
            change: x => ({ ...x, subjectCounts: {} }),
        });
    if (c.checkTravel !== false)
        out.push({
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

async function build(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const checked = validateBuildArgs(rawArgs);
    if (!checked.ok) return badArguments(checked.issues);
    const args = checked.args;
    const c = withStated(constraintsFrom(args, ctx), ctx);
    ctx.onProgress?.('Finding classes that fit your rules…');
    const pool = await candidatePool(args, ctx, c);
    if (!pool.length)
        return {
            result: {
                error: 'No eligible cached sections were found for this request.',
                reasons: [
                    'The selected semester, unmet degree requirements, and your course filters left no eligible options.',
                    ...evaluateDegree(ctx.audit, [], { term: ctx.term, now: ctx.now }).issues.slice(0, 2),
                ],
                suggestions: [
                    'Import or refresh the requested semester’s course list and a current IDA.',
                    'Check that the IDA still has unmet core hours, including a signature course.',
                ],
            },
        };
    const required = Object.keys(c.subjectCounts ?? {});
    ctx.onProgress?.('Building a schedule that follows every rule…');
    const result = await solveSchedule(pool, c, { audit: ctx.audit, signal: ctx.signal, travel: ctx.travel });
    if (!result.best) {
        const alternatives = await closestAlternatives(args, ctx, c);
        return {
            result: {
                error: 'I couldn’t find a complete schedule meeting all of your rules in the cached sections.',
                reasons: [
                    ...(result.report?.reasons ?? []),
                    ...evaluateDegree(ctx.audit, [], { term: ctx.term, now: ctx.now }).issues.slice(0, 2),
                ],
                suggestions: alternatives.length
                    ? []
                    : [
                          'Import or refresh the requested semester’s course list and your current IDA.',
                          'Ask for a lower credit load or a wider gap limit; your core-only, day and UGS requirements will stay in place unless you change them.',
                      ],
                closestAlternatives: alternatives,
                note: alternatives.length
                    ? 'Each alternative breaks exactly one rule and needs the student’s permission; none is on the calendar.'
                    : 'No single relaxed rule produced a valid schedule either.',
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
    const description = await describePlan(ctx, result.best.sections, pool, c, required, report);
    return {
        result: description,
        plan: {
            sections: result.best.sections,
            note: `Built from ${pool.length} real UT sections. ${verdictText(report)}`,
            constraints: c,
            pool,
            validation: report,
        },
    };
}

async function modify(rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const checked = validateModifyArgs(rawArgs);
    if (!checked.ok) return badArguments(checked.issues);
    const args = checked.args;
    if (!ctx.current?.sections.length)
        return { result: { error: 'There is no schedule on screen yet; call build_schedule first.' } };
    // earlier rules carry over; only what this change mentions is edited
    let c = withStated(constraintsFrom(args, ctx, ctx.current.constraints), ctx);
    const another = !!args.anotherOption;
    if (another)
        c = {
            ...c,
            excludedSections: [
                ...new Set([...(c.excludedSections ?? []), ...ctx.current.sections.map(s => s.uniqueId)]),
            ],
        };
    const removeList = strings(args.remove);
    const removedCourses = removeList.filter(x => /\d/.test(x)).map(normalizeCourseCode);
    const removedSubjects = removeList.filter(x => !/\d/.test(x)).map(x => x.toUpperCase());
    c = {
        ...c,
        excludedCourses: [...new Set([...c.excludedCourses, ...removedCourses])],
        excludedSubjects: [...new Set([...c.excludedSubjects, ...removedSubjects])],
    };
    let pool = ctx.current.pool as Scored[];
    if (another) pool = await candidatePool({ prioritizeGrades: true }, ctx, c);
    const addSubject = String(args.addSubject ?? '').toUpperCase();
    const addCourse = args.addCourse ? normalizeCourseCode(String(args.addCourse)) : '';
    if (addSubject || addCourse) {
        const extra = await candidatePool(
            { ...args, includeSubjects: addSubject ? [addSubject] : [], preferCourses: addCourse ? [addCourse] : [] },
            ctx,
            c
        );
        pool = [...pool, ...extra.filter(e => !pool.some(p => p.section.uniqueId === e.section.uniqueId))];
    }
    const keep = another ? [] : ctx.current.sections.filter(s => !hardReason(s, c));
    const replace = args.replaceCourse ? normalizeCourseCode(String(args.replaceCourse)) : '';
    const target = replace ? ctx.current.sections.find(s => normalizeCourseCode(s.courseCode) === replace) : undefined;
    let fixed: SectionRecord[] = [];
    if (addSubject || addCourse) {
        const wanted = pool
            .filter(p =>
                addCourse
                    ? normalizeCourseCode(p.section.courseCode) === addCourse
                    : subjectOf(p.section.courseCode) === addSubject
            )
            .filter(p =>
                fitsWith(
                    p.section,
                    keep.filter(k => k !== target)
                )
            )
            .sort((a, b) => b.score - a.score)[0];
        if (wanted) {
            fixed = [wanted.section];
            // adding a class is the one change that may need more room; it still has to pass every other rule
            c = {
                ...c,
                maxCredits: Math.max(
                    c.maxCredits,
                    keep.reduce((n, s) => n + s.creditHours, 0) + wanted.section.creditHours
                ),
            };
        }
    }
    const reason = String(args.replaceReason ?? 'any');
    const intent = refineIntent(reason === 'better professor' ? 'better professor' : reason);
    const gradeOf = (s: SectionRecord) =>
        (pool as Scored[]).find(p => p.section.uniqueId === s.uniqueId)?.grade?.percent ?? null;
    const result = await solveSchedule(
        pool.filter(
            p =>
                p.section.uniqueId !== target?.uniqueId &&
                !(replace && normalizeCourseCode(p.section.courseCode) === replace)
        ),
        c,
        {
            fixed,
            stable: another ? undefined : new Set(keep.filter(k => k !== target).map(k => k.uniqueId)),
            allowNew: target
                ? s => replacementFits(s, target, intent, gradeOf) || reason === 'any' || reason === 'better professor'
                : undefined,
            audit: ctx.audit,
            signal: ctx.signal,
            travel: ctx.travel,
        }
    );
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
