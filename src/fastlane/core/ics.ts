/** Minimal RFC 5545 calendar export for registration reminders (generated locally). */

export interface IcsEvent {
    uid: string;
    start: number;
    durationMinutes: number;
    summary: string;
    description?: string;
    url?: string;
    /** minutes-before values for VALARM blocks */
    alarms?: number[];
}

function stamp(epoch: number): string {
    return new Date(epoch)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
}

export function escapeIcsText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Folds lines longer than 75 octets as required by RFC 5545 */
export function foldLine(line: string): string {
    const parts: string[] = [];
    let rest = line;
    while (rest.length > 75) {
        parts.push(rest.slice(0, 75));
        rest = ` ${rest.slice(75)}`;
    }
    parts.push(rest);
    return parts.join('\r\n');
}

export function buildIcs(events: IcsEvent[], now = Date.now()): string {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Fastlane Course Planner//Reminders//EN',
        'CALSCALE:GREGORIAN',
    ];
    for (const e of events) {
        lines.push(
            'BEGIN:VEVENT',
            `UID:${e.uid}`,
            `DTSTAMP:${stamp(now)}`,
            `DTSTART:${stamp(e.start)}`,
            `DTEND:${stamp(e.start + e.durationMinutes * 60_000)}`,
            `SUMMARY:${escapeIcsText(e.summary)}`
        );
        if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
        if (e.url) lines.push(`URL:${e.url}`);
        for (const minutes of e.alarms ?? []) {
            lines.push(
                'BEGIN:VALARM',
                'ACTION:DISPLAY',
                `DESCRIPTION:${escapeIcsText(e.summary)}`,
                `TRIGGER:-PT${minutes}M`,
                'END:VALARM'
            );
        }
        lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
