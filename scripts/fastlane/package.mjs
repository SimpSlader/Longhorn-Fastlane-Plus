#!/usr/bin/env node
/**
 * Packages dist/ into an installable / Chrome Web Store ZIP. Source maps and dev-only files are excluded.
 * Writes package/fastlane-course-planner-<version>.zip and package/RELEASE.json (sha256, size, file list).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = 'dist';
const out = 'package';
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const name = `${pkg.name}-${pkg.version}.zip`;
// store packages must never contain the local self-reload helper
for (const f of readdirSync(join(dist, 'assets'))) {
    if (f.endsWith('.js') && readFileSync(join(dist, 'assets', f), 'utf8').includes('fastlane-dev-build.json')) {
        console.error('Refusing to package a local development build (auto-reload). Rebuild with `pnpm build`.');
        process.exit(1);
    }
}
mkdirSync(out, { recursive: true });
// remove older packages so package/*.zip always means this build
for (const f of readdirSync(out)) if (f.endsWith('.zip')) rmSync(join(out, f), { force: true });

const walk = d => readdirSync(d).flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(dist)
    .map(f => relative(dist, f))
    .filter(f => !f.endsWith('.map') && !/sentry-toolbar/.test(f) && !f.startsWith('.vite/') && !/\.DS_Store$/.test(f))
    .sort();

execFileSync('zip', ['-q', '-X', join('..', out, name), ...files], { cwd: dist });
const zip = readFileSync(join(out, name));
const release = {
    name: manifest.name,
    version: manifest.version,
    zip: name,
    bytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex'),
    files: files.length,
    builtAt: new Date().toISOString(),
    upstream: pkg.upstream,
};
writeFileSync(join(out, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(`packaged ${join(out, name)} (${(zip.length / 1024 / 1024).toFixed(2)} MB, ${files.length} files)`);
