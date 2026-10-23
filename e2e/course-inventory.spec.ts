import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildInventory } from '../src/fastlane/catalog/offerings';
import type { PdfTextItem } from '../src/fastlane/catalog/offeringsPdf';
import { parseOfferingsItems } from '../src/fastlane/catalog/offeringsPdf';
import { expect, test } from './fixtures';

const excerpt = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src/fastlane/__tests__/fixtures/ut-offerings-spring2027-excerpt.json'), 'utf8')
) as { items: PdfTextItem[] };
// Listings built from real pages of the Registrar's Spring 2027 course-offerings PDF
const { records, meta } = buildInventory(
    parseOfferingsItems(excerpt.items as PdfTextItem[]),
    { name: 'ut.courses.Spring2027.pdf', sha256: 'e2e' },
    Date.parse('2026-10-22T12:00:00Z')
);

test('every subject in the official course list is browsable without visiting UT departments', async ({
    context,
    extensionId,
}) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    await expect(page.getByRole('heading', { name: 'All UT classes for the semester' })).toBeVisible();
    await expect(page.getByText(/Import the course list PDF/)).toBeVisible();

    // same storage the import writes (extension-origin IndexedDB)
    await page.evaluate(
        async ({ rows, info }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open('fastlane');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            const tx = db.transaction(['sections', 'meta'], 'readwrite');
            for (const r of rows)
                tx.objectStore('sections').put({
                    ...r,
                    key: `${r.semester?.code}:${r.uniqueId}`,
                    semesterLabel: 'Spring 2027',
                });
            tx.objectStore('meta').put(info, `offerings:${info.termCode}`);
            await new Promise(resolve => {
                tx.oncomplete = resolve;
            });
        },
        { rows: records, info: meta }
    );
    await page.reload();
    // with a course list imported, the panel moves into the advanced section below the AI chat
    await page.getByText('Browse courses and adjust advanced filters').click();
    await expect(page.getByText(`${meta.sections.toLocaleString()} sections in`)).toBeVisible();
    await expect(page.getByText(/course list as of Oct 1, 2026/)).toBeVisible();

    await page.getByRole('button', { name: 'Browse all classes' }).click();
    await page.getByRole('combobox', { name: 'Semester' }).selectOption('Spring 2027');
    const subject = page.getByRole('combobox', { name: 'Subject' });
    const cards = page.locator('.planner-results article');
    for (const code of ['ECO', 'FIN', 'ACC']) {
        await subject.selectOption(code);
        await expect(cards.first()).toBeVisible();
        const titles = await cards.locator('.class-code').allTextContents();
        expect(titles.length).toBeGreaterThan(2);
        expect(titles.every(t => t.startsWith(`${code} `))).toBe(true);
    }

    // official listing, confirmed details and availability are shown separately
    await subject.selectOption('ECO');
    const first = cards.first();
    await expect(first.locator('.class-time')).not.toBeEmpty();
    await first.getByRole('button', { name: 'Seats' }).click();
    await expect(first.getByText(/Listed by UT Registrar · as of Oct 1, 2026/)).toBeVisible();
    await expect(first.getByText('Section details not yet confirmed on UT')).toBeVisible();
    await expect(first.getByText('Seat availability: confirm on UT')).toBeVisible();
    await expect(first.getByRole('button', { name: 'Confirm on UT' })).toBeVisible();

    // a listed section is a real UTRP course and can be planned
    await first.getByRole('button', { name: /^Add to/ }).click();
    await expect(page.getByText(/^Added ECO /)).toBeVisible();
    expect(errors).toEqual([]);
});

test('imports the Registrar PDF chosen by the student (opt-in: FASTLANE_OFFERINGS_PDF)', async ({
    context,
    extensionId,
}) => {
    test.skip(!process.env.FASTLANE_OFFERINGS_PDF, 'set FASTLANE_OFFERINGS_PDF to the downloaded Registrar PDF');
    test.setTimeout(420_000);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    const started = Date.now();
    await page.locator('.inventory-panel input[type=file]').setInputFiles(process.env.FASTLANE_OFFERINGS_PDF as string);
    await expect(page.getByText(/^Imported Spring 2027: [\d,]+ sections/)).toBeVisible({ timeout: 300_000 });
    console.info(`import took ${Math.round((Date.now() - started) / 1000)} s`);
    await page.getByText('Browse courses and adjust advanced filters').click();
    await page.getByRole('button', { name: 'Browse all classes' }).click();
    await page.getByRole('combobox', { name: 'Semester' }).selectOption('Spring 2027');
    await page.getByRole('combobox', { name: 'Subject' }).selectOption('HIS');
    await expect(page.locator('.planner-results article').first()).toContainText('HIS ');
    console.info(`browse ready after ${Math.round((Date.now() - started) / 1000)} s`);
    const titles = await page.locator('.planner-results article b').allTextContents();
    expect(titles.length).toBeGreaterThan(10);
    expect(titles.every(t => t.startsWith('HIS '))).toBe(true);
});
