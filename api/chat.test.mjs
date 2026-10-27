import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, sanitize } from './chat.mjs';

describe('chat API', () => {
    it('keeps public course facts (grades, Rate My Professors) and drops anything else', () => {
        const data = sanitize({
            message: 'Which ECO 304K professor is best?',
            gpa: 3.9,
            context: {
                courses: [
                    {
                        code: 'ECO 304K',
                        listedSections: 12,
                        instructors: [
                            {
                                name: 'Lee',
                                aRate: 71,
                                gradesCounted: 900,
                                rmpRating: 4.6,
                                rmpDifficulty: 2.1,
                                rmpWouldTakeAgain: 92,
                                rmpCount: 140,
                                eid: 'x',
                            },
                        ],
                    },
                ],
            },
        });
        expect(data.courses[0].instructors[0]).toEqual({
            name: 'Lee',
            aRate: 71,
            gradesCounted: 900,
            rmpRating: 4.6,
            rmpDifficulty: 2.1,
            rmpWouldTakeAgain: 92,
            rmpCount: 140,
        });
        expect(JSON.stringify(data)).not.toMatch(/3\.9|eid/);
    });

    it('is a UT academic specialist that can still answer general questions, without inventing UT facts', () => {
        expect(SYSTEM_PROMPT).toMatch(/Rate My Professors/);
        expect(SYSTEM_PROMPT).toMatch(/general questions/);
        expect(SYSTEM_PROMPT).toMatch(/Never invent/);
    });
});
