import type { ParsedAudit } from '../audit/types';
import type { GradeStat } from './grades';
import { DAY_ORDER, type DayCode, detectConflicts, scheduleConflicts } from './meetings';
import { normalizeCourseCode } from './requirements';
import { type SectionRecord, semesterKey, toSectionTimes } from './sections';

export type Grades = Map<number, GradeStat | null>;
export interface PlannerFilters {
    semester: string;
    query: string;
    professor: string;
    modality: string;
    days: DayCode[];
    start: number;
    end: number;
    minGrade: number;
    hours: number;
    requirement: string;
    fits: boolean;
    noGaps: boolean;
    preferAsync: boolean;
    highGrades: boolean;
    shortWalk: boolean;
}
export const DEFAULT_FILTERS: PlannerFilters = {
    semester: '',
    query: '',
    professor: '',
    modality: '',
    days: [...DAY_ORDER],
    start: 0,
    end: 1440,
    minGrade: 0,
    hours: 0,
    requirement: '',
    fits: false,
    noGaps: false,
    preferAsync: false,
    highGrades: true,
    shortWalk: false,
};
export function matchesFilters(s: SectionRecord, f: PlannerFilters, grades: Grades, active: SectionRecord[] = []) {
    if (f.semester && semesterKey(s.semester) !== f.semester) return false;
    if (!`${s.courseCode} ${s.title}`.toLowerCase().includes(f.query.toLowerCase())) return false;
    if (!s.instructors.join(' ').toLowerCase().includes(f.professor.toLowerCase())) return false;
    if (f.modality && s.modality !== f.modality) return false;
    if (f.hours && s.creditHours !== f.hours) return false;
    if (f.requirement && !s.requirementTags.includes(f.requirement)) return false;
    if (f.minGrade > 0 && (grades.get(s.uniqueId)?.result.percent ?? -1) < f.minGrade) return false;
    const limited = f.days.length < 7 || f.start > 0 || f.end < 1440 || f.noGaps;
    if (limited && !s.scheduleComplete && s.modality !== 'async-online') return false;
    if (s.meetings.some(m => m.days.some(d => !f.days.includes(d)) || m.start < f.start || m.end > f.end)) return false;
    if (
        f.fits &&
        (active.some(a => normalizeCourseCode(a.courseCode) === normalizeCourseCode(s.courseCode)) ||
            detectConflicts(toSectionTimes(s), active.map(toSectionTimes)).status !== 'clear')
    )
        return false;
    if (f.noGaps && metrics([...active, s], grades).gapMinutes > 0) return false;
    return true;
}
export function metrics(sections: SectionRecord[], grades: Grades) {
    const gaps: Record<string, number> = {};
    let buildingChanges = 0;
    let unknownLocations = 0;
    for (const d of DAY_ORDER) {
        const meetings = sections
            .flatMap(s =>
                s.meetings
                    .filter(m => m.days.includes(d))
                    .map(m => ({ ...m, physical: s.modality === 'in-person' || s.modality === 'hybrid' }))
            )
            .sort((a, b) => a.start - b.start);
        let end = meetings[0]?.end ?? 0;
        gaps[d] = 0;
        for (let i = 1; i < meetings.length; i++) {
            const m = meetings[i]!;
            const prev = meetings[i - 1]!;
            gaps[d] += Math.max(0, m.start - end);
            end = Math.max(end, m.end);
            if (m.physical && prev.physical) {
                if (!m.location || !prev.location) unknownLocations++;
                else if (m.location.split(' ')[0] !== prev.location.split(' ')[0]) buildingChanges++;
            }
        }
    }
    const known = sections.map(s => grades.get(s.uniqueId)).filter((g): g is GradeStat => !!g);
    return {
        hours: sections.reduce((n, s) => n + s.creditHours, 0),
        average: known.length ? known.reduce((n, g) => n + g.result.percent, 0) / known.length : null,
        coverage: known.length,
        friday: sections.filter(s => s.meetings.some(m => m.days.includes('F'))).length,
        gaps,
        gapMinutes: Object.values(gaps).reduce((a, b) => a + b, 0),
        buildingChanges,
        unknownLocations,
        conflicts: scheduleConflicts(sections.map(toSectionTimes)).length,
        unknownTimes: sections.filter(s => !toSectionTimes(s).complete).length,
    };
}

/** Bounded search, all selected course groups must be represented. No synthetic sections. */
export function generateSchedules(catalog: SectionRecord[], codes: string[], f: PlannerFilters, grades: Grades) {
    if (!f.semester || !codes.length || codes.length > 8) throw new Error('Select a semester and 1–8 courses.');
    const uniqueCodes = [...new Set(codes.map(normalizeCourseCode))];
    const groups = uniqueCodes.map(code =>
        catalog.filter(
            s =>
                normalizeCourseCode(s.courseCode) === code &&
                !!s.course &&
                toSectionTimes(s).complete &&
                s.status?.value !== 'CANCELLED' &&
                s.status?.value !== 'CLOSED' &&
                matchesFilters(s, { ...f, fits: false, noGaps: false, query: '', requirement: '' }, grades)
        )
    );
    groups.sort((a, b) => a.length - b.length);
    const score = (sections: SectionRecord[]) => {
        const m = metrics(sections, grades);
        return (
            (f.highGrades ? (m.average ?? 0) - (sections.length - m.coverage) * 20 : 0) +
            (f.preferAsync ? sections.filter(s => s.modality === 'async-online').length * 30 : 0) -
            (f.shortWalk ? m.buildingChanges * 10 + m.unknownLocations * 15 : 0)
        );
    };
    groups.forEach(g => {
        g.sort((a, b) => score([b]) - score([a]) || a.uniqueId - b.uniqueId);
    });
    let visited = 0;
    let truncated = false;
    const results: SectionRecord[][] = [];
    function visit(index: number, selected: SectionRecord[]) {
        if (++visited > 40000) {
            truncated = true;
            return;
        }
        if (index === groups.length) {
            if (!f.noGaps || metrics(selected, grades).gapMinutes === 0) {
                results.push(selected);
                results.sort((a, b) => score(b) - score(a));
                results.splice(6);
            }
            return;
        }
        for (const s of groups[index]!) {
            if (truncated) break;
            if (
                selected.some(a => a.uniqueId === s.uniqueId) ||
                detectConflicts(toSectionTimes(s), selected.map(toSectionTimes)).status !== 'clear'
            )
                continue;
            visit(index + 1, [...selected, s]);
        }
    }
    visit(0, []);
    return { results, truncated, visited };
}

/** Only explicit course-code AND/OR rules can be resolved; prose stays unverified. */
export function prerequisiteStatus(rule: string, audit: ParsedAudit | null) {
    const unknown = {
        status: 'Needs verification',
        reason: 'Add an explicit course-code rule from the catalog and import your audit. Other restrictions still need review.',
    };
    if (!rule.trim() || !audit) return unknown;
    const groups = rule
        .toUpperCase()
        .split(/\s+AND\s+|;/)
        .map(s => s.split(/\s+OR\s+|\//).map(s => s.trim()));
    if (groups.some(g => g.some(code => !/^[A-Z][A-Z ]{0,6}\s+\d{3}[A-Z]{0,2}$/.test(code)))) return unknown;
    let pending = false;
    for (const alternatives of groups) {
        const matches = audit.courses.filter(c =>
            alternatives.some(code => normalizeCourseCode(code) === normalizeCourseCode(c.code))
        );
        if (
            matches.some(c => c.status === 'completed' && !!c.grade.trim() && !/^(F|NC|Q|W|I|X)$/i.test(c.grade.trim()))
        )
            continue;
        if (matches.some(c => c.status === 'in-progress' || c.status === 'pending-transfer')) pending = true;
        else
            return {
                status: 'Needs verification',
                reason: `No confirmed credit for ${alternatives.join(' or ')}. Check equivalencies, minimum grades and restrictions.`,
            };
    }
    return pending
        ? {
              status: 'Possibly satisfied',
              reason: 'Depends on in-progress coursework or pending transfer credit. Not confirmed.',
          }
        : {
              status: 'Satisfied',
              reason: 'The listed course-code rule matches completed audit credit. Minimum grades, standing and department restrictions are not verified.',
          };
}
export interface RoadmapEntry {
    id: string;
    term: string;
    code: string;
    hours: number;
    kind: 'course' | 'transfer' | 'CLEP';
    rule: string;
}
export function roadmapProjection(entries: RoadmapEntry[], audit: ParsedAudit | null) {
    const completed = new Set(
        audit?.courses
            .filter(c => c.status === 'completed' && !!c.grade.trim() && !/^(F|NC|Q|W|I|X)$/i.test(c.grade.trim()))
            .map(c => normalizeCourseCode(c.code)) ?? []
    );
    const seen = new Set(completed);
    const terms = new Map<string, number>();
    const termOrder = (t: string) =>
        Number(t.split(' ')[1]) * 3 + ['Spring', 'Summer', 'Fall'].indexOf(t.split(' ')[0]!);
    for (const e of [...entries].sort((a, b) => termOrder(a.term) - termOrder(b.term))) {
        const code = normalizeCourseCode(e.code);
        if (seen.has(code) || !Number.isFinite(e.hours) || e.hours <= 0) continue;
        seen.add(code);
        terms.set(e.term, (terms.get(e.term) ?? 0) + e.hours);
    }
    return { terms, planned: [...terms.values()].reduce((a, b) => a + b, 0) };
}

/** Keep catalog prose intact if it is more complex than course-code rules; the checker will decline to guess. */
export function catalogPrerequisite(description?: string[]): string {
    const line = description?.find(s => /^prerequisites?\s*:/i.test(s.trim()));
    return (
        line
            ?.replace(/^prerequisites?\s*:\s*/i, '')
            .replace(/\.$/, '')
            .trim() ?? ''
    );
}
export function confirmedAuditHours(audit: ParsedAudit | null): number {
    const courses = new Map<string, number>();
    for (const c of audit?.courses ?? []) {
        if (
            c.status !== 'completed' ||
            !c.grade.trim() ||
            /^(F|NC|Q|W|I|X)$/i.test(c.grade.trim()) ||
            !Number.isFinite(c.hours)
        )
            continue;
        const key = normalizeCourseCode(c.code);
        courses.set(key, Math.max(courses.get(key) ?? 0, c.hours));
    }
    return [...courses.values()].reduce((a, b) => a + b, 0);
}
