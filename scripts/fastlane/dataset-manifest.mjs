#!/usr/bin/env node
/**
 * Generates src/fastlane/data/bundled-datasets.json describing the datasets shipped in the package
 * (version, SHA-256, size, semesters covered, last-updated date). Run after any dataset change:
 *   node scripts/fastlane/dataset-manifest.mjs           (write)
 *   node scripts/fastlane/dataset-manifest.mjs --check   (CI: fail if out of date)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');

const dbPath = join(root, 'src/assets/database/grade_distributions.db');
const outPath = join(root, 'src/fastlane/data/bundled-datasets.json');

const bytes = readFileSync(dbPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const SQL = await initSqlJs();
const db = new SQL.Database(bytes);
const semesters = db.exec('SELECT DISTINCT Semester FROM grade_distributions')[0].values.map(r => String(r[0]));
const rows = db.exec('SELECT COUNT(*) FROM grade_distributions')[0].values[0][0];
const order = { Spring: 1, Summer: 2, Fall: 3 };
semesters.sort((a, b) => {
    const [sa, ya] = a.split(' ');
    const [sb, yb] = b.split(' ');
    return Number(ya) - Number(yb) || order[sa] - order[sb];
});

let updated = '';
try {
    updated = execFileSync('git', ['log', '-1', '--format=%cs', '--', 'src/assets/database/grade_distributions.db'], {
        cwd: root,
    })
        .toString()
        .trim();
} catch {}
if (!updated) updated = new Date().toISOString().slice(0, 10);

const manifest = {
    manifestVersion: 1,
    generatedBy: 'scripts/fastlane/dataset-manifest.mjs',
    datasets: [
        {
            id: 'grades',
            version: `bundled-${sha256.slice(0, 12)}`,
            schemaVersion: 1,
            format: 'sqlite',
            sha256,
            bytes: bytes.length,
            publishedAt: `${updated}T00:00:00Z`,
            rows,
            firstSemester: semesters[0],
            latestSemester: semesters[semesters.length - 1],
            semesterCount: semesters.length,
            source: 'UT Austin grade distribution reports, compiled by UT_Grade_Parser and redistributed in UT Registration Plus',
            sourceUrl: 'https://github.com/doprz/UT_Grade_Parser',
            license: 'Public university records; see docs/DATA_SOURCES.md',
        },
    ],
};

const text = `${JSON.stringify(manifest, null, 4)}\n`;
if (process.argv.includes('--check')) {
    const current = readFileSync(outPath, 'utf8');
    const strip = s => s.replace(/"publishedAt": "[^"]*"/, '');
    if (strip(current) !== strip(text)) {
        console.error('bundled-datasets.json is out of date. Run: node scripts/fastlane/dataset-manifest.mjs');
        process.exit(1);
    }
    console.log('bundled-datasets.json is up to date');
} else {
    writeFileSync(outPath, text);
    console.log(`wrote ${outPath}: ${semesters[0]} – ${semesters[semesters.length - 1]}, ${rows} rows`);
}
