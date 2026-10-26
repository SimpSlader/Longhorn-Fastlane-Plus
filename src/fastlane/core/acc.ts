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
}): { suggestions: AccSuggestion[]; room: AccRoom; residency: ProgramResidency | null; blocked: string[] } {
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
    const seen = new Set<string>();
    const out: AccSuggestion[] = [];
    for (const r of audit.requirements) {
        if (r.status === 'completed') continue;
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
            out.push({
                tccn: codes.join(' or '),
                ut,
                hours: tccnHours(codes[0]!),
                requirement: r.text.length > 90 ? `${r.text.slice(0, 87)}…` : r.text,
                utARate: grade?.percent ?? null,
                utSample: grade?.sample ?? 0,
                cautions: cautions.filter(Boolean),
            });
        }
    }
    // hardest at UT first; unknown difficulty after known
    out.sort((a, b) => (a.utARate ?? 101) - (b.utARate ?? 101));
    const picked: AccSuggestion[] = [];
    let hours = 0;
    for (const s of out) {
        if (picked.length >= (input.limit ?? 3)) break;
        if (room.room != null && hours + s.hours > room.room) continue;
        picked.push(s);
        hours += s.hours;
    }
    return { suggestions: picked, room, residency: residencyRule, blocked };
}
