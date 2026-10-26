/**
 * Fastlane's chat reply after each request. It describes the schedule that is actually shown (never a
 * different list of picks), what changed since the previous version, any ACC suggestions with their
 * residency caveats, and what the student can ask next.
 */
import type { AccRoom, AccSuggestion } from './acc';
import type { DayCode } from './meetings';
import { formatMinutes } from './meetings';
import type { NoScheduleReport } from './scheduleSolver';
import { gapMinutes, isAsync } from './scheduleSolver';
import type { SectionRecord } from './sections';

const DAY: Record<DayCode, string> = { M: 'Mon', T: 'Tue', W: 'Wed', TH: 'Thu', F: 'Fri', S: 'Sat', SU: 'Sun' };

function when(s: SectionRecord): string {
    if (isAsync(s)) return 'online, on your own schedule';
    const m = s.meetings[0];
    if (!m) return 'times not listed';
    const days = m.days.map(d => DAY[d]).join('/');
    const online = s.modality === 'live-online' ? ' (live online)' : '';
    return `${days} ${formatMinutes(m.start)}–${formatMinutes(m.end)}${online}`;
}

export interface ReplyInput {
    sections: SectionRecord[] | null;
    before: SectionRecord[] | null;
    report: NoScheduleReport | null;
    avoidDays: DayCode[];
    acc?: { suggestions: AccSuggestion[]; room: AccRoom; residencyNote?: string; blocked: string[] } | null;
    /** set when the student asked for ACC ideas, so an empty result is explained */
    accAsked?: boolean;
}

export function composeReply(input: ReplyInput): string {
    const lines: string[] = [];
    if (!input.sections) {
        lines.push(`I couldn't build a complete schedule that follows all of your rules.`);
        for (const r of input.report?.reasons ?? []) lines.push(`• ${r}`);
        if (input.report?.suggestions.length)
            lines.push(`You could: ${input.report.suggestions.map(s => s.text.toLowerCase()).join('; ')}.`);
    } else {
        const credits = input.sections.reduce((n, s) => n + s.creditHours, 0);
        const days = input.avoidDays.filter(d => ['M', 'T', 'W', 'TH', 'F'].includes(d));
        const facts = [
            `${input.sections.length} class${input.sections.length === 1 ? '' : 'es'}`,
            days.length ? `nothing on ${days.map(d => DAY[d]).join('/')}` : '',
            `${Math.round(gapMinutes(input.sections))} min of gaps`,
        ].filter(Boolean);
        lines.push(`Here's a ${credits}-credit plan (${facts.join(', ')}):`);
        for (const s of input.sections) lines.push(`• ${s.courseCode} — ${when(s)}`);
        if (input.before) {
            const was = new Set(input.before.map(s => s.uniqueId));
            const now = new Set(input.sections.map(s => s.uniqueId));
            const added = input.sections.filter(s => !was.has(s.uniqueId)).map(s => s.courseCode);
            const removed = input.before.filter(s => !now.has(s.uniqueId)).map(s => s.courseCode);
            const kept = input.sections.filter(s => was.has(s.uniqueId)).length;
            if (!added.length && !removed.length) lines.push('Nothing needed to change from the last version.');
            else
                lines.push(
                    `Changed from last time: ${[removed.length ? `took out ${removed.join(', ')}` : '', added.length ? `added ${added.join(', ')}` : ''].filter(Boolean).join(' and ')}${kept ? `; kept the other ${kept}` : ''}.`
                );
        }
    }
    const acc = input.acc;
    if (acc?.suggestions.length) {
        lines.push('To get ahead at ACC (check ACC’s schedule for online sections):');
        for (const s of acc.suggestions)
            lines.push(
                `• ${s.tccn} → transfers as ${s.ut}${s.utARate != null ? ` (only ${Math.round(s.utARate)}% A/A− at UT)` : ''}`
            );
        lines.push(
            'Those are left out of your UT schedule so you don’t take them twice. ACC credit counts only after UT evaluates your transcript.'
        );
        const cautions = [...new Set(acc.suggestions.flatMap(s => s.cautions))];
        for (const c of cautions) lines.push(`Note: ${c}`);
    } else if (input.accAsked) {
        if (acc?.room.room === 0)
            lines.push(
                'I didn’t suggest ACC classes: your remaining hours all need to be taken at UT to meet the residence rules on your IDA.'
            );
        else
            lines.push(
                'I didn’t find a course your IDA still needs that has an official ACC (TCCN) equivalent and may be taken outside UT.'
            );
    }
    if (acc?.blocked.length)
        lines.push(
            `Keep ${acc.blocked.join(', ')} at UT: your program requires ${acc.blocked.length === 1 ? 'it' : 'them'} in residence.`
        );
    lines.push(
        input.sections
            ? 'Want to change anything? Ask for easier classes, a different day, one more online class, or click a class to replace it.'
            : 'Tell me which rule to relax, or click one of the options below.'
    );
    return lines.join('\n');
}

/** Short follow-ups offered under the latest reply. */
export function quickReplies(hasPlan: boolean, accAsked: boolean): string[] {
    // each one is phrased so the request reader understands it exactly
    if (!hasPlan) return ['Wednesdays are fine', '2–3 online classes are fine', 'Make it 12–15 credits'];
    return [
        'Make it easier',
        'Give me 1 more online class',
        'Keep everything but no Friday classes',
        ...(accAsked ? [] : ['Suggest harder classes I could take at ACC']),
    ];
}
