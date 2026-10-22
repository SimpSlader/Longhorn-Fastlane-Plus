import { describe, expect, it } from 'vitest';

import type { GradeStat } from '../core/grades';
import { buildGradeStat, computeThreshold } from '../core/grades';
import { recommend } from '../core/recommend';
import { coreTagFromListing, normalizeCourseCode, sectionMatchesRequirement, tagsForSection } from '../core/requirements';
import type { SectionRecord } from '../core/sections';
import { availabilityDisplay, toSectionTimes } from '../core/sections';
import { sectionFixture } from './factories';

const ARTS = ['Visual & Performing Arts'];
const NOW = Date.UTC(2026, 10, 9, 14, 0);

const statFor = (percent: number, graded: number, scope: 'instructor' | 'course' = 'course'): GradeStat =>
    buildGradeStat({
        scope,
        courseCode: 'X',
        instructor: scope === 'instructor' ? 'Smith' : undefined,
        result: computeThreshold(
            { A: Math.round((percent / 100) * graded), B: graded - Math.round((percent / 100) * graded) },
            'A-'
        )!,
        semesters: ['Fall 2025'],
        source: 'test',
        datasetVersion: '1',
        datasetUpdated: '2026-01-01',
    });

describe('requirement tags', () => {
    it('maps the course schedule Core column to core codes', () => {
        expect(coreTagFromListing('Visual & Performing Arts')).toBe('CORE 050');
        expect(coreTagFromListing('Natural Science and Technology, Part II')).toBe('CORE 093');
        expect(coreTagFromListing('Natural Science and Technology, Part I')).toBe('CORE 030');
        expect(coreTagFromListing('First-Year Signature Course')).toBe('CORE 090');
        expect(coreTagFromListing('Something else')).toBeNull();
        expect(tagsForSection({ courseCode: 'mus  302l', core: ARTS })).toEqual(['COURSE MUS 302L', 'CORE 050']);
        expect(normalizeCourseCode('UGS302')).toBe('UGS 302');
    });
});


    it('matches a reviewed department as a possible fit but never calls it a specific course', () => {
        const eco = sectionFixture(98765, 'ECO 324');
        const ugs = sectionFixture(98766, 'UGS 302');
        expect(sectionMatchesRequirement(eco, 'DEPT ECO')).toBe(true);
        expect(sectionMatchesRequirement(ugs, 'DEPT ECO')).toBe(false);
        const results = recommend({
            requirements: ['DEPT ECO'],
            catalog: [eco, ugs],
            semester: 'Spring 2027',
            activeSchedule: [],
        });
        expect(results.map(r => r.section.courseCode)).toEqual(['ECO 324']);
        expect(results[0]?.reasons[0]).toMatch(/Possible fit/);
        expect(results[0]?.warnings.join(' ')).toMatch(/not official degree credit/);
    });

describe('recommend (emergency backups)', () => {
    const active = [toSectionTimes(sectionFixture(1, 'M 408C', { times: [['MWF', '10:00 a.m.-11:00 a.m.']] }))];

    // Western Music, Classical Mythology and Ancient Rome are all full (excluded); other Core 050 options exist
    const full = [23095, 33515, 33505];
    const catalog: SectionRecord[] = [
        sectionFixture(23095, 'MUS 302L', { core: ARTS }),
        sectionFixture(33515, 'C C 303', { core: ARTS }),
        sectionFixture(33505, 'C C 302', { core: ARTS }),
        sectionFixture(20001, 'ART 301', { core: ARTS, times: [['MWF', '10:00 a.m.-11:00 a.m.']] }), // conflicts
        sectionFixture(20002, 'T D 301', { core: ARTS, times: [['TTH', '2:00 p.m.-3:30 p.m.']] }),
        sectionFixture(20003, 'MUS 307', { core: ARTS, modality: 'async-online' }),
        sectionFixture(20004, 'ARH 301', { core: ARTS, times: [['MW', 'TBA']], complete: false }), // unknown
        sectionFixture(20005, 'GOV 310L', {
            core: ['American and Texas Government'],
            times: [['TTH', '8:00 a.m.-9:30 a.m.']],
        }),
        sectionFixture(20006, 'F A 308', {
            core: ARTS,
            times: [['TTH', '3:30 p.m.-5:00 p.m.']],
            semester: { year: 2026, season: 'Fall' },
        }),
        sectionFixture(20007, 'MUS 303M', {
            core: ARTS,
            times: [['MWF', '1:00 p.m.-2:00 p.m.']],
            status: { value: 'CANCELLED', observedAt: NOW, source: 'x' },
        }),
    ];
    const grades: Record<number, GradeStat> = {
        20002: statFor(81, 400, 'instructor'),
        20003: statFor(65, 900),
    };

    const base = {
        requirements: ['CORE 050'],
        catalog,
        semester: 'Spring 2027',
        activeSchedule: active,
        excludeUniqueIds: full,
        gradeFor: (s: SectionRecord) => grades[s.uniqueId] ?? null,
        now: NOW,
    };

    it('only suggests real catalog sections that satisfy an outstanding requirement', () => {
        const ids = recommend(base).map(r => r.section.uniqueId);
        expect(ids).not.toContain(20005); // wrong requirement
        expect(ids).not.toContain(20007); // cancelled
        for (const f of full) expect(ids).not.toContain(f);
        expect(new Set(ids).size).toBe(ids.length); // no duplicates
    });

    it('ranks semester, then conflicts, then grades', () => {
        const ids = recommend(base).map(r => r.section.uniqueId);
        // 20002 (clear, 81%), 20003 (clear, async, 65%), then unknown (20004), conflict (20001), then off-semester
        expect(ids).toEqual([20002, 20003, 20004, 20001, 20006]);
    });

    it('reliable grade percentage outranks delivery preference', () => {
        const ids = recommend({ ...base, prefs: { preferAsync: true } }).map(r => r.section.uniqueId);
        expect(ids[0]).toBe(20002);
    });

    it('avoid-Friday preference demotes Friday meetings among otherwise equal options', () => {
        const a = sectionFixture(30001, 'ART 302', { core: ARTS, times: [['F', '1:00 p.m.-4:00 p.m.']] });
        const b = sectionFixture(30002, 'ART 303', { core: ARTS, times: [['W', '1:00 p.m.-4:00 p.m.']] });
        const ids = recommend({ ...base, catalog: [a, b], prefs: { avoidFriday: true } }).map(r => r.section.uniqueId);
        expect(ids).toEqual([30002, 30001]);
    });

    it('excludes courses already completed', () => {
        const ids = recommend({ ...base, excludeCourseCodes: ['T D 301'] }).map(r => r.section.uniqueId);
        expect(ids).not.toContain(20002);
    });

    it('never claims availability without an observed status', () => {
        const recs = recommend(base);
        expect(recs.every(r => r.availability.text === 'Check availability')).toBe(true);
    });

    it('explains warnings honestly', () => {
        const rec = recommend(base).find(r => r.section.uniqueId === 20001)!;
        expect(rec.conflict.status).toBe('conflict');
        expect(rec.warnings.join(' ')).toContain('Conflicts with M 408C (00001)');
        expect(
            recommend(base)
                .find(r => r.section.uniqueId === 20004)!
                .warnings.join(' ')
        ).toContain('No historical grade data');
    });

    it('returns nothing when there are no outstanding requirements', () => {
        expect(recommend({ ...base, requirements: [] })).toEqual([]);
    });
});

describe('availabilityDisplay', () => {
    it('only says open with a fresh observed status and timestamp', () => {
        expect(availabilityDisplay(undefined, NOW)).toEqual({ tone: 'check', text: 'Check availability' });
        const fresh = availabilityDisplay(
            { value: 'OPEN', observedAt: NOW - 5 * 60_000, source: 'UT course schedule' },
            NOW
        );
        expect(fresh.tone).toBe('open');
        expect(fresh.text).toMatch(/^Open as of .+ \(UT course schedule\)$/);
        const stale = availabilityDisplay({ value: 'OPEN', observedAt: NOW - 3 * 60 * 60_000, source: 'x' }, NOW);
        expect(stale.tone).toBe('check');
        expect(stale.text).toContain('Check availability');
        expect(availabilityDisplay({ value: 'CLOSED', observedAt: NOW, source: 'x' }, NOW).tone).toBe('closed');
    });
});
