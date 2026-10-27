import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideDevReload, personalAccessFromStamp, RELOAD_COOLDOWN_MS } from '../background/devAutoReload';
import {
    checkExtensionContext,
    ExtensionContextInvalidatedError,
    installExtensionLifecycleGuards,
    isContextInvalidatedError,
    onExtensionContextInvalidated,
    resetExtensionContextForTests,
    withExtensionContext,
} from '../services/extensionContext';
import { fastlanePageUrl, sendFastlane } from '../services/runtime';

type ChromeLike = { runtime: { id?: string; sendMessage: ReturnType<typeof vi.fn>; getURL: (p: string) => string } };
const g = globalThis as unknown as { chrome?: ChromeLike };

function installChrome(alive = true) {
    const id = alive ? 'ext-id' : undefined;
    g.chrome = { runtime: { id, sendMessage: vi.fn(), getURL: (p: string) => `chrome-extension://ext-id/${p}` } };
    return g.chrome;
}

beforeEach(() => {
    resetExtensionContextForTests();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    delete g.chrome;
});

describe('extension context helpers', () => {
    it('recognizes only lifecycle errors', () => {
        expect(isContextInvalidatedError(new Error('Extension context invalidated.'))).toBe(true);
        expect(isContextInvalidatedError(new ExtensionContextInvalidatedError())).toBe(true);
        expect(isContextInvalidatedError('Uncaught Error: Extension context invalidated.')).toBe(true);
        expect(isContextInvalidatedError(new Error('Could not establish connection'))).toBe(false);
        expect(isContextInvalidatedError(new TypeError('x is undefined'))).toBe(false);
        expect(isContextInvalidatedError(undefined)).toBe(false);
    });

    it('normal startup: messages reach the background and return data', async () => {
        const chrome = installChrome();
        chrome.runtime.sendMessage.mockResolvedValue({ ok: true, data: [1, 2] });
        await expect(sendFastlane({ type: 'getSections' })).resolves.toEqual([1, 2]);
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'getSections', fastlane: true });
        expect(fastlanePageUrl('register')).toBe('chrome-extension://ext-id/fastlane.html#register');
    });

    it('after invalidation, messaging rejects with a typed error and never calls Chrome', async () => {
        const chrome = installChrome(false);
        await expect(sendFastlane({ type: 'getSections' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
        expect(fastlanePageUrl()).toBeNull();
    });

    it('maps a Chrome lifecycle throw/rejection to the typed error, but passes genuine failures through', async () => {
        const chrome = installChrome();
        chrome.runtime.sendMessage.mockImplementationOnce(() => {
            throw new Error('Extension context invalidated.');
        });
        await expect(sendFastlane({ type: 'getSections' })).rejects.toBeInstanceOf(ExtensionContextInvalidatedError);

        resetExtensionContextForTests();
        chrome.runtime.id = 'ext-id';
        chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Database is locked'));
        await expect(sendFastlane({ type: 'getSections' })).rejects.toThrow('Database is locked');
        chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: false, error: 'bad request' });
        await expect(sendFastlane({ type: 'getSections' })).rejects.toThrow('bad request');
        await expect(withExtensionContext(() => Promise.reject(new RangeError('real bug')))).rejects.toBeInstanceOf(
            RangeError
        );
    });

    it('invalidation listeners run exactly once, from one shared timer that then stops', async () => {
        const chrome = installChrome();
        const a = vi.fn();
        const b = vi.fn();
        onExtensionContextInvalidated(a);
        onExtensionContextInvalidated(b);
        vi.advanceTimersByTime(3000);
        expect(a).not.toHaveBeenCalled();
        chrome.runtime.id = undefined; // extension reloaded
        vi.advanceTimersByTime(1000);
        vi.advanceTimersByTime(5000);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        // subscribing after the fact still runs (once)
        const late = vi.fn();
        onExtensionContextInvalidated(late);
        await Promise.resolve();
        expect(late).toHaveBeenCalledTimes(1);
        expect(checkExtensionContext()).toBe(false);
    });

    it('global guards mark only lifecycle rejections handled', () => {
        installChrome();
        installExtensionLifecycleGuards(window);
        const lifecycle = new Event('unhandledrejection', { cancelable: true }) as PromiseRejectionEvent;
        Object.defineProperty(lifecycle, 'reason', { value: new Error('Extension context invalidated.') });
        window.dispatchEvent(lifecycle);
        expect(lifecycle.defaultPrevented).toBe(true);

        const genuine = new Event('unhandledrejection', { cancelable: true }) as PromiseRejectionEvent;
        Object.defineProperty(genuine, 'reason', { value: new Error('real failure') });
        window.dispatchEvent(genuine);
        expect(genuine.defaultPrevented).toBe(false);

        const err = new ErrorEvent('error', { cancelable: true, error: new Error('Extension context invalidated.') });
        window.dispatchEvent(err);
        expect(err.defaultPrevented).toBe(true);
        const otherErr = new ErrorEvent('error', { cancelable: true, error: new TypeError('boom') });
        window.dispatchEvent(otherErr);
        expect(otherErr.defaultPrevented).toBe(false);
    });
});

describe('development self-reload decisions (no loops)', () => {
    const base = { now: 1_000_000, registrationTabOpen: false };

    it('first start records the running build instead of reloading', () => {
        expect(decideDevReload({ ...base, current: 'b1', loaded: undefined, state: {} })).toEqual({
            action: 'record-baseline',
        });
    });

    it('does nothing for the same build or without a stamp', () => {
        expect(decideDevReload({ ...base, current: 'b1', loaded: 'b1', state: {} }).action).toBe('none');
        expect(decideDevReload({ ...base, current: null, loaded: 'b1', state: {} }).action).toBe('none');
    });

    it('reloads once for a new build, never twice for the same build, and respects the cooldown', () => {
        expect(decideDevReload({ ...base, current: 'b2', loaded: 'b1', state: {} })).toEqual({ action: 'reload' });
        // a failed/odd startup that still reports the old baseline must not loop
        expect(
            decideDevReload({ ...base, current: 'b2', loaded: 'b1', state: { lastReloadedTo: 'b2', lastReloadAt: 0 } })
        ).toEqual({
            action: 'none',
            reason: 'already-reloaded-to-this-build',
        });
        expect(
            decideDevReload({
                ...base,
                current: 'b3',
                loaded: 'b2',
                state: { lastReloadedTo: 'b2', lastReloadAt: base.now - 1000 },
            })
        ).toEqual({ action: 'none', reason: 'cooldown' });
        expect(
            decideDevReload({
                ...base,
                current: 'b3',
                loaded: 'b2',
                state: { lastReloadedTo: 'b2', lastReloadAt: base.now - RELOAD_COOLDOWN_MS - 1 },
            })
        ).toEqual({ action: 'reload' });
    });

    it('waits while a UT registration page is open unless the student chooses Install now', () => {
        expect(decideDevReload({ ...base, registrationTabOpen: true, current: 'b2', loaded: 'b1', state: {} })).toEqual(
            {
                action: 'defer',
                reason: 'registration-tab-open',
            }
        );
        expect(
            decideDevReload({ ...base, registrationTabOpen: true, force: true, current: 'b2', loaded: 'b1', state: {} })
        ).toEqual({
            action: 'reload',
        });
    });
});

describe('private local access configuration', () => {
    it('accepts a personal invite code from a private installation stamp', () => {
        expect(personalAccessFromStamp({ buildId: 'test', aiAccessCode: ' personal-local-test-code\n' })).toBe(
            'personal-local-test-code'
        );
    });
    it('ignores absent, malformed, or too short codes', () => {
        for (const stamp of [
            null,
            {},
            { aiAccessCode: 12 },
            { aiAccessCode: 'short' },
            { aiAccessCode: 'contains a space' },
        ]) {
            expect(personalAccessFromStamp(stamp)).toBeNull();
        }
    });
});
