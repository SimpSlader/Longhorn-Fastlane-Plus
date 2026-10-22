/**
 * Compact, always-visible insights next to UT Registration Plus's grade-graph button:
 *   72.4% A-+ · Prof   |  ASYNC  |  Conflicts: C S 314 (52345)  |  + Backup
 * Rendered inside UTRP's shadow-root portal for the row.
 */
import { background } from '@shared/messages';
import type { Course } from '@shared/types/Course';
import type { UserSchedule } from '@shared/types/UserSchedule';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import CheckIcon from '~icons/ph/check-bold';
import PlusIcon from '~icons/ph/plus-bold';

import { gradeStatFrom, lookupGrades, sectionFromCourse } from '../adapters/utrp';
import type { GradeStat } from '../core/grades';
import { describeGradeStat, formatPercent, thresholdLabel } from '../core/grades';
import type { ConflictResult } from '../core/meetings';
import { conflictingSections, formatMeeting } from '../core/meetings';
import type { ModalityResult } from '../core/modality';
import { DuplicateSectionError, findSection } from '../core/plans';
import type { RmpRating } from '../core/rmp';
import { rmpProfessorUrl, splitProfessorName } from '../core/rmp';
import { addBackupFor, loadPlan } from '../services/planService';
import { sendFastlane } from '../services/runtime';
import { FastlanePlanStore, FastlaneSettingsStore } from '../storage/stores';

interface Props {
    course: Course;
    modality: ModalityResult;
    conflict: ConflictResult | null;
    activeSchedule?: UserSchedule;
    rowAnalysis: Parameters<typeof sectionFromCourse>[1];
}

function GradeChip({ course }: { course: Course }) {
    const threshold = FastlaneSettingsStore.useStore(s => s.gradeThreshold);
    const [raw, setRaw] = useState<Awaited<ReturnType<typeof lookupGrades>> | undefined>(undefined);

    useEffect(() => {
        let alive = true;
        // grade work is deferred to idle time so long listings stay responsive
        const run = () =>
            lookupGrades(course).then(r => {
                if (alive) setRaw(r);
            });
        const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
        if (idle) idle(run);
        else setTimeout(run, 0);
        return () => {
            alive = false;
        };
    }, [course]);

    const stat: GradeStat | null = useMemo(
        () => (raw ? gradeStatFrom(course, raw, threshold) : null),
        [raw, course, threshold]
    );

    if (raw === undefined) {
        return <span className='fl-chip text-[11px] text-gray-400 px-1'>…</span>;
    }
    if (!stat) {
        return (
            <span
                className='inline-flex items-center rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-500 whitespace-nowrap'
                title='No verified historical grade data for this course in the bundled dataset. Nothing is estimated.'
                role='img'
                aria-label='No historical grade data'
            >
                No grade data
            </span>
        );
    }
    const instructor = stat.scope === 'instructor';
    return (
        <span
            className={clsx(
                'inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 text-[11px] leading-tight whitespace-nowrap',
                instructor
                    ? 'bg-[#BF5700]/10 text-[#7a3800] border border-[#BF5700]/40'
                    : 'border border-dashed border-gray-400 text-gray-700'
            )}
            style={{
                background: instructor
                    ? 'linear-gradient(145deg, rgba(255,255,255,.94), rgba(255,237,220,.65))'
                    : 'rgba(255,255,255,.7)',
                backdropFilter: 'blur(14px) saturate(140%)',
                border: '1px solid rgba(191,87,0,.18)',
                borderRadius: 9,
                padding: '5px 8px',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9), 0 2px 7px rgba(90,50,20,.07)',
                color: '#713b18',
            }}
            title={describeGradeStat(stat)}
            role='img'
            aria-label={describeGradeStat(stat).replace(/\n/g, '. ')}
            data-fastlane='grade'
        >
            <strong className='text-[12px]'>{formatPercent(stat.result.percent)}</strong>
            <span>{thresholdLabel(stat.result.threshold)}</span>
            <span className='opacity-70'>· {instructor ? 'Prof' : 'All profs'}</span>
            {stat.smallSample && <span className='opacity-70'>· n={stat.result.graded}</span>}
        </span>
    );
}

/** Rate My Professors rating for the section's first listed professor (only exact, unique matches). */
function RatingChip({ course }: { course: Course }) {
    const prof = course.instructors[0];
    const name = prof ? splitProfessorName(prof.firstName, prof.lastName, prof.fullName ?? '') : null;
    const [rating, setRating] = useState<RmpRating | null | undefined>(undefined);
    useEffect(() => {
        if (!name?.last) return;
        let alive = true;
        sendFastlane<RmpRating | null>({ type: 'professorRating', first: name.first, last: name.last })
            .then(r => alive && setRating(r))
            .catch(() => alive && setRating(null));
        return () => {
            alive = false;
        };
    }, [name?.first, name?.last]);
    if (!name?.last || rating === undefined) return null;
    if (!rating || rating.numRatings === 0)
        return (
            <span
                className='inline-flex items-center rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-500 whitespace-nowrap'
                title='No Rate My Professors match for this professor at UT Austin.'
                data-fastlane='rmp'
            >
                RMP –
            </span>
        );
    const good = rating.avgRating >= 4 ? '#15803d' : rating.avgRating >= 3 ? '#a16207' : '#b91c1c';
    const again =
        rating.wouldTakeAgainPercent >= 0 ? ` · ${Math.round(rating.wouldTakeAgainPercent)}% would take again` : '';
    return (
        <a
            href={rmpProfessorUrl(rating.legacyId)}
            target='_blank'
            rel='noreferrer'
            onClick={e => e.stopPropagation()}
            className='inline-flex items-baseline gap-1 whitespace-nowrap text-[11px] leading-tight no-underline'
            style={{
                background: 'rgba(255,255,255,.8)',
                backdropFilter: 'blur(14px) saturate(140%)',
                border: '1px solid rgba(51,63,72,.15)',
                borderRadius: 9,
                padding: '5px 8px',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9), 0 2px 7px rgba(30,40,50,.06)',
                color: '#333f48',
            }}
            title={`Rate My Professors: ${rating.name} (${rating.department})\n${rating.avgRating.toFixed(1)}/5 quality · ${rating.avgDifficulty.toFixed(1)}/5 difficulty · ${rating.numRatings} ratings${again}`}
            data-fastlane='rmp'
        >
            <strong className='text-[12px]' style={{ color: good }}>
                ★ {rating.avgRating.toFixed(1)}
            </strong>
            <span className='opacity-70'>RMP · {rating.numRatings}</span>
        </a>
    );
}

/** One-click add to the active schedule (UTRP picks the class color); turns into the class color once added. */
function QuickAddButton({ course, activeSchedule }: Pick<Props, 'course' | 'activeSchedule'>) {
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    if (!activeSchedule) return null;
    const saved = activeSchedule.courses.find(c => c.uniqueId === course.uniqueId);
    const otherSemester = activeSchedule.courses.some(
        c => c.semester.year !== course.semester.year || c.semester.season !== course.semester.season
    );
    const label = saved
        ? `Remove ${course.department} ${course.number} from ${activeSchedule.name}`
        : `Add ${course.department} ${course.number} to ${activeSchedule.name}`;
    const toggle = async () => {
        if (busy) return;
        if (!saved && otherSemester) {
            setNote(`${activeSchedule.name} has classes from another semester`);
            return;
        }
        setBusy(true);
        setNote(null);
        try {
            if (saved) await background.removeCourse({ course, scheduleId: activeSchedule.id });
            else await background.addCourse({ course, scheduleId: activeSchedule.id });
        } catch {
            setNote('Could not update your schedule');
        } finally {
            setBusy(false);
        }
    };
    const color = saved?.colors?.primaryColor ?? '#16a34a';
    return (
        <button
            type='button'
            className='inline-flex h-[24px] w-[24px] items-center justify-center rounded-full border-none text-white'
            style={{
                background: color,
                boxShadow: '0 2px 6px rgba(0,0,0,.15), inset 0 1px 0 rgba(255,255,255,.35)',
                transition: 'background 200ms ease, transform 120ms ease',
                cursor: busy ? 'progress' : 'pointer',
            }}
            aria-label={label}
            aria-pressed={!!saved}
            title={note ?? (saved ? `Added to ${activeSchedule.name} · click to remove` : label)}
            onClick={e => {
                e.stopPropagation();
                void toggle();
            }}
            data-fastlane='quick-add'
        >
            {saved ? <CheckIcon className='h-3.5 w-3.5' /> : <PlusIcon className='h-3.5 w-3.5' />}
        </button>
    );
}

function ModalityChip({ modality }: { modality: ModalityResult }) {
    const title = modality.reasons.join('\n');
    if (modality.modality === 'async-online') {
        return (
            <span
                className='rounded bg-[#1d4ed8] px-1.5 py-0.5 text-[10px] font-bold text-white whitespace-nowrap'
                title={title}
                data-fastlane='async'
            >
                ASYNC ONLINE
            </span>
        );
    }
    if (modality.modality === 'live-online') {
        return (
            <span
                className='rounded border border-[#7c3aed] px-1.5 py-0.5 text-[10px] font-bold text-[#6d28d9] whitespace-nowrap'
                title={title}
                data-fastlane='live-online'
            >
                LIVE ONLINE
            </span>
        );
    }
    if (modality.modality === 'unknown' && /internet|online/i.test(title)) {
        return (
            <span
                className='rounded border border-gray-400 px-1.5 py-0.5 text-[10px] text-gray-600 whitespace-nowrap'
                title={title}
            >
                ONLINE · TIMES UNCLEAR
            </span>
        );
    }
    return null;
}

function ConflictChip({ conflict }: { conflict: ConflictResult }) {
    if (conflict.status === 'conflict') {
        const sections = conflictingSections(conflict);
        const detail = conflict.conflicts
            .map(c => `${c.with.label}: ${formatMeeting(c.otherMeeting)} overlaps ${formatMeeting(c.candidateMeeting)}`)
            .join('\n');
        return (
            <span
                className='rounded bg-[#b91c1c] px-1.5 py-0.5 text-[10px] font-semibold text-white whitespace-nowrap'
                title={`Conflicts with your active schedule:\n${detail}`}
                data-fastlane='conflict'
            >
                Conflicts: {sections.map(s => s.label).join(', ')}
            </span>
        );
    }
    if (conflict.status === 'unknown') {
        const why = conflict.candidateIncomplete
            ? 'This section’s meeting times are incomplete or TBA.'
            : `Times are incomplete for: ${conflict.unknownWith.map(s => s.label).join(', ')}.`;
        return (
            <span
                className='rounded border border-[#b45309] px-1.5 py-0.5 text-[10px] font-semibold text-[#92400e] whitespace-nowrap'
                title={`Conflict status unknown. ${why}`}
                data-fastlane='conflict-unknown'
            >
                Conflict ?
            </span>
        );
    }
    return null;
}

function BackupButton({
    course,
    activeSchedule,
    rowAnalysis,
}: Pick<Props, 'course' | 'activeSchedule' | 'rowAnalysis'>) {
    const plans = FastlanePlanStore.useStore(s => s.plans ?? {}) as unknown as Record<
        string,
        import('../core/plans').PlanMeta
    >;
    const [open, setOpen] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    if (!activeSchedule || activeSchedule.containsCourse(course)) return null;
    const plan = plans[activeSchedule.id];
    const existing = plan ? findSection(plan, course.uniqueId) : null;
    if (existing && existing.index > 0) {
        const primary = existing.slot.candidates.find(c => c.uniqueId === existing.slot.activeUniqueId);
        return (
            <span
                className='rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700 whitespace-nowrap'
                data-fastlane='backup-badge'
            >
                Backup #{existing.index} for {primary?.courseCode}
            </span>
        );
    }
    if (activeSchedule.courses.length === 0) return null;

    const add = async (forUniqueId: number) => {
        try {
            await loadPlan(activeSchedule);
            await addBackupFor(activeSchedule.id, forUniqueId, sectionFromCourse(course, rowAnalysis));
            setMessage('Saved as backup');
        } catch (e) {
            setMessage(e instanceof DuplicateSectionError ? 'Already in plan' : (e as Error).message);
        }
        setOpen(false);
    };

    return (
        <span className='relative inline-flex'>
            <button
                type='button'
                className='rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-[#333f48] hover:border-[#BF5700] whitespace-nowrap'
                onClick={e => {
                    e.stopPropagation();
                    setOpen(o => !o);
                }}
                aria-expanded={open}
                title='Save this section as a ranked backup for one of your planned classes. Backups never count toward your active schedule.'
            >
                {message ?? '+ Backup'}
            </button>
            {open && (
                <span className='absolute right-0 top-6 z-50 flex min-w-56 flex-col rounded-md border border-gray-200 bg-white p-1 shadow-lg'>
                    <span className='px-2 py-1 text-[10px] font-bold uppercase text-gray-500'>Backup for…</span>
                    {activeSchedule.courses.map(c => (
                        <button
                            key={c.uniqueId}
                            type='button'
                            className='rounded px-2 py-1 text-left text-[11px] text-gray-800 hover:bg-gray-100'
                            onClick={e => {
                                e.stopPropagation();
                                void add(c.uniqueId);
                            }}
                        >
                            {c.department} {c.number} · {String(c.uniqueId).padStart(5, '0')}
                        </button>
                    ))}
                </span>
            )}
        </span>
    );
}

export default function RowInsights({ course, modality, conflict, activeSchedule, rowAnalysis }: Props) {
    const settings = FastlaneSettingsStore.useStore(s => s);
    return (
        <span className='inline-flex flex-wrap items-center gap-1 py-0.5' data-fastlane='row'>
            {settings.showInlineGrades && <GradeChip course={course} />}
            {settings.showProfessorRatings && <RatingChip course={course} />}
            {settings.highlightAsync && <ModalityChip modality={modality} />}
            {settings.showConflictDetails && conflict && <ConflictChip conflict={conflict} />}
            <BackupButton course={course} activeSchedule={activeSchedule} rowAnalysis={rowAnalysis} />
            <QuickAddButton course={course} activeSchedule={activeSchedule} />
        </span>
    );
}
