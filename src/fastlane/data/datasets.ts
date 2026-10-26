/**
 * Versioned public-dataset updates without a backend.
 *
 * 1. A bundled dataset ships inside the extension package.
 * 2. Optionally (and at most once per interval) a static manifest is fetched from an allow-listed
 *    HTTPS host (e.g. GitHub Pages).
 * 3. Each newer dataset is downloaded, checked for size, SHA-256, format and schema, and only then
 *    stored in IndexedDB. Any failure leaves the previous valid copy in place.
 *
 * Datasets are DATA ONLY (JSON or SQLite). Nothing downloaded is ever executed.
 */

export type DatasetId = 'grades' | 'catalog' | 'requirements' | 'professors' | 'syllabi';
export const DATASET_IDS: DatasetId[] = ['grades', 'catalog', 'requirements', 'professors', 'syllabi'];
export type DatasetFormat = 'sqlite' | 'json';

/** Highest dataset schema version this build understands, per dataset */
export const SUPPORTED_SCHEMA: Record<DatasetId, number> = {
    grades: 1,
    catalog: 1,
    requirements: 1,
    professors: 1,
    syllabi: 1,
};

export interface DatasetDescriptor {
    id: DatasetId;
    version: string;
    schemaVersion: number;
    format: DatasetFormat;
    url: string;
    sha256: string;
    bytes: number;
    /** ISO timestamp */
    publishedAt: string;
    source: string;
    license: string;
}

export interface DatasetManifest {
    manifestVersion: 1;
    generatedAt: string;
    datasets: DatasetDescriptor[];
}

export interface InstalledDataset {
    descriptor: DatasetDescriptor;
    installedAt: number;
    origin: 'bundled' | 'downloaded';
}

export interface DatasetStore {
    getInstalled(id: DatasetId): Promise<InstalledDataset | null>;
    /** must replace atomically: either both payload and descriptor are written or neither */
    put(installed: InstalledDataset, payload: ArrayBuffer): Promise<void>;
    getPayload(id: DatasetId): Promise<ArrayBuffer | null>;
    getMeta(): Promise<{ lastCheckedAt?: number; lastError?: string }>;
    setMeta(meta: { lastCheckedAt?: number; lastError?: string }): Promise<void>;
}

export const MAX_DATASET_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const STALE_AFTER_MS = 200 * 24 * 60 * 60 * 1000;

export function isAllowedUrl(url: string, allowedHosts: string[]): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && allowedHosts.includes(u.hostname) && !u.username && !u.password;
    } catch {
        return false;
    }
}

export interface ValidationResult {
    ok: boolean;
    manifest?: DatasetManifest;
    errors: string[];
}

export function validateManifest(json: unknown, allowedHosts: string[], now = Date.now()): ValidationResult {
    const errors: string[] = [];
    const m = json as DatasetManifest;
    if (!m || typeof m !== 'object') return { ok: false, errors: ['Manifest is not an object'] };
    if (m.manifestVersion !== 1) errors.push(`Unsupported manifestVersion ${String(m.manifestVersion)}`);
    if (!Array.isArray(m.datasets)) errors.push('datasets must be an array');
    const valid: DatasetDescriptor[] = [];
    for (const d of Array.isArray(m.datasets) ? m.datasets : []) {
        const where = `dataset ${String(d?.id)}@${String(d?.version)}`;
        if (!DATASET_IDS.includes(d?.id)) {
            errors.push(`${where}: unknown id`);
            continue;
        }
        if (typeof d.version !== 'string' || !d.version) errors.push(`${where}: missing version`);
        else if (!Number.isInteger(d.schemaVersion) || d.schemaVersion > SUPPORTED_SCHEMA[d.id]) {
            errors.push(`${where}: schema ${String(d.schemaVersion)} is newer than this build supports`);
        } else if (d.format !== 'json' && d.format !== 'sqlite') errors.push(`${where}: format must be json or sqlite`);
        else if (!isAllowedUrl(d.url, allowedHosts)) errors.push(`${where}: url is not on an allowed HTTPS host`);
        else if (!/^[a-f0-9]{64}$/.test(d.sha256)) errors.push(`${where}: sha256 must be 64 hex characters`);
        else if (!Number.isInteger(d.bytes) || d.bytes <= 0 || d.bytes > MAX_DATASET_BYTES)
            errors.push(`${where}: bad size`);
        else if (Number.isNaN(Date.parse(d.publishedAt)) || Date.parse(d.publishedAt) > now + 60 * 60 * 1000) {
            errors.push(`${where}: publishedAt is missing or in the future`);
        } else if (typeof d.source !== 'string' || typeof d.license !== 'string' || !d.source || !d.license) {
            errors.push(`${where}: source and license are required`);
        } else valid.push(d);
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, manifest: { ...m, datasets: valid }, errors };
}

/** Compares "1.2.10" > "1.2.9"; falls back to publish date when versions are not numeric. */
export function isNewer(candidate: DatasetDescriptor, installed: DatasetDescriptor | undefined): boolean {
    if (!installed) return true;
    const a = candidate.version.split('.').map(Number);
    const b = installed.version.split('.').map(Number);
    if (a.every(Number.isFinite) && b.every(Number.isFinite)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const d = (a[i] ?? 0) - (b[i] ?? 0);
            if (d !== 0) return d > 0;
        }
        return false;
    }
    return Date.parse(candidate.publishedAt) > Date.parse(installed.publishedAt);
}

export async function sha256Hex(payload: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', payload);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** Format and content checks. JSON datasets must be plain data with the expected envelope. */
export function verifyFormat(descriptor: DatasetDescriptor, payload: ArrayBuffer): string | null {
    const bytes = new Uint8Array(payload);
    if (descriptor.format === 'sqlite') {
        const head = new TextDecoder().decode(bytes.slice(0, 16));
        return head === SQLITE_MAGIC ? null : 'Payload is not a SQLite database';
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return 'Payload is not valid JSON';
    }
    const env = parsed as { dataset?: string; schemaVersion?: number; records?: unknown[] };
    if (env?.dataset !== descriptor.id) return 'JSON envelope names a different dataset';
    if (env.schemaVersion !== descriptor.schemaVersion) return 'JSON schemaVersion does not match manifest';
    if (!Array.isArray(env.records)) return 'JSON records must be an array';
    return null;
}

export interface UpdateReport {
    checked: boolean;
    skippedReason?: 'disabled' | 'throttled' | 'offline';
    installed: Array<{ id: DatasetId; version: string }>;
    errors: string[];
}

export interface UpdateOptions {
    manifestUrl: string | null;
    allowedHosts: string[];
    store: DatasetStore;
    fetchFn?: typeof fetch;
    now?: number;
    intervalMs?: number;
    force?: boolean;
    online?: boolean;
    timeoutMs?: number;
    /** datasets shipped inside the package; never re-download the same bytes or older data */
    bundled?: Partial<Record<DatasetId, { sha256: string; publishedAt: string }>>;
}

async function fetchWithTimeout(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchFn(url, {
            signal: controller.signal,
            credentials: 'omit',
            cache: 'no-cache',
            redirect: 'error',
        });
    } finally {
        clearTimeout(timer);
    }
}

/** Checks for and installs newer datasets. Never throws; failures keep the previous data. */
export async function checkForUpdates(opts: UpdateOptions): Promise<UpdateReport> {
    const now = opts.now ?? Date.now();
    const report: UpdateReport = { checked: false, installed: [], errors: [] };
    if (!opts.manifestUrl) return { ...report, skippedReason: 'disabled' };
    if (opts.online === false) return { ...report, skippedReason: 'offline' };
    const meta = await opts.store.getMeta();
    if (
        !opts.force &&
        meta.lastCheckedAt &&
        now - meta.lastCheckedAt < (opts.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
    ) {
        return { ...report, skippedReason: 'throttled' };
    }
    const fetchFn = opts.fetchFn ?? fetch;
    const timeout = opts.timeoutMs ?? 20_000;
    report.checked = true;
    try {
        if (!isAllowedUrl(opts.manifestUrl, opts.allowedHosts))
            throw new Error('Manifest URL is not on an allowed HTTPS host');
        const res = await fetchWithTimeout(fetchFn, opts.manifestUrl, timeout);
        if (!res.ok) throw new Error(`Manifest request failed (${res.status})`);
        const validation = validateManifest(await res.json(), opts.allowedHosts, now);
        if (!validation.ok || !validation.manifest) throw new Error(validation.errors.join('; '));
        for (const descriptor of validation.manifest.datasets) {
            try {
                const current = await opts.store.getInstalled(descriptor.id);
                if (!isNewer(descriptor, current?.descriptor)) continue;
                const shipped = opts.bundled?.[descriptor.id];
                if (!current && shipped) {
                    if (shipped.sha256 === descriptor.sha256) continue;
                    if (Date.parse(descriptor.publishedAt) <= Date.parse(shipped.publishedAt)) continue;
                }
                const dl = await fetchWithTimeout(fetchFn, descriptor.url, timeout);
                if (!dl.ok) throw new Error(`download failed (${dl.status})`);
                const payload = await dl.arrayBuffer();
                if (payload.byteLength !== descriptor.bytes) throw new Error('size does not match manifest');
                if ((await sha256Hex(payload)) !== descriptor.sha256)
                    throw new Error('SHA-256 does not match manifest');
                const formatError = verifyFormat(descriptor, payload);
                if (formatError) throw new Error(formatError);
                await opts.store.put({ descriptor, installedAt: now, origin: 'downloaded' }, payload);
                report.installed.push({ id: descriptor.id, version: descriptor.version });
            } catch (e) {
                report.errors.push(`${descriptor.id}@${descriptor.version}: ${(e as Error).message}`);
            }
        }
    } catch (e) {
        report.errors.push((e as Error).message);
    }
    await opts.store.setMeta({ lastCheckedAt: now, lastError: report.errors[0] });
    return report;
}

export function isStale(descriptor: DatasetDescriptor, now = Date.now()): boolean {
    return now - Date.parse(descriptor.publishedAt) > STALE_AFTER_MS;
}
