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
    kind?: 'requirement' | 'requested' | 'elective';
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
    electives?: { count: number; hours: number };
    understood?: string;
    recommended?: {
        totalCredits: number;
        gapMinutes: number;
        averageExpectedGradePoints: number | null;
        degreeClasses: number;
        onlineClasses: number;
    };
    alternatives?: Array<{
        label: string;
        totalCredits: number;
        gapMinutes: number;
        averageExpectedGradePoints: number | null;
        degreeClasses?: number;
        onlineClasses?: number;
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
        // an elective is labelled as one: it adds credit hours but satisfies no unmet requirement
        const req = c.countsToward.length
            ? c.countsToward.map(describeRequirement).join('; ')
            : c.kind === 'elective'
              ? 'Elective: counts toward total credit hours only'
              : c.kind === 'requested'
                ? 'Requested by you: no unmet requirement'
                : 'unverified';
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
    if (r.electives?.count)
        lines.push(
            `${r.electives.count} of ${r.classes.length} classes (${r.electives.hours} credit hours) are electives chosen to reach your credit total, ranked by grade outlook. They add to your total hours but do **not** satisfy any unmet degree requirement.`
        );
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
        // one comparison table: how the versions actually differ on what each one optimizes
        const row = (
            label: string,
            m: {
                totalCredits: number;
                gapMinutes: number;
                averageExpectedGradePoints: number | null;
                degreeClasses?: number;
                onlineClasses?: number;
            }
        ) =>
            `| ${label} | ${m.degreeClasses ?? '?'} | ${m.averageExpectedGradePoints != null ? m.averageExpectedGradePoints.toFixed(2) : 'n/a'} | ${m.gapMinutes} min | ${m.onlineClasses ?? '?'} |`;
        lines.push(
            '**Compare the versions** (use the buttons above the calendar to switch; each was independently validated):\n' +
                [
                    '| Version | Degree-requirement classes | Avg expected GPA pts | Gaps | Online |',
                    '| --- | --- | --- | --- | --- |',
                    ...(r.recommended ? [row('Recommended', r.recommended)] : []),
                    ...r.alternatives.map(a => row(a.label.split(':')[0]!, a)),
                ].join('\n')
        );
    }
    lines.push(
        '_Past grades are history, not promises. Seat status is only what you saw on UT’s site, never live. Everything above comes from the same checked data as your calendar._'
    );
    return lines.join('\n\n');
}

/**
 * What the model gets to see of a tool result. The student's chat text is built from the full result, so the model
 * only needs the decisions and the facts it may refer to — and the copilot trims long results from the END, so the
 * decisive fields (error, verdict, what changed) must come first and the whole thing must stay short.
 */
export function forModel(result: unknown): unknown {
    const r = result as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.classes)) return result;
    const classes = (r.classes as Array<Record<string, unknown>>).map(c => ({
        code: c.code,
        unique: c.unique,
        credits: c.credits,
        when: c.when,
        instructor: c.instructor,
        counts: c.countsToward,
        kind: c.kind,
        aRate: (c.historicalARate as { percent?: number } | null)?.percent ?? null,
    }));
    const backups = r.backups as
        | { perClass?: Array<{ for: string; options: unknown[] }>; general?: unknown[] }
        | undefined;
    const validation = r.validation as { allRulesMet?: boolean; verdict?: string } | undefined;
    return {
        ...(r.notice ? { notice: r.notice } : {}),
        ...(r.rulesItDoesNotFollow ? { rulesItDoesNotFollow: r.rulesItDoesNotFollow } : {}),
        validation: { allRulesMet: validation?.allRulesMet, verdict: validation?.verdict },
        ...(r.understood ? { understood: r.understood } : {}),
        ...(r.changed ? { changed: r.changed } : {}),
        totalCredits: r.totalCredits,
        classes,
        backupsCount:
            (backups?.perClass ?? []).reduce((n, g) => n + g.options.length, 0) + (backups?.general?.length ?? 0),
        ...(Array.isArray(r.alternatives)
            ? { alternatives: (r.alternatives as Array<{ label: string }>).map(a => a.label) }
            : {}),
        note: 'The student already sees the full table, backups and verdict; summarize briefly and never restate a verdict the validator did not give.',
    };
}
