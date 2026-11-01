/**
 * The developer test server routes the AI to a protected Vercel preview (never production) with its own test code,
 * shows a visible TEST SERVER marker, and falls back to production for anything that is not this project's preview.
 */
import { audit, rule } from '../src/fastlane/__tests__/fixtures/spring2027-degree';
import { expect, test } from './fixtures';

const PREVIEW = 'https://longhorn-fastlane-plus-git-feat-nl-fc50bc-simpsladers-projects.vercel.app';
const PROD = 'https://longhorn-fastlane-plus.vercel.app';

test('the AI goes to the configured preview with the test code, and production is untouched', async ({
    context,
    extensionId,
}) => {
    const page = await context.newPage();
    const hits: Array<{ host: string; code: string; credentials: boolean }> = [];
    const cors = {
        'Access-Control-Allow-Origin': `chrome-extension://${extensionId}`,
        'Access-Control-Allow-Credentials': 'true',
    };
    for (const host of [PREVIEW, PROD])
        await page.route(`${host}/api/agent`, async route => {
            const body = route.request().postDataJSON() as { accessCode: string };
            hits.push({ host, code: body.accessCode, credentials: true });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: cors,
                body: JSON.stringify({ type: 'answer', text: 'Hello from the test server.' }),
            });
        });
    // cached UT sections (the chat needs a course list) via the offline demo
    await page.goto(`chrome-extension://${extensionId}/demo.html`);
    await page.getByRole('button', { name: 'Create demo schedule' }).click();
    await expect(page.locator('#setupStatus')).toContainText('Created');
    await page.waitForTimeout(2500);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#settings`);
    const localBuild = await page.evaluate(() => !!chrome.runtime.getManifest().optional_host_permissions?.length);
    if (!localBuild) {
        // a store/packaged build: no developer card, no extra permission — the AI can only be production
        await expect(page.getByRole('heading', { name: 'Developer: AI test server' })).toHaveCount(0);
        return;
    }
    await expect(page.getByRole('heading', { name: 'Developer: AI test server' })).toBeVisible();
    await expect(page.getByText('Currently using: production')).toBeVisible();

    // a host that is not this project's preview is refused outright
    await page.getByLabel(/Preview URL/).fill('https://evil.example.com');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText(/Only this project’s own Vercel preview URLs/)).toBeVisible();

    // configure the preview directly (the Chrome permission prompt cannot be clicked in automation)
    await page.evaluate(
        async ([base]) =>
            chrome.storage.local.set({ 'FastlaneDevServer:base': base, 'FastlaneDevServer:code': 'dev-test-code-123' }),
        [PREVIEW]
    );
    // the chat needs an imported IDA
    const a = audit([rule('CORE 050')]);
    a.parsedAt = Date.now();
    await page.evaluate(async data => chrome.storage.local.set({ 'FastlaneAudit:audit': data }), a);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    await page.reload();
    await expect(page.getByText(/TEST SERVER: longhorn-fastlane-plus-git-feat/)).toBeVisible();
    await page.getByPlaceholder('Enter once to enable AI').fill('my-production-code');
    await page.getByRole('checkbox', { name: /I agree to send/ }).check();
    await page
        .getByRole('textbox', { name: 'Ask Fastlane for class recommendations' })
        .fill('Is it worth taking summer classes?');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('log', { name: 'Planning conversation' }).locator('.bubble.bot').last()).toContainText(
        'Hello from the test server.'
    );
    expect(hits).toEqual([{ host: PREVIEW, code: 'dev-test-code-123', credentials: true }]);

    // back to production: the saved production code is used and the marker disappears
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#settings`);
    await page.getByRole('button', { name: 'Use production' }).click();
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    await expect(page.getByText(/TEST SERVER/)).toHaveCount(0);
});
