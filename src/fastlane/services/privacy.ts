/**
 * Export / import / delete of everything Fastlane stores. All local; nothing is sent anywhere.
 */
import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import type { ParsedAudit } from '../audit/types';
import type { PlanMeta } from '../core/plans';
import type { QueueState } from '../core/queue';
import { emptyQueue, isQueueState } from '../core/queue';
import type { ReminderConfig } from '../core/reminders';
import { defaultReminderConfig, isReminderConfig } from '../core/reminders';
import { idbClearAll } from '../data/idb';
import type { FastlaneSettings } from '../storage/stores';
import {
    DEFAULT_SETTINGS,
    FASTLANE_LOCAL_PREFIXES,
    FastlaneAuditStore,
    FastlanePlanStore,
    FastlaneQueueStore,
    FastlaneReminderStore,
    FastlaneSettingsStore,
} from '../storage/stores';
import { clearPlanningHistory, PlanningStore } from './history';

export const EXPORT_FORMAT = 'fastlane-course-planner-export';
/** exports created before the rename */
export const LEGACY_EXPORT_FORMATS = ['longhorn-fastlane-export'];

export interface FastlaneExport {
    format: typeof EXPORT_FORMAT;
    version: 1;
    exportedAt: string;
    schedules: unknown[];
    activeIndex: number;
    plans: Record<string, PlanMeta>;
    queue: QueueState;
    reminders: ReminderConfig;
    settings: FastlaneSettings;
    audit?: ParsedAudit | null;
}

export class ImportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImportError';
    }
}

/** Validates an imported file. Unknown/extra fields are dropped; settings are merged onto defaults. */
export function validateExport(json: unknown): FastlaneExport {
    const d = json as Partial<FastlaneExport>;
    if (
        !d ||
        typeof d !== 'object' ||
        (d.format !== EXPORT_FORMAT && !LEGACY_EXPORT_FORMATS.includes(String(d.format)))
    )
        throw new ImportError('This is not a Fastlane Course Planner export file.');
    if (d.version !== 1) throw new ImportError(`Unsupported export version ${String(d.version)}.`);
    if (!Array.isArray(d.schedules)) throw new ImportError('Export is missing schedules.');
    for (const s of d.schedules as Array<{ name?: unknown; courses?: unknown }>) {
        if (!s || typeof s.name !== 'string' || !Array.isArray(s.courses))
            throw new ImportError('A schedule in the file is malformed.');
    }
    if (d.plans && typeof d.plans !== 'object') throw new ImportError('Plans are malformed.');
    for (const p of Object.values(d.plans ?? {})) {
        if (!p || !Array.isArray((p as PlanMeta).slots)) throw new ImportError('A plan in the file is malformed.');
    }
    if (d.queue && !isQueueState(d.queue)) throw new ImportError('The registration queue in the file is malformed.');
    if (d.reminders && !isReminderConfig(d.reminders))
        throw new ImportError('Reminder settings in the file are malformed.');
    return {
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: String(d.exportedAt ?? ''),
        schedules: d.schedules,
        activeIndex: Number.isInteger(d.activeIndex) ? (d.activeIndex as number) : 0,
        plans: (d.plans ?? {}) as Record<string, PlanMeta>,
        queue: d.queue as QueueState,
        reminders: d.reminders as ReminderConfig,
        settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) },
        audit: d.audit ?? null,
    };
}

export async function exportAll(includeAudit: boolean): Promise<FastlaneExport> {
    return {
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        schedules: (await UserScheduleStore.get('schedules')) as unknown[],
        activeIndex: await UserScheduleStore.get('activeIndex'),
        plans: (await FastlanePlanStore.get('plans')) as unknown as Record<string, PlanMeta>,
        queue: (await FastlaneQueueStore.get('queue')) as unknown as QueueState,
        reminders: (await FastlaneReminderStore.get('reminders')) as unknown as ReminderConfig,
        settings: (await FastlaneSettingsStore.all()) as unknown as FastlaneSettings,
        audit: includeAudit ? ((await FastlaneAuditStore.get('audit')) as ParsedAudit | null) : undefined,
    };
}

export async function importAll(data: FastlaneExport): Promise<void> {
    if (data.schedules.length) {
        await UserScheduleStore.set('schedules', data.schedules as never);
        await UserScheduleStore.set('activeIndex', Math.min(data.activeIndex, data.schedules.length - 1));
    }
    await FastlanePlanStore.set('plans', data.plans as never);
    if (data.queue) await FastlaneQueueStore.set('queue', data.queue as never);
    if (data.reminders) await FastlaneReminderStore.set('reminders', data.reminders as never);
    await FastlaneSettingsStore.set(data.settings as never);
    if (data.audit !== undefined) await FastlaneAuditStore.set('audit', data.audit as never);
}

/** Deletes Fastlane's own data (plans, backups, queue, audit, reminders, settings, caches) and resets to empty defaults. */
export async function deleteFastlaneData(): Promise<void> {
    await PlanningStore.set({ roadmap: [], onboarded: false, rules: {} });
    await clearPlanningHistory();
    // overwrite with empty defaults (rather than removing keys) so open pages never see a missing value
    await FastlanePlanStore.set('plans', {} as never);
    await FastlaneAuditStore.set('audit', null as never);
    await FastlaneQueueStore.set({ queue: emptyQueue(), lastFilled: null } as never);
    await FastlaneReminderStore.set('reminders', defaultReminderConfig() as never);
    await FastlaneSettingsStore.set(DEFAULT_SETTINGS as never);
    // remove any other Fastlane-owned keys (e.g. from older versions)
    const keep = new Set([
        'FastlanePlanning:roadmap',
        'FastlanePlanning:onboarded',
        'FastlanePlanning:rules',
        'FastlaneHistory:snapshots',
        'FastlanePlans:plans',
        'FastlaneAudit:audit',
        'FastlaneQueue:queue',
        'FastlaneQueue:lastFilled',
        'FastlaneReminders:reminders',
    ]);
    const local = await chrome.storage.local.get(null);
    const stale = Object.keys(local).filter(k => FASTLANE_LOCAL_PREFIXES.some(p => k.startsWith(p)) && !keep.has(k));
    if (stale.length) await chrome.storage.local.remove(stale);
    await idbClearAll();
    const alarms = await chrome.alarms.getAll();
    await Promise.all(
        alarms.filter(a => a.name.startsWith('fastlane-reminder:')).map(a => chrome.alarms.clear(a.name))
    );
}

/** Deletes everything this extension stored, including UT Registration Plus schedules. */
export async function deleteEverything(): Promise<void> {
    await clearPlanningHistory();
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await chrome.storage.session?.clear();
    await idbClearAll();
    await chrome.alarms.clearAll();
}
