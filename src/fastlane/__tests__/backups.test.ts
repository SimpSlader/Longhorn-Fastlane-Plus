import { describe, expect, it } from 'vitest';
import { buildBackups, SAFE_SECTIONS, sectionCounts } from '../core/backups';
import { tagsForSection } from '../core/requirements';
import { sectionFixture } from './factories';

const ugs = (id: number, code: string, time: string) =>
    sectionFixture(id, code, { times: [['TTH', time]], core: ['ugs'] });

describe('backups for a proposed week', () => {
    const plan = [
        ugs(1, 'UGS 303', '9:30 a.m.-11:00 a.m.'),
        sectionFixture(2, 'ECO 304K', { times: [['TTH', '11:00 a.m.-12:30 p.m.']] }),
    ];
    // many GOV 310L sections make it the "safe" fallback
    const gov = Array.from({ length: SAFE_SECTIONS + 2 }, (_, i) =>
        sectionFixture(100 + i, 'GOV 310L', {
            times: [['MWF', `${8 + (i % 3)}:00 a.m.-${8 + (i % 3)}:50 a.m.`]],
            core: ['070'],
        })
    );
    const candidates = [
        ...plan,
        ugs(10, 'UGS 302', '2:00 p.m.-3:30 p.m.'),
        ugs(11, 'UGS 303', '3:30 p.m.-5:00 p.m.'), // another section of the same course
        ugs(12, 'UGS 302', '11:00 a.m.-12:30 p.m.'), // overlaps ECO 304K: never a backup for UGS 303
        ugs(13, 'UGS 303', '9:30 a.m.-11:00 a.m.'),
        sectionFixture(20, 'ECO 304K', { times: [['MW', '1:00 p.m.-2:30 p.m.']] }),
        sectionFixture(30, 'SED 303', { modality: 'async-online' }),
        sectionFixture(31, 'SED 303', { status: { value: 'CLOSED', observedAt: 0, source: 'test' } }),
        ...gov,
    ];
    const outstanding = [...new Set([...tagsForSection({ courseCode: 'UGS 303', core: ['ugs'] }), 'CORE 070'])];
    const grades = new Map([
        [10, 95],
        [11, 70],
        [13, 60],
    ]);
    const result = buildBackups({
        plan,
        candidates,
        outstanding,
        taken: new Set(),
        gradeOf: s => grades.get(s.uniqueId) ?? null,
        sectionCounts: sectionCounts(candidates),
    });

    it('gives each class two backups of the same kind and a safe fallback, ranked by A rate', () => {
        const forUgs = result.perClass.find(x => x.for.courseCode === 'UGS 303')!;
        // the highest historical A rate comes first (95% UGS 302), then another section of UGS 303
        expect(forUgs.backups.map(b => b.section.uniqueId).slice(0, 2)).toEqual([10, 11]);
        expect(forUgs.backups.map(b => b.kind).slice(1)).toEqual(['same course', 'safe']);
        expect(forUgs.backups[2]!.section.courseCode).toBe('GOV 310L');
        expect(forUgs.backups[2]!.why).toMatch(/UT lists 10 sections/);
    });

    it('never suggests a class that overlaps the rest of the week, a closed section, or the same class twice', () => {
        const all = [...result.perClass.flatMap(x => x.backups), ...result.general].map(b => b.section.uniqueId);
        expect(all).not.toContain(12);
        expect(all).not.toContain(31);
        expect(new Set(all).size).toBe(all.length);
        const forEco = result.perClass.find(x => x.for.courseCode === 'ECO 304K')!;
        expect(forEco.backups[0]!.section.uniqueId).toBe(20);
    });

    it('general backups fit beside the whole week', () => {
        expect(result.general.length).toBeGreaterThan(0);
        for (const b of result.general) expect(plan.some(p => p.courseCode === b.section.courseCode)).toBe(false);
        // a course with many sections that counts toward an unfinished requirement
        expect(result.general.some(b => b.section.courseCode === 'GOV 310L')).toBe(true);
    });
});
