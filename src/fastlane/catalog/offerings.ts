/**
 * Turns the Registrar's course-offerings document into Fastlane's shared course inventory.
 *
 * Each listed section becomes a real UT Registration Plus `Course` (so UTRP's grade database, calendar and
 * schedules work with it unchanged) plus a Fastlane `SectionRecord` marked `source: "ut-offerings"`.
 * Listings carry no seat status: availability is only ever shown from UT pages the student viewed.
 * The document is read locally in this browser; nothing is uploaded.
 */
import type { Day } from '@shared/types/CourseMeeting';

import { DAY_NAMES } from '../core/meetings';
import type { Modality } from '../core/modality';
import { tagsForSection } from '../core/requirements';
import type { OfferingListing, SectionRecord } from '../core/sections';
import { OFFERINGS_COURSE_MARK } from '../core/sections';
import type { OfferingsMeta } from '../data/sectionStore';
import type { OfferingSection, OfferingsParse, PdfTextItem } from './offeringsPdf';
import { creditHoursFor, parseOfferingsItems } from './offeringsPdf';

export const MAX_OFFERINGS_BYTES = 40 * 1024 * 1024;

export function registrarPrintUrl(termCode: string): string {
    return `https://registrar.utexas.edu/schedules/${termCode}/print`;
}

export function utSectionUrl(termCode: string, uniqueId: number): string {
    return `https://utdirect.utexas.edu/apps/registrar/course_schedule/${termCode}/${String(uniqueId).padStart(5, '0')}/`;
}

export function offeringModality(section: Pick<OfferingSection, 'webBased' | 'meetings'>): Modality {
    if (section.webBased === 'partial') return 'hybrid';
    if (section.webBased === 'full') return section.meetings.length ? 'live-online' : 'async-online';
    return section.meetings.length ? 'in-person' : 'unknown';
}

function instructorParts(name: string) {
    const [lastName = '', rest = ''] = name.split(',').map(s => s.trim());
    const [firstName, middleInitial] = rest.split(' ');
    return { fullName: name, lastName, firstName, middleInitial };
}

/** Serialized UTRP Course for one listed section (no status: the listing does not say whether seats are open). */
export function offeringToCourse(
    section: OfferingSection,
    term: NonNullable<OfferingsParse['term']>,
    importedAt: number
): Record<string, unknown> {
    const modality = offeringModality(section);
    const title = section.topic ?? section.courseTitle;
    return {
        uniqueId: section.uniqueId,
        number: section.number,
        fullName: `${section.courseCode} ${title}`,
        courseName: title,
        department: section.subject,
        creditHours: creditHoursFor(section.number),
        instructors: section.instructors.map(instructorParts),
        isReserved: false,
        description: section.description ? [section.description] : [],
        schedule: {
            meetings: section.meetings.map(m => {
                const [building = '', room = ''] = (m.location ?? '').split(' ');
                return {
                    days: m.days.map(d => DAY_NAMES[d] as Day),
                    startTime: m.start,
                    endTime: m.end,
                    ...(building ? { location: { building, room } } : {}),
                };
            }),
        },
        url: utSectionUrl(term.code, section.uniqueId),
        flags: [],
        core: [],
        instructionMode: modality === 'hybrid' ? 'Hybrid' : modality.endsWith('online') ? 'Online' : 'In Person',
        semester: { year: term.year, season: term.season, code: term.code },
        scrapedAt: importedAt,
        [OFFERINGS_COURSE_MARK]: 'ut-offerings',
    };
}

export function offeringToSection(
    section: OfferingSection,
    term: NonNullable<OfferingsParse['term']>,
    listing: OfferingListing,
    known?: { core: string[]; flags: string[] }
): SectionRecord {
    const modality = offeringModality(section);
    const core = known?.core ?? [];
    const flags = known?.flags ?? [];
    return {
        uniqueId: section.uniqueId,
        source: 'ut-offerings',
        listing,
        ...(section.prerequisites ? { prerequisites: section.prerequisites } : {}),
        courseCode: section.courseCode,
        title: section.topic ?? section.courseTitle,
        semester: { year: term.year, season: term.season, code: term.code },
        instructors: section.instructors,
        creditHours: creditHoursFor(section.number),
        meetings: section.meetings,
        scheduleComplete: section.meetings.length > 0 || modality === 'async-online',
        modality,
        core,
        flags,
        isReserved: false,
        url: utSectionUrl(term.code, section.uniqueId),
        requirementTags: tagsForSection({ courseCode: section.courseCode, core, flags }),
        course: offeringToCourse(section, term, listing.importedAt),
        capturedAt: listing.importedAt,
    };
}

export interface BuiltInventory {
    records: SectionRecord[];
    meta: OfferingsMeta;
}

/**
 * Builds inventory records from a parse. `known` supplies core/flag listings already confirmed on UT pages
 * for the same course code (the offerings document does not print them).
 */
export function buildInventory(
    parse: OfferingsParse,
    document: { name: string; sha256: string },
    importedAt: number,
    known: Map<string, { core: string[]; flags: string[] }> = new Map()
): BuiltInventory {
    const term = parse.term;
    if (!term) throw new Error('This file does not look like a UT course-offerings document (no semester found).');
    if (parse.sections.length === 0)
        throw new Error('No sections were found. Choose the "PDF of courses offered" from the Registrar.');
    const label = `${term.season} ${term.year}`;
    const listing: OfferingListing = {
        term: label,
        asOf: parse.asOf,
        sourceUrl: registrarPrintUrl(term.code),
        document: document.name,
        sha256: document.sha256,
        importedAt,
    };
    const records = parse.sections.map(s => offeringToSection(s, term, listing, known.get(s.courseCode)));
    return {
        records,
        meta: {
            term: label,
            termCode: term.code,
            asOf: parse.asOf,
            sourceUrl: listing.sourceUrl,
            document: document.name,
            sha256: document.sha256,
            importedAt,
            sections: records.length,
            courses: new Set(records.map(r => r.courseCode)).size,
            subjects: new Set(parse.sections.map(s => s.subject)).size,
            subjectNames: parse.subjects,
            issues: parse.issues.slice(0, 50),
        },
    };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Reads positioned text from the PDF with the bundled PDF.js (no network, no eval). */
export async function readPdfItems(buffer: ArrayBuffer, onPage?: (page: number, total: number) => void) {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer.slice(0)),
        isEvalSupported: false,
        disableFontFace: true,
    }).promise;
    const items: PdfTextItem[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        for (const item of content.items as Array<{ str: string; transform: number[] }>) {
            if (item.str.trim())
                items.push({ page: p, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, str: item.str });
        }
        onPage?.(p, doc.numPages);
    }
    await doc.destroy();
    return items;
}

export async function readOfferingsFile(
    file: File,
    onPage?: (page: number, total: number) => void
): Promise<{ parse: OfferingsParse; sha256: string }> {
    if (file.size > MAX_OFFERINGS_BYTES) throw new Error('That file is larger than 40 MB.');
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name)))
        throw new Error('Choose the course-offerings PDF downloaded from the UT Registrar.');
    const buffer = await file.arrayBuffer();
    const [items, sha256] = await Promise.all([readPdfItems(buffer, onPage), sha256Hex(buffer)]);
    return { parse: parseOfferingsItems(items), sha256 };
}
