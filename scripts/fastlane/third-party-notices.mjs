#!/usr/bin/env node
/**
 * Writes public/THIRD_PARTY_NOTICES.txt (shipped inside the extension) with the license text of
 * every production dependency, plus the upstream projects this fork is built on.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
);
const entries = Object.entries(raw).flatMap(([license, pkgs]) => pkgs.map(p => ({ license, ...p })));
entries.sort((a, b) => a.name.localeCompare(b.name));

function licenseText(paths) {
    for (const dir of paths ?? []) {
        if (!existsSync(dir)) continue;
        const file = readdirSync(dir).find(f => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
        if (file) return readFileSync(join(dir, file), 'utf8').trim();
    }
    return null;
}

const out = [];
out.push('FASTLANE COURSE PLANNER — THIRD-PARTY NOTICES');
out.push('');
out.push('Fastlane Course Planner is an independent, student-developed project. It is not affiliated with,');
out.push('endorsed by, or approved by The University of Texas at Austin or the UT Registration Plus team.');
out.push('');
out.push('='.repeat(78));
out.push('UT Registration Plus — https://github.com/Longhorn-Developers/UT-Registration-Plus');
out.push('This extension is a fork of UT Registration Plus.');
out.push('='.repeat(78));
out.push(readFileSync('LICENSE.md', 'utf8').trim());
out.push('');
out.push('='.repeat(78));
out.push('Degree Audit Plus — https://github.com/Longhorn-Developers/Degree-Audit-Plus');
out.push('The degree-audit parser follows its approach to UT IDA markup; its sample fixtures are used in tests only.');
out.push('='.repeat(78));
out.push(readFileSync('docs/licenses/Degree-Audit-Plus-LICENSE.txt', 'utf8').trim());
out.push('');
out.push('='.repeat(78));
out.push('DATA');
out.push('='.repeat(78));
out.push('Historical grade distributions: University of Texas at Austin grade distribution reports, compiled by');
out.push('UT_Grade_Parser (https://github.com/doprz/UT_Grade_Parser, MIT OR Apache-2.0) and redistributed by');
out.push('UT Registration Plus. Campus map artwork and walkway graph: UT Registration Plus (MIT).');
out.push('');
out.push('='.repeat(78));
out.push(`BUNDLED OPEN-SOURCE PACKAGES (${entries.length})`);
out.push('='.repeat(78));
const seenTexts = new Map();
for (const e of entries) {
    const versions = (e.versions ?? [e.version]).join(', ');
    out.push('');
    out.push(`${e.name}@${versions} — ${e.license}${e.homepage ? ` — ${e.homepage}` : ''}`);
    const text = licenseText(e.paths ?? [e.path]);
    if (!text) {
        out.push('  (license file not included in package; see the package homepage)');
        continue;
    }
    if (seenTexts.has(text)) {
        out.push(`  Same license text as ${seenTexts.get(text)}.`);
        continue;
    }
    seenTexts.set(text, e.name);
    out.push(
        text
            .split('\n')
            .map(l => `  ${l}`)
            .join('\n')
    );
}
writeFileSync('public/THIRD_PARTY_NOTICES.txt', `${out.join('\n')}\n`);
console.log(`wrote public/THIRD_PARTY_NOTICES.txt (${entries.length} packages)`);
