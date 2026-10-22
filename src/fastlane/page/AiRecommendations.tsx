import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useState } from 'react';
import { scheduleTimes } from '../adapters/utrp';
import { requestedDaysOff } from '../core/chatPreferences';
import { outstandingTags } from '../audit/parseAudit';
import type { AiCandidate, AiCandidateInput } from '../core/aiCandidates';
import { finalizeAiCandidates, shortlistAiCandidates } from '../core/aiCandidates';
import { safeAiScheduleDraft } from '../core/aiSchedule';
import type { PrerequisiteCheck } from '../core/prerequisites';
import { describePrerequisites, subjectNameIndex } from '../core/prerequisites';
import { normalizeCourseCode } from '../core/requirements';
import { isConfirmedSection, type SectionRecord, semesterKey, subjectOf } from '../core/sections';
import { subjectForCode, utSubjectScheduleUrl } from '../data/subjects';
import { addOrSwap, createPlanningSchedule } from '../services/planningService';
import { FastlaneAiAccessStore, FastlaneAuditStore, FastlaneSettingsStore } from '../storage/stores';
import { inventorySubjects, SectionEvidence, useInventory } from './CourseInventory';
import { useGradeStats } from './hooks';

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
    const expanded = true;
    const [request, setRequest] = useState('');
    const [lastRequest, setLastRequest] = useState('');
    const [history, setHistory] = useState<Array<{ request: string; summary: string }>>([]);
    const [timeOfDay, setTimeOfDay] = useState<'any' | 'morning' | 'afternoon' | 'evening'>('any');
    const [minGrade, setMinGrade] = useState(0);
    const avoidDays = useMemo(() => requestedDaysOff(request || lastRequest), [request, lastRequest]);
    const [consent, setConsent] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const savedCode = FastlaneAiAccessStore.useStore(s => s.accessCode);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [summary, setSummary] = useState('');
    const [recommendations, setRecommendations] = useState<AiSelection[]>([]);
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

    const latest = [...new Set(catalog.map(c => semesterKey(c.semester)).filter(x => x !== 'unknown'))];
    const listedTerm = [...inventory.metas].sort((a, b) => b.termCode.localeCompare(a.termCode))[0]?.term;
    const actualTerm = settings.targetSemester ?? listedTerm ?? (latest.length === 1 ? (latest[0] ?? '') : '');
    const selectionInput = useMemo<AiCandidateInput>(
        () => ({
            sections: catalog,
            term: actualTerm,
            taken,
            outstanding: audit ? outstandingTags(audit) : [],
            subject,
            active: scheduleTimes(schedule),
            avoidFriday: settings.avoidFriday,
            preferAsync: settings.preferAsync,
            subjectIndex: subjectNameIndex(inventorySubjects(inventory)),
        }),
        [catalog, actualTerm, taken, audit, subject, schedule, settings.avoidFriday, settings.preferAsync, inventory]
    );
    // ranked only while the AI panel is open
    const shortlist = useMemo(
        () => (expanded ? shortlistAiCandidates(selectionInput) : []),
        [expanded, selectionInput]
    );
    const grades = useGradeStats(
        useMemo(() => shortlist.map(c => c.section), [shortlist]),
        'A-'
    );
    const chosen = useMemo(
        () => finalizeAiCandidates(shortlist, selectionInput, s => grades.get(s.uniqueId)),
        [shortlist, selectionInput, grades]
    );
    const candidates = useMemo(() => chosen.map(c => c.section).filter(section => {
        const grade = grades.get(section.uniqueId)?.result;
        if (minGrade > 0 && (!grade || grade.percent < minGrade)) return false;
        if (avoidDays.some(day => section.meetings.some(meeting => meeting.days.includes(day)))) return false;
        if (timeOfDay !== 'any' && section.modality !== 'async-online') {
            if (!section.meetings.length) return false; // unknown meeting times aren't safe matches
            if (timeOfDay === 'morning' && section.meetings.some(m => m.start >= 12 * 60)) return false;
            if (timeOfDay === 'afternoon' && section.meetings.some(m => m.start < 12 * 60 || m.end > 17 * 60)) return false;
            if (timeOfDay === 'evening' && section.meetings.some(m => m.start < 17 * 60)) return false;
        }
        return true;
    }), [chosen, grades, minGrade, timeOfDay, avoidDays]);
    const facts = useMemo(() => new Map(chosen.map(c => [c.section.uniqueId, c])), [chosen]);
    const candidateIndex = useMemo(() => new Map(candidates.map(c => [c.uniqueId, c])), [candidates]);
    const coveredSubjects = [...new Set(candidates.map(c => subjectOf(c.courseCode)))];

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
        if (!candidates.length) {
            setError(
                "No UT sections are available for the selected subject and semester. Import UT's course list for the semester, then try again. AI never suggests classes that are not listed."
            );
            return;
        }
        setBusy(true);
        setError('');
        setRecommendations([]);
        setSavedId(null);
        setDraftResult('');
        try {
            const response = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessCode: code,
                    requirements: audit.requirements
                        .filter(r => r.status !== 'completed')
                        .slice(0, 35)
                        .map(r => ({ text: r.text.slice(0, 220), tags: r.tags, status: r.status })),
                    completed: [...taken].slice(0, 70),
                    candidates: candidates.map(c => ({
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
                    chatHistory: history.slice(-4),
                    preferences: {
                        semester: actualTerm,
                        avoidFriday: settings.avoidFriday,
                        preferAsync: settings.preferAsync,
                        minGrade,
                        timeOfDay,
                        avoidDays,
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
            setSummary(payload.summary ?? '');
            setRecommendations((payload.recommendations ?? []).filter(r => candidateIndex.has(r.id)));
            setHistory(previous => [...previous, { request: request.trim(), summary: payload.summary ?? '' }].slice(-5));
            setLastRequest(request.trim());
            setRequest('');
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'AI recommendations are unavailable.');
        } finally {
            setBusy(false);
        }
    };
    const draft = safeAiScheduleDraft(
        recommendations.map(r => r.id),
        // a clearly missing printed prerequisite keeps a section out of an automatic draft
        candidates.filter(c => facts.get(c.uniqueId)?.prerequisite.status !== 'unmet'),
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
                <p className='small muted'>Describe your ideal week, degree needs, online classes, or planned ACC courses.
                    Fastlane uses listed UT sections and your imported IDA, not invented classes.</p>
            </div>
            <div className='chat-history' role='log' aria-label='Planning conversation'>
                {history.map((turn, i) => (
                    <div key={i} className='chat-turn'>
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
                    placeholder='Find me 12–13 credits that count for my degree, no Monday/Wednesday/Friday classes, and 1–2 fully asynchronous online classes. I plan to take Macro through ACC.'
                    aria-label='Ask Fastlane for class recommendations'
                />
            </label>
            <div className='ai-quick-filters'>
                <label>Preferred class time
                    <select value={timeOfDay} onChange={e => setTimeOfDay(e.target.value as typeof timeOfDay)}>
                        <option value='any'>Any time</option>
                        <option value='morning'>Morning</option>
                        <option value='afternoon'>Afternoon</option>
                        <option value='evening'>Evening</option>
                    </select>
                </label>
                <label>Historical A− or better
                    <select value={minGrade} onChange={e => setMinGrade(Number(e.target.value))}>
                        <option value={0}>Any / unknown</option>
                        <option value={60}>60% or higher</option>
                        <option value={70}>70% or higher</option>
                        <option value={80}>80% or higher</option>
                        <option value={90}>90% or higher</option>
                    </select>
                </label>
            </div>
            {avoidDays.length > 0 && <p className='small muted'>Days excluded from this request: {avoidDays.join(', ')}.</p>}
            {expanded && (
                <div className='ai-advisor-body'>
                    <p className='small muted'>
                        AI input: {candidates.length} real UT sections from {coveredSubjects.length} subjects, chosen
                        locally from {catalog.length.toLocaleString()} by unfinished IDA requirements, printed
                        prerequisites, conflicts with your schedule, your preferences and historical grades.
                        {subject ? ` Subject filter: ${subjectForCode(subject)?.name ?? subject} (${subject}).` : ''}
                        {coveredSubjects.length > 0 && ` Includes ${coveredSubjects.slice(0, 10).join(', ')}.`}
                    </p>
                    {loadingCatalog ? <p className='small muted'>Loading UT classes…</p> : null}
                    {!loadingCatalog && subject && candidates.length === 0 && (
                        <p role='status' className='notice warn'>
                            No {subjectForCode(subject)?.name ?? subject} sections are listed for{' '}
                            {actualTerm || 'this semester'}. AI never substitutes UGS or another subject when {subject}{' '}
                            is selected.
                            <a
                                href={utSubjectScheduleUrl(actualTerm, subject)}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                Open this subject on UT's course schedule
                            </a>{' '}
                            to check it.
                        </p>
                    )}
                    {!audit && <div className='notice warn'>Import your IDA in Degree progress first.</div>}
                    {!subject && !inventory.metas.length && coveredSubjects.length < 3 && (
                        <div className='notice small'>
                            Only a few subjects are available. Import UT's course list at the top of this page so AI can
                            compare classes from every subject.
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
                            I agree to send my unfinished requirement descriptions, completed course codes, preferences
                            your typed planning request and selected public course details to Fastlane's Vercel server and Groq. No name, EID or
                            full IDA file is sent.
                        </span>
                    </label>
                    <button
                        type='button'
                        className='btn primary'
                        disabled={!consent || !audit || !candidates.length || busy || !request.trim()}
                        onClick={() => void run()}
                    >
                        {busy ? 'Checking real UT sections…' : 'Ask Fastlane'}
                    </button>
                    {error && (
                        <p className='notice warn' role='alert'>
                            {error}
                        </p>
                    )}
                    {recommendations.map(rec => {
                        const c = candidateIndex.get(rec.id);
                        if (!c) return null;
                        const g = grades.get(c.uniqueId);
                        return (
                            <div key={rec.id} className='ai-result'>
                                <div className='row between'>
                                    <b>
                                        {c.courseCode} · {c.title}
                                    </b>
                                    <span className='chip'>
                                        {rec.confidence === 'high' ? 'Likely match' : 'Review degree fit'}
                                    </span>
                                </div>
                                <p className='small'>{rec.reason}</p>
                                <p className='small muted'>
                                    {c.instructors.join(', ') || 'Instructor unlisted'} · {semesterKey(c.semester)}
                                    {g
                                        ? ` · ${g.result.percent.toFixed(0)}% historical A− or better (n=${g.result.graded})`
                                        : ' · No historical grade data'}
                                </p>
                                <p className='small muted'>
                                    Requirement: {rec.requirement || 'Verify against IDA'}.
                                    {rec.warning && ` ${rec.warning}`}
                                    {facts.get(c.uniqueId) &&
                                        ` ${describePrerequisites(facts.get(c.uniqueId)?.prerequisite as PrerequisiteCheck)}.`}
                                </p>
                                <SectionEvidence s={c} />
                                <button
                                    type='button'
                                    className='btn sm'
                                    disabled={!schedule || !c.course}
                                    onClick={() => void add(c)}
                                >
                                    {savedId === c.uniqueId ? 'Added to schedule' : 'Add to my schedule'}
                                </button>
                            </div>
                        );
                    })}
                    {draft.length >= 2 && (
                        <div className='card'>
                            <h3>Create a draft schedule</h3>
                            <p className='small muted'>
                                {draft.length} nonconflicting, verified sections ·{' '}
                                {draft.reduce((n, c) => n + c.creditHours, 0)} credits. This creates a separate schedule
                                without changing your current one. Check prerequisites, degree credit and seat
                                availability.
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
                    {!busy && summary && recommendations.length === 0 && (
                        <p className='small muted'>No verified candidate IDs were returned. Try broader UT sections.</p>
                    )}
                    <p className='small muted'>
                        AI advice is not an official degree evaluation. Verify prerequisites, requirements and
                        availability with UT.
                    </p>
                </div>
            )}
        </section>
    );
}
