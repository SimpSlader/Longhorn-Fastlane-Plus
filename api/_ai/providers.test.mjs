import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAuthorized } from './http.mjs';
import { MODELS } from './models.mjs';
import { callModel } from './providers.mjs';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('Gemini request compatibility', () => {
    it.each([
        ['gemini-3.8-flash', 'low'],
        ['gemini-3.1-flash-lite', 'minimal'],
    ])('uses a supported reasoning level for %s', async (model, effort) => {
        const fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
            headers: new Headers(),
        }));
        vi.stubGlobal('fetch', fetch);
        const result = await callModel(
            MODELS.find(m => m.model === model),
            { system: 'Connection check.', user: 'Reply OK.', maxTokens: 1024 },
            { GEMINI_API_KEY: 'test-key' }
        );
        expect(result.text).toBe('OK');
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
        expect(JSON.parse(init.body)).toMatchObject({ model, reasoning_effort: effort, max_tokens: 1024 });
    });
});

describe('invite code pasted from a text file', () => {
    it('accepts surrounding whitespace while still rejecting a different code', () => {
        vi.stubEnv('FASTLANE_AI_ACCESS_CODE', '  long-test-invite-code\n');
        const res = { setHeader: vi.fn(), end: vi.fn() };
        const body = { accessCode: 'long-test-invite-code' };
        expect(readAuthorized({ body }, res, 2000)).toEqual(body);
        expect(readAuthorized({ body: { accessCode: 'long-test-invite-code-wrong' } }, res, 2000)).toBeNull();
        expect(res.statusCode).toBe(401);
    });
    it('does not treat whitespace as a configured credential', () => {
        vi.stubEnv('FASTLANE_AI_ACCESS_CODE', '             ');
        const res = { setHeader: vi.fn(), end: vi.fn() };
        expect(readAuthorized({ body: { accessCode: '' } }, res, 2000)).toBeNull();
        expect(res.statusCode).toBe(503);
    });
});
