/**
 * Proposed AI schedules and how a follow-up message refines them. Everything here is local and pure:
 * which proposed class a message is about, what kind of change it asks for, which classes stay, and
 * what a replacement must satisfy. Only real, listed sections ever enter a proposal.
 */
import type { DayCode } from './meetings';
import { detectConflicts } from './meetings';
import { normalizeCourseCode } from './requirements';
import { type SectionRecord, toSectionTimes } from './sections';

export interface ProposalVersion {
    id: number;
    sections: SectionRecord[];
    /** what changed and why, in plain words */
    note: string;
    added: number[];
    removed: number[];
}

export interface RefineIntent {
    /** "I don't need this requirement anymore": drop the class and stop matching its requirement */
    dropRequirement: boolean;
    /** "I'll take it through ACC": drop the class and leave the course out (never counted as UT credit) */
    elsewhere: boolean;
    /** "remove this", "I don't want it" with no replacement wish */
    removeOnly: boolean;
    earlier: boolean;
    later: boolean;
    easier: boolean;
    online: boolean;
    inPerson: boolean;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');

/** The proposed section a message refers to: an explicit focus, a course code, a unique number, or a title word. */
export function resolveTarget(
    message: string,
    sections: SectionRecord[],
    focusId?: number | null
): SectionRecord | null {
    if (focusId != null) return sections.find(s => s.uniqueId === focusId) ?? null;
    const upper = ` ${message.toUpperCase().replace(/\s+/g, ' ')} `;
    const squeezed = upper.replace(/\s+/g, '');
    for (const s of sections) {
        const code = normalizeCourseCode(s.courseCode);
        if (upper.includes(` ${code} `) || upper.includes(` ${code}.`) || upper.includes(` ${code},`)) return s;
        if (squeezed.includes(code.replace(/\s+/g, ''))) return s;
        if (new RegExp(`\\b0*${s.uniqueId}\\b`).test(message)) return s;
    }
    // a distinctive title word (5+ letters) that names exactly one proposed class
    const text = ` ${words(message)} `;
    const byWord = sections.filter(s =>
        words(s.title)
            .split(' ')
            .some(w => w.length >= 5 && text.includes(` ${w} `))
    );
    return byWord.length === 1 ? byWord[0]! : null;
}

export function refineIntent(message: string): RefineIntent {
    const t = message.toLowerCase();
    const dropRequirement =
        /(?:don'?t|do not|no longer) need (?:this|that|the)?\s*(?:degree )?(?:requirement|req)|requirement (?:is )?(?:already )?(?:done|satisfied|covered)|already (?:have|satisfied|covered) (?:this|that|the) requirement/.test(
            t
        );
    const elsewhere =
        /\b(?:through|at|via) (?:acc|austin community college|a community college|another (?:school|college))\b/.test(
            t
        );
    const wantsReplacement = /\breplace|swap|instead|different|another|something|rather|switch|change\b/.test(t);
    const removeOnly =
        !wantsReplacement && /\b(?:remove|drop|delete|take out|get rid of|don'?t want)\b/.test(t) && !dropRequirement;
    return {
        dropRequirement,
        elsewhere,
        removeOnly,
        earlier: /\btoo late\b|\bearlier\b|\bmorning\b|\bbefore (?:noon|lunch)\b/.test(t),
        later: /\btoo early\b|\blater\b|\bafternoon\b|\bsleep in\b/.test(t),
        easier: /\beasier\b|\beasy\b|\btoo hard\b|\bless work\b|\bbetter grades?\b|\bhigher grades?\b|\bgpa\b/.test(t),
        online:
            /\bonline\b|\basync|\bremote\b|\bfrom home\b/.test(t) &&
            !/\bno online|\bnot online|\bin[- ]person\b/.test(t),
        inPerson: /\bin[- ]person\b|\bno online\b|\bnot online\b/.test(t),
    };
}

/** True when a message is about changing one class rather than the whole plan. */
export function isTargetedChange(intent: RefineIntent): boolean {
    return Object.values(intent).some(Boolean);
}

const firstStart = (s: SectionRecord) => Math.min(...s.meetings.map(m => m.start));
const lastEnd = (s: SectionRecord) => Math.max(...s.meetings.map(m => m.end));
export const isOnline = (s: SectionRecord) => s.modality === 'async-online' || s.modality === 'live-online';

/** What a replacement for `target` must satisfy, given the student's reason. */
export function replacementFits(
    candidate: SectionRecord,
    target: SectionRecord,
    intent: RefineIntent,
    gradeOf: (s: SectionRecord) => number | null
): boolean {
    if (normalizeCourseCode(candidate.courseCode) === normalizeCourseCode(target.courseCode) && intent.elsewhere)
        return false;
    if (intent.online && !isOnline(candidate)) return false;
    if (intent.inPerson && isOnline(candidate)) return false;
    const timed = candidate.meetings.length > 0 && target.meetings.length > 0;
    // "too late": the replacement must finish earlier in the day; async classes have no time and always fit
    if (intent.earlier && candidate.modality !== 'async-online') {
        if (!timed || lastEnd(candidate) >= lastEnd(target)) return false;
    }
    if (intent.later && candidate.modality !== 'async-online') {
        if (!timed || firstStart(candidate) <= firstStart(target)) return false;
    }
    if (intent.easier) {
        const mine = gradeOf(target);
        const theirs = gradeOf(candidate);
        if (theirs == null || (mine != null && theirs <= mine)) return false;
    }
    return true;
}

/** Classes that break the conversation's hard preferences (for whole-plan follow-ups such as "no Fridays"). */
export function breaksPreferences(
    s: SectionRecord,
    prefs: { avoidDays: DayCode[]; timeOfDay: string; leftOut: Set<string>; noOnline: boolean }
): boolean {
    if (prefs.leftOut.has(normalizeCourseCode(s.courseCode))) return true;
    if (prefs.noOnline && s.modality === 'async-online') return true;
    if (prefs.avoidDays.some(d => s.meetings.some(m => m.days.includes(d)))) return true;
    if (prefs.timeOfDay !== 'any' && s.modality !== 'async-online' && s.meetings.length) {
        if (prefs.timeOfDay === 'morning' && s.meetings.some(m => m.start >= 12 * 60)) return true;
        if (prefs.timeOfDay === 'afternoon' && s.meetings.some(m => m.start < 12 * 60 || m.end > 17 * 60)) return true;
        if (prefs.timeOfDay === 'evening' && s.meetings.some(m => m.start < 17 * 60)) return true;
    }
    return false;
}

/** Whether `s` can join `kept` without a time conflict or a second section of the same course. */
export function fitsWith(s: SectionRecord, kept: SectionRecord[]): boolean {
    const code = normalizeCourseCode(s.courseCode);
    if (kept.some(k => k.uniqueId === s.uniqueId || normalizeCourseCode(k.courseCode) === code)) return false;
    return detectConflicts(toSectionTimes(s), kept.map(toSectionTimes)).status === 'clear';
}

/** Fills up to `slots` places from AI-ranked ids, keeping every kept class and never creating a conflict. */
export function fillSlots(
    kept: SectionRecord[],
    rankedIds: number[],
    lookup: Map<number, SectionRecord>,
    slots: number
): SectionRecord[] {
    const out = [...kept];
    let filled = 0;
    for (const id of rankedIds) {
        if (filled >= slots) break;
        const s = lookup.get(id);
        if (!s || !s.course || s.status?.value === 'CANCELLED' || !fitsWith(s, out)) continue;
        out.push(s);
        filled++;
    }
    return out;
}

export function diffSections(before: SectionRecord[], after: SectionRecord[]): { added: number[]; removed: number[] } {
    const was = new Set(before.map(s => s.uniqueId));
    const now = new Set(after.map(s => s.uniqueId));
    return {
        added: after.filter(s => !was.has(s.uniqueId)).map(s => s.uniqueId),
        removed: before.filter(s => !now.has(s.uniqueId)).map(s => s.uniqueId),
    };
}

export const totalHours = (sections: SectionRecord[]) => sections.reduce((n, s) => n + s.creditHours, 0);
