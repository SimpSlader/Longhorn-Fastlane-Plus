/**
 * Applies plan operations to storage, keeping UT Registration Plus schedules in sync:
 * the active section of each slot is the one in the UTRP schedule; backups live only in Fastlane.
 */
import type { Serialized } from '@chrome-extension-toolkit';
import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import { Course } from '@shared/types/Course';
import { UserSchedule } from '@shared/types/UserSchedule';
import { getUnusedColor } from '@shared/util/colors';

import { sectionFromCourse } from '../adapters/utrp';
import type { PlanKind, PlanMeta, PlanSlot } from '../core/plans';
import {
    activateCandidate,
    addBackup,
    addSlot,
    emptyPlan,
    findSection,
    markFull,
    reconcileWithSchedule,
    removeCandidate,
    reorderBackups,
    setRequirement,
} from '../core/plans';
import type { SectionRecord } from '../core/sections';
import { FastlanePlanStore } from '../storage/stores';

async function readPlans(): Promise<Record<string, PlanMeta>> {
    return ((await FastlanePlanStore.get('plans')) as unknown as Record<string, PlanMeta>) ?? {};
}

async function writePlan(plan: PlanMeta): Promise<void> {
    const plans = await readPlans();
    await FastlanePlanStore.set('plans', { ...plans, [plan.scheduleId]: plan } as never);
}

export function guessKind(name: string): PlanKind {
    if (/backup|plan b/i.test(name)) return 'backup';
    if (/ideal|plan a|main/i.test(name)) return 'ideal';
    return 'custom';
}

/** Default requirement for a slot: the first core tag of its section, else the course itself. */
export function defaultRequirement(section: SectionRecord): string {
    return section.requirementTags.find(t => t.startsWith('CORE')) ?? section.requirementTags[0] ?? '';
}

/**
 * Returns the plan for a schedule, creating slots for any schedule course that does not have one
 * and dropping slots whose course was removed in the calendar.
 */
export function syncPlan(plan: PlanMeta | undefined, schedule: UserSchedule, now = Date.now()): PlanMeta {
    let next = plan ?? emptyPlan(schedule.id, guessKind(schedule.name), now);
    next = reconcileWithSchedule(
        next,
        schedule.courses.map(c => c.uniqueId),
        now
    );
    for (const course of schedule.courses) {
        if (next.slots.some(s => s.activeUniqueId === course.uniqueId)) continue;
        const found = findSection(next, course.uniqueId);
        const section = sectionFromCourse(course);
        if (found) continue; // listed as someone's backup but also in schedule: leave as-is
        next = addSlot(next, section, defaultRequirement(section), now);
    }
    return next;
}

export async function loadPlan(schedule: UserSchedule): Promise<PlanMeta> {
    const plans = await readPlans();
    const synced = syncPlan(plans[schedule.id], schedule);
    if (synced !== plans[schedule.id]) await writePlan(synced);
    return synced;
}

export async function setPlanKind(scheduleId: string, kind: PlanKind): Promise<void> {
    const plans = await readPlans();
    const plan = plans[scheduleId];
    if (!plan) return;
    await writePlan({ ...plan, kind, updatedAt: Date.now() });
}

async function withSchedule(scheduleId: string): Promise<UserSchedule> {
    const schedules = await UserScheduleStore.get('schedules');
    const raw = schedules.find(s => s.id === scheduleId);
    if (!raw) throw new Error('That schedule no longer exists');
    return new UserSchedule(raw as unknown as Serialized<UserSchedule>);
}

/** Adds `backup` as the lowest-ranked backup for the slot whose active section is `forUniqueId`. */
export async function addBackupFor(scheduleId: string, forUniqueId: number, backup: SectionRecord): Promise<PlanMeta> {
    const plan = await loadPlan(await withSchedule(scheduleId));
    const slot = plan.slots.find(s => s.activeUniqueId === forUniqueId);
    if (!slot) throw new Error('That class is not in the schedule');
    const next = addBackup(plan, slot.id, backup);
    await writePlan(next);
    return next;
}

export async function updatePlan(scheduleId: string, fn: (plan: PlanMeta) => PlanMeta): Promise<PlanMeta> {
    const plan = await loadPlan(await withSchedule(scheduleId));
    const next = fn(plan);
    await writePlan(next);
    return next;
}

export const planOps = {
    reorder: (scheduleId: string, slotId: string, from: number, to: number) =>
        updatePlan(scheduleId, p => reorderBackups(p, slotId, from, to)),
    remove: (scheduleId: string, slotId: string, uniqueId: number) =>
        updatePlan(scheduleId, p => removeCandidate(p, slotId, uniqueId)),
    markFull: (scheduleId: string, slotId: string, uniqueId: number) =>
        updatePlan(scheduleId, p => markFull(p, slotId, uniqueId)),
    setRequirement: (scheduleId: string, slotId: string, requirement: string) =>
        updatePlan(scheduleId, p => setRequirement(p, slotId, requirement)),
};

/**
 * Class swapping: makes a backup the active section. The UTRP schedule is updated in the same step
 * (old active removed, new one added) so the calendar, credit hours and conflict checks follow.
 */
export async function activateSection(scheduleId: string, slotId: string, uniqueId: number): Promise<void> {
    const schedule = await withSchedule(scheduleId);
    const plan = await loadPlan(schedule);
    const { plan: next, swap } = activateCandidate(plan, slotId, uniqueId);
    if (!swap) return;
    if (!swap.add.course)
        throw new Error('This backup was saved without full course details; re-add it from the UT course schedule.');
    const schedules = await UserScheduleStore.get('schedules');
    const target = schedules.find(s => s.id === scheduleId);
    if (!target) throw new Error('That schedule no longer exists');
    const incoming = new Course(swap.add.course as Serialized<Course>);
    const kept = target.courses.filter(c => c.uniqueId !== swap.remove.uniqueId && c.uniqueId !== incoming.uniqueId);
    const removed = target.courses.find(c => c.uniqueId === swap.remove.uniqueId);
    incoming.colors =
        removed?.colors ?? getUnusedColor(new UserSchedule({ ...target, courses: kept } as never), incoming);
    target.courses = [...kept, incoming] as never;
    target.updatedAt = Date.now();
    await UserScheduleStore.set('schedules', schedules);
    await writePlan(next);
}

export function slotForActive(plan: PlanMeta | undefined, uniqueId: number): PlanSlot | undefined {
    return plan?.slots.find(s => s.activeUniqueId === uniqueId);
}
