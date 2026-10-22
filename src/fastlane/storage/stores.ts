/**
 * Fastlane persistence.
 *
 * - FastlaneSettingsStore → chrome.storage.sync: small preferences only (no academic data).
 * - Everything about the student (plans, backups, queue, audit, reminders) → chrome.storage.local,
 *   which never leaves this browser profile.
 */
import { createLocalStore, createSyncStore } from '@chrome-extension-toolkit';

import type { ParsedAudit } from '../audit/types';
import type { AutofillSettings } from '../core/autofill';
import { DEFAULT_AUTOFILL } from '../core/autofill';
import type { GradeThreshold } from '../core/grades';
import { DEFAULT_GRADE_THRESHOLD } from '../core/grades';
import type { PlanMeta } from '../core/plans';
import type { QueueState } from '../core/queue';
import { defaultQueue } from '../core/queue';
import type { ReminderConfig } from '../core/reminders';
import { defaultReminderConfig } from '../core/reminders';

export interface FastlaneSettings {
    gradeThreshold: GradeThreshold;
    showInlineGrades: boolean;
    highlightAsync: boolean;
    showConflictDetails: boolean;
    showAssistant: boolean;
    /** read visible UT result messages and SUGGEST an outcome; off until confirmed acceptable */
    passiveDetection: boolean;
    autofill: AutofillSettings;
    preferOnline: boolean;
    preferAsync: boolean;
    avoidFriday: boolean;
    /** optional static dataset update checks */
    dataUpdates: boolean;
    /** "Spring 2027" etc. null = any */
    targetSemester: string | null;
    themePreference: 'system' | 'light' | 'dark';
}

export const DEFAULT_SETTINGS: FastlaneSettings = {
    gradeThreshold: DEFAULT_GRADE_THRESHOLD,
    showInlineGrades: true,
    highlightAsync: true,
    showConflictDetails: true,
    showAssistant: true,
    passiveDetection: false,
    autofill: DEFAULT_AUTOFILL,
    preferOnline: false,
    preferAsync: false,
    avoidFriday: false,
    dataUpdates: true,
    targetSemester: null,
    themePreference: 'system',
};

export const FastlaneSettingsStore = createSyncStore<FastlaneSettings>('FastlaneSettings', DEFAULT_SETTINGS);

interface PlanStoreShape {
    /** keyed by UT Registration Plus schedule id */
    plans: Record<string, PlanMeta>;
}

export const FastlanePlanStore = createLocalStore<PlanStoreShape>('FastlanePlans', { plans: {} });

interface QueueStoreShape {
    queue: QueueState;
    /** last code Fastlane itself placed in UT's field (so we never clobber typed input) */
    lastFilled: string | null;
}

export const FastlaneQueueStore = createLocalStore<QueueStoreShape>('FastlaneQueue', {
    queue: defaultQueue(),
    lastFilled: null,
});

interface AuditStoreShape {
    audit: ParsedAudit | null;
}

export const FastlaneAuditStore = createLocalStore<AuditStoreShape>('FastlaneAudit', { audit: null });

interface ReminderStoreShape {
    reminders: ReminderConfig;
}

export const FastlaneReminderStore = createLocalStore<ReminderStoreShape>('FastlaneReminders', {
    reminders: defaultReminderConfig(),
});

/** Every chrome.storage key Fastlane owns (used by "delete my data") */
export const FASTLANE_LOCAL_PREFIXES = [
    'FastlanePlans:',
    'FastlaneQueue:',
    'FastlaneAudit:',
    'FastlaneReminders:',
    'FastlanePlanning:',
    'FastlaneHistory:',
];
export const FASTLANE_SYNC_PREFIXES = ['FastlaneSettings:'];
