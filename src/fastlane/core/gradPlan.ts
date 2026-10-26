/**
 * The facts behind "how do I graduate early?": hours left, how many may come from ACC, semester-by-semester
 * scenarios, and (when the student plans to apply) where they stand on McCombs internal transfer. Everything
 * is computed in the browser from the imported IDA; the AI only explains these numbers.
 */
import type { ParsedAudit } from '../audit/types';
import mccombs from '../data/mccombs-internal-transfer.json';
import { academicSummary, realCourses } from './academic';
import { accRoom } from './acc';
import { normalizeCourseCode } from './requirements';

export interface GradScenario {
    /** UT hours each long semester */
    utPerSemester: number;
    /** hours taken at ACC in total (summers or alongside) */
    accHours: number;
    /** long semesters at UT still needed */
    longSemesters: number;
}

export interface GradFacts {
    program: string | null;
    hoursRequired: number | null;
    hoursApplied: number | null;
    /** earned hours (graded or credit by exam), never including classes in progress */
    hoursCompleted: number;
    hoursRemaining: number | null;
    /** in-progress UT hours this semester (already counted by UT once graded) */
    inProgressHours: number;
    residenceRemaining: number | null;
    /** most hours that may still come from outside UT */
    accRoomHours: number | null;
    scenarios: GradScenario[];
    mccombs: McCombsStatus | null;
}

export interface McCombsStatus {
    rules: typeof mccombs;
    /** UT long semesters (fall/spring) seen on the IDA, including the current one */
    utLongSemesters: number;
    prerequisites: Array<{ name: string; status: 'done at UT' | 'in progress at UT' | 'transfer credit' | 'not yet' }>;
}

const isTransfer = (type: string, status: string) => /transfer/i.test(type) || status === 'pending-transfer';

/** Where the student stands on each McCombs prerequisite and the four-long-semester window. */
export function mccombsStatus(audit: ParsedAudit): McCombsStatus {
    const courses = audit.courses.map(c => ({ ...c, code: normalizeCourseCode(c.code) }));
    const transfer = new Set(
        [...audit.transfer.accepted, ...audit.transfer.pending].map(c => normalizeCourseCode(c.code))
    );
    const prerequisites = mccombs.prerequisites.map(p => {
        const matches = courses.filter(c => p.codes.includes(c.code));
        const ut = matches.filter(c => !isTransfer(c.type, c.status) && !transfer.has(c.code));
        const status: McCombsStatus['prerequisites'][number]['status'] = ut.some(c => c.status === 'completed')
            ? 'done at UT'
            : ut.some(c => c.status === 'in-progress')
              ? 'in progress at UT'
              : matches.length || p.codes.some(code => transfer.has(code))
                ? 'transfer credit'
                : 'not yet';
        return { name: p.name, status };
    });
    const longSemesters = new Set(
        realCourses(audit)
            .filter(c => !isTransfer(c.type, c.status) && !/exam/i.test(c.type))
            .filter(c => c.status === 'completed' || c.status === 'in-progress')
            .map(c => c.semester.trim().toLowerCase())
            .filter(s => /fall|spring/.test(s))
    );
    return { rules: mccombs, utLongSemesters: longSemesters.size, prerequisites };
}

/** Semester scenarios for finishing the remaining hours with more UT hours and/or ACC hours. */
export function gradScenarios(remaining: number, accRoomHours: number): GradScenario[] {
    const out: GradScenario[] = [];
    const accOptions = [...new Set([0, Math.min(accRoomHours, 6), Math.min(accRoomHours, 12)])].filter(
        h => h <= remaining
    );
    for (const utPerSemester of [15, 18])
        for (const accHours of accOptions)
            out.push({
                utPerSemester,
                accHours,
                longSemesters: Math.ceil(Math.max(0, remaining - accHours) / utPerSemester),
            });
    return out;
}

export function gradFacts(audit: ParsedAudit, opts: { mccombs: boolean }): GradFacts {
    const room = accRoom(audit);
    const summary = academicSummary(audit);
    const inProgressHours = summary.inProgressHours;
    // the IDA's "applied" figure may already include this semester's classes; only subtract them when it doesn't
    const appliedIncludesCurrent =
        summary.degree != null && summary.degree.applied >= summary.completedHours + inProgressHours - 1;
    const remaining =
        room.remaining == null ? null : Math.max(0, room.remaining - (appliedIncludesCurrent ? 0 : inProgressHours));
    const accRoomHours = room.room == null ? null : Math.min(room.room, remaining ?? room.room);
    return {
        program: audit.program ?? null,
        hoursRequired: audit.creditHours.required ?? summary.degree?.required ?? null,
        hoursApplied: audit.creditHours.applied ?? summary.degree?.applied ?? null,
        hoursCompleted: summary.completedHours,
        hoursRemaining: remaining,
        inProgressHours,
        residenceRemaining: room.residenceRemaining,
        accRoomHours,
        scenarios: remaining == null ? [] : gradScenarios(remaining, accRoomHours ?? 0),
        mccombs: opts.mccombs ? mccombsStatus(audit) : null,
    };
}

/** True when a message asks for degree-level advice rather than a semester schedule. */
export function isAdviceQuestion(message: string): boolean {
    const t = message.toLowerCase();
    const advice =
        /\bgraduat|\bgrad early\b|\bfinish (?:my degree|early|faster|in \d)|\bmccombs\b|\binternal(?:ly)? transfer|\bdegree (?:plan|audit|progress)\b|\bon track\b|\bhow many (?:classes|courses|credits|hours|semesters)\b|\bsemesters? (?:left|do i)\b|\bwhat should i (?:take|do)\b|\bhow (?:much|many) .*\bacc\b|\bfour[- ]year plan\b|\broadmap\b|\bwhich (?:ut )?classes (?:would|should|will|can)\b/.test(
            t
        );
    const schedule =
        /\b(?:build|make|create|give me|find)\b.*\b(?:schedule|week|semester plan)\b|\b(?:mon|tue|wed|thu|fri)(?:day)?s?\b|\bonline class|\bback[- ]to[- ]back\b|\bremove\b|\bdrop\b|\breplace\b/.test(
            t
        );
    return advice && !schedule;
}
