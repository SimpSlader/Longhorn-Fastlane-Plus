/**
 * Validation against real (or publicly documented) UT page structures.
 * - dap-ut-course-schedule-details.html: a real saved UT course schedule page (Fall 2025), from Degree Audit Plus (MIT).
 * - ut-registration-form-structure.html: UT add/drop form structure reconstructed from public sources (see file header).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CourseCatalogScraper } from '@views/lib/CourseCatalogScraper';
import getCourseTableRows from '@views/lib/getCourseTableRows';
import { SiteSupport } from '@views/lib/getSiteSupport';
import { describe, expect, it } from 'vitest';
import { analyzeRow, sectionFromCourse } from '../adapters/utrp';
import { DEFAULT_AUTOFILL, decideAutofill, fillInput, findUniqueAddInput } from '../core/autofill';
import { MESSAGE_SELECTORS } from '../injected/registration/messageSelectors';

const load = (name: string) =>
    new DOMParser().parseFromString(readFileSync(join(__dirname, 'fixtures', name), 'utf8'), 'text/html');

describe('real UT course schedule page (saved Fall 2025 details page)', () => {
    const doc = load('dap-ut-course-schedule-details.html');
    const url = 'https://utdirect.utexas.edu/apps/registrar/course_schedule/20259/50100/';
    const rows = new CourseCatalogScraper(SiteSupport.COURSE_CATALOG_DETAILS, doc, url).scrape(getCourseTableRows(doc));

    it('UT Registration Plus scraper reads the section', () => {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.course).toMatchObject({
            uniqueId: 50100,
            department: 'NSC',
            number: '209',
            status: 'CLOSED',
            instructionMode: 'In Person',
        });
    });

    it('Fastlane reads meeting lines, delivery mode and conflicts inputs from the real markup', () => {
        const row = rows[0]!;
        const analysis = analyzeRow(row.element);
        expect(analysis.modality.modality).toBe('in-person');
        expect(analysis.modality.reasons[0]).toContain('Face-to-face');
        expect(analysis.complete).toBe(true);
        expect(analysis.meetings).toEqual([{ days: ['T', 'TH'], start: 720, end: 780, location: 'PHR 2.116' }]);
        const section = sectionFromCourse(row.course!, analysis);
        expect(section).toMatchObject({ courseCode: 'NSC 209', scheduleComplete: true, status: { value: 'CLOSED' } });
    });
});

describe('UT add/drop form structure', () => {
    const doc = load('ut-registration-form-structure.html');

    it('selects the ADD field — never drop, swap-add, swap-drop or hidden fields', () => {
        expect(findUniqueAddInput(doc)?.id).toBe('s_unique_add');
    });

    it('fills without changing the transaction radio, other fields, or submitting', () => {
        const form = doc.getElementById('regform') as HTMLFormElement;
        let submitted = false;
        form.addEventListener('submit', () => {
            submitted = true;
        });
        const input = findUniqueAddInput(doc)!;
        const decision = decideAutofill({
            settings: { ...DEFAULT_AUTOFILL, enabled: true },
            code: '23095',
            fieldValue: input.value,
            lastFilled: null,
        });
        expect(decision).toEqual({ action: 'fill', code: '23095' });
        fillInput(input, '23095');
        expect((doc.getElementById('s_unique_add') as HTMLInputElement).value).toBe('23095');
        expect((doc.getElementById('s_swap_unique_add') as HTMLInputElement).value).toBe('');
        expect((doc.getElementById('ds_request_STADD') as HTMLInputElement).checked).toBe(true);
        expect(submitted).toBe(false);
    });

    it('optional message reading covers the page message areas', () => {
        for (const id of ['#message', '#message2', '#e_message', '#n_message']) {
            expect(doc.querySelector(id)).not.toBeNull();
            expect(MESSAGE_SELECTORS).toContain(id);
        }
    });
});
