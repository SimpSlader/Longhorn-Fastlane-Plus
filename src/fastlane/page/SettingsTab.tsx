import { useEffect, useState } from 'react';

import { GRADE_THRESHOLDS } from '../core/grades';
import { BUNDLED_GRADE_DATASET } from '../data/activeGradeDataset';
import bundled from '../data/bundled-datasets.json';
import type { InstalledDataset, UpdateReport } from '../data/datasets';
import { isStale } from '../data/datasets';
import { idbDatasetStore } from '../data/idb';
import { dataManifestConfig } from '../services/dataConfig';
import { deleteEverything, deleteFastlaneData, exportAll, importAll, validateExport } from '../services/privacy';
import { sendFastlane } from '../services/runtime';
import type { FastlaneSettings } from '../storage/stores';
import { FastlaneSettingsStore } from '../storage/stores';
import { downloadText, PageHead } from './common';
import { useOnline } from './hooks';

function Toggle({ k, label, help }: { k: keyof FastlaneSettings; label: string; help?: string }) {
    const value = FastlaneSettingsStore.useStore(s => s[k]) as boolean;
    return (
        <label className='check'>
            <input
                type='checkbox'
                checked={value}
                onChange={e => void FastlaneSettingsStore.set(k, e.target.checked as never)}
            />
            <span>
                {label}
                {help && <small>{help}</small>}
            </span>
        </label>
    );
}

export default function SettingsTab() {
    const settings = FastlaneSettingsStore.useStore(s => s);
    const online = useOnline();
    const cfg = dataManifestConfig();
    const [installed, setInstalled] = useState<InstalledDataset | null>(null);
    const [meta, setMeta] = useState<{ lastCheckedAt?: number; lastError?: string }>({});
    const [report, setReport] = useState<UpdateReport | null>(null);
    const [includeAudit, setIncludeAudit] = useState(false);
    const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);

    const refresh = () => {
        void idbDatasetStore.getInstalled('grades').then(setInstalled);
        void idbDatasetStore.getMeta().then(setMeta);
    };
    useEffect(refresh, []);

    const grades = bundled.datasets[0]!;
    const activeVersion =
        installed?.origin === 'downloaded' ? installed.descriptor.version : BUNDLED_GRADE_DATASET.version;
    const activeDate =
        installed?.origin === 'downloaded'
            ? installed.descriptor.publishedAt.slice(0, 10)
            : BUNDLED_GRADE_DATASET.updated;
    const stale = isStale({ publishedAt: `${activeDate}T00:00:00Z` } as never);

    return (
        <div className='stack'>
            <PageHead
                title='Settings & privacy'
                subtitle='Everything is stored in this browser. No account, no backend, no analytics.'
            />
            <div className='grid2'>
                <div className='card stack'>
                    <h2>Course listing</h2>
                    <label className='field'>
                        Grade percentage threshold (applies everywhere)
                        <select
                            value={settings.gradeThreshold}
                            onChange={e => void FastlaneSettingsStore.set('gradeThreshold', e.target.value as never)}
                        >
                            {GRADE_THRESHOLDS.map(t => (
                                <option key={t} value={t}>
                                    {t} or better
                                </option>
                            ))}
                        </select>
                    </label>
                    <Toggle k='showInlineGrades' label='Show grade percentages beside the grade graph button' />
                    <Toggle
                        k='showProfessorRatings'
                        label='Show Rate My Professors ratings (sends only professor names to ratemyprofessors.com)'
                    />
                    <Toggle
                        k='highlightAsync'
                        label='Color online course text blue'
                        help='Both live and asynchronous online course rows use blue text; asynchronous sections also have a light blue background.'
                    />
                    <Toggle k='showConflictDetails' label='Show which planned class causes each conflict' />
                    <label className='field'>
                        Appearance
                        <select
                            value={settings.themePreference}
                            onChange={e =>
                                void FastlaneSettingsStore.set({
                                    themePreference: e.target.value as never,
                                    themeChosen: true,
                                } as never)
                            }
                        >
                            <option value='system'>Match system</option>
                            <option value='light'>Light</option>
                            <option value='dark'>Dark</option>
                        </select>
                    </label>
                </div>
                <div className='card stack'>
                    <h2>Data sources</h2>
                    <div className='small'>
                        <b>Historical grades:</b> {activeVersion} (
                        {installed?.origin === 'downloaded' ? 'downloaded update' : 'bundled'}), updated {activeDate}.
                        Covers {grades.firstSemester} – {grades.latestSemester}. {grades.source}.
                    </div>
                    {stale && (
                        <div className='notice warn small'>
                            This grade dataset is more than 200 days old. Newer semesters may be missing.
                        </div>
                    )}
                    <div className='small'>
                        <b>Course sections:</b> saved from UT course schedule pages you open. Seat status is shown only
                        with the time it was seen.
                    </div>
                    <Toggle
                        k='dataUpdates'
                        label='Check for newer public datasets (at most once a day)'
                        help={
                            cfg.manifestUrl
                                ? `Source: ${cfg.manifestUrl}`
                                : 'No update source is configured in this build, so only bundled data is used.'
                        }
                    />
                    <div className='row'>
                        <button
                            type='button'
                            className='btn sm'
                            disabled={!cfg.manifestUrl || !online || !settings.dataUpdates}
                            onClick={() =>
                                void sendFastlane<UpdateReport>({ type: 'checkDataUpdates', force: true }).then(r => {
                                    setReport(r);
                                    refresh();
                                })
                            }
                        >
                            Check now
                        </button>
                        <span className='small muted'>
                            {online ? 'Online' : 'Offline'}
                            {meta.lastCheckedAt
                                ? ` · last checked ${new Date(meta.lastCheckedAt).toLocaleString()}`
                                : ''}
                        </span>
                    </div>
                    {report && (
                        <div className={`notice small ${report.errors.length ? 'warn' : 'ok'}`}>
                            {report.skippedReason
                                ? `Skipped (${report.skippedReason}).`
                                : report.installed.length
                                  ? `Installed ${report.installed.map(i => `${i.id} ${i.version}`).join(', ')}. Reload UT pages to use it.`
                                  : 'Already up to date.'}{' '}
                            {report.errors.join('; ')} {report.errors.length ? 'Previous data is still in use.' : ''}
                        </div>
                    )}
                </div>
            </div>
            <div className='card stack'>
                <h2>Your data</h2>
                <p className='small muted' style={{ margin: 0 }}>
                    Schedules, backups, your registration queue, reminders and any imported degree audit stay in this
                    Chrome profile. Fastlane never sends your EID, grades, audit, or registration information to any
                    server, and it does not collect browsing history or credentials.
                </p>
                <div className='row'>
                    <button
                        type='button'
                        className='btn'
                        onClick={async () => {
                            const data = await exportAll(includeAudit);
                            downloadText(
                                JSON.stringify(data, null, 2),
                                `fastlane-export-${new Date().toISOString().slice(0, 10)}.json`
                            );
                        }}
                    >
                        Export schedules & plans (JSON)
                    </button>
                    <label className='check small'>
                        <input
                            type='checkbox'
                            checked={includeAudit}
                            onChange={e => setIncludeAudit(e.target.checked)}
                        />
                        Include degree audit
                    </label>
                    <label className='btn'>
                        Import JSON…
                        <input
                            type='file'
                            accept='application/json,.json'
                            className='sr-only'
                            onChange={async e => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                try {
                                    const data = validateExport(JSON.parse(await file.text()));
                                    if (
                                        !confirm(
                                            `Replace your current schedules and plans with the ${data.schedules.length} schedule(s) in this file?`
                                        )
                                    )
                                        return;
                                    await importAll(data);
                                    setStatus({ text: 'Imported.', tone: 'ok' });
                                } catch (err) {
                                    setStatus({ text: (err as Error).message, tone: 'bad' });
                                }
                                e.target.value = '';
                            }}
                        />
                    </label>
                </div>
                <div className='row'>
                    <button
                        type='button'
                        className='btn danger'
                        onClick={async () => {
                            if (
                                !confirm(
                                    'Delete all Fastlane data (backups, queue, audit, reminders, cached sections)? UT Registration Plus schedules are kept.'
                                )
                            )
                                return;
                            await deleteFastlaneData();
                            setStatus({ text: 'Fastlane data deleted.', tone: 'ok' });
                        }}
                    >
                        Delete Fastlane data
                    </button>
                    <button
                        type='button'
                        className='btn danger'
                        onClick={async () => {
                            if (
                                !confirm(
                                    'Delete EVERYTHING this extension stored, including all schedules? This cannot be undone.'
                                )
                            )
                                return;
                            await deleteEverything();
                            setStatus({ text: 'All locally saved information was deleted.', tone: 'ok' });
                        }}
                    >
                        Delete all saved information
                    </button>
                </div>
                {status && <div className={`notice small ${status.tone}`}>{status.text}</div>}
            </div>
            <div className='card small muted'>
                Fastlane Course Planner is an independent, student-developed project. It is not affiliated with,
                endorsed by, or approved by The University of Texas at Austin or the UT Registration Plus team. It is
                built on UT Registration Plus (MIT License, © Sriram Hariharan and contributors) and uses ideas from
                Degree Audit Plus (MIT License, © Longhorn Developers). See{' '}
                <a href={chrome.runtime.getURL('THIRD_PARTY_NOTICES.txt')}>third-party notices</a>.
            </div>
        </div>
    );
}
