import { describe, expect, it } from 'vitest';
import { safeAiScheduleDraft } from '../core/aiSchedule';
import { sectionFixture } from './factories';

describe('safe AI draft schedule', () => {
    it('builds from verified selections, skipping conflicts, duplicates and unknown IDs', () => {
        const eco = { ...sectionFixture(101, 'ECO 304L', { times: [['TTH', '10:00 a.m.-11:00 a.m.']] }), course: {} };
        const conflicting = { ...sectionFixture(102, 'M 408Q', { times: [['TTH', '10:00 a.m.-11:00 a.m.']] }), course: {} };
        const history = { ...sectionFixture(103, 'HIS 315L', { times: [['MWF', '12:00 p.m.-1:00 p.m.']] }), course: {} };
        const duplicate = { ...sectionFixture(104, 'ECO 304L', { times: [['MWF', '2:00 p.m.-3:00 p.m.']] }), course: {} };
        const draft = safeAiScheduleDraft([101, 102, 103, 104, 999], [eco, conflicting, history, duplicate]);
        expect(draft.map(c => c.uniqueId)).toEqual([101, 103]);
    });
    it('honors Friday restrictions and never includes a cancelled section', () => {
        const fri = { ...sectionFixture(106, 'ECO 304L', { times: [['F', '10:00 a.m.-11:00 a.m.']] }), course: {} };
        const cancelled = { ...sectionFixture(107, 'M 408Q', {
            status: { value: 'CANCELLED' as const, source: 'test', observedAt: Date.now() }
        }), course: {} };
        const safe = { ...sectionFixture(108, 'HIS 315L', { modality: 'async-online' }), course: {} };
        expect(safeAiScheduleDraft([106, 107, 108], [fri, cancelled, safe], 16, true).map(c => c.uniqueId)).toEqual([108]);
    });
});
