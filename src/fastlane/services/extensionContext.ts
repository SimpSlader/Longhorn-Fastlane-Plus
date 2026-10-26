/**
 * Extension lifecycle helpers for content scripts.
 *
 * When the extension is reloaded or updated (including local self-reloads), content scripts already
 * running in open tabs keep running, but every chrome.* API they call throws
 * "Extension context invalidated". These helpers let Fastlane notice that once, stop
 * extension-dependent work, and keep that expected lifecycle error from surfacing as an uncaught
 * exception. Genuine failures are never swallowed.
 */

export class ExtensionContextInvalidatedError extends Error {
    constructor(message = 'Extension context invalidated.') {
        super(message);
        this.name = 'ExtensionContextInvalidatedError';
    }
}

const INVALIDATED = /extension context invalidated/i;

/** True while this script can still talk to the extension. */
export function isExtensionContextValid(): boolean {
    try {
        return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
    } catch {
        return false;
    }
}

/** Errors caused by the expected reload/update lifecycle (and nothing else). */
export function isContextInvalidatedError(error: unknown): boolean {
    if (error instanceof ExtensionContextInvalidatedError) return true;
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return INVALIDATED.test(message);
}

type Listener = () => void;
const listeners = new Set<Listener>();
let fired = false;
let timer: ReturnType<typeof setInterval> | undefined;

function fire(): void {
    if (fired) return;
    fired = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            console.debug('[Fastlane] cleanup after extension update failed', error);
        }
    }
    listeners.clear();
}

/** Re-checks the context now (also called on lifecycle errors and when the tab becomes visible). */
export function checkExtensionContext(): boolean {
    if (fired) return false;
    if (isExtensionContextValid()) return true;
    fire();
    return false;
}

/**
 * Runs `listener` once when this script loses its extension context. One shared 1 s timer serves all
 * subscribers and stops after firing, so stale tabs do not accumulate polling.
 */
export function onExtensionContextInvalidated(listener: Listener): () => void {
    if (fired || !isExtensionContextValid()) {
        fired = true;
        queueMicrotask(listener);
        return () => undefined;
    }
    listeners.add(listener);
    if (timer === undefined) timer = setInterval(checkExtensionContext, 1000);
    return () => {
        listeners.delete(listener);
        if (!listeners.size && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };
}

/** Throws a typed error instead of calling into a dead extension context. */
export function assertExtensionContext(): void {
    if (!checkExtensionContext()) throw new ExtensionContextInvalidatedError();
}

/** Converts lifecycle errors from a Chrome API call into ExtensionContextInvalidatedError; rethrows others. */
export async function withExtensionContext<T>(call: () => Promise<T> | T): Promise<T> {
    assertExtensionContext();
    try {
        return await call();
    } catch (error) {
        if (isContextInvalidatedError(error) || !isExtensionContextValid()) {
            checkExtensionContext();
            throw new ExtensionContextInvalidatedError();
        }
        throw error;
    }
}

let guardsInstalled = false;

/**
 * Last line of defence in a content script: an uncaught "Extension context invalidated" error or
 * rejection (for example from code that does not await a message) is marked handled and triggers the
 * normal invalidation cleanup. Every other error still reaches the console and Chrome's error page.
 */
export function installExtensionLifecycleGuards(target: Window = window): void {
    if (guardsInstalled) return;
    guardsInstalled = true;
    target.addEventListener('unhandledrejection', event => {
        if (!isContextInvalidatedError(event.reason)) return;
        event.preventDefault();
        checkExtensionContext();
    });
    target.addEventListener('error', event => {
        if (!isContextInvalidatedError(event.error ?? event.message)) return;
        event.preventDefault();
        checkExtensionContext();
    });
    target.document?.addEventListener('visibilitychange', () => {
        if (target.document.visibilityState === 'visible') checkExtensionContext();
    });
}

/** for tests */
export function resetExtensionContextForTests(): void {
    listeners.clear();
    fired = false;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    guardsInstalled = false;
}
