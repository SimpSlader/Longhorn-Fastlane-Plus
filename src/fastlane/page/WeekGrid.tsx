/**
 * Weekly calendar in UT Registration Plus's layout: time column, orange weekday headers,
 * bold course-colored blocks ("MUS 302L – Middleton", time, room), and an ASYNC / OTHER row.
 * Only ACTIVE sections are drawn; backups never appear here until activated.
 */
import type { DayCode } from '../core/meetings';
import { formatMinutes, scheduleConflicts } from '../core/meetings';
import type { SectionRecord } from '../core/sections';
import { toSectionTimes } from '../core/sections';
import { sectionColor } from './common';

const DAYS: Array<[DayCode, string]> = [
    ['M', 'Mon'],
    ['T', 'Tue'],
    ['W', 'Wed'],
    ['TH', 'Thu'],
    ['F', 'Fri'],
];
const HOUR_PX = 64;

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

export default function WeekGrid({ sections }: { sections: SectionRecord[] }) {
    const timed = sections.filter(s => s.meetings.length);
    const starts = timed.flatMap(s => s.meetings.map(m => m.start));
    const ends = timed.flatMap(s => s.meetings.map(m => m.end));
    const first = Math.min(8 * 60, ...starts.map(t => Math.floor(t / 60) * 60));
    const last = Math.max(18 * 60, ...ends.map(t => Math.ceil(t / 60) * 60));
    const px = HOUR_PX / 60;
    const height = (last - first) * px;
    const conflicted = new Set(
        scheduleConflicts(sections.map(toSectionTimes)).flatMap(([a, b]) => [a.uniqueId, b.uniqueId])
    );
    const hours: number[] = [];
    for (let t = first; t <= last; t += 60) hours.push(t);
    const untimed = sections.filter(s => !s.meetings.length);

    return (
        <div className='card' style={{ padding: '14px 16px 8px' }}>
            <div className='week' role='img' aria-label='Weekly calendar of active classes'>
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
                            {sections.flatMap((s, i) =>
                                s.meetings
                                    .filter(m => m.days.includes(day))
                                    .map(m => (
                                        <div
                                            key={`${s.uniqueId}-${m.days.join('')}-${m.start}`}
                                            className={`block ${conflicted.has(s.uniqueId) ? 'conflict' : ''}`}
                                            style={{
                                                top: (m.start - first) * px + 1,
                                                height: Math.max(22, (m.end - m.start) * px - 2),
                                                background: sectionColor(s, i),
                                            }}
                                            title={`${blockTitle(s)} (${s.uniqueId}) ${formatMinutes(m.start)} – ${formatMinutes(m.end)} ${m.location ?? ''}`}
                                        >
                                            <b>{blockTitle(s)}</b>
                                            <div>
                                                {formatMinutes(m.start)} – {formatMinutes(m.end)}
                                            </div>
                                            {m.location && m.location !== 'WB' && <div>{m.location}</div>}
                                        </div>
                                    ))
                            )}
                        </div>
                    </div>
                ))}
            </div>
            <div className='async-row'>
                <span className='label'>Async / Other</span>
                {untimed.length === 0 && <span className='small muted'>None</span>}
                {untimed.map(s => (
                    <span
                        key={s.uniqueId}
                        className='course-pill'
                        style={{ background: sectionColor(s, sections.indexOf(s)) }}
                        title={s.modality === 'async-online' ? 'Asynchronous online' : 'Meeting times not listed'}
                    >
                        {blockTitle(s)}
                    </span>
                ))}
            </div>
        </div>
    );
}
