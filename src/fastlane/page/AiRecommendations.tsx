import type { Serialized } from '@chrome-extension-toolkit';
import { Course } from '@shared/types/Course';
import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gradeStatFrom, lookupGrades } from '../adapters/utrp';
import { outstandingTags } from '../audit/parseAudit';
import type { AccRoom, AccSuggestion, ProgramResidency } from '../core/acc';
import { accSuggestions, TCCN_SOURCE, tccnFor } from '../core/acc';
import type { AiCandidate, AiCandidateInput } from '../core/aiCandidates';
import { chooseAiCandidates } from '../core/aiCandidates';
import type { PlanningPreferences } from '../core/chatPreferences';
import { describePreferences, planningPreferences } from '../core/chatPreferences';
import type { GradeStat } from '../core/grades';
import { DAY_NAMES, detectConflicts } from '../core/meetings';
import { composeReply, quickReplies } from '../core/plannerReply';
import { subjectNameIndex } from '../core/prerequisites';
import type { ProposalVersion } from '../core/proposal';
import {
    diffSections,
    fitsWith,
    isTargetedChange,
    refineIntent,
    replacementFits,
    resolveTarget,
} from '../core/proposal';
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
import { isConfirmedSection, type SectionRecord, semesterKey, subjectOf, toSectionTimes } from '../core/sections';
import { subjectForCode, UT_SUBJECTS, utSubjectScheduleUrl } from '../data/subjects';
import { addOrSwap, createPlanningSchedule } from '../services/planningService';
import { FastlaneAiAccessStore, FastlaneAuditStore, FastlaneSettingsStore } from '../storage/stores';
import { ClassCard } from './ClassCard';
import type { PlannerOverrides } from './ConstraintsBar';
import ConstraintsBar from './ConstraintsBar';
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
    const prefs = useMemo(
        () => planningPreferences(conversation, subjectCodes, UT_SUBJECTS),
        [conversation, subjectCodes]
    );
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
    // real sections compared so far (with grades and IDA facts): what the solver chooses from
    const [pool, setPool] = useState<Map<number, PoolEntry>>(new Map());
    const [overrides, setOverrides] = useState<PlannerOverrides>({});
    const [noSchedule, setNoSchedule] = useState<NoScheduleReport | null>(null);
    const [accPlan, setAccPlan] = useState<{
        suggestions: AccSuggestion[];
        room: AccRoom;
        residency: ProgramResidency | null;
        blocked: string[];
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
    const constraintsFor = (p: PlanningPreferences, extraExcluded: string[] = []): ScheduleConstraints => {
        const requested = p.credits;
        const minCredits = Math.max(MIN_CREDITS, overrides.minCredits ?? requested?.min ?? MIN_CREDITS);
        const maxCredits = Math.max(
            minCredits,
            overrides.maxCredits ?? (requested ? Math.max(requested.max, MIN_CREDITS) : DEFAULT_MAX_CREDITS)
        );
        const excludedSubjects = overrides.excludedSubjects ?? p.excludedSubjects;
        const time = timeChoice !== 'any' ? timeChoice : p.timeOfDay;
        return {
            minCredits,
            maxCredits,
            creditsRequested: !!requested || overrides.minCredits != null || overrides.maxCredits != null,
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
        if (!consent || busy) return;
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
            if (intent.dropRequirement) {
                dropped = [...new Set([...droppedTags, ...(known.facts.get(target.uniqueId)?.applies ?? [])])];
                setDroppedTags(dropped);
            }
        }
        const c = constraintsFor(nowPrefs, extraExcluded);

        if (proposal && targeted && target && intent.removeOnly) {
            // removing needs no AI call, but the rest is still checked: below the minimum is flagged, not hidden
            const kept = proposal.sections.filter(s => s.uniqueId !== target.uniqueId);
            const check = validateSchedule(kept, c, factsById);
            const note = `Removed ${target.courseCode}.${check.credits < c.minCredits ? ` Now ${check.credits} credits, below ${c.minCredits}: use "Fill to ${c.minCredits}+ credits" to add a class.` : ''}`;
            pushVersion(kept, note);
            setHistory(previous =>
                [...previous, { id: Date.now(), request: message, context, summary: note }].slice(-6)
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
            // ACC ideas come first (from UT's official TCCN table), so the UT schedule doesn't duplicate them
            let acc: typeof accPlan = null;
            if (nowPrefs.accSuggest || nowPrefs.accPlanned) {
                setProgress('Checking UT’s official ACC transfer table…');
                const firstSection = new Map<string, SectionRecord>();
                for (const sec of catalog) {
                    const key = normalizeCourseCode(sec.courseCode);
                    if (sec.course && !firstSection.has(key)) firstSection.set(key, sec);
                }
                const needed = [
                    ...new Set(
                        outstandingTags(audit)
                            .map(t => t.match(/^COURSE (.+)$/i)?.[1])
                            .filter((x): x is string => !!x && tccnFor(x).length > 0)
                            .map(normalizeCourseCode)
                    ),
                ];
                const utGrades = new Map<string, { percent: number; sample: number }>();
                for (const code of needed) {
                    const sec = firstSection.get(code);
                    const stat = sec ? await gradeForSection(sec) : null;
                    if (stat) utGrades.set(code, { percent: stat.result.percent, sample: stat.result.graded });
                }
                acc = accSuggestions({ audit, planned: [], gradeOf: code => utGrades.get(code) ?? null });
                if (!nowPrefs.accSuggest) acc = { ...acc, suggestions: [] };
            }
            setAccPlan(acc);
            const rules = acc?.suggestions.length
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
            const usable = chosen.filter(x => {
                const grade = grades.get(x.section.uniqueId)?.result;
                if (minGrade > 0 && (!grade || grade.percent < minGrade)) return false;
                return x.prerequisite.status !== 'unmet';
            });
            setCompared({
                sections: eligible.length,
                subjects: new Set(usable.map(x => subjectOf(x.section.courseCode))).size,
            });
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
                        minGrade,
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
            setRecommendations(recs);

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
    const solveLocally = async (mode: 'rebuild' | 'fill') => {
        if (!pool.size || busy) return;
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
                    Chat with Fastlane about your week. It builds a real schedule from UT's listed classes and your IDA,
                    then keeps adjusting it as you reply.
                </p>
            </div>
            <div className='chat-history' role='log' aria-label='Planning conversation'>
                {history.map(turn => (
                    <div key={turn.id} className='chat-turn'>
                        <p className='chat-user'>{turn.request}</p>
                        <p className='chat-answer'>{turn.summary || 'Your schedule is shown below.'}</p>
                    </div>
                ))}
                {busy && progress && (
                    <p className='chat-answer typing' role='status'>
                        {progress}
                    </p>
                )}
            </div>
            {history.length > 0 && !busy && consent && (
                <fieldset className='quick-replies' aria-label='Quick replies'>
                    {quickReplies(!!proposal, prefs.accSuggest).map(text => (
                        <button key={text} type='button' className='quick-reply' onClick={() => void run(text)}>
                            {text}
                        </button>
                    ))}
                </fieldset>
            )}
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
            <details className='more-filters'>
                <summary className='small muted'>Time and grade filters</summary>
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
            </details>
            {understood.length > 0 && (
                <ul className='understood small' aria-label='What Fastlane understood'>
                    {understood.map(line => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            )}
            <div className='ai-advisor-body'>
                <p className='small muted compared-note'>
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
                {error && (
                    <p className='notice warn' role='alert'>
                        {error}
                    </p>
                )}
                {(proposal || noSchedule || pool.size > 0 || understood.length > 0) && (
                    <ConstraintsBar
                        constraints={constraints}
                        easyGrades={easyGrades}
                        coreFocus={coreFocus}
                        accPlanned={prefs.accPlanned}
                        edited={Object.keys(overrides).length > 0}
                        canRebuild={pool.size > 0}
                        busy={busy}
                        onChange={patch => setOverrides(o => ({ ...o, ...patch }))}
                        onRebuild={() => void solveLocally('rebuild')}
                        onReset={() => setOverrides({})}
                    />
                )}
                {noSchedule && (
                    <section className='glass-card no-schedule' role='alert' aria-label='No complete schedule found'>
                        <h3>No complete schedule found</h3>
                        <p className='small'>Fastlane will not show a schedule that breaks one of your rules.</p>
                        <ul className='small'>
                            {noSchedule.reasons.map(r => (
                                <li key={r}>{r}</li>
                            ))}
                        </ul>
                        <div className='row'>
                            {noSchedule.suggestions.map(sug => (
                                <button
                                    key={sug.text}
                                    type='button'
                                    className='btn sm'
                                    disabled={busy || !pool.size}
                                    onClick={() => {
                                        const patch = sug.patch;
                                        setOverrides(o => ({
                                            ...o,
                                            ...(patch.avoidDays ? { avoidDays: patch.avoidDays } : {}),
                                            ...(patch.maxCredits ? { maxCredits: patch.maxCredits } : {}),
                                            ...(patch.online !== undefined ? { online: patch.online } : {}),
                                            ...(patch.excludedSubjects
                                                ? { excludedSubjects: patch.excludedSubjects }
                                                : {}),
                                        }));
                                        setNoSchedule(null);
                                    }}
                                >
                                    {sug.text}
                                </button>
                            ))}
                        </div>
                        <p className='small muted'>
                            Pick a change, then “Rebuild schedule with these rules”, or tell Fastlane what to relax.
                        </p>
                    </section>
                )}
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
                {proposal && (
                    <>
                        <h3 className='ai-results-head'>Your schedule’s classes</h3>
                        {proposal.sections.map(c => {
                            const pick = known.picks.get(c.uniqueId);
                            const applies = factsById.get(c.uniqueId)?.applies ?? [];
                            return (
                                <div key={c.uniqueId} className='ai-result'>
                                    <ClassCard
                                        section={c}
                                        grade={known.grades.get(c.uniqueId)}
                                        className='in-plan'
                                        badge={
                                            applies.length
                                                ? `Matches your IDA: ${applies.slice(0, 2).join(', ')}`
                                                : 'Possible elective'
                                        }
                                    >
                                        <button type='button' className='btn ghost sm' onClick={() => togglePlan(c)}>
                                            Remove from plan
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
                                    <p className='small muted why'>
                                        {pick?.reason || 'Added by Fastlane to complete your week within your rules.'}
                                    </p>
                                </div>
                            );
                        })}
                    </>
                )}
                {accPlan && accPlan.suggestions.length > 0 && (
                    <section className='acc-suggestions' aria-label='Classes to take at ACC'>
                        <h3 className='ai-results-head'>Take at ACC to get ahead</h3>
                        {accPlan.suggestions.map(x => (
                            <article key={x.ut} className='class-card online async'>
                                <div className='class-card-main'>
                                    <div className='class-card-text'>
                                        <h4 className='class-title'>{x.tccn} at ACC</h4>
                                        <p className='class-code'>
                                            Transfers to UT as {x.ut} <span>· {x.hours} credits</span>
                                        </p>
                                        <p className='class-time'>Counts toward: {x.requirement}</p>
                                        {x.cautions.map(cn => (
                                            <span key={cn} className='class-badge'>
                                                {cn}
                                            </span>
                                        ))}
                                    </div>
                                    <div
                                        className='class-grade'
                                        title='UT’s historical A/A− rate for the UT equivalent'
                                    >
                                        {x.utARate != null ? (
                                            <>
                                                <b>{Math.round(x.utARate)}%</b>
                                                <span>A/A− at UT</span>
                                            </>
                                        ) : (
                                            <span>No UT grade data</span>
                                        )}
                                    </div>
                                </div>
                            </article>
                        ))}
                        <p className='small muted'>
                            From{' '}
                            <a href={TCCN_SOURCE} target='_blank' rel='noopener noreferrer'>
                                UT’s official Texas Common Course Numbering table
                            </a>
                            . Check ACC’s schedule for online sections. Credit counts only after UT evaluates your ACC
                            transcript.
                            {accPlan.room.room != null &&
                                ` Your IDA leaves room for up to ${accPlan.room.room} hours from outside UT.`}
                            {accPlan.residency && ` ${accPlan.residency.label}: ${accPlan.residency.note}`}
                        </p>
                    </section>
                )}
                {recommendations.some(r => !inPlan.has(r.id)) && (
                    <details className='other-options'>
                        <summary className='small'>
                            Other options AI suggested ({recommendations.filter(r => !inPlan.has(r.id)).length})
                        </summary>
                        {recommendations
                            .filter(r => !inPlan.has(r.id))
                            .map(rec => {
                                const c = known.sections.get(rec.id);
                                if (!c) return null;
                                return (
                                    <div key={rec.id} className='ai-result'>
                                        <ClassCard section={c} grade={known.grades.get(c.uniqueId)}>
                                            <button
                                                type='button'
                                                className='btn sm primary'
                                                onClick={() => togglePlan(c)}
                                            >
                                                Add to plan
                                            </button>
                                        </ClassCard>
                                        {rec.reason && <p className='small muted why'>{rec.reason}</p>}
                                    </div>
                                );
                            })}
                    </details>
                )}
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
