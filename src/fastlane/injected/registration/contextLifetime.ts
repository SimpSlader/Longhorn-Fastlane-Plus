/** Old content scripts survive an extension reload, but their Chrome APIs do not. */
import {
    checkExtensionContext,
    isContextInvalidatedError,
    isExtensionContextValid,
    onExtensionContextInvalidated,
} from '../../services/extensionContext';

export const EXPIRED_EVENT = 'fastlane-assistant-context-expired';
export const contextAlive = isExtensionContextValid;
export const contextInvalidated = isContextInvalidatedError;
export function expireAssistant(host: HTMLElement) {
    host.dispatchEvent(new Event(EXPIRED_EVENT));
}
export async function assistantAction(host: HTMLElement, action: () => Promise<unknown>) {
    if (!contextAlive()) {
        expireAssistant(host);
        return;
    }
    try {
        await action();
    } catch (error) {
        if (!contextAlive() || contextInvalidated(error)) {
            expireAssistant(host);
            return;
        }
        throw error;
    }
}

export function watchAssistantContext(host: HTMLElement, unmount: () => void) {
    const doc = host.ownerDocument;
    let expired = false;
    const stop = () => {
        unsubscribe();
        host.removeEventListener(EXPIRED_EVENT, expire);
        host.removeEventListener('click', guard, true);
        host.removeEventListener('change', guard, true);
        doc.removeEventListener('keydown', guardShortcut, true);
        doc.defaultView?.removeEventListener('pagehide', onPageHide);
    };
    const onPageHide = (event: PageTransitionEvent) => {
        if (!event.persisted) stop(); // keep guards when this document is retained in the back/forward cache
    };
    const expire = () => {
        if (expired) return;
        expired = true;
        stop();
        unmount(); // disconnect result observers, pending scans and keyboard shortcuts
        const panel = doc.createElement('section');
        panel.className = 'fl';
        panel.style.padding = '16px';
        panel.setAttribute('role', 'status');
        const text = doc.createElement('p');
        text.textContent =
            'FastLane was updated or disconnected. Refresh this UT page to reconnect. FastLane will not submit or retry registration.';
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'mini';
        button.textContent = 'Refresh UT page';
        button.onclick = () => doc.defaultView?.location.reload();
        panel.append(text, button);
        host.shadowRoot?.append(panel);
    };
    const guard = (event: Event) => {
        if (checkExtensionContext()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        expire();
    };
    const guardShortcut = (event: KeyboardEvent) => {
        if (event.altKey && event.shiftKey && ['KeyC', 'KeyF'].includes(event.code)) guard(event);
    };
    // one shared watcher per tab (stops itself after firing)
    const unsubscribe = onExtensionContextInvalidated(expire);
    host.addEventListener(EXPIRED_EVENT, expire);
    host.addEventListener('click', guard, true);
    host.addEventListener('change', guard, true);
    doc.addEventListener('keydown', guardShortcut, true);
    doc.defaultView?.addEventListener('pagehide', onPageHide);
    return expire;
}
