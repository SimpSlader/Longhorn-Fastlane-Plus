/**
 * Backup classes for a proposed week, so a full class never means a last-minute scramble. For each class:
 * two backups of the same kind (another section of the course, or a class meeting the same requirement or
 * subject, like another UGS for a UGS), and one "safe" backup from a course UT lists many sections of. Plus a
 * few general backups that fit beside the whole week. Backups never overlap the other classes they would
 * join, and no class is suggested twice. Everything comes from UT's listed sections; nothing is invented.
 */
import { fitsWith } from './proposal';
import { normalizeCourseCode } from './requirements';
import { isAsync } from './scheduleSolver';
import { type SectionRecord, subjectOf } from './sections';

export interface Backup {
    section: SectionRecord;
    /** why it is a backup, in plain words */
    why: string;
    kind: 'same course' | 'same requirement' | 'same subject' | 'safe';
}

export interface BackupPlan {
    perClass: Array<{ for: SectionRecord; backups: Backup[] }>;
    general: Backup[];
}

export interface BackupInput {
    plan: SectionRecord[];
    /** listed sections that follow the student's hard rules (days, exclusions, semester…) */
    candidates: SectionRecord[];
    /** unfinished IDA requirement tags */
    outstanding: string[];
    /** courses already completed or in progress */
    taken: Set<string>;
    /** historical A/A− percent when known */
    gradeOf: (s: SectionRecord) => number | null;
    /** how many sections UT lists for each course (more sections = easier to get a seat) */
    sectionCounts: Map<string, number>;
}

/** A course with this many listed sections is a "safe" fallback. */
export const SAFE_SECTIONS = 8;

const code = (s: SectionRecord) => normalizeCourseCode(s.courseCode);
const tagsOf = (s: SectionRecord, outstanding: Set<string>) => s.requirementTags.filter(t => outstanding.has(t));

export function sectionCounts(sections: SectionRecord[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const s of sections) counts.set(code(s), (counts.get(code(s)) ?? 0) + 1);
    return counts;
}

export function buildBackups(input: BackupInput, perKind = 2, generalCount = 3): BackupPlan {
    const outstanding = new Set(input.outstanding);
    const planCodes = new Set(input.plan.map(code));
    const used = new Set<number>();
    const usable = input.candidates.filter(
        s => !planCodes.has(code(s)) || input.plan.some(p => code(p) === code(s) && p.uniqueId !== s.uniqueId)
    );
    const notTaken = (s: SectionRecord) => !input.taken.has(code(s));
    const open = (s: SectionRecord) => s.status?.value !== 'CLOSED' && s.status?.value !== 'CANCELLED';
    const grade = (s: SectionRecord) => input.gradeOf(s) ?? 60;
    const many = (s: SectionRecord) => input.sectionCounts.get(code(s)) ?? 1;
    const rank = (a: SectionRecord, b: SectionRecord, bonus: (s: SectionRecord) => number) =>
        bonus(b) + grade(b) - (bonus(a) + grade(a));
    const take = (list: SectionRecord[], n: number) => {
        const out: SectionRecord[] = [];
        const courses = new Set<string>();
        for (const s of list) {
            if (out.length >= n) break;
            // one section per course, and never the same class for two different backups
            if (used.has(s.uniqueId) || courses.has(code(s))) continue;
            out.push(s);
            courses.add(code(s));
            used.add(s.uniqueId);
        }
        return out;
    };

    const perClass = input.plan.map(p => {
        const others = input.plan.filter(x => x.uniqueId !== p.uniqueId);
        const pTags = new Set(tagsOf(p, outstanding));
        const fits = usable.filter(s => s.uniqueId !== p.uniqueId && open(s) && notTaken(s) && fitsWith(s, others));
        const sameCourse = (s: SectionRecord) => code(s) === code(p);
        const sameReq = (s: SectionRecord) => s.requirementTags.some(t => pTags.has(t));
        const sameSubject = (s: SectionRecord) => subjectOf(s.courseCode) === subjectOf(p.courseCode);
        const kindOf = (s: SectionRecord): Backup['kind'] =>
            sameCourse(s) ? 'same course' : sameReq(s) ? 'same requirement' : 'same subject';
        const alike = fits
            .filter(s => sameCourse(s) || sameReq(s) || sameSubject(s))
            .sort((a, b) =>
                rank(
                    a,
                    b,
                    s => (sameCourse(s) ? 12 : 0) + (sameReq(s) ? 8 : 0) + (tagsOf(s, outstanding).length ? 4 : 0)
                )
            );
        const chosen: Backup[] = take(alike, perKind).map(s => ({
            section: s,
            kind: kindOf(s),
            why:
                kindOf(s) === 'same course'
                    ? `Another section of ${p.courseCode}`
                    : kindOf(s) === 'same requirement'
                      ? `Counts for the same requirement as ${p.courseCode}`
                      : `Another ${subjectOf(p.courseCode)} class`,
        }));
        // the safe fallback: a course with many listed sections, ideally for the same requirement
        const safe = fits
            .filter(s => many(s) >= SAFE_SECTIONS && !sameCourse(s))
            .sort((a, b) =>
                rank(
                    a,
                    b,
                    s => (sameReq(s) ? 15 : 0) + (tagsOf(s, outstanding).length ? 6 : 0) + Math.min(many(s), 30) / 3
                )
            );
        const fallback = take(safe, 1).map(s => ({
            section: s,
            kind: 'safe' as const,
            why: `Safe pick: UT lists ${many(s)} sections${sameReq(s) ? `, same requirement as ${p.courseCode}` : ''}`,
        }));
        return { for: p, backups: [...chosen, ...fallback] };
    });

    // general backups fit beside the whole week, so they can stand in for any class
    const general = take(
        usable
            .filter(s => open(s) && notTaken(s) && !planCodes.has(code(s)) && fitsWith(s, input.plan))
            .filter(s => tagsOf(s, outstanding).length > 0 || many(s) >= SAFE_SECTIONS)
            .sort((a, b) =>
                rank(
                    a,
                    b,
                    s => (tagsOf(s, outstanding).length ? 10 : 0) + Math.min(many(s), 30) / 3 + (isAsync(s) ? 4 : 0)
                )
            ),
        generalCount
    ).map(s => ({
        section: s,
        kind: 'safe' as const,
        why: isAsync(s)
            ? 'Online on your own schedule, fits any week'
            : `Fits around all your classes${many(s) >= SAFE_SECTIONS ? `; UT lists ${many(s)} sections` : ''}`,
    }));
    return { perClass, general };
}
