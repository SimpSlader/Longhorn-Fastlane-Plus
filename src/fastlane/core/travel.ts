/**
 * Walking-time estimates between UT buildings, from UT Registration Plus's campus walkway graph (pixel
 * coordinates of the bundled campus map). The estimate is deliberately conservative: straight-line distance
 * with a detour factor, UTRP's walking speed, and a fixed buffer for doors and stairs. Buildings missing from
 * the graph return null — the validator then reports the transition as unverified instead of assuming it is fine.
 */
import { graphNodes } from '@views/components/map/graphNodes';
import { PIXELS_TO_FEET, WALKING_SPEED } from '@views/components/map/types';

import { splitLocation } from './campus';
import type { DayCode, Meeting } from './meetings';
import type { SectionRecord } from './sections';

/** real walkways are longer than the straight line between two buildings */
export const DETOUR_FACTOR = 1.35;
/** minutes to leave one room and be seated in the next (stairs, elevators, doors) */
export const TRANSITION_BUFFER_MIN = 3;

export type TravelEstimator = (fromBuilding: string, toBuilding: string) => number | null;

export const campusTravelMinutes: TravelEstimator = (from, to) => {
    if (from === to) return 0;
    const a = (graphNodes as Record<string, { x: number; y: number } | undefined>)[from];
    const b = (graphNodes as Record<string, { x: number; y: number } | undefined>)[to];
    if (!a || !b) return null;
    const feet = Math.hypot(a.x - b.x, a.y - b.y) * PIXELS_TO_FEET * DETOUR_FACTOR;
    return Math.ceil(feet / WALKING_SPEED + TRANSITION_BUFFER_MIN);
};

export interface Transition {
    day: DayCode;
    from: { section: SectionRecord; meeting: Meeting; building: string };
    to: { section: SectionRecord; meeting: Meeting; building: string };
    gap: number;
    /** walking minutes needed, or null when a building has no map location */
    needed: number | null;
    /** true = enough time, false = not enough, null = cannot be verified */
    feasible: boolean | null;
}

/** Every pair of consecutive in-person meetings on a day that happen in different buildings. */
export function transitions(sections: SectionRecord[], estimate: TravelEstimator = campusTravelMinutes): Transition[] {
    const out: Transition[] = [];
    const byDay = new Map<DayCode, Array<{ section: SectionRecord; meeting: Meeting; building?: string }>>();
    for (const section of sections)
        for (const meeting of section.meetings) {
            const { building } = splitLocation(meeting.location);
            for (const day of meeting.days) {
                const list = byDay.get(day) ?? [];
                list.push({ section, meeting, building });
                byDay.set(day, list);
            }
        }
    for (const [day, list] of byDay) {
        list.sort((a, b) => a.meeting.start - b.meeting.start);
        for (let i = 1; i < list.length; i++) {
            const from = list[i - 1]!;
            const to = list[i]!;
            if (from.section === to.section) continue;
            const gap = to.meeting.start - from.meeting.end;
            // an unknown location is unverifiable; a missing one (online) is no transition at all
            const known = from.building && to.building;
            if (!from.building && !to.building) continue;
            const needed = known ? estimate(from.building!, to.building!) : null;
            if (known && from.building === to.building) continue;
            out.push({
                day,
                from: { section: from.section, meeting: from.meeting, building: from.building ?? '?' },
                to: { section: to.section, meeting: to.meeting, building: to.building ?? '?' },
                gap,
                needed,
                feasible: needed == null ? null : gap >= needed,
            });
        }
    }
    return out;
}

/** True when `s` cannot be reached in time from, or to, an already chosen section. */
export function travelInfeasible(
    s: SectionRecord,
    chosen: SectionRecord[],
    estimate: TravelEstimator = campusTravelMinutes
): boolean {
    return transitions([...chosen, s], estimate).some(
        t => t.feasible === false && (t.from.section === s || t.to.section === s)
    );
}
