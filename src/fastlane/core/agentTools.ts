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
import type { GradeStat } from './grades';
import { graduationAnswer, graduationPlan, parseTerm, termName } from './graduation';
import type { DayCode } from './meetings';
import { formatMeeting } from './meetings';
import { checkPrerequisites } from './prerequisites';
import { fitsWith, refineIntent, replacementFits } from './proposal';
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
}

export interface ToolOutcome {
    /** what the model sees (kept small) */
    result: unknown;
    /** a schedule to put on the calendar */
    plan?: { sections: SectionRecord[]; note: string; constraints: ScheduleConstraints; pool: SolverCandidate[] };
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
        .map(([code, list]) => ({ code, list, applies: list[0]!.requirementTags.filter(t => open.has(t)) }))
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
    const prereq = checkPrerequisites(list[0]!.prerequisites, ctx.taken, ctx.subjectIndex);
    return {
        course: code,
        title: list[0]!.title,
        credits: list[0]!.creditHours,
        alreadyTakenOrInProgress: ctx.taken.has(code),
        countsToward: list[0]!.requirementTags.filter(t => ctx.outstanding.includes(t)),
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
    };
}

interface Scored extends SolverCandidate {
    grade: { percent: number; sample: number } | null;
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
        active: [],
        avoidFriday: false,
        preferAsync: (c.online?.min ?? 0) > 0,
        subjectIndex: ctx.subjectIndex,
    };
    const opts = {
        signal: ctx.signal,
        onProgress: ctx.onProgress,
        limit: 90,
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
    for (const subj of strings(args.includeSubjects).map(x => x.toUpperCase()))
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
        const g = grades.get(x.section.uniqueId)?.result;
        let score = scoreSection({
            applies: x.applies,
            coreFocus: !!args.coreFocus,
            gradePercent: g?.percent ?? null,
            gradeSample: g?.graded ?? 0,
            easyGrades: args.prioritizeGrades !== false,
            aiPicked: false,
            creditHours: x.section.creditHours,
            courseCode: x.section.courseCode,
            prerequisite: x.prerequisite.status,
        });
        if (prefer.has(normalizeCourseCode(x.section.courseCode))) score += 15;
        // professor quality counts too: look up the best-ranked candidates' ratings (cached per name)
        if (args.prioritizeRatings && ctx.rmp && i < 40) {
            const who = x.section.instructors[0] ?? '';
            if (!ratingCache.has(who)) ratingCache.set(who, await rating(ctx, who));
            const r = ratingCache.get(who);
            if (r && typeof r.quality === 'number' && r.ratings >= 5) score += (r.quality - 3.5) * 6;
        }
        out.push({
            section: x.section,
            applies: x.applies,
            prerequisite: x.prerequisite.status,
            score,
            grade: g ? { percent: Math.round(g.percent), sample: g.graded } : null,
        });
    }
    return out;
}

async function describePlan(
    ctx: ToolContext,
    sections: SectionRecord[],
    pool: Scored[],
    c: ScheduleConstraints,
    requested: string[]
) {
    const bySection = new Map(pool.map(p => [p.section.uniqueId, p]));
    const classes = [];
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
            rateMyProfessors: await rating(ctx, s.instructors[0]),
            countsToward: p?.applies ?? [],
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
        taken: ctx.taken,
        gradeOf: s => gradeMap.get(s.uniqueId) ?? null,
        sectionCounts: sectionCounts(inTerm(ctx)),
    });
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
        classes,
        backups: {
            perClass: await Promise.all(
                backups.perClass.map(async g => ({
                    for: g.for.courseCode,
                    options: await Promise.all(g.backups.map(brief)),
                }))
            ),
            general: await Promise.all(backups.general.map(brief)),
        },
        rulesFollowed: {
            credits: `${c.minCredits}–${c.maxCredits}`,
            noClassesOn: c.avoidDays,
            online: c.online,
            backToBack: c.backToBack,
            excludedSubjects: c.excludedSubjects,
        },
        couldNotInclude: missing.length
            ? missing.map(subj => `${subj}: no listed section fits around the rest of the rules`)
            : [],
        note: 'Seats are not checked live; confirm on UT’s course schedule. Shown on the student’s calendar with backups.',
    };
}

async function build(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const c = constraintsFrom(args, ctx);
    ctx.onProgress?.('Finding classes that fit your rules…');
    const pool = await candidatePool(args, ctx, c);
    if (!pool.length)
        return {
            result: {
                error: 'No listed UT sections fit these rules. UT’s course list may not be imported for the semester.',
            },
        };
    const required = strings(args.includeSubjects).map(x => x.toUpperCase());
    ctx.onProgress?.('Building a schedule that follows every rule…');
    // each required subject's best sections are tried as fixed choices until the rest of the week can be built
    let fixed: SectionRecord[] = [];
    for (const subj of required) {
        const options = pool
            .filter(p => subjectOf(p.section.courseCode) === subj && fitsWith(p.section, fixed))
            .sort((a, b) => b.score - a.score)
            .slice(0, 4);
        for (const o of options) {
            const trial = await solveSchedule(pool, c, {
                fixed: [...fixed, o.section],
                signal: ctx.signal,
                maxNodes: 4000,
            });
            if (trial.best) {
                fixed = [...fixed, o.section];
                break;
            }
        }
    }
    const result = await solveSchedule(pool, c, { fixed, signal: ctx.signal });
    if (!result.best)
        return {
            result: {
                error: 'No complete schedule follows all of these rules.',
                reasons: result.report?.reasons ?? [],
                suggestions: result.report?.suggestions.map(s => s.text) ?? [],
            },
        };
    const description = await describePlan(ctx, result.best.sections, pool, c, required);
    return {
        result: description,
        plan: {
            sections: result.best.sections,
            note: `Built from ${pool.length} real UT sections.`,
            constraints: c,
            pool,
        },
    };
}

async function modify(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    if (!ctx.current?.sections.length)
        return { result: { error: 'There is no schedule on screen yet; call build_schedule first.' } };
    let c = constraintsFrom(args, ctx, ctx.current.constraints);
    const removeList = strings(args.remove);
    const removedCourses = removeList.filter(x => /\d/.test(x)).map(normalizeCourseCode);
    const removedSubjects = removeList.filter(x => !/\d/.test(x)).map(x => x.toUpperCase());
    c = {
        ...c,
        excludedCourses: [...new Set([...c.excludedCourses, ...removedCourses])],
        excludedSubjects: [...new Set([...c.excludedSubjects, ...removedSubjects])],
    };
    let pool = ctx.current.pool as Scored[];
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
    const keep = ctx.current.sections.filter(s => !hardReason(s, c));
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
            stable: new Set(keep.filter(k => k !== target).map(k => k.uniqueId)),
            allowNew: target
                ? s => replacementFits(s, target, intent, gradeOf) || reason === 'any' || reason === 'better professor'
                : undefined,
            signal: ctx.signal,
        }
    );
    if (!result.best)
        return { result: { error: 'That change leaves no complete schedule.', reasons: result.report?.reasons ?? [] } };
    const description = await describePlan(
        ctx,
        result.best.sections,
        pool as Scored[],
        c,
        addSubject ? [addSubject] : []
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
            note: 'Updated as asked; other classes kept where they still fit.',
            constraints: c,
            pool,
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
