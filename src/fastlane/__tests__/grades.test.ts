import { describe, expect, it } from 'vitest';

import {
    buildGradeStat,
    computeThreshold,
    describeGradeStat,
    describeSemesters,
    formatPercent,
    GRADE_THRESHOLDS,
    InvalidGradeCountsError,
    lettersAtOrAbove,
    sortSemesterLabels,
    sumCounts,
    thresholdLabel,
} from '../core/grades';

// 100 letter grades, 10 per letter A..D-, F gets 0 except where noted. Easy to verify by hand.
const even = { A: 10, 'A-': 10, 'B+': 10, B: 10, 'B-': 10, 'C+': 10, C: 10, 'C-': 10, 'D+': 10, D: 10, 'D-': 0, F: 0 };

describe('computeThreshold', () => {
    it('defaults to A- or better = A + A- (+ A+ when present)', () => {
        const r = computeThreshold({ A: 50, 'A-': 20, 'B+': 30 }, 'A-');
        expect(r).toMatchObject({ atOrAbove: 70, graded: 100, percent: 70 });
    });

    it('includes A+ in A- or better when a dataset contains it', () => {
        const r = computeThreshold({ 'A+': 5, A: 45, 'A-': 20, 'B+': 30 }, 'A-');
        expect(r?.atOrAbove).toBe(70);
        expect(r?.graded).toBe(100);
    });

    it('computes every threshold boundary exactly', () => {
        const expected: Record<string, number> = {
            A: 10,
            'A-': 20,
            'B+': 30,
            B: 40,
            'B-': 50,
            'C+': 60,
            C: 70,
            'C-': 80,
            'D+': 90,
            D: 100,
            'D-': 100,
        };
        for (const t of GRADE_THRESHOLDS) {
            expect(computeThreshold(even, t)?.percent, t).toBeCloseTo(expected[t]!, 10);
        }
    });

    it('a grade exactly at the threshold counts; one step below does not', () => {
        expect(computeThreshold({ 'B+': 1, B: 1 }, 'B+')?.atOrAbove).toBe(1);
        expect(computeThreshold({ 'B+': 1, B: 1 }, 'B')?.atOrAbove).toBe(2);
    });

    it('excludes non-letter outcomes (Other) from numerator AND denominator', () => {
        const r = computeThreshold({ A: 30, B: 70, Other: 400 }, 'A-');
        expect(r).toMatchObject({ atOrAbove: 30, graded: 100, excluded: 400, percent: 30 });
    });

    it('counts F in the denominator', () => {
        expect(computeThreshold({ A: 1, F: 3 }, 'A')?.percent).toBe(25);
    });

    it('returns null instead of inventing a number when there are no letter grades', () => {
        expect(computeThreshold({}, 'A-')).toBeNull();
        expect(computeThreshold({ Other: 25 }, 'A-')).toBeNull();
    });

    it('rejects negative, fractional and non-numeric counts', () => {
        expect(() => computeThreshold({ A: -1 }, 'A')).toThrow(InvalidGradeCountsError);
        expect(() => computeThreshold({ A: 1.5 }, 'A')).toThrow(InvalidGradeCountsError);
        expect(() => computeThreshold({ A: Number.NaN }, 'A')).toThrow(InvalidGradeCountsError);
        expect(() => computeThreshold({ A: '3' as unknown as number }, 'A')).toThrow(InvalidGradeCountsError);
    });

    it('uses real-looking UT counts', () => {
        // MUS 302L style distribution
        const counts = {
            A: 612,
            'A-': 211,
            'B+': 98,
            B: 77,
            'B-': 41,
            'C+': 22,
            C: 19,
            'C-': 9,
            'D+': 4,
            D: 6,
            'D-': 2,
            F: 36,
            Other: 58,
        };
        const r = computeThreshold(counts, 'A-')!;
        expect(r.graded).toBe(1137);
        expect(r.atOrAbove).toBe(823);
        expect(formatPercent(r.percent)).toBe('72.3%');
    });
});

describe('helpers', () => {
    it('lists letters at or above a threshold', () => {
        expect(lettersAtOrAbove('B+')).toEqual(['A+', 'A', 'A-', 'B+']);
    });

    it('sums counts across semesters', () => {
        expect(
            sumCounts([
                { A: 1, Other: 2 },
                { A: 3, B: 4 },
            ])
        ).toEqual({ A: 4, B: 4, Other: 2 });
    });

    it('formats without rounding up to a misleading value', () => {
        expect(formatPercent(72.36)).toBe('72.3%');
        expect(formatPercent(99.99)).toBe('99.9%');
        expect(formatPercent(100)).toBe('100%');
        expect(formatPercent(0)).toBe('0.0%');
    });

    it('labels thresholds', () => {
        expect(thresholdLabel('A-')).toBe('A-+');
        expect(thresholdLabel('B+')).toBe('B+ or better');
        expect(thresholdLabel('A')).toBe('A or better');
    });

    it('sorts semesters chronologically', () => {
        expect(sortSemesterLabels(['Fall 2023', 'Spring 2023', 'Summer 2023', 'Spring 2022', 'Fall 2023'])).toEqual([
            'Spring 2022',
            'Spring 2023',
            'Summer 2023',
            'Fall 2023',
        ]);
        expect(describeSemesters(['Fall 2023', 'Spring 2022'])).toBe('2 semesters (Spring 2022 – Fall 2023)');
    });

    it('describes provenance, scope and small samples', () => {
        const stat = buildGradeStat({
            scope: 'instructor',
            instructor: 'Smith',
            courseCode: 'MUS 302L',
            result: computeThreshold({ A: 5, B: 5, Other: 1 }, 'A-')!,
            semesters: ['Fall 2024'],
            source: 'UT Austin grade distributions',
            datasetVersion: '2026.08',
            datasetUpdated: '2026-08-20',
        });
        expect(stat.smallSample).toBe(true);
        const text = describeGradeStat(stat);
        expect(text).toContain('Professor Smith');
        expect(text).toContain('10 letter grades');
        expect(text).toContain('1 non-letter');
        expect(text).toContain('Small sample');
        expect(text).toContain('not a prediction');
    });
});
