/**
 * The one academic model shared by Degree progress, the chat, the advisor and graduation planning. Every
 * figure says where it came from (the IDA's own rule, the IDA's course list, the student's own words, or a
 * calculation from those) and how. Earned, in-progress and projected credits are separate and never added up
 * under the wrong name; requirement buckets (core, major, residence, upper division) are never summed into the
 * degree total because one course can count toward several of them. When the student corrects a figure, that
 * value is used for planning while the IDA's value is kept beside it, and any difference is stated.
 */
import { degreeTotals } from '../audit/progress';
import type { ParsedAudit } from '../audit/types';
import { academicSummary } from './academic';

export type Source = 'ida' | 'ida-courses' | 'student' | 'calculated' | 'unknown';

export interface Figure {
    value: number | null;
    source: Source;
    /** how it was found or worked out, in plain words */
    method: string;
    /** when the underlying data was captured (IDA import or the student's message) */
    at: number | null;
}

/** Figures the student stated themselves; each is used for planning and kept beside the IDA's. */
export interface ConfirmedFacts {
    degreeTotalRequired?: { value: number; at: number };
    degreeCreditsEarned?: { value: number; at: number };
    degreeCreditsInProgress?: { value: number; at: number };
    degreeCreditsProjected?: { value: number; at: number };
    degreeCreditsRemainingProjected?: { value: number; at: number };
    utResidentRequired?: { value: number; at: number };
    utResidentCounted?: { value: number; at: number };
    upperDivisionRequired?: { value: number; at: number };
    upperDivisionCounted?: { value: number; at: number };
    upperDivisionResidentRequired?: { value: number; at: number };
    /** "Spring 2029" */
    targetGraduation?: { value: string; at: number };
}

export type FactKey = Exclude<keyof ConfirmedFacts, 'targetGraduation'>;

export interface AcademicModel {
    degreeProgram: string | null;
    catalogYear: string | null;
    auditTimestamp: number | null;
    auditIncludes: { inProgress: boolean; future: boolean; planned: boolean } | null;
    degreeTotalRequired: Figure;
    /** the IDA's own "counted" figure for the degree (it includes whatever the audit was run with) */
    degreeCreditsCountedByIda: Figure;
    degreeCreditsEarned: Figure;
    degreeCreditsInProgress: Figure;
    degreeCreditsFuturePlanned: Figure;
    /** earned + in progress: where the student will be if they pass this semester's classes */
    degreeCreditsProjected: Figure;
    degreeCreditsRemainingEarned: Figure;
    degreeCreditsRemainingProjected: Figure;
    utResidentRequired: Figure;
    utResidentCounted: Figure;
    upperDivisionRequired: Figure;
    upperDivisionCounted: Figure;
    upperDivisionResidentRequired: Figure;
    upperDivisionResidentCounted: Figure;
    examCreditsAccepted: Figure;
    transferCreditsAccepted: Figure;
    gpa: Array<{ label: string; value: number; minimum: number }>;
    targetGraduation: { value: string; source: Source; at: number | null } | null;
    /** things that don't add up, stated plainly (never silently fixed) */
    issues: string[];
    /** where the student's figure differs from the IDA's */
    discrepancies: string[];
}

const fig = (value: number | null, source: Source, method: string, at: number | null): Figure => ({
    value,
    source: value == null ? 'unknown' : source,
    method: value == null ? 'not available' : method,
    at,
});

/** The student's value when they gave one (newest wins), otherwise the record's. */
function prefer(
    record: Figure,
    confirmed: { value: number; at: number } | undefined,
    label: string,
    out: string[]
): Figure {
    if (!confirmed) return record;
    if (record.value != null && record.value !== confirmed.value)
        out.push(
            `${label}: you told me ${confirmed.value}; your IDA shows ${record.value}. I'm using ${confirmed.value} for planning.`
        );
    return { value: confirmed.value, source: 'student', method: 'you told me', at: confirmed.at };
}

export function academicModel(audit: ParsedAudit | null, confirmed: ConfirmedFacts = {}): AcademicModel {
    const at = audit?.parsedAt ?? null;
    const summary = academicSummary(audit);
    const totals = audit ? degreeTotals(audit) : null;
    const issues: string[] = [];
    const discrepancies: string[] = [];
    const included = audit?.included ?? null;

    const required = fig(
        totals?.totalHours?.total ?? null,
        'ida',
        totals?.rules.degree ? `IDA rule: “${totals.rules.degree}”` : 'IDA total-hours rule',
        at
    );
    const counted = fig(totals?.totalHours?.done ?? null, 'ida', 'IDA “counted” hours on the degree-total rule', at);
    const earnedRows = audit ? summary.completedHours : null;
    const inProgressRows = audit ? summary.inProgressHours : null;
    const plannedRows = audit ? summary.plannedHours : null;

    // Projected from the IDA's own count: it includes in-progress (and future/planned when those boxes were on)
    let projectedFromIda: number | null = null;
    if (counted.value != null && included) {
        projectedFromIda = counted.value - (included.planned || included.future ? (plannedRows ?? 0) : 0);
        if (!included.inProgress) projectedFromIda = null; // then the IDA count is earned only
    }
    const earnedFromIda = counted.value != null && included && !included.inProgress ? counted.value : null;
    // the course list and the IDA's own count should agree (within one hour); if not, say so and trust the rule
    const rowsProjected = earnedRows != null && inProgressRows != null ? earnedRows + inProgressRows : null;
    if (projectedFromIda != null && rowsProjected != null && Math.abs(projectedFromIda - rowsProjected) > 1)
        issues.push(
            `Your IDA counts ${projectedFromIda} hours toward the degree (including classes in progress), but its course list adds up to ${rowsProjected}. Some listed courses may not apply to the degree, so I use the IDA's own count for degree totals.`
        );
    const reconciled =
        projectedFromIda == null || rowsProjected == null || Math.abs(projectedFromIda - rowsProjected) <= 1;

    let earned = fig(
        earnedFromIda ?? earnedRows,
        earnedFromIda != null ? 'ida' : 'ida-courses',
        earnedFromIda != null
            ? 'IDA counted hours (audit run without in-progress courses)'
            : 'graded and credit-by-exam courses on the IDA course list, each counted once',
        at
    );
    let inProgress = fig(
        inProgressRows,
        'ida-courses',
        'courses on the IDA list without a grade yet, each counted once',
        at
    );
    let projected = fig(
        projectedFromIda ?? rowsProjected,
        projectedFromIda != null ? 'ida' : 'calculated',
        projectedFromIda != null
            ? 'IDA counted hours minus planned/future courses it included'
            : 'earned + in progress',
        at
    );
    if (!reconciled && projectedFromIda != null && inProgressRows != null) {
        // keep the parts consistent with the IDA's total rather than with a course list that doesn't reconcile
        earned = fig(
            Math.max(0, projectedFromIda - inProgressRows),
            'calculated',
            'IDA counted hours minus in-progress courses',
            at
        );
    }

    earned = prefer(earned, confirmed.degreeCreditsEarned, 'Earned credits', discrepancies);
    inProgress = prefer(inProgress, confirmed.degreeCreditsInProgress, 'Credits in progress', discrepancies);
    const total = prefer(required, confirmed.degreeTotalRequired, 'Degree total', discrepancies);
    if (confirmed.degreeCreditsProjected)
        projected = prefer(
            projected,
            confirmed.degreeCreditsProjected,
            'Credits toward the degree (with this semester)',
            discrepancies
        );
    else if (confirmed.degreeCreditsEarned || confirmed.degreeCreditsInProgress) {
        if (earned.value != null && inProgress.value != null)
            projected = fig(
                earned.value + inProgress.value,
                'calculated',
                'earned + in progress (from what you told me)',
                Date.now()
            );
    } else if (confirmed.degreeCreditsRemainingProjected && total.value != null)
        projected = fig(
            total.value - confirmed.degreeCreditsRemainingProjected.value,
            'calculated',
            'degree total minus the remaining hours you told me',
            confirmed.degreeCreditsRemainingProjected.at
        );

    // a confirmed degree count without a confirmed earned figure: earned follows from it, never from older records
    const projectedConfirmed =
        !!confirmed.degreeCreditsProjected ||
        (!!confirmed.degreeCreditsRemainingProjected && !confirmed.degreeCreditsEarned);
    if (projectedConfirmed && !confirmed.degreeCreditsEarned && projected.value != null) {
        const ip = inProgress.value;
        earned =
            ip != null && ip <= projected.value
                ? fig(
                      projected.value - ip,
                      'calculated',
                      'credits toward the degree you told me, minus in-progress',
                      projected.at
                  )
                : fig(null, 'unknown', '', null);
    }

    let remainingProjected = fig(
        total.value != null && projected.value != null ? total.value - projected.value : null,
        'calculated',
        'degree total − credits projected after this semester',
        projected.at
    );
    if (confirmed.degreeCreditsRemainingProjected) {
        const c = confirmed.degreeCreditsRemainingProjected;
        if (remainingProjected.value != null && remainingProjected.value !== c.value)
            discrepancies.push(
                `Remaining hours: you told me ${c.value}; the figures above give ${remainingProjected.value}. I'm using ${c.value}.`
            );
        remainingProjected = { value: c.value, source: 'student', method: 'you told me', at: c.at };
    }
    const remainingEarned = fig(
        total.value != null && earned.value != null ? total.value - earned.value : null,
        'calculated',
        'degree total − earned credits',
        earned.at
    );
    for (const [name, f] of [
        ['earned', earned],
        ['in progress', inProgress],
        ['projected', projected],
        ['remaining', remainingProjected],
    ] as const)
        if (f.value != null && f.value < 0)
            issues.push(`The ${name} figure came out negative (${f.value}); it can't be used.`);
    if (earned.value != null && projected.value != null && earned.value > projected.value)
        issues.push(
            'Earned credits came out larger than projected credits, which can’t happen; please re-import your IDA.'
        );

    const residence = totals?.residence ?? null;
    const ud = totals?.upperDivision ?? null;
    const udRes = totals?.upperDivisionResidence ?? null;
    const target = confirmed.targetGraduation
        ? { value: confirmed.targetGraduation.value, source: 'student' as const, at: confirmed.targetGraduation.at }
        : null;
    return {
        degreeProgram: audit?.program ?? null,
        catalogYear: audit?.catalogYear ?? null,
        auditTimestamp: at,
        auditIncludes: included,
        degreeTotalRequired: total,
        degreeCreditsCountedByIda: counted,
        degreeCreditsEarned: earned,
        degreeCreditsInProgress: inProgress,
        degreeCreditsFuturePlanned: fig(plannedRows, 'ida-courses', 'future or planned courses on the IDA list', at),
        degreeCreditsProjected: projected,
        degreeCreditsRemainingEarned: remainingEarned,
        degreeCreditsRemainingProjected: remainingProjected,
        utResidentRequired: prefer(
            fig(residence?.total ?? null, 'ida', totals?.rules.residence ?? 'IDA residence rule', at),
            confirmed.utResidentRequired,
            'Residence hours required',
            discrepancies
        ),
        utResidentCounted: prefer(
            fig(residence?.done ?? null, 'ida', 'IDA counted hours on the residence rule', at),
            confirmed.utResidentCounted,
            'Residence hours counted',
            discrepancies
        ),
        upperDivisionRequired: prefer(
            fig(ud?.total ?? null, 'ida', totals?.rules.upperDivision ?? 'IDA upper-division rule', at),
            confirmed.upperDivisionRequired,
            'Upper-division hours required',
            discrepancies
        ),
        upperDivisionCounted: prefer(
            fig(ud?.done ?? null, 'ida', 'IDA counted hours on the upper-division rule', at),
            confirmed.upperDivisionCounted,
            'Upper-division hours counted',
            discrepancies
        ),
        upperDivisionResidentRequired: prefer(
            fig(udRes?.total ?? null, 'ida', totals?.rules.upperDivisionResidence ?? 'IDA rule', at),
            confirmed.upperDivisionResidentRequired,
            'Upper-division residence hours required',
            discrepancies
        ),
        upperDivisionResidentCounted: fig(udRes?.done ?? null, 'ida', 'IDA counted hours on that rule', at),
        examCreditsAccepted: fig(
            audit ? summary.examHours : null,
            'ida-courses',
            'credit-by-exam courses on the IDA list',
            at
        ),
        transferCreditsAccepted: fig(
            audit ? summary.transferHours : null,
            'ida-courses',
            'transfer courses on the IDA list',
            at
        ),
        gpa: totals?.gpa ?? [],
        targetGraduation: target,
        issues,
        discrepancies,
    };
}

/** A short "where this number comes from" label for answers and the Degree progress page. */
export function sourceLabel(f: Figure): string {
    return {
        ida: 'from your IDA',
        'ida-courses': 'from your IDA course list',
        student: 'as you told me',
        calculated: 'calculated',
        unknown: 'not available',
    }[f.source];
}
