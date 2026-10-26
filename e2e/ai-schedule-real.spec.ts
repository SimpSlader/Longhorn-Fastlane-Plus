import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildInventory } from '../src/fastlane/catalog/offerings';
import type { PdfTextItem } from '../src/fastlane/catalog/offeringsPdf';
import { parseOfferingsItems } from '../src/fastlane/catalog/offeringsPdf';
import { expect, test } from './fixtures';

/** Opt-in: FASTLANE_OFFERINGS_PDF=/path/to/ut.courses.Spring2027.pdf (UT's file is not committed). */
const PDF = process.env.FASTLANE_OFFERINGS_PDF;

const EXAMPLE =
    'Build me a schedule for next semester that helps me become core complete, no history classes, really high A grades to protect my GPA, classes only on Tuesdays and Thursdays, preferably 1–2 online, 12–13 credit hours. I plan on taking classes through ACC. Make sure all classes are back to back so I have no awkward gaps.';

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
        { name: 'ut.courses.Spring2027.pdf', sha256: 'real' },
        Date.now()
    );
}

test('the exact request builds a valid Tue/Thu, 12–13 credit, no-history schedule from the real catalog', async ({
    context,
    extensionId,
}) => {
    test.skip(!PDF, 'set FASTLANE_OFFERINGS_PDF to the Registrar PDF');
    test.setTimeout(400_000);
    const { records, meta } = await fullInventory();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    await page
        .locator('input[type=file]')
        .setInputFiles(resolve(process.cwd(), 'src/fastlane/__tests__/fixtures/dap-audit-results-real.html'));
    await expect(page.getByText('Official IDA degree completion').first()).toBeVisible();
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
    // the AI ranks: here it simply returns the first candidates it was given (the code must still enforce rules)
    const sent: Array<{
        candidates: Array<{ id: number; code: string; days: string[] }>;
        preferences: Record<string, unknown>;
    }> = [];
    await page.route('https://longhorn-fastlane-plus.vercel.app/api/recommend', async route => {
        const body = route.request().postDataJSON();
        sent.push(body);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': `chrome-extension://${extensionId}` },
            body: JSON.stringify({
                summary: 'Ranked.',
                recommendations: body.candidates.slice(0, 10).map((c: { id: number }) => ({
                    id: c.id,
                    reason: 'r',
                    requirement: '',
                    confidence: 'possible',
                    warning: '',
                })),
            }),
        });
    });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    const box = page.getByRole('textbox', { name: 'Ask Fastlane for class recommendations' });
    await box.fill(EXAMPLE);
    await page.getByPlaceholder('Enter once to enable AI').fill('real-catalog-test');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    await page.getByRole('button', { name: 'Send message' }).click();

    const proposal = page.getByRole('region', { name: 'Proposed schedule' });
    await expect(proposal).toBeVisible({ timeout: 180_000 });
    await expect(proposal).toContainText('All rules met');
    // nothing sent to AI breaks a hard rule either
    expect(sent[0]!.candidates.every(c => !c.code.startsWith('HIS '))).toBe(true);
    expect(sent[0]!.candidates.every(c => c.days.every(d => d === 'T' || d === 'TH'))).toBe(true);
    expect(sent[0]!.preferences.credits).toEqual({ min: 12, max: 13 });

    // read the schedule from the calendar and check it independently
    const blocks = await proposal.locator('.week-block').evaluateAll(els =>
        els.map(e => ({
            text: e.querySelector('b')?.textContent ?? '',
            day: e.closest('.col')?.querySelector('.dayhead')?.textContent ?? '',
        }))
    );
    expect(blocks.every(b => b.day === 'Tue' || b.day === 'Thu')).toBe(true);
    expect(blocks.some(b => b.text.startsWith('HIS '))).toBe(false);
    const heading = await proposal.locator('.fl-plan-total').textContent();
    const credits = Number(heading?.match(/(\d+) credits/)?.[1]);
    expect(credits).toBeGreaterThanOrEqual(12);
    expect(credits).toBeLessThanOrEqual(13);
    console.info('PROPOSAL', heading, JSON.stringify(blocks), await page.locator('.bubble.bot').last().textContent());
    console.info('ASYNC', await proposal.locator('.course-pill').allTextContents());
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/real-exact-request.png' });
});
