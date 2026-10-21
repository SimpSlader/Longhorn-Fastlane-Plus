import 'fake-indexeddb/auto';

import { describe, expect, it, vi } from 'vitest';

import type { DatasetDescriptor, DatasetStore, InstalledDataset } from '../data/datasets';
import { checkForUpdates, isNewer, isStale, sha256Hex, validateManifest, verifyFormat } from '../data/datasets';
import { idbDatasetStore, idbGetAll, idbPutMany, resetDbConnection, STORES } from '../data/idb';

const HOSTS = ['fastlane-planner.github.io'];
const NOW = Date.UTC(2026, 9, 21);

function memoryStore(
    initial?: InstalledDataset,
    payload?: ArrayBuffer
): DatasetStore & { payloads: Map<string, ArrayBuffer> } {
    const installed = new Map<string, InstalledDataset>();
    const payloads = new Map<string, ArrayBuffer>();
    if (initial) installed.set(initial.descriptor.id, initial);
    if (initial && payload) payloads.set(initial.descriptor.id, payload);
    let meta = {};
    return {
        payloads,
        getInstalled: async id => installed.get(id) ?? null,
        put: async (i, p) => {
            installed.set(i.descriptor.id, i);
            payloads.set(i.descriptor.id, p);
        },
        getPayload: async id => payloads.get(id) ?? null,
        getMeta: async () => meta,
        setMeta: async m => {
            meta = m;
        },
    };
}

const json = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;

async function descriptorFor(payload: ArrayBuffer, patch: Partial<DatasetDescriptor> = {}): Promise<DatasetDescriptor> {
    return {
        id: 'catalog',
        version: '2026.10.1',
        schemaVersion: 1,
        format: 'json',
        url: 'https://fastlane-planner.github.io/data/catalog-2026.10.1.json',
        sha256: await sha256Hex(payload),
        bytes: payload.byteLength,
        publishedAt: '2026-10-01T00:00:00Z',
        source: 'UT public course schedule (test)',
        license: 'test',
        ...patch,
    };
}

function fakeFetch(routes: Record<string, () => Response>) {
    return vi.fn(async (url: string) => {
        const route = routes[url];
        if (!route) throw new TypeError('Failed to fetch');
        return route();
    }) as unknown as typeof fetch;
}

describe('manifest validation', () => {
    it('accepts a well-formed manifest', async () => {
        const d = await descriptorFor(json({ dataset: 'catalog', schemaVersion: 1, records: [] }));
        expect(validateManifest({ manifestVersion: 1, generatedAt: '', datasets: [d] }, HOSTS, NOW).ok).toBe(true);
    });

    it('rejects non-HTTPS or non-allow-listed hosts, unknown schemas, future dates and executable formats', async () => {
        const base = await descriptorFor(json({}));
        const cases: Array<Partial<DatasetDescriptor>> = [
            { url: 'http://fastlane-planner.github.io/x.json' },
            { url: 'https://evil.example.com/x.json' },
            { schemaVersion: 99 },
            { publishedAt: '2030-01-01T00:00:00Z' },
            { format: 'js' as never },
            { sha256: 'abc' },
            { license: '' },
        ];
        for (const patch of cases) {
            const r = validateManifest(
                { manifestVersion: 1, generatedAt: '', datasets: [{ ...base, ...patch }] },
                HOSTS,
                NOW
            );
            expect(r.ok, JSON.stringify(patch)).toBe(false);
        }
        expect(validateManifest({ manifestVersion: 2, datasets: [] }, HOSTS, NOW).ok).toBe(false);
    });

    it('compares versions', async () => {
        const a = await descriptorFor(json({}), { version: '1.2.10' });
        const b = await descriptorFor(json({}), { version: '1.2.9' });
        expect(isNewer(a, b)).toBe(true);
        expect(isNewer(b, a)).toBe(false);
        expect(isNewer(a, a)).toBe(false);
        expect(isNewer(a, undefined)).toBe(true);
        expect(isStale(a, Date.parse('2026-10-01') + 300 * 86400000)).toBe(true);
    });

    it('verifies payload format', async () => {
        const good = json({ dataset: 'catalog', schemaVersion: 1, records: [] });
        expect(verifyFormat(await descriptorFor(good), good)).toBeNull();
        const bad = json({ dataset: 'grades', schemaVersion: 1, records: [] });
        expect(verifyFormat(await descriptorFor(bad), bad)).toContain('different dataset');
        const notSqlite = new TextEncoder().encode('function(){}').buffer as ArrayBuffer;
        expect(verifyFormat(await descriptorFor(notSqlite, { format: 'sqlite' }), notSqlite)).toContain('SQLite');
    });
});

describe('checkForUpdates', () => {
    const manifestUrl = 'https://fastlane-planner.github.io/data/manifest.json';

    it('installs a verified newer dataset', async () => {
        const payload = json({ dataset: 'catalog', schemaVersion: 1, records: [{ uniqueId: 1 }] });
        const d = await descriptorFor(payload);
        const store = memoryStore();
        const fetchFn = fakeFetch({
            [manifestUrl]: () => Response.json({ manifestVersion: 1, generatedAt: '', datasets: [d] }),
            [d.url]: () => new Response(payload),
        });
        const report = await checkForUpdates({ manifestUrl, allowedHosts: HOSTS, store, fetchFn, now: NOW });
        expect(report).toMatchObject({
            checked: true,
            installed: [{ id: 'catalog', version: '2026.10.1' }],
            errors: [],
        });
        expect(store.payloads.get('catalog')?.byteLength).toBe(payload.byteLength);
    });

    it('keeps the previous valid data when the hash does not match', async () => {
        const old = json({ dataset: 'catalog', schemaVersion: 1, records: ['old'] });
        const oldDescriptor = await descriptorFor(old, { version: '2026.9.0' });
        const store = memoryStore({ descriptor: oldDescriptor, installedAt: 0, origin: 'bundled' }, old);
        const tampered = json({ dataset: 'catalog', schemaVersion: 1, records: ['tampered'] });
        const d = await descriptorFor(json({ dataset: 'catalog', schemaVersion: 1, records: ['expected'] }));
        const fetchFn = fakeFetch({
            [manifestUrl]: () =>
                Response.json({
                    manifestVersion: 1,
                    generatedAt: '',
                    datasets: [{ ...d, bytes: tampered.byteLength }],
                }),
            [d.url]: () => new Response(tampered),
        });
        const report = await checkForUpdates({ manifestUrl, allowedHosts: HOSTS, store, fetchFn, now: NOW });
        expect(report.installed).toEqual([]);
        expect(report.errors[0]).toContain('SHA-256');
        expect((await store.getInstalled('catalog'))?.descriptor.version).toBe('2026.9.0');
        expect(store.payloads.get('catalog')).toBe(old);
    });

    it('survives network failures, offline mode and is throttled', async () => {
        const store = memoryStore();
        const failing = fakeFetch({});
        const r1 = await checkForUpdates({ manifestUrl, allowedHosts: HOSTS, store, fetchFn: failing, now: NOW });
        expect(r1.errors[0]).toContain('Failed to fetch');
        const r2 = await checkForUpdates({
            manifestUrl,
            allowedHosts: HOSTS,
            store,
            fetchFn: failing,
            now: NOW + 1000,
        });
        expect(r2.skippedReason).toBe('throttled');
        const r3 = await checkForUpdates({ manifestUrl, allowedHosts: HOSTS, store, online: false, now: NOW });
        expect(r3.skippedReason).toBe('offline');
        const r4 = await checkForUpdates({ manifestUrl: null, allowedHosts: HOSTS, store });
        expect(r4.skippedReason).toBe('disabled');
        expect(failing).toHaveBeenCalledTimes(1);
    });

    it('rejects a manifest served from a host that is not allow-listed', async () => {
        const fetchFn = fakeFetch({});
        const r = await checkForUpdates({
            manifestUrl: 'https://example.com/m.json',
            allowedHosts: HOSTS,
            store: memoryStore(),
            fetchFn,
            now: NOW,
        });
        expect(r.errors[0]).toContain('allowed');
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('does not re-download data identical to (or older than) the bundled copy', async () => {
        const payload = json({ dataset: 'catalog', schemaVersion: 1, records: [] });
        const d = await descriptorFor(payload);
        const fetchFn = fakeFetch({
            [manifestUrl]: () => Response.json({ manifestVersion: 1, generatedAt: '', datasets: [d] }),
        });
        const same = await checkForUpdates({
            manifestUrl,
            allowedHosts: HOSTS,
            store: memoryStore(),
            fetchFn,
            now: NOW,
            bundled: { catalog: { sha256: d.sha256, publishedAt: d.publishedAt } },
        });
        expect(same.installed).toEqual([]);
        const older = await checkForUpdates({
            manifestUrl,
            allowedHosts: HOSTS,
            store: memoryStore(),
            fetchFn,
            now: NOW,
            bundled: { catalog: { sha256: 'x', publishedAt: '2026-10-05T00:00:00Z' } },
        });
        expect(older.installed).toEqual([]);
        expect(fetchFn).toHaveBeenCalledTimes(2); // manifest only, never the payload
    });

    it('rejects an older or same version', async () => {
        const payload = json({ dataset: 'catalog', schemaVersion: 1, records: [] });
        const d = await descriptorFor(payload);
        const store = memoryStore({ descriptor: d, installedAt: 0, origin: 'downloaded' }, payload);
        const fetchFn = fakeFetch({
            [manifestUrl]: () => Response.json({ manifestVersion: 1, generatedAt: '', datasets: [d] }),
        });
        const r = await checkForUpdates({ manifestUrl, allowedHosts: HOSTS, store, fetchFn, now: NOW, force: true });
        expect(r.installed).toEqual([]);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});

describe('IndexedDB persistence (survives reloads)', () => {
    it('stores datasets and sections and reads them back on a new connection', async () => {
        const payload = json({ dataset: 'catalog', schemaVersion: 1, records: [] });
        const d = await descriptorFor(payload);
        await idbDatasetStore.put({ descriptor: d, installedAt: 1, origin: 'downloaded' }, payload);
        await idbPutMany(STORES.sections, [{ key: '20272:23095', semester: 'Spring 2027', uniqueId: 23095 }]);
        resetDbConnection(); // simulate a browser restart
        expect((await idbDatasetStore.getInstalled('catalog'))?.descriptor.version).toBe('2026.10.1');
        expect((await idbDatasetStore.getPayload('catalog'))?.byteLength).toBe(payload.byteLength);
        expect(await idbGetAll(STORES.sections)).toHaveLength(1);
    });
});
