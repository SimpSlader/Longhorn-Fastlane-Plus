import { detectConflicts } from './meetings';
import { normalizeCourseCode } from './requirements';
import { type SectionRecord, toSectionTimes } from './sections';

/** Only verified non-overlapping meeting times are allowed in an AI draft schedule. */
export function safeAiScheduleDraft(
    recommendedIds: number[],
    sections: SectionRecord[],
    maxHours = 16,
    avoidFriday = false
): SectionRecord[] {
    const lookup = new Map(sections.map(s => [s.uniqueId, s]));
    const selected: SectionRecord[] = [];
    const seen = new Set<string>();
    let hours = 0;
    for (const id of recommendedIds) {
        const s = lookup.get(id);
        if (!s || !s.course || s.status?.value === 'CANCELLED') continue;
        if (avoidFriday && s.meetings.some(m => m.days.includes('F'))) continue;
        const code = normalizeCourseCode(s.courseCode);
        if (seen.has(code) || hours + s.creditHours > maxHours || s.creditHours <= 0) continue;
        if (
            selected.length &&
            selected[0] &&
            s.semester &&
            (selected[0].semester?.year !== s.semester.year || selected[0].semester?.season !== s.semester.season)
        )
            continue;
        const check = detectConflicts(toSectionTimes(s), selected.map(toSectionTimes));
        if (check.status !== 'clear') continue;
        selected.push(s);
        seen.add(code);
        hours += s.creditHours;
    }
    return selected;
}
