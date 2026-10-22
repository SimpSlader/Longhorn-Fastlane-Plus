/**
 * The one local course inventory every feature reads (Browse classes, recommendations, AI, schedule builder).
 *
 * It holds two kinds of records, keyed by term code + unique number:
 *  - sections the student saw on UT's course schedule ("ut-page": confirmed details, observed status)
 *  - sections listed in the Registrar's course-offerings document ("ut-offerings")
 * A confirmed record is never replaced by an offerings listing; the listing's provenance and printed
 * prerequisites are attached to it instead. Everything stays in this browser profile (IndexedDB).
 */
import type { SectionRecord } from '../core/sections';
import { isConfirmedSection, semesterKey } from '../core/sections';
import { idbDeleteMany, idbGet, idbGetAll, idbPut, idbPutMany, STORES } from './idb';

export interface StoredSection extends SectionRecord {
    key: string;
    semesterLabel: string;
}

/** Per-term summary of an imported offerings document (meta store, key "offerings:<code>"). */
export interface OfferingsMeta {
    term: string;
    termCode: string;
    asOf: string | null;
    sourceUrl: string;
    document: string;
    sha256: string;
    importedAt: number;
    sections: number;
    courses: number;
    subjects: number;
    /** subjects that have no sections listed */
    subjectNames: Record<string, string>;
    issues: string[];
}

export function sectionKey(s: Pick<SectionRecord, 'semester' | 'uniqueId'>): string {
    return `${s.semester?.code ?? semesterKey(s.semester)}:${s.uniqueId}`;
}

function stored(s: SectionRecord): StoredSection {
    return { ...s, key: sectionKey(s), semesterLabel: semesterKey(s.semester) };
}

export async function readSections(semester?: string | null): Promise<SectionRecord[]> {
    const all = await idbGetAll<StoredSection>(STORES.sections);
    return semester ? all.filter(s => s.semesterLabel === semester) : all;
}

/** Saves sections seen on UT's course schedule, keeping any offerings provenance already attached. */
export async function putObservedSections(sections: SectionRecord[]): Promise<number> {
    const rows = sections.filter(s => Number.isInteger(s.uniqueId) && typeof s.courseCode === 'string').map(stored);
    const merged = await Promise.all(
        rows.map(async row => {
            const existing = await idbGet<StoredSection>(STORES.sections, row.key);
            return {
                ...row,
                source: 'ut-page' as const,
                listing: row.listing ?? existing?.listing,
                prerequisites: row.prerequisites ?? existing?.prerequisites,
            };
        })
    );
    await idbPutMany(STORES.sections, merged);
    return merged.length;
}

/**
 * Replaces one term's offerings listings. Confirmed (UT page) records keep their details and gain the
 * listing provenance; listings that disappeared from a newer document are removed (confirmed records stay).
 */
export async function replaceTermOfferings(
    termCode: string,
    offerings: SectionRecord[],
    meta: OfferingsMeta
): Promise<{ added: number; confirmedKept: number; removed: number }> {
    const all = await idbGetAll<StoredSection>(STORES.sections);
    const existing = new Map(all.filter(s => s.key.startsWith(`${termCode}:`)).map(s => [s.key, s]));
    const next: StoredSection[] = [];
    let confirmedKept = 0;
    for (const offering of offerings.map(stored)) {
        const current = existing.get(offering.key);
        existing.delete(offering.key);
        if (current && isConfirmedSection(current)) {
            confirmedKept++;
            next.push({ ...current, listing: offering.listing, prerequisites: offering.prerequisites });
        } else {
            next.push(offering);
        }
    }
    const stale = [...existing.values()].filter(s => !isConfirmedSection(s)).map(s => s.key);
    await idbPutMany(STORES.sections, next);
    await idbDeleteMany(STORES.sections, stale);
    await idbPut(STORES.meta, meta, `offerings:${termCode}`);
    return { added: next.length - confirmedKept, confirmedKept, removed: stale.length };
}

export async function readOfferingsMeta(): Promise<OfferingsMeta[]> {
    const db = await idbGetAll<OfferingsMeta | Record<string, unknown>>(STORES.meta);
    return db.filter((m): m is OfferingsMeta => typeof m === 'object' && m !== null && 'termCode' in m);
}
