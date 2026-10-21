/**
 * Small messaging channel between content scripts and the background worker for things that must
 * live in the extension's own origin (IndexedDB section cache, downloaded datasets, alarms).
 * Messages are tagged `fastlane: true` so they never collide with UT Registration Plus messaging.
 */
import type { SectionRecord } from '../core/sections';

export type FastlaneRequest =
    | { fastlane: true; type: 'cacheSections'; sections: SectionRecord[] }
    | { fastlane: true; type: 'getSections'; semester?: string | null }
    | { fastlane: true; type: 'getGradesOverride' }
    | { fastlane: true; type: 'syncReminders' }
    | { fastlane: true; type: 'testNotification' }
    | { fastlane: true; type: 'checkDataUpdates'; force?: boolean }
    | { fastlane: true; type: 'openFastlane'; tab?: string };

export function isFastlaneRequest(msg: unknown): msg is FastlaneRequest {
    return !!msg && typeof msg === 'object' && (msg as { fastlane?: unknown }).fastlane === true;
}

type WithoutTag<T> = T extends unknown ? Omit<T, 'fastlane'> : never;

export async function sendFastlane<T = unknown>(request: WithoutTag<FastlaneRequest>): Promise<T> {
    const response = (await chrome.runtime.sendMessage({ ...request, fastlane: true })) as {
        ok: boolean;
        data?: T;
        error?: string;
    };
    if (!response?.ok) throw new Error(response?.error ?? 'No response from background');
    return response.data as T;
}

export function fastlanePageUrl(tab?: string): string {
    return chrome.runtime.getURL(`fastlane.html${tab ? `#${tab}` : ''}`);
}

/** base64 helpers for moving binary datasets over runtime messaging */
export function bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
}

export function base64ToBuffer(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}
