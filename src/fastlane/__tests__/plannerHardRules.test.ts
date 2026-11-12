/**
 * Regression tests for the planner's hard rules. The first block reproduces the reported failure (two UGS courses
 * and a non-core course in a "core only, one UGS, Tue/Thu, 13–15 hours" schedule that was called fully compliant)
 * and proves it can no longer happen; the rest cover each rule, the validator, GPA ranking, follow-ups and the
 * link between the chat result and the calendar.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedAudit } from '../audit/types';
import { academicModel } from '../core/academicModel';
import { runTool, type ToolContext } from '../core/agentTools';
import { guardReply, STRUCK } from '../core/claimGuard';
import { parseCourseQuery, resolveCourseCode, sectionMatchesQuery, subjectWords } from '../core/courseSearch';
import { compareRationale, estimateGpa, GRADE_POINTS } from '../core/gpaModel';
import type { GradeCounts, GradeStat } from '../core/grades';
import {
    anotherOption,
    constraintsFromRules,
    EMPTY_RULES,
    enforceStated,
    initialState,
    isCurrent,
    reduce,
    statedRules,
    undoLast,
} from '../core/plannerRules';
import { isPlanResult, renderPlanReply } from '../core/planReply';
import { validateBackup, validatePlan } from '../core/planValidator';
import { assignRequirements } from '../core/requirementFit';
import { tagsForSection } from '../core/requirements';
import type { ScheduleConstraints, SolverCandidate } from '../core/scheduleSolver';
import { isAsync, scoreSection, solveSchedule } from '../core/scheduleSolver';
import type { SectionRecord } from '../core/sections';
import { validateBuildArgs } from '../core/toolArgs';
import { campusTravelMinutes, transitions } from '../core/travel';
import { UT_SUBJECTS } from '../data/subjects';
import { sectionFixture } from './factories';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const SUBJECTS = new Set(UT_SUBJECTS.map(s => s.code));

type Time = [string, string, string?];
const sec = (
    id: number,
    code: string,
    opts: {
        times?: Time[];
        core?: string[];
        title?: string;
        credits?: number;
        instructors?: string[];
        capturedAt?: number;
    } = {}
): SectionRecord => ({
    prerequisites: '',
    ...sectionFixture(id, code, {
        times: opts.times,
        core: opts.core,
        title: opts.title,
        creditHours: opts.credits,
        instructors: opts.instructors,
    }),
    course: {},
    capturedAt: opts.capturedAt ?? NOW - 60_000,
});
const TTH = (h: string, room = 'GDC 1.1'): Time[] => [['TTH', h, room]];
const SLOT = {
    a: '9:30 a.m.-11:00 a.m.',
    b: '11:00 a.m.-12:30 p.m.',
    c: '12:30 p.m.-2:00 p.m.',
    d: '2:00 p.m.-3:30 p.m.',
    e: '3:30 p.m.-5:00 p.m.',
};

/** the reported run's courses, plus realistic Tuesday/Thursday core alternatives */
const catalog: SectionRecord[] = [
    sec(1, 'UGS 302', { times: TTH(SLOT.a), core: ['090'], title: 'ART & THE EPIDEMIC' }),
    sec(2, 'UGS 303', { times: TTH(SLOT.b), core: ['090'], title: 'DIY ASSISTIVE TECH' }),
    sec(3, 'GOV 312L', { times: TTH(SLOT.c), core: ['070'], title: 'ISSUES & POLICIES IN AMERICAN GOVERNMENT' }),
    sec(4, 'MUS 306M', { times: TTH(SLOT.d), core: ['050'], title: 'ELEMENTS OF MUSIC' }),
    sec(5, 'AMS 310', { times: TTH(SLOT.e), title: 'INTRODUCTION TO AMERICAN STUDIES' }), // no core designation
    sec(6, 'SOC 302', { times: TTH(SLOT.e), core: ['080'], title: 'INTRO TO SOCIOLOGY' }),
    sec(7, 'ECO 304L', { times: TTH(SLOT.c), core: ['080'], title: 'INTRO TO MACRO' }), // same requirement as SOC 302
    sec(8, 'HIS 315K', { times: TTH(SLOT.e), core: ['060'], title: 'THE UNITED STATES, 1865 TO PRESENT' }),
    sec(9, 'NTR 306', { core: ['030'], title: 'FUNDAMENTALS OF NUTRITION' }), // asynchronous online
    sec(10, 'E 316L', { core: ['040'], title: 'BRITISH LITERATURE' }), // asynchronous online
    sec(11, 'M 408C', { times: [['MWF', '9:00 a.m.-10:00 a.m.', 'RLM 4.1']], core: ['020'], credits: 4 }),
    sec(12, 'SED 303', { times: TTH(SLOT.d) }), // elective
    sec(13, 'UGS 302', { times: TTH(SLOT.c), core: ['090'], title: 'ART & THE EPIDEMIC' }),
];
const OUTSTANDING = [...new Set(catalog.flatMap(s => tagsForSection({ courseCode: s.courseCode, core: s.core })))];
const coreOf = (s: SectionRecord) => s.requirementTags.filter(t => /^CORE \d{3}$/.test(t));

const REQUEST =
    "Please create me a 13–15 hour schedule, classes only Tuesday and Thursday, count towards my core complete, no history, and number 1 rule is highest A / GPA classes to protect my GPA as much as possible. I'm okay with having 1–2 online classes. Make sure all classes are back to back so there's no awkward gaps, and remember core complete only. Lastly I want to have a UGS.";
const statedFor = (...msgs: string[]) => constraintsFromRules(statedRules(msgs, SUBJECTS, UT_SUBJECTS), 'Spring 2027');

const asCandidates = (sections: SectionRecord[], outstanding = OUTSTANDING, grade = 90): SolverCandidate[] =>
    sections.map(s => {
        const applies = s.requirementTags.filter(t => outstanding.includes(t) && /^CORE/.test(t));
        return {
            section: s,
            applies,
            prerequisite: 'none',
            score: scoreSection({
                applies,
                coreFocus: true,
                gradePercent: grade,
                gradeSample: 300,
                easyGrades: true,
                aiPicked: false,
            }),
        };
    });

const vctx = (outstanding = OUTSTANDING, extra: Record<string, unknown> = {}) => ({
    applies: (s: SectionRecord) => s.requirementTags.filter(t => outstanding.includes(t)),
    auditAvailable: true,
    catalog,
    now: NOW,
    ...extra,
});

const auditStub = (pending: string[] = []) =>
    ({
        requirements: [...new Set(catalog.flatMap(s => s.requirementTags.filter(t => t.startsWith('CORE '))))].map(
            tag => ({
                id: tag,
                section: 'Core Curriculum',
                text: `Complete ${tag}`,
                category: 'core',
                status: 'not-started',
                required: { value: 3, unit: 'hours' },
                applied: { value: 0, unit: 'hours' },
                remaining: { value: 3, unit: 'hours' },
                tags: [tag],
                courses: [],
                confidence: 'high',
                issues: [],
            })
        ),
        courses: [],
        transfer: { accepted: [], pending: pending.map(code => ({ code })) },
        restrictions: [],
        warnings: [],
        parsedAt: NOW,
        source: 'html',
        creditHours: { confidence: 'high' },
    }) as unknown as ParsedAudit;

const toolCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
    catalog,
    term: 'Spring 2027',
    audit: auditStub(),
    model: academicModel(null),
    taken: new Set(),
    outstanding: OUTSTANDING,
    subjectIndex: [],
    gradeStat: async s =>
        ({
            result: { percent: 80, graded: 300 },
            scope: 'course',
            source: 'test',
            semesters: ['Fall 2025'],
        }) as unknown as GradeStat,
    rmp: null,
    current: null,
    remember: async () => {},
    now: NOW,
    ...over,
});

const BUILD = {
    includeSubjects: ['UGS'],
    excludeSubjects: ['HIS'],
    coreOnly: true,
    onlyDays: ['T', 'TH'],
    minCredits: 13,
    maxCredits: 15,
    onlineMin: 0,
    onlineMax: 2,
};

describe('the reported failure (two UGS, a non-core course, "all rules met")', () => {
    const rules = statedFor(REQUEST);

    it('reads every hard rule from the request itself, not from the model', () => {
        expect(rules.minCredits).toBe(13);
        expect(rules.maxCredits).toBe(15);
        expect(rules.avoidDays).toEqual(expect.arrayContaining(['M', 'W', 'F']));
        expect(rules.avoidDays).not.toContain('T');
        expect(rules.excludedSubjects).toContain('HIS');
        expect(rules.coreOnly).toBe(true);
        expect(rules.subjectCounts).toEqual({ UGS: 1 });
        expect(rules.maxOnline).toBe(2);
    });

    it('the exact reported lineup is rejected by the validator with specific reasons', () => {
        const reported = ['UGS 302', 'GOV 312L', 'AMS 310', 'MUS 306M', 'UGS 303'].map(
            code => catalog.find(s => s.courseCode === code)!
        );
        const report = validatePlan(reported, rules, vctx());
        expect(report.hardOk).toBe(false);
        expect(report.allRulesMet).toBe(false);
        const text = report.failures.join(' | ');
        expect(text).toMatch(/2 UGS classes, exactly 1 required/);
        expect(text).toMatch(/AMS 310[^|]*does not advance any outstanding core requirement/);
        expect(text).toMatch(/only repeats a requirement/);
    });

    it('negative control: with the new rules switched off, the old failure IS reproducible', async () => {
        const old = { ...rules, coreOnly: false, subjectCounts: {}, checkTravel: false };
        const out = await solveSchedule(asCandidates(catalog), old, { keep: 20 });
        const reproduced = [out.best!, ...out.alternatives].some(
            p =>
                p.sections.filter(s => s.courseCode.startsWith('UGS')).length > 1 ||
                p.sections.some(s => s.courseCode === 'AMS 310' || s.courseCode === 'SED 303')
        );
        expect(reproduced).toBe(true);
    });

    it('the solver can no longer return it: exactly one UGS, every class core, none repeats a requirement', async () => {
        const out = await solveSchedule(asCandidates(catalog), rules, { keep: 5 });
        expect(out.best).not.toBeNull();
        for (const plan of [out.best!, ...out.alternatives]) {
            const codes = plan.sections.map(s => s.courseCode);
            expect(codes.filter(c => c.startsWith('UGS'))).toHaveLength(1);
            expect(codes).not.toContain('AMS 310');
            expect(codes).not.toContain('SED 303');
            expect(codes).not.toContain('HIS 315K');
            expect(plan.credits).toBeGreaterThanOrEqual(13);
            expect(plan.credits).toBeLessThanOrEqual(15);
            expect(plan.sections.every(s => coreOf(s).length > 0)).toBe(true);
            const dedicated = assignRequirements(plan.sections, s => asCandidates([s])[0]!.applies, true);
            expect(dedicated.unassigned).toEqual([]);
            expect(validatePlan(plan.sections, rules, vctx()).hardOk).toBe(true);
        }
    });

    it('through the real tool path: one UGS, calendar plan = validated plan, "All rules met" only when verified', async () => {
        const out = await runTool('build_schedule', BUILD, toolCtx({ stated: rules }));
        expect(out.plan).toBeDefined();
        const codes = out.plan!.sections.map(s => s.courseCode);
        expect(codes.filter(c => c.startsWith('UGS'))).toHaveLength(1);
        expect(codes).not.toContain('AMS 310');
        expect(out.plan!.validation.hardOk).toBe(true);
        expect(out.plan!.validation.allRulesMet).toBe(true);
    });
});

describe('hard rules (regression cases 1–9)', () => {
    const rules = statedFor(REQUEST);

    it('1. one UGS requested: two redundant UGS courses are never recommended, alternatives included', async () => {
        const out = await solveSchedule(asCandidates(catalog), rules, { keep: 10 });
        for (const p of [out.best!, ...out.alternatives])
            expect(p.sections.filter(s => s.courseCode.startsWith('UGS'))).toHaveLength(1);
    });

    it('UGS 302 and 303 are alternatives for the one Signature Course requirement', () => {
        const two = [catalog[0]!, catalog[1]!];
        const r = assignRequirements(two, s => s.requirementTags.filter(t => OUTSTANDING.includes(t)), true);
        expect(r.assigned.size).toBe(1);
        expect(r.unassigned).toHaveLength(1);
    });

    it('2. core-only: electives that do not advance an outstanding core requirement are excluded', async () => {
        const out = await solveSchedule(asCandidates(catalog), rules, { keep: 10 });
        for (const p of [out.best!, ...out.alternatives])
            for (const s of p.sections) expect(['AMS 310', 'SED 303']).not.toContain(s.courseCode);
    });

    it('3. 13–15 hours: 12 and 16 are never a result', async () => {
        const out = await solveSchedule(asCandidates(catalog), rules, { keep: 10 });
        for (const p of [out.best!, ...out.alternatives]) expect([13, 14, 15]).toContain(p.credits);
        const twelve = catalog.slice(0, 4);
        expect(validatePlan(twelve, rules, vctx()).failures.join()).toMatch(/12 credit hours is below 13/);
        const sixteen = [...catalog.slice(0, 4), catalog[8]!, catalog[9]!];
        expect(validatePlan(sixteen, rules, vctx()).failures.join()).toMatch(/18 credit hours is above 15/);
    });

    it('4. Tuesday/Thursday: no in-person Monday/Wednesday/Friday section', async () => {
        const out = await solveSchedule(asCandidates(catalog), rules, { keep: 10 });
        for (const p of [out.best!, ...out.alternatives])
            for (const s of p.sections)
                expect(s.meetings.flatMap(m => m.days).every(d => d === 'T' || d === 'TH')).toBe(true);
        expect(validatePlan([catalog[10]!], rules, vctx()).failures.join()).toMatch(/M 408C \(00011\) meets on Monday/);
    });

    it('asynchronous classes count toward credits without manufacturing meeting times', async () => {
        const out = await solveSchedule(asCandidates(catalog), rules, { keep: 5 });
        const asyncOnes = out.best!.sections.filter(isAsync);
        expect(asyncOnes.length).toBeLessThanOrEqual(2);
        for (const s of asyncOnes) expect(s.meetings).toEqual([]);
        expect(out.best!.credits).toBe(out.best!.sections.reduce((n, s) => n + s.creditHours, 0));
    });

    it('5. no history: HIS never appears, not even as an automatic substitute', async () => {
        const onlyHistoryFits = catalog.filter(
            s => !['SOC 302', 'ECO 304L', 'NTR 306', 'E 316L', 'MUS 306M'].includes(s.courseCode)
        );
        const out = await solveSchedule(asCandidates(onlyHistoryFits), rules);
        expect(out.best?.sections.some(s => s.courseCode.startsWith('HIS'))).not.toBe(true);
        expect(out.best).toBeNull(); // not enough without it: infeasible, not padded with history
    });

    it('6. two classes overlap: the combination is rejected', () => {
        const overlap = [catalog[2]!, catalog[6]!]; // GOV 312L and ECO 304L, both 12:30–2:00
        const r = validatePlan(overlap, { ...rules, minCredits: 6, maxCredits: 6 }, vctx());
        expect(r.hardOk).toBe(false);
        expect(r.failures.join()).toMatch(/GOV 312L overlaps ECO 304L/);
    });

    it('7. back-to-back classes in distant buildings with too little time are rejected', async () => {
        const far = (a: string, b: string) =>
            a === b ? 0 : (new Set([a, b]).size === 2 && a + b === 'FARNEAR') || a + b === 'NEARFAR' ? 25 : null;
        const first = sec(21, 'GOV 312L', { times: [['TTH', SLOT.a, 'FAR 1.1']], core: ['070'] });
        const tight = sec(22, 'MUS 306M', { times: [['TTH', '11:05 a.m.-12:30 p.m.', 'NEAR 2.2']], core: ['050'] });
        const roomy = sec(23, 'MUS 306M', { times: [['TTH', '11:30 a.m.-1:00 p.m.', 'NEAR 2.2']], core: ['050'] });
        const loose = { ...rules, minCredits: 6, maxCredits: 6, subjectCounts: {}, coreOnly: false };
        const bad = validatePlan([first, tight], loose, { ...vctx(), travel: far });
        expect(bad.hardOk).toBe(false);
        expect(bad.failures.join()).toMatch(/needs about 25 min, 5 available/);
        expect(
            validatePlan([first, roomy], loose, { ...vctx(), travel: far }).checks.find(k => k.id === 'travel')?.status
        ).toBe('pass');
        const solved = await solveSchedule(asCandidates([first, tight, roomy]), loose, { travel: far });
        expect(solved.best!.sections.map(s => s.uniqueId)).toEqual(expect.arrayContaining([23]));
        expect(solved.best!.sections.map(s => s.uniqueId)).not.toContain(22);
    });

    it('an unmapped building is "unverified", never silently feasible', () => {
        const a = sec(24, 'GOV 312L', { times: [['TTH', SLOT.a, 'ZZZ 1.1']], core: ['070'] });
        const b = sec(25, 'MUS 306M', { times: [['TTH', '11:00 a.m.-12:30 p.m.', 'GDC 1.1']], core: ['050'] });
        const r = validatePlan(
            [a, b],
            { ...rules, minCredits: 6, maxCredits: 6, subjectCounts: {}, coreOnly: false },
            vctx()
        );
        expect(r.checks.find(k => k.id === 'travel')?.status).toBe('unverified');
        expect(r.allRulesMet).toBe(false);
        expect(transitions([a, b])[0]!.needed).toBeNull();
    });

    it('walking estimates come from the campus walkway graph and are symmetric', () => {
        const ab = campusTravelMinutes('GDC', 'PCL');
        expect(ab).toBeGreaterThan(0);
        expect(ab).toBe(campusTravelMinutes('PCL', 'GDC'));
        expect(campusTravelMinutes('GDC', 'GDC')).toBe(0);
    });

    it('8. requirements already completed: unnecessary courses are not recommended', async () => {
        const remaining = OUTSTANDING.filter(t => t !== 'CORE 070' && t !== 'CORE 050');
        const out = await runTool(
            'build_schedule',
            { ...BUILD, minCredits: 12, maxCredits: 15 },
            toolCtx({
                outstanding: remaining,
                audit: {
                    ...auditStub(),
                    requirements: auditStub().requirements.map(r =>
                        r.tags.some(t => t === 'CORE 070' || t === 'CORE 050')
                            ? { ...r, status: 'completed', applied: r.required, remaining: { value: 0, unit: 'hours' } }
                            : r
                    ),
                },
                stated: statedFor(REQUEST),
            })
        );
        const codes = out.plan?.sections.map(s => s.courseCode) ?? [];
        expect(codes).not.toContain('GOV 312L');
        expect(codes).not.toContain('MUS 306M');
        for (const s of out.plan?.sections ?? [])
            expect(out.plan!.pool.find(p => p.section === s)!.applies.length).toBeGreaterThan(0);
    });

    it('9. no feasible schedule: a closest draft that names every rule it does not follow, never claimed valid', async () => {
        // 15 credits on Tue/Thu with no online classes is impossible here (only four in-person core classes fit)
        const out = await runTool(
            'build_schedule',
            { ...BUILD, minCredits: 15, maxCredits: 15, onlineMax: 0 },
            toolCtx({
                catalog: catalog.filter(s => !['ECO 304L', 'UGS 302'].includes(s.courseCode) || s.uniqueId === 1),
                stated: statedFor('Tuesday and Thursday only, core complete only, a UGS, 15 hours, no online'),
            })
        );
        const r = out.result as {
            incomplete?: boolean;
            rulesItDoesNotFollow: string[];
            reasons: string[];
            notice: string;
        };
        expect(r.incomplete).toBe(true);
        expect(r.rulesItDoesNotFollow.length).toBeGreaterThan(0);
        expect(r.reasons.join(' ')).toMatch(/sections \(/); // the funnel
        expect(out.plan).toBeDefined(); // shown as a draft...
        expect(out.plan!.validation.hardOk).toBe(false); // ...validated against the ORIGINAL rules
        expect(out.plan!.validation.allRulesMet).toBe(false);
        expect(out.plan!.validation.failures.join()).toMatch(/asynchronous online|credit hours/);
        expect(out.plan!.constraints.maxOnline).toBe(0); // the student's rules stay in place
    });

    it('9b. when nothing at all can be built, the funnel names the rule that emptied the list', async () => {
        const out = await runTool(
            'build_schedule',
            { ...BUILD, minCredits: 15, maxCredits: 15 },
            toolCtx({ catalog: [], stated: statedFor(REQUEST) })
        );
        expect(out.plan).toBeUndefined();
        const r = out.result as { error: string; reasons: string[] };
        expect(r.error).toMatch(/couldn’t build any schedule/);
        expect(r.reasons.join(' ')).toMatch(/nothing is left after this rule/);
    });

    it('9c. a time limit ends the search and says so instead of claiming impossibility', async () => {
        // 25 credits cannot be made from 3-credit classes, so the whole space would be searched
        const many = Array.from({ length: 60 }, (_, i) => sec(500 + i, `SOC ${300 + i}`, { core: ['080'] }));
        const open: ScheduleConstraints = { ...statedFor('Tuesday and Thursday only'), minCredits: 25, maxCredits: 25 };
        const started = Date.now();
        const out = await solveSchedule(asCandidates(many), open, { timeLimitMs: 200, maxNodes: 50_000_000 });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(out.best).toBeNull();
        expect(out.report!.reasons[0]).toMatch(/search limit was reached/);
    });

    it('a stated rule cannot be loosened by the model', () => {
        const model: ScheduleConstraints = {
            ...statedFor('Tuesday and Thursday only'),
            avoidDays: [],
            coreOnly: false,
            subjectCounts: {},
        };
        const merged = enforceStated(model, statedFor(REQUEST));
        expect(merged.avoidDays).toEqual(expect.arrayContaining(['M', 'W', 'F']));
        expect(merged.coreOnly).toBe(true);
        expect(merged.subjectCounts).toEqual({ UGS: 1 });
        expect(merged.minCredits).toBe(13);
    });
});

describe('GPA model (confidence-aware)', () => {
    const counts = (a: number, am: number, b: number, rest = 0): GradeCounts => ({ A: a, 'A-': am, B: b, C: rest });

    it('95% A from 10 students does not automatically beat 90% from 2,000', () => {
        const small = estimateGpa({
            counts: counts(10, 0, 0),
            scope: 'instructor',
            semesters: ['Fall 2025'],
            nowYear: 2026,
        })!;
        const big = estimateGpa({
            counts: counts(1800, 100, 100),
            scope: 'instructor',
            semesters: ['Fall 2025'],
            nowYear: 2026,
        })!;
        expect(small.confidence).toBe('low');
        expect(big.confidence).toBe('high');
        expect(big.rankValue).toBeGreaterThan(small.rankValue);
        expect(compareRationale({ label: 'Big', estimate: big }, { label: 'Small', estimate: small })).toMatch(
            /Big ranks above Small/
        );
    });

    it('keeps A separate from A− and weights by UT grade points', () => {
        const allA = estimateGpa({ counts: { A: 500 }, scope: 'course', nowYear: 2026 })!;
        const allAMinus = estimateGpa({ counts: { 'A-': 500 }, scope: 'course', nowYear: 2026 })!;
        expect(GRADE_POINTS['A-']).toBeCloseTo(3.67);
        expect(allA.pA).toBeGreaterThan(allAMinus.pA);
        expect(allA.expectedGradePoints).toBeGreaterThan(allAMinus.expectedGradePoints);
        expect(allA.pAMinus).toBeLessThan(allAMinus.pAMinus);
    });

    it('old data is counted at half weight and says so', () => {
        const old = estimateGpa({
            counts: counts(300, 0, 0),
            scope: 'course',
            semesters: ['Fall 2019'],
            nowYear: 2026,
        })!;
        expect(old.stale).toBe(true);
        expect(old.rationale).toMatch(/half weight/);
    });

    it('10. missing grade data: no statistic is fabricated', async () => {
        expect(estimateGpa({ counts: null, scope: 'course' })).toBeNull();
        expect(estimateGpa({ counts: {}, scope: 'course' })).toBeNull();
        expect(estimateGpa({ counts: { Other: 40 }, scope: 'course' })).toBeNull();
        const out = await runTool(
            'build_schedule',
            BUILD,
            toolCtx({ gradeStat: async () => null, stated: statedFor(REQUEST) })
        );
        const classes = (out.result as { classes: Array<{ gpaOutlook: unknown; historicalARate: unknown }> }).classes;
        for (const c of classes) {
            expect(c.historicalARate).toBeNull();
            expect(c.gpaOutlook).toBe('no historical grade data: not estimated');
        }
        const claim = validatePlan(
            catalog.slice(0, 1),
            statedFor(REQUEST),
            vctx(OUTSTANDING, { gradeClaims: [{ uniqueId: 1, percent: 95 }] })
        );
        expect(claim.checks.find(k => k.id === 'grade-claims')?.status).toBe('fail');
    });

    it('GPA outlook, not raw A%, drives the choice between two sections of one requirement', async () => {
        const lowSample = sec(31, 'SOC 302', { times: TTH(SLOT.e), core: ['080'] });
        const solid = sec(32, 'ECO 304L', { times: TTH(SLOT.e), core: ['080'] });
        const stat = (c: GradeCounts) =>
            ({
                result: { percent: 99, graded: 10 },
                scope: 'instructor',
                source: 'test',
                semesters: ['Fall 2025'],
                counts: c,
            }) as unknown as GradeStat;
        const out = await runTool(
            'build_schedule',
            { coreOnly: true, minCredits: 12, maxCredits: 15, onlyDays: ['T', 'TH'], onlineMax: 2 },
            toolCtx({
                catalog: [...catalog.filter(s => s.uniqueId !== 6 && s.uniqueId !== 7), lowSample, solid],
                gradeStat: async s =>
                    s.uniqueId === 31
                        ? stat({ A: 10 })
                        : s.uniqueId === 32
                          ? stat({ A: 1800, 'A-': 100, B: 100 })
                          : null,
                stated: statedFor('Tuesday and Thursday only, core only, 12 to 15 hours'),
            })
        );
        const codes = out.plan!.sections.map(s => s.courseCode);
        expect(codes).toContain('ECO 304L');
        expect(codes).not.toContain('SOC 302');
    });
});

describe('validator (independent final check)', () => {
    const rules = statedFor(REQUEST);
    const good = () =>
        ['UGS 302', 'GOV 312L', 'MUS 306M', 'SOC 302', 'NTR 306'].map(c => catalog.find(s => s.courseCode === c)!);

    it('says "all rules met" only when every check passed and the records are verified', () => {
        expect(validatePlan(good(), rules, vctx()).allRulesMet).toBe(true);
        expect(validatePlan(good(), rules, vctx(OUTSTANDING, { auditAvailable: false })).allRulesMet).toBe(false);
    });

    it('13. a stale cached section is never described as freshly verified', () => {
        const stale = good().map(s => ({ ...s, capturedAt: NOW - 40 * 24 * 3600 * 1000 }));
        const r = validatePlan(stale, rules, vctx());
        const fresh = r.checks.find(k => k.id === 'freshness')!;
        expect(fresh.status).toBe('unverified');
        expect(fresh.detail).toMatch(/last seen 2026-09-20 \(40 days ago\)/);
        expect(r.allRulesMet).toBe(false);
        expect(r.hardOk).toBe(true);
    });

    it('15. pending transfer credit is never silently treated as awarded', async () => {
        const r = validatePlan(good(), rules, vctx(OUTSTANDING, { pendingCredit: ['GOV 312L'] }));
        expect(r.allRulesMet).toBe(false);
        expect(r.unverified.join()).toMatch(/Pending credit is not counted as awarded: GOV 312L/);
        // and the planner's "already done" set holds only completed / in-progress courses
        const out = await runTool('build_schedule', BUILD, toolCtx({ audit: auditStub(['GOV 312L']), stated: rules }));
        expect(out.plan!.validation.allRulesMet).toBe(false);
        expect(JSON.stringify(out.result)).toMatch(/Pending credit is not counted as awarded/);
    });

    it('without a degree audit nothing is called audit-verified', async () => {
        const out = await runTool('build_schedule', BUILD, toolCtx({ audit: null, stated: rules }));
        expect(out.plan!.constraints.requirementSource).toBe('listing');
        expect(out.plan!.validation.allRulesMet).toBe(false);
        expect(out.plan!.validation.unverified.join()).toMatch(/No degree audit imported/);
    });

    it('14. every backup is checked against the same constraints', async () => {
        const out = await runTool('build_schedule', BUILD, toolCtx({ stated: rules }));
        const r = out.result as {
            backups: {
                perClass: Array<{ for: string; options: Array<{ unique: string }> }>;
                general: Array<{ unique: string }>;
            };
        };
        const plan = out.plan!.sections;
        const byUnique = new Map(catalog.map(s => [String(s.uniqueId).padStart(5, '0'), s]));
        for (const g of r.backups.perClass) {
            const replaced = plan.find(s => s.courseCode === g.for)!;
            for (const o of g.options)
                expect(
                    validateBackup(plan, replaced, byUnique.get(o.unique)!, out.plan!.constraints, vctx()).hardOk
                ).toBe(true);
        }
        for (const o of r.backups.general) {
            expect(
                plan.some(
                    rep => validateBackup(plan, rep, byUnique.get(o.unique)!, out.plan!.constraints, vctx()).hardOk
                )
            ).toBe(true);
        }
        // an overlapping/History backup would fail the same check
        const hist = catalog.find(s => s.courseCode === 'HIS 315K')!;
        expect(plan.some(rep => validateBackup(plan, rep, hist, out.plan!.constraints, vctx()).hardOk)).toBe(false);
    });

    it('12. invalid model output never reaches the calendar', async () => {
        for (const bad of [
            { minCredits: 'many' },
            { onlyDays: ['Funday'] },
            { minCredits: 15, maxCredits: 12 },
            { exactCounts: { ugs: 99 } },
        ]) {
            expect(validateBuildArgs(bad).ok).toBe(false);
            const out = await runTool('build_schedule', bad as Record<string, unknown>, toolCtx());
            expect(out.plan).toBeUndefined();
            expect(out.result).toMatchObject({ error: expect.stringMatching(/rejected before anything ran/) });
        }
        expect(validateBuildArgs('nope').ok).toBe(false);
    });

    it('a solver result that fails validation is discarded, not shown', async () => {
        // every section claims to be in the catalog but one carries an invalid unique number
        const broken = catalog.map(s => (s.courseCode === 'GOV 312L' ? { ...s, uniqueId: 123456 } : s));
        const out = await runTool('build_schedule', { ...BUILD }, toolCtx({ catalog: broken, stated: rules }));
        if (out.plan) expect(out.plan.sections.every(s => s.uniqueId <= 99999)).toBe(true);
    });
});

describe("claims in the model's text", () => {
    const rules = statedFor(REQUEST);
    const bad = validatePlan(catalog.slice(0, 5), rules, vctx());

    it('are struck when the validator did not confirm them, and the real verdict is appended', () => {
        const text = 'Great news — all rules are met and this is fully degree-audit-verified.';
        const out = guardReply(text, bad);
        expect(out).not.toMatch(/all rules are met/i);
        expect(out).toContain(STRUCK);
        expect(out).toMatch(/\*\*Validator:\*\* Rules NOT met/);
        expect(guardReply('Every constraint was satisfied.', null)).toContain(STRUCK);
    });

    it('leave denials alone: "no schedule meets every rule" is not a claim', () => {
        const text = 'Why no schedule meets every rule: nothing satisfies all constraints.';
        expect(guardReply(text, bad)).toContain('Why no schedule meets every rule');
        expect(guardReply(text, bad)).not.toContain(STRUCK);
    });

    it('stand when every check passed', () => {
        const ok = validatePlan(
            ['UGS 302', 'GOV 312L', 'MUS 306M', 'SOC 302', 'NTR 306'].map(c => catalog.find(s => s.courseCode === c)!),
            rules,
            vctx()
        );
        expect(guardReply('All rules are met.', ok)).toMatch(/^All rules are met\./);
        expect(guardReply('All rules are met.', ok)).toMatch(/Validator:\*\* All rules met/);
    });
});

describe('follow-ups and memory (regression cases 11 + chat behavior)', () => {
    const base = () => reduce(initialState(), REQUEST, SUBJECTS, UT_SUBJECTS);

    it('11. "Actually, allow Wednesdays" changes only the meeting-day rule', () => {
        const before = constraintsFromRules(base().session, 'Spring 2027');
        const after = constraintsFromRules(
            reduce(base(), 'Actually, allow Wednesdays', SUBJECTS, UT_SUBJECTS).session,
            'Spring 2027'
        );
        expect(after.avoidDays).not.toContain('W');
        expect(after.avoidDays).toEqual(expect.arrayContaining(['M', 'F']));
        expect({ ...after, avoidDays: [] }).toEqual({ ...before, avoidDays: [] });
    });

    it('a modify_schedule follow-up keeps the earlier hard rules', async () => {
        const rules = statedFor(REQUEST);
        const built = await runTool('build_schedule', BUILD, toolCtx({ stated: rules }));
        const next = await runTool(
            'modify_schedule',
            { replaceCourse: 'SOC 302', replaceReason: 'any' },
            toolCtx({
                stated: rules,
                current: {
                    sections: built.plan!.sections,
                    constraints: built.plan!.constraints,
                    pool: built.plan!.pool,
                },
            })
        );
        const plan = next.plan ?? built.plan!;
        expect(plan.constraints.coreOnly).toBe(true);
        expect(plan.constraints.subjectCounts).toEqual({ UGS: 1 });
        expect(plan.constraints.avoidDays).toEqual(expect.arrayContaining(['M', 'W', 'F']));
        expect(plan.sections.filter(s => s.courseCode.startsWith('UGS'))).toHaveLength(1);
        expect(plan.validation.hardOk).toBe(true);
    });

    it('"remember" is a persistent rule; other messages are one-time', () => {
        const s = reduce(initialState(), 'Remember I only want core classes', SUBJECTS, UT_SUBJECTS);
        expect(s.persistent.coreOnly).toBe(true);
        const oneTime = reduce(s, 'no history classes this time', SUBJECTS, UT_SUBJECTS);
        expect(oneTime.session.prefs.excludedSubjects).toContain('HIS');
        expect(oneTime.persistent.prefs.excludedSubjects).not.toContain('HIS');
        expect(oneTime.persistent.coreOnly).toBe(true);
    });

    it('"Make it easier" re-ranks by GPA without losing hard rules', async () => {
        const rules = statedFor(REQUEST);
        const built = await runTool('build_schedule', BUILD, toolCtx({ stated: rules }));
        const next = await runTool(
            'modify_schedule',
            { replaceCourse: 'SOC 302', replaceReason: 'easier' },
            toolCtx({
                stated: rules,
                current: {
                    sections: built.plan!.sections,
                    constraints: built.plan!.constraints,
                    pool: built.plan!.pool,
                },
            })
        );
        const plan = next.plan ?? built.plan!;
        expect(plan.constraints.coreOnly).toBe(true);
        expect(plan.sections.every(s => coreOf(s).length > 0)).toBe(true);
    });

    it('"another option" is genuinely different, still valid, and never repeats the shown sections', async () => {
        const rules = statedFor(REQUEST);
        const built = await runTool('build_schedule', { ...BUILD, minCredits: 12 }, toolCtx({ stated: rules }));
        const shown = built.plan!.sections.map(s => s.uniqueId);
        const next = await runTool(
            'modify_schedule',
            { anotherOption: true },
            toolCtx({
                stated: rules,
                current: {
                    sections: built.plan!.sections,
                    constraints: built.plan!.constraints,
                    pool: built.plan!.pool,
                },
            })
        );
        if (next.plan) {
            expect(next.plan.sections.some(s => shown.includes(s.uniqueId))).toBe(false);
            expect(next.plan.validation.hardOk).toBe(true);
        } else {
            expect(JSON.stringify(next.result)).toMatch(/no complete schedule/i); // honest, not a repeat
        }
        const st = anotherOption(base(), shown);
        expect(st.session.excludedSections).toEqual(expect.arrayContaining(shown));
    });

    it('"Undo" restores the previous planner state exactly', () => {
        const s1 = base();
        const s2 = reduce(s1, 'Actually, allow Wednesdays', SUBJECTS, UT_SUBJECTS);
        const s3 = undoLast(s2);
        expect(s3.session).toEqual(s1.session);
        expect(reduce(s2, 'undo', SUBJECTS, UT_SUBJECTS).session).toEqual(s1.session);
    });

    it('a stale response cannot overwrite a newer instruction', () => {
        const s1 = base();
        const startedAt = s1.seq;
        const s2 = reduce(s1, 'Actually, allow Wednesdays', SUBJECTS, UT_SUBJECTS);
        expect(isCurrent(s1, startedAt)).toBe(true);
        expect(isCurrent(s2, startedAt)).toBe(false);
    });

    it('a tool result produced after a newer instruction is discarded (never reaches the calendar)', async () => {
        const out = await runTool(
            'build_schedule',
            BUILD,
            toolCtx({ stated: statedFor(REQUEST), isStale: () => true })
        );
        expect(out.plan).toBeUndefined();
        expect(JSON.stringify(out.result)).toMatch(/newer instruction/);
    });
});

describe('chat and calendar use the same validated result', () => {
    it('the classes the chat describes are exactly the sections sent to the calendar', async () => {
        const out = await runTool('build_schedule', BUILD, toolCtx({ stated: statedFor(REQUEST) }));
        const described = (out.result as { classes: Array<{ unique: string }> }).classes
            .map(c => Number(c.unique))
            .sort();
        const calendar = out.plan!.sections.map(s => s.uniqueId).sort();
        expect(described).toEqual(calendar);
        expect((out.result as { validation: { allRulesMet: boolean } }).validation.allRulesMet).toBe(
            out.plan!.validation.allRulesMet
        );
        expect((out.result as { totalCredits: number }).totalCredits).toBe(out.plan!.validation.credits);
    });

    it('UI wiring: the calendar is fed only by validated tool plans, and the pill only by the validator', () => {
        const page = readFileSync(resolve(process.cwd(), 'src/fastlane/page/AiRecommendations.tsx'), 'utf8');
        const panel = readFileSync(resolve(process.cwd(), 'src/fastlane/page/ProposalPanel.tsx'), 'utf8');
        // the only call that puts copilot sections on the calendar takes the tool outcome's plan and its report
        expect(page).toMatch(/if \(outcome\.plan && !isStale\(\)\)/);
        expect(page).toMatch(/showPlan\(sections, note, planReport, constraints\)/);
        // chat text goes through the claim guard with that same report
        expect(page).toMatch(/guardReply\([\s\S]*lastReport/);
        expect(page).toMatch(/report=\{report\}/);
        // "All rules met" can only come from the independent report
        expect(panel).toMatch(/props\.report\?\.allRulesMet/);
        expect(panel).not.toMatch(/valid\s*\?\s*'All rules met'/);
    });
});

describe('finding a course the way a student writes it (the "web based nutrition" miss)', () => {
    const nutrition = sec(40, 'NTR 306', { core: ['030'], title: 'FUNDAMENTALS OF NUTRITION' });
    const inPerson = sec(41, 'NTR 306', { times: TTH(SLOT.a), core: ['030'], title: 'FUNDAMENTALS OF NUTRITION' });
    const index: Array<[string, string]> = [
        ['nutritional sciences', 'NTR'],
        ['sociology', 'SOC'],
    ];
    const all = [nutrition, inPerson, ...catalog];

    it('"fundamental of nutrition" matches the plural title; "web based" means online', () => {
        const q = parseCourseQuery('Fundamental of Nutrition WB');
        expect(q.online).toBe(true);
        expect(sectionMatchesQuery(nutrition, q, subjectWords(index))).toBe(true);
        expect(sectionMatchesQuery(catalog[0]!, q, subjectWords(index))).toBe(false);
    });

    it('a subject name finds its courses, and a free-text name resolves to a course code', () => {
        expect(sectionMatchesQuery(nutrition, parseCourseQuery('nutrition'), subjectWords(index))).toBe(true);
        expect(resolveCourseCode('web based NTR', all, index)).toBe('NTR 306');
        expect(resolveCourseCode('fundamentals of nutrition', all, index)).toBe('NTR 306');
        expect(resolveCourseCode('underwater basket weaving', all, index)).toBeNull();
    });

    it("search_courses finds the web-based section from the student's own words", async () => {
        const out = await runTool(
            'search_courses',
            { query: 'fundamental of nutrition web based' },
            toolCtx({ catalog: [...catalog, nutrition, inPerson], subjectIndex: index })
        );
        const r = out.result as { courses: Array<{ code: string; modes: string[] }> };
        expect(r.courses.map(c => c.code)).toContain('NTR 306');
        expect(r.courses.find(c => c.code === 'NTR 306')!.modes.join()).toMatch(/asynchronous/);
    });

    it('modify_schedule by name swaps the course in, or says plainly why it could not — never silently ignores it', async () => {
        const rules = statedFor(REQUEST);
        const built = await runTool(
            'build_schedule',
            { ...BUILD },
            toolCtx({ stated: rules, catalog: [...catalog, nutrition], subjectIndex: index })
        );
        const current = {
            sections: built.plan!.sections,
            constraints: built.plan!.constraints,
            pool: built.plan!.pool,
        };
        const swapped = await runTool(
            'modify_schedule',
            { remove: ['SOC 302'], addCourse: 'fundamentals of nutrition web based' },
            toolCtx({ stated: rules, catalog: [...catalog, nutrition], subjectIndex: index, current })
        );
        if (swapped.plan) {
            expect(swapped.plan.sections.map(s => s.courseCode)).toContain('NTR 306');
            expect(swapped.plan.sections.map(s => s.courseCode)).not.toContain('SOC 302');
            expect(swapped.plan.validation.hardOk).toBe(true);
        } else expect(JSON.stringify(swapped.result)).toMatch(/NOT added|no complete schedule/i);
        const missing = await runTool(
            'modify_schedule',
            { addCourse: 'underwater basket weaving' },
            toolCtx({ stated: rules, current })
        );
        expect(missing.plan).toBeUndefined();
        expect((missing.result as { error: string }).error).toMatch(/No Spring 2027 course matches/);
    });
});

describe('chat text comes from the checked result, not from the model', () => {
    it('lists exactly the calendar sections with their real unique numbers, credits and requirements', async () => {
        const out = await runTool('build_schedule', BUILD, toolCtx({ stated: statedFor(REQUEST) }));
        expect(isPlanResult(out.result)).toBe(true);
        const text = renderPlanReply(out.result as never);
        for (const s of out.plan!.sections) expect(text).toContain(String(s.uniqueId).padStart(5, '0'));
        expect(text).toContain(`${out.plan!.validation.credits} credit hours`);
        expect(text).not.toMatch(/All rules met/); // the verdict comes from the validator line, not from this text
    });
});

describe('natural request: degree classes first, electives ranked by GPA, alternatives offered', () => {
    const elec = (id: number, code: string, slot: string) => sec(id, code, { times: TTH(slot), title: code });
    const pool = [
        sec(1, 'UGS 302', { times: TTH(SLOT.a), core: ['090'] }),
        sec(3, 'GOV 312L', { times: TTH(SLOT.b), core: ['070'] }),
        elec(60, 'SED 303', SLOT.c), // electives, different grade histories
        elec(61, 'AMS 310', SLOT.d),
        elec(62, 'ANT 301', SLOT.e),
        sec(63, 'KIN 302', { title: 'KIN 302' }), // asynchronous elective
    ];
    const grades: Record<string, GradeCounts> = {
        'SED 303': { A: 900, 'A-': 80, B: 20 },
        'AMS 310': { A: 100, B: 300, C: 150, D: 40 },
        'ANT 301': { A: 600, 'A-': 200, B: 150 },
        'KIN 302': { A: 700, 'A-': 150, B: 100 },
    };
    const statFor = (s: SectionRecord) =>
        ({
            result: { percent: 80, graded: 1000 },
            scope: 'course',
            source: 'test',
            semesters: ['Fall 2025'],
            counts: grades[s.courseCode] ?? { A: 300, B: 300, C: 100 },
        }) as unknown as GradeStat;
    const ask = {
        minCredits: 15,
        maxCredits: 15,
        onlyDays: ['T', 'TH'],
        onlineMax: 2,
        allowElectives: true,
    };
    const ctx = (over: Partial<ToolContext> = {}) =>
        toolCtx({
            catalog: pool,
            outstanding: ['CORE 090', 'CORE 070'],
            gradeStat: async s => statFor(s),
            stated: statedFor('15 hours, Tuesday and Thursday only'),
            ...over,
        });

    it('with electives wanted: the degree classes are included and electives are chosen by GPA outlook', async () => {
        const out = await runTool('build_schedule', ask, ctx());
        expect(out.plan).toBeDefined();
        const codes = out.plan!.sections.map(s => s.courseCode);
        expect(codes).toEqual(expect.arrayContaining(['UGS 302', 'GOV 312L']));
        expect(codes).not.toContain('AMS 310'); // worst grade history is the one left out
        expect(out.plan!.validation.hardOk).toBe(true);
        expect(out.plan!.validation.credits).toBe(15);
    });

    it('without electives wanted, the same request does not silently pad with electives', async () => {
        const out = await runTool('build_schedule', { ...ask, allowElectives: false }, ctx());
        const r = out.result as { incomplete?: boolean; rulesItDoesNotFollow?: string[] };
        // nothing but the two degree classes fits the rules, so the planner offers a labelled draft instead
        expect(r.incomplete).toBe(true);
        expect(r.rulesItDoesNotFollow!.join()).toMatch(/electives/i);
        expect(out.plan!.validation.allRulesMet).toBe(false);
    });

    it('returns different, validated schedules optimized for GPA, convenience and degree progress', async () => {
        const out = await runTool('build_schedule', ask, ctx());
        const alt = (
            out.result as {
                alternatives: Array<{ label: string; allRulesPass: boolean; classes: Array<{ unique: string }> }>;
            }
        ).alternatives;
        const main = out
            .plan!.sections.map(s => s.uniqueId)
            .sort()
            .join();
        for (const a of alt) {
            expect(a.allRulesPass).toBe(true);
            expect(
                a.classes
                    .map(c => Number(c.unique))
                    .sort()
                    .join()
            ).not.toBe(main);
        }
    });

    it("the chat shows what was understood, and a model's explicit choice beats keyword matching", async () => {
        const out = await runTool(
            'build_schedule',
            ask,
            ctx({ stated: statedFor('core complete only, 15 hours, Tuesday and Thursday only') })
        );
        // the model understood that electives are wanted: keyword matching does not turn core-only back on
        expect(out.plan!.constraints.coreOnly).toBe(false);
        const text = renderPlanReply(out.result as never);
        expect(text).toMatch(/What I understood:.*15–15 credit hours/);
    });
});

describe('model prose that invents a schedule', () => {
    it('is recognised so it is never shown as a schedule', async () => {
        const { looksLikeSchedule } = await import('../core/claimGuard');
        const invented = [
            'Spring 2027 – 15 credit‑hour schedule (with NTR 392)',
            '| UGS 303 DIY | 65804 | 3 | TTH 3:30‑5:00 pm · BUR 112 |',
            '| AST 301 INTRO | 49325 | 3 | TTH 9:30‑11:00 am · WEL 3.502 |',
            '| NTR 392 NUTRITION | – | 3 | online |',
        ].join('\n');
        expect(looksLikeSchedule(invented)).toBe(true);
        expect(looksLikeSchedule('No NTR class fits around your other classes. The calendar is unchanged.')).toBe(
            false
        );
    });
});
