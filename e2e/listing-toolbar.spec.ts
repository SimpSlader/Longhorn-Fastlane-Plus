import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** UT's course-listing rows, in page order: "H:<course header>" or the unique number */
async function tableOrder(page: Page): Promise<string[]> {
    return page.locator('table.results tbody tr').evaluateAll(rows =>
        rows
            .filter(r => (r as HTMLElement).style.display !== 'none')
            .map(r => {
                const header = r.querySelector('.course_header');
                if (header) return `H:${(header.textContent ?? '').trim().split(/\s+/).slice(0, 3).join(' ')}`;
                return (r.querySelector('td[data-th="Unique"] a')?.textContent ?? '?').trim();
            })
    );
}

test('Fastlane toolbar sorts and filters UT listing rows and resets to UT order', async ({ context, extensionId }) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/demo.html`);
    await page.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(page.locator('#setupStatus')).toContainText('Created');
    const bar = page.getByRole('region', { name: 'Fastlane sort and filter' });
    await expect(bar).toBeVisible();
    await expect(page.locator('[data-fastlane="grade"]').first()).toBeVisible();
    const original = await tableOrder(page);
    const allRows = await page.locator('table.results tbody tr').count();

    // sort by A/A− rate: sections stay under their own course header, and courses follow their best section
    await bar.getByRole('combobox', { name: 'Sort sections' }).selectOption('grade');
    await expect(bar.getByRole('status')).toContainText(/Showing \d+ of \d+ sections/);
    await expect.poll(() => tableOrder(page)).not.toEqual(original);
    const sorted = await tableOrder(page);
    expect([...sorted].sort()).toEqual([...original].sort());
    // every section still follows its original header
    const headerOf = (order: string[]) => {
        const map = new Map<string, string>();
        let h = '';
        for (const x of order) {
            if (x.startsWith('H:')) h = x;
            else map.set(x, h);
        }
        return map;
    };
    expect(headerOf(sorted)).toEqual(headerOf(original));
    // the UT row controls are untouched: each section row still has its grade chip and graph button
    await expect(
        page.locator('table.results tbody tr button[aria-label="Open historical grade distribution graph"]')
    ).toHaveCount(await page.locator('table.results tbody tr td[data-th="Unique"]').count());

    // minimum A− filter hides sections without enough (or any) grade data
    await bar.getByRole('combobox', { name: 'Minimum percentage of A− or better' }).selectOption('90');
    const sections = (order: string[]) => order.filter(x => !x.startsWith('H:')).length;
    await expect.poll(async () => sections(await tableOrder(page))).toBeLessThan(sections(original));

    // class format chips and conflicts with the active schedule
    await bar.getByRole('combobox', { name: 'Minimum percentage of A− or better' }).selectOption('0');
    await bar.getByRole('button', { name: 'In person' }).click();
    await bar.getByRole('button', { name: 'Live online' }).click();
    await expect.poll(() => tableOrder(page)).not.toContain('33505'); // face-to-face C C 302
    expect(await tableOrder(page)).toContain('23095'); // the demo's asynchronous MUS 302L
    await bar.getByRole('button', { name: 'In person' }).click();
    await bar.getByRole('button', { name: 'Live online' }).click();
    await bar.getByRole('checkbox', { name: /Hide conflicts with/ }).check();
    await expect.poll(() => tableOrder(page)).not.toContain('20001'); // the demo's ARH section that conflicts with M 408C
    await page.screenshot({ path: 'test-results/listing-toolbar.png', fullPage: false });

    // reset puts back UT's exact order with nothing hidden
    await bar.getByRole('button', { name: 'Reset to UT order' }).click();
    await expect.poll(() => tableOrder(page)).toEqual(original);
    expect(await page.locator('table.results tbody tr').count()).toBe(allRows);
    expect(await page.locator('table.results tbody tr[data-fastlane-hidden]').count()).toBe(0);
    expect(errors).toEqual([]);
});
