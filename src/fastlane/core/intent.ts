/**
 * What the student is asking, decided locally before anything else runs, so a question about credits gets a
 * credit answer (no schedule, no AI call) and only schedule requests start the schedule builder. Typos are
 * tolerated ("hyow many jours do i have compleeted" reads as "how many hours have I completed").
 */

export type Intent =
    | { kind: 'memory' }
    | { kind: 'correction'; completedHours?: number }
    | { kind: 'completed-hours' }
    | { kind: 'in-progress-hours' }
    | { kind: 'total-hours' }
    | { kind: 'remaining-hours' }
    | { kind: 'gpa' }
    | { kind: 'current-classes' }
    | { kind: 'easiest-class' }
    | { kind: 'course-sections'; course: string }
    | { kind: 'degree-planning' }
    /** hours per semester / semesters left to graduate by a term, with or without summers (calculated, no AI) */
    | { kind: 'graduation-plan'; summerHours?: number }
    | { kind: 'schedule' }
    | { kind: 'chat' };

/** Words the classifier relies on; a misspelling within one or two edits of one of these is read as it. */
const VOCABULARY = [
    'how',
    'many',
    'much',
    'hours',
    'hour',
    'credits',
    'credit',
    'completed',
    'complete',
    'finished',
    'earned',
    'taken',
    'taking',
    'currently',
    'enrolled',
    'semester',
    'remaining',
    'left',
    'graduate',
    'graduation',
    'schedule',
    'classes',
    'class',
    'courses',
    'course',
    'easiest',
    'easy',
    'sections',
    'available',
    'wrong',
    'actually',
    'transfer',
    'degree',
    'progress',
    'total',
    'have',
    'what',
    'which',
    'show',
];

/** Ordinary words that sit one letter away from a vocabulary word and must stay as typed ("that" ≠ "what"). */
const KEEP = new Set(
    'that this then than them they will with know from your more some time also just like want need make sure when were been only take does done hard core math'.split(
        ' '
    )
);

/** Damerau–Levenshtein distance, stopping early once it exceeds `max`. */
function distance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
        let rowMin = Number.POSITIVE_INFINITY;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                v = Math.min(v, d[i - 2]![j - 2]! + 1);
            d[i]![j] = v;
            rowMin = Math.min(rowMin, v);
        }
        if (rowMin > max) return max + 1;
    }
    return d[a.length]![b.length]!;
}

/** Lowercases and repairs likely typos of the words above ("compleeted" → "completed"). */
export function normalizeMessage(message: string): string {
    return message
        .toLowerCase()
        .replace(/[’']/g, "'")
        .split(/(\s+)/)
        .map(token => {
            const word = token.replace(/[^a-z]/g, '');
            if (word.length < 4 || VOCABULARY.includes(word) || KEEP.has(word)) return token;
            const max = word.length >= 7 ? 2 : 1;
            let best: string | null = null;
            let bestD = max + 1;
            for (const v of VOCABULARY) {
                const dd = distance(word, v, max);
                if (dd < bestD) {
                    best = v;
                    bestD = dd;
                }
            }
            return best ? token.replace(word, best) : token;
        })
        .join('');
}

const HOURS = String.raw`(?:hours?|credits?|credit hours?|hrs|units?)`;

export function classifyIntent(
    message: string,
    opts: { courseCodes?: (text: string) => string[]; hasPlan?: boolean } = {}
): Intent {
    const raw = message.trim();
    const t = normalizeMessage(raw);
    if (/^(?:please )?(?:remember|forget|from now on|always|keep in mind|clear (?:your|my) memory)\b/.test(t))
        return { kind: 'memory' };

    // "that's wrong, I've completed 9 credits, not 33"
    const corrected = t.match(
        new RegExp(String.raw`\b(?:i(?:'ve| have)? (?:completed|finished|earned|taken|done)|i have) (\d{1,3}) ${HOURS}`)
    );
    if (/\b(?:wrong|incorrect|not right|that's not|thats not|actually)\b/.test(t) && corrected)
        return { kind: 'correction', completedHours: Number(corrected[1]) };

    // "how many hours per semester to graduate in spring 2029", "what if I take 12 summer credits",
    // "how many semesters do I have left": answered by the graduation calculator
    const buildsSomething =
        /\b(?:build|make|create|find|give me|plan out|put together|suggest|recommend)\b[^.?!]*\b(?:schedule|classes|courses|electives|sections|semester plan)\b/.test(
            t
        );
    const whatIfSummer =
        /\bwhat if\b|\bif i (?:take|took|did|do)\b/.test(t) && /\bsummers?\b/.test(t)
            ? t.match(/\b(\d{1,2}) (?:summer )?(?:credits?|hours?)\b/)
            : null;
    if (whatIfSummer && !buildsSomething) return { kind: 'graduation-plan', summerHours: Number(whatIfSummer[1]) };
    if (
        !buildsSomething &&
        (/\b(?:per|a|each) semester\b[^.?!]*\b(?:graduat|finish|spring|fall|summer|20\d\d)/.test(t) ||
            /\b(?:graduat|finish)\w*\b[^.?!]*\b(?:per|a|each) semester\b/.test(t) ||
            /\bhow many (?:more )?(?:long |regular )?semesters?\b/.test(t) ||
            (/\bhow many (?:credits?|hours?|credit hours?)\b/.test(t) &&
                (/\bsummers?\b/.test(t) || /\bsemesters\b/.test(message.toLowerCase())) &&
                !/\bthis semester\b/.test(t)) ||
            /\bsemesters? (?:left|remain)/.test(t))
    )
        return { kind: 'graduation-plan' };

    const asks = /\b(?:how many|how much|what(?:'s| is| are)?|do i have|have i|tell me|show me|whats|number of)\b/.test(
        t
    );
    // quick record answers are for simple questions; a request to build something, a per-semester planning
    // question or a long multi-part message goes to the planner and advisor instead
    const compound =
        /\b(?:build|make|create|find|plan)\b[^.?!]*\b(?:schedule|classes|courses)\b/.test(t) ||
        /\b(?:per|a|each) semester\b|\bsummer\b|\bif i (?:only|took|take)\b/.test(t) ||
        t.split(/\s+/).length > 30;
    if (asks && !compound && new RegExp(`\\b${HOURS}\\b`).test(t)) {
        if (/\b(?:left|remaining|still need|to graduate|until i graduate|need to graduate)\b/.test(t))
            return { kind: 'remaining-hours' };
        if (/\b(?:total|altogether|in all|overall|after this semester|by the end of (?:this|the) semester)\b/.test(t))
            return { kind: 'total-hours' };
        if (/\b(?:currently|right now|this semester|in progress|enrolled|taking)\b/.test(t))
            return { kind: 'in-progress-hours' };
        if (/\b(?:completed|complete|finished|earned|done|taken|have i|do i have|so far)\b/.test(t))
            return { kind: 'completed-hours' };
    }
    if (/\b(?:my )?(?:gpa|grade point average)\b/.test(t) && !/\b(?:protect|boost|raise|help|easy|easier)\b/.test(t))
        return { kind: 'gpa' };
    if (
        /\b(?:what|which) (?:classes|courses) am i (?:taking|enrolled in)\b|\bmy (?:current|classes this semester)\b|\bwhat am i taking\b/.test(
            t
        )
    )
        return { kind: 'current-classes' };
    if (/\b(?:easiest|hardest|easy|hard)(?:est)? (?:class|course)\b.*\b(?:my|on|in) (?:schedule|plan|week)\b/.test(t))
        return { kind: 'easiest-class' };
    const codes = opts.courseCodes?.(raw) ?? [];
    if (codes.length === 1 && /\b(?:sections?|available|times?|when is|who teaches|professors? for|open)\b/.test(t))
        return { kind: 'course-sections', course: codes[0]! };
    if (
        /\bgraduat|\bfinish (?:my degree|early|faster|in \d)|\bmccombs\b|\binternal(?:ly)? transfer|\bdegree (?:plan|audit|progress)\b|\bon track\b|\bhow many (?:classes|courses|semesters)\b|\bsemesters? (?:left|do i)\b|\bwhat should i (?:take|do)\b|\bhow (?:much|many) .*\bacc\b|\bfour[- ]year plan\b|\broadmap\b|\bwhich (?:ut )?classes (?:would|should|will|can)\b/.test(
            t
        ) &&
        !/\b(?:build|make|create|give me|find)\b.*\b(?:schedule|week|semester plan)\b/.test(t)
    )
        return { kind: 'degree-planning' };
    const scheduleWords =
        /\b(?:schedule|classes|class|courses|course|credits?|hours?|semester|online|async|in[- ]person|mornings?|afternoons?|evenings?|mon|tue|wed|thu|fri|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|mwf|tth|back[- ]to[- ]back|gaps?|easier|harder|remove|drop|add|replace|swap|instead|acc)\b/;
    // a change to the plan on screen ("remove history", "no Fridays", "make it easier", "Wednesdays are fine")
    const changesPlan =
        /\b(?:remove|drop|add|replace|swap|instead|easier|harder|keep|only|no (?:classes|class|mon|tue|wed|thu|fri|mornings?|afternoons?|evenings?|online|gaps)|(?:are|is) (?:fine|ok(?:ay)?)|more online|fewer|less|back[- ]to[- ]back)\b/.test(
            t
        );
    // questions are answered, never turned into a schedule, unless they ask for one
    if (isQuestion(t) && !buildsSomething && !(opts.hasPlan && changesPlan)) return { kind: 'chat' };
    if (scheduleWords.test(t) || (opts.hasPlan && changesPlan)) return { kind: 'schedule' };
    return { kind: 'chat' };
}

/** A question, wherever it is phrased ("Based on my credits, how many would I need…"), not only at the start. */
export function isQuestion(text: string): boolean {
    const t = text.toLowerCase();
    return (
        /\?/.test(t) ||
        /^(?:how|what|which|when|why|who|where|can|could|should|would|will|do|does|did|is|are|am)\b/.test(t.trim()) ||
        /\b(?:how (?:many|much|long|do|can|would|should)|what (?:is|are|would|should|if)|can i|could i|should i|would i|do i need|am i|is it|is there|are there)\b/.test(
            t
        )
    );
}

/** A schedule request that also asks degree-level questions (graduation timing, summers, ACC strategy, tips). */
export function alsoAsksDegreeQuestions(message: string): boolean {
    const t = normalizeMessage(message);
    return /\bgraduat|\bsemesters? (?:left|do i)\b|\bper semester\b|\bsummer\b[^.?!]{0,60}\b(?:class|classes|semester|credits?|hours?)\b|\b(?:tips|tricks|advice)\b|\bhow many (?:credits?|hours?|classes) (?:per|a|each) semester\b|\bmccombs\b|\binternal(?:ly)? transfer/.test(
        t
    );
}
