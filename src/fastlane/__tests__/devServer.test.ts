import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_BASE, aiTarget, isPreviewOrigin } from '../services/aiClient';
import { FastlaneDevServerStore } from '../storage/stores';

describe('developer test server: only this project’s own previews are accepted', () => {
    it('accepts the branch alias and per-deployment preview hosts', () => {
        for (const o of [
            'https://longhorn-fastlane-plus-git-feat-nl-fc50bc-simpsladers-projects.vercel.app',
            'https://longhorn-fastlane-plus-1zas4f1i6-simpsladers-projects.vercel.app',
        ])
            expect(isPreviewOrigin(o)).toBe(true);
    });
    it('rejects production, other projects, other teams, lookalikes and plain http', () => {
        for (const o of [
            'https://longhorn-fastlane-plus.vercel.app',
            'https://evil.vercel.app',
            'https://longhorn-fastlane-plus-abc-otherteam-projects.vercel.app',
            'https://longhorn-fastlane-plus-abc-simpsladers-projects.vercel.app.evil.com',
            'http://longhorn-fastlane-plus-abc-simpsladers-projects.vercel.app',
            'https://evil.com/longhorn-fastlane-plus-abc-simpsladers-projects.vercel.app',
            '',
        ])
            expect(isPreviewOrigin(o)).toBe(false);
    });
});

describe('test server failure must never silently use production', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('uses production only when the developer has not selected a test server', async () => {
        vi.stubEnv('VITE_FASTLANE_DEV_AUTORELOAD', 'true');
        vi.spyOn(FastlaneDevServerStore, 'all').mockResolvedValue({ base: '', code: '' });
        expect(await aiTarget()).toEqual({ base: AI_BASE, dev: false });
    });

    it.each([
        'not a url',
        'https://evil.vercel.app',
        'https://longhorn-fastlane-plus.vercel.app',
    ])('fails closed for saved invalid test URL %s', async base => {
        vi.stubEnv('VITE_FASTLANE_DEV_AUTORELOAD', 'true');
        vi.spyOn(FastlaneDevServerStore, 'all').mockResolvedValue({ base, code: 'test' });
        await expect(aiTarget()).rejects.toThrow(/production was not contacted/i);
    });

    it('fails closed if test-server settings cannot be read', async () => {
        vi.stubEnv('VITE_FASTLANE_DEV_AUTORELOAD', 'true');
        vi.spyOn(FastlaneDevServerStore, 'all').mockRejectedValue(new Error('storage unavailable'));
        await expect(aiTarget()).rejects.toThrow(/production was not contacted/i);
    });

    it('keeps selected preview requests on the candidate backend', async () => {
        vi.stubEnv('VITE_FASTLANE_DEV_AUTORELOAD', 'true');
        const base = 'https://longhorn-fastlane-plus-git-feat-nl-fc50bc-simpsladers-projects.vercel.app';
        vi.spyOn(FastlaneDevServerStore, 'all').mockResolvedValue({ base, code: 'test' });
        expect(await aiTarget()).toEqual({ base: base + '/api', code: 'test', dev: true });
    });
});
