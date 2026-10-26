import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetMemoryStore } from './_ai/store.mjs';
import handler, { SYSTEM_PROMPT, sanitize } from './advise.mjs';

const original = { ...process.env };
afterEach(() => {
    resetMemoryStore();
    vi.unstubAllGlobals();
    process.env.GROQ_API_KEY = original.GROQ_API_KEY;
    process.env.FASTLANE_AI_ACCESS_CODE = original.FASTLANE_AI_ACCESS_CODE;
});
function request(body, ip = '198.51.100.77', method = 'POST') {
    const headers = { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x-forwarded-for': ip };
    const res = {
        statusCode: 200,
        headers: {},
        setHeader(key, value) {
            this.headers[key] = value;
        },
        end(value) {
            this.body = value ? JSON.parse(value) : {};
        },
    };
    return { req: { method, headers, body }, res };
}
const body = {
    accessCode: 'beta-invite-123',
    question: 'How do I graduate early?',
    memory: ['I want to graduate early', 'Prioritize classes that are mostly A’s'],
    facts: {
        program: 'Economics, BA',
        hoursRemaining: 60,
        accRoomHours: 12,
        scenarios: [{ utPerSemester: 15, accHours: 12, longSemesters: 4 }],
        mccombs: {
            rules: ['24 hours in residence'],
            utLongSemesters: 2,
            prerequisites: [{ name: 'Calculus I', status: 'done at UT' }],
        },
        gpa: 3.9,
    },
};

describe('advisor API', () => {
    it('keeps only computed facts, memory and a short history; drops anything else (like a GPA)', () => {
        const data = sanitize({ ...body, eid: 'abc123', chatHistory: [{ role: 'assistant', text: 'Hi' }] });
        expect(data.facts.hoursRemaining).toBe(60);
        expect(data.facts.mccombs.prerequisites[0].status).toBe('done at UT');
        expect(JSON.stringify(data)).not.toMatch(/3\.9|abc123|eid/);
        expect(data.memory).toHaveLength(2);
        expect(sanitize({ question: '' })).toBeNull();
    });

    it('requires the invite code and returns the model answer', async () => {
        process.env.GROQ_API_KEY = 'gsk_test';
        process.env.FASTLANE_AI_ACCESS_CODE = 'beta-invite-123';
        const denied = request({ ...body, accessCode: 'wrong-code-1' });
        await handler(denied.req, denied.res);
        expect(denied.res.statusCode).toBe(401);

        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify({ answer: 'Take 15 hours a semester.' }) } }],
            }),
        }));
        vi.stubGlobal('fetch', fetchMock);
        const ok = request(body, '198.51.100.78');
        await handler(ok.req, ok.res);
        expect(ok.res.statusCode).toBe(200);
        expect(ok.res.body.answer).toBe('Take 15 hours a semester.');
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(sent.messages[0].content).toBe(SYSTEM_PROMPT);
        expect(sent.messages[1].content).not.toContain('3.9');
    });

    it('answers CORS preflight only for the extension', async () => {
        const pre = request({}, '198.51.100.79', 'OPTIONS');
        await handler(pre.req, pre.res);
        expect(pre.res.statusCode).toBe(204);
    });

    it('the prompt keeps ACC and McCombs rules honest', () => {
        expect(SYSTEM_PROMPT).toMatch(/ACC credit counts only after UT evaluates/);
        expect(SYSTEM_PROMPT).toMatch(/do not count toward the required in-residence hours/);
        expect(SYSTEM_PROMPT).toMatch(/Never promise admission/);
    });
});
