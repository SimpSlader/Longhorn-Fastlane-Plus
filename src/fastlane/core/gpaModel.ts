/**
 * Confidence-aware GPA outlook for a section, from raw historical grade counts.
 *
 * Instead of ranking by a raw "A or A−" percentage (which lets 95% of 10 students beat 90% of 2,000), each
 * grade distribution is smoothed with a Dirichlet prior (the typical UT distribution, worth PRIOR_STRENGTH
 * students) and ranked by a conservative lower bound on expected grade points. A, A−, B+ … are kept separate and
 * weighted by their UT GPA points. Nothing is estimated when there are no counts: the result is null.
 *
 * Not available from the data (and therefore never claimed): per-semester consistency — the bundled dataset
 * keeps one aggregated distribution per course/instructor — and which instructor will teach a future section
 * beyond what the section listing says.
 */
import type { GradeCounts, Letter } from './grades';
import { LETTER_GRADES } from './grades';

/** UT Austin grade points (no A+) */
export const GRADE_POINTS: Record<Letter, number> = {
    'A+': 4,
    A: 4,
    'A-': 3.67,
    'B+': 3.33,
    B: 3,
    'B-': 2.67,
    'C+': 2.33,
    C: 2,
    'C-': 1.67,
    'D+': 1.33,
    D: 1,
    'D-': 0.67,
    F: 0,
};

/** Typical share of each letter grade across UT undergraduate classes; only a weak prior. */
const PRIOR_SHARE: Record<Letter, number> = {
    'A+': 0,
    A: 0.38,
    'A-': 0.17,
    'B+': 0.12,
    B: 0.11,
    'B-': 0.06,
    'C+': 0.05,
    C: 0.05,
    'C-': 0.02,
    'D+': 0.01,
    D: 0.01,
    'D-': 0.005,
    F: 0.015,
};
const PRIOR_STRENGTH = 25;
/** results older than this lose half their weight in the confidence assessment */
const STALE_YEARS = 4;
/** how many standard deviations below the mean the ranking value sits (~80th-percentile-safe) */
const CAUTION = 0.85;

export type Confidence = 'high' | 'medium' | 'low';

export interface GpaEstimate {
    scope: 'instructor' | 'course';
    /** real letter grades behind the estimate */
    sample: number;
    /** posterior mean grade points (0–4) */
    expectedGradePoints: number;
    /** conservative value used for ranking */
    rankValue: number;
    pA: number;
    pAMinus: number;
    /** probability of B or better */
    pBOrBetter: number;
    confidence: Confidence;
    /** newest semester in the data, e.g. "Fall 2025", when known */
    latestSemester: string | null;
    stale: boolean;
    rationale: string;
}

const PRIOR_MEAN = Object.entries(PRIOR_SHARE).reduce((n, [g, p]) => n + p * GRADE_POINTS[g as Letter], 0);
export const NEUTRAL_RANK_VALUE = PRIOR_MEAN - 0.4;

function newestSemester(labels: string[]): { label: string; year: number } | null {
    let best: { label: string; year: number; order: number } | null = null;
    const season: Record<string, number> = { Spring: 1, Summer: 2, Fall: 3 };
    for (const label of labels) {
        const m = label.match(/^(Spring|Summer|Fall)\s+(\d{4})$/);
        if (!m) continue;
        const order = Number(m[2]) * 4 + season[m[1]!]!;
        if (!best || order > best.order) best = { label, year: Number(m[2]), order };
    }
    return best && { label: best.label, year: best.year };
}

export function estimateGpa(input: {
    counts: GradeCounts | undefined | null;
    scope: 'instructor' | 'course';
    semesters?: string[];
    /** the year of "now", for recency (injectable for tests) */
    nowYear?: number;
}): GpaEstimate | null {
    if (!input.counts) return null;
    const observed = LETTER_GRADES.map(g => Math.max(0, Number(input.counts![g] ?? 0)));
    const n = observed.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(n) || n <= 0) return null;

    const newest = newestSemester(input.semesters ?? []);
    const nowYear = input.nowYear ?? new Date().getFullYear();
    const stale = !!newest && nowYear - newest.year >= STALE_YEARS;
    // old data counts for less, so a stale distribution is pulled harder toward the typical one
    const weight = stale ? 0.5 : 1;
    const alpha = LETTER_GRADES.map((g, i) => PRIOR_STRENGTH * PRIOR_SHARE[g] + observed[i]! * weight);
    const total = alpha.reduce((a, b) => a + b, 0);
    const p = alpha.map(a => a / total);
    const gp = LETTER_GRADES.map(g => GRADE_POINTS[g]);
    const mean = p.reduce((s, pi, i) => s + pi * gp[i]!, 0);
    const variance = p.reduce((s, pi, i) => s + pi * gp[i]! ** 2, 0) - mean ** 2;
    const sd = Math.sqrt(Math.max(0, variance) / (total + 1));
    const at = (g: Letter) => p[LETTER_GRADES.indexOf(g)]!;
    const effective = n * weight;
    const confidence: Confidence = effective >= 150 ? 'high' : effective >= 40 ? 'medium' : 'low';
    const who = input.scope === 'instructor' ? 'this instructor' : 'all instructors of the course';
    const rationale =
        `${n.toLocaleString('en-US')} letter grades for ${who}` +
        `${newest ? `, newest ${newest.label}${stale ? ' (old: counted at half weight)' : ''}` : ''}; ` +
        `smoothed toward the typical UT distribution (${PRIOR_STRENGTH} pseudo-students); ` +
        `expected ${mean.toFixed(2)} GPA points, ranked at ${(mean - CAUTION * sd).toFixed(2)} (${confidence} confidence).`;
    return {
        scope: input.scope,
        sample: n,
        expectedGradePoints: mean,
        rankValue: mean - CAUTION * sd,
        pA: at('A') + at('A+'),
        pAMinus: at('A-'),
        pBOrBetter: at('A') + at('A+') + at('A-') + at('B+') + at('B'),
        confidence,
        latestSemester: newest?.label ?? null,
        stale,
        rationale,
    };
}

/** Points added to a section's score for its GPA outlook (1 GPA point ≈ 6 score points; neutral at ≈ 3.0). */
export function gpaScore(estimate: GpaEstimate | null | undefined, weight = 1): number {
    const value = estimate ? estimate.rankValue : NEUTRAL_RANK_VALUE;
    return (value - 3) * 6 * weight;
}

/** Plain explanation of why one section outranks another on grades alone. */
export function compareRationale(
    a: { label: string; estimate: GpaEstimate | null },
    b: { label: string; estimate: GpaEstimate | null }
): string {
    if (!a.estimate || !b.estimate)
        return `${!a.estimate ? a.label : b.label} has no historical grade data, so it is ranked at a neutral value, not an assumed one.`;
    const better = a.estimate.rankValue >= b.estimate.rankValue ? a : b;
    const worse = better === a ? b : a;
    return `${better.label} ranks above ${worse.label}: conservative ${better.estimate!.rankValue.toFixed(2)} vs ${worse.estimate!.rankValue.toFixed(2)} GPA points (samples ${better.estimate!.sample.toLocaleString('en-US')} and ${worse.estimate!.sample.toLocaleString('en-US')}).`;
}
