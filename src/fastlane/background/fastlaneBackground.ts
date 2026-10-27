/**
 * Fastlane background responsibilities (MV3 service worker):
 *  - store/read the local section cache (IndexedDB, extension origin)
 *  - hand verified downloaded datasets to content scripts
 *  - schedule registration reminders with chrome.alarms and show chrome.notifications
 *  - optionally check for static dataset updates at most once per day
 *  - look up public Rate My Professors ratings by professor name (no student data)
 * No network request here ever goes to a developer-controlled server with student data.
 */

import type { PlannedReminder, ReminderConfig } from '../core/reminders';
import { ALARM_PREFIX, normalizeReminderConfig, planReminders } from '../core/reminders';
import type { SectionRecord } from '../core/sections';
import bundled from '../data/bundled-datasets.json';
import { checkForUpdates } from '../data/datasets';
import { idbDatasetStore } from '../data/idb';
import { putObservedSections, readSections } from '../data/sectionStore';
import { dataManifestConfig } from '../services/dataConfig';
import { registerHistory } from '../services/history';
import { bufferToBase64, isFastlaneRequest } from '../services/runtime';
import { FastlaneReminderStore, FastlaneSettingsStore } from '../storage/stores';
import { checkForNewLocalBuild, isDevNotification, registerDevAutoReload } from './devAutoReload';
import { cancelPersonalAi, personalAiRequest, trustedAiSender } from './personalAi';
import { professorRating } from './rmp';

export const UT_REGISTRATION_URL = 'https://utdirect.utexas.edu/registration/chooseSemester.WBX';
const DATA_ALARM = 'fastlane-data-check';
const NOTIFICATION_ICON = 'icons/icon_production_128.png';

async function cacheSections(sections: SectionRecord[]): Promise<number> {
    return putObservedSections(sections.slice(0, 500));
}

export async function syncReminderAlarms(config?: ReminderConfig): Promise<PlannedReminder[]> {
    const reminders = normalizeReminderConfig(
        config ?? ((await FastlaneReminderStore.get('reminders')) as unknown as ReminderConfig)
    );
    const existing = await chrome.alarms.getAll();
    await Promise.all(existing.filter(a => a.name.startsWith(ALARM_PREFIX)).map(a => chrome.alarms.clear(a.name)));
    let planned: PlannedReminder[] = [];
    try {
        planned = planReminders(reminders);
    } catch (e) {
        console.warn('[Fastlane] reminder config invalid', e);
    }
    for (const r of planned) await chrome.alarms.create(r.id, { when: r.when });
    return planned;
}

function notify(id: string, title: string, message: string, withButton = true) {
    chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
        title,
        message,
        priority: 2,
        requireInteraction: id.includes('registration:'),
        buttons: withButton ? [{ title: 'Open registration assistant' }, { title: 'Open Fastlane plan' }] : undefined,
    });
}

async function onAlarm(alarm: chrome.alarms.Alarm) {
    if (alarm.name === DATA_ALARM) {
        await runDataCheck(false);
        return;
    }
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const reminders = normalizeReminderConfig(
        (await FastlaneReminderStore.get('reminders')) as unknown as ReminderConfig
    );
    // recompute so edits made after scheduling are respected
    const match = planReminders(reminders, (alarm.scheduledTime ?? Date.now()) - 60_000).find(r => r.id === alarm.name);
    if (match) notify(`${alarm.name}:${Date.now()}`, match.title, match.message);
}

export async function runDataCheck(force: boolean) {
    const settings = await FastlaneSettingsStore.get('dataUpdates');
    const cfg = dataManifestConfig();
    return checkForUpdates({
        manifestUrl: settings ? cfg.manifestUrl : null,
        allowedHosts: cfg.allowedHosts,
        store: idbDatasetStore,
        force,
        online: navigator.onLine,
        bundled: Object.fromEntries(
            bundled.datasets.map(d => [d.id, { sha256: d.sha256, publishedAt: d.publishedAt }])
        ),
    });
}

function openTab(url: string) {
    void chrome.tabs.create({ url });
}

export function registerFastlaneBackground() {
    if (import.meta.env.VITE_FASTLANE_DEV_AUTORELOAD === 'true') registerDevAutoReload();
    registerHistory();
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!isFastlaneRequest(msg)) return false;
        const respond = (p: Promise<unknown>) =>
            p
                .then(data => sendResponse({ ok: true, data }))
                .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
        switch (msg.type) {
            case 'personalAi':
                if (
                    !trustedAiSender(sender) ||
                    typeof msg.requestId !== 'string' ||
                    typeof msg.path !== 'string' ||
                    !msg.body ||
                    JSON.stringify(msg.body).length > 45000
                ) {
                    sendResponse({ ok: false, error: 'Personal AI is available only inside FastLane.' });
                    return false;
                }
                respond(personalAiRequest(msg.path, msg.body, msg.requestId));
                return true;
            case 'cancelPersonalAi':
                if (trustedAiSender(sender)) cancelPersonalAi(msg.requestId);
                sendResponse({ ok: true });
                return false;
            case 'cacheSections':
                respond(cacheSections(msg.sections));
                return true;
            case 'professorRating':
                respond(professorRating(msg.first, msg.last));
                return true;
            case 'getSections':
                respond(readSections(msg.semester));
                return true;
            case 'getGradesOverride':
                respond(
                    idbDatasetStore.getInstalled('grades').then(async installed => {
                        if (!installed || installed.origin !== 'downloaded') return null;
                        const payload = await idbDatasetStore.getPayload('grades');
                        return payload ? { descriptor: installed.descriptor, base64: bufferToBase64(payload) } : null;
                    })
                );
                return true;
            case 'syncReminders':
                respond(syncReminderAlarms());
                return true;
            case 'testNotification':
                notify(
                    `fastlane-test:${Date.now()}`,
                    'Fastlane test notification',
                    'Reminders are working. You will be notified at the times you chose.'
                );
                sendResponse({ ok: true });
                return false;
            case 'checkDataUpdates':
                respond(runDataCheck(!!msg.force));
                return true;
            case 'devCheckReload':
                if (import.meta.env.VITE_FASTLANE_DEV_AUTORELOAD === 'true') {
                    respond(checkForNewLocalBuild());
                    return true;
                }
                sendResponse({ ok: true, data: false });
                return false;
            case 'openFastlane':
                openTab(chrome.runtime.getURL(`fastlane.html${msg.tab ? `#${msg.tab}` : ''}`));
                sendResponse({ ok: true });
                return false;
            default:
                return false;
        }
    });

    chrome.alarms.onAlarm.addListener(alarm => void onAlarm(alarm));

    chrome.notifications.onButtonClicked.addListener((id, index) => {
        if (isDevNotification(id)) return; // handled by devAutoReload
        openTab(index === 0 ? UT_REGISTRATION_URL : chrome.runtime.getURL('fastlane.html#register'));
        chrome.notifications.clear(id);
    });
    chrome.notifications.onClicked.addListener(id => {
        if (isDevNotification(id)) {
            chrome.notifications.clear(id);
            return;
        }
        if (id.startsWith('fastlane')) openTab(UT_REGISTRATION_URL);
        chrome.notifications.clear(id);
    });

    // keep alarms in sync with the saved reminder settings
    FastlaneReminderStore.subscribe('reminders', ({ newValue }) => {
        void syncReminderAlarms(newValue as unknown as ReminderConfig);
    });

    chrome.runtime.onStartup?.addListener(() => void syncReminderAlarms());
    chrome.runtime.onInstalled.addListener(() => {
        void syncReminderAlarms();
        void chrome.alarms.create(DATA_ALARM, { periodInMinutes: 24 * 60, delayInMinutes: 5 });
    });
}
