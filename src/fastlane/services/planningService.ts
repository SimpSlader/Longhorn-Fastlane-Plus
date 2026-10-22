import type { Serialized } from '@chrome-extension-toolkit';
import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import { Course } from '@shared/types/Course';
import { DAY_MAP } from '@shared/types/CourseMeeting';
import { UserSchedule } from '@shared/types/UserSchedule';
import { sectionFromCourse } from '../adapters/utrp';
import { DAY_ORDER } from '../core/meetings';
import type { PlanMeta } from '../core/plans';
import type { SectionRecord } from '../core/sections';
import { semesterKey } from '../core/sections';
import { FastlanePlanStore } from '../storage/stores';

const SHARE_FORMAT = 'fastlane-shared-schedule';
/** Explicit allowlist: never spread serialized course, queue, URL, audit or plan notes into a share. */
export function safeSection(s: SectionRecord): SectionRecord {
    return {
        uniqueId: s.uniqueId,
        courseCode: s.courseCode,
        title: s.title,
        semester: s.semester ? { year: s.semester.year, season: s.semester.season } : undefined,
        instructors: s.instructors.map(String),
        creditHours: s.creditHours,
        meetings: s.meetings.map(m => ({ days: [...m.days], start: m.start, end: m.end, location: m.location })),
        scheduleComplete: s.scheduleComplete,
        modality: s.modality,
        core: [],
        flags: [],
        isReserved: false,
        requirementTags: [],
        capturedAt: 0,
    };
}
export function shareSchedule(sections: SectionRecord[]) {
    return { format: SHARE_FORMAT, version: 1, sections: sections.map(safeSection) };
}
export function parseSharedSchedule(value: unknown): SectionRecord[] {
    const d = value as ReturnType<typeof shareSchedule>;
    if (
        !d ||
        d.format !== SHARE_FORMAT ||
        d.version !== 1 ||
        !Array.isArray(d.sections) ||
        !d.sections.length ||
        d.sections.length > 30
    )
        throw new Error('Choose a FastLane schedule-only file with 1–30 classes.');
    const ids = new Set<number>();
    let term = '';
    const text = (s: unknown, n: number) => typeof s === 'string' && s.length <= n;
    return d.sections.map(s => {
        if (
            !s ||
            !Number.isInteger(s.uniqueId) ||
            s.uniqueId < 1 ||
            s.uniqueId > 99999 ||
            ids.has(s.uniqueId) ||
            !text(s.courseCode, 30) ||
            !/^[A-Z][A-Z ]*\s+[FSNW]?\d{3}[A-Z]{0,2}$/i.test(s.courseCode) ||
            !text(s.title, 300) ||
            !Number.isFinite(s.creditHours) ||
            s.creditHours < 0 ||
            s.creditHours > 20 ||
            !s.semester ||
            !Number.isInteger(s.semester.year) ||
            s.semester.year < 2000 ||
            s.semester.year > 2200 ||
            !['Spring', 'Summer', 'Fall'].includes(s.semester.season) ||
            !['async-online', 'live-online', 'in-person', 'hybrid', 'unknown'].includes(s.modality) ||
            typeof s.scheduleComplete !== 'boolean' ||
            !Array.isArray(s.instructors) ||
            s.instructors.length > 20 ||
            s.instructors.some(i => !text(i, 150)) ||
            !Array.isArray(s.meetings) ||
            s.meetings.length > 30 ||
            s.meetings.some(
                m =>
                    !m ||
                    !Array.isArray(m.days) ||
                    !m.days.length ||
                    m.days.length > 7 ||
                    m.days.some(day => !DAY_ORDER.includes(day)) ||
                    !Number.isFinite(m.start) ||
                    !Number.isFinite(m.end) ||
                    m.start < 0 ||
                    m.end > 1440 ||
                    m.end <= m.start ||
                    (m.location !== undefined && !text(m.location, 120))
            )
        )
            throw new Error('Invalid section data. Nothing was imported.');
        const key = `${s.semester.season} ${s.semester.year}`;
        if (term && term !== key) throw new Error('A shared schedule must contain one semester.');
        term = key;
        ids.add(s.uniqueId);
        return safeSection(s);
    });
}
export function courseFromSection(s: SectionRecord): Course {
    if (s.course) return new Course(s.course as Serialized<Course>);
    if (!s.semester) throw new Error('This section has no semester.');
    const match = s.courseCode.match(/^(.*?)\s+(\S+)$/);
    if (!match) throw new Error('Invalid course code.');
    // Imported shares contain public schedule fields only. Never import a registration URL or status.
    return new Course({
        uniqueId: s.uniqueId,
        department: match[1]!,
        number: match[2]!,
        courseName: s.title,
        fullName: `${s.courseCode} ${s.title}`,
        creditHours: s.creditHours,
        instructors: s.instructors.map(fullName => ({
            fullName,
            // UT lists “LAST, FIRST”. Preserve that public surname for professor-specific grade lookups.
            lastName: fullName.includes(',') ? fullName.split(',')[0]!.trim() : undefined,
            firstName: fullName.includes(',') ? fullName.split(',').slice(1).join(',').trim() : undefined,
        })),
        semester: s.semester,
        schedule: {
            meetings: s.meetings.map(m => ({
                days: m.days.map(d => DAY_MAP[d]),
                startTime: m.start,
                endTime: m.end,
                location: m.location
                    ? { building: m.location.split(' ')[0]!, room: m.location.split(' ').slice(1).join(' ') }
                    : undefined,
            })),
        },
        isReserved: false,
        flags: [],
        core: [],
        instructionMode: s.modality.includes('online') ? 'Online' : s.modality === 'hybrid' ? 'Hybrid' : 'In Person',
        scrapedAt: 0,
        url: '',
    } as unknown as Serialized<Course>);
}
export async function createPlanningSchedule(name: string, sections: SectionRecord[], plan?: PlanMeta) {
    const courses = sections.map(courseFromSection);
    const schedule = new UserSchedule({
        id: crypto.randomUUID(),
        name: name.trim() || 'New schedule',
        courses: JSON.parse(JSON.stringify(courses)),
        hours: 0,
        updatedAt: Date.now(),
    });
    const all = await UserScheduleStore.get('schedules');
    await UserScheduleStore.set('schedules', [...all, JSON.parse(JSON.stringify(schedule))]);
    if (plan) {
        const plans = await FastlanePlanStore.get('plans');
        await FastlanePlanStore.set('plans', {
            ...plans,
            [schedule.id]: { ...plan, scheduleId: schedule.id, updatedAt: Date.now() },
        } as never);
    }
    return schedule.id;
}
export async function duplicateSchedule(schedule: UserSchedule) {
    const plans = await FastlanePlanStore.get('plans');
    const count = (await UserScheduleStore.get('schedules')).length;
    return createPlanningSchedule(
        `Schedule ${count + 1}`,
        schedule.courses.map(c => sectionFromCourse(c)),
        plans[schedule.id] as PlanMeta | undefined
    );
}
export async function addOrSwap(scheduleId: string, section: SectionRecord, oldUnique?: number) {
    const schedules = await UserScheduleStore.get('schedules');
    const updated = schedules.map(s => {
        if (s.id !== scheduleId) return s;
        if (s.courses.some(c => c.uniqueId !== oldUnique && semesterKey(c.semester) !== semesterKey(section.semester)))
            throw new Error('This section is from a different semester. Create a new schedule for that semester.');
        const courses = s.courses.filter(c => c.uniqueId !== oldUnique);
        if (courses.some(c => c.uniqueId === section.uniqueId))
            throw new Error('This section is already in the schedule.');
        courses.push(JSON.parse(JSON.stringify(courseFromSection(section))));
        return { ...s, courses, hours: courses.reduce((n, c) => n + c.creditHours, 0), updatedAt: Date.now() };
    });
    await UserScheduleStore.set('schedules', updated);
}
export function downloadFile(data: Blob, name: string) {
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Draw an explicitly public comparison, never capture the surrounding audit/registration DOM. */
export async function downloadComparisonImage(columns: Array<{ sections: SectionRecord[]; summary: string[] }>) {
    const canvas = document.createElement('canvas');
    canvas.width = 1500;
    canvas.height = 230 + Math.max(1, ...columns.map(c => c.sections.length)) * 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image export is unavailable in this browser.');
    ctx.fillStyle = '#fffaf5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#bf5700';
    ctx.font = 'bold 32px system-ui';
    ctx.fillText('FastLane · Schedule comparison', 40, 52);
    columns.forEach((column, i) => {
        const x = 40 + i * 740;
        ctx.fillStyle = '#151515';
        ctx.font = 'bold 24px system-ui';
        ctx.fillText(`Schedule ${i + 1}`, x, 100);
        ctx.font = '16px system-ui';
        column.summary.forEach((line, j) => {
            ctx.fillText(line, x, 132 + j * 25, 680);
        });
        column.sections.map(safeSection).forEach((s, j) => {
            const y = 225 + j * 96;
            ctx.fillStyle = '#bf5700';
            ctx.font = 'bold 18px system-ui';
            ctx.fillText(`${s.courseCode} · ${s.uniqueId} · ${s.creditHours} hours`, x, y, 680);
            ctx.fillStyle = '#222';
            ctx.font = '16px system-ui';
            ctx.fillText(s.title, x, y + 24, 680);
            ctx.fillText(
                s.meetings
                    .map(
                        m =>
                            `${m.days.join('/')} ${Math.floor(m.start / 60)}:${String(m.start % 60).padStart(2, '0')}–${Math.floor(m.end / 60)}:${String(m.end % 60).padStart(2, '0')} ${m.location ?? ''}`
                    )
                    .join(' · ') || s.modality,
                x,
                y + 48,
                680
            );
        });
    });
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create image.');
    downloadFile(blob, 'FastLane-comparison.png');
}
