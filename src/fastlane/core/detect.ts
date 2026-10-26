/**
 * OPTIONAL, conservative reading of result messages that UT already displays after the student
 * submits a registration request themselves. Disabled by default.
 *
 * It never triggers anything: a match only produces a SUGGESTION that the student confirms with
 * one click. Messages are classified in memory and never stored or transmitted.
 */
import type { Outcome } from './queue';

export type DetectedKind = Extract<Outcome, 'success' | 'full' | 'conflict' | 'restriction'>;

const NEGATED_ADD = /\b(?:not|wasn'?t|didn'?t|unable to|failed to|cannot|can'?t)\b.{0,25}\badd/i;

export function classifyMessage(text: string): DetectedKind | null {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 600) return null;
    if (
        /(?:filled to (?:the )?closing limit|no seats (?:are )?available|closed to registration|reached (?:its )?capacity|\b(?:class|section|course)(?:\s+(?:unique\s+)?\d{5})?\s+is\s+(?:now\s+)?(?:filled|full|closed)\b)/i.test(
            t
        )
    ) {
        return 'full';
    }
    if (/\btime conflict\b|conflicts? with (?:a |another )?class/i.test(t)) return 'conflict';
    if (
        /(?:restricted to|reserved for|prerequisite|not (?:eligible|permitted)|registration (?:bar|hold)|hold (?:on|preventing)|exceeds? the (?:maximum|registration) (?:hours|limit)|duplicate class|invalid unique|consent required)/i.test(
            t
        )
    ) {
        return 'restriction';
    }
    if (
        /\b(?:you (?:have )?added|successfully added|has been added|was added|added to your (?:schedule|classes))\b/i.test(
            t
        ) &&
        !NEGATED_ADD.test(t)
    ) {
        return 'success';
    }
    return null;
}

export interface DetectionContext {
    /** the five-digit unique number the student copied */
    uniqueId: number;
    /** messages present before the student acted; these are ignored */
    baseline: Set<string>;
}

/**
 * Picks at most one suggestion from visible message texts.
 * A message must be new since the copy, and if it names a five-digit unique number it must name ours.
 */
export function suggestOutcome(texts: string[], ctx: DetectionContext): { kind: DetectedKind; message: string } | null {
    const target = String(ctx.uniqueId).padStart(5, '0');
    for (const raw of texts) {
        const text = raw.replace(/\s+/g, ' ').trim();
        if (!text || ctx.baseline.has(text.toLowerCase())) continue;
        const kind = classifyMessage(text);
        if (!kind) continue;
        const uniques = [...text.matchAll(/\b\d{5}\b/g)].map(m => m[0]);
        if (uniques.length > 0 && !uniques.includes(target)) continue;
        return { kind, message: text.slice(0, 240) };
    }
    return null;
}
