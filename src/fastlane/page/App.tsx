import { background } from '@shared/messages';
import { OptionsStore } from '@shared/storage/OptionsStore';
import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import { LogoIcon } from '@views/components/common/LogoIcon';
import { switchSchedule, useActiveSchedule, useAllSchedules } from '@views/hooks/useSchedules';
import { Suspense, useEffect } from 'react';
import { suspendUntilStoresReady } from 'src/lib/chrome-extension-toolkit/storage/createStore';
import CalendarDotsIcon from '~icons/ph/calendar-dots';
import DeviceMobileIcon from '~icons/ph/device-mobile';
import GearSixIcon from '~icons/ph/gear-six';
import LightningIcon from '~icons/ph/lightning';
import ListChecksIcon from '~icons/ph/list-checks';
import MapTrifoldIcon from '~icons/ph/map-trifold';
import PlusIcon from '~icons/ph/plus';
import SparkleIcon from '~icons/ph/sparkle';
import type { PlanMeta } from '../core/plans';
import {
    FastlaneAuditStore,
    FastlanePlanStore,
    FastlaneQueueStore,
    FastlaneReminderStore,
    FastlaneSettingsStore,
} from '../storage/stores';
import AuditTab from './AuditTab';
import { useHashRoute, useOnline } from './hooks';
import MapTab from './MapTab';
import PlanTab from './PlanTab';
import RecommendTab from './RecommendTab';
import RegisterTab from './RegisterTab';
import SettingsTab from './SettingsTab';
import WallpaperTab from './WallpaperTab';

const TABS = [
    ['plan', 'Schedule & backups', CalendarDotsIcon],
    ['recommend', 'Recommendations', SparkleIcon],
    ['audit', 'Degree audit', ListChecksIcon],
    ['register', 'Registration prep', LightningIcon],
    ['map', 'Campus map', MapTrifoldIcon],
    ['wallpaper', 'Phone wallpaper', DeviceMobileIcon],
    ['settings', 'Settings & privacy', GearSixIcon],
] as const;

const RESOURCES: Array<[string, string]> = [
    ['Course Schedule', 'https://utdirect.utexas.edu/apps/registrar/course_schedule/'],
    ['My Degree Audit (IDA)', 'https://utdirect.utexas.edu/apps/degree/audits/'],
    ['Registration Info Sheet (RIS)', 'https://utdirect.utexas.edu/registrar/ris.WBX'],
    ['Register for Courses', 'https://utdirect.utexas.edu/registration/chooseSemester.WBX'],
    ['Academic Calendars', 'https://registrar.utexas.edu/calendars'],
];

export function LogoMark({ size = 20 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true'>
            <path d='M4 20 L10 4 h3 L8.5 14 H13 L9 22 Z' fill='#fff' />
            <path d='M14 20 L20 4' stroke='#fff' strokeWidth='2.2' strokeLinecap='round' opacity='0.55' />
        </svg>
    );
}

function Workspace() {
    suspendUntilStoresReady([
        UserScheduleStore,
        OptionsStore,
        FastlaneSettingsStore,
        FastlanePlanStore,
        FastlaneQueueStore,
        FastlaneAuditStore,
        FastlaneReminderStore,
    ]);
    const [tab, params, go] = useHashRoute();
    const theme = FastlaneSettingsStore.useStore(s => s.themePreference);
    const online = useOnline();
    const schedules = useAllSchedules();
    const active = useActiveSchedule();
    const plans = FastlanePlanStore.useStore(st => st.plans ?? {}) as unknown as Record<string, PlanMeta>;

    useEffect(() => {
        if (theme === 'system') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    useEffect(() => {
        document.title = `${TABS.find(t => t[0] === tab)?.[1] ?? 'Fastlane'} · Fastlane Course Planner`;
    }, [tab]);

    return (
        <div className='shell'>
            <aside className='side'>
                <div className='logo'>
                    <LogoIcon className='h-11 w-11' style={{ width: 44, height: 44 }} />
                    <div className='logo-text'>
                        Fastlane
                        <br />
                        Course Planner
                    </div>
                </div>
                <h3>
                    My schedules
                    <button
                        type='button'
                        className='icon-btn'
                        aria-label='New schedule'
                        title='New schedule'
                        onClick={async () => {
                            const name = prompt('Name for the new schedule', 'Backup schedule');
                            if (name) await background.createSchedule({ scheduleName: name });
                        }}
                    >
                        <PlusIcon />
                    </button>
                </h3>
                <div className='sched-list'>
                    {schedules.map(s => (
                        <button
                            key={s.id}
                            type='button'
                            className='sched-item'
                            onClick={() => void switchSchedule(s.id)}
                            aria-pressed={s.id === active?.id}
                        >
                            <span className={`radio ${s.id === active?.id ? 'on' : ''}`} />
                            <span>{s.name}</span>
                            {plans[s.id] && plans[s.id]!.kind !== 'custom' && (
                                <span className='sched-kind'>{plans[s.id]!.kind}</span>
                            )}
                        </button>
                    ))}
                </div>
                <hr />
                <h3>Fastlane</h3>
                <nav className='nav' aria-label='Sections'>
                    {TABS.map(([id, label, Icon]) => (
                        <button
                            key={id}
                            type='button'
                            aria-current={tab === id ? 'page' : undefined}
                            onClick={() => go(id)}
                        >
                            <Icon aria-hidden='true' /> {label}
                        </button>
                    ))}
                </nav>
                <hr />
                <h3>Resources</h3>
                <div className='resources'>
                    {RESOURCES.map(([text, url]) => (
                        <a key={url} href={url} target='_blank' rel='noopener'>
                            {text} ↗
                        </a>
                    ))}
                </div>
                <div className='side-foot'>
                    <span>{online ? 'Online' : 'Offline — cached data only'} · local-only, no tracking</span>
                    <span>Independent student project. Not affiliated with UT Austin.</span>
                    <div className='row'>
                        <span>v{chrome.runtime.getManifest().version}</span>
                        <button
                            type='button'
                            className='icon-btn'
                            aria-label='Settings & privacy'
                            title='Settings & privacy'
                            onClick={() => go('settings')}
                        >
                            <GearSixIcon />
                        </button>
                    </div>
                </div>
            </aside>
            <main className='main'>
                {tab === 'plan' && <PlanTab onNavigate={go} />}
                {tab === 'recommend' && <RecommendTab initialRequirement={params.get('req')} />}
                {tab === 'audit' && <AuditTab onNavigate={go} />}
                {tab === 'register' && <RegisterTab />}
                {tab === 'map' && <MapTab />}
                {tab === 'wallpaper' && <WallpaperTab />}
                {tab === 'settings' && <SettingsTab />}
                <div className='footer-note'>
                    Planning information comes from UT pages you viewed and bundled public datasets. Always verify
                    unique numbers, availability, restrictions and rooms in UT’s official course schedule. Historical
                    grades are not predictions.
                </div>
            </main>
        </div>
    );
}

export default function App() {
    return (
        <Suspense fallback={<div style={{ padding: 32 }}>Loading your plan…</div>}>
            <Workspace />
        </Suspense>
    );
}
