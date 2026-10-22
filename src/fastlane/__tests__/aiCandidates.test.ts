import { describe, expect, it } from 'vitest';

import { buildInventory } from '../catalog/offerings';
import type { PdfTextItem } from '../catalog/offeringsPdf';
import { parseOfferingsItems } from '../catalog/offeringsPdf';
import type { AiCandidateInput } from '../core/aiCandidates';
import { finalizeAiCandidates, shortlistAiCandidates } from '../core/aiCandidates';
import { subjectNameIndex } from '../core/prerequisites';
import { subjectOf } from '../core/sections';
import { UT_SUBJECTS } from '../data/subjects';
import excerpt from './fixtures/ut-offerings-spring2027-excerpt.json';

const { records } = buildInventory(
    parseOfferingsItems(excerpt.items as PdfTextItem[]),
    { name: 'ut.courses.Spring2027.pdf', sha256: 'abc' },
    1
);
const base: AiCandidateInput = {
    sections: records,
    term: 'Spring 2027',
    taken: [],
    outstanding: [],
    active: [],
    avoidFriday: false,
    preferAsync: false,
    subjectIndex: subjectNameIndex(UT_SUBJECTS),
};

describe('AI candidate selection from the full inventory', () => {
    it('honors the subject filter strictly (ECO never returns UGS or Finance)', () => {
        const picks = shortlistAiCandidates({ ...base, subject: 'ECO' });
        expect(picks.length).toBeGreaterThan(3);
        expect(picks.every(c => subjectOf(c.section.courseCode) === 'ECO')).toBe(true);
    });

    it('puts sections that apply to unfinished IDA requirements first', () => {
        const picks = shortlistAiCandidates({ ...base, outstanding: ['COURSE ECO 304L', 'DEPT FIN'] });
        expect(picks[0]?.applies.length).toBeGreaterThan(0);
        const firstNonApplying = picks.findIndex(c => c.applies.length === 0);
        expect(picks.slice(0, firstNonApplying).every(c => c.applies.length > 0)).toBe(true);
        expect(picks.some(c => c.section.courseCode === 'ECO 304L')).toBe(true);
    });

    it('skips completed courses and ranks clearly missing prerequisites lower', () => {
        const picks = shortlistAiCandidates({ ...base, subject: 'ECO', taken: ['ECO 304K'] });
        expect(picks.some(c => c.section.courseCode === 'ECO 304K')).toBe(false);
        const firstUnmet = picks.findIndex(c => c.prerequisite.status === 'unmet');
        if (firstUnmet >= 0) expect(picks.slice(firstUnmet).every(c => c.prerequisite.status === 'unmet')).toBe(true);
    });

    it('spreads picks across subjects and limits repeated sections of one course', () => {
        const shortlist = shortlistAiCandidates(base);
        const final = finalizeAiCandidates(shortlist, base, () => null);
        expect(final.length).toBeLessThanOrEqual(38);
        expect(new Set(final.map(c => subjectOf(c.section.courseCode))).size).toBeGreaterThan(3);
        const perCourse = new Map<string, number>();
        for (const c of final) perCourse.set(c.section.courseCode, (perCourse.get(c.section.courseCode) ?? 0) + 1);
        expect(Math.max(...perCourse.values())).toBeLessThanOrEqual(2);
    });

    it('uses historical grades only to order otherwise-equal candidates', () => {
        const shortlist = shortlistAiCandidates({ ...base, subject: 'ECO' });
        const target = shortlist[shortlist.length - 1]?.section.uniqueId;
        const final = finalizeAiCandidates(shortlist, { ...base, subject: 'ECO' }, s =>
            s.uniqueId === target
                ? ({ result: { percent: 99, graded: 500 } } as never)
                : ({ result: { percent: 40, graded: 500 } } as never)
        );
        const sameTier = final.filter(c => c.prerequisite.status !== 'unmet' && c.applies.length === 0);
        if (shortlist.find(c => c.section.uniqueId === target)?.prerequisite.status !== 'unmet')
            expect(sameTier[0]?.section.uniqueId).toBe(target);
    });
});
