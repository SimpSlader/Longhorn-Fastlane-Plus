/**
 * The model writes the explanation, but it cannot award the verdict. Any "all rules met"-style claim in its text
 * is checked against the validator's report: unsupported claims are struck, and the report's own verdict is
 * appended so what the student reads always matches what the validator found.
 */
import { type ValidationReport, verdictText } from './planValidator';

const CLAIMS = [
    /\b(?:all|every)\s+(?:of\s+)?(?:your\s+|the\s+)?(?:rules?|constraints?|requirements?|criteria|conditions?|preferences?)\s+(?:are\s+|were\s+|was\s+|have been\s+|has been\s+|is\s+)?(?:met|satisfied|fulfilled|followed|checked|respected)\b/gi,
    /\b(?:meets|satisfies|fulfills|follows)\s+(?:all|every)\s+(?:of\s+)?(?:your\s+|the\s+)?(?:rules?|constraints?|requirements?|criteria)\b/gi,
    /\bfully (?:degree[- ]audit[- ]verified|verified)\b/gi,
    /\b(?:verified|checked) against your degree audit\b/gi,
];
export const STRUCK = '[not confirmed by the validator]';

export function guardReply(text: string, report: ValidationReport | null): string {
    let out = text;
    // Degree assertions in model prose are replaced with the deterministic course outcome.
    // Even an otherwise valid timetable cannot authorize an invented requirement or elective claim.
    if (report?.degree) {
        out = out
            .split(/(?<=[.!?])\s+|\n/)
            .map(sentence => {
                if (
                    !/fulfil|satisf|count(?:s|ing)? toward|degree.applic|advance.*requirement|core requirement/i.test(
                        sentence
                    )
                )
                    return sentence;
                const courses = report.degree!.courses.filter(c =>
                    sentence.toUpperCase().replace(/\s+/g, '').includes(c.courseCode.replace(/\s+/g, '').toUpperCase())
                );
                return courses.length ? courses.map(c => `${c.courseCode}: ${c.explanation}`).join(' ') : sentence;
            })
            .join('\n');
    }
    const auditOk = report?.checks.find(c => c.id === 'degree-audit')?.status === 'pass';
    for (const [i, re] of CLAIMS.entries()) {
        // claims about the audit stand only when that check passed; the others only when everything passed
        const supported = i >= 2 ? !!report?.allRulesMet && (i === 3 ? auditOk : true) : !!report?.allRulesMet;
        if (!supported) out = out.replace(re, STRUCK);
    }
    if (!report) return out;
    const verdict = `**Validator:** ${verdictText(report)}`;
    return `${out.trimEnd()}\n\n${verdict}`;
}
