/**
 * The validator must reject EVERY schedule that breaks a hard rule, and the solver and tools must never hand back
 * one. 2,000 random schedules are checked against an independent, deliberately naive oracle of the hard rules;
 * then random requests are pushed through the real tools and every returned section is checked to exist.
 */
import { describe, expect, it } from 'vitest';
import { runTool } from '../core/agentTools';
import { validatePlan } from '../core/planValidator';
import type { ScheduleConstraints } from '../core/scheduleSolver';
import { isAsync } from '../core/scheduleSolver';
import { type SectionRecord, semesterKey, subjectOf } from '../core/sections';
import { catalog, makeContext } from './nl/fixture';

/** small deterministic PRNG so a failure is reproducible */
function rng(seed: number) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = <T>(r: () => number, list: T[]) => list[Math.floor(r() * list.length)]!;
const DAYS = ['M', 'T', 'W', 'TH', 'F'] as const;

function randomRules(r: () => number): ScheduleConstraints {
    const min = pick(r, [9, 12, 12, 13, 15]);
    return {
        minCredits: min,
        maxCredits: min + pick(r, [0, 1, 3]),
        creditsRequested: true,
        avoidDays: r() < 0.6 ? DAYS.filter(() => r() < 0.4) : [],
        excludedSubjects: r() < 0.4 ? [pick(r, ['HIS', 'ECO', 'UGS', 'KIN', 'SOC'])] : [],
        excludedTitleWords: [],
        excludedCourses: r() < 0.2 ? [pick(r, ['GOV 312L', 'MUS 306M', 'NTR 306'])] : [],
        term: 'Spring 2027',
        online: null,
        backToBack: false,
        maxOnline: r() < 0.5 ? pick(r, [0, 1, 2]) : undefined,
        subjectCounts: r() < 0.3 ? { UGS: pick(r, [0, 1]) } : {},
        timeWindow: r() < 0.3 ? { from: pick(r, [0, 600, 660]), to: pick(r, [930, 1020, 1440]) } : null,
        excludedSections: r() < 0.2 ? [pick(r, catalog).uniqueId] : [],
        checkTravel: false,
    };
}

/** the hard rules, written the dumb way */
function violates(list: SectionRecord[], c: ScheduleConstraints): string | null {
    const credits = list.reduce((n, s) => n + s.creditHours, 0);
    if (credits < c.minCredits || credits > c.maxCredits) return 'credits';
    if (new Set(list.map(s => s.courseCode)).size !== list.length) return 'duplicate course';
    if (new Set(list.map(s => semesterKey(s.semester))).size > 1) return 'semester';
    for (const s of list) {
        if (c.excludedSubjects.includes(subjectOf(s.courseCode))) return 'excluded subject';
        if (c.excludedCourses.includes(s.courseCode)) return 'excluded course';
        if (c.excludedSections?.includes(s.uniqueId)) return 'excluded section';
        if (!isAsync(s) && s.meetings.length === 0) return 'no times';
        for (const m of s.meetings) {
            if (m.days.some(d => c.avoidDays.includes(d))) return 'day';
            if (c.timeWindow && (m.start < c.timeWindow.from || m.end > c.timeWindow.to)) return 'window';
        }
    }
    for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
            for (const a of list[i]!.meetings)
                for (const b of list[j]!.meetings)
                    if (a.days.some(d => b.days.includes(d)) && a.start < b.end && b.start < a.end) return 'overlap';
    if (c.maxOnline != null && list.filter(isAsync).length > c.maxOnline) return 'online cap';
    for (const [k, n] of Object.entries(c.subjectCounts ?? {}))
        if (list.filter(s => subjectOf(s.courseCode) === k).length !== n) return 'subject count';
    return null;
}

describe('validator vs an independent oracle of the hard rules', () => {
    it('rejects 100% of schedules that break a hard rule, and does not reject clean ones', () => {
        const r = rng(20261031);
        const ctx = {
            applies: () => [] as string[],
            auditAvailable: true,
            catalog,
            now: Date.parse('2026-10-30T12:00:00Z'),
        };
        let broken = 0;
        let clean = 0;
        const missed: string[] = [];
        const falseAlarms: string[] = [];
        for (let n = 0; n < 2000; n++) {
            const c = randomRules(r);
            const size = 1 + Math.floor(r() * 6);
            const list = Array.from({ length: size }, () => pick(r, catalog)).filter(
                (s, i, a) => a.findIndex(x => x.uniqueId === s.uniqueId) === i
            );
            const why = violates(list, c);
            const report = validatePlan(list, c, ctx);
            if (why) {
                broken++;
                if (report.hardOk) missed.push(`${why}: ${list.map(s => s.uniqueId).join(',')}`);
            } else {
                clean++;
                if (!report.hardOk)
                    falseAlarms.push(`${report.failures.join(' | ')}: ${list.map(s => s.uniqueId).join(',')}`);
            }
        }
        expect(broken).toBeGreaterThan(300);
        expect(clean).toBeGreaterThan(30);
        expect(missed).toEqual([]);
        expect(falseAlarms).toEqual([]);
    });

    it('the tools never return a schedule the oracle rejects, and never an unknown section', async () => {
        const r = rng(7);
        const known = new Set(catalog.map(s => s.uniqueId));
        let built = 0;
        for (let n = 0; n < 60; n++) {
            const c = randomRules(r);
            const out = await runTool(
                'build_schedule',
                {
                    minCredits: c.minCredits,
                    maxCredits: c.maxCredits,
                    avoidDays: c.avoidDays,
                    excludeSubjects: c.excludedSubjects,
                    excludeCourses: c.excludedCourses,
                    ...(c.maxOnline != null ? { onlineMax: c.maxOnline } : {}),
                    allowElectives: true,
                },
                makeContext()
            );
            if (!out.plan) continue;
            built++;
            for (const s of out.plan.sections) expect(known.has(s.uniqueId)).toBe(true);
            if (!(out.result as { incomplete?: boolean }).incomplete) {
                expect(out.plan.validation.hardOk).toBe(true);
                expect(
                    violates(out.plan.sections, { ...c, subjectCounts: {}, timeWindow: null, excludedSections: [] })
                ).toBeNull();
            } else expect(out.plan.validation.allRulesMet).toBe(false);
        }
        expect(built).toBeGreaterThan(20);
    }, 300_000);
});
