import { resolve } from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from './fixtures';

const AI = 'https://longhorn-fastlane-plus.vercel.app/api/recommend';
const ADVISE = 'https://longhorn-fastlane-plus.vercel.app/api/advise';

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
    // clicking a class opens the course popup, like My schedule; its actions stay below the calendar
    await expect(page.getByRole('dialog').getByRole('button', { name: 'RateMyProf' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'RateMyProf' })).toBeHidden();
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
    // clicking a class opens the course popup, like My schedule; its actions stay below the calendar
    await expect(page.getByRole('dialog').getByRole('button', { name: 'RateMyProf' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'RateMyProf' })).toBeHidden();
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

    // a Backups column sits beside the week: ranked backups for each class, plus general backups
    const backups = proposal.getByRole('complementary', { name: 'Backups' });
    await expect(backups).toBeVisible();
    const firstClass = (
        await proposal
            .locator('.week-block b, .course-pill')
            .evaluateAll(els => [...new Set(els.map(e => (e.textContent ?? '').split(' – ')[0]!.trim()))])
    )[0]!;
    const group = backups.getByRole('region', { name: `Backups for ${firstClass}` });
    await expect(group).toBeVisible();
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/backups.png' });
    const swap = group.getByRole('button', { name: /^Swap in / });
    if ((await swap.count()) > 0) {
        const label = (await swap.first().getAttribute('aria-label')) ?? '';
        const swappedIn = label.replace(/^Swap in /, '').replace(/ \(\d+\)$/, '');
        await swap.first().click();
        await expect(
            proposal.locator('.week-block b, .course-pill').filter({ hasText: swappedIn }).first()
        ).toBeVisible();
        await expect(proposal.locator('.week-block b, .course-pill').filter({ hasText: firstClass })).toHaveCount(0);
        await proposal.getByRole('button', { name: 'Undo' }).click();
    }

    // "add a <subject>" adds a listed section of that subject that fits
    const general = backups.getByRole('region', { name: 'General backups' }).getByRole('button', { name: /^Add / });
    if ((await general.count()) > 0) {
        const label = (await general.first().getAttribute('aria-label')) ?? '';
        const subject = label.replace(/^Add /, '').replace(/ \d.*$/, '');
        const before = await proposal.locator('.week-block b, .course-pill').filter({ hasText: subject }).count();
        await box.fill(`add another ${subject}`);
        await send.click();
        await expect(log.locator('.bubble.bot').last()).toContainText(/added|couldn’t find/i);
        await expect
            .poll(() => proposal.locator('.week-block b, .course-pill').filter({ hasText: subject }).count())
            .toBeGreaterThan(before);
    }

    // leaving Find classes and coming back keeps the chat and the schedule
    const turns = await log.locator('.bubble.me').count();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'My schedule' }).click();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Find classes' }).click();
    await expect(log.locator('.bubble.me')).toHaveCount(turns);
    await expect(proposal).toBeVisible();
    await page.reload();
    await expect(log.locator('.bubble.me')).toHaveCount(turns);
    await expect(proposal).toBeVisible();

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

test('the chat fills the page, remembers preferences and answers graduate-early questions', async ({
    context,
    extensionId,
}) => {
    const page = await demoWithAudit(context, extensionId);
    const advised: Array<Record<string, unknown>> = [];
    await page.route(ADVISE, async route => {
        advised.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': `chrome-extension://${extensionId}` },
            body: JSON.stringify({ answer: 'At 15 UT hours a semester plus 6 hours at ACC, you could finish sooner.' }),
        });
    });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    const chat = page.locator('.fl-chat');
    await expect(chat).toBeVisible();
    // like a chat app: the chat fills the space beside the sidebar
    const box = await chat.boundingBox();
    const viewport = page.viewportSize()!;
    const side = await page.locator('aside.side').boundingBox();
    expect(box!.height).toBeGreaterThan(viewport.height * 0.9);
    expect(box!.x + box!.width).toBeGreaterThan(viewport.width - 40);
    expect(box!.x).toBeLessThan(side!.x + side!.width + 40);

    // "remember …" works before AI setup and never calls the AI
    const input = page.getByRole('textbox', { name: 'Ask Fastlane for class recommendations' });
    const send = page.getByRole('button', { name: 'Send message' });
    for (const text of [
        'Remember that I want to graduate early',
        'remember I want to internally transfer to McCombs',
        "from now on prioritize classes that are mostly A's",
    ]) {
        await input.fill(text);
        await send.click();
    }
    const log = page.getByRole('log', { name: 'Planning conversation' });
    await expect(log).toContainText('I’ll remember: “I want to internally transfer to McCombs”');
    await page.getByRole('button', { name: 'Memory · 3' }).click();
    const memory = page.getByRole('region', { name: 'What Fastlane remembers' });
    await expect(memory.getByRole('listitem')).toHaveCount(3);
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/chat-memory.png' });
    await memory.getByRole('button', { name: /Forget “I want to graduate early”/ }).click();
    await expect(memory.getByRole('listitem')).toHaveCount(2);
    await memory.getByRole('textbox', { name: 'Something for Fastlane to remember' }).fill('I want to graduate early');
    await memory.getByRole('button', { name: 'Remember' }).click();
    await expect(memory.getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: 'Memory · 3' }).click();
    // memory is kept after a reload
    await page.reload();
    await expect(page.getByRole('button', { name: 'Memory · 3' })).toBeVisible();

    // degree questions go to the advisor with computed facts, memory and no grades
    await page.getByPlaceholder('Enter once to enable AI').fill('test-invite-code-local-only');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    await page
        .getByRole('group', { name: 'Quick replies' })
        .getByRole('button', { name: 'Plan my path to graduate early' })
        .click();
    await expect.poll(() => advised.length).toBe(1);
    const sent = advised[0] as {
        question: string;
        memory: string[];
        facts: { hoursRemaining: number | null; scenarios: unknown[]; mccombs: { source: string } | null };
    };
    expect(sent.question).toBe('Plan my path to graduate early');
    expect(sent.memory).toContain('I want to internally transfer to McCombs');
    expect(sent.facts.mccombs?.source).toBe('https://my.mccombs.utexas.edu/bba/internal-transfer/');
    expect(JSON.stringify(sent)).not.toMatch(/"grade"|"gpa"/i);
    await expect(log.locator('.bubble.bot').last()).toContainText('At 15 UT hours a semester');
    // nothing about the schedule changed
    await expect(page.getByRole('region', { name: 'Proposed schedule' })).toHaveCount(0);
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/chat-advisor.png' });
    // "forget everything" clears memory
    await input.fill('forget everything');
    await send.click();
    await expect(page.getByRole('button', { name: 'Memory', exact: true })).toBeVisible();
});

test('questions about your records are answered from the IDA, accurately and without AI', async ({
    context,
    extensionId,
}) => {
    const page = await demoWithAudit(context, extensionId);
    const aiCalls: string[] = [];
    await page.route('https://longhorn-fastlane-plus.vercel.app/api/**', async route => {
        aiCalls.push(route.request().url());
        const url = route.request().url();
        if (url.endsWith('/chat'))
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'Access-Control-Allow-Origin': `chrome-extension://${extensionId}` },
                body: JSON.stringify({
                    answer: 'UGS courses are **signature courses** for first-years.',
                    meta: {
                        provider: 'groq',
                        model: 'groq:openai/gpt-oss-20b',
                        cached: false,
                        fallback: false,
                        latencyMs: 400,
                    },
                }),
            });
        if (url.endsWith('/ai-status'))
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: { 'Access-Control-Allow-Origin': `chrome-extension://${extensionId}` },
                body: JSON.stringify({
                    strictFreeTier: true,
                    storage: 'memory',
                    providers: {
                        groq: { configured: true, eligible: true, reason: '' },
                        gemini: {
                            configured: true,
                            eligible: false,
                            reason: 'Strict free mode: set GEMINI_BILLING=off …',
                        },
                        cloudflare: {
                            configured: false,
                            eligible: false,
                            reason: 'Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in Vercel.',
                        },
                        openai: { configured: false, eligible: false, reason: 'Not available' },
                    },
                    models: [
                        {
                            id: 'groq:openai/gpt-oss-20b',
                            provider: 'groq',
                            label: 'GPT-OSS 20B (Groq)',
                            tier: 'fast',
                            maxLevel: 3,
                            limits: { rpd: 1000 },
                            today: { requests: 3, tokens: 900, neurons: 0 },
                            stats: { ok: 3, latencyMs: 800, lastOk: Date.now() },
                            cooldownUntil: 0,
                            cooldownReason: '',
                            trainsOnFreeTier: false,
                        },
                    ],
                    decisions: [
                        {
                            at: Date.now(),
                            task: 'chat',
                            level: 2,
                            model: 'groq:openai/gpt-oss-20b',
                            ok: true,
                            reason: 'best score',
                        },
                    ],
                    totals: { requests: 3, fallbacks: 1 },
                    openai: { enabled: false, reason: 'Not available: documented for apps that run locally.' },
                }),
            });
        return route.abort();
    });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    const input = page.getByRole('textbox', { name: 'Ask Fastlane for class recommendations' });
    const send = page.getByRole('button', { name: 'Send message' });
    const log = page.getByRole('log', { name: 'Planning conversation' });
    const last = () => log.locator('.bubble.bot').last();

    // a typo-filled question, before any AI setup, gets the exact numbers: completed never includes in-progress
    await input.fill('hyow many jours do i have compleeted?');
    await send.click();
    await expect(last()).toContainText("You've completed 64 credit hours so far");
    await expect(last()).toContainText('another 12');
    await expect(last()).toContainText('76 credit hours');
    await expect(last()).not.toContainText('ACC');
    await expect(page.getByRole('region', { name: 'Proposed schedule' })).toHaveCount(0);
    await expect(last().locator('strong').first()).toHaveText('64 credit hours');

    await input.fill('What classes am I taking this semester?');
    await send.click();
    await expect(last().locator('li')).toHaveCount(4);
    await input.fill("What's my GPA?");
    await send.click();
    await expect(last()).not.toContainText('schedule');

    // a correction is acknowledged and kept beside the IDA, not over it
    await input.fill("That's wrong. I've completed 9 credits, not 64.");
    await send.click();
    await expect(last()).toContainText("noted that you've completed 9 credit hours");
    await expect(last()).toContainText('IDA shows 64');
    expect(aiCalls).toEqual([]);
    await page.locator('.fl-chat').screenshot({ path: 'test-results/redesign/chat-local-answers.png' });

    // general questions go to the chat endpoint and render as Markdown
    await page.getByPlaceholder('Enter once to enable AI').fill('test-invite-code-local-only');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    await input.fill('hi! what can you do?');
    await send.click();
    await expect(last().locator('strong')).toHaveText('signature courses');
    expect(aiCalls.some(u => u.endsWith('/chat'))).toBe(true);

    // Settings shows the AI dashboard: providers, why one is off, OpenAI unavailable, router settings
    await page.getByRole('button', { name: 'Settings & privacy' }).click();
    const groq = page.getByRole('region', { name: 'Groq' });
    await expect(groq).toContainText('Connected');
    await expect(groq).toContainText('Today 3 / 1000 requests');
    await expect(page.getByRole('region', { name: 'Google Gemini' })).toContainText('GEMINI_BILLING=off');
    await expect(page.getByRole('region', { name: 'OpenAI (Sign in with ChatGPT)' })).toContainText('Unavailable');
    await page.getByRole('combobox', { name: 'How Fastlane chooses a model' }).selectOption('preserve');
    await groq.getByRole('checkbox', { name: 'Use Groq' }).uncheck();
    await page.locator('.ai-dashboard').screenshot({ path: 'test-results/redesign/ai-dashboard.png' });
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
