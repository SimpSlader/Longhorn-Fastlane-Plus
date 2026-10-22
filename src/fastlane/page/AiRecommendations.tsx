import type { Serialized } from '@chrome-extension-toolkit';
import { Course } from '@shared/types/Course';
import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gradeStatFrom, lookupGrades, scheduleTimes } from '../adapters/utrp';
import { outstandingTags } from '../audit/parseAudit';
import type { AiCandidate, AiCandidateInput } from '../core/aiCandidates';
import { chooseAiCandidates } from '../core/aiCandidates';
import { safeAiScheduleDraft } from '../core/aiSchedule';
import { describePreferences, planningPreferences } from '../core/chatPreferences';
import type { GradeStat } from '../core/grades';
import { DAY_NAMES } from '../core/meetings';
import { subjectNameIndex } from '../core/prerequisites';
import { normalizeCourseCode } from '../core/requirements';
import { isConfirmedSection, type SectionRecord, semesterKey, subjectOf } from '../core/sections';
import { subjectForCode, utSubjectScheduleUrl } from '../data/subjects';
import { addOrSwap, createPlanningSchedule } from '../services/planningService';
import { FastlaneAiAccessStore, FastlaneAuditStore, FastlaneSettingsStore } from '../storage/stores';
import { ClassCard } from './ClassCard';
import { inventorySubjects, useInventory } from './CourseInventory';

/** Planning facts computed locally and sent with each candidate (public course data only). */
function aiFacts(c: AiCandidate | undefined) {
    if (!c) return {};
    return {
        applies: c.applies.slice(0, 6),
        prereq: c.prerequisite.status,
        prereqMissing: c.prerequisite.missing.join('; ').slice(0, 120),
        prereqText: (c.section.prerequisites ?? '').slice(0, 200),
        conflict: c.conflict,
        evidence: isConfirmedSection(c.section) ? 'confirmed-on-ut' : 'registrar-listing',
    };
}

/** Historical A− rate for one section, through UTRP's grade database (cached per course and professor). */
async function gradeForSection(section: SectionRecord): Promise<GradeStat | null> {
    if (!section.course) return null;
    const course = new Course(section.course as Serialized<Course>);
    return gradeStatFrom(course, await lookupGrades(course), 'A-');
}

const ENDPOINT = 'https://longhorn-fastlane-plus.vercel.app/api/recommend';
interface AiSelection {
    id: number;
    reason: string;
    requirement: string;
    confidence: 'high' | 'possible' | 'unlikely';
    warning: string;
}
interface AiResponse {
    recommendations?: AiSelection[];
    summary?: string;
    error?: string;
}

export default function AiRecommendations({ subject = '' }: { subject?: string }) {
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const settings = FastlaneSettingsStore.useStore(s => s);
    const schedule = useActiveSchedule();
    const inventory = useInventory();
    const catalog = inventory.sections;
    const loadingCatalog = !inventory.loaded;
    const [request, setRequest] = useState('');
    const [history, setHistory] = useState<Array<{ id: number; request: string; summary: string }>>([]);
    const [timeChoice, setTimeChoice] = useState<'any' | 'morning' | 'afternoon' | 'evening'>('any');
    const [minGrade, setMinGrade] = useState(0);
    const subjectCodes = useMemo(() => new Set(inventorySubjects(inventory).map(s => s.code)), [inventory]);
    // preferences carry over between follow-ups; the message being typed is included before it is sent
    const conversation = useMemo(
        () => [...history.map(h => h.request), request.trim()].filter(Boolean),
        [history, request]
    );
    const prefs = useMemo(() => planningPreferences(conversation, subjectCodes), [conversation, subjectCodes]);
    const understood = describePreferences(prefs, DAY_NAMES);
    const avoidDays = prefs.avoidDays;
    const timeOfDay = timeChoice !== 'any' ? timeChoice : prefs.timeOfDay;
    const leftOut = useMemo(
        () => new Set([...prefs.excludedCourses, ...prefs.plannedElsewhere.map(p => p.code)].map(normalizeCourseCode)),
        [prefs]
    );
    const [consent, setConsent] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const savedCode = FastlaneAiAccessStore.useStore(s => s.accessCode);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [recommendations, setRecommendations] = useState<AiSelection[]>([]);
    // sections and facts as they were when the answer arrived (adding a class must not reshuffle the answer)
    const [answered, setAnswered] = useState<{
        sections: Map<number, SectionRecord>;
        facts: Map<number, AiCandidate>;
        grades: Map<number, GradeStat | null>;
    }>({ sections: new Map(), facts: new Map(), grades: new Map() });
    const [savedId, setSavedId] = useState<number | null>(null);
    const [draftResult, setDraftResult] = useState('');

    const taken = useMemo(
        () =>
            new Set([
                ...(audit?.courses
                    .filter(c => c.status === 'completed' || c.status === 'in-progress')
                    .map(c => normalizeCourseCode(c.code)) ?? []),
                ...(schedule?.courses.map(c => normalizeCourseCode(`${c.department} ${c.number}`)) ?? []),
            ]),
        [audit, schedule]
    );

    const listedTerm = useMemo(
        () => [...inventory.metas].sort((a, b) => b.termCode.localeCompare(a.termCode))[0]?.term,
        [inventory.metas]
    );
    const actualTerm = useMemo(() => {
        if (settings.targetSemester) return settings.targetSemester;
        if (listedTerm) return listedTerm;
        const terms = new Set<string>();
        for (const c of catalog) {
            const t = semesterKey(c.semester);
            if (t !== 'unknown') terms.add(t);
            if (terms.size > 1) return '';
        }
        return [...terms][0] ?? '';
    }, [settings.targetSemester, listedTerm, catalog]);
    const subjectIndex = useMemo(() => subjectNameIndex(inventorySubjects(inventory)), [inventory]);
    // only a cheap check while rendering; the full comparison runs when the student asks
    const subjectHasSections = useMemo(
        () => !subject || catalog.some(c => subjectOf(c.courseCode) === subject.toUpperCase()),
        [catalog, subject]
    );
    const [progress, setProgress] = useState('');
    const [compared, setCompared] = useState<{ sections: number; subjects: number } | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    /** Runs only on submit: filters, ranks and grades candidates without blocking the page, then asks AI. */
    const run = async () => {
        if (!consent || busy) return;
        if (!request.trim()) {
            setError('Tell Fastlane what kind of classes or schedule you want first.');
            return;
        }
        const code = savedCode || inviteCode.trim();
        if (!code) {
            setError('Enter the beta invite code once. Fastlane will remember it on this device.');
            return;
        }
        if (!audit) {
            setError('Import your IDA on Degree progress before asking AI to plan your degree.');
            return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setError('');
        setProgress('Reading your request…');
        setRecommendations([]);
        setSavedId(null);
        setDraftResult('');
        try {
            // hard constraints from the whole conversation are applied before candidates are chosen
            const eligible = catalog.filter(section => {
                if (leftOut.has(normalizeCourseCode(section.courseCode))) return false;
                if (prefs.asyncCount?.max === 0 && section.modality === 'async-online') return false;
                if (avoidDays.some(day => section.meetings.some(m => m.days.includes(day)))) return false;
                if (timeOfDay !== 'any' && section.modality !== 'async-online') {
                    if (!section.meetings.length) return false; // unknown meeting times aren't safe matches
                    if (timeOfDay === 'morning' && section.meetings.some(m => m.start >= 12 * 60)) return false;
                    if (timeOfDay === 'afternoon' && section.meetings.some(m => m.start < 12 * 60 || m.end > 17 * 60))
                        return false;
                    if (timeOfDay === 'evening' && section.meetings.some(m => m.start < 17 * 60)) return false;
                }
                return true;
            });
            const input: AiCandidateInput = {
                sections: eligible,
                term: actualTerm,
                taken,
                outstanding: outstandingTags(audit),
                subject,
                active: scheduleTimes(schedule),
                avoidFriday: settings.avoidFriday,
                preferAsync: prefs.preferAsync || settings.preferAsync,
                subjectIndex,
            };
            const { chosen, grades } = await chooseAiCandidates(input, gradeForSection, {
                signal: controller.signal,
                onProgress: setProgress,
            });
            const usable = chosen.filter(c => {
                const grade = grades.get(c.section.uniqueId)?.result;
                return !(minGrade > 0 && (!grade || grade.percent < minGrade));
            });
            setCompared({
                sections: eligible.length,
                subjects: new Set(usable.map(c => subjectOf(c.section.courseCode))).size,
            });
            if (!usable.length) {
                setError(
                    "No listed UT sections match these preferences. Widen the days, time or grade preference, or import UT's course list for the semester. AI never suggests classes that are not listed."
                );
                return;
            }
            setProgress(`Asking Fastlane AI about ${usable.length} real UT sections…`);
            const facts = new Map(usable.map(c => [c.section.uniqueId, c]));
            const response = await fetch(ENDPOINT, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessCode: code,
                    requirements: audit.requirements
                        .filter(r => r.status !== 'completed')
                        .slice(0, 35)
                        .map(r => ({ text: r.text.slice(0, 220), tags: r.tags, status: r.status })),
                    completed: [...taken].slice(0, 70),
                    candidates: usable.map(({ section: c }) => ({
                        ...aiFacts(facts.get(c.uniqueId)),
                        id: c.uniqueId,
                        code: c.courseCode,
                        title: c.title,
                        semester: semesterKey(c.semester),
                        hours: c.creditHours,
                        professor: c.instructors.join(', ').slice(0, 80),
                        days: [...new Set(c.meetings.flatMap(m => m.days))],
                        mode: c.modality,
                        tags: c.requirementTags,
                        gradePercent: grades.get(c.uniqueId)?.result.percent ?? null,
                        gradeSample: grades.get(c.uniqueId)?.result.graded ?? null,
                    })),
                    planningRequest: request.trim(),
                    chatHistory: history.slice(-4).map(h => ({ request: h.request, summary: h.summary })),
                    preferences: {
                        semester: actualTerm,
                        avoidFriday: settings.avoidFriday,
                        preferAsync: settings.preferAsync,
                        minGrade,
                        timeOfDay,
                        avoidDays,
                        asyncCount: prefs.asyncCount,
                        easyGrades: prefs.easyGrades,
                        plannedElsewhere: prefs.plannedElsewhere,
                        excludedCourses: prefs.excludedCourses,
                    },
                }),
            });
            const payload = (await response.json()) as AiResponse;
            if (response.status === 401 && savedCode) {
                await FastlaneAiAccessStore.set('accessCode', '');
                setInviteCode('');
            }
            if (!response.ok) throw new Error(payload.error ?? `AI service unavailable (HTTP ${response.status})`);
            if (!savedCode) await FastlaneAiAccessStore.set('accessCode', code);
            const sections = new Map(usable.map(c => [c.section.uniqueId, c.section]));
            setAnswered({ sections, facts, grades });
            setRecommendations((payload.recommendations ?? []).filter(r => sections.has(r.id)));
            setHistory(previous =>
                [...previous, { id: Date.now(), request: request.trim(), summary: payload.summary ?? '' }].slice(-6)
            );
            setRequest('');
        } catch (failure) {
            if (controller.signal.aborted) setError('Stopped. Nothing was sent.');
            else setError(failure instanceof Error ? failure.message : 'AI recommendations are unavailable.');
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setBusy(false);
            setProgress('');
        }
    };
    const draft = safeAiScheduleDraft(
        recommendations.map(r => r.id),
        // a clearly missing printed prerequisite keeps a section out of an automatic draft
        [...answered.sections.values()].filter(c => answered.facts.get(c.uniqueId)?.prerequisite.status !== 'unmet'),
        16,
        settings.avoidFriday
    );
    const makeDraft = async () => {
        if (draft.length < 2) return;
        try {
            const name = `AI draft · ${actualTerm || 'Upcoming semester'}`;
            await createPlanningSchedule(name, draft);
            setDraftResult(
                `Created ${name} with ${draft.length} classes and ${draft.reduce((n, c) => n + c.creditHours, 0)} credits. Select it in My schedule to review.`
            );
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not create schedule.');
        }
    };
    const add = async (c: SectionRecord) => {
        if (!schedule || !c.course) return;
        try {
            await addOrSwap(schedule.id, c);
            setSavedId(c.uniqueId);
            setError('');
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not add this section.');
        }
    };

    return (
        <section className='card planner-glass ai-advisor'>
            <div>
                <span className='eyebrow'>ASK FASTLANE</span>
                <h2>What classes should I take?</h2>
                <p className='small muted'>
                    Describe your ideal week, degree needs, online classes, or planned ACC courses. Fastlane uses listed
                    UT sections and your imported IDA, not invented classes.
                </p>
            </div>
            <div className='chat-history' role='log' aria-label='Planning conversation'>
                {history.map(turn => (
                    <div key={turn.id} className='chat-turn'>
                        <p className='chat-user'>{turn.request}</p>
                        <p className='chat-answer'>{turn.summary || 'Recommendations are shown below.'}</p>
                    </div>
                ))}
            </div>
            <label className='field'>
                Tell Fastlane what you need
                <textarea
                    rows={3}
                    value={request}
                    onChange={e => setRequest(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
                    }}
                    placeholder='Find me 12–13 credits that count for my degree, no Monday/Wednesday/Friday classes, and 1–2 fully asynchronous online classes. I plan to take Macro through ACC.'
                    aria-label='Ask Fastlane for class recommendations'
                />
            </label>
            <div className='ai-quick-filters'>
                <label>
                    Preferred class time
                    <select value={timeChoice} onChange={e => setTimeChoice(e.target.value as typeof timeChoice)}>
                        <option value='any'>{prefs.timeOfDay === 'any' ? 'Any time' : 'From my message'}</option>
                        <option value='morning'>Morning</option>
                        <option value='afternoon'>Afternoon</option>
                        <option value='evening'>Evening</option>
                    </select>
                </label>
                <label>
                    Historical A− or better
                    <select value={minGrade} onChange={e => setMinGrade(Number(e.target.value))}>
                        <option value={0}>Any / unknown</option>
                        <option value={60}>60% or higher</option>
                        <option value={70}>70% or higher</option>
                        <option value={80}>80% or higher</option>
                        <option value={90}>90% or higher</option>
                    </select>
                </label>
            </div>
            {understood.length > 0 && (
                <ul className='understood small' aria-label='What Fastlane understood'>
                    {understood.map(line => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            )}
            <div className='ai-advisor-body'>
                <p className='small muted'>
                    {compared
                        ? `Last request compared ${compared.sections.toLocaleString()} listed UT sections that fit your preferences and sent the best matches from ${compared.subjects} subjects to AI.`
                        : `When you ask, Fastlane compares ${catalog.length.toLocaleString()} listed UT sections against your unfinished IDA requirements, printed prerequisites, schedule conflicts, preferences and historical grades.`}
                    {subject ? ` Subject filter: ${subjectForCode(subject)?.name ?? subject} (${subject}).` : ''}
                </p>
                {loadingCatalog ? <p className='small muted'>Loading UT classes…</p> : null}
                {!loadingCatalog && !subjectHasSections && (
                    <p role='status' className='notice warn'>
                        No {subjectForCode(subject)?.name ?? subject} sections are listed for{' '}
                        {actualTerm || 'this semester'}. AI never substitutes UGS or another subject when {subject} is
                        selected.{' '}
                        <a href={utSubjectScheduleUrl(actualTerm, subject)} target='_blank' rel='noopener noreferrer'>
                            Open this subject on UT's course schedule
                        </a>{' '}
                        to check it.
                    </p>
                )}
                {!audit && <div className='notice warn'>Import your IDA in Degree progress first.</div>}
                {!loadingCatalog && !catalog.length && (
                    <div className='notice small'>
                        No UT classes are loaded yet. Import UT's course list on this page so AI can compare classes
                        from every subject.
                    </div>
                )}
                {savedCode ? (
                    <p className='small muted'>
                        AI access saved on this device. No code needed for future schedules.{' '}
                        <button
                            type='button'
                            className='btn sm'
                            onClick={() => {
                                setInviteCode('');
                                void FastlaneAiAccessStore.set('accessCode', '');
                            }}
                        >
                            Forget code
                        </button>
                    </p>
                ) : (
                    <label className='field'>
                        One-time beta invite code (not your Groq API key)
                        <input
                            type='password'
                            autoComplete='off'
                            value={inviteCode}
                            onChange={e => setInviteCode(e.target.value)}
                            placeholder='Enter once to enable AI'
                        />
                    </label>
                )}
                <label className='check'>
                    <input type='checkbox' checked={consent} onChange={e => setConsent(e.target.checked)} />
                    <span className='small'>
                        I agree to send my unfinished requirement descriptions, completed course codes, preferences your
                        typed planning request and selected public course details to Fastlane's Vercel server and Groq.
                        No name, EID or full IDA file is sent.
                    </span>
                </label>
                <div className='row'>
                    <button
                        type='button'
                        className='btn primary'
                        disabled={!consent || !audit || !catalog.length || busy || !request.trim()}
                        onClick={() => void run()}
                    >
                        {busy ? 'Working…' : 'Ask Fastlane'}
                    </button>
                    {busy && (
                        <button type='button' className='btn' onClick={() => abortRef.current?.abort()}>
                            Cancel
                        </button>
                    )}
                </div>
                {busy && progress && (
                    <p role='status' className='small muted ai-progress'>
                        {progress}
                    </p>
                )}
                {error && (
                    <p className='notice warn' role='alert'>
                        {error}
                    </p>
                )}
                {recommendations.map(rec => {
                    const c = answered.sections.get(rec.id);
                    if (!c) return null;
                    const g = answered.grades.get(c.uniqueId);
                    return (
                        <div key={rec.id} className='ai-result'>
                            <ClassCard
                                section={c}
                                grade={g}
                                badge={
                                    answered.facts.get(c.uniqueId)?.prerequisite.status === 'unmet'
                                        ? 'Prerequisite needed'
                                        : undefined
                                }
                            >
                                <button
                                    type='button'
                                    className='btn sm'
                                    disabled={!schedule || !c.course}
                                    onClick={() => void add(c)}
                                >
                                    {savedId === c.uniqueId ? 'Added to schedule' : 'Add to my schedule'}
                                </button>
                            </ClassCard>
                        </div>
                    );
                })}
                {draft.length >= 2 && (
                    <div className='card'>
                        <h3>Create a draft schedule</h3>
                        <p className='small muted'>
                            {draft.length} nonconflicting, verified sections ·{' '}
                            {draft.reduce((n, c) => n + c.creditHours, 0)} credits. This creates a separate schedule
                            without changing your current one. Check prerequisites, degree credit and seat availability.
                        </p>
                        <button type='button' className='btn primary' onClick={() => void makeDraft()}>
                            Create draft schedule
                        </button>
                    </div>
                )}
                {draftResult && (
                    <p role='status' className='notice'>
                        {draftResult}
                    </p>
                )}
                {!busy && history.length > 0 && recommendations.length === 0 && !request.trim() && (
                    <p className='small muted'>No verified candidate IDs were returned. Try broader UT sections.</p>
                )}
                <p className='small muted'>
                    AI advice is not an official degree evaluation. Verify prerequisites, requirements and availability
                    with UT.
                </p>
            </div>
        </section>
    );
}
