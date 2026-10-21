/**
 * Campus map for the final (active) schedule. Uses UT Registration Plus's bundled campus SVG and
 * walkway graph, so it works offline. Paths along that graph are ESTIMATES, not turn-by-turn routes.
 */
import { MainCampusBuildings } from '@shared/types/MainCampusBuildings';
import { graphNodes } from '@views/components/map/graphNodes';
import { PathFinder } from '@views/components/map/PathFinder';
import { PIXELS_TO_FEET, WALKING_SPEED } from '@views/components/map/types';
import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useMemo, useState } from 'react';

import { sectionFromCourse } from '../adapters/utrp';
import type { Stop } from '../core/campus';
import { DAY_COLORS, legs, stopsForDay, walkingDirectionsUrl } from '../core/campus';
import type { DayCode } from '../core/meetings';
import { formatMinutes } from '../core/meetings';
import { PageHead } from './common';

const MAP_URL = new URL('/src/assets/UT-Map.svg', import.meta.url).href;
const W = 783;
const H = 753;
const DAYS: Array<[DayCode, string]> = [
    ['M', 'Monday'],
    ['T', 'Tuesday'],
    ['W', 'Wednesday'],
    ['TH', 'Thursday'],
    ['F', 'Friday'],
];

const finder = new PathFinder(graphNodes);

function buildingName(code?: string): string | undefined {
    if (!code) return undefined;
    const b = (MainCampusBuildings as Record<string, { name: string }>)[code];
    return b ? b.name.replace(/\s*\(.*\)$/, '') : undefined;
}

function nodeFor(code?: string) {
    return code ? graphNodes[code] : undefined;
}

function estimatedPath(
    from: string,
    to: string
): { points: Array<{ x: number; y: number }>; estimated: 'walkway' | 'straight' } {
    try {
        const ids = finder.findPath(from, to);
        const points = ids.map(id => graphNodes[id]).filter(Boolean) as Array<{ x: number; y: number }>;
        if (points.length >= 2) return { points, estimated: 'walkway' };
    } catch {
        /* fall through to straight line */
    }
    const a = graphNodes[from]!;
    const b = graphNodes[to]!;
    return { points: [a, b], estimated: 'straight' };
}

function pathLength(points: Array<{ x: number; y: number }>): number {
    let d = 0;
    for (let i = 1; i < points.length; i++)
        d += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    return d;
}

export default function MapTab() {
    const schedule = useActiveSchedule();
    const sections = useMemo(() => schedule?.courses.map(c => sectionFromCourse(c)) ?? [], [schedule]);
    const firstDay = DAYS.find(([d]) => stopsForDay(sections, d).length)?.[0] ?? 'M';
    const [day, setDay] = useState<DayCode>(firstDay);
    const stops = stopsForDay(sections, day);
    const dayLegs = legs(stops);
    const color = DAY_COLORS[day];
    const onlineOnly = sections.filter(s => !s.meetings.some(m => nodeFor((m.location ?? '').split(' ')[0])));

    const pinStops = stops.filter(s => nodeFor(s.building));
    const unmapped = stops.filter(s => s.building && !nodeFor(s.building));

    return (
        <div className='stack'>
            <PageHead
                title='Campus map'
                subtitle={`Your active schedule (${schedule?.name ?? 'none'}) by weekday. Works offline with the bundled campus map.`}
                actions={
                    <fieldset className='tabs' aria-label='Day'>
                        {DAYS.map(([d, label]) => (
                            <button
                                key={d}
                                type='button'
                                aria-pressed={day === d}
                                onClick={() => setDay(d)}
                                style={
                                    day === d ? { background: DAY_COLORS[d], borderColor: DAY_COLORS[d] } : undefined
                                }
                            >
                                {label.slice(0, 3)} ({stopsForDay(sections, d).length})
                            </button>
                        ))}
                    </fieldset>
                }
            />
            <div className='grid2' style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(260px, 2fr)' }}>
                <div className='map-wrap'>
                    <svg
                        viewBox={`0 0 ${W} ${H}`}
                        role='img'
                        aria-label={`Campus map for ${DAYS.find(d => d[0] === day)?.[1]}`}
                    >
                        <image href={MAP_URL} x={0} y={0} width={W} height={H} />
                        {dayLegs.map(leg => {
                            const from = leg.from.building!;
                            const to = leg.to.building!;
                            if (!nodeFor(from) || !nodeFor(to)) return null;
                            const { points, estimated } = estimatedPath(from, to);
                            return (
                                <polyline
                                    key={`${from}-${to}-${leg.to.order}`}
                                    points={points.map(p => `${p.x},${p.y}`).join(' ')}
                                    fill='none'
                                    stroke={color}
                                    strokeWidth={4}
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                    strokeDasharray={estimated === 'straight' ? '6 6' : undefined}
                                    opacity={0.85}
                                />
                            );
                        })}
                        {pinStops.map(s => {
                            const n = nodeFor(s.building)!;
                            return (
                                <g key={`${s.section.uniqueId}-${s.order}`} transform={`translate(${n.x},${n.y})`}>
                                    <title>
                                        {`${s.order}. ${s.section.courseCode} ${formatMinutes(s.meeting.start)}–${formatMinutes(s.meeting.end)} · ${s.building} ${s.room ?? ''}`}
                                    </title>
                                    <circle r={11} fill={color} stroke='#fff' strokeWidth={2.5} />
                                    <text textAnchor='middle' dy={4} fontSize={11} fontWeight={800} fill='#fff'>
                                        {s.order}
                                    </text>
                                    <g transform='translate(14,-10)'>
                                        <rect
                                            x={0}
                                            y={0}
                                            rx={4}
                                            width={Math.max(84, s.section.courseCode.length * 6.6 + 12)}
                                            height={30}
                                            fill='#fff'
                                            stroke={color}
                                        />
                                        <text x={6} y={12} fontSize={10} fontWeight={700} fill='#111'>
                                            {s.section.courseCode}
                                        </text>
                                        <text x={6} y={24} fontSize={9} fill='#333'>
                                            {formatMinutes(s.meeting.start)} · {s.building} {s.room ?? ''}
                                        </text>
                                    </g>
                                </g>
                            );
                        })}
                    </svg>
                </div>
                <div className='stack'>
                    {stops.length === 0 && <div className='card muted'>No scheduled classes on this day.</div>}
                    {stops.map((s: Stop, i) => {
                        const prev = stops[i - 1];
                        const fromName = buildingName(prev?.building);
                        const toName = buildingName(s.building);
                        const leg = dayLegs.find(l => l.to === s);
                        const est =
                            leg && nodeFor(leg.from.building) && nodeFor(leg.to.building)
                                ? estimatedPath(leg.from.building!, leg.to.building!)
                                : null;
                        const minutes = est
                            ? Math.round((pathLength(est.points) * PIXELS_TO_FEET) / WALKING_SPEED)
                            : null;
                        return (
                            <div
                                key={`${s.section.uniqueId}-${s.order}`}
                                className='card'
                                style={{ borderLeft: `4px solid ${color}` }}
                            >
                                <div className='row between'>
                                    <b>
                                        {s.order}. {s.section.courseCode}
                                    </b>
                                    <span className='small'>
                                        {formatMinutes(s.meeting.start)}–{formatMinutes(s.meeting.end)}
                                    </span>
                                </div>
                                <div className='small muted'>{s.section.title}</div>
                                <div className='small'>
                                    {s.building
                                        ? `${toName ?? s.building} · ${s.building} ${s.room ?? ''}`
                                        : 'Online / no room listed'}
                                    {s.building &&
                                        !nodeFor(s.building) &&
                                        ' · not on the bundled map (shown by name only)'}
                                </div>
                                {leg && (
                                    <div className='small' style={{ marginTop: 4 }}>
                                        {leg.gapMinutes} min between classes
                                        {minutes !== null &&
                                            ` · about ${minutes} min walk (${est?.estimated === 'walkway' ? 'estimated along campus walkways' : 'straight-line estimate'})`}
                                        {minutes !== null && minutes > leg.gapMinutes && (
                                            <span className='chip bad' style={{ marginLeft: 6 }}>
                                                Tight
                                            </span>
                                        )}
                                    </div>
                                )}
                                {fromName && toName && prev?.building !== s.building && (
                                    <a
                                        className='small'
                                        href={walkingDirectionsUrl(fromName, toName)}
                                        target='_blank'
                                        rel='noopener noreferrer'
                                    >
                                        Open walking directions ↗
                                    </a>
                                )}
                            </div>
                        );
                    })}
                    {unmapped.length > 0 && (
                        <div className='small muted'>
                            Some buildings are not in the bundled map data; they are listed by name only.
                        </div>
                    )}
                    {onlineOnly.length > 0 && (
                        <div className='small muted'>
                            No campus location: {onlineOnly.map(s => s.courseCode).join(', ')}
                        </div>
                    )}
                    <div className='notice small'>
                        Lines follow UT Registration Plus’s campus walkway graph and are estimates, not verified routes.
                        Dashed lines are straight-line connections showing order only. Use “Open walking directions” for
                        real routing (opens Google Maps).
                    </div>
                </div>
            </div>
        </div>
    );
}
