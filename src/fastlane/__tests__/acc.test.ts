import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseAuditHtml } from '../audit/parseAudit';
import type { ParsedAudit } from '../audit/types';
import { accRoom, accSuggestions, programResidency, tccnFor, tccnHours } from '../core/acc';
import { composeReply, quickReplies } from '../core/plannerReply';
import type { SectionRecord } from '../core/sections';

const realAudit = (): ParsedAudit =>
    parseAuditHtml(
        new DOMParser().parseFromString(
            readFileSync(resolve(__dirname, 'fixtures/dap-audit-results-real.html'), 'utf8'),
            'text/html'
        )
    );

function econAudit(over: Partial<ParsedAudit> = {}): ParsedAudit {
    const base = realAudit();
    return {
        ...base,
        program: 'Bachelor of Arts, Economics',
        requirements: [
            ...base.requirements,
            {
                ...base.requirements[0]!,
                text: 'Economics 304K',
                status: 'not-started',
                tags: ['COURSE ECO 304K'],
                courses: [],
            },
            {
                ...base.requirements[0]!,
                text: 'Economics 420K',
                status: 'not-started',
                tags: ['COURSE ECO 420K'],
                courses: [],
            },
            {
                ...base.requirements[0]!,
                text: 'Mathematics 408Q',
                status: 'not-started',
                tags: ['COURSE M 408Q'],
                courses: [],
            },
            {
                ...base.requirements[0]!,
                text: 'Psychology 301',
                status: 'not-started',
                tags: ['COURSE PSY 301'],
                courses: [],
            },
        ],
        ...over,
    } as ParsedAudit;
}

describe("UT's official ACC (TCCN) table", () => {
    it('maps ACC course numbers to the UT courses they transfer as', () => {
        expect(tccnFor('ECO 304L')).toEqual(['ECON 2301']);
        expect(tccnFor('ECO 304K')).toEqual(['ECON 2302']);
        expect(tccnFor('PSY 301')).toEqual(['PSYC 2301']);
        expect(tccnFor('ECO 420K')).toEqual([]);
        expect(tccnHours('MATH 2413')).toBe(4);
    });
});

describe('ACC suggestions', () => {
    const grades = (code: string) =>
        ({ 'ECO 304K': { percent: 41, sample: 900 }, 'PSY 301': { percent: 70, sample: 1500 } })[code] ?? null;

    it('suggests only courses the IDA still needs, hardest at UT first, never ones required in residence', () => {
        const audit = econAudit();
        expect(programResidency(audit)?.label).toBe('Economics, BA');
        const out = accSuggestions({ audit, planned: [], gradeOf: grades });
        const codes = out.suggestions.map(s => s.ut);
        expect(codes[0]).toBe('ECO 304K'); // 41% A/A- at UT: the hardest
        expect(codes).toContain('PSY 301');
        expect(codes).not.toContain('ECO 420K'); // must be completed in residence (and has no TCCN equivalent)
        expect(codes).not.toContain('M 408Q'); // must be taken in residence (and UT lists no ACC equivalent)
        expect(out.suggestions[0]!.tccn).toBe('ECON 2302');
        expect(out.suggestions[0]!.cautions.join(' ')).toMatch(/18 ECO hours/);
    });

    it('keeps a course at UT when the IDA says it must be taken in residence', () => {
        const audit = econAudit();
        audit.requirements.push({
            ...audit.requirements[0]!,
            text: 'PSY 301 must be taken in residence',
            status: 'not-started',
            tags: [],
            courses: [],
        });
        const out = accSuggestions({ audit, planned: [], gradeOf: grades });
        expect(out.suggestions.map(s => s.ut)).not.toContain('PSY 301');
        expect(out.blocked).toContain('PSY 301');
    });

    it('stays within the hours the residence rules leave', () => {
        const audit = econAudit();
        const room = accRoom(audit);
        expect(room.remaining).toBe(38); // 120 degree hours, 82 done on the real IDA
        expect(room.residenceRemaining).toBe(0); // 60 of 60 in residence already
        expect(room.room).toBe(38);
    });

    it('never suggests what is already planned at UT', () => {
        const out = accSuggestions({ audit: econAudit(), planned: ['ECO 304K'], gradeOf: grades });
        expect(out.suggestions.map(s => s.ut)).not.toContain('ECO 304K');
    });
});

describe('chat replies describe the schedule that is shown', () => {
    const sec = (courseCode: string, uniqueId: number, meetings: SectionRecord['meetings']): SectionRecord => ({
        uniqueId,
        courseCode,
        title: courseCode,
        instructors: [],
        creditHours: 3,
        meetings,
        scheduleComplete: true,
        modality: meetings.length ? 'in-person' : 'async-online',
        core: [],
        flags: [],
        isReserved: false,
        requirementTags: [],
        capturedAt: 0,
    });
    const a = sec('R S 310', 1, [{ days: ['T', 'TH'], start: 570, end: 660 }]);
    const b = sec('C C 301', 2, [{ days: ['T', 'TH'], start: 660, end: 750 }]);
    const c = sec('GOV 310L', 3, []);
    const d = sec('HIS 314K', 4, [{ days: ['T', 'TH'], start: 840, end: 930 }]);

    it('lists exactly the scheduled classes and what changed', () => {
        const text = composeReply({
            sections: [a, b, c],
            before: [a, d, c],
            report: null,
            avoidDays: ['M', 'W', 'F'],
        });
        expect(text).toMatch(/9-credit plan/);
        expect(text).toContain('• R S 310 — Tue/Thu 9:30am–11:00am');
        expect(text).toContain('• GOV 310L — online, on your own schedule');
        expect(text).toMatch(/took out HIS 314K and added C C 301; kept the other 2/);
        expect(text).not.toContain('HIS 314K —');
    });

    it('explains impossible requests and offers next steps', () => {
        const text = composeReply({
            sections: null,
            before: null,
            report: {
                reasons: ['The most credits … is 9, short of 12.'],
                suggestions: [{ text: 'Allow classes on Wednesday', patch: {} }],
                bestCredits: 9,
            },
            avoidDays: ['M', 'W', 'F'],
        });
        expect(text).toMatch(/couldn't build a complete schedule/);
        expect(text).toMatch(/allow classes on wednesday/);
        expect(quickReplies(false, false)[0]).toBe('Wednesdays are fine');
    });
});
