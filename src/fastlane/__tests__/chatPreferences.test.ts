import { describe, expect, it } from 'vitest';
import { courseCodesIn, describePreferences, planningPreferences, requestedDaysOff } from '../core/chatPreferences';

describe('natural-language day exclusions', () => {
    it('detects three days in a typical scheduling request', () => {
        expect(
            requestedDaysOff('Please find classes with no classes on Monday, Wednesday, Friday; 1-2 online')
        ).toEqual(['M', 'W', 'F']);
    });
    it('supports common M/W/F shorthand and single days', () => {
        expect(requestedDaysOff('Avoid M/W/F. Prefer asynchronous courses.')).toEqual(['M', 'W', 'F']);
        expect(requestedDaysOff('No class on Tuesday and Thursday.')).toEqual(['T', 'TH']);
    });
    it('does not interpret a mentioned day as a prohibited day', () => {
        expect(requestedDaysOff('I can take classes Monday and Tuesday.')).toEqual([]);
    });
});

describe('planning conversation preferences', () => {
    const subjects = new Set(['ECO', 'GOV', 'HIS', 'C S', 'M', 'ACC', 'UGS']);
    const example =
        "Find classes that count toward my degree, preferably no classes Monday, Wednesday or Friday, 1–2 asynchronous online classes, and easy professors. I'm planning to take Macro through ACC.";

    it('understands the full example request', () => {
        const p = planningPreferences([example], subjects);
        expect(p.avoidDays.sort()).toEqual(['F', 'M', 'W']);
        expect(p.asyncCount).toEqual({ min: 1, max: 2 });
        expect(p.preferAsync).toBe(true);
        expect(p.easyGrades).toBe(true);
        // ACC is a plan, not credit: the course is left out of suggestions, never marked completed
        expect(p.plannedElsewhere).toEqual([{ code: 'ECO 304L', where: 'ACC' }]);
        expect(p.excludedCourses).toEqual([]);
    });

    it('keeps earlier preferences across follow-ups and lets a later message change them', () => {
        const p = planningPreferences(
            [example, 'Also skip GOV 310L.', 'Actually Fridays are fine, and only one async class.'],
            subjects
        );
        expect(p.avoidDays.sort()).toEqual(['M', 'W']);
        expect(p.asyncCount).toEqual({ min: 1, max: 1 });
        expect(p.excludedCourses).toEqual(['GOV 310L']);
        expect(p.plannedElsewhere.map(c => c.code)).toEqual(['ECO 304L']);
        expect(p.easyGrades).toBe(true);
    });

    it('reads course codes only for real subjects, including spaced codes', () => {
        expect(courseCodesIn('I already took cs 312 and c s 314, not XYZ 999', subjects)).toEqual([
            'C S 312',
            'C S 314',
        ]);
        expect(planningPreferences(['I prefer mornings, no online classes'], subjects)).toMatchObject({
            timeOfDay: 'morning',
            asyncCount: { min: 0, max: 0 },
            preferAsync: false,
        });
    });

    it('describes what was understood without implying ACC credit', () => {
        const lines = describePreferences(planningPreferences([example], subjects), {
            M: 'Monday',
            T: 'Tuesday',
            W: 'Wednesday',
            TH: 'Thursday',
            F: 'Friday',
            S: 'Saturday',
            SU: 'Sunday',
        });
        expect(lines).toContain('1–2 asynchronous online classes');
        expect(lines.join(' ')).toMatch(/ECO 304L: you plan to take it at ACC \(not counted as UT credit/);
    });
});
