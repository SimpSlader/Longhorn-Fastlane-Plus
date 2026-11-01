/**
 * The planner's source of truth: structured rules, not chat text.
 *
 * What the student says is turned into explicit rules by deterministic code (`statedRules`), whatever the model
 * does or fails to do with the request. Rules come in two scopes:
 *  - persistent ("remember I only want core classes"): saved per user, applied to every future request;
 *  - session (everything else): apply to the schedule being built, change one field at a time on a follow-up
 *    ("allow Wednesdays" touches only the days), and can be undone.
 * Every state change bumps `seq`; a late answer that was started under an older `seq` is dropped, so a slow
 * response can never overwrite a newer instruction.
 */
import { applyPlanningMessage, type DayLimits, EMPTY_PREFERENCES, type PlanningPreferences } from './chatPreferences';
import type { DayCode } from './meetings';
import type { ScheduleConstraints } from './scheduleSolver';
import { DEFAULT_MAX_CREDITS, MIN_CREDITS } from './scheduleSolver';

export interface PlannerRules {
    prefs: PlanningPreferences;
    coreOnly: boolean;
    /** "a UGS", "one signature course" → { UGS: 1 } */
    subjectCounts: Record<string, number>;
    /** most asynchronous online classes allowed ("okay with 1–2 online") */
    maxOnline: number | null;
    /** sections ruled out for "give me another option" */
    excludedSections: number[];
}

export const EMPTY_RULES: PlannerRules = {
    prefs: EMPTY_PREFERENCES,
    coreOnly: false,
    subjectCounts: {},
    maxOnline: null,
    excludedSections: [],
};

const CORE_ONLY =
    /\bcore[- ]complete only\b|\b(?:only|just) (?:want |need |take |include )?(?:core|classes that count (?:toward|towards) (?:my )?core)\b|\bcore (?:classes|courses|requirements?) only\b|\b(?:count|counts|counting|fulfill|fulfil|satisfy) (?:toward|towards|for|my)?\s*(?:my |the )?core\b|\bevery (?:class|course) (?:must )?(?:counts?|fulfills?)\b[^.]*\bcore\b/i;
const ALLOW_ELECTIVES =
    /\b(?:allow|include|add|fine with|okay with|ok with) (?:some )?(?:electives|non-?core)\b|\bdoes(?:n'?t| not) (?:need to|have to) (?:be|count (?:toward|towards) )core\b|\bnot (?:just|only) core\b/i;

/** Applies one chat message to a rule set. Fields the message does not mention are left untouched. */
export function applyMessage(
    rules: PlannerRules,
    message: string,
    subjects: Set<string>,
    names: Array<{ code: string; name: string }> = []
): PlannerRules {
    const text = message.toLowerCase();
    const prefs = applyPlanningMessage(rules.prefs, message, subjects, names);
    let coreOnly = rules.coreOnly;
    if (ALLOW_ELECTIVES.test(text)) coreOnly = false;
    else if (CORE_ONLY.test(text)) coreOnly = true;
    const subjectCounts = { ...rules.subjectCounts };
    const ugs = text.match(/\b(?:(two|2|both)\s+ugs|(?:a|an|one|1)\s+(?:ugs|signature)|ugs\b|signature course)/);
    if (ugs && /\bugs\b|signature course/.test(text)) subjectCounts.UGS = /\b(?:two|2|both)\s+ugs/.test(text) ? 2 : 1;
    if (/\b(?:no|without|skip) (?:a |any )?(?:ugs|signature)\b/.test(text)) delete subjectCounts.UGS;
    let maxOnline = rules.maxOnline;
    const online = text.match(
        /\b(?:up to|at most|no more than|max(?:imum)?(?: of)?)\s*(\d)\s*(?:asynchronous |async )?online\b/
    );
    if (/\bno\s+(?:async(?:hronous)?|online)\b|\bin[- ]person only\b/.test(text)) maxOnline = 0;
    else if (online) maxOnline = Number(online[1]);
    else if (/\b(?:ok|okay|fine)\b[^.]*?(?:\d)\s*[-–to ]+\s*(\d)\s*online/.test(text))
        maxOnline = Number(text.match(/(\d)\s*(?:online)/)?.[1] ?? maxOnline);
    else if (prefs.asyncCount && !prefs.asyncPreferredOnly) maxOnline = Math.max(maxOnline ?? 0, prefs.asyncCount.max);
    return { prefs, coreOnly, subjectCounts, maxOnline, excludedSections: rules.excludedSections };
}

export function statedRules(
    messages: string[],
    subjects: Set<string>,
    names: Array<{ code: string; name: string }> = [],
    persistent: PlannerRules = EMPTY_RULES
): PlannerRules {
    return messages.reduce((r, m) => applyMessage(r, m, subjects, names), persistent);
}

/** "Remember …" saves a rule for every future request; anything else is for this schedule only. */
export function rememberedPart(message: string): string | null {
    const m = message.match(/\bremember(?: that)?\s+(.{3,200})/i);
    return m ? m[1]! : null;
}

/** Solver constraints from the structured rules; the term and credit range are always explicit. */
export function constraintsFromRules(
    rules: PlannerRules,
    term: string,
    base?: Partial<ScheduleConstraints>
): ScheduleConstraints {
    const p = rules.prefs;
    return {
        minCredits: Math.max(1, p.credits?.min ?? base?.minCredits ?? MIN_CREDITS),
        maxCredits: p.credits?.max ?? base?.maxCredits ?? DEFAULT_MAX_CREDITS,
        creditsRequested: !!p.credits || !!base?.creditsRequested,
        avoidDays: p.avoidDays as DayCode[],
        excludedSubjects: p.excludedSubjects,
        excludedTitleWords: p.excludedTitleWords,
        excludedCourses: p.excludedCourses,
        term,
        online: p.asyncCount,
        onlineIsPreference: p.asyncPreferredOnly,
        backToBack: p.backToBack,
        maxGapMinutes: p.maxGapMinutes,
        dayLimits: p.dayLimits as DayLimits,
        coreOnly: rules.coreOnly,
        subjectCounts: rules.subjectCounts,
        maxOnline: rules.maxOnline ?? undefined,
        excludedSections: rules.excludedSections,
        checkTravel: true,
    };
}

/**
 * Hard rules the student stated are folded into whatever constraints the model asked for. The model may add
 * detail but can never loosen a stated rule.
 */
export function enforceStated(
    model: ScheduleConstraints,
    stated: ScheduleConstraints,
    /** what the model set explicitly this turn: the model's reading of the request wins over keyword matching */
    explicit: { coreOnly?: boolean; allowElectives?: boolean } = {}
): ScheduleConstraints {
    const union = <T>(a: T[] = [], b: T[] = []) => [...new Set([...a, ...b])];
    return {
        ...model,
        avoidDays: union(model.avoidDays, stated.avoidDays),
        excludedSubjects: union(model.excludedSubjects, stated.excludedSubjects),
        excludedTitleWords: union(model.excludedTitleWords, stated.excludedTitleWords),
        excludedCourses: union(model.excludedCourses, stated.excludedCourses),
        excludedSections: union(model.excludedSections, stated.excludedSections),
        // keyword matching only fills a gap: it never overrides what the model understood from the whole request
        coreOnly:
            explicit.coreOnly || explicit.allowElectives ? !!model.coreOnly : !!(model.coreOnly || stated.coreOnly),
        subjectCounts: { ...(model.subjectCounts ?? {}), ...(stated.subjectCounts ?? {}) },
        maxOnline:
            stated.onlineIsPreference && stated.maxOnline == null
                ? undefined
                : model.maxOnline != null && stated.maxOnline != null
                  ? Math.min(model.maxOnline, stated.maxOnline)
                  : (stated.maxOnline ?? model.maxOnline),
        ...(stated.creditsRequested
            ? {
                  minCredits: Math.max(model.minCredits, stated.minCredits),
                  maxCredits: Math.min(model.maxCredits, stated.maxCredits),
                  creditsRequested: true,
              }
            : {}),
        dayLimits: { ...(model.dayLimits ?? {}), ...(stated.dayLimits ?? {}) },
        backToBack: model.backToBack || stated.backToBack,
        maxGapMinutes: stated.maxGapMinutes !== undefined ? stated.maxGapMinutes : model.maxGapMinutes,
        checkTravel: true,
    };
}

// ---------------------------------------------------------------------------------------------------------

export interface PlannerState {
    /** bumped on every change; answers carry the seq they started under */
    seq: number;
    persistent: PlannerRules;
    session: PlannerRules;
    /** earlier session rule sets, newest last, for undo */
    undo: PlannerRules[];
}

export const initialState = (persistent: PlannerRules = EMPTY_RULES): PlannerState => ({
    seq: 0,
    persistent,
    session: persistent,
    undo: [],
});

export function reduce(
    state: PlannerState,
    message: string,
    subjects: Set<string>,
    names: Array<{ code: string; name: string }> = []
): PlannerState {
    if (/^\s*undo\b/i.test(message)) return undoLast(state);
    let persistent = state.persistent;
    const remembered = rememberedPart(message);
    if (remembered) persistent = applyMessage(persistent, remembered, subjects, names);
    // the persistent rules are the base; this message edits only what it mentions
    const session = applyMessage(
        remembered ? applyMessage(state.session, remembered, subjects, names) : state.session,
        message,
        subjects,
        names
    );
    return { seq: state.seq + 1, persistent, session, undo: [...state.undo, state.session].slice(-20) };
}

export function undoLast(state: PlannerState): PlannerState {
    const previous = state.undo.at(-1);
    return previous
        ? { ...state, seq: state.seq + 1, session: previous, undo: state.undo.slice(0, -1) }
        : { ...state, seq: state.seq + 1 };
}

/** "Give me another option": rule out the sections currently shown (the solver must find different ones). */
export function anotherOption(state: PlannerState, shown: number[]): PlannerState {
    return {
        ...state,
        seq: state.seq + 1,
        session: { ...state.session, excludedSections: [...new Set([...state.session.excludedSections, ...shown])] },
        undo: [...state.undo, state.session].slice(-20),
    };
}

/** True when an answer started under `startedAt` is still current. */
export const isCurrent = (state: PlannerState, startedAt: number) => state.seq === startedAt;
