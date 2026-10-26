import type { Serialized } from '@chrome-extension-toolkit';
import { Course } from '@shared/types/Course';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gradeStatFrom, lookupGrades } from '../adapters/utrp';
import { outstandingTags } from '../audit/parseAudit';
import type { AccRoom, AccSuggestion, ProgramResidency } from '../core/acc';
import { accCandidateUtCodes, accSuggestions, TCCN_SOURCE } from '../core/acc';
import type { AiCandidate, AiCandidateInput } from '../core/aiCandidates';
import { chooseAiCandidates } from '../core/aiCandidates';
import type { PlanningPreferences } from '../core/chatPreferences';
import { planningPreferences } from '../core/chatPreferences';
import type { GradeStat } from '../core/grades';
import type { DayCode } from '../core/meetings';
import { composeReply, quickReplies } from '../core/plannerReply';
import { subjectNameIndex } from '../core/prerequisites';
import type { ProposalVersion } from '../core/proposal';
import { diffSections, isTargetedChange, refineIntent, replacementFits, resolveTarget } from '../core/proposal';
import { normalizeCourseCode } from '../core/requirements';
import type { NoScheduleReport, ScheduleConstraints, SolveResult, SolverCandidate } from '../core/scheduleSolver';
import {
    DEFAULT_MAX_CREDITS,
    hardFilterCounts,
    hardReason,
    isAsync,
    MIN_CREDITS,
    scoreSection,
    solveSchedule,
    validateSchedule,
} from '../core/scheduleSolver';
import { isConfirmedSection, type SectionRecord, semesterKey, subjectOf } from '../core/sections';
import { subjectForCode, UT_SUBJECTS } from '../data/subjects';
import { createPlanningSchedule } from '../services/planningService';
import { FastlaneAiAccessStore, FastlaneAuditStore, FastlaneSettingsStore } from '../storage/stores';
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

/** Rule changes picked from the "no complete schedule" options. */
interface PlannerOverrides {
    minCredits?: number;
    maxCredits?: number;
    avoidDays?: DayCode[];
    excludedSubjects?: string[];
    online?: { min: number; max: number } | null;
    backToBack?: boolean;
    easyGrades?: boolean;
    coreFocus?: boolean;
}

interface PoolEntry {
    section: SectionRecord;
    applies: string[];
    prerequisite: SolverCandidate['prerequisite'];
    gradePercent: number | null;
    gradeSample: number;
    aiPicked: boolean;
    /** AI said it may count toward a Core requirement (not verified) */
    possibleCore: boolean;
}

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
    const inventory = useInventory();
    const catalog = inventory.sections;
    const loadingCatalog = !inventory.loaded;
    const [request, setRequest] = useState('');
    const [history, setHistory] = useState<ChatTurn[]>([]);
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
    const prefs = useMemo(
        () => planningPreferences(conversation, subjectCodes, UT_SUBJECTS),
        [conversation, subjectCodes]
    );
    const avoidDays = prefs.avoidDays;
    const timeOfDay = prefs.timeOfDay;
    const leftOut = useMemo(
        () => new Set([...prefs.excludedCourses, ...prefs.plannedElsewhere.map(p => p.code)].map(normalizeCourseCode)),
        [prefs]
    );
    const [consent, setConsent] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const savedCode = FastlaneAiAccessStore.useStore(s => s.accessCode);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // everything AI has been shown in this conversation, so earlier picks keep their facts and grades
    const [known, setKnown] = useState<{
        sections: Map<number, SectionRecord>;
        facts: Map<number, AiCandidate>;
        grades: Map<number, GradeStat | null>;
        picks: Map<number, AiPick>;
    }>({ sections: new Map(), facts: new Map(), grades: new Map(), picks: new Map() });
    // real sections compared so far (with grades and IDA facts): what the solver chooses from
    const [pool, setPool] = useState<Map<number, PoolEntry>>(new Map());
    // rule changes from the "no complete schedule" options, applied on top of the conversation
    const [overrides, setOverrides] = useState<PlannerOverrides>({});
    const currentOverrides = overrides;
    const [noSchedule, setNoSchedule] = useState<NoScheduleReport | null>(null);
    const [accPlan, setAccPlan] = useState<{
        suggestions: AccSuggestion[];
        room: AccRoom;
        residency: ProgramResidency | null;
        blocked: string[];
        notes: string[];
    } | null>(null);

    const taken = useMemo(
        () =>
            new Set([
                // only what the IDA says is done or in progress; a mock schedule is a plan, not credit
                ...(audit?.courses
                    .filter(c => c.status === 'completed' || c.status === 'in-progress')
                    .map(c => normalizeCourseCode(c.code)) ?? []),
            ]),
        [audit]
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

    /** The rules every schedule must follow: the conversation's preferences, then any edits in the summary. */
    const constraintsFor = (
        p: PlanningPreferences,
        extraExcluded: string[] = [],
        overrides: PlannerOverrides = currentOverrides
    ): ScheduleConstraints => {
        const requested = p.credits;
        const minCredits = Math.max(MIN_CREDITS, overrides.minCredits ?? requested?.min ?? MIN_CREDITS);
        const maxCredits = Math.max(
            minCredits,
            overrides.maxCredits ?? (requested ? Math.max(requested.max, MIN_CREDITS) : DEFAULT_MAX_CREDITS)
        );
        const excludedSubjects = overrides.excludedSubjects ?? p.excludedSubjects;
        const time = p.timeOfDay;
        return {
            minCredits,
            maxCredits,
            // a floor ("at least 12") keeps the usual 15-credit sweet spot; an exact range is followed as given
            creditsRequested:
                (!!requested && !requested.floor) || overrides.minCredits != null || overrides.maxCredits != null,
            avoidDays: overrides.avoidDays ?? [
                ...new Set([...p.avoidDays, ...(settings.avoidFriday ? (['F'] as const) : [])]),
            ],
            excludedSubjects,
            // title words follow their subjects ("history" goes away when HIS is allowed again)
            excludedTitleWords: p.excludedTitleWords.filter(w =>
                excludedSubjects.some(code => new RegExp(`\\b${w}\\b`, 'i').test(subjectForCode(code)?.name ?? ''))
            ),
            excludedCourses: [
                ...new Set(
                    [...p.excludedCourses, ...p.plannedElsewhere.map(x => x.code), ...extraExcluded].map(
                        normalizeCourseCode
                    )
                ),
            ],
            term: actualTerm,
            online: overrides.online !== undefined ? overrides.online : p.asyncCount,
            backToBack: overrides.backToBack ?? p.backToBack,
            timeWindow:
                time === 'morning'
                    ? { from: 0, to: 12 * 60 }
                    : time === 'afternoon'
                      ? { from: 12 * 60, to: 17 * 60 }
                      : time === 'evening'
                        ? { from: 17 * 60, to: 24 * 60 }
                        : null,
        };
    };
    const constraints = constraintsFor(prefs);
    const easyGrades = overrides.easyGrades ?? prefs.easyGrades;
    const coreFocus = overrides.coreFocus ?? prefs.coreFocus;
    const factsById = useMemo(
        () =>
            new Map(
                [...pool.values()].map(p => [p.section.uniqueId, { applies: p.applies, prerequisite: p.prerequisite }])
            ),
        [pool]
    );
    const solverCandidates = (entries: Iterable<PoolEntry>, flags = { easyGrades, coreFocus }): SolverCandidate[] =>
        [...entries].map(p => ({
            section: p.section,
            applies: p.applies,
            prerequisite: p.prerequisite,
            score: scoreSection({
                applies: p.applies,
                coreFocus: flags.coreFocus,
                gradePercent: p.gradePercent,
                gradeSample: p.gradeSample,
                easyGrades: flags.easyGrades,
                aiPicked: p.aiPicked,
                possibleCore: p.possibleCore,
                creditHours: p.section.creditHours,
                courseCode: p.section.courseCode,
                prerequisite: p.prerequisite,
            }),
        }));
    const validation = proposal ? validateSchedule(proposal.sections, constraints, factsById) : null;

    /** Puts a solver result on screen (a new version when valid, otherwise the "no complete schedule" report)
     *  and returns the chat reply, which always describes the schedule that is shown. */
    const showResult = (
        result: SolveResult,
        before: SectionRecord[] | null,
        why: string,
        rules: ScheduleConstraints = constraints,
        acc: typeof accPlan = accPlan,
        accAsked = false
    ): string => {
        const reply = composeReply({
            sections: result.best?.sections ?? null,
            before,
            report: result.report,
            avoidDays: rules.avoidDays,
            acc,
            accAsked,
        });
        if (!result.best) {
            setNoSchedule(result.report);
            return reply;
        }
        setNoSchedule(null);
        const check = validateSchedule(result.best.sections, rules, factsById);
        pushVersion(
            result.best.sections,
            `${why} ${result.best.credits} credits, ${result.best.asyncCount} async online, ${Math.round(result.best.gapMinutes)} min of gaps. Checked against every rule${check.ok ? '' : ' (see warnings)'}.`
        );
        return reply;
    };

    /** Runs only on submit: filters, ranks and grades candidates without blocking the page, then asks AI. */
    const run = async (override?: string) => {
        if (busy) return;
        if (!consent) {
            setError('Check “I agree to send…” below first; Fastlane only contacts its AI after you agree.');
            return;
        }
        const message = (override ?? request).trim();
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
        const prefsBefore = planningPreferences(
            history.map(h => h.context),
            subjectCodes,
            UT_SUBJECTS
        );
        const nowPrefs = planningPreferences([...history.map(h => h.context), message], subjectCodes, UT_SUBJECTS);
        let context = message;
        let dropped = droppedTags;
        const extraExcluded: string[] = [];
        if (proposal && targeted && target) {
            context = `${message} (about ${target.courseCode}, unique ${pad(target.uniqueId)})`;
            if (intent.elsewhere) {
                extraExcluded.push(target.courseCode);
                context = `${message} I plan to take ${target.courseCode} through ACC.`;
            }
            if (intent.removeOnly) {
                // "remove X": X stays out of later versions too, and its slot is refilled within the rules
                extraExcluded.push(target.courseCode);
                context = `${message} Not ${target.courseCode}.`;
            }
            if (intent.dropRequirement) {
                dropped = [...new Set([...droppedTags, ...(known.facts.get(target.uniqueId)?.applies ?? [])])];
                setDroppedTags(dropped);
            }
        }
        const c = constraintsFor(nowPrefs, extraExcluded);

        // "remove X" / "remove history": done here at once from the classes already compared (no AI call)
        const removesClass = proposal && target && targeted && intent.removeOnly;
        const removesSubject =
            proposal &&
            !target &&
            /\b(?:remove|drop|delete|take out|get rid of|no more|don'?t want)\b/i.test(message) &&
            proposal.sections.some(s => hardReason(s, c));
        if (proposal && pool.size > 0 && (removesClass || removesSubject)) {
            const kept = proposal.sections.filter(s => !hardReason(s, c));
            const gone = proposal.sections.filter(s => !kept.includes(s)).map(s => s.courseCode);
            const controller = new AbortController();
            abortRef.current = controller;
            setBusy(true);
            setError('');
            setProgress(`Removing ${gone.join(', ')}…`);
            try {
                const result = await solveSchedule(
                    solverCandidates([...pool.values()].filter(p => !hardReason(p.section, c))),
                    c,
                    {
                        stable: new Set(kept.map(s => s.uniqueId)),
                        signal: controller.signal,
                        removedBy: hardFilterCounts(catalog, c),
                    }
                );
                let summary: string;
                if (result.best) {
                    summary = showResult(result, proposal.sections, `Removed ${gone.join(', ')}.`, c);
                } else {
                    setNoSchedule(null);
                    pushVersion(kept, `Removed ${gone.join(', ')}.`);
                    const credits = kept.reduce((n, s) => n + s.creditHours, 0);
                    summary = `${composeReply({ sections: kept, before: proposal.sections, report: null, avoidDays: c.avoidDays })}\nThat leaves ${credits} credits. Tap “Fill to ${c.minCredits}+ credits” or tell me what to add.`;
                }
                setHistory(previous => [...previous, { id: Date.now(), request: message, context, summary }].slice(-6));
                setRequest('');
                setFocusId(null);
            } catch (failure) {
                if (!controller.signal.aborted)
                    setError(failure instanceof Error ? failure.message : 'Could not update the schedule.');
            } finally {
                if (abortRef.current === controller) abortRef.current = null;
                setBusy(false);
                setProgress('');
            }
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setError('');
        setProgress('Reading your request…');
        try {
            // ACC ideas come first (from UT's official TCCN table), so the UT schedule doesn't duplicate them
            let acc: typeof accPlan = null;
            if (audit) {
                setProgress('Checking UT’s official ACC transfer table…');
                const firstSection = new Map<string, SectionRecord>();
                for (const sec of catalog) {
                    const key = normalizeCourseCode(sec.courseCode);
                    if (sec.course && !firstSection.has(key)) firstSection.set(key, sec);
                }
                const utGrades = new Map<string, { percent: number; sample: number }>();
                for (const code of accCandidateUtCodes(audit)) {
                    const sec = firstSection.get(code);
                    const stat = sec ? await gradeForSection(sec) : null;
                    if (stat) utGrades.set(code, { percent: stat.result.percent, sample: stat.result.graded });
                }
                acc = accSuggestions({ audit, planned: [], gradeOf: code => utGrades.get(code) ?? null });
            }
            // only when asked ("take those at ACC") do ACC courses leave the UT schedule
            const rules =
                nowPrefs.accSuggest && acc?.suggestions.length
                    ? constraintsFor(nowPrefs, [...extraExcluded, ...acc.suggestions.map(x => x.ut)])
                    : c;
            // hard rules are applied to the whole catalog before anything is ranked
            const removedBy = hardFilterCounts(catalog, rules);
            // replacing one class: the other proposed courses stay as they are (they're already in the pool)
            const keptCodes = new Set(
                proposal && targeted && target
                    ? proposal.sections
                          .filter(x => x.uniqueId !== target.uniqueId)
                          .map(x => normalizeCourseCode(x.courseCode))
                    : []
            );
            const eligible = catalog.filter(
                section =>
                    !hardReason(section, rules) &&
                    !(rules.online?.max === 0 && isAsync(section)) &&
                    !keptCodes.has(normalizeCourseCode(section.courseCode))
            );
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
                // a proposal is its own semester plan: the current mock schedule neither blocks nor ranks it
                active: [],
                avoidFriday: false,
                preferAsync: (rules.online?.min ?? 0) > 0 || settings.preferAsync || (targeted && intent.online),
                subjectIndex,
            };
            const options = {
                signal: controller.signal,
                onProgress: setProgress,
                limit: 90,
                // enough online options to choose from, without crowding out classes on the allowed days
                asyncShare: Math.max(6, (rules.online?.max ?? 2) * 5),
            };
            let picked = await chooseAiCandidates(input, gradeForSection, options);
            if (targetTags.length && !picked.chosen.some(x => x.applies.length))
                picked = await chooseAiCandidates({ ...input, outstanding: allOutstanding }, gradeForSection, options);
            const { chosen, grades } = picked;
            const usable = chosen.filter(x => x.prerequisite.status !== 'unmet');
            if (!usable.length) {
                setError(
                    "No listed UT sections fit these rules. Widen the days, credits or grade preference, or import UT's course list for the semester. AI never suggests classes that are not listed."
                );
                return;
            }
            const forAi = usable.slice(0, 38);
            setProgress(`Asking Fastlane AI about ${forAi.length} real UT sections…`);
            const facts = new Map(usable.map(x => [x.section.uniqueId, x]));
            const planningRequest =
                proposal && targeted && target
                    ? `${message}\n\nCurrent proposed schedule: ${proposal.sections.map(s => `${s.courseCode} (${pad(s.uniqueId)})`).join(', ')}. Replace only ${target.courseCode} (${pad(target.uniqueId)}); keep the other classes.`
                    : proposal
                      ? `${message}\n\nCurrent proposed schedule: ${proposal.sections.map(s => `${s.courseCode} (${pad(s.uniqueId)})`).join(', ')}. Keep classes that still fit.`
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
                    candidates: forAi.map(({ section: s }) => ({
                        ...aiFacts(facts.get(s.uniqueId)),
                        id: s.uniqueId,
                        code: s.courseCode,
                        title: s.title,
                        semester: semesterKey(s.semester),
                        hours: s.creditHours,
                        professor: s.instructors.join(', ').slice(0, 80),
                        days: [...new Set(s.meetings.flatMap(m => m.days))],
                        mode: s.modality,
                        tags: s.requirementTags,
                        gradePercent: grades.get(s.uniqueId)?.result.percent ?? null,
                        gradeSample: grades.get(s.uniqueId)?.result.graded ?? null,
                    })),
                    planningRequest,
                    chatHistory: history.slice(-4).map(h => ({ request: h.context, summary: h.summary })),
                    preferences: {
                        semester: actualTerm,
                        avoidFriday: settings.avoidFriday,
                        preferAsync: settings.preferAsync,
                        minGrade: 0,
                        timeOfDay,
                        avoidDays: rules.avoidDays,
                        asyncCount: rules.online,
                        easyGrades: easyGrades || (targeted && intent.easier),
                        plannedElsewhere: nowPrefs.plannedElsewhere,
                        excludedCourses: rules.excludedCourses,
                        credits: { min: rules.minCredits, max: rules.maxCredits },
                        excludedSubjects: rules.excludedSubjects,
                        backToBack: rules.backToBack,
                        coreFocus,
                        accPlanned: nowPrefs.accPlanned,
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
            const sections = new Map(usable.map(x => [x.section.uniqueId, x.section]));
            const recs = (payload.recommendations ?? []).filter(r => sections.has(r.id));
            const picks = new Set(recs.map(r => r.id));
            setKnown({
                sections: new Map([...known.sections, ...sections]),
                facts: new Map([...known.facts, ...facts]),
                grades: new Map([...known.grades, ...grades]),
                picks: new Map([
                    ...known.picks,
                    ...recs.map(
                        r => [r.id, { reason: r.reason, requirement: r.requirement, warning: r.warning }] as const
                    ),
                ]),
            });

            // every real section compared so far, so the solver can consider alternatives, not just AI's picks
            const nextPool = new Map(pool);
            for (const x of usable) {
                const g = grades.get(x.section.uniqueId)?.result;
                nextPool.set(x.section.uniqueId, {
                    section: x.section,
                    applies: x.applies,
                    prerequisite: x.prerequisite.status,
                    gradePercent: g?.percent ?? null,
                    gradeSample: g?.graded ?? 0,
                    aiPicked: picks.has(x.section.uniqueId),
                    possibleCore: recs.some(r => r.id === x.section.uniqueId && /\bcore\b/i.test(r.requirement)),
                });
            }
            setPool(nextPool);
            const gradeOf = (s: SectionRecord) => nextPool.get(s.uniqueId)?.gradePercent ?? null;
            const flags = { easyGrades: easyGrades || (targeted && intent.easier), coreFocus };
            setProgress('Building a schedule that follows every rule…');
            let result: SolveResult;
            let why: string;
            if (proposal && targeted && target) {
                const stable = new Set(
                    proposal.sections.filter(s => s.uniqueId !== target.uniqueId).map(s => s.uniqueId)
                );
                result = await solveSchedule(
                    solverCandidates(
                        [...nextPool.values()].filter(p => p.section.uniqueId !== target.uniqueId),
                        flags
                    ),
                    rules,
                    {
                        stable,
                        allowNew: s => replacementFits(s, target, intent, gradeOf),
                        signal: controller.signal,
                        removedBy,
                    }
                );
                why = `Replacing ${target.courseCode}.`;
            } else if (proposal) {
                result = await solveSchedule(solverCandidates(nextPool.values(), flags), rules, {
                    stable: new Set(proposal.sections.map(s => s.uniqueId)),
                    // "make it easier" should be free to swap classes for higher A rates
                    stableWeight: intent.easier || nowPrefs.easyGrades !== prefsBefore.easyGrades ? 1 : 4,
                    signal: controller.signal,
                    removedBy,
                });
                why = 'Updated for your message, keeping classes that still fit.';
            } else {
                result = await solveSchedule(solverCandidates(nextPool.values(), flags), rules, {
                    signal: controller.signal,
                    removedBy,
                });
                why = `Built from ${nextPool.size} real UT sections that follow your rules.`;
            }
            if (acc && !nowPrefs.accSuggest && result.best) {
                // not asked: don't suggest ACC for something the UT schedule already covers
                const inPlan = new Set(result.best.sections.map(x => normalizeCourseCode(x.courseCode)));
                const covered = new Set(
                    result.best.sections.flatMap(x => nextPool.get(x.uniqueId)?.applies ?? []).map(t => t.toUpperCase())
                );
                acc = {
                    ...acc,
                    suggestions: acc.suggestions.filter(
                        x =>
                            !inPlan.has(x.ut) &&
                            !covered.has(
                                x.requirement.match(/^Core (\d{3})/)?.[1] ? `CORE ${x.requirement.slice(5, 8)}` : ''
                            )
                    ),
                };
            }
            setAccPlan(acc);
            const summary = showResult(result, proposal?.sections ?? null, why, rules, acc, nowPrefs.accSuggest);
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

    /** Local re-plan from sections already compared (no AI call): after editing the rules, or to fill up. */
    const solveLocally = async (mode: 'rebuild' | 'fill', withOverrides: PlannerOverrides = overrides) => {
        if (!pool.size || busy) return;
        const constraints = constraintsFor(prefs, [], withOverrides);
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        setError('');
        setProgress(mode === 'fill' ? 'Finding a class to reach your minimum…' : 'Rebuilding with your rules…');
        try {
            const current = proposal?.sections ?? [];
            const result = await solveSchedule(solverCandidates(pool.values()), constraints, {
                ...(mode === 'fill' ? { fixed: current } : { stable: new Set(current.map(s => s.uniqueId)) }),
                signal: controller.signal,
                removedBy: hardFilterCounts(catalog, constraints),
            });
            showResult(
                result,
                proposal?.sections ?? null,
                mode === 'fill' ? 'Added classes to reach your credit minimum.' : 'Rebuilt with your edited rules.'
            );
        } catch (failure) {
            if (!controller.signal.aborted)
                setError(failure instanceof Error ? failure.message : 'Could not rebuild the schedule.');
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setBusy(false);
            setProgress('');
        }
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
    const newChat = () => {
        abortRef.current?.abort();
        setHistory([]);
        setVersions([]);
        setVersionIndex(0);
        setPool(new Map());
        setOverrides({});
        setNoSchedule(null);
        setAccPlan(null);
        setFocusId(null);
        setDroppedTags([]);
        setError('');
        setSaveNote('');
        setRequest('');
        textRef.current?.focus();
    };

    // keep the newest message in view, like any chat
    const logRef = useRef<HTMLDivElement>(null);
    const scrollKey = `${history.length}|${busy}|${error}|${versionIndex}|${noSchedule ? 1 : 0}`;
    useEffect(() => {
        const log = logRef.current;
        if (log && scrollKey) log.scrollTop = log.scrollHeight;
    }, [scrollKey]);

    const notice = !audit
        ? 'First import your IDA in Degree progress, so I know which requirements you still need.'
        : !loadingCatalog && !catalog.length
          ? "No UT classes are loaded yet. Import UT's course list on this page so I can plan from every subject."
          : !loadingCatalog && !subjectHasSections
            ? `No ${subjectForCode(subject)?.name ?? subject} sections are listed for ${actualTerm || 'this semester'}.`
            : '';
    const needsSetup = !savedCode || !consent;
    const canSend =
        consent && !!audit && catalog.length > 0 && !!request.trim() && (!!savedCode || !!inviteCode.trim());
    const chips: Array<{ text: string; onClick: () => void }> = busy
        ? []
        : noSchedule
          ? noSchedule.suggestions.map(sug => ({
                text: sug.text,
                onClick: () => {
                    const patch = sug.patch;
                    const next: PlannerOverrides = {
                        ...overrides,
                        ...(patch.avoidDays ? { avoidDays: patch.avoidDays } : {}),
                        ...(patch.maxCredits ? { maxCredits: patch.maxCredits } : {}),
                        ...(patch.online !== undefined ? { online: patch.online } : {}),
                        ...(patch.excludedSubjects ? { excludedSubjects: patch.excludedSubjects } : {}),
                    };
                    setOverrides(next);
                    void solveLocally('rebuild', next);
                },
            }))
          : history.length > 0 && consent
            ? quickReplies(!!proposal, prefs.accSuggest).map(text => ({ text, onClick: () => void run(text) }))
            : [];

    return (
        <section className='fl-chat' aria-label='Fastlane schedule chat'>
            <header className='fl-chat-head'>
                <span className='fl-chat-avatar' aria-hidden='true'>
                    F
                </span>
                <div className='fl-chat-title'>
                    <h2>Fastlane</h2>
                    <span>Builds your semester from UT’s real classes and your IDA</span>
                </div>
                {(history.length > 0 || proposal) && (
                    <button type='button' className='fl-chat-new' onClick={newChat}>
                        New chat
                    </button>
                )}
            </header>

            <div className='fl-chat-log' role='log' aria-label='Planning conversation' ref={logRef}>
                <p className='bubble bot'>
                    Hi! Tell me what you want this semester: credits, which days, easy or challenging, online classes,
                    or anything you’ll take at ACC. I’ll build a real schedule, and you can keep chatting to change it,
                    like “remove history” or “no Fridays”.
                </p>
                {notice && <p className='bubble bot warn'>{notice}</p>}
                {history.map((turn, i) => (
                    <div key={turn.id} className='fl-turn'>
                        <p className='bubble me'>{turn.request}</p>
                        <p className='bubble bot'>
                            {turn.summary || 'Your schedule is below.'}
                            {i === history.length - 1 && accPlan && accPlan.suggestions.length > 0 && (
                                <a className='bubble-link' href={TCCN_SOURCE} target='_blank' rel='noopener noreferrer'>
                                    UT’s official ACC transfer table ↗
                                </a>
                            )}
                        </p>
                    </div>
                ))}
                {proposal && (
                    <ProposalPanel
                        validation={validation}
                        minCredits={constraints.minCredits}
                        onFill={() => void solveLocally('fill')}
                        canFill={pool.size > 0}
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
                        onRemove={s =>
                            pushVersion(
                                proposal.sections.filter(x => x.uniqueId !== s.uniqueId),
                                `Removed ${s.courseCode}.`
                            )
                        }
                        onAskReplace={s => {
                            setFocusId(s.uniqueId);
                            setError('');
                            textRef.current?.focus();
                        }}
                        onSave={() => void saveProposal()}
                        saveNote={saveNote}
                        busy={busy}
                    />
                )}
                {busy && (
                    <p className='bubble bot typing' role='status'>
                        <span className='dots' aria-hidden='true'>
                            <i />
                            <i />
                            <i />
                        </span>
                        {progress || 'Thinking…'}
                    </p>
                )}
                {loadingCatalog && !busy && <p className='bubble bot typing'>Loading UT classes…</p>}
                {error && (
                    <p className='bubble bot error' role='alert'>
                        {error}
                    </p>
                )}
            </div>

            {chips.length > 0 && (
                <fieldset className='quick-replies' aria-label='Quick replies'>
                    {chips.map(chip => (
                        <button
                            key={chip.text}
                            type='button'
                            className='quick-reply'
                            disabled={!pool.size && !!noSchedule}
                            onClick={chip.onClick}
                        >
                            {chip.text}
                        </button>
                    ))}
                </fieldset>
            )}

            {needsSetup && (
                <div className='fl-setup'>
                    {!savedCode && (
                        <input
                            type='password'
                            autoComplete='off'
                            value={inviteCode}
                            onChange={e => setInviteCode(e.target.value)}
                            placeholder='Enter once to enable AI'
                            aria-label='Beta invite code (not your Groq API key)'
                        />
                    )}
                    <label className='check'>
                        <input type='checkbox' checked={consent} onChange={e => setConsent(e.target.checked)} />
                        <span className='small'>
                            I agree to send my unfinished requirement descriptions, completed course codes, preferences,
                            my typed request and public course details to Fastlane's server and Groq. No name, EID or
                            full IDA file is sent.
                        </span>
                    </label>
                </div>
            )}

            {focus && (
                <p className='focus-chip' role='status'>
                    Replacing <b>{focus.courseCode}</b>. Say why, like “too late” or “something easier”.
                    <button
                        type='button'
                        className='focus-chip-x'
                        aria-label='Stop replacing this class'
                        onClick={() => setFocusId(null)}
                    >
                        ×
                    </button>
                </p>
            )}

            <div className='fl-composer'>
                <textarea
                    ref={textRef}
                    rows={1}
                    value={request}
                    onChange={e => setRequest(e.target.value)}
                    onKeyDown={e => {
                        // Enter sends, Shift+Enter adds a line (like any chat)
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (canSend) void run();
                        }
                    }}
                    placeholder={
                        focus
                            ? `Why replace ${focus.courseCode}?`
                            : proposal
                              ? 'Reply… e.g. “remove history”, “no Fridays”, “make it easier”'
                              : 'Message Fastlane… e.g. “15 easy credits, Tue/Thu only”'
                    }
                    aria-label='Ask Fastlane for class recommendations'
                />
                {busy ? (
                    <button
                        type='button'
                        className='fl-send stop'
                        aria-label='Cancel'
                        onClick={() => abortRef.current?.abort()}
                    >
                        ■
                    </button>
                ) : (
                    <button
                        type='button'
                        className='fl-send'
                        aria-label='Send message'
                        disabled={!canSend}
                        title={!consent ? 'Check the agreement above first' : undefined}
                        onClick={() => void run()}
                    >
                        ↑
                    </button>
                )}
            </div>
            <p className='fl-foot'>
                AI can be wrong. Confirm requirements and prerequisites with UT.
                {savedCode && (
                    <button
                        type='button'
                        className='fl-link'
                        onClick={() => {
                            setInviteCode('');
                            void FastlaneAiAccessStore.set('accessCode', '');
                        }}
                    >
                        Forget AI code
                    </button>
                )}
            </p>
        </section>
    );
}
