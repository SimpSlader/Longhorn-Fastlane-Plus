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
    await expect(page.getByText('My degree progress', { exact: true }).first()).toBeVisible();
});
test('duplicate, swap, history and sanitized share import keep existing plans', async ({
    context,
    extensionId,
    sw,
}) => {
    const page = await demo(context, extensionId);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#compare`);
    await page.getByRole('button', { name: /Duplicate / }).click();
    await expect(page.getByRole('status')).toContainText('Copy created');
    const before = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    const newId = before.at(-1).id;
    await expect(page.getByLabel('Right schedule')).toHaveValue(newId);
    const right = page.locator('.comparison-grid > section').last();
    const swap = right.getByLabel('Swap this class').first();
    await expect(swap).toBeVisible();
    await expect.poll(() => swap.locator('option').count()).toBeGreaterThan(1);
    const options = await swap.locator('option').all();
    expect(options.length).toBeGreaterThan(1);
    const value = await options.at(-1)!.getAttribute('value');
    await swap.selectOption(value!);
    await expect(page.getByRole('status')).toContainText('Class changed');
    const after = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    expect(after[0].courses).toEqual(before[0].courses);
    const downloadPromise = page.waitForEvent('download');
    await right.getByRole('button', { name: 'Share schedule file' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    const shared = JSON.parse(readFileSync(path!, 'utf8'));
    expect(Object.keys(shared).sort()).toEqual(['format', 'sections', 'version']);
    const serialized = JSON.stringify(shared);
    for (const key of ['registerURL', 'audit', 'queue', 'notes', 'scheduleId', 'url', 'outcomes'])
        expect(serialized).not.toContain(`"${key}"`);
    await page.getByLabel('Import schedule-only file').setInputFiles(path!);
    await expect(page.getByRole('status')).toContainText('Imported into a new schedule');
    const imported = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    expect(imported.length).toBe(after.length + 1);
    expect(imported[0]).toEqual(after[0]);
    expect(
        imported.at(-1).courses.find((c: { uniqueId: number }) => c.uniqueId === 53780).instructors[0].lastName
    ).toBe('SMITH');
    const imageDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save comparison image' }).click();
    expect((await imageDownload).suggestedFilename()).toBe('FastLane-comparison.png');
    await page.screenshot({ path: 'reports/screenshots/planning-comparison.png', fullPage: true });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#history`);
    await expect(page.getByRole('button', { name: 'Undo last change by restoring a copy' })).toBeVisible();
    await page.getByRole('button', { name: 'Undo last change by restoring a copy' }).click();
    await expect(page.getByRole('status')).toContainText('Restored');
    await page.screenshot({ path: 'reports/screenshots/planning-history.png' });
});
test('finder, generator, roadmap and first-use guidance render and save locally', async ({
    context,
    extensionId,
    sw,
}) => {
    const page = await demo(context, extensionId);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#home`);
    await expect(page.getByRole('heading', { name: 'What should I do next?' })).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome to FastLane' })).toHaveCount(0);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    await page.getByLabel('Semester', { exact: true }).selectOption('Spring 2027');
    await expect(page.locator('.planner-results article').first()).toBeVisible();
    await page.getByRole('button', { name: 'Tuesday / Thursday' }).click();
    await expect(page.getByLabel('M', { exact: true })).not.toBeChecked();
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#generate`);
    await page.getByLabel('Semester', { exact: true }).selectOption('Spring 2027');
    await page.locator('.course-choices input').first().check();
    await page.getByRole('button', { name: 'Generate combinations' }).click();
    await expect(page.getByRole('heading', { name: 'Combination 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save as new schedule' }).first().click();
    await expect(page.getByRole('status')).toContainText('Saved as a new schedule');
    await page.screenshot({ path: 'reports/screenshots/planning-generator.png', fullPage: true });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#roadmap`);
    await page.getByLabel('Semester', { exact: true }).fill('Summer 2027');
    await page.getByLabel('Course or exam code').fill('M 408C');
    await page.getByRole('button', { name: 'Add planned credit' }).click();
    await expect(page.getByRole('heading', { name: 'Summer 2027 · 3 new planned hours' })).toBeVisible();
    await page.screenshot({ path: 'reports/screenshots/planning-roadmap.png', fullPage: true });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#settings`);
    page.on('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete Fastlane data', exact: true }).click();
    await expect(page.getByText('Fastlane data deleted.')).toBeVisible();
    const local = await sw.evaluate(() => chrome.storage.local.get(null));
    expect(local['FastlaneHistory:snapshots']).toEqual([]);
    expect(local['FastlanePlanning:roadmap']).toEqual([]);
    expect(local['FastlanePlanning:rules']).toEqual({});
    expect(errors).toEqual([]);
});
