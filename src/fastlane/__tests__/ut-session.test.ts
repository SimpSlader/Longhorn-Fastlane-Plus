import { validateLoginStatus } from '@shared/util/checkLoginStatus';
import { fetchUtRegistrar, UtLoginRequiredError } from '@shared/util/fetchUtRegistrar';
import { afterEach, describe, expect, it, vi } from 'vitest';

const url = 'https://utdirect.utexas.edu/apps/registrar/course_schedule/20272/49325/';
afterEach(() => vi.unstubAllGlobals());

describe('UT course session requests', () => {
    it('includes session cookies and stops before the SAML redirect', async () => {
        const response = { ok: true, status: 200, type: 'basic', redirected: false };
        const fetch = vi.fn(async () => response);
        vi.stubGlobal('fetch', fetch);
        expect(await fetchUtRegistrar(url)).toBe(response);
        expect(fetch).toHaveBeenCalledWith(url, { credentials: 'include', redirect: 'manual' });
    });
    it.each([
        { ok: false, status: 0, type: 'opaqueredirect' },
        { ok: false, status: 302, type: 'basic' },
        { ok: false, status: 401, type: 'basic' },
        { ok: false, status: 403, type: 'basic' },
    ])('treats a redirect or expired session as a sign-in requirement: $status/$type', async response => {
        const fetch = vi.fn(async () => response);
        vi.stubGlobal('fetch', fetch);
        await expect(fetchUtRegistrar(url)).rejects.toBeInstanceOf(UtLoginRequiredError);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await validateLoginStatus()).toBe(false);
    });
    it('does not report a failed registrar response as logged in', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 500 }))
        );
        expect(await validateLoginStatus()).toBe(false);
    });
    it('rejects non-course destinations before sending session cookies', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        await expect(fetchUtRegistrar('https://example.com/')).rejects.toThrow('UT course-schedule URL');
        await expect(fetchUtRegistrar('https://utdirect.utexas.edu/registration/')).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
});
