import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    confirmRequirement,
    correctRequirement,
    needsReview,
    outstandingTags,
    parseAuditHtml,
    parseAuditText,
    parseProgress,
    takenCourseCodes,
} from '../audit/parseAudit';

const fixture = (name: string) =>
    new DOMParser().parseFromString(readFileSync(join(__dirname, 'fixtures', name), 'utf8'), 'text/html');

describe('parseAuditHtml — Degree Audit Plus sample fixture', () => {
    const audit = parseAuditHtml(fixture('dap-audit-results.html'), 'sample.html', 1);

    it('reads coursework with status and completion type', () => {
        expect(audit.courses.map(c => [c.code, c.status, c.type])).toEqual([
            ['C S 314', 'completed', 'In-Residence'],
            ['M 340L', 'in-progress', 'Transfer'],
            ['C S 331', 'planned', 'Credit By Exam'],
        ]);
    });

    it('reads requirement status from the rule markup and the hour/course columns', () => {
        expect(audit.requirements.map(r => [r.text, r.status, r.remaining?.value, r.remaining?.unit])).toEqual([
            ['Complete three core courses', 'in-progress', 1, 'courses'],
            ['Complete the programming requirement', 'completed', 0, 'hours'],
            ['Complete six hours of mathematics', 'in-progress', 3, 'hours'],
        ]);
    });

    it('flags a status that disagrees with the numbers for review', () => {
        // third rule has no fulfilled/partial class but 3 of 6 hours applied
        const math = audit.requirements[2]!;
        expect(math.confidence).toBe('low');
        expect(math.issues.join(' ')).toContain('disagrees');
        expect(needsReview(audit).map(r => r.id)).toContain(math.id);
    });

    it('treats in-residence/accepted transfer as accepted, not pending', () => {
        expect(audit.transfer.accepted.map(c => c.code)).toEqual(['M 340L']);
        expect(audit.transfer.pending).toEqual([]);
    });
});

describe('parseAuditHtml — real IDA markup (Degree Audit Plus fixture)', () => {
    const doc = fixture('dap-audit-results-real.html');
    const audit = parseAuditHtml(doc);

    it('parses every rule row with its markup status', () => {
        const rules = [...doc.querySelectorAll('#requirements tbody.section > tr.rule')].filter(
            r => r.querySelectorAll(':scope > td').length >= 6
        );
        expect(audit.requirements).toHaveLength(rules.length);
        const fulfilled = rules.filter(r => r.classList.contains('fulfilled')).length;
        expect(audit.requirements.filter(r => r.status === 'completed').length).toBeLessThanOrEqual(fulfilled);
    });

    it('extracts core curriculum codes and categories', () => {
        const core = audit.requirements.filter(r => r.category === 'core');
        const tags = new Set(core.flatMap(r => r.tags));
        for (const t of [
            'CORE 010',
            'CORE 020',
            'CORE 040',
            'CORE 050',
            'CORE 060',
            'CORE 070',
            'CORE 080',
            'CORE 090',
        ]) {
            expect(tags.has(t), t).toBe(true);
        }
        expect(core.find(r => r.tags.includes('CORE 090'))?.status).toBe('completed');
        expect(audit.requirements.some(r => r.category === 'major')).toBe(true);
    });

    it('reads course history across semesters and skips excluded classes', () => {
        expect(audit.courses.length).toBeGreaterThan(10);
        expect(audit.courses[0]).toMatchObject({
            code: 'C S 314',
            grade: 'B+',
            unique: '50245',
            semester: 'Fall 2024',
            hours: 3,
        });
        expect(new Set(audit.courses.map(c => c.semester)).has('Classes Excluded from Audit')).toBe(false);
    });

    it('collects prerequisite/restriction sentences', () => {
        expect(audit.restrictions.some(s => /adviser|residence|must/i.test(s))).toBe(true);
    });

    it('lists outstanding requirement tags', () => {
        const outstanding = outstandingTags(audit);
        expect(outstanding).not.toContain('CORE 090');
        expect(takenCourseCodes(audit)).toContain('C S 314');
    });
});

describe('pending transfer credit', () => {
    const html = `<html><body>
      <div id="coursework"><table class="results"><tbody>
        <tr><th class="section_title">Fall 2025 Courses</th></tr>
        <tr><td>RHE 306</td><td>RHETORIC AND WRITING</td><td>CR</td><td></td><td>Transfer</td><td>3</td></tr>
        <tr><th class="section_title">Pending Transfer Courses</th></tr>
        <tr><td>MUS 302L</td><td>WESTERN MUSIC</td><td></td><td></td><td>Transfer</td><td>3</td></tr>
      </tbody></table></div>
      <div id="requirements"><table class="results"><thead><tr><th class="section_title"><a>Core Curriculum</a></th></tr></thead>
        <tbody class="section">
          <tr class="rule fulfilled"><td>1</td><td></td><td>CORE (050): 3 hours in the visual and performing arts are required.</td><td>3 hours</td><td>3 hours</td><td>0 hours</td></tr>
          <tr class="details"><td colspan="6"><table><tbody><tr><td>MUS 302L</td><td>x</td><td></td><td></td><td></td><td>3</td></tr></tbody></table></td></tr>
          <tr class="rule fulfilled"><td>2</td><td></td><td>CORE (010): RHE 306 is required.</td><td>3 hours</td><td>3 hours</td><td>0 hours</td></tr>
          <tr class="details"><td colspan="6"><table><tbody><tr><td>RHE 306</td><td>x</td><td></td><td></td><td></td><td>3</td></tr></tbody></table></td></tr>
        </tbody></table></div></body></html>`;
    const audit = parseAuditHtml(new DOMParser().parseFromString(html, 'text/html'));

    it('is never treated as awarded', () => {
        expect(audit.transfer.pending.map(c => c.code)).toEqual(['MUS 302L']);
        expect(audit.transfer.accepted.map(c => c.code)).toEqual(['RHE 306']);
        const arts = audit.requirements.find(r => r.tags.includes('CORE 050'))!;
        expect(arts.status).toBe('in-progress');
        expect(arts.confidence).toBe('low');
        expect(arts.issues.join(' ')).toContain('pending transfer');
        expect(outstandingTags(audit)).toContain('CORE 050');
        expect(takenCourseCodes(audit)).not.toContain('MUS 302L');
    });

    it('can be corrected or confirmed on the review screen', () => {
        const arts = audit.requirements.find(r => r.tags.includes('CORE 050'))!;
        const corrected = correctRequirement(audit, arts.id, { status: 'not-started' });
        expect(corrected.requirements.find(r => r.id === arts.id)).toMatchObject({
            status: 'not-started',
            reviewed: true,
        });
        expect(needsReview(confirmRequirement(audit, arts.id)).map(r => r.id)).not.toContain(arts.id);
    });
});

describe('parseAuditText (PDF)', () => {
    const lines = [
        'Fall 2024 Courses',
        'Course Grade Unique Type Credit Hours',
        'C S 314 DATA STRUCTURES B+ 50245 In-Residence 3',
        'In Progress M 408D SEQUENCES SERIES 53180 In-Residence 4',
        'Pending Transfer Courses',
        'GOV 310L AMERICAN GOVERNMENT Transfer 3',
        'Core Curriculum (42 hours required with a letter grade)',
        '# Done Requirement Required Counted Lacking Courses Details',
        '1 CORE (090): A first-year signature course (UGS 302 or 303 or the equivalent) is required. 3 hours 3 hours 0 hours UGS 303',
        '2 CORE (050): 3 hours in the visual and performing arts are',
        'required. 3 hours 0 hours 3 hours',
        '3 CORE (070): 6 hours in American & Texas government. 6 hours 3 hours 3 hours GOV 310L',
    ];
    const audit = parseAuditText(lines, 'audit.pdf', 1);

    it('reads courses including pending transfer', () => {
        expect(audit.courses.map(c => [c.code, c.status])).toEqual([
            ['C S 314', 'completed'],
            ['M 408D', 'in-progress'],
            ['GOV 310L', 'pending-transfer'],
        ]);
    });

    it('derives statuses from numbers, joins wrapped lines, and asks for review', () => {
        expect(audit.requirements.map(r => [r.tags[0], r.status])).toEqual([
            ['CORE 090', 'completed'],
            ['CORE 050', 'not-started'],
            ['CORE 070', 'in-progress'],
        ]);
        expect(audit.requirements[1]!.text).toContain('visual and performing arts are required');
        expect(audit.requirements.every(r => r.confidence !== 'high')).toBe(true);
        expect(audit.requirements[2]!.issues.join(' ')).toContain('pending transfer');
        expect(audit.warnings[0]).toContain('PDF');
    });

    it('parses progress text', () => {
        expect(parseProgress('3 Courses')).toEqual({ value: 3, unit: 'courses' });
        expect(parseProgress('  6 hours ')).toEqual({ value: 6, unit: 'hours' });
        expect(parseProgress('')).toBeUndefined();
    });
});
