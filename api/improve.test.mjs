import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetMemoryStore } from './_ai/store.mjs';
import handler, { addedSomething } from './improve.mjs';

afterEach(() => {
    resetMemoryStore();
    vi.unstubAllGlobals();
});
const call = body => {
    const res = {
        statusCode: 200,
        setHeader() {},
        end(v) {
            this.body = JSON.parse(v);
        },
    };
    return {
        req: {
            method: 'POST',
            headers: {
                origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'x-forwarded-for': '203.0.113.9',
            },
            body,
        },
        res,
    };
};

describe('improve my message', () => {
    it('accepts clarifications but rejects anything added', () => {
        const draft = '15 easy creds no fri, 1-2 async, no gov';
        expect(
            addedSomething(
                draft,
                'Build me a 15-credit-hour schedule with no Friday classes, 1–2 fully online (asynchronous) classes, high historical A rates, and no government classes.'
            )
        ).toBeNull();
        expect(addedSomething(draft, 'Build a 12-credit schedule with no Friday classes.')).toMatch(/number 12/);
        expect(addedSomething(draft, 'A 15-credit schedule on Tuesdays only.')).toMatch(/day \(T\)/);
        expect(addedSomething('remove history', 'Remove HIS 315K from my plan.')).toMatch(/315|course/);
        expect(addedSomething('hi', '')).toBe('empty rewrite');
    });

    it('rejects a rewrite that drops part of a long, multi-part message', () => {
        const draft =
            'Could you build a schedule with a minimum of 12 to 13 credit hours, preferably 15, one to two classes online, only Tuesdays and Thursdays, back to back. Also find harder classes I could take through ACC. I want to graduate a year early, in five semesters, in 2029: how many credit hours per semester spring and fall only, and with one summer? Any tips?';
        const dropped =
            'Please build a class schedule with 12 to 15 credit hours on Tuesdays and Thursdays only, back to back, with one to two online classes.';
        expect(addedSomething(draft, dropped)).toMatch(/dropped/);
        const kept =
            '1. Build me a schedule with at least 12–13 credit hours, ideally about 15, with one to two online classes, only on Tuesdays and Thursdays, all back to back.\n2. Suggest harder classes I could take through ACC.\n3. I want to graduate a year early, in five semesters (2029): how many credit hours per semester would I need with only spring and fall, and with one summer?\n4. Any tips?';
        expect(addedSomething(draft, kept)).toBeNull();
    });

    it('a rewrite that adds a preference goes to another model; the clean one is returned', async () => {
        process.env.GROQ_API_KEY = 'gsk_test';
        process.env.FASTLANE_AI_ACCESS_CODE = 'beta-invite-123';
        const replies = [
            { improved: 'Build a 12-credit schedule with no Friday classes.', changes: [] },
            { improved: 'Build a 15-credit schedule with no Friday classes.', changes: ['Spelled out Friday'] },
        ];
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] }),
        }));
        vi.stubGlobal('fetch', fetchMock);
        const { req, res } = call({ accessCode: 'beta-invite-123', draft: '15 creds no fri' });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.improved).toBe('Build a 15-credit schedule with no Friday classes.');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // only the draft is sent, never memory or academic data
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content).toBe(
            JSON.stringify({ draft: '15 creds no fri', currentPlanCourses: [] })
        );
    });

    it('keeps a long spoken message whole, in the same order and format', async () => {
        const draft =
            "Could you please build a class schedule with a minimum of 12 to 13 credit hours preferably in the 15 range though Um a minimum of one to two classes online Um just for flexibility Um But classes only on Tuesdays and Thursdays all classes should be back to back so there's no weird gaps make sure you're also considering like the online classes Um because I don't want like an online class from like one to two but have in person classes from like 12 to one and then two to three Um additionally I want classes with really really high a distributions pretty much the highest you can find out there I really want to protect my GPA as much as I can additionally Um make sure they're only like classes that will help me become core complete not major specific Um just because I might be transferring majors and want this these credits to be able to transfer Um lastly can you also find classes that I should take through ACCU that are harder UT and have lower A's But something that I'm one allowed to take outside of UT and the ACC Uh just because ACC you can transfer credits And the GPA doesn't transfer so it doesn't affect your grade as muchYeah. Oh additionally um I do want to try and graduate early a year early to be exact um So that would be In five semesters give or take Um how many credit hours per semester would I need if I only did spring and fall semesters graduating in 2029 Um and then same thing but if I took one summer and took classes over like my freshman summer Um how would that look um Yeah any like recommendations tips tricks would be appreciated.";
        expect(draft.length).toBeGreaterThan(1500);
        const faithful =
            "Could you please build a class schedule with a minimum of 12 to 13 credit hours, preferably around 15? I'd like one to two classes online for flexibility, but classes only on Tuesdays and Thursdays. All classes should be back to back so there are no weird gaps, and that includes the online classes: I don't want an online class from one to two while my in-person classes are from 12 to one and two to three. I want classes with really high A distributions, the highest you can find, because I want to protect my GPA as much as I can. They should only be classes that help me become core complete, not major-specific, since I might transfer majors and want these credits to transfer. Lastly, can you find harder classes with lower A rates at UT that I'm allowed to take through ACC instead? ACC credits transfer, but the GPA doesn't, so they don't affect my grade as much. I also want to graduate a year early, in about five semesters, graduating in 2029. How many credit hours per semester would I need if I only did spring and fall semesters? And how would that look if I took one summer, taking classes over my freshman summer? Any recommendations, tips or tricks would be appreciated.";
        expect(addedSomething(draft, faithful)).toBeNull();
        // the earlier failure: everything after the ACC question cut off
        const cut =
            '1. Build a class schedule with a minimum of 12–13 credit hours, preferably around 15 credit hours.\n2. Include at least one to two fully online classes.\n3. Tuesdays and Thursdays only, back to back.\n4. No online class from 1–2 PM while in-person classes run 12–1 PM and 2–3 PM.\n5. Highest grade distributions to protect GPA.\n6. Core completion, not major-specific, to transfer credits.\n7. Find additional classes that I should consider.';
        expect(addedSomething(draft, cut)).toMatch(/dropped/);

        process.env.GROQ_API_KEY = 'gsk_test';
        process.env.FASTLANE_AI_ACCESS_CODE = 'beta-invite-123';
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify({ improved: faithful, changes: [] }) } }],
            }),
        }));
        vi.stubGlobal('fetch', fetchMock);
        const { req, res } = call({ accessCode: 'beta-invite-123', draft });
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        // the whole message reached the model, and the whole rewrite came back
        expect(JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content).draft).toBe(draft);
        expect(res.body.improved).toBe(faithful);
    });
});
