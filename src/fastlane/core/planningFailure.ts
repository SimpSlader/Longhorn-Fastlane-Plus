/** Student-facing failure details come from the local tool, never an optimistic model reply. */
export function planningFailure(value: unknown): string {
    const result = value as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
    const lines = [String(result.error ?? 'The schedule could not be built.')];
    const reasons = strings(result.reasons ?? result.failures);
    if (reasons.length) lines.push('Why this attempt stopped:', ...reasons.slice(0, 5).map(s => `- ${s}`));
    const alternatives = Array.isArray(result.closestAlternatives) ? result.closestAlternatives : [];
    if (alternatives.length) {
        lines.push('Closest checked options — not added to your calendar:');
        for (const alt of alternatives.slice(0, 3)) {
            const codes = Array.isArray(alt.classes)
                ? alt.classes
                      .map((c: { code?: string }) => c.code)
                      .filter(Boolean)
                      .join(', ')
                : '';
            lines.push(`- ${alt.requiresPermissionTo}: ${alt.totalCredits} credit hours${codes ? ` (${codes})` : ''}.`);
        }
    }
    const suggestions = strings(result.suggestions);
    if (suggestions.length) lines.push('Changes you can ask me to try:', ...suggestions.slice(0, 3).map(s => `- ${s}`));
    if (typeof result.note === 'string') lines.push(result.note);
    lines.push('Your saved schedules have not changed.');
    return lines.join('\n\n');
}
