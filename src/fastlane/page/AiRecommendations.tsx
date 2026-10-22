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
import { DAY_NAMES, detectConflicts } from '../core/meetings';
import { subjectNameIndex } from '../core/prerequisites';
import type { ProposalVersion } from '../core/proposal';
import {
    breaksPreferences,
    diffSections,
    fillSlots,
    fitsWith,
    isTargetedChange,
    refineIntent,
    replacementFits,
    resolveTarget,
} from '../core/proposal';
import { normalizeCourseCode } from '../core/requirements';
import { isConfirmedSection, type SectionRecord, semesterKey, subjectOf, toSectionTimes } from '../core/sections';
import { subjectForCode, utSubjectScheduleUrl } from '../data/subjects';
import { addOrSwap, createPlanningSchedule } from '../services/planningService';
import { FastlaneAiAccessStore, FastlaneAuditStore, FastlaneSettingsStore } from '../storage/stores';
import { ClassCard } from './ClassCard';
import { inventorySubjects, useInventory } from './CourseInventory';
import type { AiPick } from './ProposalPanel';
import ProposalPanel from './ProposalPanel';

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

const pad = (n: number) => String(n).padStart(5, '0');

interface ChatTurn {
    id: number;
    /** what the student typed */
    request: string;
    /** the request plus the class it was about, so preferences such as "through ACC" carry over */
    context: string;
    summary: string;
}

export default function AiRecommendations({ subject = '' }: { subject?: string }) {
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const settings = FastlaneSettingsStore.useStore(s => s);
    const schedule = useActiveSchedule();
    const inventory = useInventory();
    const catalog = inventory.sections;
    const loadingCatalog = !inventory.loaded;
    const [request, setRequest] = useState('');
    const [history, setHistory] = useState<ChatTurn[]>([]);
    const [timeChoice, setTimeChoice] = useState<'any' | 'morning' | 'afternoon' | 'evening'>('any');
    const [minGrade, setMinGrade] = useState(0);
    const subjectCodes = useMemo(() => new Set(inventorySubjects(inventory).map(s => s.code)), [inventory]);
    // the proposed schedule and its versions (undo / redo); never saved until the student asks
    const [versions, setVersions] = useState<ProposalVersion[]>([]);
    const [versionIndex, setVersionIndex] = useState(0);
    const proposal = versions[versionIndex] ?? null;
    // the proposed class a follow-up is about (set by "Ask AI to replace")
    const [focusId, setFocusId] = useState<number | null>(null);
    const focus = proposal?.sections.find(s => s.uniqueId === focusId) ?? null;
    const [droppedTags, setDroppedTags] = useState<string[]>([]);
    const [saveNote, setSaveNote] = useState('');
    const textRef = useRef<HTMLTextAreaElement>(null);
    // preferences carry over between follow-ups; the message being typed is included before it is sent
    const conversation = useMemo(
        () => [...history.map(h => h.context), request.trim()].filter(Boolean),
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
    // everything AI has been shown in this conversation, so earlier picks keep their facts and grades
    const [known, setKnown] = useState<{
        sections: Map<number, SectionRecord>;
        facts: Map<number, AiCandidate>;
        grades: Map<number, GradeStat | null>;
        picks: Map<number, AiPick>;
    }>({ sections: new Map(), facts: new Map(), grades: new Map(), picks: new Map() });
    const [savedId, setSavedId] = useState<number | null>(null);

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

    const pushVersion = (sections: SectionRecord[], note: string, base = proposal) => {
        const next: ProposalVersion = {
            id: Date.now(),
            sections,
            note,
            ...diffSections(base?.sections ?? [], sections),
        };
        const kept = base ? versions.slice(0, versionIndex + 1) : [];
        setVersions([...kept, next]);
        setVersionIndex(kept.length);
        setSaveNote('');
    };

    /** Runs only on submit: filters, ranks and grades candidates without blocking the page, then asks AI. */
    const run = async () => {
        if (!consent || busy) return;
        const message = request.trim();
        if (!message) {
            setError(
                focus
                    ? `Tell Fastlane why you want to replace ${focus.courseCode}.`
                    : 'Tell Fastlane what kind of classes or schedule you want first.'
            );
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

        // --- what this message changes: one class of the proposal, the whole plan, or (first time) everything
        const intent = refineIntent(message);
        const target = proposal ? resolveTarget(message, proposal.sections, focusId) : null;
        const targeted =
            !!target &&
            (focusId != null || isTargetedChange(intent) || /\b(?:replace|swap|instead|change)\b/i.test(message));
        if (proposal && !target && /\bthis (?:class|one|course)\b/i.test(message)) {
            setError(
                'Which class do you mean? Click it on the calendar and choose "Ask AI to replace", or name it (for example HIS 314K).'
            );
            return;
        }
        const extraLeftOut = new Set<string>();
        let kept: SectionRecord[] = [];
        let slots = 0;
        let context = message;
        let dropped = droppedTags;
        if (proposal && targeted && target) {
            kept = proposal.sections.filter(s => s.uniqueId !== target.uniqueId);
            slots = intent.removeOnly ? 0 : 1;
            context = `${message} (about ${target.courseCode}, unique ${pad(target.uniqueId)})`;
            if (intent.elsewhere) {
                extraLeftOut.add(normalizeCourseCode(target.courseCode));
                context = `${message} I plan to take ${target.courseCode} through ACC.`;
            }
            if (intent.dropRequirement) {
                dropped = [...new Set([...droppedTags, ...(known.facts.get(target.uniqueId)?.applies ?? [])])];
                setDroppedTags(dropped);
            }
        } else if (proposal) {
            const conversationPrefs = planningPreferences([...history.map(h => h.context), message], subjectCodes);
            const out = new Set(
                [...conversationPrefs.excludedCourses, ...conversationPrefs.plannedElsewhere.map(p => p.code)].map(
                    normalizeCourseCode
                )
            );
            kept = proposal.sections.filter(
                s =>
                    !breaksPreferences(s, {
                        avoidDays: conversationPrefs.avoidDays,
                        timeOfDay: timeChoice !== 'any' ? timeChoice : conversationPrefs.timeOfDay,
                        leftOut: out,
                        noOnline: conversationPrefs.asyncCount?.max === 0,
                    })
            );
            slots = proposal.sections.length - kept.length;
            if (!slots && /\b(?:add|another|more|extra)\b/i.test(message)) slots = 1;
            // nothing to keep or change locally: plan again from scratch as a new version
            if (!slots) kept = [];
        }
        const refining = !!proposal && (targeted || slots > 0 || kept.length > 0);

        if (refining && slots === 0) {
            // removing a class needs no AI call
            pushVersion(kept, `Removed ${target?.courseCode}. Everything else is unchanged.`);
            setHistory(previous =>
                [
                    ...previous,
                    { id: Date.now(), request: message, context, summary: `Removed ${target?.courseCode}.` },
                ].slice(-6)
            );
            setRequest('');
            setFocusId(null);
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setError('');
        setProgress('Reading your request…');
        setSavedId(null);
        try {
            // hard constraints from the whole conversation are applied before candidates are chosen
            const eligible = catalog.filter(section => {
                const sectionCode = normalizeCourseCode(section.courseCode);
                if (leftOut.has(sectionCode) || extraLeftOut.has(sectionCode)) return false;
                if (prefs.asyncCount?.max === 0 && section.modality === 'async-online') return false;
                if (avoidDays.some(day => section.meetings.some(m => m.days.includes(day)))) return false;
                if (timeOfDay !== 'any' && section.modality !== 'async-online') {
                    if (!section.meetings.length) return false; // unknown meeting times aren't safe matches
                    if (timeOfDay === 'morning' && section.meetings.some(m => m.start >= 12 * 60)) return false;
                    if (timeOfDay === 'afternoon' && section.meetings.some(m => m.start < 12 * 60 || m.end > 17 * 60))
                        return false;
                    if (timeOfDay === 'evening' && section.meetings.some(m => m.start < 17 * 60)) return false;
                }
                if (refining) {
                    // a replacement keeps every other proposed class: no time conflict, no second section
                    if (!fitsWith(section, kept)) return false;
                    if (
                        target &&
                        targeted &&
                        !replacementFits(section, target, { ...intent, easier: false }, () => null)
                    )
                        return false;
                }
                return true;
            });
            const allOutstanding = outstandingTags(audit).filter(t => !dropped.includes(t));
            const targetTags =
                target && targeted && !intent.dropRequirement ? (known.facts.get(target.uniqueId)?.applies ?? []) : [];
            const input: AiCandidateInput = {
                sections: eligible,
                term: actualTerm,
                taken,
                // a replacement first looks for the same requirement as the class it replaces
                outstanding: targetTags.length ? targetTags : allOutstanding,
                subject,
                active: refining ? kept.map(toSectionTimes) : scheduleTimes(schedule),
                avoidFriday: settings.avoidFriday,
                preferAsync: prefs.preferAsync || settings.preferAsync || (targeted && intent.online),
                subjectIndex,
            };
            let picked = await chooseAiCandidates(input, gradeForSection, {
                signal: controller.signal,
                onProgress: setProgress,
            });
            if (targetTags.length && !picked.chosen.some(c => c.applies.length))
                picked = await chooseAiCandidates({ ...input, outstanding: allOutstanding }, gradeForSection, {
                    signal: controller.signal,
                    onProgress: setProgress,
                });
            const { chosen, grades } = picked;
            const gradeOf = (s: SectionRecord) =>
                (grades.get(s.uniqueId) ?? known.grades.get(s.uniqueId))?.result.percent ?? null;
            const usable = chosen.filter(c => {
                const grade = grades.get(c.section.uniqueId)?.result;
                if (minGrade > 0 && (!grade || grade.percent < minGrade)) return false;
                if (refining && c.conflict !== 'clear') return false;
                if (targeted && target && intent.easier && !replacementFits(c.section, target, intent, gradeOf))
                    return false;
                return true;
            });
            setCompared({
                sections: eligible.length,
                subjects: new Set(usable.map(c => subjectOf(c.section.courseCode))).size,
            });
            if (!usable.length) {
                setError(
                    targeted && target
                        ? `No listed UT section fits as a replacement for ${target.courseCode} without breaking the rest of your proposed week. Try a different reason, or remove it instead.`
                        : "No listed UT sections match these preferences. Widen the days, time or grade preference, or import UT's course list for the semester. AI never suggests classes that are not listed."
                );
                return;
            }
            setProgress(`Asking Fastlane AI about ${usable.length} real UT sections…`);
            const facts = new Map(usable.map(c => [c.section.uniqueId, c]));
            const planningRequest =
                refining && proposal
                    ? `${message}\n\nCurrent proposed schedule: ${proposal.sections.map(s => `${s.courseCode} (${pad(s.uniqueId)})`).join(', ')}. ${
                          targeted && target
                              ? `Replace only ${target.courseCode} (${pad(target.uniqueId)}); keep the other classes.`
                              : `Keep ${kept.map(s => s.courseCode).join(', ') || 'nothing'}; suggest ${slots} class${slots === 1 ? '' : 'es'} to fill the open place${slots === 1 ? '' : 's'}.`
                      } Every candidate already fits the kept classes.`
                    : message;
            const response = await fetch(ENDPOINT, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accessCode: code,
                    requirements: audit.requirements
                        .filter(r => r.status !== 'completed' && !r.tags.every(t => dropped.includes(t)))
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
                    planningRequest,
                    chatHistory: history.slice(-4).map(h => ({ request: h.context, summary: h.summary })),
                    preferences: {
                        semester: actualTerm,
                        avoidFriday: settings.avoidFriday,
                        preferAsync: settings.preferAsync,
                        minGrade,
                        timeOfDay,
                        avoidDays,
                        asyncCount: prefs.asyncCount,
                        easyGrades: prefs.easyGrades || (targeted && intent.easier),
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
            const recs = (payload.recommendations ?? []).filter(r => sections.has(r.id));
            const allSections = new Map([...known.sections, ...sections]);
            const allFacts = new Map([...known.facts, ...facts]);
            setKnown({
                sections: allSections,
                facts: allFacts,
                grades: new Map([...known.grades, ...grades]),
                picks: new Map([
                    ...known.picks,
                    ...recs.map(
                        r => [r.id, { reason: r.reason, requirement: r.requirement, warning: r.warning }] as const
                    ),
                ]),
            });
            setRecommendations(recs);

            let summary = payload.summary ?? '';
            if (refining && proposal) {
                const next = fillSlots(
                    kept,
                    recs.map(r => r.id),
                    sections,
                    slots
                );
                const newcomers = next.slice(kept.length);
                if (targeted && target && !newcomers.length && !intent.elsewhere && !intent.dropRequirement) {
                    summary = `AI found no listed section that fits as a replacement for ${target.courseCode}, so it stays. ${summary}`;
                } else {
                    const why = newcomers.map(s => recs.find(r => r.id === s.uniqueId)?.reason).filter(Boolean)[0];
                    const note =
                        targeted && target
                            ? newcomers.length
                                ? `Replaced ${target.courseCode} with ${newcomers.map(s => s.courseCode).join(', ')}${why ? `: ${why}` : '.'} Everything else is unchanged.`
                                : `Removed ${target.courseCode}; no listed section fit in its place.`
                            : `Kept ${kept.length} class${kept.length === 1 ? '' : 'es'}; ${newcomers.length ? `added ${newcomers.map(s => s.courseCode).join(', ')}` : 'nothing fit the open places'}.`;
                    pushVersion(next, note);
                    summary = `${note} ${summary}`.trim();
                }
            } else {
                // first proposal: a draft of nonconflicting, verified picks (unmet printed prerequisites stay out)
                const draft = safeAiScheduleDraft(
                    recs.map(r => r.id),
                    [...sections.values()].filter(c => facts.get(c.uniqueId)?.prerequisite.status !== 'unmet'),
                    16,
                    settings.avoidFriday
                );
                if (draft.length)
                    pushVersion(
                        draft,
                        proposal
                            ? 'A new plan for your updated request (Undo brings back the previous one).'
                            : `A first draft from AI's picks: no time conflicts, at most 16 credits. Click a class to change it.`
                    );
            }
            setHistory(previous => [...previous, { id: Date.now(), request: message, context, summary }].slice(-6));
            setRequest('');
            setFocusId(null);
        } catch (failure) {
            if (controller.signal.aborted) setError('Stopped. Nothing was sent.');
            else setError(failure instanceof Error ? failure.message : 'AI recommendations are unavailable.');
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setBusy(false);
            setProgress('');
        }
    };

    const togglePlan = (c: SectionRecord) => {
        const current = proposal?.sections ?? [];
        if (current.some(s => s.uniqueId === c.uniqueId)) {
            pushVersion(
                current.filter(s => s.uniqueId !== c.uniqueId),
                `Removed ${c.courseCode}.`
            );
            return;
        }
        if (!fitsWith(c, current)) {
            const clash = current.find(
                s =>
                    normalizeCourseCode(s.courseCode) === normalizeCourseCode(c.courseCode) ||
                    detectConflicts(toSectionTimes(c), [toSectionTimes(s)]).status !== 'clear'
            );
            setError(`${c.courseCode} overlaps ${clash?.courseCode ?? 'a proposed class'}. Remove that class first.`);
            return;
        }
        setError('');
        pushVersion([...current, c], `Added ${c.courseCode}.`);
    };
    const alternatives = (target: SectionRecord) => {
        if (!proposal) return [];
        const others = proposal.sections.filter(s => s.uniqueId !== target.uniqueId);
        const tags = new Set(known.facts.get(target.uniqueId)?.applies ?? []);
        return [...known.sections.values()]
            .filter(s => s.uniqueId !== target.uniqueId && fitsWith(s, others))
            .filter(
                s =>
                    normalizeCourseCode(s.courseCode) === normalizeCourseCode(target.courseCode) ||
                    (known.facts.get(s.uniqueId)?.applies ?? []).some(t => tags.has(t))
            )
            .slice(0, 8);
    };
    const saveProposal = async () => {
        if (!proposal?.sections.length) return;
        try {
            const name = `AI plan · ${actualTerm || 'Upcoming semester'}`;
            await createPlanningSchedule(name, proposal.sections);
            setSaveNote(
                `Saved "${name}" with ${proposal.sections.length} classes. Your other schedules were not changed. Select it in My schedule to review.`
            );
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save this schedule.');
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
    const inPlan = new Set(proposal?.sections.map(s => s.uniqueId) ?? []);

    return (
        <section className='card planner-glass ai-advisor'>
            <div>
                <span className='eyebrow'>ASK FASTLANE</span>
                <h2>What classes should I take?</h2>
                <p className='small muted'>
                    Describe your ideal week, degree needs, online classes, or planned ACC courses. Fastlane uses listed
                    UT sections and your imported IDA, not invented classes. After the first answer, tell it what to
                    change and it keeps the rest of your week.
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
            {focus && (
                <p className='focus-chip' role='status'>
                    Replacing <b>{focus.courseCode}</b> ({pad(focus.uniqueId)}). Say why, for example “too late in the
                    day” or “something easier”.{' '}
                    <button
                        type='button'
                        className='btn ghost sm'
                        aria-label='Stop replacing this class'
                        onClick={() => setFocusId(null)}
                    >
                        ×
                    </button>
                </p>
            )}
            <label className='field'>
                {proposal ? 'Ask for changes' : 'Tell Fastlane what you need'}
                <textarea
                    ref={textRef}
                    rows={3}
                    value={request}
                    onChange={e => setRequest(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
                    }}
                    placeholder={
                        focus
                            ? `Why replace ${focus.courseCode}?`
                            : proposal
                              ? 'e.g. "HIS 314K is too late in the day", "I’d rather have an online class", "I plan to take ECO 304L through ACC"'
                              : 'Find me 12–13 credits that count for my degree, no Monday/Wednesday/Friday classes, and 1–2 fully asynchronous online classes. I plan to take Macro through ACC.'
                    }
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
                        {busy ? 'Working…' : proposal ? 'Update plan' : 'Ask Fastlane'}
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
                {proposal && (
                    <ProposalPanel
                        version={proposal}
                        index={versionIndex}
                        count={versions.length}
                        onVersion={i => {
                            setVersionIndex(i);
                            setSaveNote('');
                        }}
                        grades={known.grades}
                        facts={known.facts}
                        picks={known.picks}
                        sectionsById={known.sections}
                        alternatives={alternatives}
                        onRemove={s =>
                            pushVersion(
                                proposal.sections.filter(x => x.uniqueId !== s.uniqueId),
                                `Removed ${s.courseCode}.`
                            )
                        }
                        onReplace={(from, to) =>
                            pushVersion(
                                proposal.sections.map(x => (x.uniqueId === from.uniqueId ? to : x)),
                                `Replaced ${from.courseCode} (${pad(from.uniqueId)}) with ${to.courseCode} (${pad(to.uniqueId)}).`
                            )
                        }
                        onAskReplace={s => {
                            setFocusId(s.uniqueId);
                            setError('');
                            textRef.current?.focus();
                            textRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }}
                        onSave={() => void saveProposal()}
                        saveNote={saveNote}
                        busy={busy}
                    />
                )}
                {recommendations.length > 0 && (
                    <h3 className='ai-results-head'>
                        {proposal && versions.length > 1 ? 'AI’s latest picks' : 'AI’s picks'}
                    </h3>
                )}
                {recommendations.map(rec => {
                    const c = known.sections.get(rec.id);
                    if (!c) return null;
                    const g = known.grades.get(c.uniqueId);
                    const planned = inPlan.has(c.uniqueId);
                    return (
                        <div key={rec.id} className='ai-result'>
                            <ClassCard
                                section={c}
                                grade={g}
                                className={planned ? 'in-plan' : ''}
                                badge={
                                    known.facts.get(c.uniqueId)?.prerequisite.status === 'unmet'
                                        ? 'Prerequisite needed'
                                        : undefined
                                }
                            >
                                <button
                                    type='button'
                                    className={`btn sm ${planned ? '' : 'primary'}`}
                                    aria-pressed={planned}
                                    onClick={() => togglePlan(c)}
                                >
                                    {planned ? 'In plan ✓' : 'Add to plan'}
                                </button>
                                <button
                                    type='button'
                                    className='btn ghost sm'
                                    disabled={!schedule || !c.course}
                                    onClick={() => void add(c)}
                                >
                                    {savedId === c.uniqueId ? 'Added to schedule' : 'Add to my schedule'}
                                </button>
                            </ClassCard>
                        </div>
                    );
                })}
                {!busy && history.length > 0 && recommendations.length === 0 && !request.trim() && !proposal && (
                    <p className='small muted'>No verified candidate IDs were returned. Try broader UT sections.</p>
                )}
                <p className='small muted'>
                    AI advice is not an official degree evaluation. “Matches your IDA” is checked against your imported
                    audit; anything AI says may count is a possible match to verify. Confirm prerequisites, requirements
                    and availability with UT.
                </p>
            </div>
        </section>
    );
}
