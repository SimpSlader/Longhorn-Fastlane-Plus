import { resolve } from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from './fixtures';

const AI = 'https://longhorn-fastlane-plus.vercel.app/api/recommend';

async function demoWithAudit(context: BrowserContext, extensionId: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/demo.html`);
    await page.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(page.locator('#setupStatus')).toContainText('Created');
    await page.waitForTimeout(2500); // demo listing is cached in the background (debounced)
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    await page
        .locator('input[type=file]')
        .setInputFiles(resolve(process.cwd(), 'src/fastlane/__tests__/fixtures/dap-audit-results-real.html'));
    await expect(page.locator('.metric').filter({ hasText: 'Official IDA degree completion' })).toContainText('68%');
    return page;
}

test('theme switcher offers Light, Dark and System, applies at once and is remembered', async ({
    context,
    extensionId,
}) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#home`);
    const theme = page.getByRole('combobox', { name: 'Appearance theme' });
    await expect(theme.locator('option')).toHaveText(['System', 'Light', 'Dark']);
    // a fresh install opens in Light, and the page starts light (no dark flash before the app loads)
    await expect(theme).toHaveValue('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const raw = await page.request.get(`chrome-extension://${extensionId}/fastlane.html`).catch(() => null);
    if (raw) expect(await raw.text()).toContain('data-theme="light"');
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await theme.selectOption('light');
    const light = await background();
    await theme.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await background()).not.toBe(light);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    for (const tab of ['home', 'finder', 'plan', 'audit', 'settings']) {
        await page.goto(`chrome-extension://${extensionId}/fastlane.html#${tab}`);
        await expect(page.locator('main')).toBeVisible();
        await page.screenshot({ path: `test-results/redesign/dark-${tab}.png` });
    }
    await page.getByRole('combobox', { name: 'Appearance theme' }).selectOption('system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(errors).toEqual([]);
});

test('My schedule shows the week at once and switches between saved schedules, even an empty draft', async ({
    context,
    extensionId,
    sw,
}) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/demo.html`);
    await page.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(page.locator('#setupStatus')).toContainText('Created');
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#home`);
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'My schedule' }).click();
    await expect(page.getByRole('region', { name: 'Weekly calendar of active classes' })).toBeVisible();
    const before = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    const switcher = page.getByRole('group', { name: 'Saved schedule scenarios' });
    await expect(switcher.getByRole('button')).toHaveCount(before.length);
    await expect(page.locator('.counts')).toContainText('hours');

    // create an empty draft from the sidebar, then switch back and forth without leaving the page
    page.once('dialog', d => void d.accept('Empty draft'));
    await page.getByRole('button', { name: 'New schedule' }).click();
    await expect(switcher.getByRole('button', { name: /Empty draft/ })).toBeVisible();
    await switcher.getByRole('button', { name: /Empty draft/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Empty draft');
    await expect(page.getByRole('region', { name: 'Weekly calendar of active classes' })).toBeVisible();
    await expect(page.getByText(/No classes in this draft yet/)).toBeVisible();
    const demoName = before.find((s: { courses: unknown[] }) => s.courses.length > 0).name as string;
    await switcher.getByRole('button', { name: new RegExp(demoName.replace(/[()]/g, '\\$&')) }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(demoName);
    await expect(page.locator('.week .block, .week [class*="block"]').first()).toBeVisible();

    // every class has its own color, and clicking a block opens UTRP's course popup with grades
    const blocks = page.locator('.week .week-block');
    const colorByClass = new Map<string, string>();
    for (const b of await blocks.all()) {
        const name = ((await b.locator('b').textContent()) ?? '').trim();
        colorByClass.set(name, await b.evaluate(el => getComputedStyle(el).backgroundColor));
    }
    expect(new Set(colorByClass.values()).size).toBe(colorByClass.size);
    const pageBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await blocks.first().click();
    const popup = page.getByRole('dialog');
    await expect(popup.getByRole('button', { name: 'RateMyProf' })).toBeVisible();
    await expect(popup.getByText('Grade Distribution for')).toBeVisible();
    // wait for the fade-in to finish so the screenshot shows the settled popup
    await expect
        .poll(() =>
            popup.getByRole('button', { name: 'RateMyProf' }).evaluate(el => {
                let o = 1;
                for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
                return o;
            })
        )
        .toBe(1);
    await page.screenshot({ path: 'test-results/redesign/course-popup.png' });
    await page.keyboard.press('Escape');
    await expect(popup.getByRole('button', { name: 'RateMyProf' })).toBeHidden();
    // UTRP's styles stay inside the popup's shadow root
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(pageBg);
    await page.screenshot({ path: 'test-results/redesign/schedule-colors.png' });

    // existing schedules are untouched by browsing and switching
    const after = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    for (const s of before) {
        const same = after.find((a: { id: string }) => a.id === s.id);
        expect(same?.courses.map((c: { uniqueId: number }) => c.uniqueId)).toEqual(
            s.courses.map((c: { uniqueId: number }) => c.uniqueId)
        );
    }
});

test('AI chat understands preferences and follow-ups, shows real sections and builds a separate draft', async ({
    context,
    extensionId,
    sw,
}) => {
    const page = await demoWithAudit(context, extensionId);
    const sent: Array<Record<string, unknown>> = [];
    await page.route(AI, async route => {
        const body = route.request().postDataJSON() as {
            candidates: Array<{ id: number }>;
            [k: string]: unknown;
        };
        sent.push(body);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': `chrome-extension://${extensionId}` },
            body: JSON.stringify({
                summary: `Here are ${Math.min(3, body.candidates.length)} listed sections.`,
                recommendations: [
                    ...body.candidates.slice(0, 3).map(c => ({
                        id: c.id,
                        reason: 'Fits the requested days.',
                        requirement: 'Verify on IDA',
                        confidence: 'possible',
                        warning: '',
                    })),
                    { id: 99999, reason: 'Invented', requirement: '', confidence: 'high', warning: '' },
                ],
            }),
        });
    });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    const box = page.getByRole('textbox', { name: 'Ask Fastlane for class recommendations' });
    await expect(box).toBeVisible();
    // only the simple filters are visible; advanced browsing is collapsed
    await expect(page.getByRole('button', { name: 'Browse all classes' })).toBeHidden();
    await box.fill(
        "Find classes that count toward my degree, preferably no classes Monday, Wednesday or Friday, 1–2 asynchronous online classes, and easy professors. I'm planning to take Macro through ACC."
    );
    const understood = page.getByRole('list', { name: 'What Fastlane understood' });
    await expect(understood).toContainText('No classes on Monday, Wednesday, Friday');
    await expect(understood).toContainText('1–2 asynchronous online classes');
    await expect(understood).toContainText(
        'Leaving out ECO 304L: you plan to take it at ACC (not counted as UT credit'
    );

    await page.getByPlaceholder('Enter once to enable AI').fill('test-invite-code-local-only');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    await page.getByRole('button', { name: 'Ask Fastlane' }).click();
    await expect(page.getByRole('log', { name: 'Planning conversation' })).toContainText('listed sections');
    const first = sent[0] as {
        planningRequest: string;
        completed: string[];
        candidates: Array<{ days: string[] }>;
        preferences: { avoidDays: string[]; plannedElsewhere: Array<{ code: string }> };
    };
    expect(first.planningRequest).toContain('Macro through ACC');
    expect(first.preferences.avoidDays.sort()).toEqual(['F', 'M', 'W']);
    expect(first.preferences.plannedElsewhere.map(p => p.code)).toEqual(['ECO 304L']);
    // ACC plans are never sent as completed credit, and excluded days never appear in candidates
    const audit = await sw.evaluate(
        async () => (await chrome.storage.local.get('FastlaneAudit:audit'))['FastlaneAudit:audit']
    );
    const fromIda = new Set(
        (audit.courses as Array<{ code: string; status: string }>)
            .filter(c => c.status === 'completed' || c.status === 'in-progress')
            .map(c => c.code.replace(/\s+/g, ' ').trim())
    );
    // nothing is reported as taken unless the IDA (or the active schedule) says so; ACC plans add nothing
    const scheduleCodes = (
        await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules)
    ).flatMap((s: { courses: Array<{ department: string; number: string }> }) =>
        s.courses.map(c => `${c.department} ${c.number}`)
    );
    expect(first.completed.every(c => fromIda.has(c) || scheduleCodes.includes(c))).toBe(true);
    expect(first.candidates.every(c => !c.days.some(d => ['M', 'W', 'F'].includes(d)))).toBe(true);

    // results show real UT sections with unique number, professor, schedule, grades and degree relevance
    const cards = page.locator('.ai-result');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeLessThanOrEqual(3); // the invented ID 99999 is dropped
    await expect(cards.first().locator('.class-code')).toHaveText(/^[A-Z ]+ \d{3}[A-Z]? · \d{5}$/);
    await expect(cards.first().locator('.class-time')).not.toBeEmpty();
    await expect(cards.first().locator('.class-grade')).toContainText(/% *A or A−|No grade data/);
    await expect(cards.first().getByRole('button', { name: 'Grade distribution' })).toBeVisible();
    await page.locator('.ai-advisor').screenshot({ path: 'test-results/redesign/class-cards.png' });

    // follow-up keeps earlier preferences and adds an exclusion
    await box.fill('Actually Fridays are fine.');
    await expect(understood).toContainText('No classes on Monday, Wednesday');
    await expect(understood).not.toContainText('Friday');
    await page.getByRole('button', { name: 'Ask Fastlane' }).click();
    await expect.poll(() => sent.length).toBe(2);
    const second = sent[1] as { chatHistory: Array<{ request: string }>; preferences: { avoidDays: string[] } };
    expect(second.chatHistory[0]?.request).toContain('Macro through ACC');
    expect(second.preferences.avoidDays.sort()).toEqual(['M', 'W']);

    // add one class to the active schedule, then save the picks as a separate mock schedule
    const before = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    await cards.first().getByRole('button', { name: 'Add to my schedule' }).click();
    await expect(cards.first().getByRole('button', { name: 'Added to schedule' })).toBeVisible();
    const withAdded = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    const grown = withAdded.find(
        (s: { id: string; courses: unknown[] }) =>
            s.courses.length > (before.find((b: { id: string }) => b.id === s.id)?.courses.length ?? 0)
    ) as { courses: Array<{ colors?: { primaryColor: string } }> };
    const colorsNow = grown.courses.map(c => c.colors?.primaryColor);
    expect(colorsNow.at(-1)).toBeTruthy();
    expect(colorsNow.slice(0, -1)).not.toContain(colorsNow.at(-1));
    const draft = page.getByRole('button', { name: 'Create draft schedule' });
    if (await draft.isVisible()) {
        await draft.click();
        await expect(page.getByText(/^Created AI draft/)).toBeVisible();
        const after = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
        expect(after.length).toBe(before.length + 1);
    }
});

test('Degree progress shows simple cards built from the real IDA', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    await page
        .locator('input[type=file]')
        .setInputFiles(resolve(process.cwd(), 'src/fastlane/__tests__/fixtures/dap-audit-results-real.html'));
    const overall = page.getByRole('region', { name: 'Official IDA degree completion' });
    await expect(overall).toContainText('68%');
    await expect(overall).toContainText('82 of 120 degree hours · 38 remaining');
    const card = (title: string) => page.locator('details.progress-card').filter({ hasText: title });
    await expect(card('Core Curriculum')).toContainText('27 / 42 credit hours completed');
    await expect(card('Core Curriculum')).toContainText('15 credit hours remaining');
    await expect(card('Major Requirements')).toContainText('6 / 9 requirements complete');
    await expect(card('Major Requirements')).toContainText('hours need verification');
    await expect(card('GPA, residency and total hours')).toContainText('3.78');
    await expect(card('GPA, residency and total hours')).toContainText('60/60');
    await expect(page.locator('details.progress-card').filter({ hasText: 'Minor Requirements' })).toHaveCount(0);
    // collapsed by default; expanding lists the requirements by state
    await expect(card('Core Curriculum')).not.toHaveAttribute('open', /.*/);
    await card('Core Curriculum').locator('summary').click();
    await expect(card('Core Curriculum').getByRole('heading', { name: /Remaining/ })).toBeVisible();
    await expect(card('Core Curriculum').getByRole('heading', { name: /In progress/ })).toBeVisible();
    await expect(card('Core Curriculum').getByRole('heading', { name: /Completed/ })).toBeVisible();
    await expect(card('Core Curriculum')).toContainText('CORE (050)');
    await page.screenshot({ path: 'test-results/redesign/degree-progress-light.png', fullPage: true });
    await page.getByRole('combobox', { name: 'Appearance theme' }).selectOption('dark');
    await page.screenshot({ path: 'test-results/redesign/degree-progress-dark.png', fullPage: true });
});
