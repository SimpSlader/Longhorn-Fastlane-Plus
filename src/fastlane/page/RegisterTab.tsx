import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useState } from 'react';

import type { PlanMeta } from '../core/plans';
import type { Outcome, QueueItem, QueueState } from '../core/queue';
import {
    addItem,
    currentItem,
    defaultQueue,
    emptyQueue,
    moveItem,
    OUTCOME_LABELS,
    progress,
    removeItem,
    resetProgress,
    setCondition,
    updateItem,
} from '../core/queue';
import { describeRequirement } from '../core/requirements';
import { formatUnique } from '../core/sections';
import { FastlanePlanStore, FastlaneQueueStore, FastlaneSettingsStore } from '../storage/stores';
import { CopyButton, PageHead } from './common';
import RemindersPanel from './RemindersPanel';

const UT_REGISTRATION = 'https://utdirect.utexas.edu/registration/chooseSemester.WBX';

function queueFromPlan(plan: PlanMeta): QueueState {
    let q = emptyQueue();
    for (const slot of plan.slots) {
        const group = slot.requirement ? slot.requirement.replace(/\s+/g, '-') : `SLOT-${slot.id.slice(-4)}`;
        for (const c of slot.candidates) {
            try {
                q = addItem(q, {
                    uniqueId: c.uniqueId,
                    label: c.title,
                    courseCode: c.courseCode,
                    group,
                    requirement: slot.requirement,
                });
            } catch {
                /* duplicates are skipped */
            }
        }
    }
    return q;
}

function ItemRow({
    item,
    index,
    queue,
    save,
}: {
    item: QueueItem;
    index: number;
    queue: QueueState;
    save: (q: QueueState) => Promise<void>;
}) {
    const outcome = queue.outcomes[item.id];
    const isCurrent = currentItem(queue)?.id === item.id;
    const [error, setError] = useState<string | null>(null);
    const patch = (p: Partial<QueueItem>) => {
        try {
            void save(updateItem(queue, item.id, p));
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
    };
    return (
        <tr style={isCurrent ? { background: 'var(--accent-soft)' } : undefined}>
            <td className='small muted'>{index + 1}</td>
            <td>
                <input
                    type='text'
                    inputMode='numeric'
                    maxLength={5}
                    defaultValue={formatUnique(item.uniqueId)}
                    aria-label='Unique number'
                    style={{ width: 70 }}
                    className='mono'
                    onBlur={e => {
                        const v = Number(e.target.value);
                        if (/^\d{5}$/.test(e.target.value) && v !== item.uniqueId) patch({ uniqueId: v });
                    }}
                />
                {error && (
                    <div className='small' style={{ color: 'var(--bad)' }}>
                        {error}
                    </div>
                )}
            </td>
            <td>
                <input
                    type='text'
                    defaultValue={item.label}
                    aria-label='Label'
                    onBlur={e => e.target.value !== item.label && patch({ label: e.target.value })}
                />
                <div className='small muted'>{item.courseCode}</div>
            </td>
            <td>
                <input
                    type='text'
                    defaultValue={item.group}
                    aria-label='Group'
                    style={{ width: 90 }}
                    onBlur={e => e.target.value !== item.group && patch({ group: e.target.value })}
                />
            </td>
            <td>
                <input
                    type='text'
                    defaultValue={item.requirement}
                    aria-label='Requirement'
                    style={{ width: 110 }}
                    onBlur={e => e.target.value !== item.requirement && patch({ requirement: e.target.value })}
                />
                <div className='small muted'>{item.requirement ? describeRequirement(item.requirement) : ''}</div>
            </td>
            <td>
                <select
                    value={item.condition ?? ''}
                    aria-label='Condition'
                    onChange={e => patch({ condition: e.target.value || undefined })}
                >
                    <option value=''>Always</option>
                    {queue.conditions.map(c => (
                        <option key={c.key} value={c.key}>
                            If: {c.label}
                        </option>
                    ))}
                </select>
            </td>
            <td>
                {outcome ? (
                    <span className={`chip ${outcome === 'success' ? 'ok' : 'bad'}`}>
                        {OUTCOME_LABELS[outcome as Outcome]}
                    </span>
                ) : isCurrent ? (
                    <span className='chip accent'>Next</span>
                ) : (
                    <span className='small muted'>Pending</span>
                )}
            </td>
            <td>
                <div className='row' style={{ flexWrap: 'nowrap' }}>
                    <CopyButton text={formatUnique(item.uniqueId)} />
                    <button
                        type='button'
                        className='btn sm'
                        disabled={index === 0}
                        aria-label='Move up'
                        onClick={() => void save(moveItem(queue, index, index - 1))}
                    >
                        ↑
                    </button>
                    <button
                        type='button'
                        className='btn sm'
                        disabled={index === queue.items.length - 1}
                        aria-label='Move down'
                        onClick={() => void save(moveItem(queue, index, index + 1))}
                    >
                        ↓
                    </button>
                    <button
                        type='button'
                        className='btn sm danger'
                        aria-label='Remove'
                        onClick={() => void save(removeItem(queue, item.id))}
                    >
                        ✕
                    </button>
                </div>
            </td>
        </tr>
    );
}

export default function RegisterTab() {
    const queue = FastlaneQueueStore.useStore(s => s.queue) as unknown as QueueState;
    const settings = FastlaneSettingsStore.useStore(s => s);
    const plans = FastlanePlanStore.useStore(s => s.plans ?? {}) as unknown as Record<string, PlanMeta>;
    const schedule = useActiveSchedule();
    const [draft, setDraft] = useState({ uniqueId: '', label: '', group: '', requirement: '' });
    const [conditionLabel, setConditionLabel] = useState('');
    const [error, setError] = useState<string | null>(null);
    const save = async (q: QueueState) => FastlaneQueueStore.set('queue', q as never);
    const stats = progress(queue);
    const plan = schedule ? plans[schedule.id] : undefined;

    const add = () => {
        try {
            if (!/^\d{5}$/.test(draft.uniqueId)) throw new Error('Enter a five-digit unique number');
            void save(
                addItem(queue, {
                    ...draft,
                    uniqueId: Number(draft.uniqueId),
                    label: draft.label || `Unique ${draft.uniqueId}`,
                })
            );
            setDraft({ uniqueId: '', label: '', group: draft.group, requirement: draft.requirement });
            setError(null);
        } catch (e) {
            setError((e as Error).message);
        }
    };

    return (
        <div className='stack'>
            <PageHead
                title='Registration prep'
                subtitle={
                    <>
                        Your priority queue for the floating assistant on UT’s registration page. You copy (or
                        optionally autofill) and submit every request yourself —{' '}
                        <a
                            href='https://registrar.utexas.edu/schedules/272/whentoregister'
                            target='_blank'
                            rel='noopener'
                        >
                            UT prohibits automated add/drop programs
                        </a>
                        .
                    </>
                }
                actions={
                    <a className='btn primary' href={UT_REGISTRATION} target='_blank' rel='noopener'>
                        Open UT registration ↗
                    </a>
                }
            />
            <div className='metrics'>
                <div className='metric'>
                    <b>{currentItem(queue) ? formatUnique(currentItem(queue)!.uniqueId) : '—'}</b>
                    <span>next unique number</span>
                </div>
                <div className='metric'>
                    <b>{stats.success}</b>
                    <span>added</span>
                </div>
                <div className='metric'>
                    <b>{stats.failed}</b>
                    <span>full / blocked / skipped</span>
                </div>
                <div className='metric'>
                    <b>{stats.remaining}</b>
                    <span>still to try</span>
                </div>
            </div>
            <div className='card stack'>
                <div className='row between'>
                    <h2>Priority queue</h2>
                    <div className='row'>
                        {plan && plan.slots.length > 0 && (
                            <button
                                type='button'
                                className='btn sm'
                                onClick={() => {
                                    if (
                                        confirm(
                                            'Replace the queue with your active schedule’s classes and ranked backups?'
                                        )
                                    )
                                        void save(queueFromPlan(plan));
                                }}
                            >
                                Build from schedule + backups
                            </button>
                        )}
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() =>
                                confirm('Restore the original Fastlane example queue?') && void save(defaultQueue())
                            }
                        >
                            Restore example queue
                        </button>
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() =>
                                confirm('Clear all attempt results and history?') && void save(resetProgress(queue))
                            }
                        >
                            Reset progress
                        </button>
                    </div>
                </div>
                <p className='small muted' style={{ margin: 0 }}>
                    Items in the same group are alternatives: once one succeeds, the rest of that group is skipped. When
                    every item in a group fails, the assistant offers degree-relevant recommendations for that group’s
                    requirement.
                </p>
                <div style={{ overflowX: 'auto' }}>
                    <table className='list'>
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Unique</th>
                                <th>Class</th>
                                <th>Group</th>
                                <th>Requirement</th>
                                <th>Condition</th>
                                <th>Status</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {queue.items.map((item, i) => (
                                <ItemRow
                                    key={`${item.id}-${item.uniqueId}`}
                                    item={item}
                                    index={i}
                                    queue={queue}
                                    save={save}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
                <div className='row'>
                    <input
                        type='text'
                        className='mono'
                        placeholder='Unique #'
                        maxLength={5}
                        inputMode='numeric'
                        style={{ width: 90 }}
                        value={draft.uniqueId}
                        onChange={e => setDraft({ ...draft, uniqueId: e.target.value.replace(/\D/g, '') })}
                        aria-label='New unique number'
                    />
                    <input
                        type='text'
                        placeholder='Class name'
                        value={draft.label}
                        onChange={e => setDraft({ ...draft, label: e.target.value })}
                        aria-label='New class name'
                    />
                    <input
                        type='text'
                        placeholder='Group (e.g. ARTS)'
                        style={{ width: 130 }}
                        value={draft.group}
                        onChange={e => setDraft({ ...draft, group: e.target.value })}
                        aria-label='New group'
                    />
                    <input
                        type='text'
                        placeholder='Requirement (e.g. CORE 050)'
                        style={{ width: 170 }}
                        value={draft.requirement}
                        onChange={e => setDraft({ ...draft, requirement: e.target.value })}
                        aria-label='New requirement'
                    />
                    <button type='button' className='btn primary' onClick={add}>
                        Add
                    </button>
                </div>
                {error && <div className='notice bad small'>{error}</div>}
                <div className='stack' style={{ gap: 6 }}>
                    <h3>Conditions</h3>
                    {queue.conditions.map(c => (
                        <label key={c.key} className='check'>
                            <input
                                type='checkbox'
                                checked={c.enabled}
                                onChange={e => void save(setCondition(queue, c.key, e.target.checked))}
                            />
                            {c.label}
                        </label>
                    ))}
                    <div className='row'>
                        <input
                            type='text'
                            placeholder='New condition, e.g. “Did not pass AP exam”'
                            value={conditionLabel}
                            onChange={e => setConditionLabel(e.target.value)}
                            style={{ minWidth: 280 }}
                        />
                        <button
                            type='button'
                            className='btn sm'
                            disabled={!conditionLabel.trim()}
                            onClick={() => {
                                void save(
                                    setCondition(queue, `c-${Date.now().toString(36)}`, false, conditionLabel.trim())
                                );
                                setConditionLabel('');
                            }}
                        >
                            Add condition
                        </button>
                    </div>
                </div>
            </div>

            <div className='grid2'>
                <div className='card stack'>
                    <h2>Registration autofill</h2>
                    <p className='small muted' style={{ margin: 0 }}>
                        Optional. Fastlane may type the next unique number into UT’s <i>add</i> field. It never clicks
                        Submit, presses Enter, or sends anything; you review and submit each request. Confirm this use
                        is acceptable under current UT policy before enabling.
                    </p>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={settings.autofill.enabled}
                            onChange={e =>
                                void FastlaneSettingsStore.set('autofill', {
                                    ...settings.autofill,
                                    enabled: e.target.checked,
                                    paused: false,
                                })
                            }
                        />
                        <span>
                            Enable registration autofill
                            <small>
                                Off by default. Fills after each Success/Full/Conflict/Restriction you mark, and on page
                                load.
                            </small>
                        </span>
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={settings.autofill.preserveNonEmpty}
                            onChange={e =>
                                void FastlaneSettingsStore.set('autofill', {
                                    ...settings.autofill,
                                    preserveNonEmpty: e.target.checked,
                                })
                            }
                        />
                        <span>
                            Do not overwrite a non-empty registration field
                            <small>Anything you typed yourself is left alone.</small>
                        </span>
                    </label>
                    {settings.autofill.enabled && (
                        <button
                            type='button'
                            className='btn'
                            onClick={() =>
                                void FastlaneSettingsStore.set('autofill', {
                                    ...settings.autofill,
                                    paused: !settings.autofill.paused,
                                })
                            }
                        >
                            {settings.autofill.paused ? 'Resume autofill' : 'Pause autofill'}
                        </button>
                    )}
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={settings.passiveDetection}
                            onChange={e => void FastlaneSettingsStore.set('passiveDetection', e.target.checked)}
                        />
                        <span>
                            Suggest outcomes from UT’s on-screen messages (experimental)
                            <small>
                                Reads only messages already visible after you submit, suggests Success/Full/etc., and
                                waits for your confirmation. Off by default.
                            </small>
                        </span>
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={settings.showAssistant}
                            onChange={e => void FastlaneSettingsStore.set('showAssistant', e.target.checked)}
                        />
                        Show the floating assistant on UT registration pages
                    </label>
                </div>
                <RemindersPanel />
            </div>

            <div className='card'>
                <h2>Attempt history</h2>
                {queue.history.length === 0 ? (
                    <p className='muted small'>No attempts recorded yet.</p>
                ) : (
                    <table className='list'>
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Unique</th>
                                <th>Event</th>
                                <th>Source</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...queue.history]
                                .reverse()
                                .slice(0, 50)
                                .map(h => (
                                    <tr key={`${h.at}-${h.itemId}-${h.action}`}>
                                        <td className='small'>{new Date(h.at).toLocaleString()}</td>
                                        <td className='mono'>{formatUnique(h.uniqueId)}</td>
                                        <td>{h.action}</td>
                                        <td className='small muted'>
                                            {h.source === 'detected' ? 'confirmed from page message' : 'you'}
                                        </td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
