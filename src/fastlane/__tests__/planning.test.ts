import { describe, expect, it } from 'vitest';
import type { ParsedAudit } from '../audit/types';
import {
    confirmedAuditHours,
    DEFAULT_FILTERS,
    generateSchedules,
    matchesFilters,
    metrics,
    prerequisiteStatus,
    roadmapProjection,
} from '../core/planning';
import { sectionFixture } from './factories';

const filters = { ...DEFAULT_FILTERS, semester: 'Spring 2027' };
const emptyAudit = {
    source: 'html',
    parsedAt: 0,
    requirements: [],
    courses: [],
    transfer: { accepted: [], pending: [] },
    creditHours: { confidence: 'low' },
    restrictions: [],
    warnings: [],
} as ParsedAudit;
const course = (code: string, status: 'completed' | 'in-progress' | 'pending-transfer', grade = 'A') => ({
    code,
    status,
    grade,
    hours: 3,
    name: code,
    unique: '',
    type: '',
    semester: '',
});
const section = (id: number, code: string, days = 'TTH', time = '9:00 a.m.-10:00 a.m.') => ({
    ...sectionFixture(id, code, { times: [[days, time]] }),
    course: { cached: true },
});

describe('planning constraints and metrics', () => {
    it('enforces Tuesday/Thursday and morning limits, without assuming unknown times fit', () => {
        const f = { ...filters, days: ['T', 'TH'] as const, end: 720 };
        expect(matchesFilters(section(1, 'M 301'), { ...f, days: [...f.days] }, new Map())).toBe(true);
        expect(matchesFilters(section(2, 'M 301', 'MWF'), { ...f, days: [...f.days] }, new Map())).toBe(false);
        expect(
            matchesFilters(
                sectionFixture(3, 'M 301', { modality: 'in-person', complete: false }),
                { ...f, days: [...f.days] },
                new Map()
            )
        ).toBe(false);
        expect(matchesFilters(sectionFixture(4, 'M 301'), { ...f, days: [...f.days] }, new Map())).toBe(true);
    });
    it('only returns complete, same-term, conflict-free cached combinations', () => {
        const a = section(1, 'M 301');
        const overlap = section(2, 'BIO 301');
        const next = section(3, 'BIO 301', 'TTH', '10:00 a.m.-11:00 a.m.');
        const old = { ...next, uniqueId: 4, semester: { year: 2026, season: 'Spring' as const } };
        const closed = { ...next, uniqueId: 5, status: { value: 'CLOSED' as const, observedAt: 0, source: 'test' } };
        const result = generateSchedules(
            [a, overlap, next, old, closed],
            ['M 301', 'BIO 301'],
            { ...filters, noGaps: true },
            new Map()
        );
        expect(result.results.map(s => s.map(v => v.uniqueId))).toEqual([[1, 3]]);
        expect(generateSchedules([a], ['M 301', 'BIO 301'], filters, new Map()).results).toEqual([]);
    });
    it('tests no gaps only after a complete combination, allowing intermediate gaps to be filled', () => {
        const a = section(1, 'M 301');
        const b = section(2, 'BIO 301', 'TTH', '11:00 a.m.-12:00 p.m.');
        const c = section(3, 'CH 301', 'TTH', '10:00 a.m.-11:00 a.m.');
        expect(
            generateSchedules([a, b, c], ['M 301', 'BIO 301', 'CH 301'], { ...filters, noGaps: true }, new Map())
                .results
        ).toHaveLength(1);
        expect(
            generateSchedules([a, b], ['M 301', 'BIO 301'], { ...filters, noGaps: true }, new Map()).results
        ).toHaveLength(0);
    });
    it('reports unknown grades and times instead of zero-grade or conflict-free certainty', () => {
        const unknown = sectionFixture(9, 'M 301', { modality: 'in-person', complete: false });
        const m = metrics([unknown], new Map());
        expect(m.average).toBeNull();
        expect(m.unknownTimes).toBe(1);
        expect(matchesFilters(unknown, { ...filters, minGrade: 1 }, new Map())).toBe(false);
        expect(matchesFilters(unknown, { ...filters, fits: true }, new Map())).toBe(false);
    });
    it('reports daily gaps, Friday classes, credits and conflicts', () => {
        const a = section(1, 'M 301', 'MWF');
        const b = section(2, 'BIO 301', 'MWF', '11:00 a.m.-12:00 p.m.');
        const m = metrics([a, b], new Map());
        expect(m.hours).toBe(6);
        expect(m.friday).toBe(2);
        expect(m.gaps.M).toBe(60);
        expect(m.gapMinutes).toBe(180);
        expect(m.conflicts).toBe(0);
    });
});
describe('conservative academic estimates', () => {
    it('distinguishes completed, pending, absent and unsupported prerequisite rules', () => {
        const audit = {
            ...emptyAudit,
            courses: [course('M 408C', 'completed'), course('PHY 303K', 'pending-transfer')],
        };
        expect(prerequisiteStatus('M 408C', audit).status).toBe('Satisfied');
        expect(prerequisiteStatus('M 408C AND PHY 303K', audit).status).toBe('Possibly satisfied');
        expect(prerequisiteStatus('M 408D OR M 408C', audit).status).toBe('Satisfied');
        expect(prerequisiteStatus('M 408D', audit).status).toBe('Needs verification');
        expect(prerequisiteStatus('M 408C with a grade of C or better', audit).status).toBe('Needs verification');
        expect(prerequisiteStatus('M 408C', { ...audit, courses: [course('M 408C', 'completed', 'F')] }).status).toBe(
            'Needs verification'
        );
    });
    it('never counts pending credit as confirmed and excludes duplicate planned/completed credits', () => {
        const audit = {
            ...emptyAudit,
            courses: [
                course('M 408C', 'completed'),
                course('M 408C', 'completed'),
                course('PHY 303K', 'pending-transfer'),
                course('CH 301', 'completed', 'F'),
            ],
        };
        expect(confirmedAuditHours(audit)).toBe(3);
        const entries = ['M 408C', 'PHY 303K', 'PHY 303K'].map((code, i) => ({
            id: String(i),
            term: 'Summer 2027',
            code,
            hours: 3,
            kind: 'course' as const,
            rule: '',
        }));
        expect(roadmapProjection(entries, audit).planned).toBe(3);
    });
});
