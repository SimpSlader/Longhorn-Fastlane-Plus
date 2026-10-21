/**
 * Bridges UT Registration Plus types (Course, UserSchedule, grade database) to Fastlane's plain data.
 */
import type { Course } from '@shared/types/Course';
import type { Day } from '@shared/types/CourseMeeting';
import type { UserSchedule } from '@shared/types/UserSchedule';
import { NoDataError, queryAggregateDistribution } from '@views/lib/database/queryDistribution';

import type { GradeCounts, GradeStat, GradeThreshold } from '../core/grades';
import { buildGradeStat, computeThreshold } from '../core/grades';
import type { DayCode, Meeting, RawMeeting, SectionTimes } from '../core/meetings';
import { meetingsFromRaw } from '../core/meetings';
import type { Modality, ModalityResult } from '../core/modality';
import { classifyModality } from '../core/modality';
import { tagsForSection } from '../core/requirements';
import type { SectionRecord } from '../core/sections';
import { sectionLabel, toSectionTimes } from '../core/sections';
import type { GradeDatasetInfo } from '../data/activeGradeDataset';
import { getActiveGradeDataset } from '../data/activeGradeDataset';

const DAY_TO_CODE: Record<Day, DayCode> = {
    Monday: 'M',
    Tuesday: 'T',
    Wednesday: 'W',
    Thursday: 'TH',
    Friday: 'F',
    Saturday: 'S',
    Sunday: 'SU',
};

export function courseCode(course: Pick<Course, 'department' | 'number'>): string {
    return `${course.department} ${course.number}`.replace(/\s+/g, ' ').trim();
}

/** Visible meeting lines of a UT course-schedule row (one span per meeting line) */
export function rawMeetingsFromRow(row: Element): RawMeeting[] {
    const read = (sel: string) => [...row.querySelectorAll(sel)].map(n => (n.textContent ?? '').trim());
    const days = read('td[data-th="Days"] > span');
    const hours = read('td[data-th="Hour"] > span');
    const rooms = read('td[data-th="Room"] > span');
    const n = Math.max(days.length, hours.length, rooms.length);
    const lines: RawMeeting[] = [];
    for (let i = 0; i < n; i++)
        lines.push({ daysText: days[i] ?? '', hoursText: hours[i] ?? '', roomText: rooms[i] ?? '' });
    return lines;
}

export function instructionModeTextFromRow(row: Element): string {
    return (row.querySelector('td[data-th="Instruction Mode"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function analyzeRow(row: Element): { modality: ModalityResult; meetings: Meeting[]; complete: boolean } {
    const raw = rawMeetingsFromRow(row);
    const { meetings, complete } = meetingsFromRaw(raw);
    return {
        modality: classifyModality({ instructionModeText: instructionModeTextFromRow(row), meetings: raw }),
        meetings,
        complete,
    };
}

function meetingsFromCourse(course: Course): Meeting[] {
    return course.schedule.meetings
        .filter(m => m.days.length && m.endTime > m.startTime)
        .map(m => ({
            days: m.days.map(d => DAY_TO_CODE[d]).filter(Boolean),
            start: m.startTime,
            end: m.endTime,
            location: m.location ? `${m.location.building} ${m.location.room}`.trim() : undefined,
        }));
}

/** Best-effort modality for a stored course (raw listing text is not kept by UTRP). */
export function modalityFromCourse(course: Course, meetings: Meeting[]): Modality {
    if (course.instructionMode === 'Hybrid') return 'hybrid';
    if (course.instructionMode === 'Online') return meetings.length ? 'live-online' : 'async-online';
    return 'in-person';
}

export function sectionFromCourse(
    course: Course,
    fromRow?: { modality: ModalityResult; meetings: Meeting[]; complete: boolean }
): SectionRecord {
    const meetings = fromRow?.meetings ?? meetingsFromCourse(course);
    const modality = fromRow?.modality.modality ?? modalityFromCourse(course, meetings);
    const code = courseCode(course);
    return {
        uniqueId: course.uniqueId,
        courseCode: code,
        title: course.courseName,
        semester: course.semester,
        instructors: course.instructors
            .map(i => i.fullName ?? `${i.firstName ?? ''} ${i.lastName ?? ''}`.trim())
            .filter(Boolean),
        creditHours: course.creditHours,
        meetings,
        // a stored in-person course with no meeting times has unknown times
        scheduleComplete: fromRow ? fromRow.complete : meetings.length > 0 || modality === 'async-online',
        modality,
        core: course.core ?? [],
        flags: course.flags ?? [],
        isReserved: course.isReserved,
        status: course.status
            ? { value: course.status, observedAt: course.scrapedAt, source: 'UT course schedule page' }
            : undefined,
        url: course.url,
        requirementTags: tagsForSection({ courseCode: code, core: course.core, flags: course.flags }),
        course: JSON.parse(JSON.stringify(course)),
        capturedAt: course.scrapedAt ?? Date.now(),
    };
}

export function scheduleTimes(schedule: UserSchedule | undefined, exceptUniqueId?: number): SectionTimes[] {
    if (!schedule) return [];
    return schedule.courses.filter(c => c.uniqueId !== exceptUniqueId).map(c => toSectionTimes(sectionFromCourse(c)));
}

export function sectionTimesLabel(course: Course): string {
    return sectionLabel({ courseCode: courseCode(course), uniqueId: course.uniqueId });
}

// ---------- historical grades ----------

export type DatasetInfo = GradeDatasetInfo;

interface RawGradeLookup {
    counts: GradeCounts;
    semesters: string[];
    instructorSpecific: boolean;
}

const cache = new Map<string, Promise<RawGradeLookup | null>>();

function lookupKey(course: Course): string {
    return `${course.department}|${course.getNumberWithoutTerm?.() ?? course.number}|${course.instructors[0]?.lastName ?? ''}`;
}

/**
 * Raw counts for a course, cached once per (course, instructor) per page load.
 * Professor-specific data is used when it exists; otherwise the course-wide aggregate, clearly labeled.
 */
export function lookupGrades(course: Course): Promise<RawGradeLookup | null> {
    const key = lookupKey(course);
    let hit = cache.get(key);
    if (!hit) {
        hit = queryAggregateDistribution(course)
            .then(([distribution, semesters, instructorIncluded]) => ({
                counts: {
                    A: distribution.A,
                    'A-': distribution['A-'],
                    'B+': distribution['B+'],
                    B: distribution.B,
                    'B-': distribution['B-'],
                    'C+': distribution['C+'],
                    C: distribution.C,
                    'C-': distribution['C-'],
                    'D+': distribution['D+'],
                    D: distribution.D,
                    'D-': distribution['D-'],
                    F: distribution.F,
                    Other: distribution.Other,
                },
                semesters: semesters.map(s => `${s.season} ${s.year}`),
                instructorSpecific: instructorIncluded,
            }))
            .catch(err => {
                if (err instanceof NoDataError) return null;
                console.warn('[Fastlane] grade lookup failed', err);
                return null;
            });
        cache.set(key, hit);
    }
    return hit;
}

export function gradeStatFrom(
    course: Course,
    raw: RawGradeLookup | null,
    threshold: GradeThreshold,
    dataset: DatasetInfo = getActiveGradeDataset()
): GradeStat | null {
    if (!raw) return null;
    let result: ReturnType<typeof computeThreshold>;
    try {
        result = computeThreshold(raw.counts, threshold);
    } catch {
        return null;
    }
    if (!result) return null;
    const instructor = course.instructors[0];
    return buildGradeStat({
        scope: raw.instructorSpecific ? 'instructor' : 'course',
        instructor: raw.instructorSpecific ? (instructor?.fullName ?? instructor?.lastName) : undefined,
        courseCode: courseCode(course),
        result,
        semesters: raw.semesters,
        source: dataset.source,
        datasetVersion: dataset.version,
        datasetUpdated: dataset.updated,
    });
}
