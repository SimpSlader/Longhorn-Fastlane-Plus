import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelPersonalAi, personalAiRequest, trustedAiSender } from '../background/personalAi';
import {
    DEFAULT_PERSONAL_AI,
    PERSONAL_PROVIDER_IDS,
    PERSONAL_PROVIDERS,
    type PersonalAiConfig,
} from '../core/personalAi';

const state = vi.hoisted(() => ({ all: vi.fn() }));
vi.mock('../storage/stores', () => ({ FastlanePersonalAiStore: { all: state.all } }));
let config: PersonalAiConfig;
let network: ReturnType<typeof vi.fn>;
const origin = `chrome-extension://${'a'.repeat(32)}/`;
beforeEach(() => {
    config = structuredClone(DEFAULT_PERSONAL_AI);
    config.enabled = true;
    for (const p of PERSONAL_PROVIDER_IDS)
        config.providers[p] = {
            key: `fake-key-${p}`,
            accountId: 'b'.repeat(32),
            freeConfirmed: true,
            allowAcademic: false,
        };
    state.all.mockImplementation(async () => config);
    vi.stubGlobal('chrome', {
        runtime: { id: 'a'.repeat(32), getURL: (path: string) => origin + path },
        permissions: { contains: vi.fn(async () => true) },
    });
    network = vi.fn(
        async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
    );
    vi.stubGlobal('fetch', network);
});
afterEach(() => vi.unstubAllGlobals());

describe('personal AI privacy boundary', () => {
    it.each(
        PERSONAL_PROVIDER_IDS
    )('sends the %s key only as provider authorization, never in the prompt or response', async p => {
        config.provider = p;
        const result = await personalAiRequest(
            'chat',
            {
                message: 'Hello',
                name: 'PRIVATE_NAME',
                fullAudit: 'PRIVATE_HTML',
                accessCode: 'PRIVATE_INVITE',
                context: { eid: 'PRIVATE_EID' },
            },
            crypto.randomUUID()
        );
        expect(result.status).toBe(200);
        expect(result.payload.answer).toBe('OK');
        expect(network).toHaveBeenCalledTimes(1);
        const [url, options] = network.mock.calls[0]!;
        expect(url).toMatch(new RegExp('^' + PERSONAL_PROVIDERS[p].origin.replace('/*', '/').replaceAll('.', '\\.')));
        expect(options.headers.Authorization).toBe(`Bearer fake-key-${p}`);
        expect(options.body).not.toMatch(/PRIVATE_|fake-key/);
        expect(JSON.stringify(result)).not.toContain(`fake-key-${p}`);
    });
    it('does not call a provider until free-plan status is confirmed', async () => {
        config.providers.groq.freeConfirmed = false;
        expect((await personalAiRequest('chat', { message: 'Hello' }, crypto.randomUUID())).status).toBe(403);
        expect(network).not.toHaveBeenCalled();
    });
    it('requires a separate Gemini opt-in for degree facts', async () => {
        config.provider = 'gemini';
        const body = { message: 'Explain these facts', context: { academic: { hoursCompleted: 9 } } };
        expect((await personalAiRequest('chat', body, crypto.randomUUID())).status).toBe(403);
        expect(network).not.toHaveBeenCalled();
        config.providers.gemini.allowAcademic = true;
        expect((await personalAiRequest('chat', body, crypto.randomUUID())).status).toBe(200);
    });
    it('does not retry or fall back to the shared server when a personal key fails', async () => {
        network.mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'fake-key-groq rejected' } }), { status: 401 })
        );
        const result = await personalAiRequest('chat', { message: 'Hello' }, crypto.randomUUID());
        expect(result.status).toBe(502);
        expect(JSON.stringify(result)).not.toContain('fake-key-groq');
        expect(network).toHaveBeenCalledTimes(1);
        expect(network.mock.calls[0]![0]).not.toContain('vercel.app');
    });
    it('does not send anything if the provider permission is missing or Cloudflare account ID is invalid', async () => {
        vi.stubGlobal('chrome', { ...chrome, permissions: { contains: vi.fn(async () => false) } });
        expect((await personalAiRequest('chat', { message: 'Hello' }, crypto.randomUUID())).status).toBe(403);
        config.provider = 'cloudflare';
        config.providers.cloudflare.accountId = '../../another-account';
        expect((await personalAiRequest('chat', { message: 'Hello' }, crypto.randomUUID())).status).toBe(400);
        expect(network).not.toHaveBeenCalled();
    });
    it('rejects fabricated recommendation IDs before returning results', async () => {
        network.mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({ recommendations: [{ id: 99999 }], summary: 'invented' }),
                            },
                        },
                    ],
                }),
                { status: 200 }
            )
        );
        const result = await personalAiRequest(
            'recommend',
            { requirements: [{ text: 'Core', status: 'not-started' }], candidates: [{ id: 12345, code: 'UGS 302' }] },
            crypto.randomUUID()
        );
        expect(result.status).toBe(502);
    });
    it('honors cancellation received while the request is being prepared', async () => {
        const id = crypto.randomUUID();
        cancelPersonalAi(id);
        network.mockImplementation(async (_url, options) => {
            expect(options.signal.aborted).toBe(true);
            throw new DOMException('Aborted', 'AbortError');
        });
        expect((await personalAiRequest('chat', { message: 'Hello' }, id)).status).toBe(502);
    });
    it('allows only extension pages to request access to personal keys', () => {
        expect(trustedAiSender({ id: chrome.runtime.id, url: origin + 'fastlane.html' })).toBe(true);
        expect(trustedAiSender({ id: chrome.runtime.id, url: 'https://utdirect.utexas.edu/' })).toBe(false);
        expect(trustedAiSender({ id: 'another-extension', url: origin + 'fastlane.html' })).toBe(false);
    });
});
