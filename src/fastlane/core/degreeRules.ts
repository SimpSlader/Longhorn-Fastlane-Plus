/** Deterministic degree planning. Audit balances are authoritative; planned allocations never become earned credit. */
import type { AuditCourse, AuditRequirement, ParsedAudit } from '../audit/types';
import coreSnapshot from '../data/ut-core-2026.json';
import degreePolicies from '../data/ut-degree-policies-2026.json';
import { coreTagFromListing, describeRequirement, normalizeCourseCode } from './requirements';
import { type SectionRecord, semesterKey } from './sections';

export type Validity = 'verified' | 'unverified' | 'stale' | 'contradictory';
export interface Evidence {
    source: string;
    effectiveTerm?: string;
    verifiedAt: number;
    validity: Validity;
    catalogYear?: string;
    program?: string;
}
export interface DegreeOptions {
    term?: string;
    program?: string;
    catalogYear?: string;
    now?: number;
}
export interface DegreeRule {
    id: string;
    label: string;
    tags: string[];
    unit: 'hours' | 'courses';
    required: number;
    counted: number;
    inProgress: number;
    importedPlanned: number;
    pending: number;
    remaining: number;
    planned: number;
    group: string;
    evidence: Evidence;
    issues: string[];
    record: AuditRequirement;
}
export interface Contribution {
    ruleId: string;
    tag: string;
    label: string;
    amount: number;
    unit: 'hours' | 'courses';
}
export interface CourseAssessment {
    uniqueId: number;
    courseCode: string;
    status:
        | 'advances'
        | 'elective'
        | 'redundant'
        | 'duplicate-credit'
        | 'duplicate-enrollment'
        | 'in-progress'
        | 'unverified'
        | 'excluded';
    contributions: Contribution[];
    degreeCredits: number;
    explanation: string;
    warnings: string[];
}
export interface DegreeEvaluation {
    rules: DegreeRule[];
    courses: CourseAssessment[];
    plannedDegreeCredits: number;
    issues: string[];
}

const DAY = 86400000;
// IDA may append a major code and separate degree initials with spaces.
const programKey = (value: string) =>
    value
        .split(',')[0]!
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
export const earnsCredit = (c: AuditCourse) =>
    c.status === 'completed' && !/^(F|W|Q|X|I|NC|U|WF|WP)$/i.test(c.grade.trim()) && !c.excluded;
const termOrder = (term: string) => {
    const m = term.match(/^(Spring|Summer|Fall) (20\d\d)$/);
    return m ? Number(m[2]) * 3 + ['Spring', 'Summer', 'Fall'].indexOf(m[1]!) : null;
};
const currentCore = (term: string) => {
    const n = termOrder(term);
    return n !== null && n >= termOrder(coreSnapshot.effectiveTerm)! && n <= termOrder(coreSnapshot.expiresAfterTerm)!;
};
const snapshotCourses: Record<string, string[]> = coreSnapshot.courses;
/** No course-name or subject inference. A catalog snapshot or recent UT Core column is required. */
export function verifiedCoreTags(code: string, term: string, section?: SectionRecord, now = Date.now()): string[] {
    const known = currentCore(term) ? snapshotCourses[normalizeCourseCode(code)] : undefined;
    const recent =
        section &&
        section.source !== 'ut-offerings' &&
        section.capturedAt <= now &&
        now - section.capturedAt <= 30 * DAY;
    const observed = recent ? [...new Set(section.core.map(coreTagFromListing).filter((t): t is string => !!t))] : [];
    if (known && observed.length && observed.some(t => !known.includes(t))) return [];
    return known ?? observed;
}

/** The imported IDA explicitly groups aliases under an enrollment; aliases do not create extra credits. */
export function creditIdentity(
    audit: Pick<ParsedAudit, 'courses'> | null,
    extra: SectionRecord[] = []
): (code: string) => string {
    const parent = new Map<string, string>();
    const find = (raw: string): string => {
        const c = normalizeCourseCode(raw);
        const p = parent.get(c);
        if (!p || p === c) return c;
        const root = find(p);
        parent.set(c, root);
        return root;
    };
    const link = (a: string, b: string) => {
        const x = find(a),
            y = find(b);
        if (x !== y) parent.set(y, x);
    };
    let actual: AuditCourse | undefined;
    for (const c of audit?.courses ?? []) {
        if (!c.equivalent) actual = c;
        else if (actual && actual.semester === c.semester) link(actual.code, c.code);
        for (const alias of c.equivalentCodes ?? []) link(c.code, alias);
    }
    for (const s of extra) for (const alias of s.equivalentCodes ?? []) link(s.courseCode, alias);
    return find;
}
export function recordedCourseCodes(audit: ParsedAudit): string[] {
    const identity = creditIdentity(audit);
    const have = new Set(
        audit.courses
            .filter(c => earnsCredit(c) || (c.status === 'in-progress' && !c.excluded))
            .filter(c => !c.equivalent)
            .map(c => identity(c.code))
    );
    return [...new Set(audit.courses.filter(c => have.has(identity(c.code))).map(c => normalizeCourseCode(c.code)))];
}
const named = (r: AuditRequirement) => r.tags.filter(t => t.startsWith('COURSE ')).map(t => t.slice(7));
function matches(
    rule: AuditRequirement,
    s: SectionRecord,
    term: string,
    identity: (s: string) => string,
    now: number
): string[] {
    if (rule.approvedCourses?.length)
        return rule.approvedCourses.some(c => identity(c) === identity(s.courseCode))
            ? rule.tags.filter(t => !t.startsWith('COURSE ') || identity(t.slice(7)) === identity(s.courseCode))
            : [];
    const codes = named(rule);
    // A core rule that explicitly names an allowed course is an intersection, not an extra OR branch.
    if (codes.length && !codes.some(c => identity(c) === identity(s.courseCode))) return [];
    const core = rule.tags.filter(t => /^CORE \d{3}$/.test(t));
    if (core.length) return core.filter(t => verifiedCoreTags(s.courseCode, term, s, now).includes(t));
    return codes.length ? codes.filter(c => identity(c) === identity(s.courseCode)).map(c => `COURSE ${c}`) : [];
}
function historySection(c: AuditCourse): SectionRecord {
    return {
        courseCode: c.code,
        core: [],
        flags: [],
        requirementTags: [],
        uniqueId: 0,
        title: c.name,
        creditHours: c.hours,
        capturedAt: 0,
        meetings: [],
        instructors: [],
        scheduleComplete: false,
        modality: 'unknown',
        isReserved: false,
    };
}
/** Numeric imported balances, not broad tag presence, determine available capacity. */
export function degreeRules(audit: ParsedAudit | null, options: DegreeOptions = {}): DegreeRule[] {
    if (!audit) return [];
    const now = options.now ?? Date.now();
    const term = options.term ?? coreSnapshot.effectiveTerm;
    const identity = creditIdentity(audit);
    const contextMismatch =
        (options.program !== undefined && options.program !== audit.program) ||
        (options.catalogYear !== undefined && options.catalogYear !== audit.catalogYear);
    const policy = currentCore(term)
        ? degreePolicies.policies.find(
              p =>
                  p.programs.some(program => programKey(program) === programKey(audit.program ?? '')) &&
                  p.catalogYear === audit.catalogYear
          )
        : undefined;
    const unique = new Set<string>();
    return audit.requirements.map(r => {
        const issues: string[] = [];
        const unit = r.required?.unit ?? 'hours';
        const required = r.required?.value ?? 0;
        const counted = r.applied?.value ?? 0;
        const rawRemaining = r.remaining?.value;
        let validity: Validity = 'verified';
        if (contextMismatch) issues.push('Import an audit for the selected major and catalog year.');
        if (audit.source !== 'html' || r.confidence !== 'high' || r.manuallyChanged)
            issues.push('Requirement needs verification against the official audit.');
        if (!r.required || !r.applied || !r.remaining || r.applied.unit !== unit || r.remaining.unit !== unit)
            issues.push('Required, counted and remaining amounts are missing or use different units.');
        if (
            ![required, counted, rawRemaining ?? NaN].every(n => Number.isFinite(n) && n >= 0) ||
            required === 0 ||
            Math.abs(required - counted - (rawRemaining ?? 0)) > 0.01 ||
            (r.status === 'completed' && !!rawRemaining)
        ) {
            validity = 'contradictory';
            issues.push('Audit amounts or completion status disagree.');
        }
        if (
            /\b(?:upper.division|residen|GPA|grade.point|at least.*grade|minimum grade|approved list|except|excluding|not count)\b/i.test(
                r.text
            ) &&
            !r.approvedCourses
        )
            issues.push('Additional degree conditions need verification.');
        if (r.tags.some(t => /^CORE (010|070)$/.test(t)) && !named(r).length && !r.approvedCourses)
            issues.push('This component has course-pairing rules; import its individual course requirements.');
        if (named(r).length > 1 && /\band\b/i.test(r.text) && !/\bor\b/i.test(r.text) && !r.approvedCourses)
            issues.push('Separate required courses need individual audit rules.');
        if (
            r.approvedCourses &&
            (!r.optionEvidence ||
                !/^https:\/\/[^/]*\.utexas\.edu\//.test(r.optionEvidence.source) ||
                r.optionEvidence.program !== audit.program ||
                r.optionEvidence.catalogYear !== audit.catalogYear ||
                r.optionEvidence.effectiveTerm !== term ||
                now - r.optionEvidence.verifiedAt > 120 * DAY ||
                now < r.optionEvidence.verifiedAt)
        )
            issues.push('Approved options need a current official source for this program and catalog.');
        if (
            r.tags.some(t => t.startsWith('DEPT ')) ||
            (!r.tags.some(t => /^CORE \d{3}$|^COURSE /.test(t)) && !r.approvedCourses)
        )
            issues.push('No verified course options are available for this requirement.');
        if (r.category === 'gpa' || r.category === 'hours')
            issues.push('Aggregate hours, residency and GPA are constraints, not course eligibility.');
        const key = `${r.section}|${r.text}|${required}|${r.tags.slice().sort().join(',')}`;
        if (unique.has(key)) issues.push('Repeated audit rule; capacity is not counted again.');
        unique.add(key);
        if (now < audit.parsedAt || now - audit.parsedAt > 120 * DAY) {
            validity = 'stale';
            issues.push('Import a current audit before relying on degree matches.');
        }
        if (issues.length && validity === 'verified') validity = 'unverified';
        let inProgress = 0,
            importedPlanned = 0,
            pending = 0;
        const seen = new Set<string>();
        for (const c of audit.courses) {
            const id = identity(c.code);
            if (c.equivalent || c.excluded || seen.has(id)) continue;
            if (
                !r.courses.some(code => identity(code) === id) &&
                !matches(r, historySection(c), term, identity, now).length
            )
                continue;
            if (
                c.status === 'in-progress' &&
                !r.courses.some(code => identity(code) === id) &&
                r.tags.some(t => t.startsWith('CORE ')) &&
                audit.requirements.filter(
                    other =>
                        other.tags.some(t => t.startsWith('CORE ')) &&
                        matches(other, historySection(c), term, identity, now).length
                ).length > 1
            ) {
                validity = 'unverified';
                issues.push(
                    'In-progress course could fit multiple core areas; its official allocation needs verification.'
                );
                continue;
            }
            seen.add(id);
            const amount = unit === 'courses' ? 1 : c.hours;
            if (c.status === 'in-progress') inProgress += amount;
            if (c.status === 'planned' && r.courses.some(code => identity(code) === id) && counted > 0)
                importedPlanned += amount;
            if (c.status === 'pending-transfer') pending += amount;
        }
        inProgress = Math.min(required, inProgress);
        importedPlanned = Math.min(required, importedPlanned);
        if (importedPlanned) {
            validity = 'unverified';
            issues.push(
                'The IDA includes planned coursework. Re-run it without planned/future credit to verify current unmet capacity.'
            );
        }
        if (audit.requirements.filter(other => other.id === r.id).length > 1) {
            validity = 'contradictory';
            issues.push('Requirement identifiers are repeated; import a fresh audit.');
        }
        // Included in-progress work is already in the IDA's Counted column. Reserve it exactly once.
        const alreadyCounted =
            audit.included?.inProgress === true ||
            (r.courses.some(code =>
                audit.courses.some(c => c.status === 'in-progress' && identity(c.code) === identity(code))
            ) &&
                counted > 0);
        const remaining = Math.max(0, (rawRemaining ?? 0) - (alreadyCounted ? 0 : inProgress));
        return {
            id: r.id,
            label: r.text,
            tags: r.tags,
            unit,
            required,
            counted: Math.max(0, counted - (alreadyCounted ? inProgress : 0) - importedPlanned),
            inProgress,
            importedPlanned,
            pending,
            remaining,
            planned: 0,
            group: r.tags.some(t => t.startsWith('CORE '))
                ? 'core'
                : policy?.allowCoreMajorSharing && r.category === 'major'
                  ? 'major'
                  : r.optionEvidence
                    ? (r.sharingGroup ?? 'core')
                    : 'core',
            evidence: {
                source: 'Imported UT IDA',
                verifiedAt: audit.parsedAt,
                catalogYear: audit.catalogYear,
                program: audit.program,
                effectiveTerm: term,
                validity,
            },
            issues,
            record: r,
        };
    });
}

export function evaluateDegree(
    audit: ParsedAudit | null,
    sections: SectionRecord[],
    options: DegreeOptions = {}
): DegreeEvaluation {
    const term = options.term || (sections[0] ? semesterKey(sections[0].semester) : '');
    const now = options.now ?? Date.now();
    const rules = degreeRules(audit, { ...options, term });
    const identity = creditIdentity(audit, sections);
    const records = (audit?.courses ?? []).filter(c => !c.equivalent && !c.excluded);
    const have = new Set(records.filter(earnsCredit).map(c => identity(c.code)));
    const current = new Set(records.filter(c => c.status === 'in-progress').map(c => identity(c.code)));
    const policy = currentCore(term)
        ? degreePolicies.policies.find(
              p =>
                  p.programs.some(program => programKey(program) === programKey(audit?.program ?? '')) &&
                  p.catalogYear === audit?.catalogYear
          )
        : undefined;
    const exclusions = currentCore(term) ? degreePolicies.creditExclusions : [];
    const creditKey = (code: string) =>
        exclusions.find(e => e.courses.includes(normalizeCourseCode(code)))?.courses[0] ?? identity(code);
    const alreadyCredited = new Set(
        records.filter(c => earnsCredit(c) || c.status === 'in-progress').map(c => creditKey(c.code))
    );
    const selectedCredit = new Set<string>();
    const seen = new Set<string>();
    const seenIds = new Set<number>();
    const courses: CourseAssessment[] = sections.map(s => {
        const id = identity(s.courseCode);
        let status: CourseAssessment['status'] = 'unverified';
        let explanation = 'Course applicability is unverified; no degree credit is assumed.';
        if (seen.has(id) || seenIds.has(s.uniqueId)) {
            status = 'duplicate-enrollment';
            explanation = 'Another selected section is the same or an equivalent course.';
        } else if (have.has(id) && !s.repeatableForCredit) {
            status = 'duplicate-credit';
            explanation = 'Your record already includes earned credit for this course or its verified equivalent.';
        } else if (current.has(id)) {
            status = 'in-progress';
            explanation = 'Already in progress; successful completion is reserved in your audit plan.';
        } else if (alreadyCredited.has(creditKey(s.courseCode)) || selectedCredit.has(creditKey(s.courseCode))) {
            status = 'duplicate-credit';
            explanation = 'A verified credit-exclusion rule permits credit for only one course in this group.';
        } else if (
            policy &&
            (policy.excludedSubjects.some(sub => normalizeCourseCode(s.courseCode).startsWith(`${sub} `)) ||
                policy.excludedCourses.includes(normalizeCourseCode(s.courseCode)))
        ) {
            status = 'excluded';
            explanation =
                'The verified degree-plan policy excludes this course from degree hours; it may still count as enrollment credit.';
        }
        selectedCredit.add(creditKey(s.courseCode));
        seen.add(id);
        seenIds.add(s.uniqueId);
        return {
            uniqueId: s.uniqueId,
            courseCode: s.courseCode,
            status,
            explanation,
            degreeCredits: 0,
            contributions: [],
            warnings: records.some(c => c.status === 'pending-transfer' && identity(c.code) === id)
                ? ['Pending exam or transfer credit is not posted. Verify official credit before enrolling.']
                : [],
        };
    });
    // One course can be used only once within a sharing group (all Core components share one group).
    // Search each group globally, so flexible alternatives do not consume another course's only slot.
    const groups = [...new Set(rules.filter(r => r.evidence.validity === 'verified').map(r => r.group))];
    for (const group of groups) {
        const available = rules.filter(r => r.group === group && r.evidence.validity === 'verified' && r.remaining > 0);
        let best: Array<[number, number, number, string]> = [],
            bestScore = -1,
            nodes = 0;
        const balances = available.map(r => r.remaining);
        const chosen: Array<[number, number, number, string]> = [];
        const search = (i: number, score: number) => {
            if (++nodes > 30000) return; // conservative: a bounded search may under-assign, never over-assign
            if (i === sections.length) {
                if (score > bestScore) {
                    bestScore = score;
                    best = [...chosen];
                }
                return;
            }
            const s = sections[i]!,
                c = courses[i]!;
            if (c.status === 'unverified' && Number.isFinite(s.creditHours) && s.creditHours > 0) {
                for (let j = 0; j < available.length; j++) {
                    const r = available[j]!,
                        tags = matches(r.record, s, term, identity, now);
                    if (!tags.length || balances[j]! <= 0) continue;
                    const amount = Math.min(balances[j]!, r.unit === 'courses' ? 1 : s.creditHours);
                    balances[j]! -= amount;
                    chosen.push([i, j, amount, tags[0]!]);
                    search(i + 1, score + amount + (r.unit === 'courses' ? s.creditHours : 0));
                    chosen.pop();
                    balances[j]! += amount;
                }
            }
            search(i + 1, score);
        };
        search(0, 0);
        for (const [i, j, amount, tag] of best) {
            const r = available[j]!,
                c = courses[i]!,
                s = sections[i]!;
            r.planned += amount;
            c.contributions.push({ ruleId: r.id, tag, label: r.label, amount, unit: r.unit });
            c.degreeCredits = Math.max(c.degreeCredits, r.unit === 'courses' ? s.creditHours : amount);
        }
    }
    for (const [i, c] of courses.entries()) {
        const s = sections[i]!;
        if (c.contributions.length) {
            c.status = c.contributions.every(x => rules.find(r => r.id === x.ruleId)?.record.kind === 'elective')
                ? 'elective'
                : 'advances';
            c.explanation = `Planned toward ${c.contributions.map(x => `${x.amount} ${x.unit}: ${x.label}`).join('; ')}. Credit is conditional on successful completion.`;
        } else if (c.status === 'unverified') {
            const matching = rules.filter(r => matches(r.record, s, term, identity, now).length);
            if (
                matching.some(r => r.evidence.validity === 'verified') &&
                matching.every(r => r.evidence.validity !== 'verified' || r.remaining - r.planned <= 0)
            ) {
                c.status = 'redundant';
                c.explanation =
                    'This requirement is already satisfied, reserved by in-progress work, or covered by another selected course. Elective credit is unverified.';
            }
            c.warnings.push(...[...new Set(matching.flatMap(r => r.issues))]);
        }
    }
    return {
        rules,
        courses,
        plannedDegreeCredits: courses.reduce((n, c) => n + c.degreeCredits, 0),
        issues: [...new Set(rules.flatMap(r => r.issues))],
    };
}
export function applicableTags(
    audit: ParsedAudit,
    section: SectionRecord,
    options: DegreeOptions = {},
    selected: SectionRecord[] = []
): string[] {
    const result = evaluateDegree(audit, [...selected, section], options).courses.at(-1);
    return result?.contributions.map(c => c.tag) ?? [];
}

/** Compile once per ranking pass; no cached balance survives a record or selected-course change. */
export function createDegreeMatcher(audit: ParsedAudit, options: DegreeOptions = {}, selected: SectionRecord[] = []) {
    const term = options.term ?? coreSnapshot.effectiveTerm;
    const now = options.now ?? Date.now();
    const base = evaluateDegree(audit, selected, { ...options, term });
    const identity = creditIdentity(audit, selected);
    const taken = new Set(recordedCourseCodes(audit).map(identity));
    for (const s of selected) taken.add(identity(s.courseCode));
    const policy = currentCore(term)
        ? degreePolicies.policies.find(
              p =>
                  p.programs.some(program => programKey(program) === programKey(audit.program ?? '')) &&
                  p.catalogYear === audit.catalogYear
          )
        : undefined;
    const exclusions = currentCore(term) ? degreePolicies.creditExclusions : [];
    const codeBlocked = (s: SectionRecord) =>
        policy &&
        (policy.excludedSubjects.some(sub => normalizeCourseCode(s.courseCode).startsWith(`${sub} `)) ||
            policy.excludedCourses.includes(normalizeCourseCode(s.courseCode)));
    return (s: SectionRecord): string[] => {
        if (
            codeBlocked(s) ||
            exclusions.some(
                e =>
                    e.courses.includes(normalizeCourseCode(s.courseCode)) &&
                    e.courses.some(code => taken.has(identity(code)))
            )
        )
            return [];
        if (taken.has(identity(s.courseCode)) && !s.repeatableForCredit) return [];
        return [
            ...new Set(
                base.rules
                    .filter(r => r.evidence.validity === 'verified' && r.remaining - r.planned > 0)
                    .flatMap(r => matches(r.record, s, options.term || semesterKey(s.semester), identity, now))
            ),
        ];
    };
}
