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
import type { QueueState } from '../core/queue';
import type { Recommendation } from '../core/recommend';
import { recommend } from '../core/recommend';
import type { SectionRecord } from '../core/sections';
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

export async function loadCachedSections(semester: string | null): Promise<SectionRecord[]> {
    try {
        return await sendFastlane<SectionRecord[]>({ type: 'getSections', semester });
    } catch {
        return [];
    }
}

export async function buildRecommendations(ctx: RecommendationContext): Promise<Recommendation[]> {
    const catalog = ctx.catalog ?? (await loadCachedSections(ctx.settings.targetSemester));
    const relevant = catalog.filter(s => ctx.requirements.some(r => s.requirementTags.includes(r)));

    // grade lookups only for the relevant pool, bounded so this stays fast
    const grades = new Map<number, GradeStat | null>();
    await Promise.all(
        relevant.map(async s => {
            if (!s.course) return;
            try {
                const course = new Course(s.course as Serialized<Course>);
                grades.set(s.uniqueId, gradeStatFrom(course, await lookupGrades(course), ctx.settings.gradeThreshold));
            } catch {
                grades.set(s.uniqueId, null);
            }
        })
    );

    const exclude = new Set<number>(ctx.schedule?.courses.map(c => c.uniqueId) ?? []);
    if (ctx.plan) for (const id of usedUniqueIds(ctx.plan)) exclude.add(id);
    if (ctx.queue) for (const item of ctx.queue.items) if (ctx.queue.outcomes[item.id]) exclude.add(item.uniqueId);

    const excludeCourseCodes = [
        ...(ctx.audit ? takenCourseCodes(ctx.audit) : []),
        ...(ctx.schedule?.courses.map(c => `${c.department} ${c.number}`) ?? []),
    ];

    return recommend({
        requirements: ctx.requirements,
        catalog: relevant,
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
        gradeFor: s => grades.get(s.uniqueId) ?? null,
        limit: ctx.limit ?? 8,
    });
}
