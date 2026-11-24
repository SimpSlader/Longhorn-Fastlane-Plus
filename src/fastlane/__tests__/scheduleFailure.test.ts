import { describe, expect, it } from 'vitest';
import { constraintsFromRules, EMPTY_RULES, enforceStated, statedRules } from '../core/plannerRules';
import { planningFailure } from '../core/planningFailure';
import { validatePlan } from '../core/planValidator';
import { maximumGap, solveSchedule } from '../core/scheduleSolver';
import { section } from './fixtures/spring2027-degree';

const request =
    "please create a 15-16 hour schedule, tuesday and thursday only, high A's, classes that only count towards core complete, No history, and I need a UGS, preferably 2 online classes, and make sure classes are back to back, the max gap allowed is 15 minutes.";
const rules = () => constraintsFromRules(statedRules([request], new Set(['UGS', 'HIS'])), 'Spring 2027');
const timed = (id: number, start: number, end: number) =>
    section(id, `XYZ 30${id}`, {
        prerequisites: '',
        scheduleComplete: true,
        meetings: [{ days: ['T', 'TH'], start, end }],
    });

describe('schedule failure recovery', () => {
    it('keeps reasons and tested alternatives instead of only a generic error', () => {
        const text = planningFailure({
            error: 'No complete schedule found.',
            reasons: ['Only 12 verified core credits fit.'],
            closestAlternatives: [
                { requiresPermissionTo: 'Try 12–16 credits', totalCredits: 12, classes: [{ code: 'UGS 303' }] },
            ],
        });
        expect(text).toContain('Only 12 verified core credits fit.');
        expect(text).toContain('Try 12–16 credits: 12 credit hours (UGS 303)');
        expect(text).toContain('not added to your calendar');
    });
    it('extracts the screenshot gap limit and keeps it on a retry', () => {
        const prefs = statedRules([request, 'try your best to follow what i said'], new Set(['UGS', 'HIS']));
        expect(prefs.prefs.maxGapMinutes).toBe(15);
        expect(prefs.maxOnline).toBeNull();
        const c = constraintsFromRules(prefs, 'Spring 2027');
        expect(c).toMatchObject({
            minCredits: 15,
            maxCredits: 16,
            coreOnly: true,
            maxGapMinutes: 15,
            subjectCounts: { UGS: 1 },
        });
        expect(enforceStated({ ...c, maxGapMinutes: 120 }, c).maxGapMinutes).toBe(15);
        expect(enforceStated({ ...c, maxOnline: 2 }, c).maxOnline).toBeUndefined();
        expect(
            statedRules(['remove the gap limit'], new Set(), [], { ...EMPTY_RULES, prefs: prefs.prefs }).prefs
                .maxGapMinutes
        ).toBeNull();
    });
    it('a later no-online instruction remains a hard rule after a soft online preference', () => {
        const prefs = statedRules([request, 'no online classes'], new Set(['UGS', 'HIS']));
        expect(prefs.prefs.asyncPreferredOnly).toBe(false);
        expect(prefs.maxOnline).toBe(0);
        const c = constraintsFromRules(prefs, 'Spring 2027');
        expect(enforceStated({ ...c, maxOnline: 2 }, c).maxOnline).toBe(0);
    });
    it('uses a per-day maximum and allows a third course to bridge a partial gap', async () => {
        const sections = [timed(1, 540, 600), timed(2, 660, 720), timed(3, 600, 660)];
        expect(maximumGap(sections.slice(0, 2))).toBe(60);
        expect(maximumGap(sections)).toBe(0);
        const c = { ...rules(), minCredits: 9, maxCredits: 9, coreOnly: false, subjectCounts: {}, checkTravel: false };
        const pool = sections.map(s => ({ section: s, score: 1, applies: [], prerequisite: 'none' as const }));
        const result = await solveSchedule(pool, c);
        expect(result.best?.sections).toHaveLength(3);
        const incomplete = await solveSchedule(pool.slice(0, 2), { ...c, minCredits: 6, maxCredits: 6 });
        expect(incomplete.best).toBeNull();
    });
    it('the independent validator rejects a gap above the requested limit', () => {
        const sections = [timed(1, 540, 600), timed(2, 660, 720)];
        const c = { ...rules(), minCredits: 6, maxCredits: 6, coreOnly: false, subjectCounts: {}, checkTravel: false };
        const out = validatePlan(sections, c, { applies: () => [], auditAvailable: false, catalog: sections });
        expect(out.checks.find(x => x.id === 'gaps')?.status).toBe('fail');
        expect(out.hardOk).toBe(false);
    });
});
