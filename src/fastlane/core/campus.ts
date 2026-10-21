/**
 * Turns the final schedule into an ordered list of stops per weekday for the campus map.
 */
import type { DayCode, Meeting } from './meetings';
import type { SectionRecord } from './sections';

export interface Stop {
    order: number;
    section: SectionRecord;
    meeting: Meeting;
    /** UT building code, e.g. "GDC"; undefined for online/no-room meetings */
    building?: string;
    room?: string;
}

export function splitLocation(location?: string): { building?: string; room?: string } {
    if (!location) return {};
    const [building, ...rest] = location.trim().split(/\s+/);
    if (!building || /^(WB|WEB|INTERNET|ONLINE|TBA)$/i.test(building)) return {};
    return { building: building.toUpperCase(), room: rest.join(' ') || undefined };
}

export function stopsForDay(sections: SectionRecord[], day: DayCode): Stop[] {
    const stops = sections
        .flatMap(section =>
            section.meetings
                .filter(m => m.days.includes(day))
                .map(meeting => ({ section, meeting, ...splitLocation(meeting.location) }))
        )
        .sort((a, b) => a.meeting.start - b.meeting.start);
    return stops.map((s, i) => ({ ...s, order: i + 1 }));
}

/** Consecutive pairs of in-person stops, with the gap between classes in minutes. */
export function legs(stops: Stop[]): Array<{ from: Stop; to: Stop; gapMinutes: number }> {
    const physical = stops.filter(s => s.building);
    const out: Array<{ from: Stop; to: Stop; gapMinutes: number }> = [];
    for (let i = 1; i < physical.length; i++) {
        const from = physical[i - 1]!;
        const to = physical[i]!;
        if (from.building === to.building) continue;
        out.push({ from, to, gapMinutes: to.meeting.start - from.meeting.end });
    }
    return out;
}

export const DAY_COLORS: Record<DayCode, string> = {
    M: '#BF5700',
    T: '#2563EB',
    W: '#059669',
    TH: '#9333EA',
    F: '#DB2777',
    S: '#64748B',
    SU: '#64748B',
};

/** Google Maps walking directions between two UT buildings (opens externally, on click only). */
export function walkingDirectionsUrl(fromName: string, toName: string): string {
    const q = (n: string) => `${n}, The University of Texas at Austin, Austin, TX`;
    return `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${encodeURIComponent(q(fromName))}&destination=${encodeURIComponent(q(toName))}`;
}
