import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from '@playwright/test';

import { ADD_DROP_FORM_HTML, courseScheduleTableHtml, DEMO_SEMESTER_CODE } from '../src/pages/demo/fixture';
import { EXTENSION, expect, test } from './fixtures';

const LISTING_URL = `https://utdirect.utexas.edu/apps/registrar/course_schedule/${DEMO_SEMESTER_CODE}/results/?fos_fl=MUS`;
const LISTING_HTML = `<!doctype html><html><body><h1>Course schedule (local fixture)</h1>${courseScheduleTableHtml()}</body></html>`;

/** console errors and page errors mentioning the lifecycle error, from any world (page or content script) */
function watchLifecycleErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
        if (m.type() === 'error') errors.push(m.text());
    });
    return errors;
}

async function reloadExtension(sw: { evaluate: (f: () => void) => Promise<unknown> }) {
    // Reload destroys this service-worker target; content scripts in open tabs stay behind.
    await sw
        .evaluate(() => chrome.runtime.reload())
        .catch(error => {
            if (!/closed|destroyed|Target/i.test(String(error))) throw error;
        });
}

async function routeUt(context: BrowserContext) {
    await context.route('https://utdirect.utexas.edu/**', route => {
        const url = route.request().url();
        const body = url.includes('/course_schedule/')
            ? LISTING_HTML
            : `<!doctype html><html><body>${ADD_DROP_FORM_HTML}</body></html>`;
        return route.fulfill({ contentType: 'text/html', body });
    });
}

test('an open UT page survives extension reload without stale actions or registration submission', async ({
    context,
    sw,
}) => {
    await routeUt(context);
    const page = await context.newPage();
    const errors = watchLifecycleErrors(page);
    await page.goto('https://utdirect.utexas.edu/registration/chooseSemester.WBX');
    const host = page.locator('#fastlane-registration-assistant');
    await expect(host.getByRole('button', { name: 'Plan ↗' })).toBeVisible();
    await host.getByRole('switch', { name: 'Auto-fill code' }).check();
    await expect(page.locator('#s_unique_add')).toHaveValue('65555');
    await page.locator('#s_unique_add').fill('11111');
    await page.evaluate(() => {
        (window as unknown as { submissions: number }).submissions = 0;
        document.addEventListener(
            'submit',
            e => {
                e.preventDefault();
                (window as unknown as { submissions: number }).submissions++;
            },
            true
        );
    });
    await reloadExtension(sw);
    await expect(host.getByRole('button', { name: 'Refresh UT page' })).toBeVisible({ timeout: 15000 });
    await expect(host.getByRole('button', { name: 'Plan ↗' })).toHaveCount(0);
    await expect(host.getByRole('switch')).toHaveCount(0);
    await page.keyboard.press('Alt+Shift+F');
    await page.locator('#message').evaluate(node => {
        node.textContent = 'Requested class is full';
    });
    await expect(page.locator('#s_unique_add')).toHaveValue('11111');
    expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(0);
    expect(errors).toEqual([]);
    // The refresh action is offered, never automatic: a student may still have unsaved UT input.
    await expect(host.getByRole('button', { name: 'Refresh UT page' })).toBeEnabled();
});

test('an open course-listing page tears down Fastlane UI after an extension reload, with no uncaught errors', async ({
    context,
    sw,
}) => {
    await routeUt(context);
    const page = await context.newPage();
    const errors = watchLifecycleErrors(page);
    await page.goto(LISTING_URL);
    const header = page.locator('#ut-registration-plus-table-head select');
    await expect(header).toBeVisible();
    await expect(page.locator('[data-fastlane="row"]').first()).toBeAttached();

    await reloadExtension(sw);
    // stale handler used in the instant before teardown: must not become an uncaught error
    await header.selectOption('B').catch(() => undefined);

    await expect(page.locator('#fastlane-stale-tab-notice')).toBeAttached({ timeout: 15000 });
    await expect(
        page.locator('#fastlane-stale-tab-notice').getByRole('button', { name: 'Refresh page' })
    ).toBeVisible();
    await expect(page.locator('[data-fastlane="row"]')).toHaveCount(0); // extension-dependent UI stopped
    await expect(page.locator('table.results tbody tr').first()).toBeVisible(); // UT's own page untouched
    await page.waitForTimeout(2500); // no polling errors accumulate afterwards
    expect(errors.filter(e => /context invalidated/i.test(e))).toEqual([]);
    expect(errors).toEqual([]);
});

test('after an update, freshly loaded UT pages work again and saved schedules, audit and settings are kept', async () => {
    // Relaunching on the same profile is how the test browser receives the rebuilt extension; Chrome's own
    // "Reload" re-adds an unpacked extension the same way and keeps its storage.
    const userDataDir = mkdtempSync(join(tmpdir(), 'fastlane-update-'));
    const launch = () =>
        chromium.launchPersistentContext(userDataDir, {
            headless: true,
            ...(process.env.PW_CHROMIUM_PATH
                ? { executablePath: process.env.PW_CHROMIUM_PATH }
                : { channel: 'chromium' }),
            args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
        });
    let context = await launch();
    let sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(sw.url()).host;
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${id}/demo.html`);
    await ext.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(ext.locator('#setupStatus')).toContainText('Created');
    await ext.evaluate(async () => {
        await chrome.storage.local.set({ 'FastlaneAudit:audit': { probe: 'audit-kept' } });
        await chrome.storage.sync.set({ 'FastlaneSettings:gradeThreshold': 'B+' });
    });
    await context.close();

    context = await launch();
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    expect(new URL(sw.url()).host).toBe(id); // same extension ID
    await routeUt(context);
    const page = await context.newPage();
    const errors = watchLifecycleErrors(page);
    await page.goto('https://utdirect.utexas.edu/registration/chooseSemester.WBX');
    await expect(
        page.locator('#fastlane-registration-assistant').getByRole('button', { name: 'Plan ↗' })
    ).toBeVisible();
    await page.goto(LISTING_URL);
    await expect(page.locator('#ut-registration-plus-table-head select')).toHaveValue('B+');
    const data = await sw.evaluate(async () => ({
        schedules: ((await chrome.storage.local.get('schedules')).schedules as Array<{ name: string }>).map(
            s => s.name
        ),
        audit: (await chrome.storage.local.get('FastlaneAudit:audit'))['FastlaneAudit:audit'],
        threshold: (await chrome.storage.sync.get('FastlaneSettings:gradeThreshold'))[
            'FastlaneSettings:gradeThreshold'
        ],
    }));
    expect(data.schedules).toContain('Fastlane demo (Ideal)');
    expect(data.audit).toEqual({ probe: 'audit-kept' });
    expect(data.threshold).toBe('B+');
    expect(errors.filter(e => /context invalidated/i.test(e))).toEqual([]);
    await context.close();
});
