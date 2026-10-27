import { useState } from 'react';
import { importAuditFile } from '../audit/importFile';
import { confirmRequirement, correctRequirement, needsReview } from '../audit/parseAudit';
import type { DegreeTotals, ProgressSummary } from '../audit/progress';
import { CARD_GROUPS, degreeTotals, hasMinor, summarizeRequirements } from '../audit/progress';
import type { AuditRequirement, ParsedAudit, RequirementStatus } from '../audit/types';
import type { AcademicModel, Figure } from '../core/academicModel';
import { academicModel, sourceLabel } from '../core/academicModel';
import { FastlaneAuditStore, FastlaneFactsStore } from '../storage/stores';
import AiAuditReview from './AiAuditReview';
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
    // only uncertain rows show correction controls; everything else stays a clean read-only line
    const flagged = r.confidence !== 'high' && !r.reviewed;
    return (
        <tr className={flagged ? 'req-row flagged' : 'req-row'}>
            <td>
                <span className='req-status' style={{ background: STATUS_COLOR[r.status] }} />
            </td>
            <td>
                <div>{r.text}</div>
                <div className='small muted'>
                    {progressText(r)}
                    {r.courses.length ? ` · ${r.courses.join(', ')}` : ''}
                </div>
                {flagged && (
                    <div className='row small' style={{ marginTop: 6 }}>
                        <span style={{ color: 'var(--warn)' }}>
                            Check: {r.issues.join('; ') || 'unclear in the IDA'}
                        </span>
                        <select
                            aria-label='Requirement status'
                            value={r.status}
                            onChange={e =>
                                onChange(
                                    correctRequirement(audit, r.id, { status: e.target.value as RequirementStatus })
                                )
                            }
                        >
                            {(['completed', 'in-progress', 'not-started'] as const).map(s => (
                                <option key={s} value={s}>
                                    {STATUS_LABEL[s]}
                                </option>
                            ))}
                        </select>
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() => onChange(confirmRequirement(audit, r.id))}
                        >
                            Looks right
                        </button>
                    </div>
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
    const totals = audit ? degreeTotals(audit) : null;
    const facts = FastlaneFactsStore.useStore(st => st.facts);
    const model = audit ? academicModel(audit, facts ?? {}) : null;
    const dropzone = (compact: boolean) => (
        <label
            className={`dropzone${over ? ' over' : ''}${compact ? ' compact' : ''}`}
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
            <b>
                {busy
                    ? 'Reading audit…'
                    : compact
                      ? 'Update from a newer IDA file'
                      : 'Drop your audit here or click to choose a file'}
            </b>
            {!compact && (
                <div className='small muted'>
                    While viewing your audit in Chrome, press <b>Command+S</b> (Mac) or <b>Ctrl+S</b> (Windows) and
                    select <i>Webpage, HTML Only</i>. You can also use <i>Print → Save as PDF</i>. On a live IDA results
                    page, click “Add IDA” to import it directly into this browser.
                </div>
            )}
        </label>
    );
    return (
        <div className='stack degree-page'>
            <PageHead
                title='Degree progress'
                subtitle={
                    audit
                        ? audit.program && !/navigation|menu/i.test(audit.program)
                            ? audit.program
                            : 'From your imported IDA'
                        : 'Import your IDA to see what is left.'
                }
                actions={
                    audit && (
                        <button type='button' className='btn sm ghost' onClick={() => void save(null)}>
                            Remove audit
                        </button>
                    )
                }
            />
            {!audit && dropzone(false)}
            {error && (
                <div className='notice bad' role='alert'>
                    {error}
                </div>
            )}
            {audit && totals && (
                <>
                    <section className='glass-card overall metric' aria-label='Official IDA degree completion'>
                        <span className='eyebrow'>Official IDA degree completion</span>
                        <div className='big-figure'>{totals.official !== null ? `${totals.official}%` : '—'}</div>
                        {totals.official !== null ? (
                            <div className='thin-bar' aria-hidden='true'>
                                <span style={{ width: `${totals.official}%` }} />
                            </div>
                        ) : (
                            <p className='small muted'>
                                Not shown in the imported file. Open your IDA on UT to see it.
                            </p>
                        )}
                        {totals.totalHours && (
                            <p className='small muted'>
                                {totals.totalHours.done} of {totals.totalHours.total} degree hours ·{' '}
                                {totals.totalHours.remaining} remaining
                            </p>
                        )}
                    </section>
                    {model && <CreditsPanel model={model} />}
                    {(review.length > 0 || audit.transfer.pending.length > 0) && (
                        <p className='small muted quiet-note'>
                            {review.length > 0 && `${review.length} imported items need a quick check (marked below). `}
                            {audit.transfer.pending.length > 0 &&
                                `Pending transfer/exam credit is not counted yet: ${audit.transfer.pending.map(c => c.code).join(', ')}.`}
                        </p>
                    )}
                    <p className='small muted quiet-note'>
                        These cards show which requirements your courses satisfy. One course can satisfy a core
                        requirement and a major requirement and still counts only once toward your degree total, so the
                        cards don’t add up to the degree hours above.
                    </p>
                    <div className='progress-cards'>
                        {CARD_GROUPS.filter(g => g.key !== 'minor' || hasMinor(reqs)).map(g => {
                            const group = reqs.filter(r => g.categories.includes(r.category));
                            if (!group.length) return null;
                            return (
                                <ProgressCard
                                    key={g.key}
                                    title={g.title}
                                    summary={summarizeRequirements(group)}
                                    onChange={a => void save(a)}
                                />
                            );
                        })}
                        <TotalsCard
                            totals={totals}
                            rules={reqs.filter(r => ['hours', 'gpa', 'other'].includes(r.category))}
                            onChange={a => void save(a)}
                        />
                    </div>
                    <div className='row'>
                        <button type='button' className='btn primary' onClick={() => onNavigate('finder')}>
                            Find classes for what is left
                        </button>
                    </div>
                    <details className='glass-card quiet'>
                        <summary>Check unclear items with AI (optional)</summary>
                        <div className='audit-detail'>
                            <AiAuditReview audit={audit} onChange={save} />
                        </div>
                    </details>
                    {dropzone(true)}
                    <div className='small muted'>
                        Imported {new Date(audit.parsedAt).toLocaleString()} from {audit.fileName ?? 'file'} (
                        {audit.source.toUpperCase()}). {audit.courses.length} courses read.
                    </div>
                </>
            )}
        </div>
    );
}

function Chevron() {
    return (
        <svg className='chevron' width='16' height='16' viewBox='0 0 16 16' aria-hidden='true'>
            <path d='M5 6l3 3 3-3' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' />
        </svg>
    );
}

function RequirementList({
    title,
    items,
    onChange,
}: {
    title: string;
    items: AuditRequirement[];
    onChange: (a: ParsedAudit) => void;
}) {
    if (!items.length) return null;
    return (
        <div className='req-list'>
            <h4>
                {title} <span className='muted'>· {items.length}</span>
            </h4>
            <table className='list'>
                <tbody>
                    {items.map(r => (
                        <RequirementRow key={r.id} r={r} onChange={onChange} />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ProgressCard({
    title,
    summary,
    onChange,
}: {
    title: string;
    summary: ProgressSummary;
    onChange: (a: ParsedAudit) => void;
}) {
    const f = summary.figure;
    const pct = f && f.total > 0 ? Math.min(100, Math.round((f.done / f.total) * 100)) : null;
    return (
        <details className='glass-card progress-card'>
            <summary>
                <div className='card-top'>
                    <h3>{title}</h3>
                    <Chevron />
                </div>
                {f ? (
                    <div className='big-figure sm'>
                        {f.done} <span>/ {f.total}</span>
                        <small>{f.unit === 'hours' ? ' credit hours completed' : ' requirements complete'}</small>
                    </div>
                ) : (
                    <div className='big-figure sm'>Needs verification</div>
                )}
                {pct !== null && (
                    <div className='thin-bar' aria-hidden='true'>
                        <span style={{ width: `${pct}%` }} />
                    </div>
                )}
                <p className='small muted'>
                    {summary.remainingText}
                    {summary.hoursNeedVerification && ' · hours need verification on your IDA'}
                </p>
            </summary>
            <div className='card-details'>
                <RequirementList
                    title='Remaining'
                    items={summary.items.filter(r => r.status === 'not-started')}
                    onChange={onChange}
                />
                <RequirementList
                    title='In progress'
                    items={summary.items.filter(r => r.status === 'in-progress')}
                    onChange={onChange}
                />
                <RequirementList
                    title='Completed'
                    items={summary.items.filter(r => r.status === 'completed')}
                    onChange={onChange}
                />
            </div>
        </details>
    );
}

function TotalsCard({
    totals,
    rules,
    onChange,
}: {
    totals: DegreeTotals;
    rules: AuditRequirement[];
    onChange: (a: ParsedAudit) => void;
}) {
    const university = totals.gpa.find(g => g.label === 'University GPA') ?? totals.gpa[0];
    if (!rules.length && !totals.totalHours && !university) return null;
    return (
        <details className='glass-card progress-card compact'>
            <summary>
                <div className='card-top'>
                    <h3>GPA, residency and total hours</h3>
                    <Chevron />
                </div>
                <div className='mini-stats'>
                    {university && (
                        <span>
                            <b>{university.value.toFixed(2)}</b> GPA
                        </span>
                    )}
                    {totals.residence && (
                        <span>
                            <b>
                                {totals.residence.done}/{totals.residence.total}
                            </b>{' '}
                            hrs in residence
                        </span>
                    )}
                    {totals.totalHours && (
                        <span>
                            <b>
                                {totals.totalHours.done}/{totals.totalHours.total}
                            </b>{' '}
                            total hrs
                        </span>
                    )}
                </div>
            </summary>
            <div className='card-details'>
                {totals.gpa.length > 0 && (
                    <ul className='small plain'>
                        {totals.gpa.map(g => (
                            <li key={g.label}>
                                {g.label}: {g.value.toFixed(2)} (minimum {g.minimum.toFixed(2)})
                            </li>
                        ))}
                    </ul>
                )}
                <RequirementList
                    title='Remaining'
                    items={rules.filter(r => r.category !== 'gpa' && r.status !== 'completed')}
                    onChange={onChange}
                />
                <RequirementList
                    title='Completed'
                    items={rules.filter(r => r.category !== 'gpa' && r.status === 'completed')}
                    onChange={onChange}
                />
            </div>
        </details>
    );
}

/** Earned, in-progress and projected credits kept apart, each with where it comes from. */
function CreditsPanel({ model }: { model: AcademicModel }) {
    const row = (label: string, f: Figure, suffix = '') => (
        <tr>
            <th scope='row'>{label}</th>
            <td>{f.value != null ? `${f.value}${suffix}` : 'Unable to verify'}</td>
            <td className='muted'>{sourceLabel(f)}</td>
        </tr>
    );
    const pair = (label: string, done: Figure, total: Figure) => (
        <tr>
            <th scope='row'>{label}</th>
            <td>
                {done.value != null && total.value != null ? `${done.value} of ${total.value}` : 'Unable to verify'}
            </td>
            <td className='muted'>{sourceLabel(done)}</td>
        </tr>
    );
    const inc = model.auditIncludes;
    return (
        <section className='glass-card credits-panel' aria-label='Your credits'>
            <h2>Your credits</h2>
            <table>
                <tbody>
                    {row('Earned (graded or credit by exam)', model.degreeCreditsEarned)}
                    {row('In progress this semester', model.degreeCreditsInProgress)}
                    {row('Projected toward the degree after this semester', model.degreeCreditsProjected)}
                    {row('Remaining after this semester', model.degreeCreditsRemainingProjected)}
                    {pair('In residence at UT', model.utResidentCounted, model.utResidentRequired)}
                    {pair('Upper-division', model.upperDivisionCounted, model.upperDivisionRequired)}
                </tbody>
            </table>
            <p className='small muted'>
                {inc
                    ? `Your IDA was run with ${[inc.inProgress && 'in-progress', inc.future && 'future', inc.planned && 'planned'].filter(Boolean).join(', ') || 'no extra'} courses included, so its “counted” hours include them; Fastlane separates them above.`
                    : 'The imported file doesn’t say which courses the IDA included.'}
                {model.catalogYear ? ` Catalog ${model.catalogYear}.` : ''}
                {model.auditTimestamp ? ` Imported ${new Date(model.auditTimestamp).toLocaleString()}.` : ''}
            </p>
            {[...model.discrepancies, ...model.issues].map(t => (
                <p key={t} className='small notice warn'>
                    {t}
                </p>
            ))}
        </section>
    );
}
