/**
 * Where optional dataset updates come from. Configured at build time:
 *   VITE_FASTLANE_DATA_MANIFEST_URL=https://<org>.github.io/<repo>/data/manifest.json
 * When unset, the extension uses its bundled datasets only and never makes an update request.
 */
import type { DatasetDescriptor, DatasetId } from '../data/datasets';
import { idbDatasetStore } from '../data/idb';
import { base64ToBuffer, sendFastlane } from './runtime';

export function dataManifestConfig(): { manifestUrl: string | null; allowedHosts: string[] } {
    const url = (import.meta.env.VITE_FASTLANE_DATA_MANIFEST_URL as string | undefined)?.trim() || null;
    if (!url) return { manifestUrl: null, allowedHosts: [] };
    try {
        return { manifestUrl: url, allowedHosts: [new URL(url).hostname] };
    } catch {
        return { manifestUrl: null, allowedHosts: [] };
    }
}

/**
 * A verified, downloaded replacement for the bundled grade database, if one is installed.
 * Content scripts cannot read the extension's IndexedDB, so they ask the background worker.
 */
export async function loadGradesOverride(): Promise<{ descriptor: DatasetDescriptor; buffer: ArrayBuffer } | null> {
    try {
        if (globalThis.location?.protocol === 'chrome-extension:') {
            const installed = await idbDatasetStore.getInstalled('grades' as DatasetId);
            if (!installed || installed.origin !== 'downloaded') return null;
            const buffer = await idbDatasetStore.getPayload('grades');
            return buffer ? { descriptor: installed.descriptor, buffer } : null;
        }
        const res = await sendFastlane<{ descriptor: DatasetDescriptor; base64: string } | null>({
            type: 'getGradesOverride',
        });
        return res ? { descriptor: res.descriptor, buffer: base64ToBuffer(res.base64) } : null;
    } catch {
        return null;
    }
}
