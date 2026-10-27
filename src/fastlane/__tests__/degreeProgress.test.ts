import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseAuditHtml } from '../audit/parseAudit';
import { degreeTotals, hasMinor, summarizeRequirements } from '../audit/progress';
import type { AuditRequirement } from '../audit/types';

const audit = (file: string) =>
    parseAuditHtml(
        new DOMParser().parseFromString(readFileSync(resolve(__dirname, 'fixtures', file), 'utf8'), 'text/html'),
        file
    );
const real = audit('dap-audit-results-real.html');
const of = (category: AuditRequirement['category']) => real.requirements.filter(r => r.category === category);

describe('degree progress from a real IDA', () => {
    it('uses the IDA core total (42 hours) without adding the sub-rules on top', () => {
        const core = summarizeRequirements(of('core'));
        expect(core.figure).toEqual({ done: 27, total: 42, unit: 'hours' });
        expect(core.remainingText).toBe('15 credit hours remaining');
        // the total rule itself is not listed as a requirement
        expect(core.items.some(r => /42 hours are required/.test(r.text))).toBe(false);
        expect(core.counts).toEqual({ completed: 6, inProgress: 3, remaining: 1, total: 10 });
    });

    it('shows requirement counts, not invented hours, when a category mixes courses and hours', () => {
        const major = summarizeRequirements(of('major'));
        expect(major.figure).toEqual({ done: 6, total: 9, unit: 'requirements' });
        expect(major.hoursNeedVerification).toBe(true);
        expect(major.remainingText).toBe('3 requirements left');
    });

    it('reads the official percentage, degree hours, residence hours and GPA as the IDA states them', () => {
        expect(degreeTotals(real)).toMatchObject({
            official: 68,
            totalHours: { total: 120, done: 82, remaining: 38 },
            residence: { done: 60, total: 60 },
            gpa: [
                { label: 'University GPA', value: 3.7766, minimum: 2 },
                { label: 'mathematics', value: 3.6091, minimum: 2 },
            ],
        });
    });

    it('hides the minor card when the degree requires no minor', () => {
        expect(hasMinor(real.requirements)).toBe(false);
    });

    it('never invents an official percentage', () => {
        const basic = audit('dap-audit-results.html');
        // upper-division rules are read from the IDA too, not hardcoded
        expect(degreeTotals(real).upperDivision).toEqual({ done: 32, total: 42 });
        expect(degreeTotals(basic).official).toBeNull();
        expect(degreeTotals(basic).totalHours).toBeNull();
    });

    it('sums hours only when rules are all in hours and share no courses', () => {
        const rule = (id: string, required: number, applied: number, courses: string[]): AuditRequirement => ({
            id,
            section: 'Major',
            text: `rule ${id}`,
            category: 'major',
            status: applied >= required ? 'completed' : 'in-progress',
            required: { value: required, unit: 'hours' },
            applied: { value: applied, unit: 'hours' },
            tags: [],
            courses,
            confidence: 'high',
            issues: [],
        });
        expect(summarizeRequirements([rule('a', 3, 3, ['M 408C']), rule('b', 6, 3, ['M 408D'])]).figure).toEqual({
            done: 6,
            total: 9,
            unit: 'hours',
        });
        // the same course under two rules would be counted twice: fall back to counts
        const overlapping = summarizeRequirements([rule('a', 3, 3, ['M 408C']), rule('b', 6, 3, ['M 408C'])]);
        expect(overlapping.figure?.unit).toBe('requirements');
        expect(overlapping.hoursNeedVerification).toBe(true);
    });
});
