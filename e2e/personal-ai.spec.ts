import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';

const KEY = 'gsk_fixture_personal_key_not_real';
test('personal keys save privately, connect directly, work without an invite, and never enter exports', async ({
    context,
    extensionId,
    sw,
}) => {
    const page = await context.newPage();
    const providerRequests: { url: string; key?: string; body: string }[] = [];
    const sharedRequests: string[] = [];
    let rejectKey = false;
    await context.route('https://longhorn-fastlane-plus.vercel.app/**', route => {
        sharedRequests.push(route.request().url());
        return route.abort();
    });
    await context.route('https://api.groq.com/**', async route => {
        const req = route.request();
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
        };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const body = req.postData() ?? '';
        providerRequests.push({ url: req.url(), key: req.headers().authorization, body });
        if (rejectKey) return route.fulfill({ status: 401, headers, json: { error: { message: 'Invalid test key' } } });
        const request = JSON.parse(body) as { response_format?: { json_schema?: { name?: string } } };
        const answer =
            request.response_format?.json_schema?.name === 'fastlane_audit_review'
                ? JSON.stringify({ summary: 'Personal key review passed.', suggestions: [] })
                : 'OK';
        return route.fulfill({
            headers,
            json: { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
        });
    });
    // Simulate Chrome's optional-permission dialog in this disposable profile, never the user's Chrome.
    await sw.evaluate(() => {
        chrome.permissions.contains = async () => true;
    });
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#settings`);
    await page.evaluate(() => {
        chrome.permissions.request = async permissions => {
            await chrome.storage.session.set({ testProviderOrigins: permissions.origins });
            return true;
        };
    });
    const area = page.getByRole('region', { name: 'Use your own API keys', exact: true });
    await expect(area.getByRole('heading', { name: 'Use your own API keys' })).toBeVisible();
    for (const [name, url] of [
        ['Groq', 'https://console.groq.com/keys'],
        ['Google Gemini', 'https://aistudio.google.com/api-keys'],
        ['Cloudflare Workers AI', 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai'],
    ]) {
        const card = area.getByRole('region', { name: `${name} API key`, exact: true });
        await expect(card.getByRole('link', { name: `Get a ${name} API key ↗` })).toHaveAttribute('href', url!);
        await card.getByText('How to get a key', { exact: true }).click();
        await expect(card.locator('ol li').first()).toBeVisible();
    }
    const groq = area.getByRole('region', { name: 'Groq API key', exact: true });
    await groq.getByLabel('Groq API key', { exact: true }).fill(KEY);
    await expect(groq.getByLabel('Groq API key', { exact: true })).toHaveAttribute('type', 'password');
    await groq.getByRole('button', { name: 'Save & use' }).click();
    await expect(groq.getByRole('status')).toContainText('Confirm your free plan');
    await groq.getByLabel('This Groq account is on the free plan.').check();
    await groq.getByRole('button', { name: 'Save & use' }).click();
    await expect(groq.getByRole('status')).toContainText('saved on this device');
    await expect(groq.getByLabel('Groq API key', { exact: true })).toHaveValue('');
    expect(
        await page.evaluate(async () => (await chrome.storage.session.get('testProviderOrigins')).testProviderOrigins)
    ).toEqual(['https://api.groq.com/*']);
    await groq.getByRole('button', { name: 'Test connection' }).click();
    await expect(groq.getByRole('status')).toContainText('Groq is connected');
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.key).toBe(`Bearer ${KEY}`);
    expect(providerRequests[0]?.body).not.toContain(KEY);
    expect(await page.evaluate(async () => JSON.stringify(await chrome.storage.sync.get(null)))).not.toContain(KEY);
    await area.screenshot({ path: 'reports/screenshots/personal-api-keys.png' });

    await page.reload();
    await expect(groq.getByLabel('Groq API key', { exact: true })).toHaveAttribute(
        'placeholder',
        'Key saved — paste to replace'
    );
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export schedules & plans (JSON)' }).click();
    const file = await (await downloadPromise).path();
    expect(file).toBeTruthy();
    const exported = readFileSync(file!, 'utf8');
    expect(exported).not.toContain(KEY);
    expect(exported).not.toContain('FastlaneAiKeys');

    await page.goto(`chrome-extension://${extensionId}/fastlane.html#audit`);
    await page
        .locator('input[type=file]')
        .setInputFiles(resolve('src/fastlane/__tests__/fixtures/dap-audit-results-real.html'));
    await page.getByText('Check unclear items with AI (optional)').click();
    await page.getByRole('button', { name: 'Review with AI' }).click();
    await expect(page.getByText('Using your own API key from Settings.')).toBeVisible();
    await expect(page.getByPlaceholder('Enter once to enable AI')).toHaveCount(0);
    await expect(page.getByRole('checkbox').last()).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Check requirements with AI' })).toBeDisabled();
    await page.getByRole('checkbox').last().check();
    await page.getByRole('button', { name: 'Check requirements with AI' }).click();
    await expect(page.getByText('Personal key review passed.')).toBeVisible();
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]?.body).not.toContain(KEY);
    expect(providerRequests[1]?.body).not.toContain('PRIVATE_INVITE');

    await page.goto(`chrome-extension://${extensionId}/fastlane.html#settings`);
    rejectKey = true;
    await groq.getByRole('button', { name: 'Test connection' }).click();
    await expect(groq.getByRole('status')).toContainText('rejected this key');
    expect(sharedRequests).toEqual([]);
    await groq.getByRole('button', { name: 'Remove key' }).click();
    await expect(groq.getByRole('status')).toContainText('Key removed');
    expect(
        await page.evaluate(
            async () =>
                (await chrome.storage.local.get('FastlaneAiKeys:providers'))['FastlaneAiKeys:providers'].groq.key
        )
    ).toBe('');
    expect(
        await page.evaluate(
            async () => (await chrome.storage.local.get('FastlaneAiKeys:enabled'))['FastlaneAiKeys:enabled']
        )
    ).toBe(true);
    expect(sharedRequests).toEqual([]);
});
