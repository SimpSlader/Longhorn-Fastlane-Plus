/**
 * Gathers local inputs (cached sections, active schedule, audit, queue, plans) and runs the pure
 * recommendation engine. Works offline: everything comes from this browser.
 */
import type { Serialized } from '@chrome-extension-toolkit';
import { Course } from '@shared/types/Course';
import type { UserSchedule } from '@shared/types/UserSchedule';

import { gradeStatFrom, lookupGrades, scheduleTimes } from '../adapters/utrp';
import { takenCourseCodes } from '../audit/parseAudit';
import type { ParsedAudit } from '../audit/types';
import type { GradeStat } from '../core/grades';
import type { PlanMeta } from '../core/plans';
import { usedUniqueIds } from '../core/plans';
import { prerequisiteEligibility, subjectNameIndex } from '../core/prerequisites';
import type { QueueState } from '../core/queue';
import type { Recommendation } from '../core/recommend';
import { recommend } from '../core/recommend';
import { sectionMatchesRequirement } from '../core/requirements';
import type { SectionRecord } from '../core/sections';
import { readSections } from '../data/sectionStore';
import { UT_SUBJECTS } from '../data/subjects';
import type { FastlaneSettings } from '../storage/stores';
import { sendFastlane } from './runtime';

export interface RecommendationContext {
    requirements: string[];
    schedule?: UserSchedule;
    settings: FastlaneSettings;
    audit: ParsedAudit | null;
    queue?: QueueState;
    plan?: PlanMeta;
    limit?: number;
    /** for tests / the demo page */
    catalog?: SectionRecord[];
}

/** The shared inventory. Extension pages read IndexedDB directly (it can hold ~10k listings); content scripts ask the background. */
export async function loadCachedSections(semester: string | null): Promise<SectionRecord[]> {
    try {
        if (globalThis.location?.protocol === 'chrome-extension:') return await readSections(semester);
        return await sendFastlane<SectionRecord[]>({ type: 'getSections', semester });
    } catch {
        return [];
    }
}

/** How many top-ranked sections get a historical-grade lookup before the final ranking. */
const GRADE_POOL = 300;

export async function buildRecommendations(ctx: RecommendationContext): Promise<Recommendation[]> {
    const catalog = ctx.catalog ?? (await loadCachedSections(ctx.settings.targetSemester));
    const relevant = catalog.filter(s => ctx.requirements.some(r => sectionMatchesRequirement(s, r)));

    const exclude = new Set<number>(ctx.schedule?.courses.map(c => c.uniqueId) ?? []);
    if (ctx.plan) for (const id of usedUniqueIds(ctx.plan)) exclude.add(id);
    if (ctx.queue) for (const item of ctx.queue.items) if (ctx.queue.outcomes[item.id]) exclude.add(item.uniqueId);

    const taken = ctx.audit ? takenCourseCodes(ctx.audit) : [];
    const excludeCourseCodes = [...taken, ...(ctx.schedule?.courses.map(c => `${c.department} ${c.number}`) ?? [])];
    const index = subjectNameIndex(UT_SUBJECTS);
    const input = {
        requirements: ctx.requirements,
        semester: ctx.settings.targetSemester,
        activeSchedule: scheduleTimes(ctx.schedule),
        excludeUniqueIds: exclude,
        excludeCourseCodes,
        prefs: {
            preferOnline: ctx.settings.preferOnline,
            preferAsync: ctx.settings.preferAsync,
            avoidFriday: ctx.settings.avoidFriday,
            gradeThreshold: ctx.settings.gradeThreshold,
        },
        eligibilityFor: (s: SectionRecord) => prerequisiteEligibility(s, taken, index),
    };

    // pass 1 ranks every relevant section without grades; grades are looked up only for the best GRADE_POOL
    const first = recommend({ ...input, catalog: relevant, limit: GRADE_POOL });
    const grades = new Map<number, GradeStat | null>();
    await Promise.all(
        first.map(async ({ section: s }) => {
            if (!s.course) return;
            try {
                const course = new Course(s.course as Serialized<Course>);
                grades.set(s.uniqueId, gradeStatFrom(course, await lookupGrades(course), ctx.settings.gradeThreshold));
            } catch {
                grades.set(s.uniqueId, null);
            }
        })
    );
    const ranked = recommend({
        ...input,
        catalog: first.map(r => r.section),
        gradeFor: s => grades.get(s.uniqueId) ?? null,
        limit: GRADE_POOL,
    });
    // a printed prerequisite that is clearly not in the IDA moves the section below the others (stable)
    const unmet = (r: Recommendation) =>
        r.eligibility.status === 'restricted' && r.warnings.some(w => w.startsWith('Prerequisite not in your IDA'));
    return [...ranked.filter(r => !unmet(r)), ...ranked.filter(unmet)].slice(0, ctx.limit ?? 8);
}
