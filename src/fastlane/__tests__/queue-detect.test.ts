import { describe, expect, it } from 'vitest';

import { classifyMessage, suggestOutcome } from '../core/detect';
import type { QueueState } from '../core/queue';
import {
    addItem,
    currentItem,
    defaultQueue,
    exhaustedGroups,
    isQueueState,
    moveItem,
    nextFallback,
    progress,
    QueueError,
    recordCopy,
    recordOutcome,
    removeItem,
    setCondition,
    undo,
    updateItem,
} from '../core/queue';

const cur = (s: QueueState) => currentItem(s)?.uniqueId;
const fail = (s: QueueState, outcome: 'full' | 'conflict' | 'restriction' = 'full') =>
    recordOutcome(s, currentItem(s)!.id, outcome, 1);
const succeed = (s: QueueState) => recordOutcome(s, currentItem(s)!.id, 'success', 1);

describe('registration queue', () => {
    it('starts with the student priority list', () => {
        const q = defaultQueue();
        expect(q.items.map(i => i.uniqueId)).toEqual([
            65555, 65705, 65605, 34240, 23095, 33515, 33505, 55675, 31830, 31925, 31875, 65600,
        ]);
        expect(cur(q)).toBe(65555);
        expect(nextFallback(q)).toMatchObject({ item: { uniqueId: 65705 }, sameGroup: true });
    });

    it('moves to Western Music after three failed UGS attempts (macro is conditional)', () => {
        let q = defaultQueue();
        q = fail(q);
        expect(cur(q)).toBe(65705);
        q = fail(q, 'restriction');
        q = fail(q, 'conflict');
        expect(cur(q)).toBe(23095);
    });

    it('inserts Macroeconomics only when the no-CLEP condition is enabled', () => {
        let q = setCondition(defaultQueue(), 'no-clep-eco', true);
        q = fail(fail(fail(q)));
        expect(cur(q)).toBe(34240);
    });

    it('a success skips the rest of that group, including the later UGS revisit', () => {
        let q = succeed(defaultQueue()); // UGS 65555 added
        expect(cur(q)).toBe(23095);
        q = succeed(q); // Western Music added → skip arts backups
        expect(cur(q)).toBe(55675);
        q = fail(q); // nutrition full → backup 31830
        expect(cur(q)).toBe(31830);
        q = succeed(q);
        q = succeed(q); // archaeology 31925
        expect(cur(q)).toBeUndefined(); // 65600 skipped because UGS succeeded
        expect(progress(q)).toEqual({ success: 4, failed: 1, remaining: 0 });
    });

    it('returns to UGS 65600 after the other priorities when UGS failed', () => {
        let q = fail(fail(fail(defaultQueue())));
        q = succeed(q); // arts
        q = succeed(q); // nutrition
        q = succeed(q); // archaeology
        expect(cur(q)).toBe(65600);
    });

    it('reports exhausted groups so recommendations can be generated', () => {
        let q = defaultQueue();
        q = fail(fail(fail(q))); // UGS 1-3 (65600 still pending → not exhausted)
        expect(exhaustedGroups(q)).toEqual([]);
        q = fail(fail(fail(q))); // all three arts
        expect(exhaustedGroups(q)).toEqual([{ group: 'ARTS', requirement: 'CORE 050' }]);
        expect(nextFallback(q)).toMatchObject({ item: { uniqueId: 31830 }, sameGroup: true });
    });

    it('undo restores the previous state and logs history', () => {
        let q = recordCopy(defaultQueue(), 'default-65555', 5);
        expect(q.pending).toEqual({ itemId: 'default-65555', copiedAt: 5 });
        q = fail(q);
        expect(q.pending).toBeNull();
        expect(cur(q)).toBe(65705);
        q = undo(q, 9);
        expect(cur(q)).toBe(65555);
        expect(q.history.map(h => h.action)).toEqual(['copied', 'full', 'undo']);
        expect(undo(undo(q))).toEqual(undo(undo(q))); // undo on empty stack is a no-op
    });

    it('prevents duplicate unique numbers and validates input', () => {
        const q = defaultQueue();
        expect(() => addItem(q, { uniqueId: 23095, label: 'dup', group: 'X', requirement: '' })).toThrow(QueueError);
        expect(() => addItem(q, { uniqueId: 1234567, label: 'bad', group: 'X', requirement: '' })).toThrow(QueueError);
        expect(() => updateItem(q, 'default-65705', { uniqueId: 65555 })).toThrow(QueueError);
        const added = addItem(q, { uniqueId: 12345, label: 'New', group: '', requirement: 'CORE 050' }, 0);
        expect(added.items[0]).toMatchObject({ uniqueId: 12345, group: 'OTHER' });
    });

    it('is editable: move and remove', () => {
        let q = moveItem(defaultQueue(), 4, 0);
        expect(cur(q)).toBe(23095);
        q = removeItem(q, 'default-23095');
        expect(cur(q)).toBe(65555);
    });

    it('validates persisted shape', () => {
        expect(isQueueState(defaultQueue())).toBe(true);
        expect(isQueueState({ version: 2 })).toBe(false);
        expect(isQueueState(JSON.parse(JSON.stringify(defaultQueue())))).toBe(true);
    });
});

describe('result message detection (optional, suggestion only)', () => {
    it('classifies UT-style messages', () => {
        expect(classifyMessage('Requested class is filled to closing limit.')).toBe('full');
        expect(classifyMessage('Requested class 65555 is filled to closing limit.')).toBe('full');
        expect(classifyMessage('The class 23095 is closed.')).toBe('full');
        expect(classifyMessage('Section is full')).toBe('full');
        expect(classifyMessage('You have added 23095 to your schedule.')).toBe('success');
        expect(classifyMessage('Time conflict with another class.')).toBe('conflict');
        expect(classifyMessage('This class is restricted to certain majors.')).toBe('restriction');
        expect(classifyMessage('The class was not added to your schedule.')).toBeNull();
        expect(classifyMessage('Welcome to registration')).toBeNull();
    });

    it('ignores messages that predate the copy and messages about other unique numbers', () => {
        const baseline = new Set(['requested class is filled to closing limit for 65555.']);
        expect(
            suggestOutcome(['Requested class is filled to closing limit for 65555.'], { uniqueId: 65555, baseline })
        ).toBeNull();
        expect(
            suggestOutcome(['You added 11111 to your schedule.'], { uniqueId: 65555, baseline: new Set() })
        ).toBeNull();
        expect(
            suggestOutcome(['You added 65555 to your schedule.'], { uniqueId: 65555, baseline: new Set() })
        ).toMatchObject({
            kind: 'success',
        });
    });
});
