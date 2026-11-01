/**
 * Schema check for the model's tool arguments. The model proposes; this decides whether the proposal is
 * well-formed. A bad call returns errors to the model (bounded retries) and never reaches the solver, the
 * calendar or the chat.
 */
export interface ArgIssue {
    field: string;
    problem: string;
}

type Kind = 'number' | 'boolean' | 'string' | 'strings' | 'object';
/** Constraint fields shared by both tools: a follow-up can change any rule the first request could set. */
const CONSTRAINTS: Record<string, Kind> = {
    minCredits: 'number',
    maxCredits: 'number',
    onlyDays: 'strings',
    avoidDays: 'strings',
    onlineMin: 'number',
    onlineMax: 'number',
    backToBack: 'boolean',
    maxGapMinutes: 'number',
    coreFocus: 'boolean',
    coreOnly: 'boolean',
    allowElectives: 'boolean',
    requiredCourses: 'strings',
    dayWindows: 'object',
    objective: 'string',
    exactCounts: 'object',
    includeSubjects: 'strings',
    excludeSubjects: 'strings',
    excludeCourses: 'strings',
    earliestStart: 'string',
    latestEnd: 'string',
};
const BUILD: Record<string, Kind> = {
    ...CONSTRAINTS,
    prioritizeGrades: 'boolean',
    prioritizeRatings: 'boolean',
    preferCourses: 'strings',
};
const MODIFY: Record<string, Kind> = {
    ...CONSTRAINTS,
    remove: 'strings',
    addCourse: 'string',
    addSubject: 'string',
    replaceCourse: 'string',
    replaceReason: 'string',
    changeOnlyDays: 'strings',
    changeCredits: 'object',
    anotherOption: 'boolean',
    swapSectionFor: 'string',
    sectionGoal: 'string',
};
const DAYS = /^(?:m|mon|monday|t|tu|tue|tues|tuesday|w|wed|wednesday|th|thu|thur|thurs|thursday|f|fri|friday)$/i;

function check(
    args: unknown,
    schema: Record<string, Kind>
): { ok: true; args: Record<string, unknown> } | { ok: false; issues: ArgIssue[] } {
    if (!args || typeof args !== 'object' || Array.isArray(args))
        return { ok: false, issues: [{ field: '(arguments)', problem: 'must be an object' }] };
    const issues: ArgIssue[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        const kind = schema[key];
        // an argument the tool does not know must never be silently dropped: the change it asked for would not happen
        if (!kind) {
            issues.push({ field: key, problem: 'is not an argument of this tool' });
            continue;
        }
        if (value === null || value === undefined) continue;
        const good =
            (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
            (kind === 'boolean' && typeof value === 'boolean') ||
            (kind === 'string' && typeof value === 'string') ||
            (kind === 'strings' && Array.isArray(value) && value.every(v => typeof v === 'string')) ||
            (kind === 'object' && typeof value === 'object' && !Array.isArray(value));
        if (!good) issues.push({ field: key, problem: `expected ${kind}` });
        else out[key] = value;
    }
    for (const f of ['minCredits', 'maxCredits', 'onlineMin', 'onlineMax'] as const) {
        const v = out[f];
        if (typeof v === 'number' && (v < 0 || v > 40)) issues.push({ field: f, problem: 'must be between 0 and 40' });
    }
    if (typeof out.minCredits === 'number' && typeof out.maxCredits === 'number' && out.minCredits > out.maxCredits)
        issues.push({ field: 'minCredits', problem: 'is greater than maxCredits' });
    for (const f of ['onlyDays', 'avoidDays', 'changeOnlyDays'] as const)
        for (const d of (out[f] as string[] | undefined) ?? [])
            if (!DAYS.test(d.replace(/[^a-z]/gi, ''))) issues.push({ field: f, problem: `"${d}" is not a weekday` });
    if (
        out.sectionGoal &&
        !['easier', 'better rated', 'online', 'in-person', 'earlier', 'later'].includes(String(out.sectionGoal))
    )
        issues.push({
            field: 'sectionGoal',
            problem: 'must be easier, better rated, online, in-person, earlier or later',
        });
    if (out.objective && !['gpa', 'convenience', 'degree'].includes(String(out.objective)))
        issues.push({ field: 'objective', problem: 'must be gpa, convenience or degree' });
    if (out.dayWindows)
        for (const [k, v] of Object.entries(out.dayWindows as Record<string, unknown>))
            if (!DAYS.test(k.replace(/[^a-z]/gi, '')) || !v || typeof v !== 'object')
                issues.push({ field: 'dayWindows', problem: `${k}: expected a weekday and {from,to}` });
    if (out.exactCounts)
        for (const [k, v] of Object.entries(out.exactCounts as Record<string, unknown>))
            if (!/^[A-Z]{1,4}$/.test(k) || !Number.isInteger(v) || (v as number) < 0 || (v as number) > 6)
                issues.push({ field: 'exactCounts', problem: `${k}: expected a subject code and a count 0–6` });
    return issues.length ? { ok: false, issues } : { ok: true, args: out };
}

export const validateBuildArgs = (a: unknown) => check(a, BUILD);
export const validateModifyArgs = (a: unknown) => check(a, MODIFY);
