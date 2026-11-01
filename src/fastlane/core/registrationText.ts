/**
 * The text a student pastes or reads while registering. UT's add/drop form takes one unique number per field, so
 * the list leads with the five-digit numbers, one per line, followed by what each one is — so a typo is easy to
 * spot. Seat status is only ever "as last seen on <date>", never live.
 */
import { formatMeeting } from './meetings';
import { formatUnique, type SectionRecord } from './sections';

const seen = (s: SectionRecord) =>
    s.status
        ? `${s.status.value.toLowerCase()} as last seen ${new Date(s.status.observedAt).toISOString().slice(0, 10)}`
        : 'seats not checked';

export function registrationText(sections: SectionRecord[], term = ''): string {
    const lines = sections.map(s => {
        const when = s.meetings.length ? s.meetings.map(formatMeeting).join('; ') : 'online, no set times';
        return `${formatUnique(s.uniqueId)}  ${s.courseCode}  ${when}  (${seen(s)})`;
    });
    return [
        `${term ? `${term} — ` : ''}unique numbers to add (one per registration field):`,
        ...lines,
        '',
        'Seat status is only what was seen on UT’s site at the time shown, never live. Check it on UT before registering.',
    ].join('\n');
}
