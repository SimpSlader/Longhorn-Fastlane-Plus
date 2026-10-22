import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from './recommend.mjs';

const original = { ...process.env };
afterEach(() => {
    vi.unstubAllGlobals();
    process.env.GROQ_API_KEY = original.GROQ_API_KEY;
    process.env.FASTLANE_AI_ACCESS_CODE = original.FASTLANE_AI_ACCESS_CODE;
});
function request(body, ip = '198.51.100.42') {
    const headers = { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x-forwarded-for': ip };
    const res = {
        statusCode: 200,
        headers: {},
        setHeader(key, value) { this.headers[key] = value; },
        end(value) { this.body = value ? JSON.parse(value) : {}; },
    };
    return { req: { method: 'POST', headers, body }, res };
}
const body = {
    accessCode: 'beta-invite-123',
    requirements: [{ text: 'Economics elective requirement', tags: ['COURSE ECO 304L'], status: 'not-started' }],
    completed: ['ECO 304K'],
    candidates: [
        { id: 12345, code: 'ECO 304L', title: 'Macroeconomics', semester: 'Spring 2027', hours: 3, professor: 'Test', days: ['T'], mode: 'in-person', tags: ['COURSE ECO 304L'], gradePercent: 75, gradeSample: 150 },
    ],
    preferences: { semester: 'Spring 2027', avoidFriday: true },
};
describe('Fastlane Groq API privacy boundary', () => {
    it('cannot proxy model requests without owner-provided invite code', async () => {
        process.env.GROQ_API_KEY = 'test-private-key';
        process.env.FASTLANE_AI_ACCESS_CODE = 'beta-invite-123';
        const { req, res } = request({ ...body, accessCode: 'incorrect' });
        await handler(req, res);
        expect(res.statusCode).toBe(401);
        expect(res.body.error).toMatch(/invite code/i);
    });
    it('is unavailable when the invitation gate is not configured', async () => {
        process.env.GROQ_API_KEY = 'test-private-key';
        delete process.env.FASTLANE_AI_ACCESS_CODE;
        const { req, res } = request(body, '198.51.100.44');
        await handler(req, res);
        expect(res.statusCode).toBe(503);
        expect(res.body.error).toMatch(/FASTLANE_AI_ACCESS_CODE/);
    });
    it('sends only whitelisted academic fields and drops hallucinated IDs', async () => {
        process.env.GROQ_API_KEY = 'test-private-key';
        process.env.FASTLANE_AI_ACCESS_CODE = 'beta-invite-123';
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            summary: 'Consider course fit carefully.',
                            recommendations: [
                                { id: 12345, reason: 'Explicit requirement match', requirement: 'ECO 304L', confidence: 'high', warning: '' },
                                { id: 99999, reason: 'Invented', requirement: 'Anything', confidence: 'high', warning: '' },
                            ],
                        }),
                    },
                }],
            }),
        });
        vi.stubGlobal('fetch', fakeFetch);
        const { req, res } = request({ ...body, studentName: 'Private Student', eid: 'sensitive-id' }, '198.51.100.45');
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.recommendations).toHaveLength(1);
        expect(res.body.recommendations[0].id).toBe(12345);
        const sent = JSON.parse(fakeFetch.mock.calls[0][1].body);
        expect(JSON.stringify(sent)).not.toContain('Private Student');
        expect(JSON.stringify(sent)).not.toContain('sensitive-id');
        expect(sent.model).toBe('openai/gpt-oss-120b');
    });
});
