import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildInventory } from '../src/fastlane/catalog/offerings';
import type { PdfTextItem } from '../src/fastlane/catalog/offeringsPdf';
import { parseOfferingsItems } from '../src/fastlane/catalog/offeringsPdf';
import { expect, test } from './fixtures';

/** Opt-in: FASTLANE_OFFERINGS_PDF=/path/to/ut.courses.Spring2027.pdf (UT's file is not committed). */
const PDF = process.env.FASTLANE_OFFERINGS_PDF;

async function fullInventory() {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(PDF as string)), verbosity: 0 }).promise;
    const items: PdfTextItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        for (const it of content.items as Array<{ str: string; transform: number[] }>)
            if (it.str.trim()) items.push({ page: p, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0, str: it.str });
    }
    return buildInventory(
        parseOfferingsItems(items),
        { name: 'ut.courses.Spring2027.pdf', sha256: 'perf' },
        Date.now()
    );
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

test('AI screen stays responsive with the full UT course list and an IDA', async ({ context, extensionId }) => {
    test.skip(!PDF, 'set FASTLANE_OFFERINGS_PDF to the Registrar PDF');
    test.setTimeout(400_000);
    const { records, meta } = await fullInventory();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    await page
        .locator('input[type=file]')
        .setInputFiles(resolve(process.cwd(), 'src/fastlane/__tests__/fixtures/dap-audit-results-real.html'));
    await expect(page.getByText('Official IDA degree completion').first()).toBeVisible();
    // same storage the course-list import writes (extension-origin IndexedDB)
    await page.evaluate(
        async ({ rows, info }) => {
            const db = await new Promise<IDBDatabase>((ok, ko) => {
                const r = indexedDB.open('fastlane', 1);
                r.onupgradeneeded = () => {
                    const d = r.result;
                    for (const n of ['datasets', 'payloads', 'meta'])
                        if (!d.objectStoreNames.contains(n)) d.createObjectStore(n);
                    if (!d.objectStoreNames.contains('sections'))
                        d.createObjectStore('sections', { keyPath: 'key' }).createIndex('semester', 'semester');
                };
                r.onsuccess = () => ok(r.result);
                r.onerror = () => ko(r.error);
            });
            const tx = db.transaction(['sections', 'meta'], 'readwrite');
            for (const r of rows)
                tx.objectStore('sections').put({
                    ...r,
                    key: `${r.semester?.code}:${r.uniqueId}`,
                    semesterLabel: 'Spring 2027',
                });
            tx.objectStore('meta').put(info, `offerings:${info.termCode}`);
            await new Promise(ok => {
                tx.oncomplete = ok;
            });
        },
        { rows: records, info: meta }
    );
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#home`);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
        const w = window as unknown as { __long: number[] };
        w.__long = [];
        new PerformanceObserver(l => {
            for (const e of l.getEntries()) w.__long.push(Math.round(e.duration));
        }).observe({ type: 'longtask' });
    });
    const takeLong = () =>
        page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0)) as Promise<number[]>;

    // opening the AI screen
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Find classes' }).click();
    const box = page.getByRole('textbox', { name: 'Ask Fastlane for class recommendations' });
    await expect(box).toBeVisible();
    await page.waitForTimeout(5000);
    const openLong = await takeLong();

    // typing
    const t1 = Date.now();
    await box.pressSequentially('No classes Monday or Friday', { delay: 30 });
    const typedMs = Date.now() - t1;
    await page.waitForTimeout(2000);
    const typeLong = await takeLong();

    // asking: local selection over every section + grades for the shortlist + (mocked) AI request
    await page.route('https://longhorn-fastlane-plus.vercel.app/api/recommend', async route => {
        const body = route.request().postDataJSON() as { candidates: Array<{ id: number }> };
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': `chrome-extension://${extensionId}` },
            body: JSON.stringify({
                summary: `Compared ${body.candidates.length} sections.`,
                recommendations: body.candidates
                    .slice(0, 4)
                    .map(c => ({ id: c.id, reason: 'r', requirement: '', confidence: 'possible', warning: '' })),
            }),
        });
    });
    await page.getByPlaceholder('Enter once to enable AI').fill('perf-test-code');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    await takeLong();
    const t2 = Date.now();
    await page.getByRole('button', { name: 'Ask Fastlane' }).click();
    await expect(page.locator('.ai-result').first()).toBeVisible({ timeout: 120_000 });
    const submitMs = Date.now() - t2;
    const submitLong = await takeLong();

    // cancelling stops the work and sends nothing
    await box.fill('Only afternoons please');
    await page.getByRole('button', { name: 'Ask Fastlane' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Stopped. Nothing was sent.')).toBeVisible();

    console.info(
        JSON.stringify({
            sections: records.length,
            openBlockedMs: sum(openLong),
            openMaxTaskMs: Math.max(0, ...openLong),
            typedMs,
            typeMaxTaskMs: Math.max(0, ...typeLong),
            submitMs,
            submitMaxTaskMs: Math.max(0, ...submitLong),
        })
    );
    // budgets: opening and typing never freeze the page; asking never blocks for long
    expect(sum(openLong)).toBeLessThan(800);
    expect(Math.max(0, ...typeLong)).toBeLessThan(200);
    expect(Math.max(0, ...submitLong)).toBeLessThan(400);
});
