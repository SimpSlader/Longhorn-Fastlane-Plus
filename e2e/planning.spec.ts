import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';

async function demo(context: import('@playwright/test').BrowserContext, id: string) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/demo.html`);
    await page.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(page.locator('#setupStatus')).toContainText('Created');
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const r = await chrome.runtime.sendMessage({ fastlane: true, type: 'getSections' });
                return r.data?.length ?? 0;
            })
        )
        .toBeGreaterThan(0);
    return page;
}
test('IDA import is opt-in, local, and excludes page identity', async ({ context, extensionId, sw }) => {
    const fixture = readFileSync(resolve('src/fastlane/__tests__/fixtures/dap-audit-results-real.html'), 'utf8');
    await context.route('https://utdirect.utexas.edu/**', route =>
        route.fulfill({
            contentType: 'text/html',
            body: fixture.replace('<body>', '<body><h1>Private Student Name</h1>'),
        })
    );
    const page = await context.newPage();
    const outbound: string[] = [];
    page.on('request', r => {
        if (!r.url().startsWith('chrome-extension:') && !r.url().startsWith('https://utdirect.utexas.edu/'))
            outbound.push(r.url());
    });
    await page.goto('https://utdirect.utexas.edu/apps/degree/audits/results/12345/');
    await expect(page.getByRole('button', { name: 'Add IDA' })).toBeVisible();
    expect(
        (await sw.evaluate(() => chrome.storage.local.get('FastlaneAudit:audit')))['FastlaneAudit:audit'] ?? null
    ).toBeNull();
    await page.getByRole('button', { name: 'Add IDA' }).click();
    await expect(page.getByRole('button', { name: 'Review IDA' })).toBeVisible();
    const saved = (await sw.evaluate(() => chrome.storage.local.get('FastlaneAudit:audit')))['FastlaneAudit:audit'];
    expect(saved.courses.length).toBeGreaterThan(0);
    expect(saved.requirements.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toContain('Private Student Name');
    expect(JSON.stringify(saved)).not.toContain('/results/12345');
    expect(saved.program).toBeUndefined();
    expect(outbound).toEqual([]);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    await expect(page.getByRole('heading', { name: 'Degree progress' })).toBeVisible();
});
test('minimal planner navigation keeps saved schedules accessible', async ({ context, extensionId, sw }) => {
    const page = await demo(context, extensionId);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#home`);
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav.getByRole('button')).toHaveCount(4);
    await expect(nav.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Find classes' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'My schedule' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Degree progress' })).toBeVisible();

    const schedules = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    await expect(page.getByRole('combobox', { name: 'CURRENT SCHEDULE' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'CURRENT SCHEDULE' }).locator('option')).toHaveCount(
        schedules.length
    );
    await nav.getByRole('button', { name: 'My schedule' }).click();
    await expect(page.getByRole('link', { name: 'Open full calendar' })).toBeVisible();
    // Nothing in the simplified planner should mutate existing schedule data just by navigating.
    const after = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    expect(after).toEqual(schedules);
});

test('IDA-based home and simple course filters work without hidden advanced screens', async ({
    context,
    extensionId,
}) => {
    const page = await demo(context, extensionId);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#home`);
    await expect(page.getByRole('heading', { name: 'Plan your next semester.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import my IDA' })).toBeVisible();

    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    await page.getByText('Browse courses and adjust advanced filters').click();
    await page.getByRole('button', { name: 'Browse all classes' }).click();
    await page.getByRole('combobox', { name: 'Semester' }).selectOption('Spring 2027');
    await expect(page.locator('.planner-results article').first()).toBeVisible();
    const subject = page.getByRole('combobox', { name: 'Subject' });
    await expect(subject).toBeVisible();
    await subject.selectOption('MUS');
    await expect(page.locator('.planner-results article').first()).toContainText('MUS');
    await page.getByRole('combobox', { name: 'Minimum historical A minus percentage' }).selectOption('80');
    await expect(page.getByText(/historical A− or better/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Fri', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Fri', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('More filters')).toBeVisible();

    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    await expect(page.getByRole('heading', { name: 'Degree progress' })).toBeVisible();
    await expect(page.getByText(/Drop your audit here/)).toBeVisible();
    expect(errors).toEqual([]);
});
