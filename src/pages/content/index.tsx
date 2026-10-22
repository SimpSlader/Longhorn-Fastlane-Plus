import { OptionsStore } from '@shared/storage/OptionsStore';
import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import CourseCatalogMain from '@views/components/CourseCatalogMain';
import InjectedButton from '@views/components/injected/AddAllButton';
import DaysCheckbox from '@views/components/injected/DaysCheckbox';
import ShadedResults from '@views/components/injected/SearchResultShader';
import getSiteSupport, { SiteSupport } from '@views/lib/getSiteSupport';
import React, { Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mountAuditImport } from 'src/fastlane/injected/auditImport';
import { mountRegistrationAssistant } from 'src/fastlane/injected/registration/mount';
import { showStaleTabNotice } from 'src/fastlane/injected/staleTabNotice';
import {
    checkExtensionContext,
    installExtensionLifecycleGuards,
    isContextInvalidatedError,
    onExtensionContextInvalidated,
} from 'src/fastlane/services/extensionContext';
import { pingDevAutoReload } from 'src/fastlane/services/runtime';
import { FastlanePlanStore, FastlaneSettingsStore } from 'src/fastlane/storage/stores';
import { suspendUntilStoresReady } from 'src/lib/chrome-extension-toolkit/storage/createStore';

const support = getSiteSupport(window.location.href);

// local builds: refreshing a UT page also picks up a freshly synced extension build
pingDevAutoReload();

// Uncaught lifecycle errors from stale code are expected after an extension reload; everything else surfaces.
installExtensionLifecycleGuards();

const mountedRoots: Array<{ root: Root; container: HTMLElement }> = [];

const renderComponent = (Component: React.ComponentType) => {
    const container = document.createElement('div');
    container.id = 'extension-root';
    document.body.appendChild(container);

    const root = createRoot(container, {
        onUncaughtError(error) {
            if (isContextInvalidatedError(error)) checkExtensionContext();
            else console.error(error);
        },
    });
    mountedRoots.push({ root, container });
    root.render(
        <React.StrictMode>
            <Suspense fallback={null}>
                <Component />
            </Suspense>
        </React.StrictMode>
    );
};

function AddAllButtonBootstrap() {
    suspendUntilStoresReady([UserScheduleStore]);

    return <InjectedButton />;
}

if (support === SiteSupport.COURSE_CATALOG_DETAILS || support === SiteSupport.COURSE_CATALOG_LIST) {
    renderComponent(() => {
        suspendUntilStoresReady([UserScheduleStore, OptionsStore, FastlaneSettingsStore, FastlanePlanStore]);

        return <CourseCatalogMain support={support} />;
    });
}

if (support === SiteSupport.MY_UT) {
    renderComponent(AddAllButtonBootstrap);
}

if (support === SiteSupport.COURSE_CATALOG_SEARCH) {
    renderComponent(DaysCheckbox);
}

if (support === SiteSupport.COURSE_CATALOG_KWS) {
    renderComponent(ShadedResults);
}

if (support === SiteSupport.REGISTRATION) {
    mountRegistrationAssistant();
}

mountAuditImport();

// After an extension reload/update this tab still runs the old script. Stop all extension-dependent UI
// (it can no longer read or save anything), leave UT's own page untouched, and offer a manual refresh.
onExtensionContextInvalidated(() => {
    for (const { root, container } of mountedRoots.splice(0)) {
        try {
            root.unmount();
        } catch (error) {
            console.debug('[Fastlane] stale UI cleanup', error);
        }
        container.remove();
    }
    document.getElementById('fastlane-ida')?.remove();
    // the registration assistant shows its own notice in place
    if (support !== SiteSupport.REGISTRATION) showStaleTabNotice();
});
