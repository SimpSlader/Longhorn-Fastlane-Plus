/**
 * Offline demonstration page (chrome-extension://…/demo.html).
 * Mounts the REAL listing integration and registration assistant over local fixtures, so everything
 * can be tried without signing in to UT. Nothing here contacts UT.
 */

import { OptionsStore } from '@shared/storage/OptionsStore';
import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import { UserSchedule } from '@shared/types/UserSchedule';
import { getCourseColors } from '@shared/util/colors';
import CourseCatalogMain from '@views/components/CourseCatalogMain';
import { CourseCatalogScraper } from '@views/lib/CourseCatalogScraper';
import getCourseTableRows from '@views/lib/getCourseTableRows';
import { SiteSupport } from '@views/lib/getSiteSupport';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { analyzeRow, sectionFromCourse } from 'src/fastlane/adapters/utrp';
import { addBackup, addSlot, emptyPlan } from 'src/fastlane/core/plans';
import { mountRegistrationAssistant } from 'src/fastlane/injected/registration/mount';
import { defaultRequirement } from 'src/fastlane/services/planService';
import { FastlaneAuditStore, FastlanePlanStore, FastlaneSettingsStore } from 'src/fastlane/storage/stores';
import { suspendUntilStoresReady } from 'src/lib/chrome-extension-toolkit/storage/createStore';

import { ADD_DROP_FORM_HTML, courseScheduleTableHtml, DEMO_SEMESTER_CODE } from './fixture';

const DEMO_URL = `https://utdirect.utexas.edu/apps/registrar/course_schedule/${DEMO_SEMESTER_CODE}/results/?demo=1`;
const DEMO_NAME = 'Fastlane demo (Ideal)';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

$('listing').innerHTML = courseScheduleTableHtml();
$('addDrop').innerHTML = ADD_DROP_FORM_HTML;

function scrapeDemo() {
    const scraper = new CourseCatalogScraper(SiteSupport.COURSE_CATALOG_LIST, document, DEMO_URL);
    return scraper.scrape(getCourseTableRows(document)).filter(r => r.course);
}

async function setupDemoSchedule() {
    const rows = scrapeDemo();
    const pick = (id: number) => rows.find(r => r.course!.uniqueId === id)!;
    const active = [65555, 53780, 23100].map(pick);
    // distinct course colors, as UT Registration Plus assigns them
    const colorways = ['indigo', 'red', 'sky', 'teal', 'emerald'] as const;
    for (const id of [65555, 53780, 23100, 33505, 23095]) {
        pick(id).course!.colors = getCourseColors(colorways[[65555, 53780, 23100, 33505, 23095].indexOf(id)]!, 500);
    }
    const schedules = await UserScheduleStore.get('schedules');
    const withoutDemo = schedules.filter(s => s.name !== DEMO_NAME);
    const schedule = new UserSchedule({
        id: `fastlane-demo-${Date.now().toString(36)}`,
        name: DEMO_NAME,
        courses: active.map(r => r.course!) as never,
        hours: 0,
        updatedAt: Date.now(),
    });
    await UserScheduleStore.set('schedules', [...withoutDemo, schedule] as never);
    await UserScheduleStore.set('activeIndex', withoutDemo.length);
    // plan: the arts slot gets two ranked backups that never count until activated
    let plan = emptyPlan(schedule.id, 'ideal');
    for (const r of active) {
        const section = sectionFromCourse(r.course!, analyzeRow(r.element));
        plan = addSlot(plan, section, defaultRequirement(section));
    }
    const arts = plan.slots.find(s => s.activeUniqueId === 23100)!;
    for (const id of [33505, 23095]) {
        const r = pick(id);
        plan = addBackup(plan, arts.id, sectionFromCourse(r.course!, analyzeRow(r.element)));
    }
    const plans = (await FastlanePlanStore.get('plans')) as Record<string, unknown>;
    await FastlanePlanStore.set('plans', { ...plans, [schedule.id]: plan } as never);
    $('setupStatus').textContent =
        `Created “${DEMO_NAME}” with UGS 302, M 408C and MUS 302L (live online), plus two ranked backups. Rows that overlap it are now struck through.`;
}

async function removeDemoSchedule() {
    const schedules = await UserScheduleStore.get('schedules');
    const remaining = schedules.filter(s => s.name !== DEMO_NAME);
    await UserScheduleStore.set('schedules', (remaining.length ? remaining : schedules.slice(0, 1)) as never);
    await UserScheduleStore.set('activeIndex', 0);
    $('setupStatus').textContent = 'Demo schedule removed.';
}

$('setupDemo').addEventListener('click', () => void setupDemoSchedule());
$('removeDemo').addEventListener('click', () => void removeDemoSchedule());

// ---- simulated UT result messages (the assistant never triggers these) ----
const result = () => $('message');
const unique = () => ($<HTMLInputElement>('s_unique_add').value || 'the requested class').trim();
$('demo-add-drop').addEventListener('submit', e => {
    e.preventDefault();
    result().className = 'ok';
    result().textContent = `You have added ${unique()} to your schedule.`;
});
for (const [id, cls, text] of [
    ['simFull', 'bad', (u: string) => `Requested class ${u} is filled to closing limit.`],
    ['simConflict', 'bad', (u: string) => `Time conflict: ${u} conflicts with another class on your schedule.`],
    ['simRestricted', 'bad', (u: string) => `Unique ${u} is restricted to certain majors.`],
] as const) {
    $(id).addEventListener('click', () => {
        result().className = cls;
        result().textContent = text(unique());
    });
}
$('simClear').addEventListener('click', () => {
    result().className = '';
    result().textContent = '';
});

// ---- mount the real components ----
function ListingBootstrap() {
    // the listing toolbar reads the imported IDA; every store a component reads must be loaded first
    suspendUntilStoresReady([
        UserScheduleStore,
        OptionsStore,
        FastlaneSettingsStore,
        FastlanePlanStore,
        FastlaneAuditStore,
    ]);
    return <CourseCatalogMain support={SiteSupport.COURSE_CATALOG_LIST} pageUrl={DEMO_URL} disableAutoLoad />;
}

const container = document.createElement('div');
document.body.append(container);
createRoot(container).render(
    <StrictMode>
        <Suspense fallback={null}>
            <ListingBootstrap />
        </Suspense>
    </StrictMode>
);
mountRegistrationAssistant(document);
