/**
 * Answers Fastlane gives straight from the student's records, without asking an AI: hours completed, in
 * progress and left, GPA as the IDA states it, current classes, the sections of a course, and the easiest
 * class on a schedule by historical grades. Each answer says where its numbers come from, and says so plainly
 * when the data isn't there instead of guessing.
 */
import type { AcademicSummary } from './academic';
import type { AcademicModel } from './academicModel';
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
                    `Your **${/gpa/i.test(g.label) ? g.label : `${g.label} GPA`}** is **${g.value.toFixed(2)}** (the degree requires at least ${g.minimum.toFixed(2)}).`
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

// ---------- answers from the shared academic model (the same figures Degree progress shows) ----------

const NO_FIGURES =
    "I don't have your degree audit or figures from you yet, so I can't tell you that without guessing. Import your IDA on **Degree progress**, or tell me (for example “I've earned 9 credits and I'm taking 13”).";
const sourceLine = (m: AcademicModel) =>
    m.auditTimestamp
        ? `_From your IDA imported ${new Date(m.auditTimestamp).toLocaleDateString()}${m.discrepancies.length ? ', with the figures you gave me' : ''}._`
        : '_Using the figures you gave me._';

export function earnedAnswer(m: AcademicModel): string {
    const earned = m.degreeCreditsEarned.value;
    if (earned == null) return NO_FIGURES;
    const inProgress = m.degreeCreditsInProgress.value ?? 0;
    const projected = m.degreeCreditsProjected.value;
    const parts = [`You've completed **${hrs(earned)}** so far.`];
    if (inProgress > 0)
        parts.push(
            `You're taking another **${inProgress}** right now, so if you pass them all you'll have **${hrs(projected ?? earned + inProgress)}**.`
        );
    const exam = m.examCreditsAccepted.value ?? 0;
    const transfer = m.transferCreditsAccepted.value ?? 0;
    if (exam > 0 || transfer > 0)
        parts.push(
            `That includes ${[exam ? `${exam} from credit by exam` : '', transfer ? `${transfer} of transfer credit` : ''].filter(Boolean).join(' and ')}.`
        );
    return [parts.join(' '), ...m.discrepancies, sourceLine(m)].join('\n\n');
}

export function projectedAnswer(m: AcademicModel): string {
    const p = m.degreeCreditsProjected.value;
    if (p == null) return NO_FIGURES;
    const e = m.degreeCreditsEarned.value;
    const i = m.degreeCreditsInProgress.value;
    return [
        `${e != null && i != null ? `**${hrs(e)}** completed and **${i}** in progress, so ` : ''}**${hrs(p)}** once this semester's classes are done.`,
        ...m.discrepancies,
        sourceLine(m),
    ].join('\n\n');
}

export function remainingModelAnswer(m: AcademicModel): string {
    const total = m.degreeTotalRequired.value;
    const left = m.degreeCreditsRemainingProjected.value;
    if (total == null || left == null)
        return `I don't have your degree's total-hours figure, so I won't guess how many are left.${m.degreeCreditsEarned.value != null ? ` You've completed **${hrs(m.degreeCreditsEarned.value)}**${m.degreeCreditsInProgress.value ? ` with **${m.degreeCreditsInProgress.value}** in progress` : ''}.` : ''} Tell me your degree total (for example “120 hours”) or import your IDA.`;
    const lines = [
        `Your degree needs **${total}** hours. With **${m.degreeCreditsProjected.value}** counted after this semester, **${left}** remain${m.degreeCreditsRemainingEarned.value != null ? ` (${m.degreeCreditsRemainingEarned.value} if you count only credits already earned)` : ''}.`,
    ];
    if (m.utResidentRequired.value != null && m.utResidentCounted.value != null)
        lines.push(`In residence at UT: ${m.utResidentCounted.value} of ${m.utResidentRequired.value} required hours.`);
    if (m.upperDivisionRequired.value != null && m.upperDivisionCounted.value != null)
        lines.push(
            `Upper-division: ${m.upperDivisionCounted.value} of ${m.upperDivisionRequired.value} required hours.`
        );
    return [...lines, ...m.discrepancies, sourceLine(m)].join('\n\n');
}

export function factsAcknowledgement(m: AcademicModel, stated: string[]): string {
    const total = m.degreeTotalRequired.value;
    const projected = m.degreeCreditsProjected.value;
    const left = m.degreeCreditsRemainingProjected.value;
    const core =
        total != null && projected != null && left != null
            ? `Got it. Using ${projected} credits toward your ${total}-credit degree, that leaves **${left}** after this semester.`
            : `Got it. I've noted ${stated.join(', ')}.`;
    return `${core} I'll use what you told me for planning${m.discrepancies.length ? ' and keep your IDA’s figures separately' : ''}.`;
}
