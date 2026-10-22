import { useState } from 'react';
import { importAuditFile } from '../audit/importFile';
import { confirmRequirement, correctRequirement, needsReview } from '../audit/parseAudit';
import type { AuditRequirement, ParsedAudit, RequirementCategory, RequirementStatus } from '../audit/types';
import { describeRequirement } from '../core/requirements';
import { FastlaneAuditStore } from '../storage/stores';
import AiAuditReview from './AiAuditReview';
import { PageHead } from './common';

const STATUS_COLOR: Record<RequirementStatus, string> = {
    completed: 'var(--ok)',
    'in-progress': 'var(--warn)',
    'not-started': 'var(--bad)',
};
const REQUIREMENT_GROUPS: Array<[RequirementCategory, string]> = [
    ['core', 'Core curriculum'],
    ['general', 'General education and flags'],
    ['major', 'Major and degree requirements'],
    ['minor', 'Minor requirements'],
    ['hours', 'Credit hours and residency'],
    ['gpa', 'GPA requirements'],
    ['other', 'Other IDA requirements'],
];

const STATUS_ORDER: Record<RequirementStatus, number> = {
    'not-started': 0,
    'in-progress': 1,
    completed: 2,
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
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const review = audit ? needsReview(audit) : [];
    const reqs = audit?.requirements ?? [];

    return (
        <div className='stack'>
            <PageHead
                title='Degree progress'
                subtitle='See what is still needed for your degree, grouped by category. Expand a category for details.'
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
                    <div className='metrics simple-audit-metrics'>
                        <div className='metric'>
                            <b>{audit.officialProgress ? `${audit.officialProgress.percent}%` : 'Not found'}</b>
                            <span>Official IDA degree completion</span>
                        </div>
                        <div className='metric'>
                            <b>
                                {reqs.filter(r => r.status === 'completed').length} / {reqs.length}
                            </b>
                            <span>Parsed requirement checks (unweighted)</span>
                        </div>
                        <div className='metric'>
                            <b>{audit.creditHours.remaining ?? '—'}</b>
                            <span>Degree hours remaining, if listed</span>
                        </div>
                    </div>
                    <p className='small muted'>
                        UT's reported completion percentage and these requirement-check counts are different measures.
                        Checks can overlap, have different hour weights, and include GPA or residency rules; do not
                        treat completed checks divided by total checks as degree completion.
                        {!audit.officialProgress &&
                            ' If the completion percentage was not in the imported file, view it on UT IDA.'}
                    </p>
                    {review.length > 0 && (
                        <div className='notice warn small'>
                            {review.length} imported checks need review before relying on recommendations. Expand a
                            category and confirm uncertain rows.
                        </div>
                    )}
                    {audit.transfer.pending.length > 0 && (
                        <div className='notice warn small'>
                            Pending transfer/exam credit is not awarded yet:{' '}
                            {audit.transfer.pending.map(c => `${c.code} (${c.hours} hrs)`).join(', ')}.
                        </div>
                    )}
                    <div className='row'>
                        <button type='button' className='btn primary' onClick={() => onNavigate('finder')}>
                            Find classes for remaining requirements
                        </button>
                    </div>
                    <section className='stack' aria-label='Degree requirement categories'>
                        {[...REQUIREMENT_GROUPS]
                            .sort(
                                ([a], [b]) =>
                                    Number(!reqs.some(r => r.category === a && r.status !== 'completed')) -
                                    Number(!reqs.some(r => r.category === b && r.status !== 'completed'))
                            )
                            .map(([category, label]) => {
                                // remaining first, then in progress, then completed
                                const group = reqs
                                    .filter(r => r.category === category)
                                    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
                                if (!group.length) return null;
                                const unfinished = group.filter(r => r.status !== 'completed').length;
                                const uncertain = group.filter(r => r.confidence !== 'high' && !r.reviewed).length;
                                return (
                                    <details key={category} className='card audit-group'>
                                        <summary>
                                            <span>
                                                <b>{label}</b>{' '}
                                                <span className='small muted'>
                                                    · {unfinished} remaining of {group.length} checks
                                                </span>
                                            </span>
                                            {uncertain > 0 && <span className='chip'>{uncertain} to review</span>}
                                        </summary>
                                        <div className='audit-detail'>
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
                                                    {group.map(r => (
                                                        <RequirementRow key={r.id} r={r} onChange={a => void save(a)} />
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </details>
                                );
                            })}
                    </section>
                    <details className='card audit-group'>
                        <summary>
                            <b>Optional AI audit review</b>
                            <span className='small muted'>Check ambiguous matches</span>
                        </summary>
                        <div className='audit-detail'>
                            <AiAuditReview audit={audit} onChange={save} />
                        </div>
                    </details>
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
