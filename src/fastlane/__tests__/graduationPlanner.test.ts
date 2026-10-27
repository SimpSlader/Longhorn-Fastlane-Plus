/**
 * Regression tests for the reported failures: wrong remaining hours, wrong semester counts, ignored corrections.
 */
import { describe, expect, it } from 'vitest';
import type { AuditCourse, AuditRequirement, ParsedAudit } from '../audit/types';
import { academicModel } from '../core/academicModel';
import { mergeFacts, statedFacts } from '../core/corrections';
import { currentTerm, graduationAnswer, graduationPlan, parseTerm, termName, termsUntil } from '../core/graduation';

const OCT_26_2026 = new Date(2026, 9, 26);
const course = (code: string, hours: number, status: AuditCourse['status'], type = 'In-Residence'): AuditCourse => ({
    code,
    name: code,
    grade: status === 'completed' ? 'CR' : '',
    unique: '12345',
    type,
    hours,
    semester: status === 'completed' ? 'Fall 2025' : 'Fall 2026',
    status,
});
const rule = (
    text: string,
    req: number,
    applied: number,
    category: AuditRequirement['category'] = 'other'
): AuditRequirement => ({
    id: text.slice(0, 12),
    section: 'Degree',
    text,
    category,
    status: applied >= req ? 'completed' : 'in-progress',
    required: { value: req, unit: 'hours' },
    applied: { value: applied, unit: 'hours' },
    remaining: { value: Math.max(0, req - applied), unit: 'hours' },
    tags: [],
    courses: [],
    confidence: 'high',
    issues: [],
});
/** The reported student: 9 earned (exam credit), 13 in progress at UT, IDA counts 22 of 120 with in-progress on. */
const student: ParsedAudit = {
    source: 'html',
    parsedAt: Date.UTC(2026, 9, 20),
    program: 'Economics, BA',
    included: { inProgress: true, future: false, planned: false },
    requirements: [
        rule('120 hours are required for the Bachelor of Arts', 120, 22),
        rule('60 semester hours in residence are required.', 60, 13, 'hours'),
        rule('At least 39 hours of upper-division coursework is required.', 39, 0),
        rule('42 hours are required to complete the core curriculum', 42, 21, 'core'),
    ],
    courses: [
        course('RHE 306', 3, 'completed', 'Credit by Exam'),
        course('M 408C', 4, 'completed', 'Credit by Exam'),
        course('HIS 315K', 2, 'completed', 'Credit by Exam'),
        course('ECO 304K', 3, 'in-progress'),
        course('GOV 310L', 3, 'in-progress'),
        course('UGS 303', 3, 'in-progress'),
        course('M 408D', 4, 'in-progress'),
    ],
    transfer: { accepted: [], pending: [] },
    creditHours: { confidence: 'low' },
    restrictions: [],
    warnings: [],
};

describe('academic calendar (Test 9)', () => {
    it('counts the fall/spring semesters left exactly, summers separately', () => {
        expect(termName(currentTerm(OCT_26_2026))).toBe('Fall 2026');
        const toSpring29 = termsUntil({ season: 'Spring', year: 2029 }, OCT_26_2026);
        expect(toSpring29.long.map(termName)).toEqual([
            'Spring 2027',
            'Fall 2027',
            'Spring 2028',
            'Fall 2028',
            'Spring 2029',
        ]);
        expect(toSpring29.summers.map(termName)).toEqual(['Summer 2027', 'Summer 2028']);
        expect(termsUntil({ season: 'Fall', year: 2028 }, OCT_26_2026).long).toHaveLength(4);
        const toSummer28 = termsUntil({ season: 'Summer', year: 2028 }, OCT_26_2026);
        expect(toSummer28.long.map(termName)).toEqual(['Spring 2027', 'Fall 2027', 'Spring 2028']);
        expect(toSummer28.summers.map(termName)).toEqual(['Summer 2027', 'Summer 2028']);
        // from spring, the current spring is underway and not counted again
        expect(termsUntil({ season: 'Spring', year: 2028 }, new Date(2027, 1, 10)).long.map(termName)).toEqual([
            'Fall 2027',
            'Spring 2028',
        ]);
        expect(parseTerm('graduate in spring 2029')).toEqual({ season: 'Spring', year: 2029 });
        expect(parseTerm("by may '29")).toEqual({ season: 'Spring', year: 2029 });
        expect(parseTerm('I want to graduate in 2029')).toEqual({ season: 'Spring', year: 2029 });
    });
});

describe('the reported student', () => {
    const model = academicModel(student);

    it('Test 1 / Test 4: earned, in progress, projected and remaining are separate and right', () => {
        expect(model.degreeTotalRequired.value).toBe(120);
        expect(model.degreeCreditsEarned.value).toBe(9);
        expect(model.degreeCreditsInProgress.value).toBe(13);
        expect(model.degreeCreditsProjected.value).toBe(22);
        expect(model.degreeCreditsRemainingProjected.value).toBe(98);
        expect(model.degreeCreditsRemainingEarned.value).toBe(111);
        expect(model.utResidentCounted.value).toBe(13);
        expect(model.upperDivisionCounted.value).toBe(0);
        expect(model.upperDivisionRequired.value).toBe(39);
        expect(model.issues).toEqual([]);
    });

    it('Test 1 / Test 2: five semesters, 19.6 per semester, and the summer scenarios', () => {
        const plan = graduationPlan(model, { season: 'Spring', year: 2029 }, { now: OCT_26_2026 });
        if ('missing' in plan) throw new Error(plan.missing);
        expect(plan.longTerms).toHaveLength(5);
        expect(plan.remaining).toBe(98);
        expect(plan.scenarios).toEqual([
            { summerHours: 0, perSemester: 19.6 },
            { summerHours: 6, perSemester: 18.4 },
            { summerHours: 12, perSemester: 17.2 },
            { summerHours: 18, perSemester: 16 },
            { summerHours: 24, perSemester: 14.8 },
        ]);
        const text = graduationAnswer(plan, model);
        expect(text).toContain('22 of your 120 credits');
        expect(text).toContain('**98 left**');
        expect(text).toContain('**5 fall/spring semesters**');
        expect(text).toContain('**19.6**');
        expect(text).toMatch(/39 of those hours must be upper-division/);
        expect(text).toMatch(/47 hours in residence/);
        expect(text).toMatch(/assume you pass this semester/);
        expect(text).not.toMatch(/\b50\b/);
    });

    it('Test 3: requirement buckets are never added to the degree total', () => {
        expect(model.degreeCreditsProjected.value).not.toBe(22 + 21);
        expect(JSON.stringify(model)).not.toContain('"value":43');
    });
});

describe('corrections (Test 5, Test 12)', () => {
    it('reads the figures a student states, in ordinary words', () => {
        const s = statedFacts(
            "Use what I'm telling you, I'm the source of truth: 120 total hours required, 22 credits counted toward my degree including in-progress, 98 remaining, 13 UT in-residence hours, and no upper-division hours. I want to graduate in Spring 2029."
        );
        expect(s.authoritative).toBe(true);
        expect(s.facts.degreeTotalRequired?.value).toBe(120);
        expect(s.facts.degreeCreditsProjected?.value).toBe(22);
        expect(s.facts.degreeCreditsRemainingProjected?.value).toBe(98);
        expect(s.facts.utResidentCounted?.value).toBe(13);
        expect(s.facts.upperDivisionCounted?.value).toBe(0);
        expect(s.facts.targetGraduation?.value).toBe('Spring 2029');
        expect(
            statedFacts('No, I have 22 hours counted toward my degree, not 70.').facts.degreeCreditsProjected?.value
        ).toBe(22);
        const req = statedFacts(
            'I need 60 hours in residence required, 39 upper division hours required, 24 upper division hours in residence'
        ).facts;
        expect(req.utResidentRequired?.value).toBe(60);
        expect(req.upperDivisionRequired?.value).toBe(39);
        expect(req.upperDivisionResidentRequired?.value).toBe(24);
        expect(statedFacts("I've completed 9 credits and I'm taking 13").facts).toMatchObject({
            degreeCreditsEarned: { value: 9 },
            degreeCreditsInProgress: { value: 13 },
        });
        expect(statedFacts('how many hours do I need per semester?').facts).toEqual({});
        // a question that mentions the target term records it, and is still answered as a question
        const q =
            'Based off my current track of credits and the fact I want to graduate in 2029 how many credits would I need per semester';
        expect(statedFacts(q).facts.targetGraduation?.value).toBe('Spring 2029');
    });

    it('Test 5: a stale record saying 50 remaining is overridden by the student’s 98, and the difference is kept', () => {
        const stale: ParsedAudit = {
            ...student,
            requirements: [
                rule('120 hours are required for the Bachelor of Arts', 120, 70),
                ...student.requirements.slice(1),
            ],
        };
        const before = academicModel(stale);
        expect(before.degreeCreditsRemainingProjected.value).toBe(50);
        const facts = mergeFacts({}, statedFacts('No, I have 22 hours counted toward my degree, not 70.').facts);
        const after = academicModel(stale, facts);
        expect(after.degreeCreditsProjected).toMatchObject({ value: 22, source: 'student' });
        expect(after.degreeCreditsRemainingProjected.value).toBe(98);
        // earned follows from the confirmed count (22 − 13 in progress), never from the stale record
        expect(after.degreeCreditsEarned).toMatchObject({ value: 9, source: 'calculated' });
        expect(after.issues.join(' ')).not.toMatch(/larger than projected/);
        expect(after.discrepancies.join(' ')).toMatch(/you told me 22; your IDA shows/);
        const plan = graduationPlan(after, { season: 'Spring', year: 2029 }, { now: OCT_26_2026 });
        expect('missing' in plan ? null : plan.scenarios[0]?.perSemester).toBe(19.6);
    });

    it('Test 12: without an IDA the figures the student gave are enough, and nothing is invented', () => {
        const none = academicModel(null);
        expect(none.degreeCreditsRemainingProjected.value).toBeNull();
        const plan = graduationPlan(none, { season: 'Spring', year: 2029 }, { now: OCT_26_2026 });
        expect('missing' in plan && plan.missing).toMatch(/can’t do this math without guessing/);
        const told = academicModel(
            null,
            statedFacts('120 total hours required and 22 credits counted toward my degree').facts
        );
        const ok = graduationPlan(told, { season: 'Spring', year: 2029 }, { now: OCT_26_2026 });
        expect('missing' in ok ? null : ok.scenarios[0]?.perSemester).toBe(19.6);
    });
});
