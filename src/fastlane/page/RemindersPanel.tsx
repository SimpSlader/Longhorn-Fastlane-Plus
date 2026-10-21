import { useMemo, useState } from 'react';

import { buildIcs } from '../core/ics';
import type { ReminderConfig, TaskKey } from '../core/reminders';
import { describeOffset, planReminders, TASK_LABELS, windowToEpoch } from '../core/reminders';
import { sendFastlane } from '../services/runtime';
import { FastlaneReminderStore } from '../storage/stores';
import { downloadText } from './common';

const PRESETS = [24 * 60, 60, 10];
const ZONES = [
    'America/Chicago',
    'America/New_York',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'Asia/Kolkata',
    'Asia/Shanghai',
    'Europe/London',
    'UTC',
];

export default function RemindersPanel() {
    const config = FastlaneReminderStore.useStore(s => s.reminders) as unknown as ReminderConfig;
    const [custom, setCustom] = useState('');
    const [customUnit, setCustomUnit] = useState<'minutes' | 'hours' | 'days'>('minutes');
    const [status, setStatus] = useState<string | null>(null);
    const save = (c: ReminderConfig) => FastlaneReminderStore.set('reminders', c as never);
    const window_ = config.window ?? { date: '', time: '08:00', timeZone: 'America/Chicago' };

    const { planned, error } = useMemo(() => {
        try {
            return { planned: planReminders(config), error: null };
        } catch (e) {
            return { planned: [], error: (e as Error).message };
        }
    }, [config]);

    const opens = useMemo(() => {
        try {
            return config.window?.date ? windowToEpoch(config.window) : null;
        } catch {
            return null;
        }
    }, [config.window]);

    const toggleOffset = (m: number) =>
        void save({
            ...config,
            offsets: config.offsets.includes(m)
                ? config.offsets.filter(o => o !== m)
                : [...config.offsets, m].sort((a, b) => b - a),
        });

    return (
        <div className='card stack'>
            <h2>Registration reminders</h2>
            <p className='small muted' style={{ margin: 0 }}>
                Saved only in this browser and scheduled with Chrome alarms. Chrome must be running to show
                notifications.
            </p>
            <div className='row'>
                <label className='field'>
                    Registration date
                    <input
                        type='date'
                        value={window_.date}
                        onChange={e => void save({ ...config, window: { ...window_, date: e.target.value } })}
                    />
                </label>
                <label className='field'>
                    Time
                    <input
                        type='time'
                        value={window_.time}
                        onChange={e => void save({ ...config, window: { ...window_, time: e.target.value } })}
                    />
                </label>
                <label className='field'>
                    Time zone
                    <select
                        value={window_.timeZone}
                        onChange={e => void save({ ...config, window: { ...window_, timeZone: e.target.value } })}
                    >
                        {[...new Set([window_.timeZone, ...ZONES])].map(z => (
                            <option key={z} value={z}>
                                {z}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {opens && (
                <div className='small'>
                    Your registration opens{' '}
                    {new Date(opens).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} (your local
                    time).
                </div>
            )}
            <label className='check'>
                <input
                    type='checkbox'
                    checked={config.enabled}
                    onChange={e => void save({ ...config, enabled: e.target.checked })}
                />
                Turn on reminders
            </label>
            <div className='row'>
                <span className='small muted'>Remind me:</span>
                {[...new Set([...PRESETS, ...config.offsets])]
                    .sort((a, b) => b - a)
                    .map(m => (
                        <label key={m} className='check small'>
                            <input
                                type='checkbox'
                                checked={config.offsets.includes(m)}
                                onChange={() => toggleOffset(m)}
                            />
                            {describeOffset(m)} before
                        </label>
                    ))}
            </div>
            <div className='row'>
                <input
                    type='number'
                    min={0}
                    placeholder='Custom'
                    value={custom}
                    onChange={e => setCustom(e.target.value)}
                    style={{ width: 90 }}
                    aria-label='Custom reminder amount'
                />
                <select
                    value={customUnit}
                    onChange={e => setCustomUnit(e.target.value as typeof customUnit)}
                    aria-label='Custom reminder unit'
                >
                    <option value='minutes'>minutes</option>
                    <option value='hours'>hours</option>
                    <option value='days'>days</option>
                </select>
                <button
                    type='button'
                    className='btn sm'
                    disabled={!custom || Number(custom) < 0}
                    onClick={() => {
                        const m = Number(custom) * (customUnit === 'days' ? 1440 : customUnit === 'hours' ? 60 : 1);
                        if (!config.offsets.includes(m))
                            void save({ ...config, offsets: [...config.offsets, m].sort((a, b) => b - a) });
                        setCustom('');
                    }}
                >
                    Add custom reminder
                </button>
            </div>
            <div className='stack' style={{ gap: 4 }}>
                <span className='small muted'>Preparation reminders</span>
                {(Object.keys(TASK_LABELS) as TaskKey[]).map(k => (
                    <div key={k} className='row'>
                        <label className='check small' style={{ minWidth: 230 }}>
                            <input
                                type='checkbox'
                                checked={config.tasks[k].enabled}
                                onChange={e =>
                                    void save({
                                        ...config,
                                        tasks: {
                                            ...config.tasks,
                                            [k]: { ...config.tasks[k], enabled: e.target.checked },
                                        },
                                    })
                                }
                            />
                            {TASK_LABELS[k].title}
                        </label>
                        <select
                            aria-label={`${TASK_LABELS[k].title} timing`}
                            value={config.tasks[k].minutesBefore}
                            onChange={e =>
                                void save({
                                    ...config,
                                    tasks: {
                                        ...config.tasks,
                                        [k]: { ...config.tasks[k], minutesBefore: Number(e.target.value) },
                                    },
                                })
                            }
                        >
                            {[30, 60, 120, 1440, 2880, 4320, 10080].map(m => (
                                <option key={m} value={m}>
                                    {describeOffset(m)} before
                                </option>
                            ))}
                        </select>
                    </div>
                ))}
            </div>
            {error && <div className='notice bad small'>{error}</div>}
            {config.enabled && planned.length > 0 && (
                <div className='small'>
                    <b>Scheduled:</b>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {planned.map(r => (
                            <li key={r.id}>
                                {new Date(r.when).toLocaleString()} — {r.title}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <div className='row'>
                <button
                    type='button'
                    className='btn sm'
                    onClick={() =>
                        void sendFastlane({ type: 'testNotification' })
                            .then(() =>
                                setStatus(
                                    'Test notification sent. If nothing appeared, allow Chrome notifications in your system settings.'
                                )
                            )
                            .catch(e => setStatus((e as Error).message))
                    }
                >
                    Send test notification
                </button>
                <button
                    type='button'
                    className='btn sm'
                    disabled={!opens}
                    onClick={() =>
                        opens &&
                        downloadText(
                            buildIcs([
                                {
                                    uid: `ut-registration-${opens}@fastlane.local`,
                                    start: opens,
                                    durationMinutes: 30,
                                    summary: 'UT registration opens',
                                    description:
                                        'Open the Fastlane assistant on UT’s registration page. Submit each request yourself.',
                                    url: 'https://utdirect.utexas.edu/registration/chooseSemester.WBX',
                                    alarms: config.offsets,
                                },
                            ]),
                            'ut-registration.ics',
                            'text/calendar'
                        )
                    }
                >
                    Export .ics
                </button>
            </div>
            {status && <div className='small muted'>{status}</div>}
        </div>
    );
}
