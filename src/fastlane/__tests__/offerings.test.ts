import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { buildInventory, offeringModality } from '../catalog/offerings';
import type { OfferingSection, PdfTextItem } from '../catalog/offeringsPdf';
import { joinLines, parseDays, parseOfferingsItems, parseTimeRange } from '../catalog/offeringsPdf';
import { checkPrerequisites, prerequisiteGroups, subjectNameIndex } from '../core/prerequisites';
import type { SectionRecord } from '../core/sections';
import { isConfirmedSection, OFFERINGS_COURSE_MARK, subjectOf } from '../core/sections';
import { idbPut, STORES } from '../data/idb';
import { putObservedSections, readOfferingsMeta, readSections, replaceTermOfferings } from '../data/sectionStore';
import { UT_SUBJECTS } from '../data/subjects';
import excerpt from './fixtures/ut-offerings-spring2027-excerpt.json';

// Real positioned text from six pages of the Registrar's Spring 2027 "PDF of courses offered" (as of 10/01/2026)
const parse = parseOfferingsItems(excerpt.items as PdfTextItem[]);
const find = (unique: number): OfferingSection => {
    const s = parse.sections.find(x => x.uniqueId === unique);
    if (!s) throw new Error(`unique ${unique} not parsed`);
    return s;
};

describe('Registrar course-offerings parser', () => {
    it('reads the term and the date printed on the document', () => {
        expect(parse.term).toEqual({ season: 'Spring', year: 2027, code: '20272' });
        expect(parse.asOf).toBe('2026-10-01');
    });

    it('reads sections exactly as printed (unique, days, time, room, instructor)', () => {
        const eco = find(34225);
        expect(eco.courseCode).toBe('ECO 304K');
        expect(eco.courseTitle).toBe('INTRODUCTION TO MICROECONOMICS');
        expect(eco.meetings).toEqual([{ days: ['M', 'W'], start: 11 * 60, end: 12 * 60 + 30, location: 'BUR 106' }]);
        expect(eco.instructors).toEqual(['CARRELL, S']);
        // a second meeting printed on the following line belongs to the same section
        expect(find(34255).meetings).toEqual([
            { days: ['M', 'W'], start: 9 * 60 + 30, end: 11 * 60, location: 'JGB 2.324' },
            { days: ['F'], start: 9 * 60, end: 10 * 60, location: 'JGB 2.216' },
        ]);
        expect(find(2705).instructors).toEqual(['JOHNSTON-BLAIR, D']);
    });

    it('keeps sections whose times are "to be arranged" without inventing a schedule', () => {
        const arranged = find(2505);
        expect(arranged.meetings).toEqual([]);
        expect(arranged.instructors).toEqual(['RANGANATHAN, R']);
    });

    it('reports nothing unparsed on these pages and never duplicates a unique number', () => {
        expect(parse.issues).toEqual([]);
        const ids = parse.sections.map(s => s.uniqueId);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('subject filters return only that subject (ECO is Economics, FIN Finance, ACC Accounting, M Mathematics)', () => {
        for (const subject of ['ECO', 'FIN', 'ACC', 'M']) {
            const rows = parse.sections.filter(s => subjectOf(s.courseCode) === subject);
            expect(rows.length).toBeGreaterThan(3);
            expect(rows.every(s => s.subject === subject)).toBe(true);
        }
        expect(parse.sections.filter(s => subjectOf(s.courseCode) === 'ECO').some(s => s.subject === 'UGS')).toBe(
            false
        );
        expect(parse.subjects.FIN).toBe('Finance');
        expect(parse.subjects.ECO).toBe('Economics');
    });

    it('captures printed prerequisites and rejoins words broken across lines', () => {
        expect(joinLines(['for Accounting 312 or 312H; and Statis-', 'tics 301 or 301H.'])).toBe(
            'for Accounting 312 or 312H; and Statistics 301 or 301H.'
        );
        const withPrereq = parse.sections.filter(s => s.prerequisites);
        expect(withPrereq.length).toBeGreaterThan(10);
        expect(withPrereq.every(s => s.prerequisites?.startsWith('Prerequisite'))).toBe(true);
    });

    it('parses Registrar time and day notation', () => {
        expect(parseTimeRange('200', '330P')).toEqual({ start: 14 * 60, end: 15 * 60 + 30 });
        expect(parseTimeRange('1000', '100P')).toEqual({ start: 10 * 60, end: 13 * 60 });
        expect(parseTimeRange('1230', '200P')).toEqual({ start: 12 * 60 + 30, end: 14 * 60 });
        expect(parseTimeRange('600', '900P')).toEqual({ start: 18 * 60, end: 21 * 60 });
        expect(parseTimeRange('1200', '1200')).toBeNull();
        expect(parseDays('TTH')).toEqual(['T', 'TH']);
        expect(parseDays('MWF')).toEqual(['M', 'W', 'F']);
        expect(parseDays('INTERNET')).toBeNull();
    });
});

describe('course inventory from the offerings document', () => {
    const built = buildInventory(parse, { name: 'ut.courses.Spring2027.pdf', sha256: 'abc' }, 1_000);

    it('builds listed sections with provenance and no seat status', () => {
        const eco = built.records.find(r => r.uniqueId === 34225) as SectionRecord;
        expect(eco.source).toBe('ut-offerings');
        expect(isConfirmedSection(eco)).toBe(false);
        expect(eco.status).toBeUndefined();
        expect(eco.listing).toMatchObject({
            term: 'Spring 2027',
            asOf: '2026-10-01',
            sourceUrl: 'https://registrar.utexas.edu/schedules/20272/print',
            sha256: 'abc',
        });
        expect(eco.semester).toEqual({ year: 2027, season: 'Spring', code: '20272' });
        expect(eco.creditHours).toBe(3);
        expect(eco.requirementTags).toContain('COURSE ECO 304K');
    });

    it('carries a real UTRP course so grades, calendar and schedules reuse UTRP code', () => {
        const course = built.records.find(r => r.uniqueId === 34225)?.course as Record<string, unknown>;
        expect(course).toMatchObject({
            uniqueId: 34225,
            department: 'ECO',
            number: '304K',
            courseName: 'INTRODUCTION TO MICROECONOMICS',
            url: 'https://utdirect.utexas.edu/apps/registrar/course_schedule/20272/34225/',
            instructors: [{ fullName: 'CARRELL, S', lastName: 'CARRELL', firstName: 'S' }],
            [OFFERINGS_COURSE_MARK]: 'ut-offerings',
        });
        expect(course.status).toBeUndefined();
        expect((course.schedule as { meetings: unknown[] }).meetings).toEqual([
            { days: ['Monday', 'Wednesday'], startTime: 660, endTime: 750, location: { building: 'BUR', room: '106' } },
        ]);
    });

    it('summarizes coverage with grounded counts', () => {
        expect(built.meta.sections).toBe(parse.sections.length);
        expect(built.meta.courses).toBe(new Set(parse.sections.map(s => s.courseCode)).size);
        expect(built.meta.subjects).toBe(new Set(parse.sections.map(s => s.subject)).size);
    });

    it('derives modality only from what is printed', () => {
        expect(offeringModality({ webBased: 'full', meetings: [] })).toBe('async-online');
        expect(offeringModality({ webBased: 'partial', meetings: [] })).toBe('hybrid');
        expect(offeringModality({ webBased: null, meetings: [] })).toBe('unknown');
    });

    it('refuses a document without a term or sections', () => {
        expect(() => buildInventory({ ...parse, term: null }, { name: 'x.pdf', sha256: '' }, 1)).toThrow(/semester/);
        expect(() => buildInventory({ ...parse, sections: [] }, { name: 'x.pdf', sha256: '' }, 1)).toThrow(
            /No sections/
        );
    });
});

describe('shared section store', () => {
    const built = buildInventory(parse, { name: 'ut.courses.Spring2027.pdf', sha256: 'abc' }, 1_000);
    const confirmed = {
        ...(built.records.find(r => r.uniqueId === 34225) as SectionRecord),
        source: 'ut-page' as const,
        listing: undefined,
        prerequisites: undefined,
        status: { value: 'OPEN' as const, observedAt: 5_000, source: 'UT course schedule page' },
        capturedAt: 5_000,
    };

    it('never replaces a section confirmed on a UT page, and attaches the listing to it', async () => {
        await putObservedSections([confirmed]);
        const result = await replaceTermOfferings('20272', built.records, built.meta);
        expect(result.confirmedKept).toBe(1);
        const stored = (await readSections('Spring 2027')).find(s => s.uniqueId === 34225);
        expect(stored?.source).toBe('ut-page');
        expect(stored?.status?.value).toBe('OPEN');
        expect(stored?.listing?.asOf).toBe('2026-10-01');
        expect(await readSections('Spring 2027')).toHaveLength(built.records.length);
        expect((await readOfferingsMeta())[0]?.termCode).toBe('20272');
    });

    it('a later UT page visit keeps the listing provenance', async () => {
        await putObservedSections([{ ...confirmed, capturedAt: 9_000 }]);
        const stored = (await readSections('Spring 2027')).find(s => s.uniqueId === 34225);
        expect(stored?.capturedAt).toBe(9_000);
        expect(stored?.listing?.document).toBe('ut.courses.Spring2027.pdf');
    });

    it('a newer document removes listings that disappeared but keeps confirmed sections and other terms', async () => {
        await idbPut(STORES.sections, {
            ...confirmed,
            uniqueId: 11111,
            semester: { year: 2026, season: 'Fall', code: '20269' },
            key: '20269:11111',
            semesterLabel: 'Fall 2026',
        });
        const fewer = built.records.filter(r => r.uniqueId !== 34230);
        const result = await replaceTermOfferings('20272', fewer, built.meta);
        expect(result.removed).toBe(1);
        const ids = (await readSections()).map(s => s.uniqueId);
        expect(ids).not.toContain(34230);
        expect(ids).toContain(34225);
        expect(ids).toContain(11111);
    });
});

describe('prerequisites from printed text', () => {
    const index = subjectNameIndex(UT_SUBJECTS);

    it('reads groups of alternatives', () => {
        expect(
            prerequisiteGroups(
                'Prerequisite: Credit or registration for Accounting 312 or 312H; and Statistics 301 or 301H.',
                index
            )
        ).toEqual([
            ['ACC 312', 'ACC 312H'],
            ['STA 301', 'STA 301H'],
        ]);
        expect(prerequisiteGroups('Prerequisite: Economics 304K and 304L with a grade of at least C-.', index)).toEqual(
            [['ECO 304K'], ['ECO 304L']]
        );
        expect(
            prerequisiteGroups('Prerequisite: Mathematics 408C, 408L, or 408S with a grade of at least C-.', index)
        ).toEqual([['M 408C', 'M 408L', 'M 408S']]);
        expect(prerequisiteGroups('Prerequisite: Computer Science 312 or 312H.', index)).toEqual([
            ['C S 312', 'C S 312H'],
        ]);
    });

    it('is conservative: met only when every group is covered, unmet only when none is', () => {
        const text = 'Prerequisite: Accounting 312 or 312H; and Statistics 301 or 301H.';
        expect(checkPrerequisites(text, ['ACC 312H', 'STA 301'], index).status).toBe('met');
        expect(checkPrerequisites(text, ['ACC 312'], index)).toMatchObject({
            status: 'check',
            missing: ['STA 301 or STA 301H'],
        });
        expect(checkPrerequisites(text, ['HIS 315K'], index).status).toBe('unmet');
        expect(checkPrerequisites('Prerequisite: Upper-division standing.', [], index)).toMatchObject({
            status: 'check',
            notes: ['Requires a class standing'],
        });
        expect(checkPrerequisites(undefined, [], index).status).toBe('none');
    });
});
