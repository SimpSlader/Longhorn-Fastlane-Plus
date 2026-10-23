import { describe, expect, it } from 'vitest';

import type { ListingControls, ListingRow, RowFacts } from '../core/listingSort';
import { DEFAULT_LISTING_CONTROLS, planListing } from '../core/listingSort';

// UT's layout: a course header row, then its sections
const rows: ListingRow<string>[] = [
    { el: 'H-MUS', uniqueId: null },
    { el: 'mus-1', uniqueId: 1 },
    { el: 'mus-2', uniqueId: 2 },
    { el: 'H-HIS', uniqueId: null },
    { el: 'his-3', uniqueId: 3 },
    { el: 'his-4', uniqueId: 4 },
    { el: 'H-AST', uniqueId: null },
    { el: 'ast-5', uniqueId: 5 },
    { el: 'ast-5-again', uniqueId: 5 },
];
const facts = new Map<number, RowFacts>([
    [1, { modality: 'async-online', conflict: false, idaMatch: false, grade: 70, rating: { value: 4, count: 10 } }],
    [2, { modality: 'live-online', conflict: true, idaMatch: false, grade: 95, rating: null }],
    [3, { modality: 'in-person', conflict: false, idaMatch: true, grade: null, rating: { value: 4.8, count: 3 } }],
    [4, { modality: 'in-person', conflict: false, idaMatch: false, grade: 80, rating: { value: 2, count: 40 } }],
    [5, { modality: 'hybrid', conflict: false, idaMatch: false, grade: 88, rating: { value: 3.5, count: 8 } }],
]);
const c = (over: Partial<ListingControls>): ListingControls => ({ ...DEFAULT_LISTING_CONTROLS, ...over });

describe('UT listing sort and filter', () => {
    it('UT order with no filters changes nothing, duplicates included', () => {
        const plan = planListing(rows, facts, DEFAULT_LISTING_CONTROLS);
        expect(plan.order).toEqual(rows.map(r => r.el));
        expect(plan.hidden.size).toBe(0);
    });

    it('sorts by A/A− rate within each course and courses by their best section, keeping headers', () => {
        const plan = planListing(rows, facts, c({ sort: 'grade' }));
        expect(plan.order.filter(e => !e.endsWith('again'))).toEqual([
            'H-MUS',
            'mus-2',
            'mus-1',
            'H-AST',
            'ast-5',
            'H-HIS',
            'his-4',
            'his-3', // no grade data goes last, never treated as high
        ]);
        expect(plan.hidden.has('ast-5-again')).toBe(true);
    });

    it('sorts by professor rating with unrated sections last', () => {
        const plan = planListing(rows, facts, c({ sort: 'rating' }));
        expect(plan.order.slice(0, 3)).toEqual(['H-HIS', 'his-3', 'his-4']);
        expect(plan.order.indexOf('mus-2')).toBeGreaterThan(plan.order.indexOf('mus-1'));
    });

    it('filters by minimum A− rate (missing data does not pass) and hides empty courses', () => {
        const plan = planListing(rows, facts, c({ minGrade: 85 }));
        expect([...plan.hidden].sort()).toEqual(['H-HIS', 'ast-5-again', 'his-3', 'his-4', 'mus-1'].sort());
        expect(plan.shown).toBe(2);
        expect(plan.total).toBe(5);
    });

    it('filters by modality and conflicts', () => {
        const onlyInPerson = planListing(rows, facts, c({ modes: { async: false, live: false, inPerson: true } }));
        expect(onlyInPerson.hidden.has('H-MUS')).toBe(true);
        expect(onlyInPerson.hidden.has('ast-5')).toBe(false); // hybrid counts with in person
        const noConflicts = planListing(rows, facts, c({ hideConflicts: true }));
        expect(noConflicts.hidden.has('mus-2')).toBe(true);
        expect(noConflicts.hidden.has('mus-1')).toBe(false);
    });

    it('puts IDA matches first when asked', () => {
        const plan = planListing(rows, facts, c({ idaFirst: true }));
        expect(plan.order.slice(0, 2)).toEqual(['H-HIS', 'his-3']);
    });

    it('ranks small samples lower only when the student turns that on', () => {
        const small = new Map(facts);
        small.set(2, { ...facts.get(2)!, smallSample: true }); // 95% from a handful of grades
        const off = planListing(rows, small, c({ sort: 'grade' }));
        expect(off.order.indexOf('mus-2')).toBeLessThan(off.order.indexOf('mus-1'));
        const on = planListing(rows, small, c({ sort: 'grade', smallSamplesLast: true }));
        expect(on.order.indexOf('mus-1')).toBeLessThan(on.order.indexOf('mus-2'));
    });
});
