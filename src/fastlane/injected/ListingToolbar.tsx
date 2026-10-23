/**
 * Fastlane's sort and filter bar above UT's course-listing table. It only reorders and hides UT's own rows
 * (never edits them), keeps each section under its course header, and "Reset" puts the page back in UT's
 * order. Grades come from the bundled historical grade database through Fastlane's grade math; ratings from
 * the same cached Rate My Professors lookups the rows show. Both load in small batches, only when a sort or
 * filter needs them, so long listings stay responsive.
 */
import type { ScrapedRow } from '@shared/types/Course';
import type { UserSchedule } from '@shared/types/UserSchedule';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { analyzeRow, gradeStatFrom, lookupGrades, scheduleTimes, sectionFromCourse } from '../adapters/utrp';
import { outstandingTags } from '../audit/parseAudit';
import type { ParsedAudit } from '../audit/types';
import type { ListingControls, RowFacts } from '../core/listingSort';
import { DEFAULT_LISTING_CONTROLS, isDefaultListing, planListing } from '../core/listingSort';
import { detectConflicts } from '../core/meetings';
import type { RmpRating } from '../core/rmp';
import { splitProfessorName } from '../core/rmp';
import { toSectionTimes } from '../core/sections';
import { sendFastlane } from '../services/runtime';
import { FastlaneAuditStore, FastlaneSettingsStore } from '../storage/stores';

const HIDDEN = 'fastlaneHidden';
const BATCH = 8;
const pause = () => new Promise<void>(ok => setTimeout(ok, 0));

const glass: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 14px',
    margin: '10px 0',
    padding: '10px 14px',
    borderRadius: 14,
    background: 'linear-gradient(145deg, rgba(255,255,255,.92), rgba(255,240,226,.6))',
    border: '1px solid rgba(191,87,0,.18)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9), 0 4px 14px rgba(90,50,20,.07)',
    backdropFilter: 'blur(10px) saturate(140%)',
    color: '#333f48',
    fontSize: 13,
    fontFamily: 'inherit',
};
const control: React.CSSProperties = {
    fontSize: 12.5,
    padding: '3px 6px',
    borderRadius: 8,
    border: '1px solid rgba(51,63,72,.25)',
    background: 'rgba(255,255,255,.85)',
};
const chip = (on: boolean): React.CSSProperties => ({
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 999,
    cursor: 'pointer',
    border: `1px solid ${on ? 'rgba(191,87,0,.55)' : 'rgba(51,63,72,.2)'}`,
    background: on ? 'rgba(191,87,0,.12)' : 'rgba(255,255,255,.7)',
    color: on ? '#7a3800' : '#5b6770',
    fontWeight: on ? 600 : 400,
});

export default function ListingToolbar({
    rows,
    activeSchedule,
}: {
    rows: ScrapedRow[];
    activeSchedule?: UserSchedule;
}) {
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    const [controls, setControls] = useState<ListingControls>(DEFAULT_LISTING_CONTROLS);
    const [version, setVersion] = useState(0);
    const [loading, setLoading] = useState('');
    // grades and ratings loaded on demand (undefined = not loaded yet)
    const loaded = useRef(new Map<number, Pick<RowFacts, 'grade' | 'rating'>>());
    const touched = useRef(false);
    const audit = FastlaneAuditStore.useStore(s => s.audit) as ParsedAudit | null;
    const ratingsOn = FastlaneSettingsStore.useStore(s => s.showProfessorRatings);
    const sections = useMemo(() => rows.filter(r => r.course), [rows]);

    useEffect(() => {
        const table = document.querySelector('table');
        if (!table) return;
        const div = document.createElement('div');
        div.id = 'fastlane-listing-toolbar';
        table.before(div);
        setContainer(div);
        return () => div.remove();
    }, []);

    // cheap facts for every section (modality, conflicts with the active schedule, IDA requirement match),
    // computed while rendering from stable keys: the stores can hand back new objects on every render
    const scheduleKey = activeSchedule
        ? `${activeSchedule.id}:${activeSchedule.updatedAt}:${activeSchedule.courses.map(c => c.uniqueId).join(',')}`
        : '';
    const outstandingKey = useMemo(() => {
        // an old or damaged saved IDA must never break UT's page: it just means no IDA matching
        try {
            return audit ? outstandingTags(audit).join('|') : '';
        } catch {
            return '';
        }
    }, [audit]);
    const hasAudit = !!outstandingKey;
    const scheduleRef = useRef(activeSchedule);
    scheduleRef.current = activeSchedule;
    // biome-ignore lint/correctness/useExhaustiveDependencies: scheduleKey stands for the schedule's contents
    const baseFacts = useMemo(() => {
        const schedule = scheduleRef.current;
        const busy = scheduleTimes(schedule);
        const outstanding = new Set(outstandingKey ? outstandingKey.split('|') : []);
        const out = new Map<number, Pick<RowFacts, 'modality' | 'conflict' | 'idaMatch'>>();
        for (const { course, element } of sections) {
            if (!course) continue;
            try {
                const analysis = analyzeRow(element);
                const section = sectionFromCourse(course, analysis);
                const isMine = schedule?.courses.some(c => c.uniqueId === course.uniqueId) ?? false;
                out.set(course.uniqueId, {
                    modality: analysis.modality.modality,
                    conflict:
                        !isMine &&
                        detectConflicts(
                            toSectionTimes(section),
                            busy.filter(b => b.uniqueId !== course.uniqueId)
                        ).status === 'conflict',
                    idaMatch: section.requirementTags.some(t => outstanding.has(t)),
                });
            } catch {
                /* a row UT renders differently is left as is */
            }
        }
        return out;
    }, [sections, scheduleKey, outstandingKey]);

    const needGrades = controls.sort === 'grade' || controls.minGrade > 0;
    const needRatings = controls.sort === 'rating' && ratingsOn;

    // grades and ratings load in small batches, only when asked for, reusing the rows' cached lookups
    useEffect(() => {
        if (!needGrades && !needRatings) return;
        let alive = true;
        void (async () => {
            const todo = sections.filter(({ course }) => {
                if (!course) return false;
                const f = loaded.current.get(course.uniqueId);
                return (needGrades && f?.grade === undefined) || (needRatings && f?.rating === undefined);
            });
            if (!todo.length) return;
            for (let i = 0; i < todo.length && alive; i += BATCH) {
                setLoading(
                    `${needGrades ? 'Grades' : 'Ratings'} ${Math.min(i + BATCH, todo.length)} of ${todo.length}…`
                );
                await Promise.all(
                    todo.slice(i, i + BATCH).map(async ({ course }) => {
                        if (!course) return;
                        const f = loaded.current.get(course.uniqueId) ?? {};
                        loaded.current.set(course.uniqueId, f);
                        if (needGrades && f.grade === undefined) {
                            const stat = gradeStatFrom(course, await lookupGrades(course).catch(() => null), 'A-');
                            f.grade = stat ? stat.result.percent : null;
                        }
                        if (needRatings && f.rating === undefined) {
                            const p = course.instructors[0];
                            const name = p ? splitProfessorName(p.firstName, p.lastName, p.fullName ?? '') : null;
                            const r = name?.last
                                ? await sendFastlane<RmpRating | null>({
                                      type: 'professorRating',
                                      first: name.first,
                                      last: name.last,
                                  }).catch(() => null)
                                : null;
                            f.rating = r && r.numRatings > 0 ? { value: r.avgRating, count: r.numRatings } : null;
                        }
                    })
                );
                if (alive) setVersion(v => v + 1);
                await pause();
            }
            if (alive) setLoading('');
        })();
        return () => {
            alive = false;
        };
    }, [needGrades, needRatings, sections]);

    // apply to UT's table: move and hide whole rows only, never change their contents
    const [counts, setCounts] = useState<{ shown: number; total: number } | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: version signals newly loaded grades/ratings in the ref
    useEffect(() => {
        const plain = isDefaultListing(controls);
        // nothing changed on UT's page yet: leave it completely alone
        if (plain && !touched.current) return;
        const tbody = document.querySelector('table tbody');
        if (!tbody) return;
        const frame = requestAnimationFrame(() => {
            // rows UT (or auto-load) actually placed in the table, in their original order
            const present = rows.filter(r => r.element.parentElement === tbody);
            const facts = new Map<number, RowFacts>();
            for (const [id, base] of baseFacts) facts.set(id, { ...base, ...loaded.current.get(id) });
            const plan = planListing(
                present.map(r => ({ el: r.element as HTMLElement, uniqueId: r.course?.uniqueId ?? null })),
                facts,
                controls
            );
            for (const el of plan.order) tbody.appendChild(el);
            for (const r of present) {
                const el = r.element as HTMLElement;
                if (plan.hidden.has(el)) {
                    el.style.display = 'none';
                    el.dataset[HIDDEN] = '1';
                } else if (el.dataset[HIDDEN]) {
                    el.style.display = '';
                    delete el.dataset[HIDDEN];
                }
            }
            touched.current = !plain;
            const next = plain ? null : { shown: plan.shown, total: plan.total };
            setCounts(prev => (prev?.shown === next?.shown && prev?.total === next?.total ? prev : next));
        });
        return () => cancelAnimationFrame(frame);
    }, [controls, version, rows, baseFacts]);

    if (!container) return null;
    const set = (patch: Partial<ListingControls>) => setControls(c => ({ ...c, ...patch }));
    const toggleMode = (k: keyof ListingControls['modes']) =>
        setControls(c => ({ ...c, modes: { ...c.modes, [k]: !c.modes[k] } }));

    return createPortal(
        <section style={glass} aria-label='Fastlane sort and filter'>
            <strong style={{ color: '#bf5700' }}>Fastlane</strong>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                Sort
                <select
                    style={control}
                    value={controls.sort}
                    onChange={e => set({ sort: e.target.value as ListingControls['sort'] })}
                    aria-label='Sort sections'
                >
                    <option value='ut'>UT order</option>
                    <option value='grade'>Highest A/A− rate</option>
                    <option value='rating' disabled={!ratingsOn}>
                        Professor rating{ratingsOn ? '' : ' (turn on in Fastlane settings)'}
                    </option>
                </select>
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                A− or better
                <select
                    style={control}
                    value={controls.minGrade}
                    onChange={e => set({ minGrade: Number(e.target.value) })}
                    aria-label='Minimum percentage of A− or better'
                    title='Historical share of letter grades that were A− or better. Sections without grade data are hidden by this filter.'
                >
                    <option value={0}>Any</option>
                    {[50, 60, 70, 80, 90].map(n => (
                        <option key={n} value={n}>
                            ≥ {n}%
                        </option>
                    ))}
                </select>
            </label>
            <fieldset
                style={{ display: 'inline-flex', gap: 6, border: 0, padding: 0, margin: 0 }}
                aria-label='Class format'
            >
                <button
                    type='button'
                    style={chip(controls.modes.inPerson)}
                    aria-pressed={controls.modes.inPerson}
                    onClick={() => toggleMode('inPerson')}
                >
                    In person
                </button>
                <button
                    type='button'
                    style={chip(controls.modes.live)}
                    aria-pressed={controls.modes.live}
                    onClick={() => toggleMode('live')}
                >
                    Live online
                </button>
                <button
                    type='button'
                    style={chip(controls.modes.async)}
                    aria-pressed={controls.modes.async}
                    onClick={() => toggleMode('async')}
                >
                    Async online
                </button>
            </fieldset>
            <label style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <input
                    type='checkbox'
                    checked={controls.hideConflicts}
                    onChange={e => set({ hideConflicts: e.target.checked })}
                    disabled={!activeSchedule?.courses.length}
                />
                Hide conflicts with {activeSchedule?.name ?? 'my schedule'}
            </label>
            <label
                style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}
                title={hasAudit ? undefined : 'Import your IDA in Fastlane first'}
            >
                <input
                    type='checkbox'
                    checked={controls.idaFirst}
                    onChange={e => set({ idaFirst: e.target.checked })}
                    disabled={!hasAudit}
                />
                My IDA requirements first
            </label>
            <button
                type='button'
                style={{ ...chip(false), fontWeight: 600 }}
                onClick={() => setControls(DEFAULT_LISTING_CONTROLS)}
                disabled={isDefaultListing(controls)}
            >
                Reset to UT order
            </button>
            <span role='status' style={{ fontSize: 12, color: '#5b6770' }}>
                {loading || (counts ? `Showing ${counts.shown} of ${counts.total} sections` : '')}
            </span>
        </section>,
        container
    );
}
