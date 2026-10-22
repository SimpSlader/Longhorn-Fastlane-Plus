import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useState } from 'react';

import { outstandingTags } from '../audit/parseAudit';
import { DAY_ORDER, type DayCode, formatMeeting } from '../core/meetings';
import type { PlanMeta } from '../core/plans';
import { DuplicateSectionError } from '../core/plans';
import type { QueueState } from '../core/queue';
import { addItem } from '../core/queue';
import type { Recommendation } from '../core/recommend';
import { CORE_COMPONENTS, coreTag, describeRequirement } from '../core/requirements';
import type { SectionRecord } from '../core/sections';
import { formatObservedTime, formatUnique, semesterKey } from '../core/sections';
import { availableSubjects, utSubjectScheduleUrl } from '../data/subjects';
import { addOrSwap } from '../services/planningService';
import { addBackupFor } from '../services/planService';
import { buildRecommendations, loadCachedSections } from '../services/recommendationService';
import { FastlaneAuditStore, FastlanePlanStore, FastlaneQueueStore, FastlaneSettingsStore } from '../storage/stores';
import { CopyButton, GradeChip, instructorsText, ModalityChip, PageHead, UniqueCode } from './common';
import { useOnline } from './hooks';

export default function RecommendTab({
    initialRequirement,
    embedded = false,
    subject,
    onSubjectChange,
}: {
    initialRequirement?: string | null;
    embedded?: boolean;
    subject?: string;
    onSubjectChange?: (code: string) => void;
}) {
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
    const [internalSubject, setInternalSubject] = useState('');
    const selectedSubject = subject ?? internalSubject;
    const setSubject = onSubjectChange ?? setInternalSubject;
    const [minGrade, setMinGrade] = useState(0);
    const [search, setSearch] = useState('');
    const [days, setDays] = useState<DayCode[]>([...DAY_ORDER]);

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
            limit: 100,
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

    const departments = availableSubjects(
        cache.map(s => s.courseCode.replace(/\s+\d.*$/, '').trim())
    );
    const filteredResults =
        results?.filter(rec => {
            const s = rec.section;
            if (selectedSubject && s.courseCode.replace(/\s+\d.*$/, '').trim() !== selectedSubject) return false;
            if (
                search &&
                !`${s.courseCode} ${s.title} ${s.instructors.join(' ')}`.toLowerCase().includes(search.toLowerCase())
            )
                return false;
            if (minGrade > 0 && (rec.grade?.result.percent ?? -1) < minGrade) return false;
            if (s.meetings.some(m => m.days.some(d => !days.includes(d)))) return false;
            return true;
        }) ?? [];
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

    const addToSchedule = async (rec: Recommendation) => {
        if (!schedule) return;
        try {
            await addOrSwap(schedule.id, rec.section);
            setMessage(
                `Added ${rec.section.courseCode} to ${schedule.name}. Review any meeting conflicts on My schedule.`
            );
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Could not add this section.');
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
            {!embedded && (
                <PageHead
                    title='Recommended classes'
                    subtitle='Real cached UT sections matched to unfinished requirements from your IDA.'
                />
            )}
            <section className='card planner-glass compact-filters'>
                <div className='filter-top'>
                    <div>
                        <h2>Recommended for your degree</h2>
                        <p className='small muted'>
                            Matches unfinished IDA requirements, then ranks fit and historical grades.
                        </p>
                    </div>
                    <span className='small muted'>
                        {cache.length} cached sections · {online ? 'Online' : 'Offline'}
                        {newest ? ` · updated ${formatObservedTime(newest)}` : ''}
                    </span>
                </div>
                {!audit && (
                    <div className='notice'>
                        Add your UT degree audit to get recommendations matched to your unfinished requirements. You can
                        still browse classes with the other view above.
                    </div>
                )}
                {audit && !outstanding.length && (
                    <div className='notice'>
                        No unfinished requirement tags were identified from this audit. Review your IDA to confirm
                        what's still needed.
                    </div>
                )}
                <div className='simple-filter-grid'>
                    <label>
                        Semester
                        <select
                            aria-label='Recommended class semester'
                            value={settings.targetSemester ?? ''}
                            onChange={e => void FastlaneSettingsStore.set('targetSemester', e.target.value || null)}
                        >
                            <option value=''>Any semester</option>
                            {semesters.map(t => (
                                <option key={t} value={t}>
                                    {t}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Subject
                        <select
                            aria-label='Recommended class subject'
                            value={selectedSubject}
                            onChange={e => setSubject(e.target.value)}
                        >
                            <option value=''>All subjects</option>
                            {departments.map(d => (
                                <option key={d.code} value={d.code}>
                                    {d.name} ({d.code})
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Course or professor
                        <input
                            aria-label='Search recommended classes'
                            type='text'
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder='ECO, UGS, professor…'
                        />
                    </label>
                    <label>
                        Historical grade
                        <select
                            aria-label='Recommended class grade metric'
                            value={gradeThreshold}
                            onChange={e => setGradeThreshold(e.target.value as 'A' | 'A-')}
                        >
                            <option value='A'>A percentage</option>
                            <option value='A-'>A− or better percentage</option>
                        </select>
                    </label>
                    <label>
                        Minimum {gradeThreshold === 'A' ? 'A' : 'A− or better'} rate
                        <select
                            aria-label='Recommended class minimum grade percentage'
                            value={minGrade}
                            onChange={e => setMinGrade(Number(e.target.value))}
                        >
                            <option value={0}>Any grade history</option>
                            {[60, 70, 80, 90].map(n => (
                                <option key={n} value={n}>
                                    {n}%+
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                <div className='day-filter'>
                    <span className='small muted'>Days I can take classes</span>
                    <fieldset className='day-chips' aria-label='Allowed recommendation days'>
                        {DAY_ORDER.map(d => (
                            <button
                                type='button'
                                key={d}
                                className='day-chip'
                                aria-pressed={days.includes(d)}
                                onClick={() =>
                                    setDays(old => (old.includes(d) ? old.filter(v => v !== d) : [...old, d]))
                                }
                            >
                                {d === 'TH'
                                    ? 'Thu'
                                    : d === 'SU'
                                      ? 'Sun'
                                      : d === 'T'
                                        ? 'Tue'
                                        : d === 'M'
                                          ? 'Mon'
                                          : d === 'W'
                                            ? 'Wed'
                                            : d === 'F'
                                              ? 'Fri'
                                              : 'Sat'}
                            </button>
                        ))}
                        <button type='button' className='btn sm' onClick={() => setDays(['M', 'T', 'W', 'TH'])}>
                            No Fridays
                        </button>
                    </fieldset>
                </div>
                <details className='more-filters'>
                    <summary>Choose degree requirements ({selected.length} selected)</summary>
                    {outstanding.length > 0 && (
                        <div className='row' style={{ marginTop: 12 }}>
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
                    <p className='small muted'>Other core curriculum components</p>
                    <div className='row'>
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
                                >
                                    {c.name} (Core {c.code})
                                </button>
                            );
                        })}
                    </div>
                    <div className='row' style={{ marginTop: 12 }}>
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
                    </div>
                </details>
                <p className='small muted'>
                    Percentages are historical, not a prediction. Missing grade data is excluded when a minimum rate is
                    selected.
                </p>
            </section>
            {message && (
                <div className='notice' role='status'>
                    {message}
                </div>
            )}
            {results === null && <div className='muted'>Ranking options…</div>}
            {results !== null && filteredResults.length === 0 && selected.length > 0 && (
                <div className='card'>
                    <h3>{selectedSubject ? `No verified ${departments.find(d => d.code === selectedSubject)?.name ?? selectedSubject} sections in this local catalog` : 'No classes match these preferences'}</h3>
                    <p className='muted small'>
                        This planner currently holds only UT sections already imported or viewed. Choosing a subject does not load its course offerings. Browse that subject in the official UT schedule or import the complete semester dataset. Search for{' '}
                        {selected.map(describeRequirement).join(', ')} once (for example, search by core component) —
                        the listing is saved locally and recommendations work offline afterwards.
                        {selectedSubject && (
                            <>
                                {' '}
                                <a href={utSubjectScheduleUrl(settings.targetSemester ?? '', selectedSubject)}
                                    target='_blank' rel='noopener noreferrer'>
                                    Open this subject's official UT listings
                                </a>
                            </>
                        )}
                    </p>
                </div>
            )}
            {results !== null && filteredResults.length > 0 && (
                <p className='small muted'>
                    {filteredResults.length} matches · verify each section in UT before registering.
                </p>
            )}
            {filteredResults.map((rec, i) => (
                <div className='rec planner-glass' key={rec.section.uniqueId}>
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
                        <button
                            type='button'
                            className='btn sm primary'
                            disabled={!schedule || !rec.section.course || rec.section.status?.value === 'CANCELLED'}
                            onClick={() => void addToSchedule(rec)}
                        >
                            Add to my schedule
                        </button>
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
