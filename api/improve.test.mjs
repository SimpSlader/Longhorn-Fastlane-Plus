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
});
