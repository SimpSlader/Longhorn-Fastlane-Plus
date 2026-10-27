import { defineManifest } from '@crxjs/vite-plugin';

import packageJson from '../package.json';

// Convert from Semver (example: 0.1.0-beta6)
const [major, minor, patch, label = '0'] = packageJson.version
    // can only contain digits, dots, or dash
    .replace(/[^\d.-]+/g, '')
    // split into version parts
    .split(/[.-]/);

const isBeta = !!process.env.BETA;

if (isBeta && process.env.NODE_ENV !== 'production') throw new Error('Cannot have beta non-production build');

// Fastlane: only UT pages the extension enhances. Upstream's login.utexas.edu match was removed so no
// script ever runs on UT's sign-in page.
const HOST_PERMISSIONS: string[] = [
    'https://utdirect.utexas.edu/apps/degree/audits/results/*',
    '*://*.utdirect.utexas.edu/apps/registrar/course_schedule/*',
    '*://*.utdirect.utexas.edu/registration/*',
    '*://*.utexas.collegescheduler.com/*',
    '*://*.catalog.utexas.edu/ribbit/',
    '*://*.registrar.utexas.edu/schedules/*',
    'https://*.bluera.com/rpvlf.aspx*',
    '*://my.utexas.edu/student/*',
];

// Network access is used only by Fastlane's opt-in AI panel; content scripts still run on UT pages only.
const AI_API_HOST_PERMISSION = 'https://longhorn-fastlane-plus.vercel.app/*';
// Public professor ratings shown next to grades; only professor names are sent, from the background worker.
const RMP_HOST_PERMISSION = 'https://www.ratemyprofessors.com/*';

const manifest = defineManifest(async env => {
    const isDev = env.mode === 'development';
    const mode = isBeta ? 'beta' : isDev ? 'development' : 'production';
    const nameSuffix = isBeta ? ' (beta)' : isDev ? ' (dev)' : '';

    return {
        manifest_version: 3,
        name: `${packageJson.displayName ?? packageJson.name}${nameSuffix}`,
        short_name: 'Fastlane Plus',
        version: `${major}.${minor}.${patch}.${label}`,
        description: packageJson.description,
        options_page: 'src/pages/options/index.html',
        background: { service_worker: 'src/pages/background/background.ts' },
        // Fastlane: 'background' removed (not needed in MV3); alarms + notifications power local reminders
        permissions: [
            'storage',
            'unlimitedStorage',
            'scripting',
            'alarms',
            'notifications',
            ...(isDev ? (['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'] as const) : []),
        ],
        host_permissions: isDev
            ? [...HOST_PERMISSIONS, AI_API_HOST_PERMISSION, RMP_HOST_PERMISSION, '<all_urls>']
            : [...HOST_PERMISSIONS, AI_API_HOST_PERMISSION, RMP_HOST_PERMISSION],
        optional_host_permissions: [
            'https://api.groq.com/*',
            'https://generativelanguage.googleapis.com/*',
            'https://api.cloudflare.com/*',
        ],
        action: {
            default_popup: 'src/pages/popup/index.html',
            default_icon: `icons/icon_${mode}_32.png`,
        },
        icons: {
            '16': `icons/icon_${mode}_16.png`,
            '32': `icons/icon_${mode}_32.png`,
            '48': `icons/icon_${mode}_48.png`,
            '128': `icons/icon_${mode}_128.png`,
        },
        content_scripts: [
            {
                matches: HOST_PERMISSIONS,
                js: ['src/pages/content/index.tsx'],
            },
        ],
        web_accessible_resources: [
            {
                resources: ['assets/js/*.js', 'assets/css/*.css', 'assets/img/*', 'assets/*.wasm', 'database/*'],
                // Fastlane: only UT pages may load these (upstream exposed them to every site)
                matches: ['*://*.utexas.edu/*', '*://*.utexas.collegescheduler.com/*', 'https://*.bluera.com/*'],
            },
        ],
        content_security_policy: {
            extension_pages: isDev
                ? "script-src 'self' 'wasm-unsafe-eval' http://localhost:*; object-src 'self'; frame-src https://*.sentry.io"
                : "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        },
    };
});

export default manifest;
