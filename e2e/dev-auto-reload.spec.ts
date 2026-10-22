import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

import { EXTENSION } from './fixtures';

const STAMP = 'fastlane-dev-build.json';
const isLocalBuild = () =>
    existsSync(join(EXTENSION, 'assets')) &&
    readdirSync(join(EXTENSION, 'assets')).some(
        f => f.endsWith('.js') && readFileSync(join(EXTENSION, 'assets', f), 'utf8').includes(STAMP)
    );

test('local build triggers its own reload when a newly synced build lands in its folder', async () => {
    test.skip(!isLocalBuild(), 'store builds do not include the local auto-reload helper');
    // work on a copy: the stamp is written into the loaded folder, exactly like scripts/local/sync-extension.py
    const folder = mkdtempSync(join(tmpdir(), 'fastlane-unpacked-'));
    cpSync(EXTENSION, folder, { recursive: true });
    writeFileSync(join(folder, STAMP), JSON.stringify({ buildId: 'build-1' }));
    const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'fastlane-e2e-')), {
        headless: true,
        ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : { channel: 'chromium' }),
        args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`],
    });
    try {
        const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
        const id = new URL(sw.url()).host;
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/fastlane.html#settings`);
        // same build: nothing happens
        const unchanged = await page.evaluate(() =>
            chrome.runtime.sendMessage({ fastlane: true, type: 'devCheckReload' })
        );
        expect(unchanged).toEqual({ ok: true, data: { action: 'none', reason: 'same-build' } });

        // the sync script writes a new stamp; the next check reloads the extension (no chrome://extensions click)
        writeFileSync(join(folder, STAMP), JSON.stringify({ buildId: 'build-2' }));
        await page
            .evaluate(() => chrome.runtime.sendMessage({ fastlane: true, type: 'devCheckReload' }))
            .catch(() => null);

        // chrome.runtime.reload() unloads the running copy. (In the student's Chrome, where the folder was added with
        // "Load unpacked", Chrome then re-loads it from disk; command-line-loaded test extensions are not re-added,
        // so this test can only observe the unload.)
        const check = await context.newPage();
        const unloaded = async () => {
            try {
                await check.goto(`chrome-extension://${id}/fastlane.html#settings`);
                return false;
            } catch (e) {
                return /ERR_BLOCKED_BY_CLIENT|ERR_FILE_NOT_FOUND|ERR_ABORTED/.test(String(e));
            }
        };
        await expect.poll(unloaded, { timeout: 15_000 }).toBe(true);
    } finally {
        await context.close();
    }
});

test('local build waits while a UT registration page is open instead of reloading', async () => {
    test.skip(!isLocalBuild(), 'store builds do not include the local auto-reload helper');
    const folder = mkdtempSync(join(tmpdir(), 'fastlane-unpacked-'));
    cpSync(EXTENSION, folder, { recursive: true });
    writeFileSync(join(folder, STAMP), JSON.stringify({ buildId: 'build-1' }));
    const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'fastlane-e2e-')), {
        headless: true,
        ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : { channel: 'chromium' }),
        args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`],
    });
    try {
        await context.route('https://utdirect.utexas.edu/**', route =>
            route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body><form><input id="s_unique_add"></form></body></html>',
            })
        );
        const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
        const id = new URL(sw.url()).host;
        const ut = await context.newPage();
        await ut.goto('https://utdirect.utexas.edu/registration/registration.WBX');
        await ut.locator('#s_unique_add').fill('12345');
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/fastlane.html#settings`);
        await page.evaluate(() => chrome.runtime.sendMessage({ fastlane: true, type: 'devCheckReload' }));
        writeFileSync(join(folder, STAMP), JSON.stringify({ buildId: 'build-2' }));
        const decision = await page.evaluate(() =>
            chrome.runtime.sendMessage({ fastlane: true, type: 'devCheckReload' })
        );
        expect(decision).toEqual({ ok: true, data: { action: 'defer', reason: 'registration-tab-open' } });
        // still the old build, still loaded, and the registration page was not touched
        await page.reload();
        expect(
            await page.evaluate(
                async () => (await chrome.storage.session.get('fastlaneDevLoadedBuild')).fastlaneDevLoadedBuild
            )
        ).toBe('build-1');
        await expect(ut.locator('#s_unique_add')).toHaveValue('12345');
        // checking again does not repeat the notice or reload (no loop)
        const again = await page.evaluate(() => chrome.runtime.sendMessage({ fastlane: true, type: 'devCheckReload' }));
        expect(again).toEqual({ ok: true, data: { action: 'defer', reason: 'registration-tab-open' } });
        expect(
            await page.evaluate(async () => (await chrome.storage.local.get('fastlaneDevReload')).fastlaneDevReload)
        ).toMatchObject({
            deferNotifiedFor: 'build-2',
        });
    } finally {
        await context.close();
    }
});
