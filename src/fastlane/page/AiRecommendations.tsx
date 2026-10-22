import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useState } from 'react';
import { safeAiScheduleDraft } from '../core/aiSchedule';
import { subjectForCode, utSubjectScheduleUrl } from '../data/subjects';
import { normalizeCourseCode } from '../core/requirements';
import { type SectionRecord, semesterKey } from '../core/sections';
import { addOrSwap, createPlanningSchedule } from '../services/planningService';
import { loadCachedSections } from '../services/recommendationService';
import { FastlaneAuditStore, FastlaneSettingsStore } from '../storage/stores';
import { useGradeStats } from './hooks';

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

const department = (code: string) =>
    code
        .replace(/\s+\d.*$/, '')
        .trim()
        .toUpperCase();

/** Spread a limited request across actual departments, rather than sending only the first UGS rows. */
function diverseCandidates(sections: SectionRecord[], wantedSemester: string, taken: Set<string>, selectedSubject: string) {
    const groups = new Map<string, SectionRecord[]>();
    const newest = [...sections].sort((a, b) => b.capturedAt - a.capturedAt);
    for (const section of newest) {
        if (section.status?.value === 'CANCELLED' || !section.course) continue;
        if (wantedSemester && semesterKey(section.semester) !== wantedSemester) continue;
        if (taken.has(normalizeCourseCode(section.courseCode))) continue;
        const subject = department(section.courseCode);
        if (selectedSubject && subject !== selectedSubject) continue;
        const group = groups.get(subject) ?? [];
        if (group.length < 8) group.push(section);
        groups.set(subject, group);
    }
    const selected: SectionRecord[] = [];
    // Round-robin prevents a large UGS cache from crowding out ECO, M, HIS, etc.
    for (let i = 0; i < 8 && selected.length < 38; i++) {
        for (const group of groups.values()) {
            const entry = group[i];
            if (entry && selected.length < 38) selected.push(entry);
        }
    }
    return selected;
}

export default function AiRecommendations({ subject = '' }: { subject?: string }) {
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const settings = FastlaneSettingsStore.useStore(s => s);
    const schedule = useActiveSchedule();
    const [catalog, setCatalog] = useState<SectionRecord[]>([]);
    const [loadingCatalog, setLoadingCatalog] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const [consent, setConsent] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [summary, setSummary] = useState('');
    const [recommendations, setRecommendations] = useState<AiSelection[]>([]);
    const [savedId, setSavedId] = useState<number | null>(null);
    const [draftResult, setDraftResult] = useState('');

    useEffect(() => {
        let active = true;
        void loadCachedSections(null).then(items => {
            if (active) {
                setCatalog(items);
                setLoadingCatalog(false);
            }
        });
        return () => {
            active = false;
        };
    }, []);

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

    const candidates = useMemo(
        () => diverseCandidates(catalog, settings.targetSemester ?? '', taken, subject),
        [catalog, settings.targetSemester, taken, subject]
    );
    const grades = useGradeStats(candidates, 'A-');
    const candidateIndex = useMemo(() => new Map(candidates.map(c => [c.uniqueId, c])), [candidates]);
    const coveredSubjects = [...new Set(candidates.map(c => department(c.courseCode)))];
    const latest = [...new Set(catalog.map(c => semesterKey(c.semester)).filter(x => x !== 'unknown'))];
    const actualTerm = settings.targetSemester ?? (latest.length === 1 ? latest[0] ?? '' : '');

    const run = async () => {
        if (!consent || busy) return;
        if (!audit) {
            setError('Import your IDA on Degree progress before asking AI to plan your degree.');
            return;
        }
        if (!candidates.length) {
            setError(
                'No verified sections are cached for the selected subject and semester. AI cannot suggest uncached classes. Populate the UT semester course dataset, then try again.'
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
                    accessCode: inviteCode,
                    requirements: audit.requirements
                        .filter(r => r.status !== 'completed')
                        .slice(0, 35)
                        .map(r => ({ text: r.text.slice(0, 220), tags: r.tags, status: r.status })),
                    completed: [...taken].slice(0, 70),
                    candidates: candidates.map(c => ({
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
                    preferences: {
                        semester: actualTerm,
                        avoidFriday: settings.avoidFriday,
                        preferAsync: settings.preferAsync,
                        minGrade: 0,
                    },
                }),
            });
            const payload = (await response.json()) as AiResponse;
            if (!response.ok) throw new Error(payload.error ?? `AI service unavailable (HTTP ${response.status})`);
            setSummary(payload.summary ?? '');
            setRecommendations((payload.recommendations ?? []).filter(r => candidateIndex.has(r.id)));
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'AI recommendations are unavailable.');
        } finally {
            setBusy(false);
        }
    };
    const draft = safeAiScheduleDraft(
        recommendations.map(r => r.id),
        candidates,
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
            <div className='row between'>
                <div>
                    <div className='eyebrow'>OPTIONAL · AI ASSISTED</div>
                    <h2>Find better classes with AI</h2>
                    <p className='small muted'>
                        Use your remaining IDA requirements to compare real UT sections, including subjects beyond UGS.
                    </p>
                </div>
                <button
                    type='button'
                    className='btn primary'
                    onClick={() => setExpanded(v => !v)}
                    aria-expanded={expanded}
                >
                    {expanded ? 'Hide AI' : 'Try AI recommendations'}
                </button>
            </div>
            {expanded && (
                <div className='ai-advisor-body'>
                    <p className='small muted'>
                        AI input: {candidates.length} verified sections from {coveredSubjects.length} subjects.
                        {subject ? ` Subject filter: ${subjectForCode(subject)?.name ?? subject} (${subject}).` : ''}
                        Local cache total: {catalog.length} sections.
                        {coveredSubjects.length > 0 && ` Includes ${coveredSubjects.slice(0, 10).join(', ')}.`}
                    </p>
                    {loadingCatalog ? <p className='small muted'>Checking saved UT listings…</p> : null}
                    {!loadingCatalog && subject && candidates.length === 0 && (
                        <p role='status' className='notice warn'>
                            No {subjectForCode(subject)?.name ?? subject} sections are available in Fastlane's saved data.
                            AI cannot recommend UGS or another subject when {subject} is selected.
                            <a
                                href={utSubjectScheduleUrl(actualTerm, subject)}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                Open this subject on UT's course schedule
                            </a>{' '}
                            to load real listings; a university-wide semester dataset is still needed for full coverage.
                        </p>
                    )}
                    {!audit && <div className='notice warn'>Import your IDA in Degree progress first.</div>}
                    {!subject && coveredSubjects.length < 3 && (
                        <div className='notice small'>
                            Your saved catalog covers too few subjects. AI cannot discover missing UT sections.
                            <a
                                href='https://utdirect.utexas.edu/apps/registrar/course_schedule/'
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                {' '}
                                Browse other UT departments
                            </a>{' '}
                            to populate it.
                        </div>
                    )}
                    <label className='field'>
                        Beta invite code (not an API key)
                        <input
                            type='password'
                            autoComplete='off'
                            value={inviteCode}
                            onChange={e => setInviteCode(e.target.value)}
                            placeholder='Code shared by Fastlane owner'
                        />
                    </label>
                    <label className='check'>
                        <input type='checkbox' checked={consent} onChange={e => setConsent(e.target.checked)} />
                        <span className='small'>
                            I agree to send my unfinished requirement descriptions, completed course codes, preferences
                            and selected public course details to Fastlane's Vercel server and Groq. No name, EID or
                            full IDA file is sent.
                        </span>
                    </label>
                    <button
                        type='button'
                        className='btn primary'
                        disabled={!consent || !audit || !candidates.length || busy}
                        onClick={() => void run()}
                    >
                        {busy ? 'Analyzing classes…' : 'Get recommendations'}
                    </button>
                    {error && (
                        <p className='notice warn' role='alert'>
                            {error}
                        </p>
                    )}
                    {summary && <p className='small'>{summary}</p>}
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
                                </p>
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
