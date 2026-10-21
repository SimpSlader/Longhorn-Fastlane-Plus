#!/usr/bin/env node
import { readFileSync } from 'node:fs';
/** Rasterizes store-assets/icon.svg into the PNG sizes the manifest and store need (uses Playwright Chromium). */
import { chromium } from '@playwright/test';

const svg = readFileSync('store-assets/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
        `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`
    );
    for (const mode of ['production', 'development', 'beta']) {
        await page.screenshot({ path: `public/icons/icon_${mode}_${size}.png`, omitBackground: true });
    }
}
await page.setViewportSize({ width: 128, height: 128 });
await page.screenshot({ path: 'store-assets/icon-128.png', omitBackground: true });
await browser.close();
console.log('icons written');
