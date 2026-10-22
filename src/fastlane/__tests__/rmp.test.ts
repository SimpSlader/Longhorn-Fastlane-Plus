import { describe, expect, it } from 'vitest';

import type { RmpTeacher } from '../core/rmp';
import { pickTeacher, RMP_UT_SCHOOL_ID, splitProfessorName } from '../core/rmp';

const t = (firstName: string, lastName: string, numRatings = 10, school = RMP_UT_SCHOOL_ID): RmpTeacher => ({
    legacyId: numRatings * 1000 + firstName.length,
    firstName,
    lastName,
    department: 'Music',
    avgRating: 4.3,
    avgDifficulty: 1.3,
    numRatings,
    wouldTakeAgainPercent: 71.4,
    school: { id: school },
});

describe('Rate My Professors matching', () => {
    it('reads UT and display name formats', () => {
        expect(splitProfessorName(undefined, undefined, "DELL'ANTONIO, ANDREW")).toEqual({
            first: 'andrew',
            last: "dell'antonio",
        });
        expect(splitProfessorName('Andrew', 'Dell’Antonio', '')).toEqual({ first: 'andrew', last: "dell'antonio" });
        expect(splitProfessorName(undefined, undefined, 'Andrew Dell')).toEqual({ first: 'andrew', last: 'dell' });
    });

    it('picks the single UT professor with that name', () => {
        const r = pickTeacher([t('Andrew', "Dell'Antonio"), t('Andrew', 'Dell', 5)], {
            first: 'andrew',
            last: "dell'antonio",
        });
        expect(r?.name).toBe("Andrew Dell'Antonio");
        expect(r?.avgRating).toBe(4.3);
    });

    it('matches a first initial', () => {
        expect(pickTeacher([t('Jane', 'Smith')], { first: 'j', last: 'smith' })?.name).toBe('Jane Smith');
    });

    it('shows nothing when the name is ambiguous or at another school', () => {
        expect(pickTeacher([t('John', 'Smith'), t('Jane', 'Smith')], { first: '', last: 'smith' })).toBeNull();
        expect(pickTeacher([t('Jane', 'Smith')], { first: 'mary', last: 'smith' })).toBeNull();
        expect(pickTeacher([t('Jane', 'Smith', 10, 'other')], { first: 'jane', last: 'smith' })).toBeNull();
    });

    it('prefers the rated profile when a duplicate has no ratings', () => {
        const r = pickTeacher([t('Jane', 'Smith', 0), t('Jane', 'Smith', 12)], { first: 'jane', last: 'smith' });
        expect(r?.numRatings).toBe(12);
    });
});
