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
    // each test gets its own temporary browser profile, so local runs use several workers; a test that times out
    // while the Mac is busy gets one more try. CI runners are small, so CI keeps one worker and no retries.
    fullyParallel: true,
    workers: process.env.CI ? 1 : 4,
    retries: process.env.CI ? 0 : 1,
    reporter: [['list'], ['json', { outputFile: 'reports/e2e-results.json' }]],
});
