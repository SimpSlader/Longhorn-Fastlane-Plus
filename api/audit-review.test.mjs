import { afterEach, describe, expect, it, vi } from 'vitest';
import handler, { supportedTag } from './audit-review.mjs';

const initialKey = process.env.GROQ_API_KEY;
const initialInvite = process.env.FASTLANE_AI_ACCESS_CODE;
afterEach(() => {
    vi.unstubAllGlobals();
    if (initialKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = initialKey;
    if (initialInvite === undefined) delete process.env.FASTLANE_AI_ACCESS_CODE;
    else process.env.FASTLANE_AI_ACCESS_CODE = initialInvite;
});
function call(body, ip = '198.51.100.19') {
    const res = {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
        end(value) {
            this.body = value ? JSON.parse(value) : {};
        },
    };
    return {
        req: {
            method: 'POST',
            headers: { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x-forwarded-for': ip },
            body,
        },
        res,
    };
}
const payload = {
    accessCode: 'private-invite-code',
    requirements: [
        {
            id: 'r1',
            section: 'Major',
            text: 'Six hours in ECO; 3 remaining',
            tags: [],
            status: 'in-progress',
            remaining: 3,
            applied: 3,
        },
        { id: 'r2', section: 'Core', text: 'CORE (050) needed', tags: [], status: 'not-started', remaining: 3 },
    ],
    completedCodes: ['ECO 304K'],
    pendingTransferCodes: ['ECO 304L'],
};
describe('AI IDA review security', () => {
    it('requires the private owner invitation', async () => {
        process.env.GROQ_API_KEY = 'test-only';
        process.env.FASTLANE_AI_ACCESS_CODE = 'private-invite-code';
        const { req, res } = call({ ...payload, accessCode: 'wrong' });
        await handler(req, res);
        expect(res.statusCode).toBe(401);
    });
    it('validates explicit source tags rather than accepting invented codes', () => {
        expect(supportedTag('DEPT ECO', 'Six hours in ECO')).toBe('DEPT ECO');
        expect(supportedTag('DEPT M', 'Six hours in ECO')).toBe(null);
        expect(supportedTag('COURSE ECO 304L', 'Six hours in ECO')).toBe(null);
        expect(supportedTag('CORE 050', 'CORE (050) needed')).toBe('CORE 050');
    });
    it('does not transmit identity fields and blocks hallucinated completion', async () => {
        process.env.GROQ_API_KEY = 'test-only';
        process.env.FASTLANE_AI_ACCESS_CODE = 'private-invite-code';
        const mock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                summary: 'Check the major requirement',
                                suggestions: [
                                    {
                                        id: 'r1',
                                        suggestedStatus: 'completed',
                                        suggestedTags: ['DEPT ECO', 'COURSE UGS 302'],
                                        evidence: 'Six hours in ECO',
                                        explanation: 'Department match',
                                        uncertainty: 'May be upper division only',
                                    },
                                    {
                                        id: 'r9999',
                                        suggestedStatus: 'completed',
                                        suggestedTags: [],
                                        evidence: 'Invented',
                                        explanation: 'Invented',
                                        uncertainty: '',
                                    },
                                ],
                            }),
                        },
                    },
                ],
            }),
        });
        vi.stubGlobal('fetch', mock);
        const { req, res } = call(
            { ...payload, eid: 'private-eid-123', studentName: 'Private Person' },
            '198.51.100.20'
        );
        await handler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.suggestions).toHaveLength(1);
        expect(res.body.suggestions[0].suggestedStatus).toBe('unchanged');
        expect(res.body.suggestions[0].suggestedTags).toEqual(['DEPT ECO']);
        const sent = JSON.parse(mock.mock.calls[0][1].body);
        expect(JSON.stringify(sent)).not.toContain('private-eid-123');
        expect(JSON.stringify(sent)).not.toContain('Private Person');
    });
});
