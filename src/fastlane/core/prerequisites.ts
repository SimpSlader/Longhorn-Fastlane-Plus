/**
 * Reads UT's printed prerequisite text ("Prerequisite: Accounting 312 or 312H; and Statistics 301 or 301H")
 * into groups of alternatives (all groups required, any course within a group) and compares them with the
 * student's IDA. Deliberately conservative: "met" only when every group has a completed or in-progress course,
 * "unmet" only when no group does, otherwise "check". Non-course conditions (standing, consent, admission)
 * are surfaced as notes, never decided.
 */
import { normalizeCourseCode } from './requirements';

export type PrerequisiteStatus = 'met' | 'unmet' | 'check' | 'none';

export interface PrerequisiteCheck {
    status: PrerequisiteStatus;
    /** required groups of alternatives, e.g. [["ACC 312","ACC 312H"],["STA 301","STA 301H"]] */
    groups: string[][];
    /** groups with no course in the IDA, written "ACC 312 or ACC 312H" */
    missing: string[];
    notes: string[];
}

const NUMBER = /^\d{3}[A-Z]{0,2}$/;
const JOINERS = new Set(['and', 'or', 'either', 'both', 'and/or']);

/** Builds a name → code lookup, longest names first (so "Architectural Interior Design" beats "Architecture"). */
export function subjectNameIndex(subjects: Array<{ code: string; name: string }>): Array<[string, string]> {
    const byName = new Map<string, string>();
    for (const { code, name } of subjects) if (name && code) byName.set(name.toLowerCase(), code);
    return [...byName.entries()].sort((a, b) => b[0].length - a[0].length);
}

interface SubjectList {
    courses: string[];
    joiners: string[];
    /** text between the previous list and this subject name */
    before: string;
}

/** Subject names grouped by their first word, so matching only looks at names that can start at a word. */
const firstWordIndexes = new WeakMap<Array<[string, string]>, Map<string, Array<[string, string]>>>();
function byFirstWord(index: Array<[string, string]>): Map<string, Array<[string, string]>> {
    let map = firstWordIndexes.get(index);
    if (!map) {
        map = new Map();
        for (const entry of index) {
            const first = entry[0].match(/^[a-z]+/)?.[0] ?? entry[0];
            const list = map.get(first);
            if (list) list.push(entry);
            else map.set(first, [entry]);
        }
        firstWordIndexes.set(index, map);
    }
    return map;
}

function subjectLists(text: string, index: Array<[string, string]>): SubjectList[] {
    const lists: SubjectList[] = [];
    const lower = text.toLowerCase();
    const starts = byFirstWord(index);
    const words = /[a-z]+/g;
    let i = 0;
    let lastEnd = 0;
    while (i < text.length) {
        words.lastIndex = i;
        const word = words.exec(lower);
        if (!word) break;
        i = word.index;
        // index entries are sorted longest name first, and each first-word list keeps that order
        const hit = starts
            .get(word[0])
            ?.find(([name]) => lower.startsWith(name, i) && !/[a-z]/i.test(text[i + name.length] ?? ''));
        if (!hit) {
            i += word[0].length;
            continue;
        }
        const [name, code] = hit;
        const list: SubjectList = { courses: [], joiners: [], before: text.slice(lastEnd, i) };
        i += name.length;
        // numbers that follow belong to this subject: "Mathematics 408C, 408L, or 408S"
        const re = /\s*(,|\(|\)|[^\s,()]+)/y;
        re.lastIndex = i;
        let end = i;
        for (let m = re.exec(text); m; m = re.exec(text)) {
            const raw = m[1] ?? '';
            const token = raw.replace(/[.;:]+$/, '');
            if (NUMBER.test(token)) list.courses.push(`${code} ${token}`);
            else if (JOINERS.has(token.toLowerCase())) list.joiners.push(token.toLowerCase());
            else if (raw !== ',' && raw !== '(' && raw !== ')') break;
            end = re.lastIndex;
            if (raw !== token) break; // a period or semicolon ends the list
        }
        i = end;
        lastEnd = end;
        if (list.courses.length) lists.push(list);
    }
    return lists;
}

const groupCache = new WeakMap<Array<[string, string]>, Map<string, string[][]>>();

/** Required groups of alternative courses referenced in prerequisite text (cached per text). */
export function prerequisiteGroups(text: string, index: Array<[string, string]>): string[][] {
    let cache = groupCache.get(index);
    if (!cache) {
        cache = new Map();
        groupCache.set(index, cache);
    }
    const hit = cache.get(text);
    if (hit) return hit;
    const groups = readGroups(text, index);
    cache.set(text, groups);
    return groups;
}

function readGroups(text: string, index: Array<[string, string]>): string[][] {
    const groups: string[][] = [];
    for (const list of subjectLists(text, index)) {
        const anded = list.joiners.includes('and') && !list.joiners.includes('or');
        const fresh = anded ? list.courses.map(c => [c]) : [list.courses];
        // "… 312 or Statistics 301" continues the previous alternatives; ";" or "and" starts a new requirement
        const continuesAlternatives = /\bor\b/i.test(list.before) && !/;|\band\b/i.test(list.before);
        const previous = groups[groups.length - 1];
        if (continuesAlternatives && previous && fresh.length === 1 && fresh[0]) previous.push(...fresh[0]);
        else groups.push(...fresh);
    }
    return groups.map(g => [...new Set(g)]);
}

/** Every course code referenced, in order. */
export function prerequisiteCourses(text: string, index: Array<[string, string]>): string[] {
    return [...new Set(prerequisiteGroups(text, index).flat())];
}

export function checkPrerequisites(
    text: string | undefined,
    taken: Iterable<string>,
    index: Array<[string, string]>
): PrerequisiteCheck {
    if (!text) return { status: 'none', groups: [], missing: [], notes: [] };
    const notes: string[] = [];
    if (/standing/i.test(text)) notes.push('Requires a class standing');
    if (/consent/i.test(text)) notes.push('May require instructor or department consent');
    if (/admission|admitted|restricted to/i.test(text)) notes.push('May be restricted to admitted students');
    const groups = prerequisiteGroups(text, index);
    if (!groups.length) return { status: 'check', groups, missing: [], notes };
    const have = new Set([...taken].map(normalizeCourseCode));
    const unmetGroups = groups.filter(g => !g.some(c => have.has(normalizeCourseCode(c))));
    const status = unmetGroups.length === 0 ? 'met' : unmetGroups.length === groups.length ? 'unmet' : 'check';
    return { status, groups, missing: unmetGroups.map(g => g.join(' or ')), notes };
}

export function describePrerequisites(check: PrerequisiteCheck): string {
    switch (check.status) {
        case 'none':
            return 'No prerequisite printed';
        case 'met':
            return 'Listed prerequisite courses appear in your IDA';
        case 'unmet':
            return `Prerequisite not in your IDA: ${check.missing.join('; ')}`;
        default:
            return check.missing.length
                ? `Check prerequisites; not in your IDA: ${check.missing.join('; ')}`
                : 'Check prerequisites in the course description';
    }
}

/** Recommendation-engine eligibility from printed prerequisites (reserved seats stay "restricted"). */
export function prerequisiteEligibility(
    section: { prerequisites?: string; isReserved: boolean },
    taken: Iterable<string>,
    index: Array<[string, string]>
): { status: 'eligible' | 'unknown' | 'restricted'; notes: string[]; prerequisite: PrerequisiteCheck } {
    const check = checkPrerequisites(section.prerequisites, taken, index);
    const notes = check.status === 'none' ? [] : [describePrerequisites(check), ...check.notes];
    if (section.isReserved) notes.push('Some seats are reserved; check the reserved-seat details on UT’s listing');
    const status =
        check.status === 'unmet' || section.isReserved
            ? 'restricted'
            : check.status === 'met' && !check.notes.length
              ? 'eligible'
              : 'unknown';
    if (check.status === 'none' && !section.isReserved)
        notes.push('Prerequisites not verified — check the course description');
    return { status, notes, prerequisite: check };
}
