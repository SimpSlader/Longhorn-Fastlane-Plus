/**
 * Tiny IndexedDB wrapper for larger local data: downloaded datasets and the section cache.
 * Everything stays in this browser profile.
 */
import type { DatasetId, DatasetStore, InstalledDataset } from './datasets';

const DB_NAME = 'fastlane';
const DB_VERSION = 1;
export const STORES = { datasets: 'datasets', payloads: 'payloads', meta: 'meta', sections: 'sections' } as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = factory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORES.datasets)) db.createObjectStore(STORES.datasets);
            if (!db.objectStoreNames.contains(STORES.payloads)) db.createObjectStore(STORES.payloads);
            if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta);
            if (!db.objectStoreNames.contains(STORES.sections)) {
                const s = db.createObjectStore(STORES.sections, { keyPath: 'key' });
                s.createIndex('semester', 'semester');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            dbPromise = null;
            reject(req.error);
        };
    });
    return dbPromise;
}

/** for tests */
export function resetDbConnection(): void {
    dbPromise = null;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('aborted'));
    });
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await openDb();
    return wrap(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    await done(tx);
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
    const db = await openDb();
    return wrap(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>;
}

export async function idbPutMany(store: string, values: unknown[]): Promise<void> {
    if (!values.length) return;
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    await done(tx);
}

export async function idbDeleteMany(store: string, keys: IDBValidKey[]): Promise<void> {
    if (!keys.length) return;
    const db = await openDb();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    await done(tx);
}

export async function idbClearAll(): Promise<void> {
    const db = await openDb();
    const names = Object.values(STORES);
    const tx = db.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    await done(tx);
}

/** IndexedDB-backed DatasetStore: descriptor and payload are written in one transaction. */
export const idbDatasetStore: DatasetStore = {
    async getInstalled(id: DatasetId) {
        return (await idbGet<InstalledDataset>(STORES.datasets, id)) ?? null;
    },
    async put(installed, payload) {
        const db = await openDb();
        const tx = db.transaction([STORES.datasets, STORES.payloads], 'readwrite');
        tx.objectStore(STORES.payloads).put(payload, installed.descriptor.id);
        tx.objectStore(STORES.datasets).put(installed, installed.descriptor.id);
        await done(tx);
    },
    async getPayload(id) {
        return (await idbGet<ArrayBuffer>(STORES.payloads, id)) ?? null;
    },
    async getMeta() {
        return (await idbGet<{ lastCheckedAt?: number; lastError?: string }>(STORES.meta, 'updates')) ?? {};
    },
    async setMeta(meta) {
        await idbPut(STORES.meta, meta, 'updates');
    },
};
