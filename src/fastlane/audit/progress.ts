/**
 * Progress summaries for the Degree progress page, derived only from what the imported IDA states.
 *
 * - Hours are shown only from a rule that states the category total ("42 hours are required to complete the core
 *   curriculum"). Sub-rules are never added on top of that total, so overlapping requirements are not double counted.
 * - Without such a total, hours are summed only when every rule is in hours and no course is listed under two
 *   rules; otherwise the card shows requirement counts and says hours need verification.
 * - The official completion percentage is never computed here; it comes from the IDA itself.
 */
import type { AuditRequirement, ParsedAudit, RequirementCategory } from './types';

export interface ProgressSummary {
    /** completed / required, in the stated unit */
    figure: { done: number; total: number; unit: 'hours' | 'requirements' } | null;
    remainingText: string;
    hoursNeedVerification: boolean;
    counts: { completed: number; inProgress: number; remaining: number; total: number };
    /** checklist rows (the category total rule itself is left out) */
    items: AuditRequirement[];
}

const TOTAL_RULE = /\b(?:required to complete|hours are required for|total of)\b/i;

function hours(r: AuditRequirement, key: 'required' | 'applied' | 'remaining'): number | undefined {
    const p = r[key];
    return p?.unit === 'hours' ? p.value : undefined;
}

/** The rule stating a category's total hours, if the IDA has one. */
export function totalRule(reqs: AuditRequirement[]): AuditRequirement | undefined {
    const candidates = reqs.filter(r => hours(r, 'required') !== undefined && TOTAL_RULE.test(r.text));
    return candidates.sort((a, b) => (hours(b, 'required') ?? 0) - (hours(a, 'required') ?? 0))[0];
}

export function summarizeRequirements(reqs: AuditRequirement[]): ProgressSummary {
    const total = totalRule(reqs);
    const items = reqs.filter(r => r !== total);
    const counts = {
        completed: items.filter(r => r.status === 'completed').length,
        inProgress: items.filter(r => r.status === 'in-progress').length,
        remaining: items.filter(r => r.status === 'not-started').length,
        total: items.length,
    };
    const unfinished = counts.inProgress + counts.remaining;
    const countText = unfinished
        ? `${unfinished} requirement${unfinished === 1 ? '' : 's'} left`
        : 'All requirements complete';

    if (total) {
        const required = hours(total, 'required') ?? 0;
        const done = Math.min(required, hours(total, 'applied') ?? required - (hours(total, 'remaining') ?? required));
        const left = hours(total, 'remaining') ?? Math.max(0, required - done);
        return {
            figure: { done, total: required, unit: 'hours' },
            remainingText: left > 0 ? `${left} credit hours remaining` : 'All hours complete',
            hoursNeedVerification: false,
            counts,
            items,
        };
    }
    const allHours = items.length > 0 && items.every(r => hours(r, 'required') !== undefined);
    const listed = items.flatMap(r => r.courses);
    const overlap = new Set(listed).size !== listed.length;
    if (allHours && !overlap) {
        const required = items.reduce((n, r) => n + (hours(r, 'required') ?? 0), 0);
        const done = items.reduce((n, r) => n + Math.min(hours(r, 'required') ?? 0, hours(r, 'applied') ?? 0), 0);
        return {
            figure: { done, total: required, unit: 'hours' },
            remainingText: required - done > 0 ? `${required - done} credit hours remaining` : 'All hours complete',
            hoursNeedVerification: false,
            counts,
            items,
        };
    }
    return {
        figure: items.length ? { done: counts.completed, total: counts.total, unit: 'requirements' } : null,
        remainingText: countText,
        hoursNeedVerification: items.some(r => hours(r, 'required') !== undefined),
        counts,
        items,
    };
}

export interface DegreeTotals {
    official: number | null;
    totalHours: { done: number; total: number; remaining: number } | null;
    residence: { done: number; total: number } | null;
    gpa: Array<{ label: string; value: number; minimum: number }>;
}

/** Totals for the summary cards: official %, degree hours, residence hours and GPA rules as stated by the IDA. */
export function degreeTotals(audit: ParsedAudit): DegreeTotals {
    const reqs = audit.requirements;
    const degree = reqs
        .filter(r => /hours are required for the|required for (?:the )?degree/i.test(r.text) && hours(r, 'required'))
        .sort((a, b) => (hours(b, 'required') ?? 0) - (hours(a, 'required') ?? 0))[0];
    const fromRule = degree
        ? {
              total: hours(degree, 'required') ?? 0,
              done: hours(degree, 'applied') ?? 0,
              remaining:
                  hours(degree, 'remaining') ??
                  Math.max(0, (hours(degree, 'required') ?? 0) - (hours(degree, 'applied') ?? 0)),
          }
        : null;
    const { required, applied, remaining } = audit.creditHours;
    const totalHours =
        fromRule ??
        (required !== undefined && applied !== undefined
            ? { total: required, done: applied, remaining: remaining ?? Math.max(0, required - applied) }
            : null);
    const res = reqs
        .filter(r => /in residence/i.test(r.text) && hours(r, 'required'))
        .sort((a, b) => (hours(b, 'required') ?? 0) - (hours(a, 'required') ?? 0))[0];
    // the parser keeps GPA values in the hours slot; they are GPAs (e.g. 3.78 against a 2.00 minimum)
    const gpa = reqs
        .filter(
            r => r.category === 'gpa' && r.required && r.applied && r.required.value <= 4.5 && r.applied.value <= 4.5
        )
        .map(r => ({
            label: /university gpa/i.test(r.text)
                ? 'University GPA'
                : (r.text.match(/in all ([a-z ]+?) (?:courses|and)/i)?.[1] ?? 'GPA requirement'),
            value: r.applied?.value ?? 0,
            minimum: r.required?.value ?? 0,
        }));
    return {
        official: audit.officialProgress?.percent ?? null,
        totalHours,
        residence: res
            ? {
                  done: Math.min(hours(res, 'required') ?? 0, hours(res, 'applied') ?? 0),
                  total: hours(res, 'required') ?? 0,
              }
            : null,
        gpa,
    };
}

export const CARD_GROUPS: Array<{ key: string; title: string; categories: RequirementCategory[] }> = [
    { key: 'core', title: 'Core Curriculum', categories: ['core'] },
    { key: 'general', title: 'General Education', categories: ['general'] },
    { key: 'major', title: 'Major Requirements', categories: ['major'] },
    { key: 'minor', title: 'Minor Requirements', categories: ['minor'] },
];

/** A minor card is shown only when the audit has real minor rules (not "This major does not require a minor"). */
export function hasMinor(reqs: AuditRequirement[]): boolean {
    return reqs.some(r => r.category === 'minor' && !/does not require a minor/i.test(r.text));
}
