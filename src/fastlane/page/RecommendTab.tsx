import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useState } from 'react';

import { outstandingTags } from '../audit/parseAudit';
import { formatMeeting } from '../core/meetings';
import type { PlanMeta } from '../core/plans';
import { DuplicateSectionError } from '../core/plans';
import type { QueueState } from '../core/queue';
import { addItem } from '../core/queue';
import type { Recommendation } from '../core/recommend';
import { CORE_COMPONENTS, coreTag, describeRequirement } from '../core/requirements';
import type { SectionRecord } from '../core/sections';
import { formatObservedTime, formatUnique, semesterKey } from '../core/sections';
import { addBackupFor } from '../services/planService';
import { buildRecommendations, loadCachedSections } from '../services/recommendationService';
import { FastlaneAuditStore, FastlanePlanStore, FastlaneQueueStore, FastlaneSettingsStore } from '../storage/stores';
import { CopyButton, GradeChip, instructorsText, ModalityChip, PageHead, UniqueCode } from './common';
import { useOnline } from './hooks';

export default function RecommendTab({ initialRequirement }: { initialRequirement?: string | null }) {
    const settings = FastlaneSettingsStore.useStore(s => s);
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const queue = FastlaneQueueStore.useStore(s => s.queue) as unknown as QueueState;
    const plans = FastlanePlanStore.useStore(s => s.plans ?? {}) as unknown as Record<string, PlanMeta>;
    const schedule = useActiveSchedule();
    const online = useOnline();
    const outstanding = useMemo(() => (audit ? outstandingTags(audit) : []), [audit]);
    const [selected, setSelected] = useState<string[]>(() => (initialRequirement ? [initialRequirement] : outstanding));
    const [gradeThreshold, setGradeThreshold] = useState<'A' | 'A-'>('A');
    const [results, setResults] = useState<Recommendation[] | null>(null);
    const [cache, setCache] = useState<SectionRecord[]>([]);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        if (initialRequirement) setSelected([initialRequirement]);
    }, [initialRequirement]);

    useEffect(() => {
        void loadCachedSections(null).then(setCache);
    }, []);

    const semesters = useMemo(
        () => [...new Set(cache.map(s => semesterKey(s.semester)))].filter(s => s !== 'unknown'),
        [cache]
    );
    const newest = cache.reduce((t, s) => Math.max(t, s.capturedAt || 0), 0);
    const plan = schedule ? plans[schedule.id] : undefined;

    // biome-ignore lint/correctness/useExhaustiveDependencies: rerank only when inputs that affect ranking change (stable keys instead of object identity)
    useEffect(() => {
        if (!selected.length) {
            setResults([]);
            return;
        }
        setResults(null);
        let alive = true;
        void buildRecommendations({
            requirements: selected,
            schedule,
            settings: { ...settings, gradeThreshold },
            audit,
            queue,
            plan,
            limit: 15,
        }).then(r => {
            if (alive) setResults(r);
        });
        return () => {
            alive = false;
        };
    }, [
        selected.join('|'),
        settings.targetSemester,
        settings.preferAsync,
        settings.preferOnline,
        settings.avoidFriday,
        gradeThreshold,
        audit,
        schedule?.updatedAt,
        schedule?.id,
        cache.length,
    ]);

    const toggle = (tag: string) => setSelected(s => (s.includes(tag) ? s.filter(t => t !== tag) : [...s, tag]));

    const addToQueue = async (rec: Recommendation) => {
        const req = rec.satisfies[0] ?? '';
        try {
            const next = addItem(queue, {
                uniqueId: rec.section.uniqueId,
                label: rec.section.title,
                courseCode: rec.section.courseCode,
                group: req.replace(/\s+/g, '-') || 'OTHER',
                requirement: req,
            });
            await FastlaneQueueStore.set('queue', next as never);
            setMessage(`Added ${formatUnique(rec.section.uniqueId)} to the registration queue.`);
        } catch (e) {
            setMessage((e as Error).message);
        }
    };

    const addAsBackup = async (rec: Recommendation, forUniqueId: number) => {
        if (!schedule) return;
        try {
            await addBackupFor(schedule.id, forUniqueId, rec.section);
            setMessage(`Saved ${formatUnique(rec.section.uniqueId)} as a backup.`);
        } catch (e) {
            setMessage(e instanceof DuplicateSectionError ? e.message : (e as Error).message);
        }
    };

    return (
        <div className='stack'>
            <PageHead
                title='Recommendations'
                subtitle='Degree-relevant options from course data saved in this browser. Nothing is invented; availability is shown only when UT displayed it.'
            />
            <div className='card stack'>
                <div className='row between'>
                    <h3 style={{ margin: 0 }}>Requirements to fill</h3>
                    <span className='small muted'>
                        {online ? 'Online' : 'Offline — using cached data'} · {cache.length} cached section(s)
                        {newest ? `, newest seen ${formatObservedTime(newest)}` : ''}
                    </span>
                </div>
                {outstanding.length > 0 && (
                    <div className='row'>
                        <span className='small muted'>From your degree audit:</span>
                        {outstanding.map(t => (
                            <button
                                key={t}
                                type='button'
                                className={`btn sm ${selected.includes(t) ? 'primary' : ''}`}
                                aria-pressed={selected.includes(t)}
                                onClick={() => toggle(t)}
                            >
                                {describeRequirement(t)}
                            </button>
                        ))}
                    </div>
                )}
                <div className='row'>
                    <span className='small muted'>Core curriculum:</span>
                    {CORE_COMPONENTS.map(c => {
                        const tag = coreTag(c.code);
                        if (outstanding.includes(tag)) return null;
                        return (
                            <button
                                key={tag}
                                type='button'
                                className={`btn sm ${selected.includes(tag) ? 'primary' : ''}`}
                                aria-pressed={selected.includes(tag)}
                                onClick={() => toggle(tag)}
                                title={c.name}
                            >
                                {c.code}
                            </button>
                        );
                    })}
                </div>
                <p className='small muted'>
                    Unfinished requirements first, then semester fit, conflicts and availability, reliable historical
                    grade rates, and your delivery preferences. Matches are suggestions, not an official degree
                    evaluation.
                </p>
                <div className='row'>
                    <label className='field'>
                        Historical grade ranking
                        <select value={gradeThreshold} onChange={e => setGradeThreshold(e.target.value as 'A' | 'A-')}>
                            <option value='A'>A percentage</option>
                            <option value='A-'>A− or better percentage</option>
                        </select>
                    </label>
                    <label className='field'>
                        Semester
                        <select
                            value={settings.targetSemester ?? ''}
                            onChange={e => void FastlaneSettingsStore.set('targetSemester', e.target.value || null)}
                        >
                            <option value=''>Any semester</option>
                            {semesters.map(s => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={settings.preferAsync}
                            onChange={e => void FastlaneSettingsStore.set('preferAsync', e.target.checked)}
                        />
                        Prefer asynchronous
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={settings.preferOnline}
                            onChange={e => void FastlaneSettingsStore.set('preferOnline', e.target.checked)}
                        />
                        Prefer online
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={settings.avoidFriday}
                            onChange={e => void FastlaneSettingsStore.set('avoidFriday', e.target.checked)}
                        />
                        Avoid Friday classes
                    </label>
                </div>
                {!audit && (
                    <div className='notice small'>
                        Import your degree audit to have outstanding requirements selected automatically and completed
                        courses excluded.
                    </div>
                )}
            </div>
            {message && (
                <div className='notice' role='status'>
                    {message}
                </div>
            )}
            {results === null && <div className='muted'>Ranking options…</div>}
            {results?.length === 0 && selected.length > 0 && (
                <div className='card'>
                    <h3>No saved sections match yet</h3>
                    <p className='muted small'>
                        Fastlane only recommends sections it has actually seen. Open UT’s course schedule and browse{' '}
                        {selected.map(describeRequirement).join(', ')} once (for example, search by core component) —
                        the listing is saved locally and recommendations work offline afterwards.
                    </p>
                </div>
            )}
            {results?.map((rec, i) => (
                <div className='rec' key={rec.section.uniqueId}>
                    <div className='stack' style={{ gap: 4 }}>
                        <div className='row'>
                            <span className='rank'>#{i + 1}</span>
                            <UniqueCode id={rec.section.uniqueId} />
                            <b>{rec.section.courseCode}</b>
                            <span>{rec.section.title}</span>
                            <ModalityChip modality={rec.section.modality} />
                            <GradeChip stat={rec.grade} />
                            <span
                                className={`chip ${rec.availability.tone === 'open' ? 'ok' : rec.availability.tone === 'closed' ? 'bad' : ''}`}
                            >
                                {rec.availability.text}
                            </span>
                        </div>
                        <div className='small muted'>
                            {instructorsText(rec.section)} ·{' '}
                            {rec.section.meetings.length
                                ? rec.section.meetings.map(formatMeeting).join('; ')
                                : 'No scheduled meetings'}{' '}
                            · {semesterKey(rec.section.semester)}
                        </div>
                        <div className='small'>{rec.reasons.join(' · ')}</div>
                        {rec.warnings.length > 0 && (
                            <div className='small' style={{ color: 'var(--warn)' }}>
                                {rec.warnings.join(' · ')}
                            </div>
                        )}
                    </div>
                    <div className='stack' style={{ gap: 6, alignItems: 'flex-end' }}>
                        <CopyButton text={formatUnique(rec.section.uniqueId)} label='Copy unique' />
                        <button type='button' className='btn sm' onClick={() => void addToQueue(rec)}>
                            Add to queue
                        </button>
                        {schedule && schedule.courses.length > 0 && (
                            <select
                                aria-label='Save as backup for'
                                value=''
                                onChange={e => {
                                    if (e.target.value) void addAsBackup(rec, Number(e.target.value));
                                }}
                            >
                                <option value=''>Backup for…</option>
                                {schedule.courses.map(c => (
                                    <option key={c.uniqueId} value={c.uniqueId}>
                                        {c.department} {c.number} ({formatUnique(c.uniqueId)})
                                    </option>
                                ))}
                            </select>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
