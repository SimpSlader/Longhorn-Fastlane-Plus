import { afterEach, expect, it, vi } from 'vitest';
import { routeAI } from './_ai/router.mjs';
import handler from './ai-status.mjs';

vi.mock('./_ai/router.mjs', () => ({
    routeAI: vi.fn(async () => ({ ok: true, meta: { latencyMs: 1 } })),
    routerStatus: vi.fn(),
}));
afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});
it('checks Gemini with the fast current model and enough output budget', async () => {
    vi.stubEnv('FASTLANE_AI_ACCESS_CODE', 'test-invite-code');
    const req = { method: 'POST', headers: {}, body: { accessCode: 'test-invite-code', test: 'gemini' } };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    await handler(req, res);
    expect(routeAI).toHaveBeenCalledWith(
        expect.objectContaining({
            task: 'test',
            maxTokens: 1024,
            routing: { mode: 'manual', model: 'gemini:gemini-3.1-flash-lite' },
        })
    );
    expect(res.statusCode).toBe(200);
});
