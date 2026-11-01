/**
 * Whole-experience browser test: a student imports their IDA, asks for a schedule in plain language, changes it
 * through conversation, compares the GPA / convenience / degree-progress versions with one click, and copies
 * every unique number for registration.
 *
 * IMPORTANT: the AI is a scripted stand-in (it returns the tool calls a correct interpreter would). Everything
 * downstream — the real tools, solver, validator, calendar and buttons — is the real extension. This test says
 * nothing about how well a live model understands requests; scripts/fastlane/nl-benchmark.mjs measures that.
 */
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { sectionFixture } from '../src/fastlane/__tests__/factories';
import { audit, rule, section } from '../src/fastlane/__tests__/fixtures/spring2027-degree';
import { expect, test } from './fixtures';

type Row = [number, string, string, string, 'TTH' | 'async', string, string?];
// id, code, title, core, pattern, hours, instructor
const ROWS: Row[] = [
    [90101, 'UGS 302', 'ART AND THE EPIDEMIC', '090', 'TTH', '9:30 a.m.-11:00 a.m.', 'EASY, A'],
    [90102, 'UGS 303', 'DIY ASSISTIVE TECH', '090', 'TTH', '11:00 a.m.-12:30 p.m.', 'MID, M'],
    [90103, 'GOV 312L', 'ISSUES AND POLICIES', '070', 'TTH', '12:30 p.m.-2:00 p.m.', 'EASY, A'],
    [90104, 'MUS 306M', 'ELEMENTS OF MUSIC', '050', 'TTH', '2:00 p.m.-3:30 p.m.', 'EASY, A'],
    [90105, 'BIO 301D', 'ECOLOGY AND SOCIETY', '030', 'TTH', '3:30 p.m.-5:00 p.m.', 'MID, M'],
    [90106, 'NTR 306', 'FUNDAMENTALS OF NUTRITION', '030', 'async', '', 'VEASY, V'],
    [90107, 'ECO 304L', 'INTRODUCTION TO MACROECONOMICS', '', 'TTH', '11:00 a.m.-12:30 p.m.', 'HARD, H'],
    [90108, 'ECO 304L', 'INTRODUCTION TO MACROECONOMICS', '', 'TTH', '12:30 p.m.-2:00 p.m.', 'EASY, A'],
    [90109, 'SED 303', 'EXPLORING LEARNING', '', 'async', '', 'VEASY, V'],
    [90110, 'KIN 302', 'PHYSICAL ACTIVITY AND WELLNESS', '', 'TTH', '9:30 a.m.-11:00 a.m.', 'EASY, A'],
];

async function seed(page: Page) {
    const now = Date.now();
    const a = audit([rule('CORE 090'), rule('CORE 070'), rule('CORE 050'), rule('CORE 030', 6)]);
    a.parsedAt = now;
    a.program = 'Synthetic journey degree';
    const rows = ROWS.map(([id, code, title, core, pattern, hours, who]) => {
        const base = sectionFixture(id, code, {
            title,
            times: pattern === 'async' ? [] : [['TTH', hours, 'GDC 1.304']],
            core: core ? [core] : [],
            instructors: [who ?? 'MID, M'],
        });
        const [dept, num] = [code.split(' ').slice(0, -1).join(' '), code.split(' ').at(-1)!];
        return {
            ...section(id, code, base),
            capturedAt: now,
            status: { value: 'OPEN', observedAt: now - 3_600_000, source: 'UT course schedule page you viewed' },
            course: {
                uniqueId: id,
                department: dept,
                number: num,
                courseName: title,
                fullName: `${code} ${title}`,
                creditHours: 3,
                instructors: [],
                semester: { season: 'Spring', year: 2027, code: '20272' },
                schedule: { meetings: [] },
                flags: [],
                isReserved: false,
            },
        };
    });
    await page.evaluate(
        async data => {
            await chrome.storage.local.set({ 'FastlaneAudit:audit': data.audit });
            await new Promise<void>((done, fail) => {
                const open = indexedDB.open('fastlane');
                open.onerror = () => fail(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction('sections', 'readwrite');
                    for (const r of data.rows)
                        tx.objectStore('sections').put({
                            ...r,
                            prerequisites: '',
                            key: `20272:${r.uniqueId}`,
                            semesterLabel: 'Spring 2027',
                        });
                    tx.oncomplete = () => {
                        db.close();
                        done();
                    };
                    tx.onerror = () => fail(tx.error);
                };
            });
        },
        { audit: a, rows }
    );
}

async function startWithIda(context: BrowserContext, extensionId: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/demo.html`);
    await page.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(page.locator('#setupStatus')).toContainText('Created');
    await page.waitForTimeout(2500);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    // the student uploads their real IDA file...
    await page
        .locator('input[type=file]')
        .setInputFiles(resolve(process.cwd(), 'src/fastlane/__tests__/fixtures/dap-audit-results-real.html'));
    await expect(page.locator('.metric').filter({ hasText: 'Official IDA degree completion' })).toContainText('68%');
    // ...and the test then swaps in a synthetic audit + Spring 2027 catalog with known unmet core areas
    await seed(page);
    return page;
}

test('student journey: IDA → natural request → conversational changes → compare versions → copy all', async ({
    context,
    extensionId,
    sw,
}) => {
    test.setTimeout(240_000);
    const page = await startWithIda(context, extensionId);
    const schedulesBefore = await sw.evaluate(async () =>
        JSON.stringify((await chrome.storage.local.get('schedules')).schedules)
    );
    const cors = { 'Access-Control-Allow-Origin': `chrome-extension://${extensionId}` };
    const scripted: Array<[RegExp, string, Record<string, unknown>]> = [
        [
            /15 credits/i,
            'build_schedule',
            {
                minCredits: 15,
                maxCredits: 15,
                onlyDays: ['T', 'TH'],
                onlineMax: 2,
                backToBack: true,
                allowElectives: true,
                objective: 'gpa',
            },
        ],
        [/start later/i, 'modify_schedule', { dayWindows: { T: { from: '11:00 am' } } }],
        [/24 hours/i, 'modify_schedule', { changeCredits: { min: 24, max: 24 } }],
    ];
    await page.route('https://longhorn-fastlane-plus.vercel.app/api/agent', async route => {
        const body = route.request().postDataJSON() as { messages: Array<{ role: string; content: string }> };
        const reply = (payload: unknown) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: cors,
                body: JSON.stringify(payload),
            });
        if (body.messages.at(-1)!.role === 'tool') return reply({ type: 'answer', text: 'Done. All rules met.' });
        const ask = body.messages.filter(m => m.role === 'user').at(-1)!.content;
        const hit = scripted.find(([re]) => re.test(ask));
        return hit
            ? reply({ type: 'tool_calls', calls: [{ id: 'c1', name: hit[1], arguments: hit[2] }] })
            : reply({ type: 'answer', text: 'Okay.' });
    });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    // capture what the Copy button writes (no real clipboard needed)
    await page.evaluate(() => {
        const w = window as unknown as { __copied: string[] };
        w.__copied = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (t: string) => void w.__copied.push(t) },
        });
    });
    await page.getByPlaceholder('Enter once to enable AI').fill('test-invite-code-local-only');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    const input = page.getByRole('textbox', { name: 'Ask Fastlane for class recommendations' });
    const send = page.getByRole('button', { name: 'Send message' });
    const log = page.getByRole('log', { name: 'Planning conversation' });
    const proposal = page.getByRole('region', { name: 'Proposed schedule' });
    const classes = () => proposal.locator('.week-block b').allTextContents();
    const copied = () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1) ?? '');

    // 1. a natural request builds a real, validated weekly calendar
    await input.fill(
        'I want 15 credits, only Tuesdays and Thursdays, two online at most, back to back, and easy electives.'
    );
    await send.click();
    await expect(proposal).toBeVisible({ timeout: 60_000 });
    const answer = log.locator('.bubble.bot').last();
    await expect(answer).toContainText('What I understood');
    await expect(answer).toContainText(/schedule — 15 credit hours/);
    // grades, GPA outlook and RMP sit side by side for every class; nothing is invented or malformed
    const table = answer.locator('table');
    await expect(table.locator('th')).toContainText(['Past A/A− rate', 'GPA outlook', 'Rate My Professors', 'Seats']);
    expect(await table.innerText()).not.toMatch(/undefined|NaN|null/);
    await expect(table.locator('tbody tr')).toHaveCount(5);
    const first = await classes();
    expect(first.length).toBeGreaterThanOrEqual(4);
    // hard rules pass; "All rules met" additionally needs verified audit evidence, which a synthetic audit lacks
    await expect(proposal.locator('.fl-pill')).toHaveText(/All rules met|Rules pass · \d+ unverified/);
    await page.screenshot({ path: 'reports/screenshots/journey-1-built.png' });

    // 2. Copy all: every unique number on the calendar, once
    const copyAll = proposal.getByRole('button', { name: 'Copy all unique numbers' });
    await expect(copyAll).toBeEnabled();
    await copyAll.click();
    const text = await copied();
    const numbers = [...text.matchAll(/^(\d{5})\s/gm)].map(m => m[1]!);
    expect(numbers.length).toBe(5); // 15 credit hours of 3-credit classes (online ones have no calendar block)
    for (const label of new Set(first)) expect(text).toContain(label.split(' – ')[0]!.trim());
    expect(new Set(numbers).size).toBe(numbers.length);
    // no invented sections: every number is a section the extension actually has cached
    const cached = await page.evaluate(
        () =>
            new Promise<string[]>((done, fail) => {
                const open = indexedDB.open('fastlane');
                open.onerror = () => fail(open.error);
                open.onsuccess = () => {
                    const all = open.result.transaction('sections').objectStore('sections').getAll();
                    all.onsuccess = () =>
                        done(all.result.map((r: { uniqueId: number }) => String(r.uniqueId).padStart(5, '0')));
                };
            })
    );
    for (const n of numbers) expect(cached).toContain(n);
    expect(text).toMatch(/seats? not checked|as last seen \d{4}-\d{2}-\d{2}/);

    // 3. compare the versions with one click (each was validated; switching is not a chat turn)
    const versions = proposal.getByRole('group', { name: 'Optimize for' });
    {
        await expect(versions).toBeVisible();
        const buttons = versions.getByRole('button');
        const n = await buttons.count();
        const seen = new Set<string>();
        for (let i = 0; i < n; i++) {
            await buttons.nth(i).click();
            await expect(buttons.nth(i)).toHaveAttribute('aria-pressed', 'true');
            seen.add((await classes()).sort().join('|'));
            await page.screenshot({ path: `reports/screenshots/journey-version-${i}.png` });
        }
        expect(seen.size).toBeGreaterThan(1);
        await buttons.nth(0).click();
        // switching never created a chat turn
        await expect(log.locator('.bubble.me')).toHaveCount(1);
    }

    // 4. a conversational change updates the calendar at once and keeps earlier rules
    await input.fill('Actually, make my Tuesdays start later.');
    await send.click();
    await expect(log.locator('.bubble.bot')).toHaveCount(3, { timeout: 60_000 });
    await expect(log.locator('.bubble.bot').last()).toContainText(/What I understood|couldn’t|could not/i);
    const understood = await log.locator('.bubble.bot').last().innerText();
    if (/What I understood/.test(understood)) expect(understood).toMatch(/15–15 credit hours/);

    // 5. an impossible follow-up never pretends: no "All rules met", no registration copy for a draft
    await input.fill('Make it 24 hours please.');
    await send.click();
    await expect(log.locator('.bubble.bot')).toHaveCount(4, { timeout: 60_000 });
    const last = log.locator('.bubble.bot').last();
    await expect(last).not.toContainText('Done. All rules met.');
    await expect(last).toContainText(/couldn’t|does NOT follow|Rules NOT met|NOT/i);
    await page.screenshot({ path: 'reports/screenshots/journey-5-impossible.png' });

    // nothing was saved to the student's real schedules at any point
    expect(await sw.evaluate(async () => JSON.stringify((await chrome.storage.local.get('schedules')).schedules))).toBe(
        schedulesBefore
    );
});
