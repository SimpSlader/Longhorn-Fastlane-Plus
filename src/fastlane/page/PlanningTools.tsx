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
import { type SectionRecord, semesterKey, subjectOf } from '../core/sections';
import { utSubjectScheduleUrl } from '../data/subjects';
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
import { InventoryPanel, inventorySubjects, SectionEvidence, useInventory } from './CourseInventory';
import { useGradeStats } from './hooks';

const ROW_LIMIT = 120;

import WeekGrid from './WeekGrid';

export function HomeTab({ go }: { go: (tab: string) => void }) {
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const active = useActiveSchedule();
    const requirements = audit?.requirements ?? [];
    const completed = requirements.filter(r => r.status === 'completed').length;
    const remaining = requirements.filter(r => r.status !== 'completed').length;
    const trackedPercent = requirements.length ? Math.round((completed / requirements.length) * 100) : 0;
    const hours = audit?.creditHours;
    return (
        <div className='stack'>
            <div className='simple-heading'>
                <span className='eyebrow'>YOUR DEGREE, SIMPLIFIED</span>
                <h1>Plan your next semester.</h1>
                <p>See what you need, find a great section, and build your schedule.</p>
            </div>
            {!audit ? (
                <section className='card glass-hero'>
                    <span className='eyebrow'>START HERE</span>
                    <h2>Connect your degree audit</h2>
                    <p className='muted'>
                        Import your UT Interactive Degree Audit (IDA) so Fastlane can recommend classes for requirements
                        you still need.
                    </p>
                    <div className='row'>
                        <button type='button' className='btn primary' onClick={() => go('audit')}>
                            Import my IDA
                        </button>
                        <button type='button' className='btn' onClick={() => go('finder')}>
                            Browse classes instead
                        </button>
                    </div>
                    <p className='small muted'>
                        IDA information is stored locally. You'll review anything the importer isn't certain about.
                    </p>
                </section>
            ) : (
                <section className='card glass-hero'>
                    <div className='row between'>
                        <div>
                            <span className='eyebrow'>FROM YOUR IMPORTED IDA</span>
                            <h2>{audit.program || 'Degree progress'}</h2>
                        </div>
                        <button type='button' className='btn sm' onClick={() => go('audit')}>
                            Review audit →
                        </button>
                    </div>
                    <div className='progress-summary'>
                        <div className='progress-big'>
                            {completed}
                            <span> / {requirements.length}</span>
                        </div>
                        <div className='progress-info'>
                            <b>Tracked requirements completed</b>
                            <div
                                className='progress-track'
                                role='progressbar'
                                aria-label='Completed tracked audit requirements'
                                aria-valuenow={completed}
                                aria-valuemin={0}
                                aria-valuemax={requirements.length || 1}
                            >
                                <span style={{ width: `${trackedPercent}%` }} />
                            </div>
                            <span className='small muted'>
                                {remaining} unfinished · {trackedPercent}% of parsed requirements
                            </span>
                        </div>
                    </div>
                    <div className='summary-pills'>
                        {hours?.required && hours?.applied !== undefined && (
                            <span>
                                {hours.applied} of {hours.required} degree hours applied
                            </span>
                        )}
                        {hours?.remaining !== undefined && <span>{hours.remaining} hours remaining</span>}
                        <span>{audit.transfer.pending.length} pending transfer/exam credits</span>
                    </div>
                    <p className='small muted'>
                        Requirements are parsed from your IDA, not an official graduation percentage. Confirm your
                        degree progress with UT.
                    </p>
                </section>
            )}
            <div className='simple-cards'>
                <button type='button' className='simple-action card' onClick={() => go(audit ? 'recommend' : 'audit')}>
                    <span className='action-icon'>01</span>
                    <h3>{audit ? 'Find recommended classes' : 'Check degree progress'}</h3>
                    <p>
                        {audit
                            ? 'Match courses to unfinished IDA requirements.'
                            : 'Import your IDA to see what is left.'}
                    </p>
                    <span className='action-arrow'>Explore →</span>
                </button>
                <button type='button' className='simple-action card' onClick={() => go('finder')}>
                    <span className='action-icon'>02</span>
                    <h3>Filter classes</h3>
                    <p>Search by department, days, professor or historical A grades.</p>
                    <span className='action-arrow'>Browse →</span>
                </button>
                <button type='button' className='simple-action card' onClick={() => go('plan')}>
                    <span className='action-icon'>03</span>
                    <h3>My schedule</h3>
                    <p>
                        {active?.courses.length
                            ? `${active.courses.length} classes in ${active.name}.`
                            : 'Build a weekly schedule and keep backup sections.'}
                    </p>
                    <span className='action-arrow'>Open schedule →</span>
                </button>
            </div>
        </div>
    );
}
function FilterControls({
    value: f,
    onChange: set,
    terms,
    tags,
    departments,
    gradeThreshold,
    onGradeThresholdChange,
    showFits = true,
}: {
    value: PlannerFilters;
    onChange: (v: PlannerFilters) => void;
    terms: string[];
    tags: string[];
    departments: Array<{ code: string; name: string }>;
    gradeThreshold: 'A' | 'A-';
    onGradeThresholdChange: (v: 'A' | 'A-') => void;
    showFits?: boolean;
}) {
    const update = (v: Partial<PlannerFilters>) => set({ ...f, ...v });
    return (
        <section className='card planner-glass compact-filters' aria-label='Course filters'>
            <div className='filter-top'>
                <h2>Filters</h2>
                <button
                    type='button'
                    className='btn sm ghost'
                    onClick={() => set({ ...DEFAULT_FILTERS, semester: f.semester })}
                >
                    Clear filters
                </button>
            </div>
            <div className='simple-filter-grid'>
                <label>
                    Semester
                    <select
                        aria-label='Semester'
                        value={f.semester}
                        onChange={e => update({ semester: e.target.value })}
                    >
                        <option value=''>Choose semester</option>
                        {terms.map(t => (
                            <option key={t} value={t}>
                                {t}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Subject
                    <select
                        aria-label='Subject'
                        value={f.department ?? ''}
                        onChange={e => update({ department: e.target.value })}
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
                    Course or keyword
                    <input
                        aria-label='Course or keyword'
                        type='text'
                        value={f.query}
                        onChange={e => update({ query: e.target.value })}
                        placeholder='UGS 302, Economics…'
                    />
                </label>
                <label>
                    Historical grade
                    <select
                        aria-label='Historical grade metric'
                        value={gradeThreshold}
                        onChange={e => onGradeThresholdChange(e.target.value as 'A' | 'A-')}
                    >
                        <option value='A'>A percentage</option>
                        <option value='A-'>A− or better percentage</option>
                    </select>
                </label>
                <label>
                    Minimum {gradeThreshold === 'A' ? 'A' : 'A− or better'} rate
                    <select
                        aria-label='Minimum historical A minus percentage'
                        value={f.minGrade}
                        onChange={e => update({ minGrade: Number(e.target.value) })}
                    >
                        <option value={0}>Any grade history</option>
                        <option value={60}>60%+</option>
                        <option value={70}>70%+</option>
                        <option value={80}>80%+</option>
                        <option value={90}>90%+</option>
                    </select>
                </label>
                <label>
                    Class type
                    <select
                        aria-label='Class type'
                        value={f.modality}
                        onChange={e => update({ modality: e.target.value })}
                    >
                        <option value=''>Any type</option>
                        <option value='async-online'>Online, asynchronous</option>
                        <option value='live-online'>Online, live</option>
                        <option value='in-person'>In person</option>
                        <option value='hybrid'>Hybrid</option>
                    </select>
                </label>
            </div>
            <div className='day-filter'>
                <span className='small muted'>Days I can take classes</span>
                <fieldset className='day-chips' aria-label='Allowed class days'>
                    {DAY_ORDER.map(d => (
                        <button
                            type='button'
                            key={d}
                            className='day-chip'
                            aria-pressed={f.days.includes(d)}
                            onClick={() =>
                                update({ days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d] })
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
                    <button type='button' className='btn sm' onClick={() => update({ days: ['M', 'T', 'W', 'TH'] })}>
                        No Fridays
                    </button>
                </fieldset>
            </div>
            {showFits && (
                <label className='check simple-fit'>
                    <input type='checkbox' checked={f.fits} onChange={e => update({ fits: e.target.checked })} />
                    Only classes that fit my schedule
                </label>
            )}
            <details className='more-filters'>
                <summary>More filters</summary>
                <div className='planner-fields'>
                    <label>
                        Professor
                        <input
                            type='text'
                            value={f.professor}
                            onChange={e => update({ professor: e.target.value })}
                            placeholder='Professor name'
                        />
                    </label>
                    <label>
                        Credit hours
                        <select value={f.hours} onChange={e => update({ hours: Number(e.target.value) })}>
                            <option value='0'>Any credit hours</option>
                            {[1, 2, 3, 4, 5, 6].map(h => (
                                <option key={h} value={h}>
                                    {h}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Degree requirement
                        <select value={f.requirement} onChange={e => update({ requirement: e.target.value })}>
                            <option value=''>Any requirement</option>
                            {tags.map(t => (
                                <option key={t} value={t}>
                                    {t}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        Earliest class start
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
                        Latest class end
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
            </details>
            <p className='small muted'>
                Grade percentages are historical {gradeThreshold === 'A' ? 'A rates' : 'A− or better rates'}, not
                predictions. Filtering by a percentage excludes sections with no grade data.
            </p>
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
                    ? `${g.result.percent.toFixed(1)}% ${g.result.threshold === 'A' ? 'A' : 'A− or better'} · ${g.result.graded} historical grades · ${g.scope}${g.smallSample ? ' · small sample' : ''}`
                    : 'Historical grades unavailable'}
            </p>
            <SectionEvidence s={s} />
        </>
    );
}
export function FinderTab({
    generate = false,
    embedded = false,
    subject,
    onSubjectChange,
}: {
    generate?: boolean;
    embedded?: boolean;
    subject?: string;
    onSubjectChange?: (code: string) => void;
}) {
    const inventory = useInventory();
    const catalog = inventory.sections;
    const loaded = inventory.loaded;
    const [filters, setFilters] = useState<PlannerFilters>({ ...DEFAULT_FILTERS });
    const [gradeThreshold, setGradeThreshold] = useState<'A' | 'A-'>('A-');
    const [selected, setSelected] = useState<string[]>([]);
    const [result, setResult] = useState<ReturnType<typeof generateSchedules> | null>(null);
    const [message, setMessage] = useState('');
    const active = useActiveSchedule();
    const audit = FastlaneAuditStore.useStore(s => s.audit) as ParsedAudit | null;
    const terms = [...new Set(catalog.map(s => semesterKey(s.semester)))].filter(t => t !== 'unknown');
    const departments = inventorySubjects(inventory);
    useEffect(() => {
        if (catalog.length && !filters.semester) {
            const lastSeen = [...catalog].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))[0];
            if (lastSeen) setFilters(f => ({ ...f, semester: semesterKey(lastSeen.semester) }));
        }
    }, [catalog, filters.semester]);
    useEffect(() => {
        if (subject !== undefined) setFilters(f => (f.department === subject ? f : { ...f, department: subject }));
    }, [subject]);
    const pool = useMemo(
        () => catalog.filter(s => semesterKey(s.semester) === filters.semester),
        [catalog, filters.semester]
    );
    // cheap filters first, so historical grades are looked up only for what the student is looking at
    const narrowed = useMemo(
        () =>
            pool.filter(
                s =>
                    (!filters.department || subjectOf(s.courseCode) === filters.department.toUpperCase()) &&
                    `${s.courseCode} ${s.title}`.toLowerCase().includes(filters.query.toLowerCase()) &&
                    s.instructors.join(' ').toLowerCase().includes(filters.professor.toLowerCase())
            ),
        [pool, filters.department, filters.query, filters.professor]
    );
    const gradeTargets = useMemo(
        () =>
            generate
                ? narrowed.filter(s => selected.includes(s.courseCode))
                : narrowed.slice(0, filters.department || filters.query || filters.professor ? 200 : 100),
        [generate, narrowed, selected, filters.department, filters.query, filters.professor]
    );
    const grades = useGradeStats(gradeTargets, gradeThreshold);
    const activeSections = useMemo(() => active?.courses.map(c => sectionFromCourse(c)) ?? [], [active]);
    const tags = [...new Set(pool.flatMap(s => s.requirementTags))].sort();
    const needed = new Set(audit?.requirements.filter(r => r.status !== 'completed').flatMap(r => r.tags) ?? []);
    const finished = new Set(
        audit?.courses.filter(c => c.status === 'completed').map(c => normalizeCourseCode(c.code)) ?? []
    );
    const rows = narrowed
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
        ...new Set(
            narrowed
                .filter(s => !finished.has(normalizeCourseCode(s.courseCode)) || selected.includes(s.courseCode))
                .map(s => s.courseCode)
        ),
    ];
    const shownCodes = [...new Set([...selected, ...codes.slice(0, 200)])];
    const shownRows = rows.slice(0, ROW_LIMIT);
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
            {!embedded && <h1>{generate ? 'Build a schedule' : 'Browse classes'}</h1>}
            {!embedded && <InventoryPanel />}
            <FilterControls
                value={filters}
                onChange={f => {
                    if (f.semester !== filters.semester) setSelected([]);
                    if (onSubjectChange && f.department !== filters.department) onSubjectChange(f.department ?? '');
                    setFilters(f);
                    setResult(null);
                }}
                terms={terms}
                tags={tags}
                departments={departments}
                gradeThreshold={gradeThreshold}
                onGradeThresholdChange={setGradeThreshold}
                showFits={!generate}
            />
            <p role='status'>{message}</p>
            {loaded &&
                filters.department &&
                filters.semester &&
                !narrowed.length &&
                !filters.query &&
                !filters.professor && (
                    <div className='notice small' role='status'>
                        No {departments.find(d => d.code === filters.department)?.name ?? filters.department} sections
                        are listed for {filters.semester}.{' '}
                        {inventory.metas.some(m => m.term === filters.semester)
                            ? "UT's course list for this semester has no sections in this subject."
                            : "Import UT's course list above to see every subject's classes for this semester."}{' '}
                        <a
                            href={utSubjectScheduleUrl(filters.semester, filters.department ?? '')}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            Check this subject on UT's course schedule
                        </a>
                        .
                    </div>
                )}
            {!loaded ? (
                <p>Loading classes…</p>
            ) : !catalog.length ? (
                <p className='muted'>
                    No classes yet. Import UT's course list above. Fastlane never invents sections, and choosing
                    Economics never shows other subjects.
                </p>
            ) : !filters.semester ? (
                <p>Choose a semester to see classes.</p>
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
                                {codes.length > shownCodes.length && (
                                    <p className='small muted'>
                                        Showing {shownCodes.length} of {codes.length} courses. Choose a subject or
                                        search to narrow the list.
                                    </p>
                                )}
                                <div className='course-choices'>
                                    {shownCodes.map(code => (
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
                                {rows.length.toLocaleString()} matching sections · sorted by unfinished requirement
                                matches, then historical A− or better. Course-wide grades and small samples are labeled.
                                {rows.length > shownRows.length &&
                                    ` Showing the first ${shownRows.length}; choose a subject or search to narrow.`}
                            </p>
                            {!rows.length && (
                                <p>No sections meet these filters. Try Reset filters or another subject.</p>
                            )}
                            <div className='planner-results'>
                                {shownRows.map(s => (
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
