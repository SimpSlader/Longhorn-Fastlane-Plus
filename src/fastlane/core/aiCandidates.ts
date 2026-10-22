/**
 * Chooses which real sections the optional AI step may consider. The AI request is small (38 candidates), so
 * the choice is made locally from the whole inventory, in this order:
 *   1. applies to an unfinished IDA requirement (degree applicability)
 *   2. printed prerequisites not clearly missing from the IDA
 *   3. no known conflict with the active schedule
 *   4. scheduling preferences (Friday, asynchronous)
 *   5. historical grade rate (reliable samples first), when known
 * Picks are spread across subjects and limited per course so one large department cannot crowd out others.
 */
import type { GradeStat } from './grades';
import { SMALL_SAMPLE_SIZE } from './grades';
import type { SectionTimes } from './meetings';
import { detectConflicts, meetsOn } from './meetings';
import type { PrerequisiteCheck } from './prerequisites';
import { checkPrerequisites } from './prerequisites';
import { normalizeCourseCode, sectionMatchesRequirement } from './requirements';
import type { SectionRecord } from './sections';
import { semesterKey, subjectOf, toSectionTimes } from './sections';

export interface AiCandidate {
    section: SectionRecord;
    /** unfinished IDA requirement tags this section can apply to */
    applies: string[];
    prerequisite: PrerequisiteCheck;
    conflict: 'clear' | 'unknown' | 'conflict';
}

export interface AiCandidateInput {
    sections: SectionRecord[];
    /** "Spring 2027"; empty = any */
    term: string;
    /** completed and in-progress course codes */
    taken: Iterable<string>;
    /** unfinished requirement tags from the IDA */
    outstanding: string[];
    subject?: string;
    active: SectionTimes[];
    avoidFriday: boolean;
    preferAsync: boolean;
    subjectIndex: Array<[string, string]>;
}

const conflictRank = { clear: 0, unknown: 1, conflict: 2 } as const;

function baseKey(c: AiCandidate, input: AiCandidateInput): number[] {
    return [
        c.applies.length ? 0 : 1,
        c.prerequisite.status === 'unmet' ? 1 : 0,
        conflictRank[c.conflict],
        input.avoidFriday && meetsOn(c.section, 'F') ? 1 : 0,
        input.preferAsync && c.section.modality !== 'async-online' ? 1 : 0,
        -c.applies.length,
    ];
}

function compare(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d) return d;
    }
    return 0;
}

/** Round-robin across subjects, keeping the given order within each subject. */
function spread(list: AiCandidate[], limit: number, perCourse: number): AiCandidate[] {
    const bySubject = new Map<string, AiCandidate[]>();
    const perCourseCount = new Map<string, number>();
    for (const c of list) {
        const code = normalizeCourseCode(c.section.courseCode);
        const n = perCourseCount.get(code) ?? 0;
        if (n >= perCourse) continue;
        perCourseCount.set(code, n + 1);
        const subject = subjectOf(c.section.courseCode);
        bySubject.set(subject, [...(bySubject.get(subject) ?? []), c]);
    }
    const out: AiCandidate[] = [];
    for (let round = 0; out.length < limit; round++) {
        let added = false;
        for (const group of bySubject.values()) {
            const c = group[round];
            if (c && out.length < limit) {
                out.push(c);
                added = true;
            }
        }
        if (!added) break;
    }
    return out;
}

/** First pass without grades: the shortlist that gets historical-grade lookups. */
export function shortlistAiCandidates(input: AiCandidateInput, limit = 120): AiCandidate[] {
    const taken = new Set([...input.taken].map(normalizeCourseCode));
    const pool: AiCandidate[] = [];
    for (const section of input.sections) {
        if (section.status?.value === 'CANCELLED' || !section.course) continue;
        if (input.term && semesterKey(section.semester) !== input.term) continue;
        if (input.subject && subjectOf(section.courseCode) !== input.subject.toUpperCase()) continue;
        if (taken.has(normalizeCourseCode(section.courseCode))) continue;
        pool.push({
            section,
            applies: input.outstanding.filter(r => sectionMatchesRequirement(section, r)),
            prerequisite: checkPrerequisites(section.prerequisites, taken, input.subjectIndex),
            conflict: detectConflicts(toSectionTimes(section), input.active).status as AiCandidate['conflict'],
        });
    }
    pool.sort((a, b) => compare(baseKey(a, input), baseKey(b, input)));
    return spread(pool, limit, 3);
}

/** Final ordering with grades; returns the candidates actually sent. */
export function finalizeAiCandidates(
    shortlist: AiCandidate[],
    input: AiCandidateInput,
    gradeFor: (s: SectionRecord) => GradeStat | null | undefined,
    limit = 38
): AiCandidate[] {
    const key = (c: AiCandidate) => {
        const g = gradeFor(c.section);
        return [
            ...baseKey(c, input),
            g ? (g.result.graded >= SMALL_SAMPLE_SIZE ? 0 : 1) : 2,
            -(g?.result.percent ?? 0),
        ];
    };
    return spread(
        [...shortlist].sort((a, b) => compare(key(a), key(b))),
        limit,
        2
    );
}
