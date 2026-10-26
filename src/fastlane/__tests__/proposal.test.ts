import { describe, expect, it } from 'vitest';

import type { Meeting } from '../core/meetings';
import {
    breaksPreferences,
    diffSections,
    fillSlots,
    refineIntent,
    replacementFits,
    resolveTarget,
} from '../core/proposal';
import type { SectionRecord } from '../core/sections';

const meet = (days: Meeting['days'], start: number, end: number): Meeting => ({ days, start, end });
const sec = (
    uniqueId: number,
    courseCode: string,
    title: string,
    meetings: Meeting[],
    modality: SectionRecord['modality'] = 'in-person'
): SectionRecord => ({
    uniqueId,
    courseCode,
    title,
    instructors: ['DOE, J'],
    creditHours: 3,
    meetings,
    scheduleComplete: true,
    modality,
    core: [],
    flags: [],
    isReserved: false,
    requirementTags: [],
    course: { uniqueId },
    capturedAt: 0,
});

const ast = sec(49325, 'AST 301', 'INTRODUCTION TO ASTRONOMY', [meet(['T', 'TH'], 570, 660)]);
const his = sec(12345, 'HIS 314K', 'HISTORY OF MEXICAN AMERICANS', [meet(['T', 'TH'], 840, 930)]);
const eco = sec(34220, 'ECO 101S', 'PRO DVLPMT/CAREER PLANNING', [meet(['W'], 930, 1020)]);
const plan = [ast, his, eco];

describe('which proposed class a message means', () => {
    it('uses the class clicked on the calendar first', () => {
        expect(resolveTarget('too late', plan, 34220)?.courseCode).toBe('ECO 101S');
    });
    it('finds course codes written loosely, unique numbers and title words', () => {
        expect(resolveTarget('replace his 314k please', plan)?.uniqueId).toBe(12345);
        expect(resolveTarget('swap HIS314K', plan)?.uniqueId).toBe(12345);
        expect(resolveTarget('drop 49325', plan)?.uniqueId).toBe(49325);
        expect(resolveTarget('astronomy is too early', plan)?.uniqueId).toBe(49325);
    });
    it('does not guess when nothing names a class', () => {
        expect(resolveTarget('this class is too late', plan)).toBeNull();
    });
});

describe('what the student asks for', () => {
    it('reads the requested kinds of change', () => {
        expect(refineIntent("I don't need this degree requirement anymore").dropRequirement).toBe(true);
        expect(refineIntent('This class is too late in the day').earlier).toBe(true);
        expect(refineIntent('Replace this class with something easier').easier).toBe(true);
        expect(refineIntent("I'd rather have an online class").online).toBe(true);
        expect(refineIntent('I already plan to take this class through ACC').elsewhere).toBe(true);
        expect(refineIntent('remove this one').removeOnly).toBe(true);
        expect(refineIntent('Keep everything else, but replace this one course').removeOnly).toBe(false);
    });
});

describe('replacements', () => {
    const grade = (s: SectionRecord) => ({ 12345: 60, 1: 90, 2: 50 })[s.uniqueId as 1] ?? null;
    it('an earlier class must end before the late one did', () => {
        const morning = sec(1, 'GOV 310L', 'AMERICAN GOVERNMENT', [meet(['M', 'W'], 600, 650)]);
        const evening = sec(2, 'GOV 312L', 'ISSUES', [meet(['M'], 1080, 1260)]);
        expect(replacementFits(morning, his, refineIntent('too late'), grade)).toBe(true);
        expect(replacementFits(evening, his, refineIntent('too late'), grade)).toBe(false);
    });
    it('easier means a higher historical A rate than the class it replaces', () => {
        const a = sec(1, 'GOV 310L', 'A', [meet(['M'], 600, 650)]);
        const b = sec(2, 'GOV 312L', 'B', [meet(['M'], 600, 650)]);
        expect(replacementFits(a, his, refineIntent('something easier'), grade)).toBe(true);
        expect(replacementFits(b, his, refineIntent('something easier'), grade)).toBe(false);
    });
    it('online means async or live online only', () => {
        const web = sec(1, 'GOV 310L', 'A', [], 'async-online');
        expect(replacementFits(web, his, refineIntent('rather online'), grade)).toBe(true);
        expect(replacementFits(ast, his, refineIntent('rather online'), grade)).toBe(false);
    });
    it('fills the open place without conflicts or duplicate courses, keeping the rest', () => {
        const clash = sec(7, 'GOV 310L', 'CLASH', [meet(['T'], 600, 650)]);
        const dupe = sec(8, 'AST 301', 'OTHER AST', [meet(['F'], 600, 650)]);
        const ok = sec(9, 'PSY 301', 'INTRO PSYCH', [meet(['M', 'W'], 600, 650)]);
        const lookup = new Map([clash, dupe, ok].map(s => [s.uniqueId, s]));
        const kept = [ast, eco];
        expect(fillSlots(kept, [7, 8, 9], lookup, 1).map(s => s.uniqueId)).toEqual([49325, 34220, 9]);
    });
    it('reports what changed between versions', () => {
        expect(diffSections(plan, [ast, eco, sec(9, 'PSY 301', 'P', [])])).toEqual({ added: [9], removed: [12345] });
    });
    it('whole-plan follow-ups flag only classes that break the new preferences', () => {
        const prefs = { avoidDays: ['W' as const], timeOfDay: 'any', leftOut: new Set<string>(), noOnline: false };
        expect(plan.filter(s => breaksPreferences(s, prefs)).map(s => s.courseCode)).toEqual(['ECO 101S']);
    });
});
