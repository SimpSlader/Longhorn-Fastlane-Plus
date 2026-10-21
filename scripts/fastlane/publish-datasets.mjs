#!/usr/bin/env node
/**
 * Builds a static dataset site: <out>/data/manifest.json + versioned data files.
 * The manifest format is validated by the extension (src/fastlane/data/datasets.ts) before any download.
 * Usage: node scripts/fastlane/publish-datasets.mjs <publicBaseUrl> <outDir>
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [baseUrl, outDir = 'site'] = process.argv.slice(2);
if (!baseUrl?.startsWith('https://')) throw new Error('publicBaseUrl must be https');
const bundled = JSON.parse(readFileSync('src/fastlane/data/bundled-datasets.json', 'utf8'));
const dataDir = join(outDir, 'data');
mkdirSync(dataDir, { recursive: true });

const grades = bundled.datasets.find(d => d.id === 'grades');
const version = `${grades.publishedAt.slice(0, 10).replace(/-/g, '.')}.${grades.sha256.slice(0, 8)}`;
const file = `grades-${version}.sqlite`;
copyFileSync('src/assets/database/grade_distributions.db', join(dataDir, file));

const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    datasets: [
        {
            id: 'grades',
            version,
            schemaVersion: grades.schemaVersion,
            format: 'sqlite',
            url: `${baseUrl.replace(/\/$/, '')}/${file}`,
            sha256: grades.sha256,
            bytes: grades.bytes,
            publishedAt: grades.publishedAt,
            source: grades.source,
            license: grades.license,
        },
    ],
};
writeFileSync(join(dataDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
    join(outDir, 'index.html'),
    '<!doctype html><title>Fastlane datasets</title><p>Data files for Fastlane Course Planner. See data/manifest.json.</p>'
);
console.log(`dataset site written to ${outDir} (manifest → ${baseUrl}/manifest.json)`);
