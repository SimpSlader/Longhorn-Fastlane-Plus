/**
 * The planner's rules as Fastlane understood them, shown compactly above the calendar and editable: credit
 * range, allowed meeting days, excluded subjects, online classes, back-to-back, grades and core focus.
 * Editing never calls AI; "Rebuild" re-solves locally from the real sections already compared.
 */
import { useState } from 'react';
import type { DayCode } from '../core/meetings';
import type { ScheduleConstraints } from '../core/scheduleSolver';
import { MIN_CREDITS } from '../core/scheduleSolver';
import { subjectForCode } from '../data/subjects';

export interface PlannerOverrides {
    minCredits?: number;
    maxCredits?: number;
    avoidDays?: DayCode[];
    excludedSubjects?: string[];
    online?: { min: number; max: number } | null;
    backToBack?: boolean;
    easyGrades?: boolean;
    coreFocus?: boolean;
}

const WEEKDAYS: Array<[DayCode, string]> = [
    ['M', 'M'],
    ['T', 'T'],
    ['W', 'W'],
    ['TH', 'Th'],
    ['F', 'F'],
];
const ONLINE_CHOICES: Array<[string, { min: number; max: number } | null]> = [
    ['Any', null],
    ['None', { min: 0, max: 0 }],
    ['1', { min: 1, max: 1 }],
    ['1–2', { min: 1, max: 2 }],
    ['2–3', { min: 2, max: 3 }],
];

export default function ConstraintsBar({
    constraints,
    easyGrades,
    coreFocus,
    accPlanned,
    edited,
    canRebuild,
    busy,
    onChange,
    onRebuild,
    onReset,
}: {
    constraints: ScheduleConstraints;
    easyGrades: boolean;
    coreFocus: boolean;
    accPlanned: boolean;
    edited: boolean;
    canRebuild: boolean;
    busy: boolean;
    onChange: (patch: PlannerOverrides) => void;
    onRebuild: () => void;
    onReset: () => void;
}) {
    const [newSubject, setNewSubject] = useState('');
    const onlineKey =
        ONLINE_CHOICES.find(([, v]) => v?.min === constraints.online?.min && v?.max === constraints.online?.max)?.[0] ??
        (constraints.online ? `${constraints.online.min}–${constraints.online.max}` : 'Any');
    const toggleDay = (d: DayCode) =>
        onChange({
            avoidDays: constraints.avoidDays.includes(d)
                ? constraints.avoidDays.filter(x => x !== d)
                : [...constraints.avoidDays, d],
        });
    return (
        <section className='constraints glass-card' aria-label='What Fastlane will follow'>
            <div className='constraints-row'>
                <span className='eyebrow'>FASTLANE WILL FOLLOW</span>
                {edited && (
                    <button type='button' className='btn ghost sm' onClick={onReset}>
                        Use my message again
                    </button>
                )}
            </div>
            <div className='constraints-grid'>
                <label>
                    Credits
                    <span className='constraints-inline'>
                        <input
                            type='number'
                            min={MIN_CREDITS}
                            max={21}
                            value={constraints.minCredits}
                            aria-label='Minimum credits'
                            onChange={e =>
                                onChange({ minCredits: Math.max(MIN_CREDITS, Number(e.target.value) || MIN_CREDITS) })
                            }
                        />
                        –
                        <input
                            type='number'
                            min={constraints.minCredits}
                            max={21}
                            value={constraints.maxCredits}
                            aria-label='Maximum credits'
                            onChange={e =>
                                onChange({
                                    maxCredits: Math.max(constraints.minCredits, Number(e.target.value) || 16),
                                })
                            }
                        />
                    </span>
                </label>
                <fieldset className='constraints-days' aria-label='Days classes may meet'>
                    <legend>Meeting days</legend>
                    {WEEKDAYS.map(([d, label]) => {
                        const on = !constraints.avoidDays.includes(d);
                        return (
                            <button
                                key={d}
                                type='button'
                                className={`day-chip ${on ? 'on' : ''}`}
                                aria-pressed={on}
                                aria-label={`${label} allowed`}
                                onClick={() => toggleDay(d)}
                            >
                                {label}
                            </button>
                        );
                    })}
                </fieldset>
                <label>
                    Async online
                    <select
                        value={onlineKey}
                        aria-label='Asynchronous online classes'
                        onChange={e =>
                            onChange({ online: ONLINE_CHOICES.find(([k]) => k === e.target.value)?.[1] ?? null })
                        }
                    >
                        {ONLINE_CHOICES.map(([k]) => (
                            <option key={k} value={k}>
                                {k}
                            </option>
                        ))}
                    </select>
                </label>
                <div className='constraints-toggles'>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={constraints.backToBack}
                            onChange={e => onChange({ backToBack: e.target.checked })}
                        />
                        Back-to-back
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={easyGrades}
                            onChange={e => onChange({ easyGrades: e.target.checked })}
                        />
                        High A rates
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={coreFocus}
                            onChange={e => onChange({ coreFocus: e.target.checked })}
                        />
                        Core first
                    </label>
                </div>
            </div>
            <div className='constraints-row'>
                <span className='small muted'>Leave out:</span>
                {constraints.excludedSubjects.map(code => (
                    <span key={code} className='subject-chip'>
                        {code}
                        <button
                            type='button'
                            aria-label={`Allow ${subjectForCode(code)?.name ?? code} classes`}
                            onClick={() =>
                                onChange({ excludedSubjects: constraints.excludedSubjects.filter(c => c !== code) })
                            }
                        >
                            ×
                        </button>
                    </span>
                ))}
                {constraints.excludedCourses.map(code => (
                    <span key={code} className='subject-chip muted' title='From your message'>
                        {code}
                    </span>
                ))}
                <input
                    className='subject-add'
                    value={newSubject}
                    placeholder='Subject, e.g. HIS'
                    aria-label='Leave out a subject'
                    onChange={e => setNewSubject(e.target.value.toUpperCase())}
                    onKeyDown={e => {
                        const code = newSubject.trim();
                        if (e.key === 'Enter' && subjectForCode(code)) {
                            onChange({ excludedSubjects: [...new Set([...constraints.excludedSubjects, code])] });
                            setNewSubject('');
                        }
                    }}
                />
                {accPlanned && <span className='small muted'>· ACC plans are never counted as UT credit</span>}
            </div>
            {canRebuild && edited && (
                <button type='button' className='btn primary sm' disabled={busy} onClick={onRebuild}>
                    Rebuild schedule with these rules
                </button>
            )}
        </section>
    );
}
