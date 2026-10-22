import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, matchesFilters } from '../core/planning';
import { availableSubjects, subjectForCode, UT_SUBJECTS } from '../data/subjects';
import { sectionFixture } from './factories';

describe('official UT A–Z subject selection', () => {
    it('includes all 2026–27 fields, not merely locally visited departments', () => {
        expect(UT_SUBJECTS.length).toBeGreaterThan(250);
        expect(new Set(UT_SUBJECTS.map(s => s.code)).size).toBe(UT_SUBJECTS.length);
        expect(subjectForCode('ECO')?.name).toBe('Economics');
        expect(subjectForCode('ACC')?.name).toBe('Accounting');
        expect(subjectForCode('A I')?.name).toBe('Artificial Intelligence');
        expect(subjectForCode('FIN')?.name).toBe('Finance');
        expect(subjectForCode('UGS')?.name).toBe('Undergraduate Studies');
    });
    it('offers Economics even when the only cached department is UGS', () => {
        const subjects = availableSubjects(['UGS']);
        expect(subjects.some(s => s.code === 'ECO')).toBe(true);
        expect(subjects.some(s => s.code === 'UGS')).toBe(true);
    });
    it('never returns UGS when Economics is explicitly selected', () => {
        const ugs = sectionFixture(11111, 'UGS 302');
        const eco = sectionFixture(22222, 'ECO 304L');
        const filters = { ...DEFAULT_FILTERS, department: 'ECO' };
        expect(matchesFilters(ugs, filters, new Map())).toBe(false);
        expect(matchesFilters(eco, filters, new Map())).toBe(true);
    });
    it('keeps spaced department codes such as Computer Science distinct', () => {
        const codes = availableSubjects(['C S', 'C C', 'ECO']);
        expect(codes.find(s => s.code === 'C S')?.name).toBe('Computer Science');
        expect(codes.find(s => s.code === 'C C')?.name).toBe('Classical Civilization');
    });
});
