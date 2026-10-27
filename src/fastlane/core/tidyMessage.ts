/**
 * A quick, local clean-up of a draft when the AI rewrite isn't available: common abbreviations spelled out
 * and the first letter capitalized. It never adds or removes a preference.
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
    [/\bmwf\b/gi, 'Monday, Wednesday and Friday'],
    [/\btth\b|\bt\/th\b/gi, 'Tuesday and Thursday'],
    [/\bmon\b/gi, 'Monday'],
    [/\btues?\b/gi, 'Tuesday'],
    [/\bwed\b/gi, 'Wednesday'],
    [/\bthurs?\b/gi, 'Thursday'],
    [/\bfri\b/gi, 'Friday'],
    [/\bcreds?\b|\bcrs\b/gi, 'credits'],
    [/\bhrs?\b/gi, 'hours'],
    [/\basync\b/gi, 'fully online (asynchronous)'],
    [/\bgov\b/gi, 'government'],
    [/\becon\b/gi, 'economics'],
    [/\bsched\b/gi, 'schedule'],
    [/\bprofs?\b/gi, 'professors'],
    [/\bw\/o\b/gi, 'without'],
    [/\bw\//gi, 'with '],
    [/\bpls\b|\bplz\b/gi, 'please'],
    [/\bu\b/gi, 'you'],
    [/\bi\b/g, 'I'],
];

export function tidyMessage(draft: string): string {
    let text = draft.trim().replace(/\s+/g, ' ');
    for (const [pattern, word] of REPLACEMENTS) text = text.replace(pattern, word);
    text = text.charAt(0).toUpperCase() + text.slice(1);
    return /[.!?]$/.test(text)
        ? text
        : `${text}${/^(?:how|what|which|why|when|who|can|do|does|is|are|should)\b/i.test(text) ? '?' : '.'}`;
}
