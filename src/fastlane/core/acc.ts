/**
 * Austin Community College (ACC) planning, from UT Austin's own Texas Common Course Numbering (TCCN) table.
 *
 * - Only courses the student's IDA says are still needed are suggested, and only when UT lists a TCCN
 *   equivalent (so the ACC course number is real and official).
 * - Courses UT requires "in residence" are never suggested: the program's published residency rules and any
 *   IDA rule that names a course and says "in residence".
 * - The number of hours that may come from outside UT is limited by the IDA's own residence and total-hour
 *   rules. Nothing here marks ACC credit as earned; credit counts only after UT evaluates a transcript.
 */

import { degreeTotals } from '../audit/progress';
import type { ParsedAudit } from '../audit/types';
import residency from '../data/residency-rules.json';
import tccn from '../data/tccn-equivalents.json';
import { normalizeCourseCode } from './requirements';

export const TCCN_SOURCE = tccn.source;
export const TCCN_DATED = tccn.dated;
export const TCCN_NOTES = tccn.notes;

export interface ProgramResidency {
    label: string;
    mustTakeAtUT: string[];
    majorSubject: string;
    majorHoursInResidence: number;
    note: string;
    sources: string[];
}

/** UT course → TCCN course numbers that transfer as exactly that course. */
const byUt = new Map<string, string[]>();
for (const p of tccn.pairs) {
    const ut = normalizeCourseCode(p.ut);
    // combined credit ("BIO 311C + 106M") and topic-specific entries are not one-to-one; leave them out
    if (/[+(]/.test(p.ut)) continue;
    byUt.set(ut, [...(byUt.get(ut) ?? []), p.tccn]);
}

const utByTccn = new Map<string, string>();
for (const p of tccn.pairs)
    if (!/[+(]/.test(p.ut) && !utByTccn.has(p.tccn)) utByTccn.set(p.tccn, normalizeCourseCode(p.ut));

/**
 * Standard Texas core-curriculum courses by UT core area. Under Texas's core-transfer rule, a course a community
 * college counts in a core component area also counts for that area at UT. Only courses with a UT equivalent in
 * UT's TCCN table are listed; areas that need a UT-only flag (e.g. writing-intensive) or the signature course are
 * left out.
 */
const CORE_AREAS: Record<string, { label: string; courses: string[] }> = {
    '020': { label: 'Mathematics', courses: ['MATH 1314', 'MATH 1324', 'MATH 1332', 'MATH 1342', 'MATH 2413'] },
    '030': {
        label: 'Science & technology',
        courses: [
            'BIOL 1306',
            'BIOL 1307',
            'BIOL 1308',
            'BIOL 1309',
            'CHEM 1311',
            'CHEM 1312',
            'PHYS 1301',
            'PHYS 1302',
            'PHYS 1303',
            'GEOL 1301',
        ],
    },
    '040': {
        label: 'Humanities',
        courses: [
            'PHIL 1301',
            'PHIL 2306',
            'ENGL 2322',
            'ENGL 2323',
            'ENGL 2327',
            'ENGL 2328',
            'ENGL 2332',
            'ENGL 2333',
        ],
    },
    '050': {
        label: 'Visual & performing arts',
        courses: ['ARTS 1301', 'ARTS 1303', 'ARTS 1304', 'MUSI 1306', 'MUSI 1310', 'DRAM 1310'],
    },
    '060': { label: 'U.S. history', courses: ['HIST 1301', 'HIST 1302'] },
    '070': { label: 'American & Texas government', courses: ['GOVT 2305', 'GOVT 2306'] },
    '080': {
        label: 'Social & behavioral sciences',
        courses: ['ECON 2301', 'ECON 2302', 'PSYC 2301', 'SOCI 1301', 'ANTH 2351', 'GEOG 1302'],
    },
};
export const CORE_TRANSFER_NOTE =
    'Counts toward that UT core area when ACC lists the course in the same core area (Texas core-transfer rule). Check ACC’s core list and UT’s transfer tools before enrolling.';

function hoursOf(p?: { value: number; unit: string }): number | null {
    return p && p.unit === 'hours' ? p.value : null;
}

export function tccnFor(utCode: string): string[] {
    return byUt.get(normalizeCourseCode(utCode)) ?? [];
}

/** Hours from a TCCN number: the second digit is the semester credit hours ("ECON 2301" → 3). */
export const tccnHours = (code: string) => Number(code.match(/\d(\d)\d\d$/)?.[1] ?? 3);

export function programResidency(audit: ParsedAudit | null): ProgramResidency | null {
    const program = `${audit?.program ?? ''} ${
        audit?.requirements
            .slice(0, 40)
            .map(r => r.text)
            .join(' ') ?? ''
    }`;
    for (const rule of Object.values(residency)) if (new RegExp(rule.matches, 'i').test(program)) return rule;
    return null;
}

/** Courses the IDA itself says must be taken in residence ("… ECO 420K … must be taken in residence"). */
export function idaResidencyCourses(audit: ParsedAudit | null): string[] {
    const out = new Set<string>();
    for (const r of audit?.requirements ?? []) {
        if (!/\bin residence\b/i.test(r.text)) continue;
        for (const m of r.text.matchAll(/\b([A-Z](?: ?[A-Z]){0,2}) (\d{3}[A-Z]{0,2})\b/g)) out.add(`${m[1]} ${m[2]}`);
    }
    return [...out];
}

export interface AccRoom {
    /** degree hours still needed */
    remaining: number | null;
    /** in-residence hours still needed */
    residenceRemaining: number | null;
    /** most hours that may still come from outside UT without missing a residence rule */
    room: number | null;
}

export function accRoom(audit: ParsedAudit | null): AccRoom {
    if (!audit) return { remaining: null, residenceRemaining: null, room: null };
    const totals = degreeTotals(audit);
    const remaining = totals.totalHours?.remaining ?? null;
    const residenceRemaining = totals.residence ? Math.max(0, totals.residence.total - totals.residence.done) : null;
    const room = remaining == null ? null : Math.max(0, remaining - (residenceRemaining ?? 0));
    return { remaining, residenceRemaining, room };
}

export interface AccSuggestion {
    tccn: string;
    ut: string;
    hours: number;
    /** IDA requirement it would count toward once transferred */
    requirement: string;
    /** UT's historical A/A− rate for the equivalent (lower = harder at UT) */
    utARate: number | null;
    utSample: number;
    cautions: string[];
}

/**
 * Courses worth taking at ACC: still needed per the IDA, with an official TCCN equivalent, not required in
 * residence, not already planned at UT. Hardest at UT (lowest historical A rate) first, within the hours the
 * residence rules leave.
 */
export function accSuggestions(input: {
    audit: ParsedAudit;
    /** UT courses already in the proposed schedule */
    planned: string[];
    gradeOf: (utCode: string) => { percent: number; sample: number } | null;
    limit?: number;
}): {
    suggestions: AccSuggestion[];
    room: AccRoom;
    residency: ProgramResidency | null;
    blocked: string[];
    notes: string[];
} {
    const { audit } = input;
    const residencyRule = programResidency(audit);
    const atUT = new Set(
        [...(residencyRule?.mustTakeAtUT ?? []), ...idaResidencyCourses(audit)].map(normalizeCourseCode)
    );
    const done = new Set(
        // done, in progress, or already sent to UT as transfer credit: nothing more to suggest
        audit.courses.filter(c => c.status !== 'planned').map(c => normalizeCourseCode(c.code))
    );
    const planned = new Set(input.planned.map(normalizeCourseCode));
    const room = accRoom(audit);
    const blocked: string[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();
    const out: AccSuggestion[] = [];
    for (const r of audit.requirements) {
        if (r.status === 'completed') continue;
        // a requirement that lists alternatives ("one of the following") needs only one of them: offer the hardest
        const options: AccSuggestion[] = [];
        for (const tag of r.tags) {
            const m = tag.match(/^COURSE (.+)$/i);
            if (!m) continue;
            const ut = normalizeCourseCode(m[1]!);
            if (seen.has(ut) || done.has(ut) || planned.has(ut)) continue;
            seen.add(ut);
            const codes = tccnFor(ut);
            if (!codes.length) continue;
            if (atUT.has(ut)) {
                blocked.push(ut);
                continue;
            }
            const grade = input.gradeOf(ut);
            const cautions: string[] = [];
            if (residencyRule && ut.startsWith(`${residencyRule.majorSubject} `))
                cautions.push(
                    `ACC hours don't count toward the ${residencyRule.majorHoursInResidence} ${residencyRule.majorSubject} hours your major requires at UT.`
                );
            if (/^GOV /.test(ut)) cautions.push(TCCN_NOTES[2] ?? '');
            options.push({
                tccn: codes.join(' or '),
                ut,
                hours: tccnHours(codes[0]!),
                requirement: r.text.length > 90 ? `${r.text.slice(0, 87)}…` : r.text,
                utARate: grade?.percent ?? null,
                utSample: grade?.sample ?? 0,
                cautions: cautions.filter(Boolean),
            });
        }
        options.sort((a, b) => (a.utARate ?? 101) - (b.utARate ?? 101));
        if (options[0]) out.push(options[0]);
    }
    // Core areas the IDA still needs, filled with standard Texas core courses that transfer to that area
    for (const r of audit.requirements) {
        if (r.status === 'completed') continue;
        if (/writing|flag|signature/i.test(r.text)) continue; // UT-only flags can't come from ACC
        const area = r.tags.map(t => t.match(/^CORE 0?(\d{2,3})$/i)?.[1]).find(Boolean);
        const code = area ? area.padStart(3, '0') : '';
        const def = CORE_AREAS[code];
        if (!def) continue;
        const remaining =
            hoursOf(r.remaining) ?? Math.max(0, (hoursOf(r.required) ?? 3) - (hoursOf(r.applied) ?? 0)) ?? 3;
        if (remaining <= 0) continue;
        const has = (ut: string) => done.has(ut) || r.courses.map(normalizeCourseCode).includes(ut);
        if (code === '070') {
            // UT: GOVT 2305 + 2306 together fulfill core 070; either one combines with GOV 310L, but not with
            // GOV 312L or 312P. Community colleges have no equivalent of GOV 310L, 312L or 312P.
            const taken = [...done, ...r.courses.map(normalizeCourseCode)];
            if (taken.some(c => c === 'GOV 312L' || c === 'GOV 312P')) {
                notes.push(
                    'Core 070 government: ACC’s GOVT courses don’t combine with GOV 312L or 312P (UT’s transfer table), so finish it at UT with GOV 310L.'
                );
                continue;
            }
        }
        let hoursLeft = remaining;
        const options = def.courses
            .map(t => ({ t, ut: utByTccn.get(t) }))
            .filter(
                (x): x is { t: string; ut: string } => !!x.ut && !has(x.ut) && !planned.has(x.ut) && !atUT.has(x.ut)
            )
            .filter(x => !seen.has(x.ut))
            .sort((a, b) => (input.gradeOf(a.ut)?.percent ?? 101) - (input.gradeOf(b.ut)?.percent ?? 101));
        for (const x of options) {
            if (hoursLeft <= 0) break;
            seen.add(x.ut);
            const grade = input.gradeOf(x.ut);
            out.push({
                tccn: x.t,
                ut: x.ut,
                hours: tccnHours(x.t),
                requirement: `Core ${code} ${def.label}`,
                utARate: grade?.percent ?? null,
                utSample: grade?.sample ?? 0,
                cautions: [code === '070' ? (TCCN_NOTES[2] ?? '') : CORE_TRANSFER_NOTE].filter(Boolean),
            });
            hoursLeft -= tccnHours(x.t);
        }
    }

    // hardest at UT first; unknown difficulty after known
    out.sort((a, b) => (a.utARate ?? 101) - (b.utARate ?? 101));
    const picked: AccSuggestion[] = [];
    let hours = 0;
    for (const s of out) {
        if (picked.length >= (input.limit ?? 4)) break;
        if (room.room != null && hours + s.hours > room.room) continue;
        picked.push(s);
        hours += s.hours;
    }
    return { suggestions: picked, room, residency: residencyRule, blocked, notes };
}

/** Every UT course an ACC suggestion could map to for this IDA (so their UT grades can be looked up first). */
export function accCandidateUtCodes(audit: ParsedAudit): string[] {
    const out = new Set<string>();
    for (const r of audit.requirements) {
        if (r.status === 'completed') continue;
        for (const t of r.tags) {
            const course = t.match(/^COURSE (.+)$/i)?.[1];
            if (course && tccnFor(course).length) out.add(normalizeCourseCode(course));
            const area = t.match(/^CORE 0?(\d{2,3})$/i)?.[1];
            const def = area ? CORE_AREAS[area.padStart(3, '0')] : undefined;
            for (const c of def?.courses ?? []) {
                const ut = utByTccn.get(c);
                if (ut) out.add(ut);
            }
        }
    }
    return [...out];
}
