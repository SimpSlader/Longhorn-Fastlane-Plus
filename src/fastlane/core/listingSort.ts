/**
 * Sorting and filtering for UT's course-listing table. Works on UT's own row order: a course header row
 * followed by its section rows. Sections are reordered only within their course, and courses as a whole,
 * so a section never ends up under another course's header. "UT order" with no filters restores the page
 * exactly. Missing data never counts as a high score: sections without it go last or are filtered out.
 */
import type { Modality } from './modality';

export type ListingSort = 'ut' | 'grade' | 'rating';

export interface ListingControls {
    sort: ListingSort;
    /** minimum historical % of A− or better; 0 = no filter */
    minGrade: number;
    modes: { async: boolean; live: boolean; inPerson: boolean };
    hideConflicts: boolean;
    idaFirst: boolean;
    /** optional: in the A/A− sort, sections with fewer than 30 historical grades go after well-sampled ones */
    smallSamplesLast: boolean;
}

export const DEFAULT_LISTING_CONTROLS: ListingControls = {
    sort: 'ut',
    minGrade: 0,
    modes: { async: true, live: true, inPerson: true },
    hideConflicts: false,
    idaFirst: false,
    smallSamplesLast: false,
};

export function isDefaultListing(c: ListingControls): boolean {
    return (
        c.sort === 'ut' &&
        c.minGrade === 0 &&
        c.modes.async &&
        c.modes.live &&
        c.modes.inPerson &&
        !c.hideConflicts &&
        !c.idaFirst
    );
}

export interface RowFacts {
    modality: Modality;
    conflict: boolean;
    idaMatch: boolean;
    /** % A− or better; undefined = not loaded yet, null = no data */
    grade?: number | null;
    /** fewer than 30 letter grades behind `grade` */
    smallSample?: boolean;
    rating?: { value: number; count: number } | null;
}

export interface ListingRow<T> {
    el: T;
    /** null for course header (and any other non-section) rows */
    uniqueId: number | null;
}

function modeAllowed(m: Modality, modes: ListingControls['modes']): boolean {
    if (m === 'async-online') return modes.async;
    if (m === 'live-online') return modes.live;
    return modes.inPerson; // in person, hybrid and unknown
}

export function passesFilters(f: RowFacts | undefined, c: ListingControls): boolean {
    if (!f) return isDefaultListing(c);
    if (!modeAllowed(f.modality, c.modes)) return false;
    if (c.hideConflicts && f.conflict) return false;
    if (c.minGrade > 0 && (f.grade == null || f.grade < c.minGrade)) return false;
    return true;
}

/** Sort key: lower sorts first. Missing values sort after every real value. */
function key(f: RowFacts | undefined, c: ListingControls): number[] {
    const ida = c.idaFirst ? (f?.idaMatch ? 0 : 1) : 0;
    if (c.sort === 'grade')
        return [ida, f?.grade == null ? 1 : 0, c.smallSamplesLast && f?.smallSample ? 1 : 0, -(f?.grade ?? 0)];
    if (c.sort === 'rating')
        return [ida, f?.rating == null ? 1 : 0, -(f?.rating?.value ?? 0), -(f?.rating?.count ?? 0)];
    return [ida];
}

function compare(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d) return d;
    }
    return 0;
}

/**
 * New row order and the rows to hide. Duplicate sections (the same unique number listed twice, e.g. after
 * auto-loading an overlapping page) keep only their first row while sorting or filtering is on.
 */
export function planListing<T>(
    rows: ListingRow<T>[],
    facts: Map<number, RowFacts>,
    controls: ListingControls
): { order: T[]; hidden: Set<T>; shown: number; total: number } {
    const plain = isDefaultListing(controls);
    const groups: Array<{ header: T | null; sections: ListingRow<T>[]; index: number }> = [];
    for (const row of rows) {
        if (row.uniqueId === null || !groups.length) {
            groups.push({ header: row.uniqueId === null ? row.el : null, sections: [], index: groups.length });
            if (row.uniqueId === null) continue;
        }
        groups.at(-1)!.sections.push(row);
    }
    const hidden = new Set<T>();
    const seen = new Set<number>();
    let shown = 0;
    let total = 0;
    const planned = groups.map(g => {
        const visible: Array<ListingRow<T> & { k: number[] }> = [];
        const rest: T[] = [];
        for (const row of g.sections) {
            const id = row.uniqueId!;
            const duplicate = seen.has(id);
            seen.add(id);
            if (!duplicate) total++;
            if (!plain && (duplicate || !passesFilters(facts.get(id), controls))) {
                hidden.add(row.el);
                rest.push(row.el);
            } else {
                visible.push({ ...row, k: key(facts.get(id), controls) });
                if (!duplicate) shown++;
            }
        }
        if (!plain && controls.sort !== 'ut') visible.sort((a, b) => compare(a.k, b.k));
        else if (!plain && controls.idaFirst) visible.sort((a, b) => compare(a.k, b.k));
        if (g.header !== null && !visible.length && g.sections.length) hidden.add(g.header);
        return { g, visible, rest, best: visible[0]?.k ?? [Number.POSITIVE_INFINITY] };
    });
    if (!plain && (controls.sort !== 'ut' || controls.idaFirst))
        planned.sort((a, b) => compare(a.best, b.best) || a.g.index - b.g.index);
    const order: T[] = [];
    for (const p of planned) {
        if (p.g.header !== null) order.push(p.g.header);
        for (const v of p.visible) order.push(v.el);
        order.push(...p.rest);
    }
    return { order, hidden, shown, total };
}
