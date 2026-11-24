/** A bounded tool message must remain valid JSON. The full result stays in the local UI. */
export function serializeToolResult(value: unknown, limit = 3900): string {
    const raw = JSON.stringify(value ?? null);
    if (raw.length <= limit) return raw;
    const compact = (v: unknown, depth: number): unknown => {
        if (typeof v === 'string') return v.slice(0, 120);
        if (v === null || typeof v !== 'object') return v;
        if (depth <= 0) return '[details omitted]';
        if (Array.isArray(v)) return v.slice(0, 8).map(x => compact(x, depth - 1));
        return Object.fromEntries(
            Object.entries(v)
                .slice(0, 20)
                .map(([k, x]) => [k, compact(x, depth - 1)])
        );
    };
    const data = value as Record<string, unknown>;
    const small = compact(value, 4);
    const first = JSON.stringify(small);
    if (first.length <= limit && !(Array.isArray(data?.classes) && data.classes.length > 8)) return first;
    if (data && Array.isArray(data.classes)) {
        const validation = data.validation as Record<string, unknown> | undefined;
        const backups = data.backups as
            | { perClass?: Array<{ for: string; options?: unknown[] }>; general?: unknown[] }
            | undefined;
        const plan = {
            trimmed: true,
            semester: data.semester,
            totalCredits: data.totalCredits,
            validation: validation
                ? {
                      hardOk: validation.hardOk,
                      allRulesMet: validation.allRulesMet,
                      failures: compact(validation.failures, 1),
                      unverified: compact(validation.unverified, 1),
                  }
                : { allRulesMet: false },
            classes: data.classes.map((c: Record<string, unknown>) => ({
                code: c.code,
                unique: c.unique,
                credits: c.credits,
                when: typeof c.when === 'string' ? c.when.slice(0, 100) : undefined,
                countsToward: c.countsToward,
                degree: compact(c.degree, 2),
                historicalARate: c.historicalARate,
            })),
            backups: {
                perClass: backups?.perClass?.map(b => ({ for: b.for, options: compact(b.options?.slice(0, 1), 2) })),
                general: compact(backups?.general?.slice(0, 1), 2),
            },
        };
        const text = JSON.stringify(plan);
        if (text.length <= limit) return text;
        plan.backups = { perClass: [], general: [] };
        const withoutBackups = JSON.stringify(plan);
        if (withoutBackups.length <= limit) return withoutBackups;
    }
    return JSON.stringify({
        error: 'The tool result is too large for a reliable AI summary. Ask for fewer items. Full results remain local.',
        trimmed: true,
    });
}
