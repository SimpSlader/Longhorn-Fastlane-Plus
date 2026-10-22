/**
 * Requirement-aware course recommendations ("emergency backups").
 *
 * Candidates come ONLY from sections the extension has actually seen (bundled/approved datasets or
 * public UT course-schedule pages the student viewed). Nothing is invented: a section that is not in
 * the catalog is never suggested, and availability is only "open" when an observed status says so.
 *
 * Ranking is lexicographic, in this priority order:
 *   1. satisfies an outstanding degree requirement (required; more requirements is better)
 *   2. offered in the selected semester
 *   3. no known schedule conflicts (clear > unknown > conflict); observed CLOSED/WAITLISTED after open/unknown
 *   4. online / asynchronous preference
 *   5. historical grade distribution at the student's threshold (reliable samples first, then by %)
 *   6. professor information available (named instructor, instructor-specific grades)
 *   7. scheduling preferences (e.g. avoid Friday)
 *   8. prerequisite / reserved-seat eligibility
 */
import type { GradeStat, GradeThreshold } from './grades';
import { formatPercent, SMALL_SAMPLE_SIZE } from './grades';
import type { ConflictResult, SectionTimes } from './meetings';
import { conflictingSections, detectConflicts, meetsOn } from './meetings';
import { MODALITY_LABELS } from './modality';
import { describeRequirement, normalizeCourseCode } from './requirements';
import type { AvailabilityDisplay, SectionRecord } from './sections';
import { availabilityDisplay, semesterKey, toSectionTimes } from './sections';

export interface RecommendationPrefs {
    preferOnline: boolean;
    preferAsync: boolean;
    avoidFriday: boolean;
    gradeThreshold: GradeThreshold;
    /** grade stats below this sample size rank after reliable ones */
    minSampleSize: number;
}

export const DEFAULT_PREFS: RecommendationPrefs = {
    preferOnline: false,
    preferAsync: false,
    avoidFriday: false,
    gradeThreshold: 'A-',
    minSampleSize: SMALL_SAMPLE_SIZE,
};

export type Eligibility = { status: 'eligible' | 'unknown' | 'restricted'; notes: string[] };

export interface RecommendInput {
    /** outstanding requirement tags, highest priority first */
    requirements: string[];
    catalog: SectionRecord[];
    /** e.g. "Spring 2027"; null = any semester */
    semester: string | null;
    activeSchedule: SectionTimes[];
    /** unique numbers to skip (already planned, attempted, marked full) */
    excludeUniqueIds?: Iterable<number>;
    /** course codes already completed or in progress (normalized or raw) */
    excludeCourseCodes?: Iterable<string>;
    prefs?: Partial<RecommendationPrefs>;
    gradeFor?: (section: SectionRecord) => GradeStat | null;
    eligibilityFor?: (section: SectionRecord) => Eligibility;
    now?: number;
    limit?: number;
}

export interface Recommendation {
    section: SectionRecord;
    satisfies: string[];
    conflict: ConflictResult;
    grade: GradeStat | null;
    availability: AvailabilityDisplay;
    eligibility: Eligibility;
    reasons: string[];
    warnings: string[];
    /** ranking tuple, lower is better (exposed for tests and debugging) */
    rankKey: number[];
}

function defaultEligibility(section: SectionRecord): Eligibility {
    if (section.isReserved) {
        return {
            status: 'restricted',
            notes: ['Some seats are reserved; check the reserved-seat details on UT’s listing'],
        };
    }
    return { status: 'unknown', notes: ['Prerequisites not verified — check the course description'] };
}

function modalityRank(section: SectionRecord, prefs: RecommendationPrefs): number {
    const m = section.modality;
    if (prefs.preferAsync) {
        if (m === 'async-online') return 0;
        if (prefs.preferOnline && m === 'live-online') return 1;
        return 2;
    }
    if (prefs.preferOnline) return m === 'async-online' || m === 'live-online' ? 0 : 1;
    return 0;
}

function gradeRank(grade: GradeStat | null, prefs: RecommendationPrefs): [number, number] {
    if (!grade) return [2, 0];
    const reliable = grade.result.graded >= prefs.minSampleSize;
    return [reliable ? 0 : 1, -grade.result.percent];
}

function availabilityRank(section: SectionRecord): number {
    switch (section.status?.value) {
        case 'CLOSED':
            return 2;
        case 'WAITLISTED':
            return 1;
        default:
            return 0;
    }
}

export function compareRankKeys(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

export function recommend(input: RecommendInput): Recommendation[] {
    const prefs: RecommendationPrefs = { ...DEFAULT_PREFS, ...input.prefs };
    const now = input.now ?? Date.now();
    const exclude = new Set(input.excludeUniqueIds ?? []);
    const excludeCourses = new Set([...(input.excludeCourseCodes ?? [])].map(normalizeCourseCode));
    const outstanding = input.requirements;
    if (outstanding.length === 0) return [];

    const seen = new Set<number>();
    const results: Recommendation[] = [];

    for (const section of input.catalog) {
        if (seen.has(section.uniqueId) || exclude.has(section.uniqueId)) continue;
        if (excludeCourses.has(normalizeCourseCode(section.courseCode))) continue;
        if (section.status?.value === 'CANCELLED') continue;
        const satisfies = outstanding.filter(req => section.requirementTags.includes(req));
        if (satisfies.length === 0) continue;
        seen.add(section.uniqueId);

        const inSemester = input.semester === null || semesterKey(section.semester) === input.semester;
        const conflict = detectConflicts(toSectionTimes(section), input.activeSchedule);
        const conflictRank = conflict.status === 'clear' ? 0 : conflict.status === 'unknown' ? 1 : 2;
        const grade = input.gradeFor?.(section) ?? null;
        const eligibility = input.eligibilityFor?.(section) ?? defaultEligibility(section);
        const bestRequirementIndex = Math.min(...satisfies.map(s => outstanding.indexOf(s)));
        const hasInstructor = section.instructors.some(i => i.trim());
        const professorRank = (grade?.scope === 'instructor' ? 0 : 1) + (hasInstructor ? 0 : 1);
        const fridayRank = prefs.avoidFriday && meetsOn(section, 'F') ? 1 : 0;
        const eligibilityRank = eligibility.status === 'eligible' ? 0 : eligibility.status === 'unknown' ? 1 : 2;
        const [gradeReliability, gradePercent] = gradeRank(grade, prefs);

        const rankKey = [
            -satisfies.length,
            bestRequirementIndex,
            inSemester ? 0 : 1,
            conflictRank,
            availabilityRank(section),
            gradeReliability,
            gradePercent,
            modalityRank(section, prefs),
            professorRank,
            fridayRank,
            eligibilityRank,
            section.uniqueId,
        ];

        const reasons = [`Satisfies ${satisfies.map(describeRequirement).join(', ')}`];
        const warnings: string[] = [];
        if (inSemester && input.semester) reasons.push(`Offered ${input.semester}`);
        if (!inSemester) warnings.push(`Listed for ${semesterKey(section.semester)}, not ${input.semester}`);
        if (conflict.status === 'clear') reasons.push('No known conflicts with your active schedule');
        if (conflict.status === 'unknown') warnings.push('Conflict status unknown — some meeting times are missing');
        if (conflict.status === 'conflict') {
            warnings.push(
                `Conflicts with ${conflictingSections(conflict)
                    .map(s => s.label)
                    .join(', ')}`
            );
        }
        if (section.modality !== 'in-person') reasons.push(MODALITY_LABELS[section.modality]);
        if (grade) {
            reasons.push(
                `${formatPercent(grade.result.percent)} ${grade.result.threshold} or better (${grade.result.graded} grades, ${grade.scope === 'instructor' ? 'this professor' : 'course-wide'})`
            );
            if (grade.smallSample) warnings.push('Small grade sample');
        } else {
            warnings.push('No historical grade data');
        }
        if (fridayRank) warnings.push('Meets on Friday');
        warnings.push(...eligibility.notes);

        results.push({
            section,
            satisfies,
            conflict,
            grade,
            availability: availabilityDisplay(section.status, now),
            eligibility,
            reasons,
            warnings,
            rankKey,
        });
    }

    results.sort((a, b) => compareRankKeys(a.rankKey, b.rankKey));
    return results.slice(0, input.limit ?? 10);
}
