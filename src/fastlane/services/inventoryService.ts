/**
 * Course inventory operations used by the Fastlane page: importing the Registrar's offerings document and
 * confirming one listed section on UT (the student's own session, one request, like UTRP's quick add).
 */
import { getCourseByURL } from '@pages/background/lib/getCourseByURL';

import { sectionFromCourse } from '../adapters/utrp';
import { buildInventory, readOfferingsFile } from '../catalog/offerings';
import type { SectionRecord } from '../core/sections';
import { isConfirmedSection } from '../core/sections';
import type { OfferingsMeta } from '../data/sectionStore';
import { putObservedSections, readOfferingsMeta, readSections, replaceTermOfferings } from '../data/sectionStore';

export interface ImportSummary {
    meta: OfferingsMeta;
    added: number;
    confirmedKept: number;
    removed: number;
}

export async function importOfferingsFile(
    file: File,
    onPage?: (page: number, total: number) => void
): Promise<ImportSummary> {
    const { parse, sha256 } = await readOfferingsFile(file, onPage);
    // core/flag tags the student already saw on UT pages for the same course (the document omits them)
    const known = new Map<string, { core: string[]; flags: string[] }>();
    for (const s of await readSections()) {
        if (isConfirmedSection(s) && (s.core.length || s.flags.length) && !known.has(s.courseCode))
            known.set(s.courseCode, { core: s.core, flags: s.flags });
    }
    const { records, meta } = buildInventory(parse, { name: file.name, sha256 }, Date.now(), known);
    const result = await replaceTermOfferings(meta.termCode, records, meta);
    return { meta, ...result };
}

export function loadOfferingsMeta(): Promise<OfferingsMeta[]> {
    return readOfferingsMeta().catch(() => []);
}

/**
 * Looks the section up on UT's course schedule with the student's own sign-in and stores the confirmed
 * details and seat status. Returns null when UT did not return the section (e.g. not signed in).
 */
export async function confirmSectionOnUt(section: SectionRecord): Promise<SectionRecord | null> {
    if (!section.url) return null;
    const course = await getCourseByURL(section.url).catch(() => undefined);
    if (!course || course.uniqueId !== section.uniqueId) return null;
    const confirmed = sectionFromCourse(course);
    await putObservedSections([confirmed]);
    return { ...confirmed, source: 'ut-page', listing: section.listing, prerequisites: section.prerequisites };
}
