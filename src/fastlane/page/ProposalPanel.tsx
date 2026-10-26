/**
 * The proposed week inside the chat: a compact calendar of real UT sections, the clicked class's details
 * (remove or ask AI to replace it), undo / redo, and saving the whole proposal as a new schedule. Nothing
 * here touches existing schedules until the student saves.
 */
import { lazy, Suspense, useState } from 'react';
import type { AiCandidate } from '../core/aiCandidates';
import type { GradeStat } from '../core/grades';
import type { ProposalVersion } from '../core/proposal';
import { totalHours } from '../core/proposal';
import type { ScheduleValidation } from '../core/scheduleSolver';
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
    /** every rule checked against the shown version; errors mean it is a draft, not a valid schedule */
    validation: ScheduleValidation | null;
    minCredits: number;
    onFill: () => void;
    canFill: boolean;
    version: ProposalVersion;
    index: number;
    count: number;
    onVersion: (index: number) => void;
    grades: Map<number, GradeStat | null>;
    facts: Map<number, AiCandidate>;
    picks: Map<number, AiPick>;
    onRemove: (s: SectionRecord) => void;
    onAskReplace: (s: SectionRecord) => void;
    onSave: () => void;
    saveNote: string;
    busy: boolean;
}

export default function ProposalPanel(props: Props) {
    const { version, index, count, grades, facts, picks } = props;
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [popup, setPopup] = useState<SectionRecord | null>(null);
    const selected = version.sections.find(s => s.uniqueId === selectedId) ?? null;
    const changed = new Set(index > 0 ? version.added : []);
    const credits = totalHours(version.sections);
    const valid = props.validation?.ok ?? false;
    const short = (props.validation?.credits ?? credits) < props.minCredits;

    return (
        <section className='fl-plan proposal' aria-label='Proposed schedule'>
            <div className='fl-plan-head'>
                <div className='fl-plan-total'>
                    <b>{credits} credits</b>
                    <span>
                        {version.sections.length} {version.sections.length === 1 ? 'class' : 'classes'}
                    </span>
                </div>
                <span className={`fl-pill ${valid ? 'ok' : 'warn'}`}>
                    {valid
                        ? 'All rules met'
                        : short
                          ? `Needs ${props.minCredits - credits} more credits`
                          : 'Needs a change'}
                </span>
                <fieldset className='fl-plan-undo' aria-label='Proposal versions'>
                    <button
                        type='button'
                        title='Undo'
                        disabled={index === 0 || props.busy}
                        onClick={() => props.onVersion(index - 1)}
                    >
                        Undo
                    </button>
                    <button
                        type='button'
                        title='Redo'
                        disabled={index >= count - 1 || props.busy}
                        onClick={() => props.onVersion(index + 1)}
                    >
                        Redo
                    </button>
                </fieldset>
            </div>
            {!valid && props.validation && props.validation.errors.length > 0 && (
                <div className='fl-plan-alert' role='alert'>
                    <span>{props.validation.errors.join(' ')}</span>
                    {short && (
                        <button
                            type='button'
                            className='btn primary sm'
                            disabled={props.busy || !props.canFill}
                            onClick={props.onFill}
                        >
                            Fill to {props.minCredits}+ credits
                        </button>
                    )}
                </div>
            )}
            <WeekGrid
                sections={version.sections}
                compact
                label='Proposed weekly calendar'
                onSelect={s => {
                    // like My schedule: the course popup opens, and the actions stay below the calendar
                    setSelectedId(s.uniqueId);
                    setPopup(s);
                }}
                selectedId={selectedId}
                changed={changed}
            />
            {selected ? (
                <ProposalDetail
                    s={selected}
                    grade={grades.get(selected.uniqueId)}
                    fact={facts.get(selected.uniqueId)}
                    pick={picks.get(selected.uniqueId)}
                    onRemove={() => {
                        props.onRemove(selected);
                        setSelectedId(null);
                    }}
                    onAskReplace={() => props.onAskReplace(selected)}
                    onDescription={() => setPopup(selected)}
                    busy={props.busy}
                />
            ) : (
                <p className='fl-hint'>Click a class for its details.</p>
            )}
            <button
                type='button'
                className='btn primary fl-save'
                disabled={!version.sections.length || props.busy || !valid}
                onClick={props.onSave}
            >
                Save as a new schedule
            </button>
            {props.saveNote && (
                <p role='status' className='fl-hint'>
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
    onRemove,
    onAskReplace,
    onDescription,
    busy,
}: {
    s: SectionRecord;
    grade: GradeStat | null | undefined;
    fact: AiCandidate | undefined;
    pick: AiPick | undefined;
    onRemove: () => void;
    onAskReplace: () => void;
    onDescription: () => void;
    busy: boolean;
}) {
    const unmet = fact?.prerequisite.status === 'unmet';
    return (
        <section className='proposal-detail' aria-label={`Details for ${s.courseCode}`}>
            <ClassCard section={s} grade={grade}>
                <button type='button' className='btn ghost sm' onClick={onDescription}>
                    Description
                </button>
            </ClassCard>
            <p className='fl-detail-line'>
                {s.instructors.join(', ') || 'Professor not listed'} ·{' '}
                {fact?.applies.length ? (
                    <span className='req-verified'>Counts toward {fact.applies.join(', ')}</span>
                ) : (
                    <span>Elective (no IDA match)</span>
                )}
            </p>
            {pick?.reason && <p className='fl-detail-line muted'>{pick.reason}</p>}
            {(pick?.warning || unmet) && (
                <p className='fl-detail-line warn'>
                    {pick?.warning}
                    {unmet && ' Printed prerequisite not found in your courses.'}
                </p>
            )}
            <div className='proposal-actions'>
                <button type='button' className='btn sm' onClick={onAskReplace} disabled={busy}>
                    Ask AI to replace
                </button>
                <button type='button' className='btn ghost sm danger-text' onClick={onRemove} disabled={busy}>
                    Remove
                </button>
            </div>
        </section>
    );
}
