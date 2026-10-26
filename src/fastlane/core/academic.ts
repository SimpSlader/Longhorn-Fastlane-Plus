/**
 * The student's academic facts, in one place and kept in separate categories: earned hours (graded or credit
 * by exam), hours in progress, planned hours, transfer and exam credit, degree hours the IDA applies, GPA as
 * the IDA states it, and anything the student told Fastlane themselves. Every number comes from the imported
 * IDA or the student's own words, and says which. Nothing here is estimated by AI.
 */
import { degreeTotals } from '../audit/progress';
import type { AuditCourse, ParsedAudit } from '../audit/types';
import { normalizeCourseCode } from './requirements';

/** Grades that earn no hours (failed, withdrawn, dropped, incomplete). */
const NO_CREDIT_GRADE = /^(?:F|W|Q|X|I|NC|U|WF|WP)$/i;

export interface CourseLine {
    code: string;
    name: string;
    hours: number;
    semester: string;
    grade: string;
    type: string;
}

export interface UserReported {
    completedHours?: { value: number; at: number };
}

export interface AcademicSummary {
    /** where the facts come from and when the IDA was imported */
    source: { kind: 'ida'; importedAt: number; fileName?: string } | null;
    /** earned hours: graded or credit-by-exam courses (no failing, withdrawn or in-progress courses) */
    completedHours: number;
    inProgressHours: number;
    plannedHours: number;
    examHours: number;
    transferHours: number;
    inResidenceCompletedHours: number;
    pendingTransferHours: number;
    current: CourseLine[];
    completed: CourseLine[];
    planned: CourseLine[];
    /** the IDA's own degree figures (they can include classes in progress) */
    degree: { required: number; applied: number; remaining: number } | null;
    residence: { done: number; required: number } | null;
    gpa: Array<{ label: string; value: number; minimum: number }>;
    /** "Total Hours Taken" printed by the IDA (it includes planned courses) */
    idaTotalHoursTaken: number | null;
    userReported: UserReported;
    /** differences between what the student said and the IDA, stated plainly */
    discrepancies: string[];
}

const isExam = (c: AuditCourse) => /exam|placement|\bcbe\b|\bap\b/i.test(c.type);
const isTransfer = (c: AuditCourse) => /transfer/i.test(c.type) || c.status === 'pending-transfer';

/** Real enrollments only: equivalent numbers UT lists under a course never add hours, and nothing counts twice. */
export function realCourses(audit: ParsedAudit): AuditCourse[] {
    const seen = new Set<string>();
    const out: AuditCourse[] = [];
    for (const c of audit.courses) {
        if (c.equivalent || c.excluded) continue;
        const key = `${normalizeCourseCode(c.code)}|${c.semester}|${c.unique}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}

const line = (c: AuditCourse): CourseLine => ({
    code: normalizeCourseCode(c.code),
    name: c.name,
    hours: c.hours,
    semester: c.semester,
    grade: c.grade,
    type: c.type,
});
const sum = (list: AuditCourse[]) => list.reduce((n, c) => n + (Number.isFinite(c.hours) ? c.hours : 0), 0);

export function academicSummary(audit: ParsedAudit | null, userReported: UserReported = {}): AcademicSummary {
    if (!audit) {
        return {
            source: null,
            completedHours: 0,
            inProgressHours: 0,
            plannedHours: 0,
            examHours: 0,
            transferHours: 0,
            inResidenceCompletedHours: 0,
            pendingTransferHours: 0,
            current: [],
            completed: [],
            planned: [],
            degree: null,
            residence: null,
            gpa: [],
            idaTotalHoursTaken: null,
            userReported,
            discrepancies: [],
        };
    }
    const courses = realCourses(audit);
    const earned = courses.filter(c => c.status === 'completed' && !NO_CREDIT_GRADE.test(c.grade.trim()));
    const current = courses.filter(c => c.status === 'in-progress');
    const planned = courses.filter(c => c.status === 'planned');
    const totals = degreeTotals(audit);
    const completedHours = sum(earned);
    const discrepancies: string[] = [];
    const reported = userReported.completedHours;
    if (reported && reported.value !== completedHours)
        discrepancies.push(
            `You told me you've completed ${reported.value} hours; your imported IDA shows ${completedHours}. If the IDA is out of date, import a new one on Degree progress.`
        );
    return {
        source: { kind: 'ida', importedAt: audit.parsedAt, ...(audit.fileName ? { fileName: audit.fileName } : {}) },
        completedHours,
        inProgressHours: sum(current),
        plannedHours: sum(planned),
        examHours: sum(earned.filter(isExam)),
        transferHours: sum(earned.filter(c => isTransfer(c) && !isExam(c))),
        inResidenceCompletedHours: sum(earned.filter(c => !isExam(c) && !isTransfer(c))),
        pendingTransferHours: sum(courses.filter(c => c.status === 'pending-transfer')),
        current: current.map(line),
        completed: earned.map(line),
        planned: planned.map(line),
        degree: totals.totalHours
            ? {
                  required: totals.totalHours.total,
                  applied: totals.totalHours.done,
                  remaining: totals.totalHours.remaining,
              }
            : null,
        residence: totals.residence ? { done: totals.residence.done, required: totals.residence.total } : null,
        gpa: totals.gpa,
        idaTotalHoursTaken: audit.hourTotals?.taken ?? null,
        userReported,
        discrepancies,
    };
}
