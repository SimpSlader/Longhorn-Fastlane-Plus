import { describe, expect, it } from 'vitest';

import { planningPreferences, requestedOnlyDays } from '../core/chatPreferences';
import type { Meeting } from '../core/meetings';
import type { ScheduleConstraints, SolverCandidate } from '../core/scheduleSolver';
import { gapMinutes, isAsync, scoreSection, solveSchedule, validateSchedule } from '../core/scheduleSolver';
import type { SectionRecord } from '../core/sections';
import { UT_SUBJECTS } from '../data/subjects';

const EXAMPLE =
    'Build me a schedule for next semester that helps me become core complete, no history classes, really high A grades to protect my GPA, classes only on Tuesdays and Thursdays, preferably 1–2 online, 12–13 credit hours. I plan on taking classes through ACC. Make sure all classes are back to back so I have no awkward gaps.';

const SUBJECT_CODES = new Set(UT_SUBJECTS.map(s => s.code));
const parse = (...messages: string[]) => planningPreferences(messages, SUBJECT_CODES, UT_SUBJECTS);

const tth = (start: number, end: number): Meeting[] => [{ days: ['T', 'TH'], start, end }];
let next = 10000;
function section(
    courseCode: string,
    title: string,
    meetings: Meeting[],
    opts: Partial<SectionRecord> = {}
): SectionRecord {
    const uniqueId = opts.uniqueId ?? next++;
    return {
        uniqueId,
        courseCode,
        title,
        semester: { year: 2027, season: 'Spring' },
        instructors: ['DOE, J'],
        creditHours: 3,
        meetings,
        scheduleComplete: true,
        modality: meetings.length ? 'in-person' : 'async-online',
        core: [],
        flags: [],
        isReserved: false,
        requirementTags: [],
        course: { uniqueId },
        capturedAt: 0,
        ...opts,
    };
}

/** The classes from the failed run plus realistic Tue/Thu alternatives */
const catalog = {
    ugs: section('UGS 302', 'ART & THE EPIDEMIC', tth(570, 660)),
    ast: section('AST 301', 'INTRODUCTION TO ASTRONOMY', tth(570, 660)),
    his: section('HIS 314K', 'HISTORY OF MEXICAN AMERICANS', tth(840, 930)),
    arhHist: section('ARH 301', 'SURVEY OF ANCIENT THROUGH MEDIEVAL ART', tth(660, 750)),
    ecoWed: section('ECO 101S', 'PRO DVLPMT/CAREER PLANNING', [{ days: ['W'], start: 930, end: 1020 }], {
        creditHours: 1,
    }),
    gov: section('GOV 310L', 'AMERICAN GOVERNMENT', tth(660, 750)),
    gov312: section('GOV 312L', 'ISSUES AND POLICIES IN AMERICAN GOV', tth(750, 840)),
    psy: section('PSY 301', 'INTRODUCTION TO PSYCHOLOGY', tth(1020, 1110)),
    mus: section('MUS 302L', 'INTRODUCTION TO WESTERN MUSIC', []),
    ntr: section('NTR 306', 'FUNDAMENTALS OF NUTRITION', [], { modality: 'async-online' }),
    mwf: section('M 408C', 'DIFFERENTIAL AND INTEGRAL CALCULUS', [{ days: ['M', 'W', 'F'], start: 600, end: 660 }], {
        creditHours: 4,
    }),
};
const all = Object.values(catalog);

function constraintsFrom(prefs: ReturnType<typeof parse>): ScheduleConstraints {
    return {
        minCredits: Math.max(12, prefs.credits?.min ?? 12),
        maxCredits: prefs.credits?.max ?? 16,
        creditsRequested: !!prefs.credits,
        avoidDays: prefs.avoidDays,
        excludedSubjects: prefs.excludedSubjects,
        excludedTitleWords: prefs.excludedTitleWords,
        excludedCourses: [],
        term: 'Spring 2027',
        online: prefs.asyncCount,
        backToBack: prefs.backToBack,
    };
}

const core = new Set(['GOV 310L', 'GOV 312L', 'UGS 302', 'PSY 301', 'MUS 302L', 'NTR 306', 'HIS 314K', 'AST 301']);
function candidates(sections: SectionRecord[], easy = true): SolverCandidate[] {
    return sections.map(s => {
        const applies = core.has(s.courseCode) ? [`CORE ${s.courseCode}`] : [];
        return {
            section: s,
            applies,
            prerequisite: 'none',
            score: scoreSection({
                applies,
                coreFocus: true,
                gradePercent: 85,
                gradeSample: 200,
                easyGrades: easy,
                aiPicked: false,
            }),
        };
    });
}

describe('reading the exact request', () => {
    const prefs = parse(EXAMPLE);
    it('extracts every constraint', () => {
        expect(prefs.credits).toEqual({ min: 12, max: 13 });
        expect(prefs.avoidDays).toEqual(expect.arrayContaining(['M', 'W', 'F']));
        expect(prefs.avoidDays).not.toContain('T');
        expect(prefs.avoidDays).not.toContain('TH');
        expect(prefs.excludedSubjects).toContain('HIS');
        expect(prefs.asyncCount).toEqual({ min: 1, max: 2 });
        expect(prefs.easyGrades).toBe(true);
        expect(prefs.coreFocus).toBe(true);
        expect(prefs.backToBack).toBe(true);
        expect(prefs.accPlanned).toBe(true);
        expect(prefs.plannedElsewhere).toEqual([]); // no specific ACC course named: nothing is assumed
    });

    it('understands other ways of saying Tuesday/Thursday only', () => {
        for (const text of [
            'only T/Th',
            'Tuesdays and Thursdays only',
            'TTh only please',
            'classes only on tues and thurs',
        ])
            expect(requestedOnlyDays(text)?.sort()).toEqual(['T', 'TH']);
        expect(parse('no MWF classes').avoidDays.sort()).toEqual(['F', 'M', 'W']);
        expect(parse('avoid Fridays').avoidDays).toEqual(['F']);
    });

    it('keeps earlier preferences unless the student changes them', () => {
        const later = parse(EXAMPLE, 'Actually Wednesdays are fine.');
        expect(later.avoidDays).not.toContain('W');
        expect(later.avoidDays).toContain('M');
        expect(later.excludedSubjects).toContain('HIS');
        expect(later.credits).toEqual({ min: 12, max: 13 });
        expect(parse(EXAMPLE, 'Give me 1 more online class').asyncCount?.min).toBe(2);
    });
});

describe('building the schedule', () => {
    const c = constraintsFrom(parse(EXAMPLE));

    it('Tuesday/Thursday only never includes a Wednesday class, and no HIS or history-titled course', async () => {
        const { best } = await solveSchedule(candidates(all), c);
        expect(best).not.toBeNull();
        const days = best!.sections.flatMap(s => s.meetings.flatMap(m => m.days));
        expect(days.every(d => d === 'T' || d === 'TH')).toBe(true);
        expect(best!.sections.map(s => s.courseCode)).not.toContain('ECO 101S');
        expect(best!.sections.map(s => s.courseCode)).not.toContain('HIS 314K');
        expect(best!.sections.some(s => /history/i.test(s.title))).toBe(false);
    });

    it('12–13 credits: never returns 10 credits as a complete schedule', async () => {
        const { best } = await solveSchedule(candidates(all), c);
        expect(best!.credits).toBeGreaterThanOrEqual(12);
        expect(best!.credits).toBeLessThanOrEqual(13);
        expect(validateSchedule(best!.sections, c).ok).toBe(true);
    });

    it('asynchronous online classes have no campus meetings and fit a Tuesday/Thursday week', async () => {
        const { best } = await solveSchedule(candidates(all), c);
        const online = best!.sections.filter(isAsync);
        expect(online.length).toBeGreaterThanOrEqual(1);
        expect(online.length).toBeLessThanOrEqual(2);
        expect(online.every(s => s.meetings.length === 0)).toBe(true);
    });

    it('"back to back" picks the compact week over a spread-out one', async () => {
        // same courses and grades; only the times differ
        const early = section('GOV 310L', 'AMERICAN GOVERNMENT', tth(660, 750), { uniqueId: 1 });
        const late = section('GOV 310L', 'AMERICAN GOVERNMENT', tth(1020, 1110), { uniqueId: 2 });
        const pool = [catalog.ugs, catalog.gov312, early, late, catalog.mus, catalog.ntr];
        const compact = await solveSchedule(candidates(pool), { ...c, online: null });
        expect(compact.best!.sections.map(s => s.uniqueId)).toContain(1);
        expect(gapMinutes(compact.best!.sections)).toBe(0);
        const spread = [catalog.ugs, catalog.gov312, late, catalog.mus, catalog.ntr];
        const loose = await solveSchedule(candidates(spread), { ...c, online: null });
        expect(gapMinutes(loose.best!.sections)).toBeGreaterThan(0);
        expect(compact.best!.score).toBeGreaterThan(loose.best!.score);
    });

    it('a refinement that drops below 12 credits is flagged, never silently accepted', async () => {
        const { best } = await solveSchedule(candidates(all), c);
        const fewer = best!.sections.slice(1);
        const check = validateSchedule(fewer, c);
        expect(check.ok).toBe(false);
        expect(check.errors.join(' ')).toMatch(/below the 12-credit minimum/);
        // and the solver can refill it while keeping the remaining classes
        const refill = await solveSchedule(candidates(all), c, {
            fixed: fewer,
            stable: new Set(fewer.map(s => s.uniqueId)),
        });
        expect(refill.best!.credits).toBeGreaterThanOrEqual(12);
        for (const s of fewer) expect(refill.best!.sections).toContain(s);
    });

    it('an impossible request explains why instead of returning a noncompliant schedule', async () => {
        // only two Tuesday/Thursday courses exist and no online classes
        const tiny = [catalog.ugs, catalog.gov, catalog.ecoWed, catalog.mwf];
        const result = await solveSchedule(candidates(tiny), c);
        expect(result.best).toBeNull();
        expect(result.report!.reasons.join(' ')).toMatch(/short of 12/);
        expect(result.report!.suggestions.map(x => x.text).join(' ')).toMatch(/Allow classes on Wednesday/);
        expect(result.report!.suggestions[0]!.patch.avoidDays).not.toContain('W');
    });

    it('validation catches every hard-rule violation in a hand-built schedule', () => {
        const bad = [catalog.ecoWed, catalog.his, catalog.ugs, catalog.ast];
        const v = validateSchedule(bad, c);
        expect(v.ok).toBe(false);
        const text = v.errors.join(' ');
        expect(text).toMatch(/ECO 101S .* meets on Wednesday/);
        expect(text).toMatch(/HIS 314K .* leave out/);
        expect(text).toMatch(/AST 301 .* overlaps UGS 302/);
        expect(text).toMatch(/below the 12-credit minimum/);
    });
});
