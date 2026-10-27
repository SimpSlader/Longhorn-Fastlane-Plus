/**
 * The copilot's tools on a small catalog, including the request that used to come back as a list of ECO 304L
 * sections: about 15 hours, Tuesday/Thursday only, 2–3 online, high A rates, core first, no history, a UGS with
 * backups, back to back, Macro if it fits.
 */
import { describe, expect, it } from 'vitest';
import { academicModel } from '../core/academicModel';
import { runTool, type ToolContext } from '../core/agentTools';
import type { GradeStat } from '../core/grades';
import { tagsForSection } from '../core/requirements';
import type { SectionRecord } from '../core/sections';
import { sectionFixture } from './factories';

const sec = (
    id: number,
    code: string,
    opts: { times?: Array<[string, string]>; core?: string[]; instructors?: string[]; title?: string } = {}
): SectionRecord => ({
    ...sectionFixture(id, code, {
        times: opts.times,
        core: opts.core,
        instructors: opts.instructors,
        title: opts.title,
    }),
    course: {},
});
const TTH = (h: string): Array<[string, string]> => [['TTH', h]];
const catalog: SectionRecord[] = [
    sec(1, 'UGS 302', { times: TTH('9:30 a.m.-11:00 a.m.'), core: ['ugs'], instructors: ['Lee, Ann'] }),
    sec(2, 'UGS 303', { times: TTH('11:00 a.m.-12:30 p.m.'), core: ['ugs'], instructors: ['Park, Joe'] }),
    sec(3, 'UGS 303', { times: [['MWF', '10:00 a.m.-11:00 a.m.']], core: ['ugs'] }),
    sec(4, 'UGS 302', { times: TTH('2:00 p.m.-3:30 p.m.'), core: ['ugs'], instructors: ['Diaz, Ana'] }),
    sec(10, 'ECO 304L', {
        times: TTH('12:30 p.m.-2:00 p.m.'),
        core: ['080'],
        instructors: ['Gojani, Martin'],
        title: 'Intro to Macroeconomics',
    }),
    sec(11, 'HIS 315K', { times: TTH('12:30 p.m.-2:00 p.m.'), core: ['060'] }),
    sec(20, 'GOV 310L', { core: ['070'] }), // asynchronous online
    sec(21, 'SED 303', {}),
    sec(22, 'AST 301', { core: ['030'] }),
    ...Array.from({ length: 9 }, (_, i) =>
        sec(100 + i, 'GOV 312L', { times: TTH(`${3 + (i % 2)}:30 p.m.-${5 + (i % 2)}:00 p.m.`), core: ['070'] })
    ),
    sec(30, 'M 302', { times: [['MWF', '9:00 a.m.-10:00 a.m.']], core: ['020'] }),
];
const RATES: Record<string, number> = {
    'UGS 302': 92,
    'UGS 303': 85,
    'ECO 304L': 74,
    'GOV 310L': 80,
    'SED 303': 95,
    'AST 301': 70,
    'GOV 312L': 66,
    'HIS 315K': 99,
};
const outstanding = [...new Set(catalog.flatMap(s => tagsForSection({ courseCode: s.courseCode, core: s.core })))];
const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    catalog,
    term: 'Spring 2027',
    audit: null,
    model: academicModel(null),
    taken: new Set(),
    outstanding,
    subjectIndex: [],
    gradeStat: async s =>
        ({
            result: { percent: RATES[s.courseCode] ?? 60, graded: 400 },
        }) as unknown as GradeStat,
    rmp: async (_first, last) =>
        last === 'gojani'
            ? {
                  legacyId: 1,
                  name: 'Martin Gojani',
                  department: 'Economics',
                  avgRating: 4.6,
                  avgDifficulty: 2.2,
                  numRatings: 80,
                  wouldTakeAgainPercent: 90,
              }
            : null,
    current: null,
    remember: async () => {},
    ...overrides,
});

const SCENARIO = {
    minCredits: 14,
    maxCredits: 16,
    onlyDays: ['T', 'TH'],
    onlineMin: 2,
    onlineMax: 3,
    backToBack: true,
    prioritizeGrades: true,
    prioritizeRatings: true,
    coreFocus: true,
    includeSubjects: ['UGS'],
    excludeSubjects: ['HIS'],
    preferCourses: ['ECO 304L'],
};

describe('copilot tools', () => {
    it('builds a complete schedule for the reported request, with UGS backups and a big general backup', async () => {
        const out = await runTool('build_schedule', SCENARIO, ctx());
        const r = out.result as {
            totalCredits: number;
            classes: Array<{
                code: string;
                mode: string;
                when: string;
                historicalARate: { percent: number } | null;
                rateMyProfessors: unknown;
            }>;
            backups: {
                perClass: Array<{ for: string; options: Array<{ code: string }> }>;
                general: Array<{ code: string }>;
            };
            couldNotInclude: string[];
        };
        expect(out.plan?.sections.length).toBeGreaterThan(3);
        expect(r.totalCredits).toBeGreaterThanOrEqual(14);
        expect(r.totalCredits).toBeLessThanOrEqual(16);
        const codes = r.classes.map(c => c.code);
        expect(codes.some(c => c.startsWith('UGS'))).toBe(true);
        expect(codes).not.toContain('HIS 315K');
        expect(codes).toContain('ECO 304L');
        expect(r.classes.filter(c => c.mode.startsWith('online (asynchronous)')).length).toBeGreaterThanOrEqual(2);
        // only Tuesday/Thursday meetings
        expect(
            r.classes.every(
                c =>
                    c.mode.startsWith('online') || !/\b(?:M|W|F)\b|Mon|Wed|Fri/.test(c.when.replace(/TTH|Tue|Thu/g, ''))
            )
        ).toBe(true);
        expect(r.classes.find(c => c.code === 'ECO 304L')?.rateMyProfessors).toMatchObject({
            quality: 4.6,
            ratings: 80,
        });
        const ugs = r.classes.find(c => c.code.startsWith('UGS'))!.code;
        const ugsBackups = r.backups.perClass.find(b => b.for === ugs)!.options.map(o => o.code);
        expect(ugsBackups.filter(c => c.startsWith('UGS')).length).toBeGreaterThanOrEqual(1);
        expect([...ugsBackups, ...r.backups.general.map(g => g.code)]).toContain('GOV 312L');
        expect(r.couldNotInclude).toEqual([]);
    });

    it('changes one thing on a follow-up and keeps the rest', async () => {
        const first = await runTool('build_schedule', SCENARIO, ctx());
        const current = {
            sections: first.plan!.sections,
            constraints: first.plan!.constraints,
            pool: first.plan!.pool,
        };
        const out = await runTool('modify_schedule', { remove: ['ECO 304L'] }, ctx({ current }));
        const r = out.result as { classes: Array<{ code: string }>; changed: { removed: string[] } };
        expect(r.classes.map(c => c.code)).not.toContain('ECO 304L');
        expect(r.changed.removed.join(' ')).toMatch(/ECO 304L/);
        expect(r.classes.some(c => c.code.startsWith('UGS'))).toBe(true);
    });

    it('looks up sections, professors and courses from real data and says when something is missing', async () => {
        const sections = (await runTool('get_course_sections', { course: 'eco 304l' }, ctx())).result as {
            sections: Array<{ unique: string; historicalARate: { percent: number } }>;
        };
        expect(sections.sections[0]).toMatchObject({ unique: '00010', historicalARate: { percent: 74 } });
        const prof = (await runTool('get_professor', { name: 'Martin Gojani' }, ctx())).result as {
            rateMyProfessors: { quality: number };
        };
        expect(prof.rateMyProfessors.quality).toBe(4.6);
        // no reviews: said plainly, never made up
        const noReviews = (await runTool('get_professor', { name: 'Park, Joe' }, ctx())).result as {
            rateMyProfessors: { quality: number | null; note: string };
        };
        expect(noReviews.rateMyProfessors).toMatchObject({ quality: null, note: 'no Rate My Professors match' });
        const ugs = (await runTool('search_courses', { requirement: 'signature course' }, ctx())).result as {
            courses: Array<{ code: string }>;
        };
        expect(ugs.courses.map(c => c.code).sort()).toEqual(['UGS 302', 'UGS 303']);
        const none = (await runTool('get_course_sections', { course: 'ZZZ 999' }, ctx())).result as { note: string };
        expect(none.note).toMatch(/No listed sections/);
    });

    it('flags a course the student already took and impossible rule sets', async () => {
        const taken = (
            await runTool('get_course_sections', { course: 'ECO 304L' }, ctx({ taken: new Set(['ECO 304L']) }))
        ).result as { alreadyTakenOrInProgress: boolean };
        expect(taken.alreadyTakenOrInProgress).toBe(true);
        // Mondays only can't reach 21 credits (two Monday sections plus three online classes)
        const impossible = await runTool('build_schedule', { minCredits: 21, maxCredits: 21, onlyDays: ['M'] }, ctx());
        expect((impossible.result as { error?: string }).error).toMatch(/No complete schedule/);
        expect(impossible.plan).toBeUndefined();
    });
});
