import { background } from '@shared/messages';
import { OptionsStore } from '@shared/storage/OptionsStore';
import { UserScheduleStore } from '@shared/storage/UserScheduleStore';
import { switchSchedule, useActiveSchedule, useAllSchedules } from '@views/hooks/useSchedules';
import { Suspense, useEffect, useState } from 'react';
import { suspendUntilStoresReady } from 'src/lib/chrome-extension-toolkit/storage/createStore';
import CalendarDotsIcon from '~icons/ph/calendar-dots';
import GearSixIcon from '~icons/ph/gear-six';
import LightningIcon from '~icons/ph/lightning';
import ListChecksIcon from '~icons/ph/list-checks';
import PlusIcon from '~icons/ph/plus';
import SparkleIcon from '~icons/ph/sparkle';
import {
    FastlaneAuditStore,
    FastlanePlanStore,
    FastlaneQueueStore,
    FastlaneReminderStore,
    FastlaneSettingsStore,
} from '../storage/stores';
import AiRecommendations from './AiRecommendations';
import AuditTab from './AuditTab';
import { useHashRoute, useOnline } from './hooks';
import { FinderTab, HomeTab } from './PlanningTools';
import PlanTab from './PlanTab';
import RecommendTab from './RecommendTab';
import RegisterTab from './RegisterTab';
import SettingsTab from './SettingsTab';

const TABS = [
    ['home', 'Overview', SparkleIcon],
    ['finder', 'Find classes', ListChecksIcon],
    ['plan', 'My schedule', CalendarDotsIcon],
    ['audit', 'Degree progress', ListChecksIcon],
] as const;

function FindClasses({
    initialRequirement,
    forceRecommended = false,
}: {
    initialRequirement?: string | null;
    forceRecommended?: boolean;
}) {
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const [mode, setMode] = useState<'recommended' | 'all'>(audit || forceRecommended ? 'recommended' : 'all');
    const [subject, setSubject] = useState('');
    return (
        <div className='stack'>
            <div className='simple-heading'>
                <div>
                    <span className='eyebrow'>YOUR COURSE SEARCH</span>
                    <h1>Find classes</h1>
                    <p>Find sections that fit your degree, week and grade preferences.</p>
                </div>
            </div>
            <AiRecommendations subject={subject} />
            <fieldset className='mode-toggle' aria-label='Class finder view'>
                <button type='button' aria-pressed={mode === 'recommended'} onClick={() => setMode('recommended')}>
                    For my degree
                </button>
                <button type='button' aria-pressed={mode === 'all'} onClick={() => setMode('all')}>
                    Browse all classes
                </button>
            </fieldset>
            {mode === 'recommended' ? (
                <RecommendTab initialRequirement={initialRequirement} embedded subject={subject} onSubjectChange={setSubject} />
            ) : (
                <FinderTab embedded subject={subject} onSubjectChange={setSubject} />
            )}
        </div>
    );
}

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
    const current = ['home', 'finder', 'plan', 'audit', 'register', 'settings'].includes(tab)
        ? tab
        : ((
              {
                  recommend: 'finder',
                  generate: 'finder',
                  compare: 'plan',
                  roadmap: 'audit',
                  history: 'plan',
                  map: 'home',
                  wallpaper: 'home',
              } as Record<string, string>
          )[tab] ?? 'home');
    const theme = FastlaneSettingsStore.useStore(s => s.themePreference);
    const online = useOnline();
    const schedules = useAllSchedules();
    const active = useActiveSchedule();

    useEffect(() => {
        if (theme === 'system') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    useEffect(() => {
        document.title = `${TABS.find(t => t[0] === current)?.[1] ?? 'Fastlane'} · Fastlane Course Planner`;
    }, [current]);

    return (
        <div className='shell'>
            <aside className='side'>
                <div className='logo'>
                    <div className='logo-text'>FastLane</div>
                </div>
                <div className='schedule-header'>
                    <label htmlFor='active-schedule'>CURRENT SCHEDULE</label>
                    <button
                        type='button'
                        className='icon-btn'
                        aria-label='New schedule'
                        title='New schedule'
                        onClick={async () => {
                            const name = prompt('Name for the new schedule', 'Backup schedule');
                            if (name?.trim()) await background.createSchedule({ scheduleName: name.trim() });
                        }}
                    >
                        <PlusIcon />
                    </button>
                </div>
                <select
                    id='active-schedule'
                    className='active-schedule-select'
                    value={active?.id ?? ''}
                    onChange={e => void switchSchedule(e.target.value)}
                >
                    {schedules.map(s => (
                        <option key={s.id} value={s.id}>
                            {s.name} · {s.courses.length} classes
                        </option>
                    ))}
                </select>
                <hr />
                <div className='nav-label'>PLANNER</div>
                <nav className='nav' aria-label='Sections'>
                    {TABS.map(([id, label, Icon]) => (
                        <button
                            key={id}
                            type='button'
                            aria-current={current === id ? 'page' : undefined}
                            onClick={() => go(id)}
                        >
                            <Icon aria-hidden='true' /> {label}
                        </button>
                    ))}
                </nav>
                <div className='sidebar-utilities'>
                    <button type='button' className='utility-link' onClick={() => go('register')}>
                        <LightningIcon aria-hidden='true' /> Registration prep
                    </button>
                    <a
                        className='utility-link'
                        href='https://utdirect.utexas.edu/apps/registrar/course_schedule/'
                        target='_blank'
                        rel='noopener noreferrer'
                    >
                        UT course schedule ↗
                    </a>
                    <a
                        className='utility-link'
                        href='https://utdirect.utexas.edu/apps/degree/audits/'
                        target='_blank'
                        rel='noopener noreferrer'
                    >
                        Open my IDA ↗
                    </a>
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
                {current === 'home' && <HomeTab go={go} />}
                {current === 'finder' && (
                    <FindClasses initialRequirement={params.get('req')} forceRecommended={tab === 'recommend'} />
                )}
                {current === 'plan' && <PlanTab onNavigate={go} />}
                {current === 'audit' && <AuditTab onNavigate={go} />}
                {current === 'register' && <RegisterTab />}
                {current === 'settings' && <SettingsTab />}
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
