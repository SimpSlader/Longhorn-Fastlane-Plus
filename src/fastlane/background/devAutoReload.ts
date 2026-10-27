/**
 * LOCAL DEVELOPMENT ONLY (built with VITE_FASTLANE_DEV_AUTORELOAD=true by update-fastlane.sh).
 *
 * scripts/local/sync-extension.py copies a verified build into the unpacked extension folder and then,
 * as its very last step, writes `fastlane-dev-build.json`. This module notices the new stamp and reloads
 * the extension so the student does not have to click Reload at chrome://extensions.
 *
 * Stability rules (stability over convenience):
 *  - never reload twice to the same build, and at most once per RELOAD_COOLDOWN_MS (no reload loops);
 *  - while a UT add/drop page is open, do NOT reload: offer "Install now" in a notification instead,
 *    and install automatically once those tabs are closed;
 *  - after reloading, tell the student which UT tabs still run the old script and need a refresh.
 *    Pages are never refreshed automatically (a student may have unsaved input).
 * It reads only a file inside the extension: no network access and no new permissions. Store builds
 * never include it (package.mjs refuses such a build).
 */
import { FastlaneAiAccessStore } from '../storage/stores';

export const DEV_STAMP_FILE = 'fastlane-dev-build.json';
export const DEV_NOTIFICATION_PREFIX = 'fastlane-dev-update';
const LOADED_KEY = 'fastlaneDevLoadedBuild'; // chrome.storage.session: cleared by every extension reload
const STATE_KEY = 'fastlaneDevReload'; // chrome.storage.local: survives reloads
const ALARM = 'fastlane-dev-reload';
export const RELOAD_COOLDOWN_MS = 60_000;

/** UT pages where Fastlane injects a content script (mirrors the manifest's content-script matches). */
export const UT_TAB_PATTERNS = [
    '*://*.utdirect.utexas.edu/apps/registrar/course_schedule/*',
    '*://*.utdirect.utexas.edu/registration/*',
    '*://*.utdirect.utexas.edu/apps/degree/audits/*',
    '*://*.registrar.utexas.edu/schedules/*',
    '*://my.utexas.edu/student/*',
];
const REGISTRATION_PATTERN = '*://*.utdirect.utexas.edu/registration/*';

export interface ReloadState {
    /** build the extension last reloaded itself to */
    lastReloadedTo?: string | null;
    lastReloadAt?: number;
    /** set right before reloading so the next start can report tabs needing a refresh */
    justReloaded?: boolean;
    /** build for which the "update ready" notice was already shown (shown once, not every 30 s) */
    deferNotifiedFor?: string | null;
}

export type ReloadDecision =
    | { action: 'none'; reason: 'no-stamp' | 'same-build' | 'already-reloaded-to-this-build' | 'cooldown' }
    | { action: 'record-baseline' }
    | { action: 'defer'; reason: 'registration-tab-open' }
    | { action: 'reload' };

/** Pure decision used by the background (unit-tested). */
export function decideDevReload(input: {
    current: string | null;
    loaded: string | null | undefined;
    state: ReloadState;
    now: number;
    registrationTabOpen: boolean;
    force?: boolean;
}): ReloadDecision {
    const { current, loaded, state, now } = input;
    if (loaded === undefined) return { action: 'record-baseline' };
    if (!current) return { action: 'none', reason: 'no-stamp' };
    if (current === loaded) return { action: 'none', reason: 'same-build' };
    if (state.lastReloadedTo === current) return { action: 'none', reason: 'already-reloaded-to-this-build' };
    if (state.lastReloadAt && now - state.lastReloadAt < RELOAD_COOLDOWN_MS)
        return { action: 'none', reason: 'cooldown' };
    if (input.registrationTabOpen && !input.force) return { action: 'defer', reason: 'registration-tab-open' };
    return { action: 'reload' };
}

/** Personal access exists only in the private installation stamp, never in a public build. */
export function personalAccessFromStamp(data: unknown): string | null {
    const raw = data && typeof data === 'object' && 'aiAccessCode' in data ? data.aiAccessCode : null;
    if (typeof raw !== 'string') return null;
    const code = raw.trim();
    return code.length >= 8 && code.length <= 256 && !/\s/.test(code) ? code : null;
}

async function readStamp(): Promise<string | null> {
    try {
        const res = await fetch(chrome.runtime.getURL(DEV_STAMP_FILE), { cache: 'no-store' });
        if (!res.ok) return null;
        const data = (await res.json()) as { buildId?: unknown };
        const code = personalAccessFromStamp(data);
        if (code && (await FastlaneAiAccessStore.get('accessCode')) !== code) {
            await FastlaneAiAccessStore.set('accessCode', code);
        }
        return typeof data.buildId === 'string' ? data.buildId : null;
    } catch {
        return null;
    }
}

async function readState(): Promise<ReloadState> {
    return ((await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as ReloadState | undefined) ?? {};
}

async function openTabs(patterns: string[]): Promise<chrome.tabs.Tab[]> {
    try {
        return await chrome.tabs.query({ url: patterns });
    } catch {
        return [];
    }
}

function notify(id: string, title: string, message: string, buttons?: Array<{ title: string }>) {
    chrome.notifications.create(`${DEV_NOTIFICATION_PREFIX}:${id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon_development_128.png'),
        title,
        message,
        priority: 1,
        buttons,
    });
}

/** Checks for a newly synced build and reloads (or defers) according to the stability rules. */
export async function checkForNewLocalBuild(force = false): Promise<ReloadDecision> {
    const [current, loadedRaw, state, registrationTabs] = await Promise.all([
        readStamp(),
        chrome.storage.session.get(LOADED_KEY),
        readState(),
        openTabs([REGISTRATION_PATTERN]),
    ]);
    const loaded = loadedRaw[LOADED_KEY] as string | null | undefined;
    const decision = decideDevReload({
        current,
        loaded,
        state,
        now: Date.now(),
        registrationTabOpen: registrationTabs.length > 0,
        force,
    });
    if (decision.action === 'record-baseline') {
        await chrome.storage.session.set({ [LOADED_KEY]: current });
    } else if (decision.action === 'defer' && state.deferNotifiedFor !== current) {
        await chrome.storage.local.set({ [STATE_KEY]: { ...state, deferNotifiedFor: current } satisfies ReloadState });
        notify(
            'ready',
            'Fastlane update ready',
            'A UT registration page is open, so the update waits. It installs when you close that tab, or click Install now. After installing, refresh UT tabs to reconnect.',
            [{ title: 'Install now' }]
        );
    } else if (decision.action === 'reload') {
        await chrome.storage.local.set({
            [STATE_KEY]: {
                lastReloadedTo: current,
                lastReloadAt: Date.now(),
                justReloaded: true,
                deferNotifiedFor: null,
            } satisfies ReloadState,
        });
        chrome.runtime.reload();
    }
    return decision;
}

/** After a self-reload: list UT tabs still running the previous script (they need a manual refresh). */
async function reportAfterReload(): Promise<void> {
    const state = await readState();
    if (!state.justReloaded) return;
    await chrome.storage.local.set({ [STATE_KEY]: { ...state, justReloaded: false } });
    chrome.notifications.clear(`${DEV_NOTIFICATION_PREFIX}:ready`);
    const tabs = await openTabs(UT_TAB_PATTERNS);
    if (!tabs.length) return;
    notify(
        'refresh',
        'Fastlane updated',
        `Refresh ${tabs.length === 1 ? 'your open UT tab' : `your ${tabs.length} open UT tabs`} to use the new version. Fastlane does not refresh them for you, so unsaved input is safe.`
    );
}

export function registerDevAutoReload(): void {
    void reportAfterReload();
    void checkForNewLocalBuild();
    // 30 s is Chrome's minimum alarm period; pages also ask for a check when they load
    void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === ALARM) void checkForNewLocalBuild();
    });
    chrome.notifications.onButtonClicked.addListener(id => {
        if (id === `${DEV_NOTIFICATION_PREFIX}:ready`) void checkForNewLocalBuild(true);
    });
}

export function isDevNotification(id: string): boolean {
    return id.startsWith(DEV_NOTIFICATION_PREFIX);
}
