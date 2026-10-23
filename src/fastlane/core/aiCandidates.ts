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
        const group = bySubject.get(subject);
        if (group) group.push(c);
        else bySubject.set(subject, [c]);
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

const NO_PREREQUISITE: PrerequisiteCheck = { status: 'none', groups: [], missing: [], notes: [] };
/** Sections that get the (more expensive) prerequisite check; the rest cannot reach the shortlist anyway. */
const PREREQUISITE_POOL = 400;

/** Yields to the browser so typing, scrolling and painting stay responsive during long work. */
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export class SelectionCancelled extends Error {
    constructor() {
        super('Cancelled');
        this.name = 'SelectionCancelled';
    }
}

interface Steps {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

/**
 * Cheap pass over the whole inventory (filters, requirement matching, conflicts), then prerequisites only for
 * the best PREREQUISITE_POOL. A generator, so the async caller can yield to the browser between chunks.
 */
function* rank(input: AiCandidateInput, limit: number): Generator<number, AiCandidate[]> {
    const taken = new Set([...input.taken].map(normalizeCourseCode));
    const subject = input.subject?.toUpperCase();
    const pool: AiCandidate[] = [];
    let i = 0;
    for (const section of input.sections) {
        if (++i % 1500 === 0) yield i;
        if (section.status?.value === 'CANCELLED' || !section.course) continue;
        if (input.term && semesterKey(section.semester) !== input.term) continue;
        if (subject && subjectOf(section.courseCode) !== subject) continue;
        if (taken.has(normalizeCourseCode(section.courseCode))) continue;
        pool.push({
            section,
            applies: input.outstanding.filter(r => sectionMatchesRequirement(section, r)),
            prerequisite: NO_PREREQUISITE,
            conflict: detectConflicts(toSectionTimes(section), input.active).status as AiCandidate['conflict'],
        });
    }
    pool.sort((a, b) => compare(baseKey(a, input), baseKey(b, input)));
    yield i;
    const top = spread(pool, PREREQUISITE_POOL, 3);
    for (const c of top) c.prerequisite = checkPrerequisites(c.section.prerequisites, taken, input.subjectIndex);
    top.sort((a, b) => compare(baseKey(a, input), baseKey(b, input)));
    return spread(top, limit, 3);
}

/** First pass without grades: the shortlist that gets historical-grade lookups. */
export function shortlistAiCandidates(input: AiCandidateInput, limit = 120): AiCandidate[] {
    const steps = rank(input, limit);
    for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

/**
 * The whole selection for one AI request, run when the student presses Ask: yields to the browser between
 * chunks, reports progress, looks up historical grades only for the shortlist, and can be cancelled.
 */
export async function chooseAiCandidates(
    input: AiCandidateInput,
    gradeLookup: (s: SectionRecord) => Promise<GradeStat | null>,
    options: Steps & { limit?: number; asyncShare?: number } = {}
): Promise<{ chosen: AiCandidate[]; grades: Map<number, GradeStat | null>; compared: number }> {
    const check = () => {
        if (options.signal?.aborted) throw new SelectionCancelled();
    };
    options.onProgress?.(`Comparing ${input.sections.length.toLocaleString()} UT sections…`);
    const steps = rank(input, 120);
    let step = steps.next();
    while (!step.done) {
        check();
        await yieldToBrowser();
        step = steps.next();
    }
    const shortlist = step.value;
    check();
    const grades = new Map<number, GradeStat | null>();
    for (const [n, c] of shortlist.entries()) {
        if (n % 8 === 0) {
            options.onProgress?.(`Checking historical grades (${n} of ${shortlist.length})…`);
            await yieldToBrowser();
            check();
        }
        grades.set(c.section.uniqueId, await gradeLookup(c.section).catch(() => null));
    }
    const gradeFor = (s: SectionRecord) => grades.get(s.uniqueId);
    const limit = options.limit ?? 38;
    let chosen: AiCandidate[];
    if (input.preferAsync) {
        // asked for online classes: keep a share of asynchronous options among the candidates
        const online = finalizeAiCandidates(
            shortlist.filter(c => c.section.modality === 'async-online'),
            input,
            gradeFor,
            options.asyncShare ?? 12
        );
        const ids = new Set(online.map(c => c.section.uniqueId));
        chosen = [
            ...online,
            ...finalizeAiCandidates(
                shortlist.filter(c => !ids.has(c.section.uniqueId)),
                input,
                gradeFor,
                limit - online.length
            ),
        ];
    } else chosen = finalizeAiCandidates(shortlist, input, gradeFor, limit);
    return { chosen, grades, compared: input.sections.length };
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
