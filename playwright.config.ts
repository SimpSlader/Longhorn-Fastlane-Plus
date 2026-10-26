import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests load the built, unpacked extension (dist/) into Chromium.
 * Branded Google Chrome ignores --load-extension, so use Chromium / Chrome for Testing:
 *   pnpm exec playwright install chromium        (CI)
 *   PW_CHROMIUM_PATH=/path/to/chrome pnpm e2e     (local override)
 */
export default defineConfig({
    testDir: 'e2e',
    timeout: 60_000,
    // each test gets its own temporary browser profile, so tests run side by side (GitHub's 4-core runners take 2 at a
    // time); a test that times out on a busy machine gets one more try, and a stuck run stops after 15 minutes
    fullyParallel: true,
    workers: process.env.CI ? 2 : 4,
    retries: 1,
    globalTimeout: 15 * 60_000,
    reporter: [['list'], ['json', { outputFile: 'reports/e2e-results.json' }]],
});
