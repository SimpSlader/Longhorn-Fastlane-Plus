import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

const SHOTS = resolve(process.cwd(), 'reports/screenshots');
mkdirSync(SHOTS, { recursive: true });

async function openDemo(page: Page, extensionId: string) {
    await page.goto(`chrome-extension://${extensionId}/demo.html`);
    await page.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(page.locator('#setupStatus')).toContainText('Created');
}

/** text content of the shadow-rooted injected cell for a unique number */
function rowFor(page: Page, unique: string) {
    return page.locator('table.results tbody tr', { has: page.locator(`td[data-th="Unique"] a`, { hasText: unique }) });
}

test.describe('Chrome extension permissions & security', () => {
    test('manifest requests only the minimal permissions and UT hosts', async ({ sw }) => {
        const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
        expect(manifest.manifest_version).toBe(3);
        expect(manifest.name).toBe('Fastlane Course Planner');
        expect([...(manifest.permissions ?? [])].sort()).toEqual([
            'alarms',
            'notifications',
            'scripting',
            'storage',
            'unlimitedStorage',
        ]);
        for (const host of manifest.host_permissions ?? []) {
            expect(host).toMatch(/utexas\.edu|collegescheduler\.com|bluera\.com|longhorn-fastlane-plus\.vercel\.app/);
        }
        expect(manifest.host_permissions).not.toContain('<all_urls>');
        expect(JSON.stringify(manifest.host_permissions)).not.toContain('login.utexas.edu');
        expect(manifest.content_security_policy?.extension_pages).toBe(
            "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
        );
    });
});

test.describe('fresh profile', () => {
    test('only this extension is installed and its pages load without errors', async ({ context, extensionId, sw }) => {
        expect(context.serviceWorkers()).toHaveLength(1);
        expect(await sw.evaluate(() => chrome.runtime.getManifest().name)).toBe('Fastlane Course Planner');
        const errors: string[] = [];
        const failedThirdParty: string[] = [];
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => {
            if (m.type() === 'error') errors.push(m.text());
        });
        page.on('response', r => {
            if (r.status() >= 400 && new URL(r.url()).hostname === 'api.github.com') failedThirdParty.push(r.url());
        });
        for (const p of [
            'fastlane.html',
            'demo.html',
            'calendar.html',
            'src/pages/popup/index.html',
            'map.html',
            'options.html',
        ]) {
            await page.goto(`chrome-extension://${extensionId}/${p}`);
            await page.waitForTimeout(700);
        }
        // The Settings page's GitHub contributor request can be rate-limited (403) or offline in CI. Those are
        // network conditions, not extension errors; any other console error fails the test.
        const excused = (e: string) => failedThirdParty.length > 0 && /Failed to load resource/.test(e);
        expect(errors.filter(e => !excused(e) && !/api\.github\.com|ERR_INTERNET_DISCONNECTED/i.test(e))).toEqual([]);
    });
});

test.describe('calendar sidebar usability', () => {
    test('calendar shows saved backups and separates its black title from totals and toggle', async ({
        context,
        extensionId,
    }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);
        await page.goto(`chrome-extension://${extensionId}/calendar.html`);
        const backups = page.getByRole('complementary', { name: 'Backups' });
        await expect(backups).toBeVisible();
        await expect(backups).toContainText('33505');
        await expect(backups).toContainText('23095');
        const summary = page.getByTestId('schedule-summary');
        const title = summary.getByText('Fastlane demo (Ideal)', { exact: true });
        await expect(title).toHaveCSS('color', 'rgb(17, 17, 17)');
        const titleBox = await title.boundingBox();
        const totalsBox = await page.getByTestId('schedule-totals').boundingBox();
        expect(titleBox && totalsBox && titleBox.y + titleBox.height <= totalsBox.y).toBe(true);
        await page.getByRole('button', { name: 'Hide schedule sidebar' }).click();
        const toggleBox = await page.getByRole('button', { name: 'Show schedule sidebar' }).boundingBox();
        await expect.poll(async () => (await summary.boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(72);
        expect(toggleBox?.x).toBe(16);
        await page.screenshot({ path: `${SHOTS}/calendar-backups.png` });
    });

    test('a compact icon button reopens the sidebar when it is collapsed', async ({ context, extensionId }) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/calendar.html`);
        const hide = page.getByRole('button', { name: 'Hide schedule sidebar' });
        await expect(hide).toBeVisible();
        await hide.click();
        const reopen = page.getByRole('button', { name: 'Show schedule sidebar' });
        await expect(reopen).toBeVisible();
        const dimensions = await reopen.boundingBox();
        expect(dimensions).not.toBeNull();
        expect(dimensions?.width).toBeGreaterThanOrEqual(40);
        expect(dimensions?.height).toBeGreaterThanOrEqual(40);
        await page.screenshot({ path: `${SHOTS}/calendar-sidebar-closed.png`, fullPage: false });
        for (const viewport of [
            { width: 1440, height: 1000 },
            { width: 800, height: 600 },
        ]) {
            await page.setViewportSize(viewport);
            const geometry = await reopen.evaluate(button => {
                const rect = button.getBoundingClientRect();
                const root = button.getRootNode() as Document | ShadowRoot;
                return {
                    position: getComputedStyle(button).position,
                    left: rect.left,
                    top: rect.top,
                    clickable: button.contains(
                        root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                    ),
                    clipped: Array.from(
                        (function* () {
                            for (let parent = button.parentElement; parent; parent = parent.parentElement) yield parent;
                        })()
                    ).some(parent => /auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflow)),
                };
            });
            expect(geometry).toEqual({ position: 'fixed', left: 16, top: 16, clickable: true, clipped: false });
        }
        await page.reload();
        await expect(reopen).toBeVisible();
        await reopen.click();
        await expect(hide).toBeVisible();
        await expect(reopen).toHaveCount(0);
        await page.reload();
        await expect(hide).toBeVisible();
    });
});

test.describe('course listing integration (demo fixtures, real code)', () => {
    test('inline grade percentages, threshold changes, async and conflict indicators', async ({
        context,
        extensionId,
    }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);

        // A- or better percentage with professor attribution next to the graph button
        const music = rowFor(page, '23095');
        await expect(music.locator('[data-fastlane="grade"]')).toContainText(/\d+\.\d%\s*A-\+\s*·\s*Prof/);
        const before = await music.locator('[data-fastlane="grade"]').innerText();

        // changing the threshold globally recalculates from counts
        await page.locator('#ut-registration-plus-table-head select').selectOption('B');
        await expect(music.locator('[data-fastlane="grade"]')).toContainText('B or better');
        const after = await music.locator('[data-fastlane="grade"]').innerText();
        expect(Number.parseFloat(after)).toBeGreaterThanOrEqual(Number.parseFloat(before));
        await page.locator('#ut-registration-plus-table-head select').selectOption('A-');

        // tooltip carries sample size, semesters, source and dataset date
        const tip = await music.locator('[data-fastlane="grade"]').getAttribute('title');
        expect(tip).toMatch(/letter grades/);
        expect(tip).toMatch(/semester/);
        expect(tip).toMatch(/Source:/);
        expect(tip).toMatch(/Dataset/);

        // blue async row only for verified async; WB with times is live online, not async
        await expect(music.locator('[data-fastlane="async"]')).toBeVisible();
        expect(await music.getAttribute('class')).toMatch(/isAsync/);
        const live = rowFor(page, '27425');
        await expect(live.locator('[data-fastlane="live-online"]')).toBeVisible();
        expect(await live.getAttribute('class')).not.toMatch(/isAsync/);
        await expect(live.locator('td[data-th="Unique"] a')).toHaveCSS('color', 'rgb(29, 78, 216)');
        await expect(music.locator('td[data-th="Unique"] a')).toHaveCSS('color', 'rgb(29, 78, 216)');
        expect(await rowFor(page, '33505').getAttribute('class')).not.toMatch(/isAsync/);

        // confirmed conflict names the planned class and strikes the row
        const art = rowFor(page, '20001');
        await expect(art.locator('[data-fastlane="conflict"]')).toContainText('M 408C (53780)');
        expect(await art.getAttribute('class')).toMatch(/isConflict/);
        // incomplete meeting info → unknown, not struck through
        const tba = rowFor(page, '20004');
        await expect(tba.locator('[data-fastlane="conflict-unknown"]')).toBeVisible();
        expect(await tba.getAttribute('class')).not.toMatch(/isConflict/);
        // async section never conflicts by modality alone
        await expect(music.locator('[data-fastlane="conflict"]')).toHaveCount(0);

        await page
            .locator('section')
            .nth(1)
            .screenshot({ path: `${SHOTS}/1-listing-grades-async-conflicts.png` });
    });

    test('backups do not join the active schedule, prevent duplicates, and persist after reload', async ({
        context,
        extensionId,
    }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);
        const theatre = rowFor(page, '27425');
        await theatre.getByRole('button', { name: '+ Backup' }).click();
        await theatre.getByRole('button', { name: /MUS 302L · 23100/ }).click();
        await expect(theatre.locator('[data-fastlane="backup-badge"]')).toContainText('Backup #3 for MUS 302L');

        const state = await page.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const schedules = all.schedules as Array<{ name: string; courses: Array<{ uniqueId: number }> }>;
            const demo = schedules.find(s => s.name === 'Fastlane demo (Ideal)')!;
            return { active: demo.courses.map(c => c.uniqueId).sort() };
        });
        expect(state.active).toEqual([23100, 53780, 65555]);

        // reload = browser restart for storage purposes
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#plan`);
        await expect(page.locator('.counts')).toContainText('10 hours');
        await expect(page.locator('.counts')).toContainText('3 courses');
        await expect(page.locator('.counts')).toContainText('3 backups');
        await expect(page.locator('.slot-primary .chip', { hasText: '%' }).first()).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/2-schedule-builder-backups.png`, fullPage: true });

        // activate a backup: it swaps into the calendar schedule
        const slot = page.locator('[data-testid=slot]', { has: page.locator('.slot-primary', { hasText: '23100' }) });
        await slot.locator('.cand', { hasText: '33505' }).getByRole('button', { name: 'Activate' }).click();
        await expect(page.locator('.slot-primary', { hasText: '33505' })).toBeVisible();
        const swapped = await page.evaluate(async () => {
            const all = await chrome.storage.local.get(null);
            const demo = (all.schedules as Array<{ name: string; courses: Array<{ uniqueId: number }> }>).find(
                s => s.name === 'Fastlane demo (Ideal)'
            )!;
            return demo.courses.map(c => c.uniqueId).sort();
        });
        expect(swapped).toEqual([33505, 53780, 65555]);
        await page.reload();
        await expect(page.locator('.slot-primary', { hasText: '33505' })).toContainText('Active · backup');
    });
});

test.describe('grade distribution graph (Highcharts replacement)', () => {
    test('opens the course popup with a dependency-free SVG chart', async ({ context, extensionId }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);
        await rowFor(page, '23095').getByRole('button', { name: 'Open historical grade distribution graph' }).click();
        const chart = page.locator('svg[role="img"][aria-label="Grade distribution chart"]');
        await expect(chart).toBeVisible();
        await expect(page.locator('table caption', { hasText: 'Grade distribution' })).toBeAttached(); // accessible data table
        await expect(page.getByText('Grade Distribution for')).toBeVisible();
        expect(await page.evaluate(() => 'Highcharts' in window)).toBe(false);
        await page.waitForTimeout(1200); // let the dialog's open transition and column animation finish
        // the dialog must reserve the chart's height and show it without scrolling (regression: auto-height SVG collapsed)
        const box = (await chart.boundingBox())!;
        expect(box.height).toBeGreaterThan(200);
        expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        await chart.locator('rect[data-grade="A"]').hover();
        await expect(page.getByRole('tooltip')).toContainText(/A.*\d+ students · \d+\.\d%/s);
        await expect(page.getByRole('tooltip')).toHaveCSS('color', 'rgb(0, 0, 0)');
        expect((await page.getByRole('tooltip').boundingBox())?.width).toBeGreaterThanOrEqual(160);
        for (const [name, color] of [
            ['Past Syllabi', 'rgb(255, 243, 204)'],
            ['CES', 'rgb(230, 247, 246)'],
            ['RateMyProf', 'rgb(234, 243, 248)'],
        ]) {
            await expect(page.getByRole('button', { name, exact: true })).toHaveCSS('background-color', color);
        }
        await page.screenshot({ path: `${SHOTS}/9-grade-distribution-popup.png` });
    });
});

test.describe('registration assistant', () => {
    test('queue transitions, undo, history, and persistence', async ({ context, extensionId }) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/demo.html`);
        const panel = page.locator('#fastlane-registration-assistant');
        await expect(panel.locator('.code')).toHaveText('65555');
        await panel.getByRole('button', { name: 'Full' }).click();
        await expect(panel.locator('.code')).toHaveText('65705');
        await panel.getByRole('button', { name: 'Restriction' }).click();
        await panel.getByRole('button', { name: 'Conflict' }).click();
        await expect(panel.locator('.code')).toHaveText('23095'); // Western Music after three UGS failures
        await panel.getByRole('button', { name: '↶ Undo' }).click();
        await expect(panel.locator('.code')).toHaveText('65605');
        await page.reload();
        await expect(panel.locator('.code')).toHaveText('65605');
        await expect(panel.getByText('Attempt history')).toHaveCount(0);
        const historyLength = await page.evaluate(
            async () =>
                (
                    (await chrome.storage.local.get('FastlaneQueue:queue'))['FastlaneQueue:queue'] as {
                        history: unknown[];
                    }
                ).history.length
        );
        expect(historyLength).toBe(4);
        await panel.screenshot({ path: `${SHOTS}/3-registration-assistant.png` });
    });

    test('optional autofill fills the ADD field only and never submits', async ({ context, extensionId }) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/demo.html`);
        const panel = page.locator('#fastlane-registration-assistant');
        // off by default: nothing is filled
        await expect(panel.locator('.code')).toHaveText('65555');
        await expect(page.locator('#s_unique_add')).toHaveValue('');
        // Turning on the switch fills the current code without submitting.
        await panel.getByRole('switch', { name: 'Auto-fill code' }).check();
        await expect(page.locator('#s_unique_add')).toHaveValue('65555');
        await expect(page.locator('#s_swap_unique_add')).toHaveValue('');
        await expect(page.locator('#ds_request_STADD')).toBeChecked();
        await expect(page.locator('#message')).toHaveText('');

        // Off prevents filling the next code; switching back on fills it immediately.
        await panel.getByRole('switch', { name: 'Auto-fill code' }).uncheck();
        await panel.getByRole('button', { name: 'Full' }).click();
        await expect(panel.locator('.code')).toHaveText('65705');
        await expect(page.locator('#s_unique_add')).toHaveValue('65555');
        await panel.getByRole('switch', { name: 'Auto-fill code' }).check();
        await expect(page.locator('#s_unique_add')).toHaveValue('65705');
        await expect(page.locator('#message')).toHaveText(''); // no submission happened

        // a value the student typed is never overwritten
        await page.locator('#s_unique_add').fill('11111');
        await panel.getByRole('button', { name: 'Full' }).click();
        await expect(page.locator('#s_unique_add')).toHaveValue('11111');
        await expect(panel.getByText('left alone')).toBeVisible();

        // history logs autofill events
        const actions = await page.evaluate(async () => {
            const q = (await chrome.storage.local.get('FastlaneQueue:queue'))['FastlaneQueue:queue'] as {
                history: Array<{ action: string }>;
            };
            return q.history.map(h => h.action);
        });
        expect(actions).toContain('autofilled');
    });
});

test.describe('optional outcome suggestions (UT-shaped add/drop form)', () => {
    test('suggests from #message only after the student submits, and waits for confirmation', async ({
        context,
        extensionId,
    }) => {
        const page = await context.newPage();
        // enable the option the way a student does (Registration prep → checkbox), before visiting the page
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#register`);
        const toggle = page.getByRole('checkbox', { name: /Suggest outcomes from UT/ });
        await toggle.check();
        await page.reload();
        await expect(page.getByRole('checkbox', { name: /Suggest outcomes from UT/ })).toBeChecked();
        await page.goto(`chrome-extension://${extensionId}/demo.html`);
        const panel = page.locator('#fastlane-registration-assistant');
        await expect(panel.locator('.code')).toHaveText('65555');
        await panel.getByRole('button', { name: 'Copy 65555' }).click();
        await page.locator('#s_unique_add').fill('65555');
        await page.locator('#simFull').click(); // UT shows "filled to closing limit"
        await expect(panel.getByText('appears to say')).toBeVisible();
        await expect(panel.locator('.code')).toHaveText('65555'); // nothing recorded yet
        await panel.getByRole('button', { name: 'Mark Full' }).click();
        await expect(panel.locator('.code')).toHaveText('65705');
    });
});

test.describe('network activity matches the privacy policy', () => {
    test('extension pages contact no third-party hosts', async ({ context, extensionId }) => {
        const hosts = new Set<string>();
        context.on('request', r => {
            const u = new URL(r.url());
            if (!['chrome-extension:', 'data:', 'blob:'].includes(u.protocol)) hosts.add(u.hostname);
        });
        const page = await context.newPage();
        await openDemo(page, extensionId);
        await rowFor(page, '23095').getByRole('button', { name: 'Open historical grade distribution graph' }).click();
        for (const tab of ['plan', 'recommend', 'audit', 'register', 'map', 'wallpaper', 'settings']) {
            await page.goto(`chrome-extension://${extensionId}/fastlane.html#${tab}`);
            await page.waitForTimeout(400);
        }
        for (const p of ['calendar.html', 'map.html', 'src/pages/popup/index.html']) {
            await page.goto(`chrome-extension://${extensionId}/${p}`);
            await page.waitForTimeout(800);
        }
        // Disclosed in the privacy policy: UTRP's Settings page lists contributors from GitHub's public API, and
        // the calendar's Quick Add loads UT's public semester index page (no student data is sent).
        await page.goto(`chrome-extension://${extensionId}/options.html`);
        await page.waitForTimeout(1500);
        const disclosed = new Set(['api.github.com', 'registrar.utexas.edu']);
        const unexpected = [...hosts].filter(h => !disclosed.has(h));
        expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
    });
});

test.describe('degree audit, recommendations, reminders and simple navigation', () => {
    test('imports an IDA HTML file locally and shows review items', async ({ context, extensionId }) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
        await page
            .locator('input[type=file]')
            .setInputFiles(resolve(process.cwd(), 'src/fastlane/__tests__/fixtures/dap-audit-results-real.html'));
        await expect(page.getByText('requirements complete', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /Needs review/ })).toBeVisible();
        await page.getByRole('button', { name: /^All \(/ }).click();
        await expect(page.getByText('CORE (090)').first()).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/4-degree-audit-review.png`, fullPage: false });
        await page.reload();
        await expect(page.getByText('requirements complete', { exact: true })).toBeVisible(); // persisted
    });

    test('recommends only cached, requirement-matching sections with honest availability', async ({
        context,
        extensionId,
    }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);
        await page.waitForTimeout(2500); // listing is cached in the background (debounced)
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#recommend?req=CORE%20050`);
        const recs = page.locator('.rec');
        await expect(recs.first()).toBeVisible();
        const text = await page.locator('main').innerText();
        expect(text).not.toContain('GOV 310L');
        expect(text).toMatch(/Open as of|Check availability|Closed as of/);
        expect(text).toContain('Satisfies Core 050');
        await expect(page.getByRole('button', { name: 'Add to my schedule' }).first()).toBeVisible();
        await page.getByRole('button', { name: 'Add to my schedule' }).first().click();
        await expect(page.getByRole('status')).toContainText('Added');
        await page.screenshot({ path: `${SHOTS}/5-recommendations.png`, fullPage: false });
    });

    test('reminders create chrome.alarms and can be cleared', async ({ context, extensionId, sw }) => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#register`);
        await expect(page.getByRole('heading', { name: 'Registration reminders' })).toBeVisible(); // stores initialized
        const future = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        await page.evaluate(async date => {
            const key = 'FastlaneReminders:reminders';
            const cur = (await chrome.storage.local.get(key))[key] as Record<string, unknown>;
            await chrome.storage.local.set({
                [key]: { ...cur, enabled: true, window: { date, time: '08:00', timeZone: 'America/Chicago' } },
            });
        }, future);
        await expect
            .poll(
                async () =>
                    (await sw.evaluate(async () => (await chrome.alarms.getAll()).map(a => a.name))).filter(n =>
                        n.startsWith('fastlane-reminder:')
                    ).length
            )
            .toBeGreaterThanOrEqual(4);
        await page.screenshot({ path: `${SHOTS}/6-registration-prep-reminders.png`, fullPage: false });
    });

    test('planner shows four primary pages without map, wallpaper or history clutter', async ({
        context,
        extensionId,
    }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#home`);
        const nav = page.getByRole('navigation', { name: 'Sections' });
        await expect(nav.getByRole('button')).toHaveCount(4);
        for (const label of ['Overview', 'Find classes', 'My schedule', 'Degree progress']) {
            await expect(nav.getByRole('button', { name: label })).toBeVisible();
        }
        await expect(nav.getByText('Campus map')).toHaveCount(0);
        await expect(nav.getByText('Phone wallpaper')).toHaveCount(0);
        await expect(nav.getByText('History & undo')).toHaveCount(0);

        await nav.getByRole('button', { name: 'Find classes' }).click();
        await page.getByRole('button', { name: 'Browse all classes' }).click();
        await expect(page.getByRole('combobox', { name: 'Subject' })).toBeVisible();
        await expect(page.getByRole('group', { name: 'Allowed class days' })).toBeVisible();
        await expect(page.getByRole('combobox', { name: 'Minimum historical A minus percentage' })).toBeVisible();

        // Old bookmarked links should lead back to a supported planner screen.
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#wallpaper`);
        await expect(page.getByRole('heading', { name: 'Plan your next semester.' })).toBeVisible();
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#map`);
        await expect(page.getByRole('heading', { name: 'Plan your next semester.' })).toBeVisible();
    });

    test('works offline: grades, conflicts, plans and cached recommendations', async ({ context, extensionId }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);
        await page.waitForTimeout(2500); // sections cached
        await context.setOffline(true);
        await page.reload();
        await expect(rowFor(page, '23095').locator('[data-fastlane="grade"]')).toContainText('%');
        await expect(rowFor(page, '20001').locator('[data-fastlane="conflict"]')).toBeVisible();
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#recommend?req=CORE%20050`);
        // (Playwright's offline emulation does not change navigator.onLine on extension pages, so the
        // offline badge is covered by manual testing; here we verify the features work without network.)
        await expect(page.locator('.rec').first()).toBeVisible();
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#plan`);
        await expect(page.locator('.counts')).toContainText('hours');
        await context.setOffline(false);
    });

    test('delete all Fastlane data removes plans, queue and audit', async ({ context, extensionId }) => {
        const page = await context.newPage();
        await openDemo(page, extensionId);
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#settings`);
        page.on('dialog', d => void d.accept());
        await page.getByRole('button', { name: 'Delete Fastlane data' }).click();
        await expect(page.getByText('Fastlane data deleted.')).toBeVisible();
        const local = await page.evaluate(async () => chrome.storage.local.get(null));
        expect(local['FastlanePlans:plans']).toEqual({});
        expect(local['FastlaneAudit:audit']).toBeNull();
        expect((local['FastlaneQueue:queue'] as { items: unknown[] }).items).toEqual([]);
        expect(Object.keys(local)).toContain('schedules'); // UTRP schedules kept unless "delete everything"
    });
});
