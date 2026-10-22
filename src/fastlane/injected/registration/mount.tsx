import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { suspendUntilStoresReady } from 'src/lib/chrome-extension-toolkit/storage/createStore';

import { FastlaneAuditStore, FastlanePlanStore, FastlaneQueueStore, FastlaneSettingsStore } from '../../storage/stores';
import { ASSISTANT_CSS } from './assistantStyles';
import { contextInvalidated, watchAssistantContext } from './contextLifetime';
import RegistrationAssistant from './RegistrationAssistant';

export const HOST_ID = 'fastlane-registration-assistant';

function Bootstrap({ host }: { host: HTMLElement }) {
    suspendUntilStoresReady([
        FastlaneSettingsStore,
        FastlaneQueueStore,
        FastlaneAuditStore,
        FastlanePlanStore,
        UserScheduleStore,
    ]);
    return <RegistrationAssistant host={host} />;
}

/** Mounts the floating manual-registration assistant in an isolated shadow root. */
export function mountRegistrationAssistant(doc: Document = document): HTMLElement | null {
    if (!doc.body || doc.getElementById(HOST_ID)) return null;
    const host = doc.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = ASSISTANT_CSS;
    const root = doc.createElement('div');
    shadow.append(style, root);
    doc.body.append(host);
    const reactRoot = createRoot(root, {
        onUncaughtError(error) {
            if (contextInvalidated(error)) expire();
            else console.error(error);
        },
    });
    const expire = watchAssistantContext(host, () => reactRoot.unmount());
    reactRoot.render(
        <StrictMode>
            <Suspense fallback={null}>
                <Bootstrap host={host} />
            </Suspense>
        </StrictMode>
    );
    return host;
}
