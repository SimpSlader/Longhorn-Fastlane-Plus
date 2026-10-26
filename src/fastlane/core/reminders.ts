/**
 * Registration reminders. Pure scheduling math; the background worker turns the result into
 * chrome.alarms and chrome.notifications. Nothing leaves the browser.
 */
import { TZDate } from '@date-fns/tz';

export interface RegistrationWindow {
    /** YYYY-MM-DD */
    date: string;
    /** HH:MM, 24-hour */
    time: string;
    /** IANA zone; UT registration times are published in Central time */
    timeZone: string;
}

export type TaskKey = 'review-backups' | 'verify-degree' | 'confirm-queue';

export interface TaskReminder {
    enabled: boolean;
    /** minutes before registration opens */
    minutesBefore: number;
}

export interface ReminderConfig {
    enabled: boolean;
    window: RegistrationWindow | null;
    /** minutes before the window, e.g. [1440, 60, 10] */
    offsets: number[];
    tasks: Record<TaskKey, TaskReminder>;
}

export const DEFAULT_OFFSETS = [24 * 60, 60, 10];

export const TASK_LABELS: Record<TaskKey, { title: string; message: string }> = {
    'review-backups': {
        title: 'Review your backup classes',
        message: 'Check that every planned class has ranked backups before registration opens.',
    },
    'verify-degree': {
        title: 'Verify your degree progress',
        message: 'Re-import your latest degree audit so recommendations match your remaining requirements.',
    },
    'confirm-queue': {
        title: 'Confirm your registration queue',
        message: 'Confirm the order of unique numbers in your Fastlane queue.',
    },
};

export function defaultReminderConfig(): ReminderConfig {
    return {
        enabled: false,
        window: null,
        offsets: [...DEFAULT_OFFSETS],
        tasks: {
            'review-backups': { enabled: true, minutesBefore: 2 * 24 * 60 },
            'verify-degree': { enabled: false, minutesBefore: 3 * 24 * 60 },
            'confirm-queue': { enabled: true, minutesBefore: 120 },
        },
    };
}

export class ReminderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReminderError';
    }
}

export function isValidTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** Converts the student's wall-clock registration time in `timeZone` to epoch ms (DST-aware). */
export function windowToEpoch(window: RegistrationWindow): number {
    const d = window.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const t = window.time.match(/^(\d{2}):(\d{2})$/);
    if (!d || !t) throw new ReminderError('Use a date like 2026-11-09 and a time like 08:00');
    if (!isValidTimeZone(window.timeZone)) throw new ReminderError(`Unknown time zone ${window.timeZone}`);
    const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const [hour, minute] = [Number(t[1]), Number(t[2])];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
        throw new ReminderError('Date or time is out of range');
    }
    const date = new TZDate(year, month - 1, day, hour, minute, 0, window.timeZone);
    if (date.getDate() !== day) throw new ReminderError('That date does not exist');
    return date.getTime();
}

export interface PlannedReminder {
    /** stable alarm name; all start with "fastlane-reminder:" */
    id: string;
    when: number;
    title: string;
    message: string;
    kind: 'registration' | TaskKey;
}

export const ALARM_PREFIX = 'fastlane-reminder:';

export function describeOffset(minutes: number): string {
    if (minutes === 0) return 'now';
    if (minutes % (24 * 60) === 0) {
        const d = minutes / (24 * 60);
        return `${d} day${d === 1 ? '' : 's'}`;
    }
    if (minutes % 60 === 0) {
        const h = minutes / 60;
        return `${h} hour${h === 1 ? '' : 's'}`;
    }
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Every future reminder for this config, soonest first. Past reminders are dropped. */
export function planReminders(config: ReminderConfig, now = Date.now()): PlannedReminder[] {
    if (!config.enabled || !config.window) return [];
    const opens = windowToEpoch(config.window);
    const out: PlannedReminder[] = [];
    const offsets = [...new Set(config.offsets.filter(o => Number.isFinite(o) && o >= 0))];
    for (const offset of offsets) {
        out.push({
            id: `${ALARM_PREFIX}registration:${offset}`,
            when: opens - offset * 60_000,
            title: offset === 0 ? 'Registration is open' : `Registration opens in ${describeOffset(offset)}`,
            message: 'Open the Fastlane assistant on UT’s registration page. You submit each request yourself.',
            kind: 'registration',
        });
    }
    for (const [key, task] of Object.entries(config.tasks) as Array<[TaskKey, TaskReminder]>) {
        if (!task.enabled) continue;
        out.push({
            id: `${ALARM_PREFIX}${key}`,
            when: opens - task.minutesBefore * 60_000,
            title: TASK_LABELS[key].title,
            message: TASK_LABELS[key].message,
            kind: key,
        });
    }
    return out.filter(r => r.when > now).sort((a, b) => a.when - b.when);
}

/**
 * Fills in anything missing from a stored or partially written config (e.g. a fresh profile where the
 * window was saved before defaults were written), so scheduling never silently fails.
 */
export function normalizeReminderConfig(raw: Partial<ReminderConfig> | null | undefined): ReminderConfig {
    const base = defaultReminderConfig();
    if (!raw || typeof raw !== 'object') return base;
    const tasks = { ...base.tasks };
    for (const key of Object.keys(base.tasks) as TaskKey[]) {
        const t = raw.tasks?.[key];
        if (t && typeof t.enabled === 'boolean' && Number.isFinite(t.minutesBefore)) tasks[key] = t;
    }
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
        window:
            raw.window && typeof raw.window.date === 'string' && typeof raw.window.time === 'string'
                ? raw.window
                : base.window,
        offsets: Array.isArray(raw.offsets) ? raw.offsets.filter(o => Number.isFinite(o) && o >= 0) : base.offsets,
        tasks,
    };
}

export function isReminderConfig(value: unknown): value is ReminderConfig {
    const v = value as ReminderConfig;
    return (
        !!v &&
        typeof v.enabled === 'boolean' &&
        Array.isArray(v.offsets) &&
        typeof v.tasks === 'object' &&
        (v.window === null || (typeof v.window?.date === 'string' && typeof v.window?.time === 'string'))
    );
}
