/**
 * Which outstanding requirement each selected course is actually counted toward.
 *
 * A course being Core-designated does not mean it advances THIS student's degree: it must carry a requirement
 * tag that is still outstanding in the imported audit, and two courses may not both be spent on the same single
 * requirement (UGS 302 and UGS 303 are alternatives for the one Signature Course requirement). The assignment is
 * a bipartite matching, so a course with two possible tags can take whichever leaves the other course a slot.
 */
import { coreTag, normalizeCourseCode } from './requirements';
import { type SectionRecord, subjectOf } from './sections';

const CORE_TAG = /^CORE \d{3}$/;
export const isCoreTag = (t: string) => CORE_TAG.test(t);
/** Signature Course (Core 090): UGS 302 and UGS 303 are alternatives */
export const SIGNATURE_TAG = coreTag('090');

/** the outstanding requirement tags (restricted to core ones when `coreOnly`) a section could fill */
export function fillableTags(applies: string[], coreOnly: boolean): string[] {
    return applies.filter(t => (coreOnly ? isCoreTag(t) : !t.startsWith('COURSE ') && !t.startsWith('FLAG ')));
}

export interface Assignment {
    /** uniqueId → the tag it is counted toward */
    assigned: Map<number, string>;
    /** sections that could not get a requirement of their own (redundant or advancing nothing) */
    unassigned: SectionRecord[];
}

/** Maximum matching of sections to distinct requirement tags (Kuhn's algorithm; schedules are tiny). */
export function assignRequirements(
    sections: SectionRecord[],
    applies: (s: SectionRecord) => string[],
    coreOnly: boolean
): Assignment {
    const options = new Map(sections.map(s => [s.uniqueId, fillableTags(applies(s), coreOnly)]));
    const owner = new Map<string, number>(); // tag → uniqueId
    const tryAssign = (id: number, seen: Set<string>): boolean => {
        for (const tag of options.get(id) ?? []) {
            if (seen.has(tag)) continue;
            seen.add(tag);
            const other = owner.get(tag);
            if (other === undefined || tryAssign(other, seen)) {
                owner.set(tag, id);
                return true;
            }
        }
        return false;
    };
    for (const s of sections) tryAssign(s.uniqueId, new Set());
    const assigned = new Map<number, string>();
    for (const [tag, id] of owner) assigned.set(id, tag);
    return { assigned, unassigned: sections.filter(s => !assigned.has(s.uniqueId)) };
}

/** UGS Signature Courses in a list (by subject UGS) */
export const signatureCourses = (sections: SectionRecord[]) => sections.filter(s => subjectOf(s.courseCode) === 'UGS');

/** Courses that are the same requirement alternative: same subject-level "pick one" group. */
export const sameCourse = (a: SectionRecord, b: SectionRecord) =>
    normalizeCourseCode(a.courseCode) === normalizeCourseCode(b.courseCode);
