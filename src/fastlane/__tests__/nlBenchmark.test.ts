/**
 * Natural-language benchmark, engine half: every case's gold tool calls run through the real tools, solver and
 * validator across multi-turn conversations. It proves the scheduling engine and follow-up semantics behave for
 * ~60 differently phrased requests. It does NOT prove a live model produces those calls — see
 * scripts/fastlane/nl-benchmark.mjs for that.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../core/agentTools';
import { constraintsFromRules, statedRules } from '../core/plannerRules';
import { isAsync, maximumGap } from '../core/scheduleSolver';
import type { SectionRecord } from '../core/sections';
import { UT_SUBJECTS } from '../data/subjects';
import { type Case, cases, type Expect } from './nl/cases';
import { makeContext } from './nl/fixture';

const SUBJECTS = new Set(UT_SUBJECTS.map(s => s.code));
const DAY_START = (s: SectionRecord, day: string) =>
    s.meetings.filter(m => (m.days as string[]).includes(day)).map(m => m.start);

function problems(
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
    if (e.incomplete) {
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

const rows: Array<{ id: string; category: string; turns: number; ok: boolean; problems: string[] }> = [];

describe('natural-language benchmark (gold interpretations through the real engine)', () => {
    for (const c of cases satisfies Case[])
        it(`${c.id} · ${c.category}: ${c.turns[0]!.say.slice(0, 70)}`, async () => {
            const said: string[] = [];
            let current: ToolContext['current'] = null;
            let before: SectionRecord[] | null = null;
            const all: string[] = [];
            for (const [i, turn] of c.turns.entries()) {
                said.push(turn.say);
                const stated = constraintsFromRules(statedRules(said, SUBJECTS, UT_SUBJECTS), 'Spring 2027');
                const ctx = makeContext({ stated, current });
                const out = await runTool(turn.tool, turn.args, ctx);
                const byId = new Map((out.plan?.pool ?? []).map(p => [p.section.uniqueId, p.applies]));
                const found = problems(turn.expect, out, before, s =>
                    (byId.get(s.uniqueId) ?? []).filter(t => /^CORE \d{3}$/.test(t))
                ).map(p => `turn ${i + 1}: ${p}`);
                all.push(...found);
                if (out.plan) {
                    // keep the rest of the conversation honest: a follow-up's "before" is what was last shown
                    before = current?.sections ?? null;
                    current = { sections: out.plan.sections, constraints: out.plan.constraints, pool: out.plan.pool };
                    if (turn.tool === 'modify_schedule') before = out.plan.sections && before;
                }
            }
            rows.push({ id: c.id, category: c.category, turns: c.turns.length, ok: all.length === 0, problems: all });
            expect(all).toEqual([]);
        }, 120_000);

    it('exports the gold cases for the live-model script', () => {
        if (process.env.NL_EXPORT)
            writeFileSync(
                process.env.NL_EXPORT,
                JSON.stringify(
                    cases.map(c => ({
                        id: c.id,
                        category: c.category,
                        turns: c.turns.map(t => ({ say: t.say, tool: t.tool, args: t.args })),
                    })),
                    null,
                    1
                )
            );
        expect(cases.length).toBeGreaterThanOrEqual(50);
    });

    it('summary', () => {
        const passed = rows.filter(r => r.ok).length;
        if (process.env.NL_REPORT)
            writeFileSync(process.env.NL_REPORT, JSON.stringify({ passed, total: rows.length, rows }, null, 2));
        expect(rows.length).toBe(cases.length);
    });
});
