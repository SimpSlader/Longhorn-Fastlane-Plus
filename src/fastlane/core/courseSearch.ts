/**
 * Finding courses from how a student actually writes them: "web based nutrition", "fundamental of nutrition",
 * "NTR". Words are stemmed (fundamental/fundamentals), filler and delivery words are set aside (and turn on the
 * online filter), and a word may match the course title, the course code, or the subject's own name — so
 * "nutrition" finds NTR courses even when a title doesn't contain it. A literal substring match was why a
 * real web-based nutrition class was reported as missing.
 */
import { normalizeCourseCode } from './requirements';
import { type SectionRecord, subjectOf } from './sections';

const FILLER = new Set([
    'of',
    'the',
    'a',
    'an',
    'and',
    'in',
    'to',
    'for',
    'with',
    'class',
    'classes',
    'course',
    'courses',
    'section',
    'sections',
    'some',
    'something',
    'any',
    'one',
    'please',
    'ut',
    'like',
]);
const DELIVERY = new Set([
    'web',
    'based',
    'webbased',
    'online',
    'internet',
    'async',
    'asynchronous',
    'wb',
    'remote',
    'virtual',
]);

const stem = (w: string) =>
    w.length > 4 ? w.replace(/ies$/, 'y').replace(/(?:es|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w;
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export interface CourseQuery {
    tokens: string[];
    /** the student asked for web-based / online / asynchronous delivery */
    online: boolean;
}

export function parseCourseQuery(query: string): CourseQuery {
    const all = words(query);
    return {
        online: all.some(w => DELIVERY.has(w)),
        tokens: all.filter(w => !FILLER.has(w) && !DELIVERY.has(w)).map(stem),
    };
}

/** subject code → stemmed words of its name, from the planner's subject index ([name, code] pairs). */
export function subjectWords(index: Array<[string, string]>): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const [name, code] of index) {
        const set = out.get(code) ?? new Set<string>();
        for (const w of words(name)) set.add(stem(w));
        out.set(code, set);
    }
    return out;
}

export function sectionMatchesQuery(
    s: SectionRecord,
    q: CourseQuery,
    subjects: Map<string, Set<string>> = new Map()
): boolean {
    if (!q.tokens.length) return true;
    const code = normalizeCourseCode(s.courseCode);
    const haystack = new Set([
        ...words(s.title).map(stem),
        ...words(code),
        ...(subjects.get(subjectOf(s.courseCode)) ?? []),
    ]);
    return q.tokens.every(
        t => haystack.has(t) || [...haystack].some(h => h.length > 3 && t.length > 3 && h.startsWith(t))
    );
}

/** The course code a free-text name most plausibly means (most sections wins; null when nothing matches). */
export function resolveCourseCode(
    text: string,
    sections: SectionRecord[],
    subjectIndex: Array<[string, string]>
): string | null {
    const direct = normalizeCourseCode(text);
    if (/\d{3}/.test(direct) && sections.some(s => normalizeCourseCode(s.courseCode) === direct)) return direct;
    const q = parseCourseQuery(text);
    const subjects = subjectWords(subjectIndex);
    // "NUTR 301": the department letters are a prefix of a subject's name ("nutritional sciences") and that subject
    // has exactly one course listed → it is that course. Never guessed when several courses could be meant.
    const dept = direct
        .match(/^([A-Z ]+?)\s+\d{3}[A-Z]*$/)?.[1]
        ?.trim()
        .toLowerCase();
    if (dept && dept.length >= 3) {
        const codes = [...subjects.entries()].filter(([, ws]) => [...ws].some(w => w.startsWith(dept))).map(([c]) => c);
        const courses = new Set(
            sections.filter(s => codes.includes(subjectOf(s.courseCode))).map(s => normalizeCourseCode(s.courseCode))
        );
        if (courses.size === 1) return [...courses][0]!;
    }
    const counts = new Map<string, number>();
    for (const s of sections)
        if (sectionMatchesQuery(s, q, subjects))
            counts.set(normalizeCourseCode(s.courseCode), (counts.get(normalizeCourseCode(s.courseCode)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
