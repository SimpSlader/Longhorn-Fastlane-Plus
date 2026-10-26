import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditHtml } from '../audit/parseAudit';
import type { AuditCourse, ParsedAudit } from '../audit/types';
import { academicSummary } from '../core/academic';
import { classifyIntent, normalizeMessage } from '../core/intent';
import {
    completedAnswer,
    correctionAnswer,
    easiestAnswer,
    gpaAnswer,
    sectionsAnswer,
    totalAnswer,
} from '../core/localAnswers';
import { sectionFixture } from './factories';

const course = (
    code: string,
    hours: number,
    status: AuditCourse['status'],
    extra: Partial<AuditCourse> = {}
): AuditCourse => ({
    code,
    name: code,
    grade: status === 'completed' ? 'A' : '',
    unique: '12345',
    type: 'In-Residence',
    hours,
    semester: status === 'completed' ? 'Fall 2026' : 'Spring 2027',
    status,
    ...extra,
});
/** Test fixture from the spec: 9 hours completed, 13 in progress (plus an equivalent row that must not count). */
const nineAndThirteen: ParsedAudit = {
    source: 'html',
    parsedAt: Date.UTC(2026, 9, 1),
    requirements: [],
    courses: [
        course('UGS 303', 3, 'completed'),
        course('ECO 304K', 3, 'completed'),
        course('RHE 306', 3, 'completed', { grade: 'CR', type: 'Credit by Exam' }),
        course('E 306', 3, 'completed', { grade: 'CR', type: 'Credit by Exam', unique: '00000', equivalent: true }),
        course('M 408C', 4, 'in-progress'),
        course('ECO 304L', 3, 'in-progress'),
        course('GOV 310L', 3, 'in-progress'),
        course('HIS 315K', 3, 'in-progress'),
        course('M 408K', 4, 'in-progress', { unique: '00000', equivalent: true }),
    ],
    transfer: { accepted: [], pending: [] },
    creditHours: { confidence: 'low' },
    restrictions: [],
    warnings: [],
};

describe('academic facts', () => {
    it('Test A: completed hours never include classes in progress', () => {
        const s = academicSummary(nineAndThirteen);
        expect(s.completedHours).toBe(9);
        expect(s.inProgressHours).toBe(13);
        const answer = completedAnswer(s);
        expect(answer).toContain("You've completed **9 credit hours** so far");
        expect(answer).toContain('another **13**');
        expect(answer).toContain('**22 credit hours**');
        expect(answer).not.toMatch(/completed[^.]*22/);
        expect(totalAnswer(s)).toContain('**22 credit hours** once');
    });

    it('Test B: no IDA means no invented total', () => {
        const answer = completedAnswer(academicSummary(null));
        expect(answer).toMatch(/don't have your degree audit/);
        expect(answer).not.toMatch(/\d+ credit hours/);
    });

    it('Test D: GPA comes only from the IDA, and never triggers a schedule', () => {
        expect(classifyIntent("What's my GPA?").kind).toBe('gpa');
        expect(gpaAnswer(academicSummary(nineAndThirteen))).toMatch(/doesn't list a GPA/);
        expect(gpaAnswer(academicSummary(nineAndThirteen))).not.toMatch(/ACC|schedule/);
    });

    it('Test G: a correction is kept beside the IDA, never silently replacing it', () => {
        const intent = classifyIntent("That's wrong. I've completed 9 credits, not 33.");
        expect(intent).toEqual({ kind: 'correction', completedHours: 9 });
        const withIda = academicSummary(
            { ...nineAndThirteen, courses: nineAndThirteen.courses.slice(0, 2) },
            { completedHours: { value: 9, at: 1 } }
        );
        expect(correctionAnswer(9, withIda)).toMatch(/noted that you've completed \*\*9 credit hours\*\*.*IDA shows 6/);
        expect(withIda.discrepancies[0]).toMatch(/told me .*9.*IDA shows 6/);
        expect(completedAnswer(academicSummary(null, { completedHours: { value: 9, at: 1 } }))).toMatch(/You told me/);
    });

    it('reads the real IDA without counting equivalent numbers, and ungraded current classes are in progress', () => {
        const audit = parseAuditHtml(
            new DOMParser().parseFromString(
                readFileSync(resolve(__dirname, 'fixtures/dap-audit-results-real.html'), 'utf8'),
                'text/html'
            )
        );
        const s = academicSummary(audit);
        expect(s.completedHours).toBe(64);
        expect(s.inProgressHours).toBe(12);
        expect(s.current.map(c => c.code).sort()).toEqual(['C S 331', 'C S 350C', 'SDS 320E', 'SDS 322E']);
        expect(s.plannedHours).toBe(9);
        // the IDA's own "Total Hours Taken" adds planned courses: 64 + 12 + 9
        expect(s.idaTotalHoursTaken).toBe(85);
        expect(s.examHours).toBeGreaterThan(0);
    });
});

describe('what the student is asking', () => {
    it.each([
        ['hyow many jours do i have compleeted?', 'completed-hours'],
        ['How many hours have I completed so far?', 'completed-hours'],
        ['how many credits do i have', 'completed-hours'],
        ['how many hours am I taking this semester', 'in-progress-hours'],
        ['how many credits do I have left to graduate', 'remaining-hours'],
        ['what classes am I taking', 'current-classes'],
        ["What's the easiest class on my schedule?", 'easiest-class'],
        ['How do I graduate early?', 'degree-planning'],
        ['Build a 15-credit schedule with no Friday classes', 'schedule'],
        ['Actually, Friday mornings are fine', 'schedule'],
        ['remember I want to graduate early', 'memory'],
        ['hi! what can you do?', 'chat'],
    ])('"%s" → %s', (message, kind) => {
        expect(classifyIntent(message).kind).toBe(kind);
    });

    it('Test H: a course-section question names the course', () => {
        const codes = (t: string) => (/eco 304k/i.test(t) ? ['ECO 304K'] : []);
        expect(classifyIntent('Show me available sections of ECO 304K.', { courseCodes: codes })).toEqual({
            kind: 'course-sections',
            course: 'ECO 304K',
        });
    });

    it('fixes typos without changing ordinary words', () => {
        expect(normalizeMessage('hyow many jours do i have compleeted')).toBe('how many hours do i have completed');
        expect(normalizeMessage('is that right now')).toBe('is that right now');
    });
});

describe('answers from course data', () => {
    it('Test H: lists only listed sections, with freshness and no seat claims', () => {
        const a = sectionFixture(11111, 'ECO 304K', { times: [['MWF', '9:00 a.m.-10:00 a.m.']], instructors: ['Lee'] });
        const text = sectionsAnswer('ECO 304K', [a], () => 81);
        expect(text).toContain('| 11111 |');
        expect(text).toContain('81%');
        expect(text).toMatch(/Seat availability isn't checked/);
        expect(sectionsAnswer('ECO 999', [], () => null)).toMatch(/don't see any listed sections/);
    });

    it('Test F: the easiest class comes from real grade history, with limits stated', () => {
        const text = easiestAnswer([
            { code: 'UGS 303', grade: 88, sample: 400 },
            { code: 'M 408C', grade: 41, sample: 900 },
            { code: 'NEW 101', grade: null, sample: 0 },
        ]);
        expect(text).toMatch(/\*\*UGS 303\*\* looks easiest/);
        expect(text).toMatch(/No grade history for NEW 101/);
        expect(easiestAnswer([{ code: 'X 1', grade: null, sample: 0 }])).toMatch(/can't say which is easiest/);
    });
});
