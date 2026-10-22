/**
 * The AI's proposed week: a compact calendar of real UT sections, a detail view for the clicked class
 * (with remove / replace / "Ask AI to replace"), highlighted changes between versions, undo, and saving the
 * whole proposal as a new schedule. Nothing here touches existing schedules until the student saves.
 */
import { lazy, Suspense, useState } from 'react';
import type { AiCandidate } from '../core/aiCandidates';
import type { GradeStat } from '../core/grades';
import { formatMeeting } from '../core/meetings';
import type { ProposalVersion } from '../core/proposal';
import { totalHours } from '../core/proposal';
import type { SectionRecord } from '../core/sections';
import { ClassCard } from './ClassCard';
import WeekGrid from './WeekGrid';

const CoursePopup = lazy(() => import('./CoursePopup'));

export interface AiPick {
    reason: string;
    requirement: string;
    warning: string;
}

interface Props {
    version: ProposalVersion;
    index: number;
    count: number;
    onVersion: (index: number) => void;
    grades: Map<number, GradeStat | null>;
    facts: Map<number, AiCandidate>;
    picks: Map<number, AiPick>;
    sectionsById: Map<number, SectionRecord>;
    alternatives: (s: SectionRecord) => SectionRecord[];
    onRemove: (s: SectionRecord) => void;
    onReplace: (from: SectionRecord, to: SectionRecord) => void;
    onAskReplace: (s: SectionRecord) => void;
    onSave: () => void;
    saveNote: string;
    busy: boolean;
}

const pad = (n: number) => String(n).padStart(5, '0');

export default function ProposalPanel(props: Props) {
    const { version, index, count, grades, facts, picks, sectionsById } = props;
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [popup, setPopup] = useState<SectionRecord | null>(null);
    const selected = version.sections.find(s => s.uniqueId === selectedId) ?? null;
    const changed = new Set(index > 0 ? version.added : []);
    const removed = version.removed.map(id => sectionsById.get(id)).filter(Boolean) as SectionRecord[];
    const added = version.added.map(id => sectionsById.get(id)).filter(Boolean) as SectionRecord[];

    return (
        <section className='glass-card proposal' aria-label='Proposed schedule'>
            <div className='proposal-head'>
                <div>
                    <span className='eyebrow'>PROPOSED SCHEDULE</span>
                    <h3>
                        {version.sections.length} {version.sections.length === 1 ? 'class' : 'classes'} ·{' '}
                        {totalHours(version.sections)} credits
                    </h3>
                </div>
                <fieldset className='proposal-versions' aria-label='Proposal versions'>
                    <button
                        type='button'
                        className='btn ghost sm'
                        disabled={index === 0 || props.busy}
                        onClick={() => props.onVersion(index - 1)}
                    >
                        Undo
                    </button>
                    <span className='small muted'>
                        Version {index + 1} of {count}
                    </span>
                    <button
                        type='button'
                        className='btn ghost sm'
                        disabled={index >= count - 1 || props.busy}
                        onClick={() => props.onVersion(index + 1)}
                    >
                        Redo
                    </button>
                </fieldset>
            </div>
            {version.note && <p className='proposal-note small'>{version.note}</p>}
            {index > 0 && (added.length > 0 || removed.length > 0) && (
                <p className='proposal-diff small' title='Changes in this version'>
                    {added.map(s => (
                        <span key={`a${s.uniqueId}`} className='diff-add'>
                            + {s.courseCode} ({pad(s.uniqueId)})
                        </span>
                    ))}
                    {removed.map(s => (
                        <span key={`r${s.uniqueId}`} className='diff-remove'>
                            − {s.courseCode} ({pad(s.uniqueId)})
                        </span>
                    ))}
                </p>
            )}
            <WeekGrid
                sections={version.sections}
                compact
                label='Proposed weekly calendar'
                onSelect={s => setSelectedId(id => (id === s.uniqueId ? null : s.uniqueId))}
                selectedId={selectedId}
                changed={changed}
            />
            <p className='small muted'>Click a class to see details, remove it, or ask AI to replace it.</p>
            {selected && (
                <ProposalDetail
                    s={selected}
                    grade={grades.get(selected.uniqueId)}
                    fact={facts.get(selected.uniqueId)}
                    pick={picks.get(selected.uniqueId)}
                    alternatives={props.alternatives(selected)}
                    onRemove={() => {
                        props.onRemove(selected);
                        setSelectedId(null);
                    }}
                    onReplace={to => {
                        props.onReplace(selected, to);
                        setSelectedId(to.uniqueId);
                    }}
                    onAskReplace={() => props.onAskReplace(selected)}
                    onDescription={() => setPopup(selected)}
                    busy={props.busy}
                />
            )}
            <div className='row'>
                <button
                    type='button'
                    className='btn primary'
                    disabled={!version.sections.length || props.busy}
                    onClick={props.onSave}
                >
                    Save as a new schedule
                </button>
                <span className='small muted'>Your existing schedules are not changed.</span>
            </div>
            {props.saveNote && (
                <p role='status' className='notice small'>
                    {props.saveNote}
                </p>
            )}
            {popup && (
                <Suspense fallback={null}>
                    <CoursePopup section={popup} onClosed={() => setPopup(null)} />
                </Suspense>
            )}
        </section>
    );
}

function ProposalDetail({
    s,
    grade,
    fact,
    pick,
    alternatives,
    onRemove,
    onReplace,
    onAskReplace,
    onDescription,
    busy,
}: {
    s: SectionRecord;
    grade: GradeStat | null | undefined;
    fact: AiCandidate | undefined;
    pick: AiPick | undefined;
    alternatives: SectionRecord[];
    onRemove: () => void;
    onReplace: (to: SectionRecord) => void;
    onAskReplace: () => void;
    onDescription: () => void;
    busy: boolean;
}) {
    return (
        <section className='proposal-detail' aria-label={`Details for ${s.courseCode}`}>
            <ClassCard section={s} grade={grade}>
                <button type='button' className='btn ghost sm' onClick={onDescription}>
                    Description
                </button>
            </ClassCard>
            <dl className='detail-list small'>
                <dt>Professor</dt>
                <dd>{s.instructors.join(', ') || 'Not listed'}</dd>
                <dt>Meets</dt>
                <dd>
                    {s.meetings.length
                        ? s.meetings.map(formatMeeting).join('; ')
                        : s.modality === 'async-online'
                          ? 'Asynchronous online (no meeting times)'
                          : 'Not listed'}
                </dd>
                <dt>Credits</dt>
                <dd>{s.creditHours}</dd>
                <dt>Degree requirement</dt>
                <dd>
                    {fact?.applies.length ? (
                        <span className='req-verified'>Matches your IDA: {fact.applies.join(', ')}</span>
                    ) : (
                        <span className='muted'>No verified IDA match</span>
                    )}
                    {pick?.requirement && (
                        <span className='req-possible'> · AI says it may count for {pick.requirement} (verify)</span>
                    )}
                </dd>
                {pick?.reason && (
                    <>
                        <dt>Why AI picked it</dt>
                        <dd>{pick.reason}</dd>
                    </>
                )}
                {(pick?.warning || fact?.prerequisite.status === 'unmet') && (
                    <>
                        <dt>Check</dt>
                        <dd>
                            {pick?.warning}
                            {fact?.prerequisite.status === 'unmet' &&
                                ' Printed prerequisite not found in your courses.'}
                        </dd>
                    </>
                )}
            </dl>
            <div className='row proposal-actions'>
                <button type='button' className='btn sm' onClick={onAskReplace} disabled={busy}>
                    Ask AI to replace
                </button>
                {alternatives.length > 0 && (
                    <label className='small'>
                        Replace with{' '}
                        <select
                            value=''
                            disabled={busy}
                            aria-label={`Replace ${s.courseCode} with`}
                            onChange={e => {
                                const to = alternatives.find(a => a.uniqueId === Number(e.target.value));
                                if (to) onReplace(to);
                            }}
                        >
                            <option value=''>Choose…</option>
                            {alternatives.map(a => (
                                <option key={a.uniqueId} value={a.uniqueId}>
                                    {a.courseCode} ({pad(a.uniqueId)}) ·{' '}
                                    {a.meetings.length ? a.meetings.map(formatMeeting).join('; ') : 'online'}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                <button type='button' className='btn ghost sm danger-text' onClick={onRemove} disabled={busy}>
                    Remove
                </button>
            </div>
        </section>
    );
}
