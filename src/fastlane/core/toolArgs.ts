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
const BUILD: Record<string, Kind> = {
    minCredits: 'number',
    maxCredits: 'number',
    onlyDays: 'strings',
    avoidDays: 'strings',
    onlineMin: 'number',
    onlineMax: 'number',
    backToBack: 'boolean',
    prioritizeGrades: 'boolean',
    prioritizeRatings: 'boolean',
    coreFocus: 'boolean',
    coreOnly: 'boolean',
    exactCounts: 'object',
    includeSubjects: 'strings',
    preferCourses: 'strings',
    excludeSubjects: 'strings',
    excludeCourses: 'strings',
    earliestStart: 'string',
    latestEnd: 'string',
};
const MODIFY: Record<string, Kind> = {
    remove: 'strings',
    addCourse: 'string',
    addSubject: 'string',
    replaceCourse: 'string',
    replaceReason: 'string',
    changeOnlyDays: 'strings',
    changeCredits: 'object',
    anotherOption: 'boolean',
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
        if (!kind) continue; // unknown keys are dropped, never interpreted
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
        if (typeof v === 'number' && (v < 0 || v > 24)) issues.push({ field: f, problem: 'must be between 0 and 24' });
    }
    if (typeof out.minCredits === 'number' && typeof out.maxCredits === 'number' && out.minCredits > out.maxCredits)
        issues.push({ field: 'minCredits', problem: 'is greater than maxCredits' });
    for (const f of ['onlyDays', 'avoidDays', 'changeOnlyDays'] as const)
        for (const d of (out[f] as string[] | undefined) ?? [])
            if (!DAYS.test(d.replace(/[^a-z]/gi, ''))) issues.push({ field: f, problem: `"${d}" is not a weekday` });
    if (out.exactCounts)
        for (const [k, v] of Object.entries(out.exactCounts as Record<string, unknown>))
            if (!/^[A-Z]{1,4}$/.test(k) || !Number.isInteger(v) || (v as number) < 0 || (v as number) > 6)
                issues.push({ field: 'exactCounts', problem: `${k}: expected a subject code and a count 0–6` });
    return issues.length ? { ok: false, issues } : { ok: true, args: out };
}

export const validateBuildArgs = (a: unknown) => check(a, BUILD);
export const validateModifyArgs = (a: unknown) => check(a, MODIFY);
