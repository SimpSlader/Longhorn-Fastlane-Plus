import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, test as base, chromium, type Worker } from '@playwright/test';

/** Built extension under test: dist/ by default, or an unzipped release ZIP via FASTLANE_EXTENSION_DIR. */
export const EXTENSION = resolve(process.env.FASTLANE_EXTENSION_DIR || resolve(process.cwd(), 'dist'));

export const test = base.extend<{ context: BrowserContext; extensionId: string; sw: Worker; userDataDir: string }>({
    // biome-ignore lint/correctness/noEmptyPattern: playwright fixture signature
    userDataDir: async ({}, use) => {
        await use(mkdtempSync(join(tmpdir(), 'fastlane-e2e-')));
    },
    context: async ({ userDataDir }, use) => {
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: true,
            // Extensions need full Chromium (new headless). Playwright's default "headless shell" cannot
            // load extensions, so use the 'chromium' channel unless a specific binary is provided.
            ...(process.env.PW_CHROMIUM_PATH
                ? { executablePath: process.env.PW_CHROMIUM_PATH }
                : { channel: 'chromium' }),
            args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
            viewport: { width: 1440, height: 1000 },
            permissions: ['clipboard-read', 'clipboard-write'],
        });
        // Rate My Professors is stubbed for every test (the service worker's requests included), so tests never
        // contact the real site. The stub rates whoever is searched: 4.4/5 from 31 ratings.
        await context.route('https://www.ratemyprofessors.com/**', async route => {
            const body = route.request().postDataJSON() as { variables?: { text?: string } } | null;
            const node = {
                legacyId: 4242,
                firstName: 'Jordan', // the demo professors are listed as "LAST, J"
                lastName: body?.variables?.text ?? '',
                department: 'Test',
                avgRating: 4.4,
                avgDifficulty: 2.1,
                numRatings: 31,
                wouldTakeAgainPercent: 80,
                school: { id: 'U2Nob29sLTEyNTU=' },
            };
            await route.fulfill({ json: { data: { newSearch: { teachers: { edges: [{ node }] } } } } });
        });
        await use(context);
        await context.close();
    },
    sw: async ({ context }, use) => {
        let [worker] = context.serviceWorkers();
        if (!worker) worker = await context.waitForEvent('serviceworker');
        await use(worker);
    },
    extensionId: async ({ sw }, use) => {
        await use(new URL(sw.url()).host);
    },
});

export const expect = test.expect;
