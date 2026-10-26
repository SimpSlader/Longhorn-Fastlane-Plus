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
    // one simple chat window: no rule panels or filter forms around it
    await expect(page.getByRole('list', { name: 'What Fastlane understood' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'What Fastlane will follow' })).toHaveCount(0);

    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toBeDisabled();
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/chat-start.png' });
    await page.getByPlaceholder('Enter once to enable AI').fill('test-invite-code-local-only');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    await send.click();
    // the reply is a conversation: it explains the result and offers one-click fixes
    const log = page.getByRole('log', { name: 'Planning conversation' });
    await expect(log.locator('.bubble.me')).toContainText('Macro through ACC');
    await expect(log).toContainText("couldn't build a complete schedule");
    const chips = page.getByRole('group', { name: 'Quick replies' });
    await expect(chips.getByRole('button', { name: 'Allow classes on Wednesday' })).toBeVisible();
    const first = sent[0] as {
        planningRequest: string;
        completed: string[];
        candidates: Array<{ days: string[] }>;
        preferences: { avoidDays: string[]; plannedElsewhere: Array<{ code: string }>; asyncCount: unknown };
    };
    expect(first.planningRequest).toContain('Macro through ACC');
    expect(first.preferences.avoidDays.sort()).toEqual(['F', 'M', 'W']);
    expect(first.preferences.plannedElsewhere.map(p => p.code)).toEqual(['ECO 304L']);
    expect(first.preferences.asyncCount).toEqual({ min: 1, max: 2 });
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

    // the demo catalog cannot reach 12 credits without Monday/Wednesday/Friday: Fastlane explains instead of
    // presenting a short schedule
    const proposal = page.getByRole('region', { name: 'Proposed schedule' });
    await expect(log).toContainText('short of 12');
    await expect(proposal).toHaveCount(0);

    // a follow-up lifts the day limit and keeps the earlier preferences (ACC plan, online count)
    await box.fill('Actually Mondays, Wednesdays and Fridays are fine.');
    await box.press('Enter');
    await expect.poll(() => sent.length).toBe(2);
    const second = sent[1] as { chatHistory: Array<{ request: string }>; preferences: { avoidDays: string[] } };
    expect(second.chatHistory[0]?.request).toContain('Macro through ACC');
    expect(second.preferences.avoidDays).toEqual([]);

    // now a complete schedule appears inside the chat, checked against every rule
    await expect(proposal).toBeVisible();
    await expect(log.locator('.fl-plan')).toHaveCount(1);
    await expect(proposal).toContainText('All rules met');
    // the reply lists exactly the classes on the calendar
    await expect(log).toContainText(/Here's a \d+-credit plan/);
    const calendarClasses = await proposal
        .locator('.week-block b, .course-pill')
        .evaluateAll(els => [...new Set(els.map(e => (e.textContent ?? '').split(' – ')[0]!.trim()))].sort());
    const reply = (await log.locator('.bubble.bot').last().textContent()) ?? '';
    const listed = [...reply.matchAll(/• ([A-Z][A-Z ]*\d{3}[A-Z]?) —/g)].map(m => m[1]!).sort();
    expect(listed).toEqual(calendarClasses);
    await expect(proposal.getByRole('region', { name: 'Proposed weekly calendar' })).toBeVisible();
    await expect(proposal.getByRole('button', { name: 'Undo' })).toBeDisabled();
    const blocks = proposal.locator('.week-block, .course-pill');
    const planned = await blocks.count();
    expect(planned).toBeGreaterThan(0);
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/proposal.png' });
    await page.getByRole('combobox', { name: 'Appearance theme' }).selectOption('dark');
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/proposal-dark.png' });
    await page.getByRole('combobox', { name: 'Appearance theme' }).selectOption('light');

    // clicking a class shows a real UT section; removing it makes a new version and Undo restores it
    await blocks.first().click();
    const detail = proposal.locator('.proposal-detail');
    await expect(detail.locator('.class-code')).toHaveText(/^[A-Z ]+ \d{3}[A-Z]? · \d{5}$/);
    await expect(detail.locator('.class-grade')).toContainText(/% *A or A−|No grade data/);
    await expect(detail.getByRole('button', { name: 'Grade distribution' })).toBeVisible();
    await expect(detail).toContainText(/Counts toward|Elective/);
    await detail.getByRole('button', { name: 'Remove' }).click();
    await expect(proposal.getByRole('button', { name: 'Undo' })).toBeEnabled();
    // dropping below 12 credits is flagged, saving is blocked, and a refill is offered
    await expect(proposal).toContainText(/Needs \d+ more credits/);
    await expect(proposal.getByRole('alert')).toContainText('below the 12-credit minimum');
    await expect(proposal.getByRole('button', { name: /Fill to 12\+ credits/ })).toBeVisible();
    await expect(proposal.getByRole('button', { name: 'Save as a new schedule' })).toBeDisabled();
    await proposal.getByRole('button', { name: 'Undo' }).click();
    await expect(proposal.getByRole('button', { name: 'Redo' })).toBeEnabled();
    await expect(proposal).toContainText('All rules met');

    // "Ask AI to replace" sends that class as context and keeps every other proposed class
    const kept = await proposal.locator('.week-block b, .course-pill').allTextContents();
    await blocks.first().click();
    const targetCode = ((await detail.locator('.class-code').textContent()) ?? '').split('·')[0]!.trim();
    await detail.getByRole('button', { name: 'Ask AI to replace' }).click();
    await expect(page.locator('.focus-chip')).toContainText(`Replacing ${targetCode}`);
    await box.fill('Keep everything else, but replace this one course');
    await send.click();
    await expect.poll(() => sent.length).toBe(3);
    const replace = sent[2] as { planningRequest: string; candidates: Array<{ code: string }> };
    expect(replace.planningRequest).toContain(`Replace only ${targetCode}`);
    // a replacement never brings back another section of a class that is kept
    const keptCodes = new Set(kept.map(t => t.split(' – ')[0]!.trim()).filter(c => c !== targetCode));
    expect(replace.candidates.every(c => !keptCodes.has(c.code))).toBe(true);
    await expect(page.locator('.focus-chip')).toBeHidden();
    await expect(log.locator('.bubble.bot').last()).toBeVisible();

    // "remove <class>" in the chat takes it out, keeps it out, and refills the week within the rules
    const now = await proposal
        .locator('.week-block b, .course-pill')
        .evaluateAll(els => [...new Set(els.map(e => (e.textContent ?? '').split(' – ')[0]!.trim()))]);
    const gone = now[0]!;
    await box.fill(`remove ${gone}`);
    await send.click();
    await expect(log.locator('.bubble.me').last()).toHaveText(`remove ${gone}`);
    await expect(log.locator('.bubble.bot').last()).toContainText(`took out ${gone}`);
    await expect(proposal.locator('.week-block b, .course-pill').filter({ hasText: gone })).toHaveCount(0);
    expect(sent.length).toBe(3); // removing needs no AI call
    // and it stays out of the next request
    await box.fill('make it easier');
    await send.click();
    await expect.poll(() => sent.length).toBe(4);
    const later = sent[3] as { preferences: { excludedCourses: string[] }; candidates: Array<{ code: string }> };
    expect(later.preferences.excludedCourses).toContain(gone);
    expect(later.candidates.every(c => c.code !== gone)).toBe(true);

    // saving the proposal creates one new schedule and leaves the others untouched
    const before = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
    await expect(proposal).toBeVisible();
    const save = proposal.getByRole('button', { name: 'Save as a new schedule' });
    if (await save.isEnabled()) {
        await save.click();
        await expect(proposal.getByRole('status')).toContainText('Your other schedules were not changed');
        const after = await sw.evaluate(async () => (await chrome.storage.local.get('schedules')).schedules);
        expect(after.length).toBe(before.length + 1);
        for (const s of before) {
            const same = after.find((a: { id: string }) => a.id === s.id);
            expect(same?.courses.length).toBe(s.courses.length);
        }
    }

    // "New chat" starts over
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(proposal).toHaveCount(0);
    await expect(log.locator('.bubble.me')).toHaveCount(0);
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
