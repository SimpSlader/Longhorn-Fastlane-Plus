import { createLocalStore } from '@chrome-extension-toolkit';
import type { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import type { RoadmapEntry } from '../core/planning';
import type { PlanMeta } from '../core/plans';
import { FastlanePlanStore } from '../storage/stores';

export interface ScheduleSnapshot {
    id: string;
    at: number;
    schedules: Awaited<ReturnType<typeof UserScheduleStore.all>>['schedules'];
    plans: Record<string, PlanMeta>;
    change: string;
}
export const PlanningStore = createLocalStore<{
    roadmap: RoadmapEntry[];
    onboarded: boolean;
    rules: Record<string, string>;
}>('FastlanePlanning', { roadmap: [], onboarded: false, rules: {} });
export const HistoryStore = createLocalStore<{ snapshots: ScheduleSnapshot[] }>('FastlaneHistory', { snapshots: [] });

/** Single background writer, bounded local history. Academic audits and registration queues never enter it. */
export function registerHistory() {
    let pending = Promise.resolve();
    let generation = 0;
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== 'fastlane-clear-history' || sender.id !== chrome.runtime.id) return false;
        generation++;
        pending = pending
            .then(() => HistoryStore.set('snapshots', []))
            .then(() => {
                respond({ ok: true });
            })
            .catch(() => {
                respond({ ok: false });
            });
        return true;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        const change = changes.schedules;
        if (area !== 'local' || !change || !Array.isArray(change.oldValue) || !Array.isArray(change.newValue)) return;
        const before = change.oldValue as ScheduleSnapshot['schedules'];
        const after = change.newValue as ScheduleSnapshot['schedules'];
        const content = (s: ScheduleSnapshot['schedules']) =>
            JSON.stringify(s.map(v => ({ id: v.id, name: v.name, courses: v.courses })));
        if (content(before) === content(after)) return;
        const eventGeneration = generation;
        pending = pending
            .then(async () => {
                if (eventGeneration !== generation) return;
                // Clear-all must not resurrect history from an event already in flight.
                const current = await chrome.storage.local.get('schedules');
                if (!Array.isArray(current.schedules)) return;
                const added = after.flatMap(s =>
                    s.courses.filter(
                        c => !before.find(b => b.id === s.id)?.courses.some(b => b.uniqueId === c.uniqueId)
                    )
                );
                const removed = before.flatMap(s =>
                    s.courses.filter(c => !after.find(b => b.id === s.id)?.courses.some(b => b.uniqueId === c.uniqueId))
                );
                const snapshot: ScheduleSnapshot = {
                    id: crypto.randomUUID(),
                    at: Date.now(),
                    schedules: before,
                    plans: (await FastlanePlanStore.get('plans')) as Record<string, PlanMeta>,
                    change: `${added.length} classes added · ${removed.length} removed · ${after.length} schedules`,
                };
                const snapshots = await HistoryStore.get('snapshots');
                if (eventGeneration !== generation) return;
                await HistoryStore.set('snapshots', [snapshot, ...snapshots].slice(0, 30) as never);
            })
            .catch(() => {
                /* No academic data in logs. The next edit can retry. */
            });
    });
}

/** The background serializes deletion behind pending writes, so deleting data cannot revive old snapshots. */
export async function clearPlanningHistory() {
    const result = await chrome.runtime.sendMessage({ type: 'fastlane-clear-history' });
    if (!result?.ok) throw new Error('Could not clear schedule history. Please retry.');
}
