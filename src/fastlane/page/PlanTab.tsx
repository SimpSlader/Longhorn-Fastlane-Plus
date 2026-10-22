/**
 * Schedule builder with dedicated backup management.
 * Active sections live in the UT Registration Plus schedule (calendar, credit hours, conflicts);
 * ranked backups live here and never count until activated.
 */
import { switchSchedule, useActiveSchedule, useAllSchedules } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useState } from 'react';
import ExportIcon from '~icons/ph/export';
import PlusCircleIcon from '~icons/ph/plus-circle';
import { formatMeeting } from '../core/meetings';
import type { PlanKind, PlanMeta, PlanSlot } from '../core/plans';
import {
    activeConflicts,
    activeSections,
    allAlternativesExhausted,
    backupsOf,
    clearFull,
    nextBackup,
    previewActivation,
    promoteToPrimary,
    totalCreditHours,
} from '../core/plans';
import { CORE_COMPONENTS, coreTag, describeRequirement } from '../core/requirements';
import type { SectionRecord } from '../core/sections';
import { activateSection, loadPlan, planOps, setPlanKind, updatePlan } from '../services/planService';
import { exportAll } from '../services/privacy';
import { FastlanePlanStore, FastlaneSettingsStore } from '../storage/stores';
import { CodeChip, downloadText, GradeChip, ModalityChip, sectionColor } from './common';
import { useGradeStats } from './hooks';
import WeekGrid, { blockTitle } from './WeekGrid';

const KIND_LABELS: Record<PlanKind, string> = {
    ideal: 'Ideal schedule',
    backup: 'Backup schedule',
    custom: 'Custom schedule',
};

function RequirementPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const known = CORE_COMPONENTS.map(c => coreTag(c.code));
    const custom = value && !known.includes(value);
    return (
        <select aria-label='Requirement this class satisfies' value={value} onChange={e => onChange(e.target.value)}>
            <option value=''>No requirement</option>
            {CORE_COMPONENTS.map(c => (
                <option key={c.code} value={coreTag(c.code)}>
                    {c.name} (Core {c.code})
                </option>
            ))}
            {custom && <option value={value}>{describeRequirement(value)}</option>}
        </select>
    );
}

function SlotCard({
    plan,
    slot,
    onNavigate,
    grades,
    onError,
    colorIndex,
}: {
    plan: PlanMeta;
    slot: PlanSlot;
    colorIndex: number;
    onNavigate: (tab: string, params?: Record<string, string>) => void;
    grades: ReturnType<typeof useGradeStats>;
    onError: (m: string) => void;
}) {
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dropAt, setDropAt] = useState<number | null>(null);
    const suggestion = slot.activeUniqueId in slot.full ? nextBackup(slot) : null;
    const exhausted = allAlternativesExhausted(slot);
    const sid = plan.scheduleId;
    const run = (p: Promise<unknown>) => p.catch((e: Error) => onError(e.message));

    const active = slot.candidates.find(c => c.uniqueId === slot.activeUniqueId)!;
    const activeIndex = slot.candidates.indexOf(active);
    const color = sectionColor(active, colorIndex);

    const candidateRow = (c: SectionRecord, index: number) => {
        const isFull = c.uniqueId in slot.full;
        const backupIndex = index - 1;
        const preview = previewActivation(plan, slot.id, c.uniqueId);
        return (
            // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop reordering; keyboard users have the ↑/↓ buttons in this row
            <div
                key={c.uniqueId}
                className={`cand ${isFull ? 'is-full' : ''} ${dragFrom === backupIndex ? 'dragging' : ''} ${dropAt === backupIndex && dragFrom !== null ? 'drop-target' : ''}`}
                draggable={index > 0}
                onDragStart={e => {
                    setDragFrom(backupIndex);
                    e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={e => {
                    if (index > 0 && dragFrom !== null) {
                        e.preventDefault();
                        setDropAt(backupIndex);
                    }
                }}
                onDragEnd={() => {
                    setDragFrom(null);
                    setDropAt(null);
                }}
                onDrop={e => {
                    e.preventDefault();
                    if (dragFrom !== null && index > 0 && dragFrom !== backupIndex) {
                        void run(planOps.reorder(sid, slot.id, dragFrom, backupIndex));
                    }
                    setDragFrom(null);
                    setDropAt(null);
                }}
            >
                <div className='handle' title={index > 0 ? 'Drag to reorder backups' : 'Primary'}>
                    {index > 0 ? '⋮⋮' : ''}
                </div>
                <div className='swatch' style={{ background: color }} />
                <div className='cand-main stack' style={{ gap: 2 }}>
                    <div className='row'>
                        <span className={`chip ${index === 0 ? 'accent' : 'backup'}`}>
                            {index === 0 ? 'Primary' : `Backup ${index}`}
                        </span>
                        <span className='title'>{blockTitle(c)}</span>
                        <span className='muted small'>{c.title}</span>
                        {isFull && <span className='chip bad'>Full</span>}
                        <ModalityChip modality={c.modality} />
                        <GradeChip stat={grades.get(c.uniqueId)} />
                    </div>
                    <div className='small muted'>
                        {c.meetings.length
                            ? c.meetings.map(formatMeeting).join('; ')
                            : c.modality === 'async-online'
                              ? 'Asynchronous — no meeting times'
                              : 'Times not listed'}{' '}
                        · {c.creditHours} hrs
                    </div>
                    {preview.status === 'conflict' && (
                        <div className='small' style={{ color: 'var(--bad)' }}>
                            If activated, conflicts with {preview.conflicts.map(x => x.with.label).join(', ')}
                        </div>
                    )}
                    {preview.status === 'unknown' && (
                        <div className='small' style={{ color: 'var(--warn)' }}>
                            If activated, conflict status unknown
                        </div>
                    )}
                </div>
                <div className='row' style={{ justifyContent: 'flex-end' }}>
                    <CodeChip id={c.uniqueId} />
                    <button
                        type='button'
                        className='btn sm outline-accent'
                        onClick={() => void run(activateSection(sid, slot.id, c.uniqueId))}
                    >
                        Activate
                    </button>
                    {isFull ? (
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() => void run(updatePlan(sid, p => clearFull(p, slot.id, c.uniqueId)))}
                        >
                            Not full
                        </button>
                    ) : (
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() => void run(planOps.markFull(sid, slot.id, c.uniqueId))}
                        >
                            Mark full
                        </button>
                    )}
                    {index > 1 && (
                        <button
                            type='button'
                            className='btn sm'
                            aria-label={`Move ${c.courseCode} up`}
                            onClick={() => void run(planOps.reorder(sid, slot.id, backupIndex, backupIndex - 1))}
                        >
                            ↑
                        </button>
                    )}
                    {index > 0 && index < slot.candidates.length - 1 && (
                        <button
                            type='button'
                            className='btn sm'
                            aria-label={`Move ${c.courseCode} down`}
                            onClick={() => void run(planOps.reorder(sid, slot.id, backupIndex, backupIndex + 1))}
                        >
                            ↓
                        </button>
                    )}
                    {index > 0 && (
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() => void run(updatePlan(sid, p => promoteToPrimary(p, slot.id, c.uniqueId)))}
                        >
                            Make primary
                        </button>
                    )}
                    <button
                        type='button'
                        className='btn sm ghost danger'
                        aria-label={`Remove ${c.courseCode}`}
                        onClick={() => void run(planOps.remove(sid, slot.id, c.uniqueId))}
                    >
                        Remove
                    </button>
                </div>
            </div>
        );
    };

    const activeFull = active.uniqueId in slot.full;

    return (
        <div className='slot' data-testid='slot'>
            <div className='slot-primary' style={{ background: color }}>
                <div className='strip' />
                <div className='body'>
                    <span className='title'>
                        {blockTitle(active)} {activeFull && <span className='chip'>Full</span>}
                    </span>
                    <span className='sub'>
                        {active.title} ·{' '}
                        {active.meetings.length
                            ? active.meetings.map(formatMeeting).join('; ')
                            : active.modality === 'async-online'
                              ? 'Asynchronous'
                              : 'Times not listed'}
                    </span>
                    <span className='row' style={{ gap: 6, marginTop: 3 }}>
                        <span className='chip'>
                            {activeIndex === 0 ? 'Active · primary' : `Active · backup ${activeIndex}`}
                        </span>
                        {active.modality === 'async-online' && <span className='chip'>Async online</span>}
                        {active.modality === 'live-online' && <span className='chip'>Live online</span>}
                        <GradeChip stat={grades.get(active.uniqueId)} />
                    </span>
                </div>
                <div className='actions'>
                    <CodeChip id={active.uniqueId} onColor />
                    {activeFull ? (
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() => void run(updatePlan(sid, p => clearFull(p, slot.id, active.uniqueId)))}
                        >
                            Not full
                        </button>
                    ) : (
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() => void run(planOps.markFull(sid, slot.id, active.uniqueId))}
                        >
                            Mark full
                        </button>
                    )}
                </div>
            </div>
            <div className='slot-meta'>
                <RequirementPicker
                    value={slot.requirement}
                    onChange={v => void run(planOps.setRequirement(sid, slot.id, v))}
                />
                <span className='small muted'>
                    {backupsOf(slot).length} ranked backup{backupsOf(slot).length === 1 ? '' : 's'} · not on your
                    calendar until activated
                </span>
                <span style={{ flex: 1 }} />
                {suggestion && (
                    <button
                        type='button'
                        className='btn sm primary'
                        onClick={() => void run(activateSection(sid, slot.id, suggestion.uniqueId))}
                    >
                        Full → activate {suggestion.courseCode} ({String(suggestion.uniqueId).padStart(5, '0')})
                    </button>
                )}
                {(exhausted || backupsOf(slot).length === 0) && slot.requirement && (
                    <button
                        type='button'
                        className='btn sm'
                        onClick={() => onNavigate('recommend', { req: slot.requirement })}
                    >
                        Find {describeRequirement(slot.requirement)} options
                    </button>
                )}
            </div>
            {slot.candidates.map((c, i) => (c.uniqueId === slot.activeUniqueId ? null : candidateRow(c, i)))}
            {backupsOf(slot).length === 0 && (
                <div className='small muted' style={{ padding: '10px 14px' }}>
                    No backups yet. On UT’s course schedule, click <b>+ Backup</b> on any section, or add one from
                    Recommendations.
                </div>
            )}
        </div>
    );
}

export default function PlanTab({
    onNavigate,
}: {
    onNavigate: (tab: string, params?: Record<string, string>) => void;
}) {
    const schedule = useActiveSchedule();
    const schedules = useAllSchedules();
    const plans = FastlanePlanStore.useStore(s => s.plans ?? {}) as unknown as Record<string, PlanMeta>;
    const threshold = FastlaneSettingsStore.useStore(s => s.gradeThreshold);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (schedule) void loadPlan(schedule);
    }, [schedule]);

    const plan = schedule ? plans[schedule.id] : undefined;
    const allSections = useMemo(() => plan?.slots.flatMap(s => s.candidates) ?? [], [plan]);
    const grades = useGradeStats(allSections, threshold);
    const active = plan ? activeSections(plan) : [];
    const conflicts = plan ? activeConflicts(plan) : [];
    const untimed = active.filter(s => !s.meetings.length);
    const backupCount = plan?.slots.reduce((n, s) => n + s.candidates.length - 1, 0) ?? 0;

    return (
        <div className='stack'>
            <div className='page-head'>
                <div>
                    <h1>{schedule?.name ?? 'Schedule'}</h1>
                    <div className='counts'>
                        <span>{plan ? totalCreditHours(plan) : 0} hours</span>
                        <span>{active.length} courses</span>
                        {backupCount > 0 && <span style={{ color: 'var(--muted)' }}>{backupCount} backups</span>}
                    </div>
                </div>
                <div className='toolbar'>
                    {plan && (
                        <select
                            aria-label='Schedule type'
                            value={plan.kind}
                            onChange={e => void setPlanKind(plan.scheduleId, e.target.value as PlanKind)}
                        >
                            <option value='ideal'>Ideal schedule</option>
                            <option value='backup'>Backup schedule</option>
                            <option value='custom'>Custom schedule</option>
                        </select>
                    )}
                    <span className='sep' />
                    <a
                        className='tool'
                        href='https://utdirect.utexas.edu/apps/registrar/course_schedule/'
                        target='_blank'
                        rel='noopener'
                    >
                        <PlusCircleIcon /> Browse UT classes
                    </a>
                    <button
                        type='button'
                        className='tool'
                        onClick={async () =>
                            downloadText(
                                JSON.stringify(await exportAll(false), null, 2),
                                `fastlane-${schedule?.name ?? 'schedule'}.json`
                            )
                        }
                    >
                        <ExportIcon /> Export
                    </button>
                </div>
            </div>
            <section className='card stack'>
                <div className='row between'>
                    <div>
                        <h2>Saved mock schedules</h2>
                        <p className='small muted'>Select a schedule to see its calendar here. Your other drafts remain saved.</p>
                    </div>
                    <button type='button' className='btn sm' onClick={() => onNavigate('finder')}>Find classes</button>
                </div>
                <div className='saved-schedules' role='group' aria-label='Saved schedule scenarios'>
                    {schedules.map(s => (
                        <button
                            type='button'
                            key={s.id}
                            aria-pressed={schedule?.id === s.id}
                            onClick={() => void switchSchedule(s.id)}
                        >
                            <b>{s.name}</b>
                            <span>{s.courses.length} classes</span>
                        </button>
                    ))}
                </div>
            </section>
            <WeekGrid sections={active} />
            {conflicts.length === 0 && untimed.some(s => !s.scheduleComplete && s.modality !== 'async-online') && (
                <div className='notice warn small'>
                    Some classes have incomplete meeting times, so conflicts with them cannot be ruled out.
                </div>
            )}
            {error && (
                <div className='notice bad' role='alert'>
                    {error}{' '}
                    <button type='button' className='btn sm ghost' onClick={() => setError(null)}>
                        Dismiss
                    </button>
                </div>
            )}
            {conflicts.length > 0 && (
                <div className='notice bad'>
                    Conflicts in the active schedule: {conflicts.map(([a, b]) => `${a.label} ↔ ${b.label}`).join('; ')}
                </div>
            )}
            {active.length === 0 ? (
                <div className='notice small'>
                    No classes in this draft yet. Use Find classes to add sections, or select another saved
                    schedule above. The weekly calendar stays visible even when a draft is empty.
                </div>
            ) : (
                <>
                    <div className='section-title'>Planned classes &amp; backups</div>
                    <div className='stack'>
                        {plan?.slots.map((slot, i) => (
                            <SlotCard
                                key={slot.id}
                                plan={plan}
                                slot={slot}
                                colorIndex={i}
                                grades={grades}
                                onNavigate={onNavigate}
                                onError={setError}
                            />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
