/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_PACKAGE_VERSION: string;
    readonly VITE_SENTRY_ENVIRONMENT: string;
    readonly VITE_BETA_BUILD?: 'true';
    /** local builds from update-fastlane.sh: self-reload when a newly synced build lands in the folder */
    readonly VITE_FASTLANE_DEV_AUTORELOAD?: 'true';
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
