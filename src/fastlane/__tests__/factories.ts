import { meetingsFromRaw } from '../core/meetings';
import type { Modality } from '../core/modality';
import { tagsForSection } from '../core/requirements';
import type { SectionRecord } from '../core/sections';

export function sectionFixture(
    uniqueId: number,
    courseCode: string,
    opts: {
        title?: string;
        times?: Array<[string, string, string?]>;
        modality?: Modality;
        core?: string[];
        instructors?: string[];
        creditHours?: number;
        semester?: SectionRecord['semester'];
        status?: SectionRecord['status'];
        isReserved?: boolean;
        complete?: boolean;
    } = {}
): SectionRecord {
    const { meetings, complete } = meetingsFromRaw(
        (opts.times ?? []).map(([d, h, r]) => ({ daysText: d, hoursText: h, roomText: r ?? '' }))
    );
    const core = opts.core ?? [];
    return {
        uniqueId,
        courseCode,
        title: opts.title ?? courseCode,
        semester: opts.semester ?? { year: 2027, season: 'Spring', code: '20272' },
        instructors: opts.instructors ?? ['Smith, Jane'],
        creditHours: opts.creditHours ?? 3,
        meetings,
        scheduleComplete: opts.complete ?? complete,
        modality: opts.modality ?? (meetings.length ? 'in-person' : 'async-online'),
        core,
        flags: [],
        isReserved: opts.isReserved ?? false,
        status: opts.status,
        requirementTags: tagsForSection({ courseCode, core }),
        capturedAt: 0,
    };
}
