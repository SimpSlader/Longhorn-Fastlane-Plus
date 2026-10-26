/**
 * Answers Fastlane gives straight from the student's records, without asking an AI: hours completed, in
 * progress and left, GPA as the IDA states it, current classes, the sections of a course, and the easiest
 * class on a schedule by historical grades. Each answer says where its numbers come from, and says so plainly
 * when the data isn't there instead of guessing.
 */
import type { AcademicSummary } from './academic';
import { formatMeeting } from './meetings';
import type { SectionRecord } from './sections';

const NO_IDA =
    "I don't have your degree audit yet, so I can't tell you that without guessing. Import your IDA on **Degree progress** and ask me again.";

const hrs = (n: number) => `${n} credit hour${n === 1 ? '' : 's'}`;
const fromIda = (s: AcademicSummary) =>
    s.source ? `_From your IDA imported ${new Date(s.source.importedAt).toLocaleDateString()}._` : '';

export function completedAnswer(s: AcademicSummary): string {
    if (!s.source) {
        const told = s.userReported.completedHours;
        return told
            ? `You told me you've completed **${hrs(told.value)}**. I haven't seen your IDA yet, so I can't confirm it; import it on **Degree progress** to check.`
            : NO_IDA;
    }
    const parts = [`You've completed **${hrs(s.completedHours)}** so far.`];
    if (s.inProgressHours > 0)
        parts.push(
            `You're taking another **${s.inProgressHours}** right now, so if you pass them all you'll have **${hrs(s.completedHours + s.inProgressHours)}**.`
        );
    if (s.examHours > 0 || s.transferHours > 0)
        parts.push(
            `That includes ${[s.examHours ? `${s.examHours} from credit by exam` : '', s.transferHours ? `${s.transferHours} of transfer credit` : ''].filter(Boolean).join(' and ')}.`
        );
    return [parts.join(' '), ...s.discrepancies, fromIda(s)].filter(Boolean).join('\n\n');
}

export function inProgressAnswer(s: AcademicSummary): string {
    if (!s.source) return NO_IDA;
    if (!s.current.length) return `Your IDA doesn't show any classes in progress right now.\n\n${fromIda(s)}`;
    return [
        `You're taking **${hrs(s.inProgressHours)}** this semester:`,
        s.current.map(c => `- ${c.code} ${titleCase(c.name)} (${c.hours})`).join('\n'),
        fromIda(s),
    ].join('\n\n');
}

export function totalAnswer(s: AcademicSummary): string {
    if (!s.source) return NO_IDA;
    return [
        `**${hrs(s.completedHours)}** completed and **${s.inProgressHours}** in progress, so **${hrs(s.completedHours + s.inProgressHours)}** once this semester's classes are done.${s.plannedHours ? ` (${s.plannedHours} more are planned on your IDA but not taken yet.)` : ''}`,
        ...s.discrepancies,
        fromIda(s),
    ]
        .filter(Boolean)
        .join('\n\n');
}

export function remainingAnswer(s: AcademicSummary): string {
    if (!s.source) return NO_IDA;
    if (!s.degree)
        return `Your IDA doesn't state a total-hours rule I can read, so I won't guess how many are left. You've completed **${hrs(s.completedHours)}** with **${s.inProgressHours}** in progress.\n\n${fromIda(s)}`;
    return [
        `Your degree needs **${s.degree.required}** hours. Your IDA applies **${s.degree.applied}** of them (it can count classes in progress), leaving **${s.degree.remaining}**.`,
        s.residence ? `In residence at UT: ${s.residence.done} of ${s.residence.required} required hours.` : '',
        fromIda(s),
    ]
        .filter(Boolean)
        .join('\n\n');
}

/** GPA is answered only from the IDA, here in the browser; it is never sent to an AI. */
export function gpaAnswer(s: AcademicSummary): string {
    if (!s.source) return NO_IDA;
    if (!s.gpa.length)
        return `Your imported IDA doesn't list a GPA I can read, so I can't tell you without guessing. Your official GPA is on UT's transcript page.\n\n${fromIda(s)}`;
    return [
        s.gpa
            .map(
                g =>
                    `Your **${g.label}** is **${g.value.toFixed(2)}** (the degree requires at least ${g.minimum.toFixed(2)}).`
            )
            .join('\n'),
        fromIda(s),
    ].join('\n\n');
}

export function currentClassesAnswer(s: AcademicSummary): string {
    return inProgressAnswer(s);
}

/** Sections of one course from UT's listed sections, with how fresh the listing is. Never claims seats. */
export function sectionsAnswer(
    course: string,
    sections: SectionRecord[],
    gradeOf: (s: SectionRecord) => number | null
): string {
    if (!sections.length)
        return `I don't see any listed sections of **${course}** in the course data Fastlane has. It may not be offered this semester, or UT's course list for the semester hasn't been imported yet.`;
    const asOf = sections.find(s => s.listing?.asOf)?.listing?.asOf;
    const rows = sections.slice(0, 12).map(s => {
        const when = s.meetings.length ? s.meetings.map(formatMeeting).join('; ') : 'Online, no set times';
        const g = gradeOf(s);
        const seat = s.status
            ? ` · ${s.status.value.toLowerCase()} when you viewed it ${new Date(s.status.observedAt).toLocaleDateString()}`
            : '';
        return `| ${String(s.uniqueId).padStart(5, '0')} | ${when} | ${s.instructors.join(', ') || 'TBA'} | ${g != null ? `${Math.round(g)}%` : '—'}${seat} |`;
    });
    return [
        `**${course}** has ${sections.length} listed section${sections.length === 1 ? '' : 's'}${sections.length > 12 ? ' (first 12 shown)' : ''}:`,
        ['| Unique | When | Instructor | A/A− history |', '|---|---|---|---|', ...rows].join('\n'),
        `_From UT's course list${asOf ? ` printed ${asOf}` : ''}. Seat availability isn't checked here; confirm on UT's course schedule before registering._`,
    ].join('\n\n');
}

/** Compares classes by historical A/A− rate; says so when there isn't enough data. */
export function easiestAnswer(classes: Array<{ code: string; grade: number | null; sample: number }>): string {
    if (!classes.length)
        return "There's no schedule to compare yet. Build one with me, or pick a schedule in My schedule first.";
    const known = classes.filter(c => c.grade != null).sort((a, b) => b.grade! - a.grade!);
    if (!known.length)
        return "I don't have historical grade data for these classes, so I can't say which is easiest without guessing.";
    const best = known[0]!;
    const lines = known.map(
        c =>
            `- ${c.code}: ${Math.round(c.grade!)}% A/A−${c.sample < 30 ? ` (only ${c.sample} grades, weak evidence)` : ''}`
    );
    const missing = classes.filter(c => c.grade == null).map(c => c.code);
    return [
        `By past grades, **${best.code}** looks easiest: ${Math.round(best.grade!)}% of students got an A or A−.`,
        lines.join('\n'),
        missing.length ? `No grade history for ${missing.join(', ')}.` : '',
        '_Past grades describe earlier sections, not a promise about yours, and workload can differ._',
    ]
        .filter(Boolean)
        .join('\n\n');
}

export function correctionAnswer(value: number, s: AcademicSummary): string {
    const ida = s.source ? s.completedHours : null;
    return [
        `Thanks. I've noted that you've completed **${hrs(value)}**${ida != null && ida !== value ? `. Your imported IDA shows ${ida}, so I'll keep both and won't overwrite the IDA; if it's out of date, import a new one on Degree progress` : ''}.`,
        s.source && s.inProgressHours ? `You're also taking ${s.inProgressHours} hours this semester.` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function titleCase(name: string): string {
    return name.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}
