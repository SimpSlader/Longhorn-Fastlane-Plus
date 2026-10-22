import { useState } from 'react';
import { importAuditFile } from '../audit/importFile';
import { confirmRequirement, correctRequirement, needsReview, outstandingTags } from '../audit/parseAudit';
import type { AuditRequirement, ParsedAudit, RequirementStatus } from '../audit/types';
import { describeRequirement } from '../core/requirements';
import { FastlaneAuditStore } from '../storage/stores';
import { PageHead } from './common';

const STATUS_COLOR: Record<RequirementStatus, string> = {
    completed: 'var(--ok)',
    'in-progress': 'var(--warn)',
    'not-started': 'var(--bad)',
};
const STATUS_LABEL: Record<RequirementStatus, string> = {
    completed: 'Completed',
    'in-progress': 'In progress',
    'not-started': 'Not started',
};

function progressText(r: AuditRequirement): string {
    const p = (x?: { value: number; unit: string }) => (x ? `${x.value} ${x.unit}` : '—');
    return `${p(r.applied)} of ${p(r.required)} · ${p(r.remaining)} remaining`;
}

function RequirementRow({ r, onChange }: { r: AuditRequirement; onChange: (a: ParsedAudit) => void }) {
    const audit = FastlaneAuditStore.useStore(s => s.audit) as ParsedAudit;
    const flagged = r.confidence !== 'high' && !r.reviewed;
    return (
        <tr style={flagged ? { background: 'var(--warn-soft)' } : undefined}>
            <td>
                <span className='req-status' style={{ background: STATUS_COLOR[r.status] }} />
            </td>
            <td>
                <div>{r.text}</div>
                <div className='small muted'>
                    {r.section} · {progressText(r)}
                    {r.courses.length ? ` · ${r.courses.join(', ')}` : ''}
                </div>
                {r.tags.length > 0 && (
                    <div className='row' style={{ marginTop: 3 }}>
                        {r.tags.map(t => (
                            <span key={t} className='chip'>
                                {describeRequirement(t)}
                            </span>
                        ))}
                    </div>
                )}
                {flagged && (
                    <div className='small' style={{ color: 'var(--warn)' }}>
                        Check this: {r.issues.join('; ')}
                    </div>
                )}
            </td>
            <td>
                <select
                    aria-label='Requirement status'
                    value={r.status}
                    onChange={e =>
                        onChange(correctRequirement(audit, r.id, { status: e.target.value as RequirementStatus }))
                    }
                >
                    {(['completed', 'in-progress', 'not-started'] as const).map(s => (
                        <option key={s} value={s}>
                            {STATUS_LABEL[s]}
                        </option>
                    ))}
                </select>
            </td>
            <td>
                {flagged ? (
                    <button type='button' className='btn sm' onClick={() => onChange(confirmRequirement(audit, r.id))}>
                        Looks right
                    </button>
                ) : (
                    <span className='small muted'>{r.reviewed ? 'Reviewed' : 'Read from audit'}</span>
                )}
            </td>
        </tr>
    );
}

export default function AuditTab({
    onNavigate,
}: {
    onNavigate: (tab: string, params?: Record<string, string>) => void;
}) {
    const audit = FastlaneAuditStore.useStore(s => s.audit) as ParsedAudit | null;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [over, setOver] = useState(false);
    const [filter, setFilter] = useState<'review' | 'remaining' | 'all'>('review');

    const save = (a: ParsedAudit | null) => FastlaneAuditStore.set('audit', a as never);

    const onFile = async (file: File | undefined) => {
        if (!file) return;
        setBusy(true);
        setError(null);
        try {
            const parsed = await importAuditFile(file);
            if (!parsed.requirements.length && !parsed.courses.length)
                throw new Error(parsed.warnings.join(' ') || 'Nothing could be read from that file.');
            await save(parsed);
            setFilter(needsReview(parsed).length ? 'review' : 'remaining');
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const review = audit ? needsReview(audit) : [];
    const reqs = audit?.requirements ?? [];
    const shown =
        filter === 'review' ? review : filter === 'remaining' ? reqs.filter(r => r.status !== 'completed') : reqs;
    const core = reqs.filter(r => r.category === 'core');
    const major = reqs.filter(r => r.category === 'major');
    const count = (list: AuditRequirement[], s: RequirementStatus) => list.filter(r => r.status === s).length;

    return (
        <div className='stack'>
            <PageHead
                title='Degree audit'
                subtitle='See which degree requirements you have finished and which courses you still need. Your audit stays on this computer.'
                actions={
                    audit && (
                        <button type='button' className='btn danger' onClick={() => void save(null)}>
                            Remove imported audit
                        </button>
                    )
                }
            />
            <label
                className={`dropzone ${over ? 'over' : ''}`}
                onDragOver={e => {
                    e.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={e => {
                    e.preventDefault();
                    setOver(false);
                    void onFile(e.dataTransfer.files[0]);
                }}
            >
                <input
                    type='file'
                    accept='.pdf,.html,.htm,application/pdf,text/html'
                    className='sr-only'
                    onChange={e => void onFile(e.target.files?.[0])}
                />
                <b>{busy ? 'Reading audit…' : 'Drop your audit here or click to choose a file'}</b>
                <div className='small muted'>
                    While viewing your audit in Chrome, press <b>Command+S</b> (Mac) or <b>Ctrl+S</b> (Windows) and
                    select <i>Webpage, HTML Only</i>. You can also use <i>Print → Save as PDF</i>. On a live IDA results
                    page, click “Add IDA” to import it directly into this browser.
                </div>
            </label>
            {error && (
                <div className='notice bad' role='alert'>
                    {error}
                </div>
            )}
            {audit && (
                <>
                    {audit.warnings.map(w => (
                        <div key={w} className='notice warn small'>
                            {w}
                        </div>
                    ))}
                    <div className='metrics'>
                        <div className='metric'>
                            <b>
                                {count(core, 'completed')}/{core.length}
                            </b>
                            <span>core requirements complete</span>
                        </div>
                        <div className='metric'>
                            <b>
                                {count(major, 'completed')}/{major.length}
                            </b>
                            <span>major/degree requirements complete</span>
                        </div>
                        <div className='metric'>
                            <b>{count(reqs, 'in-progress')}</b>
                            <span>in progress</span>
                        </div>
                        <div className='metric'>
                            <b>{audit.creditHours.remaining ?? '—'}</b>
                            <span>
                                hours remaining
                                {audit.creditHours.required ? ` of ${audit.creditHours.required}` : ''}
                            </span>
                        </div>
                        <div className='metric'>
                            <b>{audit.transfer.accepted.length}</b>
                            <span>accepted transfer/exam credits</span>
                        </div>
                        <div className='metric'>
                            <b style={{ color: audit.transfer.pending.length ? 'var(--warn)' : undefined }}>
                                {audit.transfer.pending.length}
                            </b>
                            <span>pending transfer (not counted)</span>
                        </div>
                    </div>
                    {audit.transfer.pending.length > 0 && (
                        <div className='notice warn'>
                            Pending transfer credit is not treated as awarded:{' '}
                            {audit.transfer.pending.map(c => `${c.code} (${c.hours} hrs)`).join(', ')}. Requirements
                            that rely on it stay in progress until UT posts the credit.
                        </div>
                    )}
                    <div className='card stack'>
                        <div className='row between'>
                            <fieldset className='tabs' aria-label='Filter requirements'>
                                <button
                                    type='button'
                                    aria-pressed={filter === 'review'}
                                    onClick={() => setFilter('review')}
                                >
                                    Needs review ({review.length})
                                </button>
                                <button
                                    type='button'
                                    aria-pressed={filter === 'remaining'}
                                    onClick={() => setFilter('remaining')}
                                >
                                    Remaining ({reqs.filter(r => r.status !== 'completed').length})
                                </button>
                                <button type='button' aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                                    All ({reqs.length})
                                </button>
                            </fieldset>
                            <button
                                type='button'
                                className='btn primary'
                                disabled={!outstandingTags(audit).length}
                                onClick={() => onNavigate('recommend', { req: outstandingTags(audit)[0] ?? '' })}
                            >
                                Recommend courses for remaining requirements
                            </button>
                        </div>
                        {shown.length === 0 ? (
                            <div className='muted small'>
                                {filter === 'review' ? 'Everything has been reviewed.' : 'Nothing here.'}
                            </div>
                        ) : (
                            <table className='list'>
                                <thead>
                                    <tr>
                                        <th />
                                        <th>Requirement</th>
                                        <th>Status</th>
                                        <th>Review</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {shown.map(r => (
                                        <RequirementRow key={r.id} r={r} onChange={a => void save(a)} />
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                    {audit.restrictions.length > 0 && (
                        <div className='card'>
                            <h3>Prerequisites and restrictions mentioned in your audit</h3>
                            <ul className='small'>
                                {audit.restrictions.slice(0, 20).map(r => (
                                    <li key={r}>{r}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className='small muted'>
                        Imported {new Date(audit.parsedAt).toLocaleString()} from {audit.fileName ?? 'file'} (
                        {audit.source.toUpperCase()}). {audit.courses.length} courses read.
                    </div>
                </>
            )}
        </div>
    );
}
