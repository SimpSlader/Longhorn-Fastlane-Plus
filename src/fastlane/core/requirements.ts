/**
 * Requirement tags shared by the degree audit, plans, recommendations and the registration queue.
 *
 * Tags are normalized strings:
 *   - "CORE 050"           UT core curriculum component (from the audit's "CORE (050)" text or the listing's Core column)
 *   - "FLAG WR"            skills & experience flags
 *   - "COURSE UGS 302"     a specific course
 *   - free text            anything the student types (kept as-is, trimmed)
 */

export interface CoreComponent {
    code: string;
    name: string;
    /** lowercase fragments that appear in UT's course-schedule "Core" column */
    aliases: string[];
}

export const CORE_COMPONENTS: CoreComponent[] = [
    { code: '010', name: 'Communication (English Composition)', aliases: ['english composition', 'communication'] },
    { code: '020', name: 'Mathematics', aliases: ['mathematics', 'math'] },
    {
        code: '030',
        name: 'Natural Science and Technology, Part I',
        aliases: [
            'natural science and technology, part i',
            'natural science & technology, part i',
            'science and technology, part i',
            'nat sci & tech, part i',
        ],
    },
    { code: '040', name: 'Humanities', aliases: ['humanities'] },
    {
        code: '050',
        name: 'Visual and Performing Arts',
        aliases: ['visual and performing arts', 'visual & performing arts', 'vis & perf arts'],
    },
    { code: '060', name: 'U.S. History', aliases: ['u.s. history', 'us history', 'american history'] },
    {
        code: '070',
        name: 'American and Texas Government',
        aliases: ['american and texas government', 'government', 'american & texas government'],
    },
    {
        code: '080',
        name: 'Social and Behavioral Sciences',
        aliases: ['social and behavioral sciences', 'social & behavioral sciences', 'social and behavioral science'],
    },
    {
        code: '090',
        name: 'First-Year Signature Course',
        aliases: ['first-year signature course', 'first year signature course', 'signature course'],
    },
    {
        code: '093',
        name: 'Natural Science and Technology, Part II',
        aliases: [
            'natural science and technology, part ii',
            'natural science & technology, part ii',
            'science and technology, part ii',
            'nat sci & tech, part ii',
        ],
    },
];

const CORE_BY_CODE = new Map(CORE_COMPONENTS.map(c => [c.code, c]));

export function coreTag(code: string): string {
    return `CORE ${code.padStart(3, '0')}`;
}

export function courseTag(courseCode: string): string {
    return `COURSE ${normalizeCourseCode(courseCode)}`;
}

/** "c s  314h" → "C S 314H"; "UGS302" → "UGS 302" */
export function normalizeCourseCode(code: string): string {
    const compact = code.toUpperCase().replace(/\s+/g, ' ').trim();
    const match =
        compact.match(/^([A-Z][A-Z ]*?)\s+([FSNW]?\d{3}[A-Z]{0,2})$/) ?? compact.match(/^([A-Z]+)(\d{3}[A-Z]{0,2})$/);
    if (!match) return compact;
    return `${match[1]!.trim()} ${match[2]}`;
}

/** Extracts core codes from audit rule text like "CORE (050): ..." or "Core 050" */
export function coreCodesInText(text: string): string[] {
    const codes = new Set<string>();
    for (const m of text.matchAll(/\bcore\s*\(?\s*(0\d{2})\s*\)?/gi)) codes.add(m[1]!);
    return [...codes];
}

/**
 * Maps a value from the course schedule's "Core" column (e.g. "Visual & Performing Arts")
 * to a core tag. Part II is checked before Part I so "Part II" never matches "Part I".
 */
export function coreTagFromListing(value: string): string | null {
    const lower = value.toLowerCase().replace(/\s+/g, ' ').trim();
    const explicit = coreCodesInText(lower);
    if (explicit.length) return coreTag(explicit[0]!);
    const bare = lower.match(/^\(?(0\d{2})\)?$/);
    if (bare && CORE_BY_CODE.has(bare[1]!)) return coreTag(bare[1]!);
    const ordered = [CORE_BY_CODE.get('093')!, ...CORE_COMPONENTS.filter(c => c.code !== '093')];
    for (const component of ordered) {
        if (component.aliases.some(alias => lower.includes(alias))) {
            if (component.code === '030' && /part ii\b/.test(lower)) continue;
            return coreTag(component.code);
        }
    }
    return null;
}

export function normalizeRequirementTag(raw: string): string {
    const trimmed = raw.trim().replace(/\s+/g, ' ');
    const core = coreCodesInText(trimmed);
    if (core.length && /^core/i.test(trimmed)) return coreTag(core[0]!);
    if (/^course\s+/i.test(trimmed)) return courseTag(trimmed.replace(/^course\s+/i, ''));
    if (/^flag\s+/i.test(trimmed)) return `FLAG ${trimmed.replace(/^flag\s+/i, '').toUpperCase()}`;
    return trimmed;
}

export function describeRequirement(tag: string): string {
    const core = tag.match(/^CORE (\d{3})$/);
    if (core) {
        const component = CORE_BY_CODE.get(core[1]!);
        return component ? `Core ${core[1]} · ${component.name}` : `Core ${core[1]}`;
    }
    if (tag.startsWith('COURSE ')) return tag.slice(7);
    if (tag.startsWith('FLAG ')) return `${tag.slice(5)} flag`;
    if (tag.startsWith('DEPT ')) return `${tag.slice(5)} courses (possible requirement fit; verify with UT)`;
    return tag;
}

/** Requirement tags a catalog section satisfies, based on its listing */
export function tagsForSection(section: { courseCode: string; core?: string[]; flags?: string[] }): string[] {
    const tags = new Set<string>([courseTag(section.courseCode)]);
    for (const c of section.core ?? []) {
        const tag = coreTagFromListing(c);
        if (tag) tags.add(tag);
    }
    for (const f of section.flags ?? []) {
        const flag = flagCode(f);
        if (flag) tags.add(`FLAG ${flag}`);
    }
    return [...tags];
}

const FLAG_ALIASES: Array<[RegExp, string]> = [
    [/writing/i, 'WR'],
    [/quantitative/i, 'QR'],
    [/global/i, 'GC'],
    [/cultural diversity/i, 'CD'],
    [/ethics/i, 'EI'],
    [/independent inquiry/i, 'II'],
];

export function flagCode(value: string): string | null {
    for (const [pattern, code] of FLAG_ALIASES) if (pattern.test(value)) return code;
    return null;
}

/** AI-reviewed broad department tags are potential matches, never proof of degree credit. */
export function sectionMatchesRequirement(
    section: { courseCode: string; requirementTags: string[] },
    requirement: string
): boolean {
    if (section.requirementTags.includes(requirement)) return true;
    if (!/^DEPT [A-Z][A-Z ]{0,5}$/.test(requirement)) return false;
    const subject = section.courseCode
        .replace(/\s*[0-9].*$/, '')
        .trim()
        .toUpperCase();
    return subject === requirement.slice(5);
}
