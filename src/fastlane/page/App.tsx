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
    FastlaneAiAccessStore,
    FastlaneAuditStore,
    FastlanePlanStore,
    FastlaneQueueStore,
    FastlaneReminderStore,
    FastlaneSettingsStore,
} from '../storage/stores';
import AiRecommendations from './AiRecommendations';
import AuditTab from './AuditTab';
import { InventoryPanel, InventoryProvider, useInventory } from './CourseInventory';
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

function FindClasses({ initialRequirement }: { initialRequirement?: string | null }) {
    return (
        <InventoryProvider>
            <FindClassesBody initialRequirement={initialRequirement} />
        </InventoryProvider>
    );
}

function FindClassesBody({ initialRequirement }: { initialRequirement?: string | null }) {
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const inventory = useInventory();
    const [subject, setSubject] = useState('');
    // degree view needs either an IDA or a requirement link (e.g. "Find classes for Core 050")
    const canDegree = Boolean(audit || initialRequirement);
    const [view, setView] = useState<'degree' | 'all'>(canDegree ? 'degree' : 'all');
    // where the import panel sits is decided once per visit, so it stays put (with its result) after an import
    const [needsCourseList, setNeedsCourseList] = useState<boolean | null>(null);
    useEffect(() => {
        if (inventory.loaded && needsCourseList === null) setNeedsCourseList(inventory.metas.length === 0);
    }, [inventory.loaded, inventory.metas.length, needsCourseList]);
    const [advancedOpen, setAdvancedOpen] = useState(Boolean(initialRequirement));
    return (
        <div className='stack'>
            <div className='simple-heading'>
                <div>
                    <span className='eyebrow'>YOUR COURSE PLANNER</span>
                    <h1>Find classes</h1>
                    <p>Tell Fastlane the days, times, online classes and degree requirements you want.</p>
                </div>
            </div>
            {/* the planner needs UT's course list; keep the import in view until one exists */}
            {needsCourseList && <InventoryPanel />}
            <AiRecommendations subject={subject} />
            <details
                className='card planner-advanced'
                open={advancedOpen}
                onToggle={e => setAdvancedOpen(e.currentTarget.open)}
            >
                <summary>Browse courses and adjust advanced filters</summary>
                {/* rendered only when opened: the browser and rankings are heavy with a full course list */}
                {advancedOpen && (
                    <div className='stack'>
                        {needsCourseList === false && <InventoryPanel />}
                        <fieldset className='mode-toggle' aria-label='Advanced class view'>
                            <button
                                type='button'
                                aria-pressed={view === 'degree'}
                                disabled={!canDegree}
                                onClick={() => setView('degree')}
                            >
                                For my degree
                            </button>
                            <button type='button' aria-pressed={view === 'all'} onClick={() => setView('all')}>
                                Browse all classes
                            </button>
                        </fieldset>
                        {view === 'degree' && canDegree ? (
                            <RecommendTab
                                initialRequirement={initialRequirement}
                                embedded
                                subject={subject}
                                onSubjectChange={setSubject}
                            />
                        ) : (
                            <FinderTab embedded subject={subject} onSubjectChange={setSubject} />
                        )}
                    </div>
                )}
            </details>
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
        FastlaneAiAccessStore,
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
    const themeChosen = FastlaneSettingsStore.useStore(s => s.themeChosen);
    const online = useOnline();
    const schedules = useAllSchedules();
    const active = useActiveSchedule();

    useEffect(() => {
        // Light is the default; a profile still on the old automatic "System" default moves to Light once.
        // Any theme the student picks from now on (including System) is kept.
        if (!themeChosen && theme === 'system') {
            void FastlaneSettingsStore.set('themePreference', 'light');
            return;
        }
        if (theme === 'system') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', theme ?? 'light');
    }, [theme, themeChosen]);

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
                <label className='side-theme'>
                    <span>Appearance</span>
                    <select
                        aria-label='Appearance theme'
                        value={theme}
                        onChange={e =>
                            void FastlaneSettingsStore.set({
                                themePreference: e.target.value as 'system' | 'light' | 'dark',
                                themeChosen: true,
                            } as never)
                        }
                    >
                        <option value='system'>System</option>
                        <option value='light'>Light</option>
                        <option value='dark'>Dark</option>
                    </select>
                </label>
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
                {current === 'finder' && <FindClasses initialRequirement={params.get('req')} />}
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
