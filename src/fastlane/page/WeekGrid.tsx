/**
 * Weekly calendar in UT Registration Plus's layout: time column, orange weekday headers,
 * bold course-colored blocks ("MUS 302L – Middleton", time, room), and an ASYNC / OTHER row.
 * Only ACTIVE sections are drawn; backups never appear here until activated.
 */
import { lazy, Suspense, useState } from 'react';
import type { DayCode, Meeting } from '../core/meetings';
import { formatMinutes, scheduleConflicts } from '../core/meetings';
import type { SectionRecord } from '../core/sections';
import { toSectionTimes } from '../core/sections';
import { COURSE_PALETTE } from '../core/wallpaper';
import { sectionColor } from './common';

const DAYS: Array<[DayCode, string]> = [
    ['M', 'Mon'],
    ['T', 'Tue'],
    ['W', 'Wed'],
    ['TH', 'Thu'],
    ['F', 'Fri'],
];
const HOUR_PX = 64;
// UTRP's popup (and its styles) load only when a class is opened
const CoursePopup = lazy(() => import('./CoursePopup'));

/** One color per class: a saved color shared with an earlier, different class falls back to the palette. */
function distinctColors(sections: SectionRecord[]): Map<number, string> {
    const out = new Map<number, string>();
    const used = new Set<string>();
    let next = 0;
    for (const [i, s] of sections.entries()) {
        let color = sectionColor(s, i);
        while (used.has(color.toLowerCase()) && next < COURSE_PALETTE.length * 2) {
            color = COURSE_PALETTE[next % COURSE_PALETTE.length]!;
            next++;
        }
        used.add(color.toLowerCase());
        out.set(s.uniqueId, color);
    }
    return out;
}

/** Side-by-side lanes for blocks that overlap on the same day, so none hides another. */
function lanes(blocks: Array<{ m: Meeting }>): Array<{ lane: number; of: number }> {
    const order = blocks.map((b, i) => i).sort((a, b) => blocks[a]!.m.start - blocks[b]!.m.start);
    const out: Array<{ lane: number; of: number }> = blocks.map(() => ({ lane: 0, of: 1 }));
    let cluster: number[] = [];
    let ends: number[] = [];
    let clusterEnd = -1;
    const close = () => {
        for (const i of cluster) out[i]!.of = ends.length;
        cluster = [];
        ends = [];
    };
    for (const i of order) {
        const { start, end } = blocks[i]!.m;
        if (start >= clusterEnd) close();
        let lane = ends.findIndex(e => e <= start);
        if (lane < 0) lane = ends.push(end) - 1;
        else ends[lane] = end;
        out[i]!.lane = lane;
        cluster.push(i);
        clusterEnd = Math.max(clusterEnd, end);
    }
    close();
    return out;
}

export function blockTitle(s: SectionRecord): string {
    const last = s.instructors[0]?.split(',')[0]?.trim();
    const pretty = last ? last.charAt(0) + last.slice(1).toLowerCase() : '';
    return pretty ? `${s.courseCode} – ${pretty}` : s.courseCode;
}

function hourLabel(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${h >= 12 ? 'PM' : 'AM'}`;
}

export default function WeekGrid({
    sections,
    compact = false,
    label = 'Weekly calendar of active classes',
    onSelect,
    selectedId,
    changed,
}: {
    sections: SectionRecord[];
    /** smaller hours and type, for the AI proposal */
    compact?: boolean;
    label?: string;
    /** when set, clicking a class selects it here instead of opening UTRP's popup */
    onSelect?: (s: SectionRecord) => void;
    selectedId?: number | null;
    /** classes that are new in this version (outlined) */
    changed?: Set<number>;
}) {
    const timed = sections.filter(s => s.meetings.length);
    const starts = timed.flatMap(s => s.meetings.map(m => m.start));
    const ends = timed.flatMap(s => s.meetings.map(m => m.end));
    const first = Math.min(compact ? 9 * 60 : 8 * 60, ...starts.map(t => Math.floor(t / 60) * 60));
    const last = Math.max(compact ? 17 * 60 : 18 * 60, ...ends.map(t => Math.ceil(t / 60) * 60));
    const px = (compact ? 40 : HOUR_PX) / 60;
    const height = (last - first) * px;
    const conflicted = new Set(
        scheduleConflicts(sections.map(toSectionTimes)).flatMap(([a, b]) => [a.uniqueId, b.uniqueId])
    );
    const hours: number[] = [];
    for (let t = first; t <= last; t += 60) hours.push(t);
    const untimed = sections.filter(s => !s.meetings.length);
    const colors = distinctColors(sections);
    const [opened, setOpenedState] = useState<SectionRecord | null>(null);
    const setOpened = (s: SectionRecord) => (onSelect ? onSelect(s) : setOpenedState(s));
    const state = (s: SectionRecord) =>
        `${conflicted.has(s.uniqueId) ? 'conflict' : ''} ${changed?.has(s.uniqueId) ? 'changed' : ''} ${selectedId === s.uniqueId ? 'selected' : ''}`;

    return (
        <div className={`card ${compact ? 'week-compact' : ''}`} style={{ padding: '14px 16px 8px' }}>
            <section className='week' aria-label={label}>
                <div>
                    <div className='dayhead'>&nbsp;</div>
                    <div style={{ position: 'relative', height }}>
                        {hours.map(h => (
                            <div
                                key={h}
                                className='hour'
                                style={{ position: 'absolute', top: (h - first) * px - 10, right: 0 }}
                            >
                                {hourLabel(h)}
                            </div>
                        ))}
                    </div>
                </div>
                {DAYS.map(([day, label]) => (
                    <div key={day} className='col'>
                        <div className='dayhead'>{label}</div>
                        <div style={{ position: 'relative', height }}>
                            {hours.map(h => (
                                <div
                                    key={h}
                                    style={{
                                        position: 'absolute',
                                        left: 0,
                                        right: 0,
                                        top: (h - first) * px,
                                        borderTop: '1px solid var(--grid)',
                                    }}
                                />
                            ))}
                            {(() => {
                                const blocks = sections.flatMap(s =>
                                    s.meetings.filter(m => m.days.includes(day)).map(m => ({ s, m }))
                                );
                                const lane = lanes(blocks);
                                return blocks.map(({ s, m }, i) => {
                                    const { lane: at, of } = lane[i]!;
                                    return (
                                        <button
                                            type='button'
                                            key={`${s.uniqueId}-${m.days.join('')}-${m.start}`}
                                            className={`week-block ${state(s)}`}
                                            aria-pressed={onSelect ? selectedId === s.uniqueId : undefined}
                                            style={{
                                                top: (m.start - first) * px + 1,
                                                height: Math.max(22, (m.end - m.start) * px - 2),
                                                left: `calc(${(at / of) * 100}% + 3px)`,
                                                width: `calc(${100 / of}% - 6px)`,
                                                background: colors.get(s.uniqueId),
                                            }}
                                            title={`${blockTitle(s)} (${s.uniqueId}) ${formatMinutes(m.start)} – ${formatMinutes(m.end)} ${m.location ?? ''}${conflicted.has(s.uniqueId) ? ' · time conflict' : ''}`}
                                            onClick={() => setOpened(s)}
                                        >
                                            <b>{blockTitle(s)}</b>
                                            <div>
                                                {formatMinutes(m.start)} – {formatMinutes(m.end)}
                                            </div>
                                            {m.location && m.location !== 'WB' && <div>{m.location}</div>}
                                        </button>
                                    );
                                });
                            })()}
                        </div>
                    </div>
                ))}
            </section>
            <div className='async-row'>
                <span className='label'>Async / Other</span>
                {untimed.length === 0 && <span className='small muted'>None</span>}
                {untimed.map(s => (
                    <button
                        type='button'
                        key={s.uniqueId}
                        className={`course-pill ${state(s)}`}
                        style={{ background: colors.get(s.uniqueId) }}
                        title={s.modality === 'async-online' ? 'Asynchronous online' : 'Meeting times not listed'}
                        onClick={() => setOpened(s)}
                    >
                        {blockTitle(s)}
                    </button>
                ))}
            </div>
            {opened && (
                <Suspense fallback={null}>
                    <CoursePopup section={opened} onClosed={() => setOpenedState(null)} />
                </Suspense>
            )}
        </div>
    );
}
