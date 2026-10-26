import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { legs, splitLocation, stopsForDay, walkingDirectionsUrl } from '../core/campus';
import { defaultQueue } from '../core/queue';
import { defaultReminderConfig } from '../core/reminders';
import { coreTagFromListing } from '../core/requirements';
import { sectionFixture } from './factories';

vi.mock('@shared/storage/UserScheduleStore', () => ({ UserScheduleStore: {} }));
vi.mock('../storage/stores', () => ({
    DEFAULT_SETTINGS: {
        gradeThreshold: 'A-',
        autofill: { enabled: false, paused: false, preserveNonEmpty: true },
        passiveDetection: false,
    },
    FASTLANE_LOCAL_PREFIXES: [],
    FASTLANE_SYNC_PREFIXES: [],
}));
vi.mock('../data/idb', () => ({ idbClearAll: vi.fn() }));

const root = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('upstream integration points (fail loudly if an upstream merge drops a Fastlane hook)', () => {
    const hooks: Array<[string, RegExp[]]> = [
        ['src/views/components/injected/TableRow/TableRow.tsx', [/RowInsights/, /detectConflicts/, /styles\.isAsync/]],
        ['src/views/components/CourseCatalogMain.tsx', [/CatalogHeader/, /useCacheVisibleSections/]],
        ['src/views/lib/database/initializeDB.ts', [/loadGradesOverride/, /setActiveGradeDataset/]],
        ['src/views/lib/getSiteSupport.ts', [/REGISTRATION/, /isRegistrationScreen/]],
        ['src/pages/content/index.tsx', [/mountRegistrationAssistant/, /FastlaneSettingsStore/]],
        ['src/pages/background/background.ts', [/registerFastlaneBackground/]],
        ['src/views/lib/CourseCatalogScraper.ts', [/skipped unparseable meeting/]],
        ['src/shared/sentry.ts', [/enabled: !!FASTLANE_SENTRY_DSN/]],
        ['src/shared/storage/OptionsStore.ts', [/enableDataRefreshing: false/]],
        ['src/manifest.ts', [/'alarms'/, /'notifications'/]],
        ['src/views/components/calendar/Calendar.tsx', [/if \(enableDataRefreshing\) void refreshCourses/]],
        ['src/views/lib/getGitHubStats.ts', [/https:\/\/api\.github\.com/]],
        ['src/views/components/injected/CourseCatalogInjectedPopup/GradeDistribution.tsx', [/GradeBarChart/]],
    ];
    for (const [file, patterns] of hooks) {
        it(file, () => {
            const text = read(file);
            for (const p of patterns) expect(text, `${file} should match ${p}`).toMatch(p);
        });
    }

    it('no third-party fonts, CDNs, proxies or Highcharts remain', () => {
        expect(read('src/views/styles/fonts.module.scss')).not.toMatch(/fonts\.googleapis\.com/);
        expect(read('src/views/lib/getGitHubStats.ts')).not.toMatch(/cachedapi/);
        expect(read('src/pages/calendar/CalendarMain.tsx')).not.toMatch(/<WhatsNewDialog/);
        expect(read('package.json')).not.toMatch(/highcharts/);
    });

    it('no upstream telemetry DSN or login-page host remains in source', () => {
        expect(read('src/shared/sentry.ts')).not.toMatch(/ingest\.us\.sentry\.io/);
        expect(read('src/manifest.ts')).not.toMatch(/login\.utexas\.edu\/login/);
    });

    it('the content script never submits forms or clicks registration buttons', () => {
        for (const file of [
            'src/fastlane/injected/registration/RegistrationAssistant.tsx',
            'src/fastlane/core/autofill.ts',
            'src/fastlane/injected/RowInsights.tsx',
        ]) {
            const text = read(file);
            expect(text, file).not.toMatch(
                /\.submit\(|requestSubmit\(|\.click\(\)|dispatchEvent\(new (Mouse|Keyboard|Submit)Event/
            );
            expect(text, file).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
        }
    });

    it('bundled dataset manifest matches the shipped database', () => {
        const manifest = JSON.parse(read('src/fastlane/data/bundled-datasets.json'));
        const db = readFileSync(join(root, 'src/assets/database/grade_distributions.db'));
        expect(manifest.datasets[0].bytes).toBe(db.length);
        expect(db.subarray(0, 15).toString()).toBe('SQLite format 3');
    });
});

describe('registration page detection', async () => {
    const { isRegistrationScreen } = await import('@views/lib/getSiteSupport');
    it('matches UT add/drop screens only', () => {
        expect(isRegistrationScreen('https://utdirect.utexas.edu/registration/registration.WBX?s_ccyys=20272')).toBe(
            true
        );
        expect(isRegistrationScreen('https://utdirect.utexas.edu/registration/chooseSemester.WBX')).toBe(true);
        expect(isRegistrationScreen('https://utdirect.utexas.edu/registration/classlist.WBX')).toBe(false);
        expect(isRegistrationScreen('https://login.utexas.edu/login/UI/Login')).toBe(false);
        expect(isRegistrationScreen('https://evil.example.com/registration/registration.WBX')).toBe(false);
    });
});

describe('campus map stops', () => {
    const ugs = sectionFixture(1, 'UGS 302', { times: [['MWF', '9:00 a.m.-10:00 a.m.', 'GEA 105']] });
    const calc = sectionFixture(2, 'M 408C', {
        times: [
            ['MWF', '10:00 a.m.-11:00 a.m.', 'RLP 0.102'],
            ['TTH', '11:00 a.m.-12:30 p.m.', 'PMA 5.104'],
        ],
    });
    const live = sectionFixture(3, 'MUS 302L', { times: [['MW', '1:00 p.m.-2:30 p.m.', 'WB']] });

    it('groups by weekday in time order with building-level locations', () => {
        const mon = stopsForDay([live, calc, ugs], 'M');
        expect(mon.map(s => [s.order, s.section.courseCode, s.building])).toEqual([
            [1, 'UGS 302', 'GEA'],
            [2, 'M 408C', 'RLP'],
            [3, 'MUS 302L', undefined],
        ]);
        expect(stopsForDay([live, calc, ugs], 'T').map(s => s.section.courseCode)).toEqual(['M 408C']);
    });

    it('builds legs only between different physical buildings and reports gaps', () => {
        expect(
            legs(stopsForDay([live, calc, ugs], 'M')).map(l => [l.from.building, l.to.building, l.gapMinutes])
        ).toEqual([['GEA', 'RLP', 0]]);
        expect(splitLocation('WB')).toEqual({});
        expect(walkingDirectionsUrl('GEARING HALL', 'PATTON HALL')).toMatch(
            /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&travelmode=walking/
        );
    });

    it('maps bare core codes from listings', () => {
        expect(coreTagFromListing('050')).toBe('CORE 050');
        expect(coreTagFromListing('(093)')).toBe('CORE 093');
        expect(coreTagFromListing('999')).toBeNull();
    });
});

describe('export / import validation', async () => {
    const { validateExport, ImportError, EXPORT_FORMAT } = await import('../services/privacy');
    const good = {
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: '2026-10-21',
        schedules: [{ name: 'Ideal', courses: [] }],
        activeIndex: 0,
        plans: { a: { scheduleId: 'a', kind: 'ideal', slots: [], updatedAt: 0 } },
        queue: defaultQueue(),
        reminders: defaultReminderConfig(),
        settings: { gradeThreshold: 'B+' },
    };

    it('accepts a valid export and merges settings onto defaults', () => {
        const v = validateExport(JSON.parse(JSON.stringify(good)));
        expect(v.settings.gradeThreshold).toBe('B+');
        expect(v.settings.passiveDetection).toBe(false);
    });

    it('rejects foreign or malformed files', () => {
        expect(() => validateExport({ format: 'other' })).toThrow(ImportError);
        expect(() => validateExport({ ...good, version: 2 })).toThrow(ImportError);
        expect(() => validateExport({ ...good, schedules: [{ name: 1 }] })).toThrow(ImportError);
        expect(() => validateExport({ ...good, queue: { version: 1 } })).toThrow(ImportError);
        expect(() => validateExport({ ...good, plans: { a: { slots: 'x' } } })).toThrow(ImportError);
    });
});
