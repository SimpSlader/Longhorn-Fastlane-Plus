import { describe, expect, it } from 'vitest';

import {
    activateCandidate,
    activeConflicts,
    activeSections,
    addBackup,
    addSlot,
    allAlternativesExhausted,
    backupsOf,
    DuplicateSectionError,
    emptyPlan,
    markFull,
    nextBackup,
    PlanError,
    previewActivation,
    promoteToPrimary,
    reconcileWithSchedule,
    removeCandidate,
    reorderBackups,
    totalCreditHours,
} from '../core/plans';
import { sectionFixture } from './factories';

const ARTS = ['Visual & Performing Arts'];
const music = sectionFixture(23095, 'MUS 302L', {
    title: 'Western Music',
    core: ARTS,
    times: [['MWF', '10:00 a.m.-11:00 a.m.']],
});
const myth = sectionFixture(33515, 'C C 303', {
    title: 'Classical Mythology',
    core: ARTS,
    times: [['TTH', '9:30 a.m.-11:00 a.m.']],
});
const rome = sectionFixture(33505, 'C C 302', {
    title: 'Ancient Rome',
    core: ARTS,
    times: [['MWF', '1:00 p.m.-2:00 p.m.']],
});
const nutrition = sectionFixture(55675, 'NTR 306', {
    core: ['Natural Science and Technology, Part I'],
    times: [['TTH', '9:30 a.m.-11:00 a.m.']],
});

function basePlan() {
    let plan = emptyPlan('sched-1', 'ideal', 1);
    plan = addSlot(plan, music, 'CORE 050', 2, 'arts');
    plan = addSlot(plan, nutrition, 'CORE 030', 3, 'sci');
    plan = addBackup(plan, 'arts', myth, 4);
    plan = addBackup(plan, 'arts', rome, 5);
    return plan;
}

describe('backup sections', () => {
    it('do not count toward the active schedule or credit hours', () => {
        const plan = basePlan();
        expect(activeSections(plan).map(s => s.uniqueId)).toEqual([23095, 55675]);
        expect(totalCreditHours(plan)).toBe(6);
    });

    it('do not create active schedule conflicts even when they overlap an active class', () => {
        // Classical Mythology (TTH 9:30) overlaps Nutrition (TTH 9:30) but is only a backup
        const plan = basePlan();
        expect(activeConflicts(plan)).toEqual([]);
        // previewing shows what WOULD happen if activated
        expect(previewActivation(plan, 'arts', 33515).status).toBe('conflict');
        expect(previewActivation(plan, 'arts', 33505).status).toBe('clear');
    });

    it('activating a backup swaps it in and returns the calendar swap', () => {
        const { plan, swap } = activateCandidate(basePlan(), 'arts', 33505, 10);
        expect(activeSections(plan).map(s => s.uniqueId)).toEqual([33505, 55675]);
        expect(swap).toMatchObject({ remove: { uniqueId: 23095 }, add: { uniqueId: 33505 } });
        // ranking is unchanged by activation
        expect(plan.slots[0]!.candidates.map(c => c.uniqueId)).toEqual([23095, 33515, 33505]);
    });

    it('activating an overlapping backup DOES then produce a conflict', () => {
        const { plan } = activateCandidate(basePlan(), 'arts', 33515, 10);
        expect(activeConflicts(plan)).toHaveLength(1);
    });

    it('supports drag-and-drop reordering of backups only', () => {
        const plan = reorderBackups(basePlan(), 'arts', 1, 0, 9);
        expect(backupsOf(plan.slots[0]!).map(c => c.uniqueId)).toEqual([33505, 33515]);
        expect(plan.slots[0]!.candidates[0]!.uniqueId).toBe(23095);
        expect(() => reorderBackups(plan, 'arts', 0, 5)).toThrow(PlanError);
    });

    it('can promote a backup to primary', () => {
        const plan = promoteToPrimary(basePlan(), 'arts', 33505, 9);
        expect(plan.slots[0]!.candidates.map(c => c.uniqueId)).toEqual([33505, 23095, 33515]);
        expect(plan.slots[0]!.activeUniqueId).toBe(23095);
    });

    it('prevents duplicate unique numbers anywhere in the plan', () => {
        const plan = basePlan();
        expect(() => addBackup(plan, 'sci', myth)).toThrow(DuplicateSectionError);
        expect(() => addBackup(plan, 'arts', music)).toThrow(DuplicateSectionError);
        expect(() => addSlot(plan, rome)).toThrow(DuplicateSectionError);
    });

    it('recommends the next ranked backup in the same requirement category when the primary is full', () => {
        let plan = markFull(basePlan(), 'arts', 23095, 20);
        expect(nextBackup(plan.slots[0]!)?.uniqueId).toBe(33515);
        plan = markFull(plan, 'arts', 33515, 21);
        expect(nextBackup(plan.slots[0]!)?.uniqueId).toBe(33505);
        plan = markFull(plan, 'arts', 33505, 22);
        expect(nextBackup(plan.slots[0]!)).toBeNull();
        expect(allAlternativesExhausted(plan.slots[0]!)).toBe(true);
    });

    it('prefers a backup in the slot requirement over an off-category one', () => {
        const offTopic = sectionFixture(11111, 'M 408C', {
            core: ['Mathematics'],
            times: [['MWF', '8:00 a.m.-9:00 a.m.']],
        });
        let plan = emptyPlan('s', 'custom', 0);
        plan = addSlot(plan, music, 'CORE 050', 0, 'arts');
        plan = addBackup(plan, 'arts', offTopic, 0);
        plan = addBackup(plan, 'arts', rome, 0);
        plan = markFull(plan, 'arts', 23095, 1);
        expect(nextBackup(plan.slots[0]!)?.uniqueId).toBe(33505);
    });

    it('will not remove the active section', () => {
        expect(() => removeCandidate(basePlan(), 'arts', 23095)).toThrow(PlanError);
        const plan = removeCandidate(basePlan(), 'arts', 33515);
        expect(plan.slots[0]!.candidates.map(c => c.uniqueId)).toEqual([23095, 33505]);
    });

    it('is immutable', () => {
        const plan = basePlan();
        const before = JSON.stringify(plan);
        activateCandidate(plan, 'arts', 33505);
        markFull(plan, 'arts', 23095);
        reorderBackups(plan, 'arts', 0, 1);
        expect(JSON.stringify(plan)).toBe(before);
    });

    it('drops slots whose active course was removed from the UTRP schedule', () => {
        const plan = reconcileWithSchedule(basePlan(), [55675], 30);
        expect(plan.slots.map(s => s.id)).toEqual(['sci']);
    });
});
