/**
 * Historical grade threshold math.
 *
 * Every number shown to students is derived here from raw historical grade COUNTS.
 * Nothing in this module estimates, interpolates or fills in missing data: if the
 * counts needed to answer a question are not present, the answer is `null`.
 */

/** Letter grades in descending order. UT Austin does not award A+, but imported datasets may include it. */
export const LETTER_GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'] as const;

export type Letter = (typeof LETTER_GRADES)[number];

/**
 * Thresholds a student can pick. "A-" means "A- or better" (A-, A and, if present, A+).
 * A+ is intentionally not selectable because UT does not award it.
 */
export const GRADE_THRESHOLDS = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-'] as const;

export type GradeThreshold = (typeof GRADE_THRESHOLDS)[number];

export const DEFAULT_GRADE_THRESHOLD: GradeThreshold = 'A-';

/**
 * Raw counts keyed by letter grade. `Other` collects non-letter outcomes in the source data
 * (for example CR/NC, Q-drops, incompletes or withdrawals). Those are EXCLUDED from both the
 * numerator and the denominator because they are not letter grades.
 */
export type GradeCounts = Partial<Record<Letter | 'Other', number>>;

export interface ThresholdResult {
    threshold: GradeThreshold;
    /** Number of letter grades at or above the threshold */
    atOrAbove: number;
    /** Number of letter grades (A+..F). This is the denominator. */
    graded: number;
    /** Non-letter outcomes that were excluded from the calculation */
    excluded: number;
    /** Exact percentage in [0, 100]; round only for display */
    percent: number;
}

export class InvalidGradeCountsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidGradeCountsError';
    }
}

export function isGradeThreshold(value: unknown): value is GradeThreshold {
    return typeof value === 'string' && (GRADE_THRESHOLDS as readonly string[]).includes(value);
}

/** Letters that count toward "threshold or better". */
export function lettersAtOrAbove(threshold: GradeThreshold): Letter[] {
    const index = LETTER_GRADES.indexOf(threshold);
    if (index < 0) throw new InvalidGradeCountsError(`Unknown threshold ${threshold}`);
    return LETTER_GRADES.slice(0, index + 1);
}

function readCount(counts: GradeCounts, key: Letter | 'Other'): number {
    const raw = counts[key];
    if (raw === undefined || raw === null) return 0;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
        throw new InvalidGradeCountsError(`Grade count for ${key} must be a non-negative integer, got ${String(raw)}`);
    }
    return raw;
}

/**
 * Computes the percentage of students who earned `threshold` or better.
 *
 * @returns `null` when there are no letter grades to divide by (never a fabricated 0%).
 * @throws InvalidGradeCountsError if any count is negative, fractional or not a number.
 */
export function computeThreshold(counts: GradeCounts, threshold: GradeThreshold): ThresholdResult | null {
    const included = new Set<Letter>(lettersAtOrAbove(threshold));
    let graded = 0;
    let atOrAbove = 0;
    for (const letter of LETTER_GRADES) {
        const n = readCount(counts, letter);
        graded += n;
        if (included.has(letter)) atOrAbove += n;
    }
    const excluded = readCount(counts, 'Other');
    if (graded === 0) return null;
    return { threshold, atOrAbove, graded, excluded, percent: (atOrAbove / graded) * 100 };
}

/** Adds several count records together (e.g. multiple semesters). */
export function sumCounts(records: GradeCounts[]): GradeCounts {
    const total: GradeCounts = {};
    for (const record of records) {
        for (const key of [...LETTER_GRADES, 'Other'] as const) {
            const n = readCount(record, key);
            if (n) total[key] = (total[key] ?? 0) + n;
        }
    }
    return total;
}

/** Display helper: one decimal place, never rounds 99.95 up to a misleading "100.0%" unless it is exact. */
export function formatPercent(percent: number): string {
    if (percent >= 100) return '100%';
    const fixed = (Math.floor(percent * 10) / 10).toFixed(1);
    return `${fixed}%`;
}

/**
 * Short badge label for the threshold, matching the requested wording:
 * minus thresholds read as "A-+" (A- or better); others as "B+ or better".
 */
export function thresholdLabel(threshold: GradeThreshold): string {
    return threshold.endsWith('-') ? `${threshold}+` : `${threshold} or better`;
}

/** Below this many letter grades we still show the number, but flag it as a small sample. */
export const SMALL_SAMPLE_SIZE = 30;

export type GradeScope = 'instructor' | 'course';

/** A fully-attributed statistic, ready to render. */
export interface GradeStat {
    scope: GradeScope;
    courseCode: string;
    /** Instructor name when scope === 'instructor' */
    instructor?: string;
    result: ThresholdResult;
    /** e.g. ['Fall 2023', 'Spring 2024'] in chronological order */
    semesters: string[];
    source: string;
    datasetVersion: string;
    /** ISO date the dataset was last updated */
    datasetUpdated: string;
    smallSample: boolean;
}

const SEASON_ORDER: Record<string, number> = { Spring: 1, Summer: 2, Fall: 3 };

/** Sorts semester labels like "Fall 2023" chronologically; unknown formats go last, alphabetically. */
export function sortSemesterLabels(labels: string[]): string[] {
    const key = (label: string): [number, number] => {
        const match = label.match(/^(Spring|Summer|Fall)\s+(\d{4})$/);
        if (!match) return [Number.MAX_SAFE_INTEGER, 0];
        return [Number(match[2]), SEASON_ORDER[match[1]!]!];
    };
    return [...new Set(labels)].sort((a, b) => {
        const [ya, sa] = key(a);
        const [yb, sb] = key(b);
        return ya - yb || sa - sb || a.localeCompare(b);
    });
}

export function describeSemesters(semesters: string[]): string {
    const sorted = sortSemesterLabels(semesters);
    if (sorted.length === 0) return 'no semesters';
    if (sorted.length === 1) return `1 semester (${sorted[0]})`;
    return `${sorted.length} semesters (${sorted[0]} – ${sorted[sorted.length - 1]})`;
}

export function buildGradeStat(
    input: Omit<GradeStat, 'smallSample' | 'semesters'> & { semesters: string[] }
): GradeStat {
    return {
        ...input,
        semesters: sortSemesterLabels(input.semesters),
        smallSample: input.result.graded < SMALL_SAMPLE_SIZE,
    };
}

/** Multi-line plain-text explanation used for tooltips and screen readers. */
export function describeGradeStat(stat: GradeStat): string {
    const who = stat.scope === 'instructor' ? `Professor ${stat.instructor}` : 'Course-wide (all instructors)';
    const lines = [
        `${formatPercent(stat.result.percent)} of ${stat.result.graded.toLocaleString('en-US')} letter grades were ${stat.result.threshold} or better`,
        `${who} · ${stat.courseCode}`,
        describeSemesters(stat.semesters),
        `Source: ${stat.source}`,
        `Dataset ${stat.datasetVersion}, updated ${stat.datasetUpdated}`,
    ];
    if (stat.result.excluded > 0) {
        lines.push(`${stat.result.excluded.toLocaleString('en-US')} non-letter outcomes (e.g. CR/NC, Q, W) excluded`);
    }
    if (stat.smallSample) lines.push(`Small sample: fewer than ${SMALL_SAMPLE_SIZE} letter grades`);
    lines.push('Historical data only; not a prediction.');
    return lines.join('\n');
}
