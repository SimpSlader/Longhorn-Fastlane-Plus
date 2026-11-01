import { describe, expect, it } from 'vitest';
import { isPreviewOrigin } from '../services/aiClient';

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
