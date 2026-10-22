import type { Serialized } from '@chrome-extension-toolkit';
import { UserSchedule } from '@shared/types/UserSchedule';
import { useActiveSchedule, useAllSchedules } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useState } from 'react';
import { sectionFromCourse } from '../adapters/utrp';
import type { ParsedAudit } from '../audit/types';
import { DAY_ORDER, formatMinutes } from '../core/meetings';
import {
    catalogPrerequisite,
    confirmedAuditHours,
    DEFAULT_FILTERS,
    type Grades,
    generateSchedules,
    matchesFilters,
    metrics,
    type PlannerFilters,
    prerequisiteStatus,
    type RoadmapEntry,
    roadmapProjection,
} from '../core/planning';
import { normalizeCourseCode } from '../core/requirements';
import { availabilityDisplay, type SectionRecord, semesterKey } from '../core/sections';
import { HistoryStore, PlanningStore, type ScheduleSnapshot } from '../services/history';
import {
    addOrSwap,
    createPlanningSchedule,
    downloadComparisonImage,
    downloadFile,
    duplicateSchedule,
    parseSharedSchedule,
    shareSchedule,
} from '../services/planningService';
import { loadCachedSections } from '../services/recommendationService';
import { FastlaneAuditStore } from '../storage/stores';
import { useGradeStats } from './hooks';
import WeekGrid from './WeekGrid';

export function HomeTab({ go }: { go: (tab: string) => void }) {
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const onboarded = PlanningStore.useStore(s => s.onboarded);
    const active = useActiveSchedule();
    return (
        <>
            <h1>Make room for what matters.</h1>
            <p className='muted'>Your classes, degree progress and alternatives, together in this browser.</p>
            {!onboarded && (
                <section className='card planner-glass'>
                    <h2>Welcome to FastLane</h2>
                    <ol>
                        <li>
                            Open your IDA results and click <b>Add IDA</b>. Review uncertain requirements.
                        </li>
                        <li>Browse UT’s course schedule to save real sections to the local cache.</li>
                        <li>Find classes, generate combinations, then compare your favorites.</li>
                        <li>Verify availability and prerequisites before registering with UT.</li>
                    </ol>
                    <button type='button' className='btn' onClick={() => void PlanningStore.set('onboarded', true)}>
                        Got it
                    </button>
                </section>
            )}
            <section className='card planner-glass'>
                <h2>What should I do next?</h2>
                <div className='planner-actions'>
                    <button type='button' className='btn' onClick={() => go(audit ? 'recommend' : 'audit')}>
                        {audit ? 'Find classes for unfinished requirements' : 'Add your degree audit'}
                    </button>
                    <button type='button' className='btn' onClick={() => go('finder')}>
                        Explore cached classes
                    </button>
                    <button
                        type='button'
                        className='btn'
                        onClick={() => go(active?.courses.length ? 'compare' : 'generate')}
                    >
                        {active?.courses.length ? 'Duplicate and compare your schedule' : 'Build a schedule'}
                    </button>
                    <button type='button' className='btn' onClick={() => go('roadmap')}>
                        Plan future semesters
                    </button>
                </div>
            </section>
            <section className='card'>
                <h2>What the numbers mean</h2>
                <p>
                    A− or better includes A and A−, divided by all historical letter grades. Non-letter outcomes are
                    excluded. Comparison averages weight each class equally, and show how many classes have data.
                    Historical results are not a prediction of your grade.
                </p>
                <p>
                    Audits, roadmap and history stay in local extension storage. Sharing uses a separate schedule-only
                    file. Your browser profile and anyone with access to it can still access local data. Manage or
                    delete it in Settings & privacy.
                </p>
            </section>
        </>
    );
}
function FilterControls({
    value: f,
    onChange: set,
    terms,
    tags,
    showFits = true,
}: {
    value: PlannerFilters;
    onChange: (v: PlannerFilters) => void;
    terms: string[];
    tags: string[];
    showFits?: boolean;
}) {
    const update = (v: Partial<PlannerFilters>) => set({ ...f, ...v });
    return (
        <section className='card planner-glass'>
            <div className='planner-fields'>
                <label>
                    Semester
                    <select
                        aria-label='Semester'
                        value={f.semester}
                        onChange={e => update({ semester: e.target.value })}
                    >
                        <option value=''>Choose semester</option>
                        {terms.map(t => (
                            <option key={t}>{t}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Course or title
                    <input value={f.query} onChange={e => update({ query: e.target.value })} placeholder='UGS 302' />
                </label>
                <label>
                    Professor
                    <input value={f.professor} onChange={e => update({ professor: e.target.value })} />
                </label>
                <label>
                    Delivery
                    <select value={f.modality} onChange={e => update({ modality: e.target.value })}>
                        <option value=''>Any delivery</option>
                        {['async-online', 'live-online', 'in-person', 'hybrid'].map(m => (
                            <option key={m}>{m}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Minimum A− or better (%)
                    <input
                        type='number'
                        min='0'
                        max='100'
                        value={f.minGrade}
                        onChange={e => update({ minGrade: Math.max(0, Math.min(100, Number(e.target.value))) })}
                    />
                </label>
                <label>
                    Credit hours
                    <select value={f.hours} onChange={e => update({ hours: Number(e.target.value) })}>
                        <option value='0'>Any hours</option>
                        {[1, 2, 3, 4, 5, 6].map(h => (
                            <option key={h}>{h}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Degree requirement
                    <select value={f.requirement} onChange={e => update({ requirement: e.target.value })}>
                        <option value=''>Any requirement</option>
                        {tags.map(t => (
                            <option key={t}>{t}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Earliest start
                    <input
                        type='time'
                        value={`${String(Math.floor(f.start / 60)).padStart(2, '0')}:${String(f.start % 60).padStart(2, '0')}`}
                        onChange={e => {
                            const [h, m] = e.target.value.split(':').map(Number);
                            if (h !== undefined && m !== undefined) update({ start: h * 60 + m });
                        }}
                    />
                </label>
                <label>
                    Latest end
                    <input
                        type='time'
                        value={
                            f.end === 1440
                                ? '23:59'
                                : `${String(Math.floor(f.end / 60)).padStart(2, '0')}:${String(f.end % 60).padStart(2, '0')}`
                        }
                        onChange={e => {
                            const [h, m] = e.target.value.split(':').map(Number);
                            if (h !== undefined && m !== undefined) update({ end: h * 60 + m });
                        }}
                    />
                </label>
            </div>
            <div className='planner-actions'>
                <span>Only these days:</span>
                {DAY_ORDER.map(d => (
                    <label key={d}>
                        <input
                            type='checkbox'
                            checked={f.days.includes(d)}
                            onChange={e =>
                                update({ days: e.target.checked ? [...f.days, d] : f.days.filter(v => v !== d) })
                            }
                        />
                        {d}
                    </label>
                ))}
            </div>
            <div className='planner-actions'>
                <button type='button' className='btn' onClick={() => update({ days: ['T', 'TH'] })}>
                    Tuesday / Thursday
                </button>
                <button type='button' className='btn' onClick={() => update({ days: ['M', 'W', 'F'] })}>
                    MWF
                </button>
                <button type='button' className='btn' onClick={() => update({ days: ['M', 'T', 'W', 'TH'] })}>
                    No Fridays
                </button>
                <button type='button' className='btn' onClick={() => update({ start: 0, end: 720 })}>
                    Mornings only
                </button>
                <button type='button' className='btn' onClick={() => set({ ...DEFAULT_FILTERS, semester: f.semester })}>
                    Reset filters
                </button>
            </div>
            <div className='planner-actions'>
                <label>
                    <input type='checkbox' checked={f.noGaps} onChange={e => update({ noGaps: e.target.checked })} />
                    Back-to-back, no gaps
                </label>
                {showFits && (
                    <label>
                        <input type='checkbox' checked={f.fits} onChange={e => update({ fits: e.target.checked })} />
                        Show only classes that fit my schedule
                    </label>
                )}
            </div>
        </section>
    );
}
function Metrics({ sections, grades }: { sections: SectionRecord[]; grades: Grades }) {
    const m = metrics(sections, grades);
    return (
        <div className='planning-metrics'>
            <span>
                <b>{m.hours}</b> credit hours
            </span>
            <span>
                <b>{m.average === null ? 'Unknown' : `${m.average.toFixed(1)}%`}</b> average A− or better ({m.coverage}/
                {sections.length} classes)
            </span>
            <span>
                <b>{m.friday}</b> Friday classes
            </span>
            <span>
                <b>{m.conflicts}</b> conflicting pairs{m.unknownTimes ? ` · ${m.unknownTimes} unknown times` : ''}
            </span>
            <span>
                Daily gaps:{' '}
                {Object.entries(m.gaps)
                    .filter(([d]) => !['S', 'SU'].includes(d))
                    .map(([d, n]) => `${d} ${n}m`)
                    .join(' · ')}
            </span>
            <span>
                {m.buildingChanges} building changes · {m.unknownLocations} unknown transitions
            </span>
        </div>
    );
}
function SectionSummary({ s, grades }: { s: SectionRecord; grades: Grades }) {
    const g = grades.get(s.uniqueId);
    return (
        <>
            <b>
                {s.courseCode} · {String(s.uniqueId).padStart(5, '0')}
            </b>
            <div>{s.title}</div>
            <p className='small muted'>
                {s.instructors.join(' · ') || 'Professor not listed'} · {s.creditHours} hours · {s.modality}
                <br />
                {s.meetings
                    .map(m => `${m.days.join('/')} ${formatMinutes(m.start)}–${formatMinutes(m.end)}`)
                    .join(' · ') || (s.modality === 'async-online' ? 'Asynchronous' : 'Meeting times unknown')}
                <br />
                {g
                    ? `${g.result.percent.toFixed(1)}% A− or better · ${g.result.graded} historical grades · ${g.scope}${g.smallSample ? ' · small sample' : ''}`
                    : 'Historical grades unavailable'}
                <br />
                {availabilityDisplay(s.status).text}
            </p>
        </>
    );
}
export function FinderTab({ generate = false }: { generate?: boolean }) {
    const [catalog, setCatalog] = useState<SectionRecord[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [filters, setFilters] = useState<PlannerFilters>({ ...DEFAULT_FILTERS });
    const [selected, setSelected] = useState<string[]>([]);
    const [result, setResult] = useState<ReturnType<typeof generateSchedules> | null>(null);
    const [message, setMessage] = useState('');
    const active = useActiveSchedule();
    const audit = FastlaneAuditStore.useStore(s => s.audit) as ParsedAudit | null;
    useEffect(() => {
        let alive = true;
        void loadCachedSections(null).then(s => {
            if (alive) {
                setCatalog(s);
                setLoaded(true);
            }
        });
        return () => {
            alive = false;
        };
    }, []);
    const terms = [...new Set(catalog.map(s => semesterKey(s.semester)))].filter(t => t !== 'unknown');
    const pool = useMemo(
        () => catalog.filter(s => semesterKey(s.semester) === filters.semester),
        [catalog, filters.semester]
    );
    const grades = useGradeStats(pool, 'A-');
    const activeSections = useMemo(() => active?.courses.map(c => sectionFromCourse(c)) ?? [], [active]);
    const tags = [...new Set(pool.flatMap(s => s.requirementTags))].sort();
    const needed = new Set(audit?.requirements.filter(r => r.status !== 'completed').flatMap(r => r.tags) ?? []);
    const finished = new Set(
        audit?.courses.filter(c => c.status === 'completed').map(c => normalizeCourseCode(c.code)) ?? []
    );
    const rows = pool
        .filter(s =>
            matchesFilters(s, { ...filters, noGaps: generate ? false : filters.noGaps }, grades, activeSections)
        )
        .sort(
            (a, b) =>
                Number(b.requirementTags.some(t => needed.has(t))) -
                    Number(a.requirementTags.some(t => needed.has(t))) ||
                (grades.get(b.uniqueId)?.result.percent ?? -1) - (grades.get(a.uniqueId)?.result.percent ?? -1)
        );
    const codes = [
        ...new Set(rows.filter(s => !finished.has(normalizeCourseCode(s.courseCode))).map(s => s.courseCode)),
    ];
    const run = async (action: () => Promise<unknown>, success: string) => {
        try {
            await action();
            setMessage(success);
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Could not save.');
        }
    };
    return (
        <>
            <h1>{generate ? 'Build several schedules' : 'Advanced course finder'}</h1>
            <p>
                Only real sections cached from UT pages you have visited. Choose a semester first. Grade filters exclude
                missing data. Unknown meeting times cannot pass strict time or fit filters.
            </p>
            <FilterControls
                value={filters}
                onChange={f => {
                    if (f.semester !== filters.semester) setSelected([]);
                    setFilters(f);
                    setResult(null);
                }}
                terms={terms}
                tags={tags}
                showFits={!generate}
            />
            <p role='status'>{message}</p>
            {!loaded ? (
                <p>Loading saved sections…</p>
            ) : !catalog.length ? (
                <section className='card'>
                    <h2>No cached sections yet</h2>
                    <p>
                        Browse the official UT course schedule, open the class listings you want, then reopen this page.
                        FastLane never invents sections.
                    </p>
                </section>
            ) : !filters.semester ? (
                <p>Choose a semester to see cached classes.</p>
            ) : (
                <>
                    {generate ? (
                        <>
                            <section className='card'>
                                <h2>Choose courses for a complete combination</h2>
                                <p>
                                    Choose 1–8 courses. Every result includes one section of each. Completed audit
                                    courses are omitted. Required-course matches appear first in the finder; verify the
                                    audit’s exact requirement wording.
                                </p>
                                <div className='planner-actions'>
                                    <button
                                        type='button'
                                        className='btn'
                                        onClick={() =>
                                            setSelected(
                                                [
                                                    ...new Set(
                                                        activeSections
                                                            .filter(s => semesterKey(s.semester) === filters.semester)
                                                            .map(s => s.courseCode)
                                                    ),
                                                ].slice(0, 8)
                                            )
                                        }
                                    >
                                        Use courses from active schedule
                                    </button>
                                </div>
                                <div className='course-choices'>
                                    {codes.map(code => (
                                        <label key={code}>
                                            <input
                                                type='checkbox'
                                                checked={selected.includes(code)}
                                                onChange={e => {
                                                    setSelected(
                                                        e.target.checked
                                                            ? [...selected, code]
                                                            : selected.filter(c => c !== code)
                                                    );
                                                    setResult(null);
                                                }}
                                            />
                                            {code}
                                        </label>
                                    ))}
                                </div>
                                <p>Selected: {selected.join(', ') || 'None'}</p>
                                <div className='planner-actions'>
                                    {(
                                        [
                                            ['preferAsync', 'Prefer asynchronous'],
                                            ['highGrades', 'Prefer high historical grades'],
                                            ['shortWalk', 'Prefer fewer building changes'],
                                        ] as const
                                    ).map(([key, label]) => (
                                        <label key={key}>
                                            <input
                                                type='checkbox'
                                                checked={filters[key]}
                                                onChange={e => {
                                                    setFilters({ ...filters, [key]: e.target.checked });
                                                    setResult(null);
                                                }}
                                            />
                                            {label}
                                        </label>
                                    ))}
                                </div>
                                <p className='small muted'>
                                    Building changes are a walking proxy, not measured distance. Unknown locations are
                                    penalized. Days/hours are strict; asynchronous classes have no scheduled meetings.
                                    No-gap results may leave no travel time. Closed/cancelled sections are excluded;
                                    other cached seat statuses need verification. Results replace no existing plan.
                                </p>
                                <button
                                    type='button'
                                    className='btn primary'
                                    disabled={!selected.length || selected.length > 8}
                                    onClick={() => {
                                        try {
                                            setResult(generateSchedules(pool, selected, filters, grades));
                                            setMessage('');
                                        } catch (e) {
                                            setMessage(String(e));
                                        }
                                    }}
                                >
                                    Generate combinations
                                </button>
                            </section>
                            {result && (
                                <>
                                    <p>
                                        {result.results.length} complete combinations found.
                                        {result.truncated
                                            ? ' Search limit reached; these are the best found, not an exhaustive search.'
                                            : ''}
                                    </p>
                                    {!result.results.length && (
                                        <p>
                                            Nothing matched all selected courses and constraints. Broaden the hours/days
                                            or browse more UT sections.
                                        </p>
                                    )}
                                    {result.results.map((sections, i) => (
                                        <section
                                            className='card planner-glass'
                                            key={sections.map(s => s.uniqueId).join('-')}
                                        >
                                            <h2>Combination {i + 1}</h2>
                                            <Metrics sections={sections} grades={grades} />
                                            {sections.map(s => (
                                                <p key={s.uniqueId}>
                                                    {s.courseCode} · {s.uniqueId} · {s.modality}
                                                </p>
                                            ))}
                                            <button
                                                type='button'
                                                className='btn'
                                                onClick={() =>
                                                    void run(
                                                        () =>
                                                            createPlanningSchedule(
                                                                `Generated schedule ${i + 1}`,
                                                                sections
                                                            ),
                                                        'Saved as a new schedule. Open Compare to review it.'
                                                    )
                                                }
                                            >
                                                Save as new schedule
                                            </button>
                                        </section>
                                    ))}
                                </>
                            )}
                        </>
                    ) : (
                        <>
                            <p>
                                {rows.length} matching sections · sorted by unfinished requirement matches, then
                                historical A− or better. Course-wide grades and small samples are labeled.
                            </p>
                            {!rows.length && (
                                <p>
                                    No cached sections meet these filters. Try Reset filters or browse additional UT
                                    course listings.
                                </p>
                            )}
                            <div className='planner-results'>
                                {rows.map(s => (
                                    <article className='card planner-glass' key={s.uniqueId}>
                                        <SectionSummary s={s} grades={grades} />
                                        {s.requirementTags.some(t => needed.has(t)) && (
                                            <p>
                                                Matches an unfinished requirement tag — confirm exact applicability in
                                                your audit.
                                            </p>
                                        )}
                                        <button
                                            type='button'
                                            className='btn'
                                            disabled={!active || !s.course || s.status?.value === 'CANCELLED'}
                                            onClick={() =>
                                                void run(
                                                    () => addOrSwap(active!.id, s),
                                                    `Added ${s.courseCode} to ${active?.name}.`
                                                )
                                            }
                                        >
                                            Add to {active?.name ?? 'schedule'}
                                        </button>
                                    </article>
                                ))}
                            </div>
                        </>
                    )}
                </>
            )}
        </>
    );
}
export function CompareTab() {
    const active = useActiveSchedule();
    const schedules = useAllSchedules();
    const [left, setLeft] = useState('');
    const [right, setRight] = useState('');
    const [catalog, setCatalog] = useState<SectionRecord[]>([]);
    const [message, setMessage] = useState('');
    useEffect(() => {
        void loadCachedSections(null).then(setCatalog);
    }, []);
    const a = schedules.find(s => s.id === left) ?? schedules.find(s => s.id === active.id) ?? schedules[0];
    const b = schedules.find(s => s.id === right) ?? schedules.find(s => s.id !== a?.id && s.courses.length > 0);
    const leftSections = useMemo(() => a?.courses.map(c => sectionFromCourse(c)) ?? [], [a]);
    const rightSections = useMemo(() => b?.courses.map(c => sectionFromCourse(c)) ?? [], [b]);
    const leftGrades = useGradeStats(leftSections, 'A-');
    const rightGrades = useGradeStats(rightSections, 'A-');
    const run = async (fn: () => Promise<unknown>, success: string) => {
        try {
            await fn();
            setMessage(success);
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Unable to save.');
        }
    };
    return (
        <>
            <h1>Compare schedules</h1>
            <p>
                Duplicate a plan, change classes in the copy, and compare. Historical averages use the same letter-grade
                definition; missing grades are not treated as zero.
            </p>
            <div className='planner-actions'>
                <button
                    type='button'
                    className='btn primary'
                    disabled={!a}
                    onClick={() =>
                        void run(async () => {
                            setRight(await duplicateSchedule(a!));
                        }, 'Copy created. The original is preserved.')
                    }
                >
                    Duplicate {a?.name ?? 'schedule'}
                </button>
                <button
                    type='button'
                    className='btn'
                    disabled={!a || !b}
                    onClick={() =>
                        void run(
                            () =>
                                downloadComparisonImage(
                                    [leftSections, rightSections].map((sections, i) => {
                                        const m = metrics(sections, i === 0 ? leftGrades : rightGrades);
                                        return {
                                            sections,
                                            summary: [
                                                `${m.hours} hours · ${m.friday} Friday classes · ${m.conflicts} conflicts · ${m.unknownTimes} unknown times`,
                                                `${m.average === null ? 'Unknown' : m.average.toFixed(1) + '%'} historical A− or better (${m.coverage}/${sections.length} classes)`,
                                                `Daily gaps: ${Object.entries(m.gaps)
                                                    .map(([d, n]) => `${d} ${n}m`)
                                                    .join(' · ')}`,
                                            ],
                                        };
                                    })
                                ),
                            'Comparison image saved without personal schedule names or audit data.'
                        )
                    }
                >
                    Save comparison image
                </button>
                <label className='btn'>
                    Import schedule-only file
                    <input
                        type='file'
                        accept='.json'
                        onChange={e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            void run(async () => {
                                if (file.size > 200000) throw new Error('File is too large.');
                                const sections = parseSharedSchedule(JSON.parse(await file.text()));
                                setRight(await createPlanningSchedule('Shared schedule', sections));
                            }, 'Imported into a new schedule. Existing plans were kept.');
                            e.target.value = '';
                        }}
                    />
                </label>
            </div>
            <p role='status'>{message}</p>
            {!b && (
                <section className='card'>Duplicate your first schedule to begin a side-by-side comparison.</section>
            )}
            <div className='comparison-grid'>
                {[a, b].map(
                    (schedule, index) =>
                        schedule && (
                            <section key={index === 0 ? 'left' : 'right'} className='card planner-glass'>
                                <label>
                                    {index === 0 ? 'Left schedule' : 'Right schedule'}
                                    <select
                                        value={schedule.id}
                                        onChange={e => (index === 0 ? setLeft : setRight)(e.target.value)}
                                    >
                                        {schedules.map(s => (
                                            <option key={s.id} value={s.id}>
                                                {s.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <h2>{schedule.name}</h2>
                                <Metrics
                                    sections={schedule.courses.map(c => sectionFromCourse(c))}
                                    grades={index === 0 ? leftGrades : rightGrades}
                                />
                                <div className='planner-actions'>
                                    <button
                                        type='button'
                                        className='btn'
                                        disabled={!schedule.courses.length}
                                        onClick={() =>
                                            downloadFile(
                                                new Blob(
                                                    [
                                                        JSON.stringify(
                                                            shareSchedule(
                                                                schedule.courses.map(c => sectionFromCourse(c))
                                                            ),
                                                            null,
                                                            2
                                                        ),
                                                    ],
                                                    { type: 'application/json' }
                                                ),
                                                'FastLane-schedule.json'
                                            )
                                        }
                                    >
                                        Share schedule file
                                    </button>
                                </div>
                                <p className='small muted'>
                                    Contains class numbers, times, professors and rooms only. No audit, student
                                    identifiers, registration links, queue, notes, or personal schedule name. Import
                                    creates a new plan.
                                </p>
                                {schedule.courses.map(c => {
                                    const s = sectionFromCourse(c);
                                    const options = catalog.filter(
                                        v =>
                                            semesterKey(v.semester) === semesterKey(s.semester) &&
                                            v.course &&
                                            v.uniqueId !== s.uniqueId &&
                                            !schedule.courses.some(existing => existing.uniqueId === v.uniqueId)
                                    );
                                    return (
                                        <article className='compare-course' key={s.uniqueId}>
                                            <SectionSummary s={s} grades={index === 0 ? leftGrades : rightGrades} />
                                            <label>
                                                Swap this class
                                                <select
                                                    value=''
                                                    onChange={e => {
                                                        const next = options.find(
                                                            v => v.uniqueId === Number(e.target.value)
                                                        );
                                                        if (next)
                                                            void run(
                                                                () => addOrSwap(schedule.id, next, s.uniqueId),
                                                                'Class changed; metrics updated. Previous combination is in History.'
                                                            );
                                                    }}
                                                >
                                                    <option value=''>Choose a cached section</option>
                                                    {options.map(v => (
                                                        <option key={v.uniqueId} value={v.uniqueId}>
                                                            {v.courseCode} · {v.uniqueId} · {v.title}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                        </article>
                                    );
                                })}
                                <details>
                                    <summary>Weekly calendar</summary>
                                    <div className='comparison-calendar'>
                                        <WeekGrid sections={schedule.courses.map(c => sectionFromCourse(c))} />
                                    </div>
                                </details>
                            </section>
                        )
                )}
            </div>
        </>
    );
}
export function RoadmapTab() {
    const audit = FastlaneAuditStore.useStore(s => s.audit) as ParsedAudit | null;
    const entries = PlanningStore.useStore(s => s.roadmap) as RoadmapEntry[];
    const rules = PlanningStore.useStore(s => s.rules);
    const active = useActiveSchedule();
    const [term, setTerm] = useState(`Spring ${new Date().getFullYear() + 1}`);
    const [code, setCode] = useState('');
    const [hours, setHours] = useState(3);
    const [kind, setKind] = useState<RoadmapEntry['kind']>('course');
    const [message, setMessage] = useState('');
    const projection = roadmapProjection(entries, audit);
    const confirmed = confirmedAuditHours(audit);
    const required = audit?.creditHours.required;
    let cumulative = confirmed;
    const hourTargetTerm = [...projection.terms].find(([, hours]) => {
        cumulative += hours;
        return required !== undefined && cumulative >= required;
    })?.[0];
    const order = (t: string) => Number(t.split(' ')[1]) * 3 + ['Spring', 'Summer', 'Fall'].indexOf(t.split(' ')[0]!);
    return (
        <>
            <h1>Degree roadmap & prerequisites</h1>
            <p>
                Confirmed credit comes from completed courses in your imported audit. Future courses, transfers and CLEP
                are planned until a refreshed audit confirms credit. Hours alone do not prove degree completion;
                completed coursework may not all apply to your degree.
            </p>
            <section className='card planner-glass'>
                <h2>
                    {confirmed} confirmed hours · {projection.planned} additional planned hours
                </h2>
                <p>
                    {required
                        ? `${Math.max(0, required - confirmed - projection.planned)} hours remain after this plan toward the audit’s ${required}-hour minimum.`
                        : 'Import an audit with a total-hour requirement to estimate remaining hours.'}
                </p>
                <p>
                    {audit
                        ? `${audit.requirements.filter(r => r.status === 'completed').length}/${audit.requirements.length} audit requirements marked completed. ${audit.courses.filter(c => c.status === 'pending-transfer').length} pending-transfer course records.`
                        : 'No audit imported. Planned credits will not be called confirmed.'}
                </p>
            </section>
            {hourTargetTerm && (
                <p>
                    Projected hour minimum reached by {hourTargetTerm}. Graduation also depends on all degree
                    requirements, residency rules, prerequisites and credit approval; this is an hours-only estimate.
                </p>
            )}
            <form
                className='card'
                onSubmit={e => {
                    e.preventDefault();
                    if (!/^(Spring|Summer|Fall) 20\d\d$/.test(term) || !code.trim() || hours <= 0 || hours > 20) {
                        setMessage('Use a term such as Summer 2027, a course/exam code and 1–20 hours.');
                        return;
                    }
                    void PlanningStore.set('roadmap', [
                        ...entries,
                        { id: crypto.randomUUID(), term, code: code.trim().toUpperCase(), hours, kind, rule: '' },
                    ]);
                    setCode('');
                    setMessage('Planned credit added.');
                }}
            >
                <h2>Plan a future credit</h2>
                <div className='planner-fields'>
                    <label>
                        Semester
                        <input
                            aria-label='Semester'
                            value={term}
                            onChange={e => setTerm(e.target.value)}
                            placeholder='Summer 2027'
                        />
                    </label>
                    <label>
                        Course or exam code
                        <input required value={code} onChange={e => setCode(e.target.value)} />
                    </label>
                    <label>
                        Hours
                        <input
                            type='number'
                            min='1'
                            max='20'
                            required
                            value={hours}
                            onChange={e => setHours(Number(e.target.value))}
                        />
                    </label>
                    <label>
                        Credit type
                        <select value={kind} onChange={e => setKind(e.target.value as RoadmapEntry['kind'])}>
                            <option value='course'>Course</option>
                            <option value='transfer'>Transfer</option>
                            <option value='CLEP'>CLEP exam</option>
                        </select>
                    </label>
                </div>
                <button className='btn' type='submit'>
                    Add planned credit
                </button>
                <p role='status'>{message}</p>
            </form>
            {[...new Set(entries.map(e => e.term))]
                .sort((a, b) => order(a) - order(b))
                .map(t => (
                    <section className='card planner-glass' key={t}>
                        <h2>
                            {t} · {projection.terms.get(t) ?? 0} new planned hours
                        </h2>
                        {entries
                            .filter(e => e.term === t)
                            .map(e => (
                                <div className='compare-course' key={e.id}>
                                    <b>{e.code}</b> · {e.hours} hours · {e.kind} · Planned
                                    <button
                                        type='button'
                                        className='btn'
                                        onClick={() =>
                                            void PlanningStore.set(
                                                'roadmap',
                                                entries.filter(v => v.id !== e.id)
                                            )
                                        }
                                    >
                                        Remove
                                    </button>
                                </div>
                            ))}
                    </section>
                ))}
            {!entries.length && (
                <p>
                    Add a semester above, including summer, transfer work or CLEP. Duplicate course codes and
                    already-completed courses are excluded from projected new hours.
                </p>
            )}
            <section className='card'>
                <h2>Check prerequisites</h2>
                <p>
                    Enter the catalog’s course-code rule using AND / OR, for example “M 408C AND PHY 303K”. Check
                    minimum grades, consent, standing and equivalencies separately. Unsupported prose is marked Needs
                    verification. Planned future credit is never treated as completed.
                </p>
                {[
                    ...new Set([
                        ...(active?.courses.map(c => `${c.department} ${c.number}`) ?? []),
                        ...entries.filter(e => e.kind === 'course').map(e => e.code),
                    ]),
                ].map(c => {
                    const course = active?.courses.find(v => `${v.department} ${v.number}` === c);
                    const rule = rules[c] ?? catalogPrerequisite(course?.description);
                    const check = prerequisiteStatus(rule, audit);
                    return (
                        <div className='compare-course' key={c}>
                            <label>
                                {c} prerequisite rule
                                <input
                                    value={rule}
                                    placeholder='M 408C AND PHY 303K'
                                    onChange={e => void PlanningStore.set('rules', { ...rules, [c]: e.target.value })}
                                />
                            </label>
                            <b>{check.status}</b>
                            <p>{check.reason}</p>
                        </div>
                    );
                })}
                {!active?.courses.length && !entries.length && (
                    <p>Add a class to your active schedule or roadmap to check its prerequisites.</p>
                )}
            </section>
        </>
    );
}
export function HistoryTab() {
    const snapshots = HistoryStore.useStore(s => s.snapshots) as ScheduleSnapshot[];
    const [message, setMessage] = useState('');
    const restore = async (snapshot: ScheduleSnapshot) => {
        try {
            for (const raw of snapshot.schedules) {
                const s = new UserSchedule(raw as Serialized<UserSchedule>);
                await createPlanningSchedule(
                    `${s.name} (restored)`,
                    s.courses.map(c => sectionFromCourse(c)),
                    snapshot.plans[s.id]
                );
            }
            setMessage('Restored the earlier combination as new schedules. Current plans were preserved.');
        } catch (e) {
            setMessage(String(e));
        }
    };
    return (
        <>
            <h1>Schedule history</h1>
            <p>
                FastLane automatically keeps the 30 most recent schedule changes in this browser. Restore creates new
                schedules so current plans stay available. Audits and registration activity are not included.
                Backup-only edits are not recorded.
            </p>
            <p role='status'>{message}</p>
            {snapshots[0] && (
                <button type='button' className='btn primary' onClick={() => void restore(snapshots[0]!)}>
                    Undo last change by restoring a copy
                </button>
            )}
            {!snapshots.length && (
                <section className='card'>
                    Your next class addition, removal, swap or schedule change will save its previous combination here.
                </section>
            )}
            {snapshots.map(s => (
                <section className='card' key={s.id}>
                    <h2>{new Date(s.at).toLocaleString()}</h2>
                    <p>{s.change}</p>
                    <details>
                        <summary>Earlier combination</summary>
                        {s.schedules.map(v => (
                            <p key={v.id}>
                                {v.name}:{' '}
                                {v.courses.map(c => `${c.department} ${c.number} (${c.uniqueId})`).join(', ') ||
                                    'Empty'}
                            </p>
                        ))}
                    </details>
                    <button type='button' className='btn' onClick={() => void restore(s)}>
                        Restore as new schedules
                    </button>
                </section>
            ))}
        </>
    );
}
