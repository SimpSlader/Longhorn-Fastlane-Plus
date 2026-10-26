/**
 * Optional registration autofill (OFF by default).
 *
 * Autofill only places a unique number into UT's "add" input. It never clicks, submits, presses
 * Enter, or sends any request: the student always submits each registration request themselves.
 */

export interface AutofillSettings {
    enabled: boolean;
    paused: boolean;
    /** never replace something the student typed */
    preserveNonEmpty: boolean;
}

export const DEFAULT_AUTOFILL: AutofillSettings = { enabled: false, paused: false, preserveNonEmpty: true };

export type AutofillDecision =
    | { action: 'fill'; code: string }
    | { action: 'skip'; reason: 'disabled' | 'paused' | 'no-code' | 'no-field' | 'already-filled' | 'non-empty' };

export interface AutofillInput {
    settings: AutofillSettings;
    /** the five-digit code to place, or null when nothing is queued */
    code: string | null;
    /** current value of the detected field; null when no field was found */
    fieldValue: string | null;
    /** the last value Fastlane itself put in the field (so we may replace our own fill) */
    lastFilled: string | null;
    /** true for an explicit "Fill next code" click: bypasses enabled/paused, never the non-empty guard */
    manual?: boolean;
}

export function decideAutofill({
    settings,
    code,
    fieldValue,
    lastFilled,
    manual = false,
}: AutofillInput): AutofillDecision {
    if (!manual && !settings.enabled) return { action: 'skip', reason: 'disabled' };
    if (!manual && settings.paused) return { action: 'skip', reason: 'paused' };
    if (!code || !/^\d{5}$/.test(code)) return { action: 'skip', reason: 'no-code' };
    if (fieldValue === null) return { action: 'skip', reason: 'no-field' };
    const current = fieldValue.trim();
    if (current === code) return { action: 'skip', reason: 'already-filled' };
    if (settings.preserveNonEmpty && current !== '' && current !== (lastFilled ?? '')) {
        return { action: 'skip', reason: 'non-empty' };
    }
    return { action: 'fill', code };
}

export const AUTOFILL_SKIP_MESSAGES: Record<Extract<AutofillDecision, { action: 'skip' }>['reason'], string> = {
    disabled: 'Autofill is off (Settings → Registration autofill).',
    paused: 'Autofill is paused.',
    'no-code': 'No code queued. Choose a recommendation first.',
    'no-field': 'Could not find UT’s unique-number field on this page. Copy the code instead.',
    'already-filled': 'The field already contains this code.',
    'non-empty': 'The field already has a number you typed, so it was left alone.',
};

interface Candidate {
    el: HTMLInputElement;
    score: number;
}

function labelText(input: HTMLInputElement, doc: Document): string {
    const parts: string[] = [];
    if (input.id) {
        const label = doc.querySelector(`label[for="${input.id.replace(/["\\]/g, '\\$&')}"]`);
        if (label) parts.push(label.textContent ?? '');
    }
    const wrapping = input.closest('label');
    if (wrapping) parts.push(wrapping.textContent ?? '');
    const cell = input.closest('td, th, div, p');
    const prev = cell?.previousElementSibling;
    if (prev) parts.push(prev.textContent ?? '');
    parts.push(input.getAttribute('aria-label') ?? '', input.getAttribute('placeholder') ?? '', input.title);
    return parts.join(' ').toLowerCase();
}

/**
 * Finds the input where a unique number to ADD is typed. Drop/swap fields, hidden fields and
 * password fields are never chosen. Returns null when nothing is clearly an add field.
 */
export function findUniqueAddInput(doc: Document, exclude?: Node | null): HTMLInputElement | null {
    const candidates: Candidate[] = [];
    for (const el of doc.querySelectorAll<HTMLInputElement>('input')) {
        if (exclude?.contains(el)) continue;
        const type = (el.getAttribute('type') ?? 'text').toLowerCase();
        if (!['text', 'number', 'tel', 'search', ''].includes(type)) continue;
        if (el.disabled || el.readOnly) continue;
        const ident = `${el.name} ${el.id}`.toLowerCase();
        const label = labelText(el, doc);
        const all = `${ident} ${label}`;
        if (/drop|swap|delete|remove|password|search_?term|eid/.test(all)) continue;
        let score = 0;
        if (/unique/.test(all)) score += 3;
        if (/\badd\b|_add|add_|addunique/.test(all)) score += 3;
        if (el.maxLength === 5) score += 2;
        if (el.inputMode === 'numeric' || type === 'number' || type === 'tel') score += 1;
        if (score >= 4) candidates.push({ el, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return null; // ambiguous: do nothing
    return candidates[0]?.el ?? null;
}

/**
 * Sets the field value the way a paste would, firing input/change so the page sees it.
 * Deliberately does not focus-and-submit, press Enter, or touch any button.
 */
export function fillInput(input: HTMLInputElement, code: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, code);
    else input.value = code;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}
