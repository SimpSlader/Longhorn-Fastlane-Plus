/**
 * Optional check against the Registrar's real course-offerings PDF (not committed; it is UT's document).
 * Run with: FASTLANE_OFFERINGS_PDF=/path/to/ut.courses.Spring2027.pdf pnpm vitest run offerings-real-pdf
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildInventory } from '../catalog/offerings';
import type { PdfTextItem } from '../catalog/offeringsPdf';
import { parseOfferingsItems } from '../catalog/offeringsPdf';
import { prerequisiteCourses, subjectNameIndex } from '../core/prerequisites';
import { subjectOf } from '../core/sections';
import { UT_SUBJECTS } from '../data/subjects';

const PDF = process.env.FASTLANE_OFFERINGS_PDF;

async function items(path: string): Promise<PdfTextItem[]> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
    const out: PdfTextItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        for (const item of content.items as Array<{ str: string; transform: number[] }>)
            if (item.str.trim())
                out.push({ page: p, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, str: item.str });
    }
    return out;
}

describe.runIf(PDF)('real Registrar offerings PDF', () => {
    it('parses every printed section of every subject', { timeout: 120_000 }, async () => {
        const all = await items(PDF as string);
        const parse = parseOfferingsItems(all);
        const printedUniques = new Set<number>();
        const sorted = [...all].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
        sorted.forEach((item, i) => {
            const next = sorted[i + 1];
            if (item.str === '•' && next && next.page === item.page && Math.abs(next.y - item.y) < 2.5)
                if (/^\d{5}$/.test(next.str)) printedUniques.add(Number(next.str));
        });
        const parsed = new Set(parse.sections.map(s => s.uniqueId));
        expect([...printedUniques].filter(u => !parsed.has(u))).toEqual([]);
        expect([...parsed].filter(u => !printedUniques.has(u))).toEqual([]);

        const { meta, records } = buildInventory(parse, { name: 'offerings.pdf', sha256: 'x' }, 1);
        const index = subjectNameIndex([
            ...UT_SUBJECTS,
            ...Object.entries(parse.subjects).map(([code, name]) => ({ code, name })),
        ]);
        const withPrereq = records.filter(r => r.prerequisites);
        const withRefs = withPrereq.filter(r => prerequisiteCourses(r.prerequisites ?? '', index).length);
        console.info(
            JSON.stringify({
                term: meta.term,
                asOf: meta.asOf,
                sections: meta.sections,
                courses: meta.courses,
                subjects: meta.subjects,
                issues: parse.issues.length,
                withPrereq: withPrereq.length,
                withPrereqCourseRefs: withRefs.length,
            })
        );
        for (const code of ['ECO 420K', 'FIN 357', 'M 408D', 'C S 314', 'ACC 312', 'M 427J']) {
            const r = records.find(x => x.courseCode === code);
            if (r)
                console.info(
                    code,
                    '|',
                    r.prerequisites?.slice(0, 150),
                    '=>',
                    prerequisiteCourses(r.prerequisites ?? '', index)
                );
        }
        for (const subject of ['ECO', 'FIN', 'ACC', 'M', 'C S', 'HIS', 'UGS']) {
            const rows = records.filter(r => subjectOf(r.courseCode) === subject);
            expect(rows.length).toBeGreaterThan(20);
            expect(rows.every(r => r.courseCode.startsWith(`${subject} `))).toBe(true);
        }
        expect(parse.issues.length).toBeLessThan(20);
    });
});
