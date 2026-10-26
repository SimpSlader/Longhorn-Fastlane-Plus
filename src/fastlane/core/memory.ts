/**
 * Fastlane's memory: short preferences the student asks it to keep ("remember I want to graduate early").
 * They are stored only in this browser and applied to every chat; the student can see and delete each one.
 */

export const MEMORY_LIMIT = 12;
export const MEMORY_ITEM_LENGTH = 160;

export type MemoryCommand = { add: string } | { forget: string } | { forgetAll: true } | null;

/** "remember (that) …", "from now on …", "always …", "forget …", "forget everything". */
export function memoryCommand(message: string): MemoryCommand {
    const t = message.trim().replace(/\s+/g, ' ');
    if (
        /^(?:please )?(?:forget|clear|erase) (?:everything|all(?: of it| memories| my preferences)?|your memory|my memory)\b/i.test(
            t
        )
    )
        return { forgetAll: true };
    const forget = t.match(/^(?:please )?forget (?:that |about )?(.{2,})$/i);
    if (forget) return { forget: tidy(forget[1] ?? '') };
    const add = t.match(
        /^(?:please )?(?:remember|keep in mind|note|save|memori[sz]e)(?: (?:that|this))?[:,]? (.{3,})$|^(?:from now on|always)[:,]? (.{3,})$/i
    );
    if (add) return { add: tidy(add[1] ?? add[2] ?? '') };
    return null;
}

function tidy(text: string): string {
    const clean = text.trim().replace(/[.!\s]+$/, '');
    return (clean.charAt(0).toUpperCase() + clean.slice(1)).slice(0, MEMORY_ITEM_LENGTH);
}

/** Adds an item (no near-duplicates, newest last, at most MEMORY_LIMIT). */
export function addMemory(items: string[], item: string): string[] {
    const key = (s: string) =>
        s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    if (!key(item)) return items;
    const kept = items.filter(i => key(i) !== key(item));
    return [...kept, item].slice(-MEMORY_LIMIT);
}

/** Removes items that mention every word of `what` ("forget McCombs" removes the McCombs item). */
export function forgetMemory(items: string[], what: string): string[] {
    const words = what
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 2 && !['the', 'that', 'about', 'want', 'my'].includes(w));
    if (!words.length) return items;
    return items.filter(i => !words.every(w => i.toLowerCase().includes(w)));
}

/** True when saved memory says the student is aiming for McCombs. */
export const wantsMcCombs = (texts: string[]) => texts.some(t => /mccombs|\bbba\b|business school/i.test(t));
