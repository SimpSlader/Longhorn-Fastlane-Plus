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

it('reports which deployment answered (environment and commit, never a secret)', async () => {
    vi.stubEnv('FASTLANE_AI_ACCESS_CODE', 'test-invite-code');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '303750cfeedface');
    vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'feat/nl-planner-candidate');
    const req = { method: 'POST', headers: {}, body: { accessCode: 'test-invite-code' } };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    await handler(req, res);
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.deployment).toEqual({ environment: 'preview', commit: '303750c', branch: 'feat/nl-planner-candidate' });
    expect(JSON.stringify(body)).not.toContain('test-invite-code');
});
