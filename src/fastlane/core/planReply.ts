/**
 * The schedule description shown in chat, written from the validated tool result — the same data that feeds the
 * calendar — never from the model's prose. The model's free text used to restate classes, unique numbers and
 * grade rates from memory, which is how a table could disagree with the calendar and the validator.
 */
import { describeRequirement } from './requirements';

interface ClassRow {
    code: string;
    title: string;
    unique: string;
    credits: number;
    when: string;
    mode: string;
    instructor: string;
    historicalARate: { percent: number; sample: number } | null;
    gpaOutlook: string | { expectedGradePoints: number; chanceOfA: number; confidence: string; basis?: string };
    countsToward: string[];
    sectionRecord?: string;
    seatStatus?: string;
    rateMyProfessors?: {
        quality: number | null;
        difficulty?: number;
        wouldTakeAgain?: number | null;
        ratings: number;
        note?: string;
    } | null;
}
interface Backup {
    code: string;
    unique: string;
    when: string;
    instructor: string;
    historicalARate: number | null;
    why: string;
}
export interface PlanResult {
    semester: string;
    totalCredits: number;
    classes: ClassRow[];
    backups?: { perClass: Array<{ for: string; options: Backup[] }>; general: Backup[] };
    changed?: { removed: string[]; added: string[] };
    couldNotInclude?: string[];
    understood?: string;
    alternatives?: Array<{
        label: string;
        totalCredits: number;
        gapMinutes: number;
        averageExpectedGradePoints: number | null;
        classes: Array<{ code: string; unique: string; when: string }>;
    }>;
}

const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

export function isPlanResult(v: unknown): v is PlanResult {
    const r = v as PlanResult | undefined;
    return !!r && Array.isArray(r.classes) && typeof r.totalCredits === 'number';
}

export function renderPlanReply(r: PlanResult): string {
    const lines: string[] = [];
    lines.push(`**${r.semester} schedule — ${r.totalCredits} credit hours**`);
    if (r.understood) lines.push(`_What I understood:_ ${r.understood}`);
    if (r.changed && (r.changed.removed.length || r.changed.added.length))
        lines.push(
            [
                r.changed.removed.length ? `Removed: ${r.changed.removed.join(', ')}.` : '',
                r.changed.added.length ? `Added: ${r.changed.added.join(', ')}.` : '',
            ]
                .filter(Boolean)
                .join(' ')
        );
    const table: string[] = [
        '| Class | Unique | Hrs | When | Counts toward | Past A/A− rate | GPA outlook | Rate My Professors | Seats |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const c of r.classes) {
        const a = c.historicalARate
            ? `${c.historicalARate.percent}% of ${c.historicalARate.sample.toLocaleString('en-US')}`
            : 'no data';
        const g =
            typeof c.gpaOutlook === 'string'
                ? 'not estimated (no grade data)'
                : `${c.gpaOutlook.expectedGradePoints.toFixed(2)} pts, ${c.gpaOutlook.chanceOfA}% A (${c.gpaOutlook.confidence} confidence)`;
        const req = c.countsToward.length ? c.countsToward.map(describeRequirement).join('; ') : 'unverified';
        const r = c.rateMyProfessors;
        // a rating is shown only when one exists on file; nothing is ever estimated
        const rmp =
            r && typeof r.quality === 'number' && r.ratings > 0
                ? `${r.quality}/5, difficulty ${r.difficulty ?? '?'}, ${r.ratings} ratings`
                : 'none on file';
        table.push(
            `| ${cell(`${c.code} ${c.title}`)} · ${cell(c.instructor)} | ${c.unique} | ${c.credits} | ${cell(c.when)} (${cell(c.mode)}) | ${cell(req)} | ${a} | ${g} | ${rmp} | ${cell(c.seatStatus ?? 'not checked')} |`
        );
    }
    lines.push(table.join('\n'));
    if (r.couldNotInclude?.length) lines.push(`Could not include: ${r.couldNotInclude.join('; ')}.`);
    const per = r.backups?.perClass.filter(g => g.options.length) ?? [];
    if (per.length || r.backups?.general.length) {
        lines.push('**Backups** (each re-checked against the same rules):');
        for (const g of per)
            lines.push(
                `- ${g.for}: ${g.options.map(o => `${o.code} (${o.unique}, ${o.when}${o.historicalARate != null ? `, ${o.historicalARate}% A/A−` : ''})`).join('; ')}`
            );
        for (const b of r.backups?.general.slice(0, 3) ?? [])
            lines.push(`- Any slot: ${b.code} (${b.unique}, ${b.when}) — ${b.why}`);
    }
    if (r.alternatives?.length) {
        lines.push('**Other ways to optimize the same request** (all follow your rules; ask for any of them):');
        for (const a of r.alternatives)
            lines.push(
                `- ${a.label} — ${a.totalCredits} hrs, ${a.gapMinutes} min of gaps${a.averageExpectedGradePoints != null ? `, avg ${a.averageExpectedGradePoints.toFixed(2)} expected GPA pts` : ''}: ${a.classes.map(c => `${c.code} (${c.unique})`).join(', ')}`
            );
    }
    lines.push(
        '_Past grades are history, not promises. Seat status is only what you saw on UT’s site, never live. Everything above comes from the same checked data as your calendar._'
    );
    return lines.join('\n\n');
}
