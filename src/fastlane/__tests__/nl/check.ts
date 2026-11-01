/** Shared outcome checker: the engine benchmark and the live-model benchmark grade schedules the same way. */
import type { runTool } from '../../core/agentTools';
import { isAsync, maximumGap, type ScheduleConstraints } from '../../core/scheduleSolver';
import type { SectionRecord } from '../../core/sections';
import type { Expect } from './cases';

const DAY_START = (s: SectionRecord, day: string) =>
    s.meetings.filter(m => (m.days as string[]).includes(day)).map(m => m.start);

export function problems(
    e: Expect,
    out: Awaited<ReturnType<typeof runTool>>,
    before: SectionRecord[] | null,
    coreTagsOf: (s: SectionRecord) => string[]
): string[] {
    const bad: string[] = [];
    const result = out.result as { incomplete?: boolean; error?: string };
    const text = JSON.stringify(out.result);
    if (e.plan === false) {
        if (out.plan) bad.push('expected no schedule on the calendar, but one was shown');
        if (e.error && !new RegExp(e.error, 'i').test(text)) bad.push(`expected message /${e.error}/`);
        return bad;
    }
    if (!out.plan) {
        // an honest explanation that leaves the calendar alone is acceptable when the case says so
        if (e.optional && result.error) return [];
        return [`expected a schedule, got: ${text.slice(0, 200)}`];
    }
    const sections = out.plan.sections;
    const report = out.plan.validation;
    const broken = (out.result as { rulesItDoesNotFollow?: string[] }).rulesItDoesNotFollow ?? [];
    const onlyElectives = !!result.incomplete && broken.length > 0 && broken.every(r => /electives/i.test(r));
    if (e.electivesDraftOk && onlyElectives) {
        // acceptable: the planner said the only thing it needed permission for was filling credits with electives
        if (report.allRulesMet) bad.push('a draft must never read "all rules met"');
    } else if (e.incomplete) {
        if (!result.incomplete) bad.push('expected a labelled closest-match draft');
        if (report.allRulesMet) bad.push('a draft must never read "all rules met"');
    } else {
        if (result.incomplete) bad.push(`unexpected draft: ${text.slice(0, 160)}`);
        if (!report.hardOk) bad.push(`validator failed: ${report.failures.join(' | ')}`);
    }
    if (e.allRulesMet !== undefined && report.allRulesMet !== e.allRulesMet)
        bad.push(`allRulesMet=${report.allRulesMet}`);
    const codes = sections.map(s => s.courseCode);
    const credits = sections.reduce((n, s) => n + s.creditHours, 0);
    if (e.credits && !e.incomplete && (credits < e.credits[0] || credits > e.credits[1]))
        bad.push(`credits ${credits}`);
    for (const c of e.include ?? []) if (!codes.includes(c)) bad.push(`missing ${c} (have ${codes.join(', ')})`);
    for (const c of e.exclude ?? []) if (codes.includes(c)) bad.push(`has excluded ${c}`);
    if (e.includeAny && !e.includeAny.some(c => codes.includes(c))) bad.push(`none of ${e.includeAny.join('/')}`);
    if (e.days)
        for (const s of sections)
            for (const m of s.meetings)
                for (const d of m.days) if (!e.days.includes(d)) bad.push(`${s.courseCode} meets on ${d}`);
    if (e.async) {
        const n = sections.filter(isAsync).length;
        if (n < e.async[0] || n > e.async[1]) bad.push(`${n} async classes`);
    }
    for (const [subj, n] of Object.entries(e.subjectCount ?? {}))
        if (codes.filter(c => c.startsWith(`${subj} `)).length !== n) bad.push(`${subj} count`);
    if (e.coreAll) for (const s of sections) if (!coreTagsOf(s).length) bad.push(`${s.courseCode} fills no core area`);
    if (e.startAtLeast)
        for (const s of sections)
            for (const t of DAY_START(s, e.startAtLeast.day))
                if (t < e.startAtLeast.minutes) bad.push(`${s.courseCode} starts ${t} on ${e.startAtLeast.day}`);
    if (e.noMeetingBefore != null)
        for (const s of sections)
            for (const m of s.meetings) if (m.start < e.noMeetingBefore) bad.push(`${s.courseCode} starts ${m.start}`);
    if (e.noMeetingAfter != null)
        for (const s of sections)
            for (const m of s.meetings) if (m.end > e.noMeetingAfter) bad.push(`${s.courseCode} ends ${m.end}`);
    if (e.maxGap != null && maximumGap(sections) > e.maxGap) bad.push(`gap ${maximumGap(sections)}`);
    if (e.asyncCourse) {
        const s = sections.find(x => x.courseCode === e.asyncCourse);
        if (!s || !isAsync(s)) bad.push(`${e.asyncCourse} is not online`);
    }
    if (e.instructor) {
        const s = sections.find(x => x.courseCode === e.instructor!.code);
        if (!s || !s.instructors.includes(e.instructor.who))
            bad.push(`${e.instructor.code} taught by ${s?.instructors.join()}`);
    }
    if (before) {
        const ids = (l: SectionRecord[]) =>
            l
                .map(s => s.uniqueId)
                .sort()
                .join();
        if (e.unchanged && ids(before) !== ids(sections)) bad.push('schedule changed');
        if (e.different && ids(before) === ids(sections)) bad.push('not a different schedule');
        for (const c of e.keep ?? []) if (!codes.includes(c)) bad.push(`dropped ${c}`);
    }
    return bad;
}

/**
 * "No silent loss": a follow-up may change only the rules its own arguments mention. Every other rule from the
 * previous turn must come through unchanged. Returns what was lost.
 */
export function preservationProblems(
    prev: ScheduleConstraints,
    next: ScheduleConstraints,
    args: Record<string, unknown>
): string[] {
    const bad: string[] = [];
    const has = (...keys: string[]) => keys.some(k => args[k] !== undefined);
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const set = (x: unknown[] | undefined) => [...new Set(x ?? [])].sort();
    if (
        !has('minCredits', 'maxCredits', 'changeCredits') &&
        (prev.minCredits !== next.minCredits || prev.maxCredits !== next.maxCredits)
    )
        bad.push(`credits ${prev.minCredits}–${prev.maxCredits} became ${next.minCredits}–${next.maxCredits}`);
    const gone = new Set(
        [...((args.remove as string[] | undefined) ?? []), String(args.replaceCourse ?? '')].map(x =>
            x.toUpperCase().replace(/\s+/g, ' ').trim()
        )
    );
    for (const r of prev.requiredCourses ?? [])
        if (!(next.requiredCourses ?? []).includes(r) && !gone.has(r.toUpperCase()))
            bad.push(`lost required course ${r}`);
    if (!has('onlineMax') && (prev.maxOnline ?? null) !== (next.maxOnline ?? null))
        bad.push(`online cap ${prev.maxOnline} became ${next.maxOnline}`);
    if (!has('onlyDays', 'avoidDays', 'changeOnlyDays') && !same(set(prev.avoidDays), set(next.avoidDays)))
        bad.push(`day rules changed: avoid ${set(prev.avoidDays)} → ${set(next.avoidDays)}`);
    if (!has('coreOnly') && !!prev.coreOnly !== !!next.coreOnly) bad.push('core-only changed');
    if (!has('allowElectives') && !!prev.allowElectives !== !!next.allowElectives)
        bad.push('electives preference changed');
    if (!has('exactCounts', 'includeSubjects', 'remove') && !same(prev.subjectCounts ?? {}, next.subjectCounts ?? {}))
        bad.push(`subject counts ${JSON.stringify(prev.subjectCounts)} became ${JSON.stringify(next.subjectCounts)}`);
    for (const s of prev.excludedSubjects)
        if (!next.excludedSubjects.includes(s)) bad.push(`dropped exclusion of ${s}`);
    if (!has('earliestStart', 'latestEnd') && !same(prev.timeWindow ?? null, next.timeWindow ?? null))
        bad.push('time window changed');
    if (!has('maxGapMinutes') && (prev.maxGapMinutes ?? null) !== (next.maxGapMinutes ?? null))
        bad.push('gap cap changed');
    const windows = Object.keys((args.dayWindows as object | undefined) ?? {}).map(k => k.toUpperCase());
    for (const [day, limit] of Object.entries(prev.dayLimits ?? {}))
        if (!windows.includes(day.toUpperCase()) && !same(limit, next.dayLimits?.[day as keyof typeof next.dayLimits]))
            bad.push(`${day} window changed`);
    return bad;
}
