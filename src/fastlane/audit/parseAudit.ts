/**
 * Local parser for UT Interactive Degree Audits (IDA).
 *
 * Structure knowledge (#coursework / #requirements tables, `tr.rule.fulfilled|partial`, details rows,
 * status icon alt text) follows Degree Audit Plus (MIT, Longhorn Developers), adapted to work on a
 * saved HTML file or on text extracted from a PDF, entirely inside the browser.
 *
 * Rules:
 *  - Anything the parser cannot read confidently is marked `confidence: 'low'` with an issue for review.
 *  - Pending transfer credit is NEVER counted as completed. A requirement that depends on pending
 *    transfer work is downgraded to in-progress and flagged.
 */
import { coreCodesInText, coreTag, courseTag, normalizeCourseCode } from '../core/requirements';
import type {
    AuditCourse,
    AuditCourseStatus,
    AuditRequirement,
    Confidence,
    ParsedAudit,
    Progress,
    RequirementCategory,
    RequirementStatus,
} from './types';

const clean = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export function parseProgress(text: string): Progress | undefined {
    const match = clean(text).match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|courses?)?/i);
    if (!match) return undefined;
    return { value: Number(match[1]), unit: /course/i.test(match[2] ?? '') ? 'courses' : 'hours' };
}

const PENDING_PATTERN = /\bpending\b|not yet (?:evaluated|posted|awarded)|awaiting|in process/i;
const RESTRICTION_PATTERN =
    /\b(prerequisite|corequisite|restricted to|must be taken|may not be counted|cannot be counted|consent of|admission to|approval of|in residence)\b/i;

export function classifyCategory(section: string, text: string, tags: string[]): RequirementCategory {
    if (tags.some(t => t.startsWith('CORE')) || /core curriculum/i.test(section)) return 'core';
    if (/\bgpa\b|grade point/i.test(`${section} ${text}`)) return 'gpa';
    if (
        /total hours|upper[- ]division hours|hours in residence|minimum of \d+ (semester )?hours/i.test(
            `${section} ${text}`
        )
    ) {
        return 'hours';
    }
    if (/\bminor\b/i.test(section)) return 'minor';
    if (/general education|general requirements|university requirements|writing flag|global cultures/i.test(section))
        return 'general';
    if (/major|degree|program|certificate|requirements|b\.?a\.?|b\.?s\.?/i.test(section)) return 'major';
    return 'other';
}

function statusFromNumbers(applied?: Progress, remaining?: Progress): RequirementStatus | null {
    if (!remaining || !applied) return null;
    if (remaining.value === 0) return 'completed';
    if (applied.value > 0) return 'in-progress';
    return 'not-started';
}

function finalizeRequirement(
    base: Omit<AuditRequirement, 'tags' | 'category' | 'confidence' | 'issues' | 'status'> & { issues?: string[] },
    statusFromMarkup: RequirementStatus | null,
    pendingCourseCodes: Set<string>,
    baseConfidence: Confidence
): AuditRequirement {
    const tags = coreCodesInText(base.text).map(coreTag);
    // Named courses are recommendation candidates; OR/AND and applicability still require audit review.
    for (const match of base.text.matchAll(/\b([A-Z][A-Z ]{0,5})\s+(\d{3}[A-Z]{0,2})\b/g)) {
        tags.push(courseTag(`${match[1]} ${match[2]}`));
    }
    const issues = [...(base.issues ?? [])];
    let confidence: Confidence = baseConfidence;
    const numeric = statusFromNumbers(base.applied, base.remaining);
    let status = statusFromMarkup ?? numeric ?? 'not-started';
    if (!statusFromMarkup && !numeric) {
        confidence = 'low';
        issues.push('Could not read the completion status');
    } else if (statusFromMarkup && numeric && statusFromMarkup !== numeric) {
        // never call something complete unless both agree
        status = statusFromMarkup === 'completed' || numeric === 'completed' ? 'in-progress' : numeric;
        confidence = 'low';
        issues.push(`Status (${statusFromMarkup}) disagrees with the hours shown (${numeric})`);
    } else if (!statusFromMarkup && numeric) {
        confidence = confidence === 'high' ? 'medium' : confidence;
    }
    if (!base.required) {
        confidence = confidence === 'high' ? 'medium' : confidence;
        issues.push('Required amount not shown');
    }
    const relying = base.courses.filter(c => pendingCourseCodes.has(normalizeCourseCode(c)));
    if (relying.length) {
        if (status === 'completed') status = 'in-progress';
        confidence = 'low';
        issues.push(`Relies on pending transfer credit (${relying.join(', ')}) — not counted until awarded`);
    }
    return { ...base, status, tags, category: classifyCategory(base.section, base.text, tags), confidence, issues };
}

function courseStatusFromCell(cell: Element | undefined, type: string, grade: string, school = ''): AuditCourseStatus {
    const icons = [...(cell?.querySelectorAll('img') ?? [])].map(i => i.getAttribute('alt') ?? '');
    if (PENDING_PATTERN.test(`${type} ${grade}`)) return 'pending-transfer';
    if (icons.some(a => /in progress/i.test(a))) return 'in-progress';
    if (icons.some(a => /planned|future/i.test(a)) || /^plan$/i.test(school)) return 'planned';
    // a course on the record without a grade yet is one the student is taking now
    if (!grade) return 'in-progress';
    return 'completed';
}

function parseCourseRows(doc: Document): AuditCourse[] {
    const table = doc.querySelector('#coursework table.results');
    if (!table) return [];
    const courses: AuditCourse[] = [];
    let semester = '';
    let excludedSection = false;
    for (const row of table.querySelectorAll('tr')) {
        const header = row.querySelector('th.section_title');
        if (header) {
            const title = clean(header.textContent);
            excludedSection = /excluded/i.test(title);
            semester = title.replace(/\s*courses?$/i, '');
            continue;
        }
        if (excludedSection) continue;
        const cells = [...row.querySelectorAll(':scope > td')];
        if (cells.length < 6) continue;
        const code = normalizeCourseCode(clean(cells[0]!.textContent));
        if (!/\d/.test(code)) continue;
        const type = clean(cells[4]!.textContent);
        const grade = clean(cells[2]!.textContent);
        const unique = clean(cells[3]!.textContent);
        const school = clean(cells[6]?.textContent);
        const hoursText = clean(cells[5]!.textContent);
        const status: AuditCourseStatus = /pending/i.test(semester)
            ? 'pending-transfer'
            : courseStatusFromCell(cells[0], type, grade, school);
        courses.push({
            code,
            name: clean(cells[1]!.textContent),
            grade,
            unique,
            type,
            hours: Number(hoursText.match(/\d+(\.\d+)?/)?.[0] ?? 0),
            semester,
            status,
            // UT lists equivalent and cross-listed numbers under each real course with unique 00000
            // (planned courses have no unique number yet, so they are not equivalents)
            ...(/^0+$/.test(unique) && status !== 'planned' ? { equivalent: true } : {}),
            // hours shown as "- 3" are excluded from the degree ("Total Hours Excluded")
            ...(/^-/.test(hoursText) ? { excluded: true } : {}),
        });
    }
    return courses;
}

/** The IDA's "Included Courses" checkboxes: whether its counted hours include in-progress, future, planned. */
function readIncluded(doc: Document): ParsedAudit['included'] {
    const box = doc.querySelector('#crswk_included, .included-courses-section');
    if (!box) return undefined;
    const flag = (label: RegExp) =>
        [...box.querySelectorAll('div')].some(
            d => label.test(d.textContent ?? '') && !!d.querySelector('input[type=checkbox][checked]')
        );
    return { inProgress: flag(/in progress/i), future: flag(/future/i), planned: flag(/planned/i) };
}

/** "Total Hours Taken: 85", "Total Hours Excluded: 3" printed under the IDA's course list. */
function readHourTotals(doc: Document): ParsedAudit['hourTotals'] {
    const text = clean(doc.querySelector('#coursework')?.textContent);
    const taken = text.match(/Total Hours Taken:\s*(\d+(?:\.\d+)?)/i)?.[1];
    const excluded = text.match(/Total Hours Excluded:\s*(\d+(?:\.\d+)?)/i)?.[1];
    if (!taken && !excluded) return undefined;
    return {
        ...(taken ? { taken: Number(taken) } : {}),
        ...(excluded ? { excluded: Number(excluded) } : {}),
    };
}

function splitTransfer(courses: AuditCourse[]): ParsedAudit['transfer'] {
    const transferish = courses.filter(c => /transfer/i.test(c.type) || c.status === 'pending-transfer');
    return {
        accepted: transferish.filter(c => c.status !== 'pending-transfer'),
        pending: transferish.filter(c => c.status === 'pending-transfer'),
    };
}

function collectRestrictions(texts: string[]): string[] {
    const out = new Set<string>();
    for (const text of texts) {
        for (const sentence of text.split(/(?<=[.;])\s+/)) {
            const s = clean(sentence);
            if (s.length > 12 && s.length < 400 && RESTRICTION_PATTERN.test(s)) out.add(s);
        }
    }
    return [...out];
}

function deriveCreditHours(reqs: AuditRequirement[]): ParsedAudit['creditHours'] {
    const total = reqs.find(
        r => r.category === 'hours' && /total|minimum of \d+/i.test(r.text) && r.required?.unit !== 'courses'
    );
    if (!total) return { confidence: 'low' };
    return {
        required: total.required?.value,
        applied: total.applied?.value,
        remaining: total.remaining?.value,
        confidence: total.confidence,
    };
}

/** Parses an IDA results page (live DOM or a saved .html file loaded with DOMParser). */
/** UT's progress widget contains both an expected-progress marker and an actual completion
 * number. Read only the latter; never confuse the expected marker with degree completion. */
export function readOfficialIdaProgress(doc: Document): ParsedAudit['officialProgress'] {
    const widget = doc.querySelector('#progress_summary');
    if (!widget) return undefined;
    const displayed = clean(widget.querySelector('.progress_number')?.textContent);
    const match = displayed.match(/^(100|[1-9]?\d)\s*%?$/);
    if (match) return { percent: Number(match[1]), source: 'ida-html' };
    const actualBar = [...widget.querySelectorAll('img[alt]')]
        .map(img => img.getAttribute('alt') ?? '')
        .find(text => /^(100|[1-9]?\d)\s*%\s*complete$/i.test(text.trim()));
    const barMatch = actualBar?.trim().match(/^(100|[1-9]?\d)\s*%\s*complete$/i);
    return barMatch ? { percent: Number(barMatch[1]), source: 'ida-html' } : undefined;
}

export function parseAuditHtml(doc: Document, fileName?: string, now = Date.now()): ParsedAudit {
    const warnings: string[] = [];
    const courses = parseCourseRows(doc);
    if (!doc.querySelector('#coursework')) warnings.push('No coursework table found; course history may be missing.');
    const transfer = splitTransfer(courses);
    const pendingCodes = new Set(transfer.pending.map(c => normalizeCourseCode(c.code)));
    const requirements: AuditRequirement[] = [];
    const sections = [...doc.querySelectorAll('#requirements table.results')];
    if (sections.length === 0)
        warnings.push('No requirement tables found. Is this an Interactive Degree Audit results page?');

    sections.forEach((table, tableIndex) => {
        const titleTh = table.querySelector('thead th.section_title');
        const section = clean(titleTh?.querySelector('a')?.textContent || titleTh?.textContent) || 'Requirements';
        for (const body of table.querySelectorAll('tbody.section')) {
            const rows = [...body.querySelectorAll(':scope > tr')];
            rows.forEach((row, i) => {
                if (!row.classList.contains('rule')) return;
                const cells = [...row.querySelectorAll(':scope > td')];
                if (cells.length < 6) return;
                const text = clean(cells[2]!.textContent);
                const statusFromMarkup: RequirementStatus = row.classList.contains('fulfilled')
                    ? 'completed'
                    : row.classList.contains('partial')
                      ? 'in-progress'
                      : 'not-started';
                const details = rows[i + 1]?.classList.contains('details') ? rows[i + 1] : undefined;
                const appliedCourses = details
                    ? [...details.querySelectorAll('table tbody tr')]
                          .map(r => normalizeCourseCode(clean(r.querySelector('td')?.textContent)))
                          .filter(c => /\d/.test(c))
                    : [];
                requirements.push(
                    finalizeRequirement(
                        {
                            id: `html-${tableIndex}-${i}`,
                            section,
                            text,
                            required: parseProgress(cells[3]!.textContent ?? ''),
                            applied: parseProgress(cells[4]!.textContent ?? ''),
                            remaining: parseProgress(cells[5]!.textContent ?? ''),
                            courses: [...new Set(appliedCourses)],
                        },
                        statusFromMarkup,
                        pendingCodes,
                        'high'
                    )
                );
            });
        }
    });

    const program = clean(doc.querySelector('#audit_title, .audit_title, h1')?.textContent) || undefined;
    return {
        source: 'html',
        fileName,
        parsedAt: now,
        program,
        requirements,
        officialProgress: readOfficialIdaProgress(doc),
        courses,
        transfer,
        creditHours: deriveCreditHours(requirements),
        hourTotals: readHourTotals(doc),
        included: readIncluded(doc),
        catalogYear: clean(doc.body?.textContent).match(/\bcatalog(?: year)?:?\s*(20\d\d(?:\s*-\s*20?\d\d)?)/i)?.[1],
        restrictions: collectRestrictions(requirements.map(r => r.text)),
        warnings,
    };
}

/**
 * Parses text lines extracted from a PDF print of the IDA. PDFs lose the status icons, so status is
 * derived from the Required / Counted / Lacking numbers and every item is at most medium confidence.
 */
export function parseAuditText(lines: string[], fileName?: string, now = Date.now()): ParsedAudit {
    const warnings = [
        'Parsed from PDF text: completion icons are not available, so statuses come from the hours columns. Please review.',
    ];
    const courses: AuditCourse[] = [];
    const requirements: AuditRequirement[] = [];
    let semester = '';
    let section = 'Requirements';
    let mode: 'none' | 'coursework' | 'requirements' = 'none';
    let pendingSection = false;
    let buffer: string[] = [];

    const courseLine =
        /^(?:(in progress|planned|future)\s+)?([A-Z][A-Z ]{0,6}?)\s+([FSNW]?\d{3}[A-Z]{0,2})\s+(.+?)\s+(?:([A-F][+-]?|CR|NC|P|F|IP|PEND\w*)\s+)?(\d{5})?\s*(In-Residence|Transfer(?: pending)?|Pending Transfer|Credit By Exam)\s+(\d+(?:\.\d+)?)\b/i;
    const ruleNumbers =
        /(\d+(?:\.\d+)?)\s*(hours?|courses?)\s+(\d+(?:\.\d+)?)\s*(hours?|courses?)\s+(\d+(?:\.\d+)?)\s*(hours?|courses?)\s*(.*)$/i;

    const flushRule = (numbersMatch: RegExpMatchArray, head: string) => {
        const text = clean([...buffer, head].join(' '))
            .replace(/^\d+\s+/, '')
            .replace(/^(completed|not completed|partially completed|done)\s+/i, '');
        buffer = [];
        if (!text) return;
        const unit = (s: string) => (/course/i.test(s) ? 'courses' : 'hours') as Progress['unit'];
        const courseList = [...(numbersMatch[7] ?? '').matchAll(/\b([A-Z][A-Z ]{0,5}?)\s+(\d{3}[A-Z]?)\b/g)].map(m =>
            normalizeCourseCode(`${m[1]} ${m[2]}`)
        );
        requirements.push(
            finalizeRequirement(
                {
                    id: `pdf-${requirements.length}`,
                    section,
                    text,
                    required: { value: Number(numbersMatch[1]), unit: unit(numbersMatch[2]!) },
                    applied: { value: Number(numbersMatch[3]), unit: unit(numbersMatch[4]!) },
                    remaining: { value: Number(numbersMatch[5]), unit: unit(numbersMatch[6]!) },
                    courses: courseList,
                    issues: ['Status inferred from hours (PDF has no status icons)'],
                },
                null,
                new Set(courses.filter(c => c.status === 'pending-transfer').map(c => c.code)),
                'medium'
            )
        );
    };

    for (const rawLine of lines) {
        const line = clean(rawLine);
        if (!line) continue;
        const semesterHeader = line.match(/^((?:Spring|Summer|Fall)\s+\d{4})\s+Courses?$/i);
        if (semesterHeader) {
            mode = 'coursework';
            semester = semesterHeader[1]!;
            pendingSection = false;
            continue;
        }
        if (/^(pending transfer|transfer credit pending)/i.test(line)) {
            mode = 'coursework';
            pendingSection = true;
            semester = 'Pending transfer';
            continue;
        }
        if (/^classes excluded from audit/i.test(line)) {
            mode = 'none';
            continue;
        }
        if (/^#?\s*Done\s+Requirement\s+Required/i.test(line)) {
            mode = 'requirements';
            buffer = [];
            continue;
        }
        if (mode === 'coursework') {
            const m = line.match(courseLine);
            if (m) {
                const type = m[7]!;
                const grade = m[5] ?? '';
                const pending = pendingSection || PENDING_PATTERN.test(`${type} ${grade}`);
                const iconWord = (m[1] ?? '').toLowerCase();
                courses.push({
                    code: normalizeCourseCode(`${m[2]} ${m[3]}`),
                    name: clean(m[4]),
                    grade,
                    unique: m[6] ?? '',
                    type: /transfer/i.test(type) ? 'Transfer' : type,
                    hours: Number(m[8]),
                    semester,
                    status: pending
                        ? 'pending-transfer'
                        : iconWord === 'in progress'
                          ? 'in-progress'
                          : iconWord
                            ? 'planned'
                            : 'completed',
                });
                continue;
            }
        }
        // a requirement section title usually stands alone, e.g. "Core Curriculum (42 hours required ...)"
        if (
            /^(core curriculum|major requirements|.*requirements\b.*|total hours.*|gpa.*)$/i.test(line) &&
            !ruleNumbers.test(line)
        ) {
            if (mode !== 'coursework' || /core curriculum|requirements/i.test(line)) {
                section = line.replace(/\s*\(.*\)$/, '');
                mode = 'requirements';
                buffer = [];
                continue;
            }
        }
        if (mode === 'requirements') {
            const m = line.match(ruleNumbers);
            if (m) {
                const head = line.slice(0, m.index).trim();
                flushRule(m, head);
            } else if (line.length < 400) {
                buffer.push(line);
                if (buffer.length > 6) buffer.shift();
            }
        }
    }

    if (requirements.length === 0)
        warnings.push('No requirements could be read from this PDF. Try saving the audit page as HTML instead.');
    const transfer = splitTransfer(courses);
    const explicit = lines.map(line => clean(line).match(/^(100|[1-9]?\d)\s*%\s*complete$/i)).find(Boolean);
    return {
        source: 'pdf',
        officialProgress: explicit ? { percent: Number(explicit[1]), source: 'ida-pdf' } : undefined,
        fileName,
        parsedAt: now,
        requirements,
        courses,
        transfer,
        creditHours: deriveCreditHours(requirements),
        restrictions: collectRestrictions(requirements.map(r => r.text)),
        warnings,
    };
}

/** Requirement tags that are still outstanding (anything not completed). */
export function outstandingTags(audit: ParsedAudit): string[] {
    const tags: string[] = [];
    for (const r of audit.requirements) {
        if (r.status === 'completed') continue;
        for (const t of r.tags) if (!tags.includes(t)) tags.push(t);
    }
    return tags;
}

/** Course codes the student has completed or is taking (excluding pending transfer). */
export function takenCourseCodes(audit: ParsedAudit): string[] {
    return [
        ...new Set(audit.courses.filter(c => c.status === 'completed' || c.status === 'in-progress').map(c => c.code)),
    ];
}

/** Applies a student's correction from the review screen. */
export function correctRequirement(
    audit: ParsedAudit,
    id: string,
    patch: Partial<Pick<AuditRequirement, 'status' | 'tags' | 'category' | 'text'>>
): ParsedAudit {
    return {
        ...audit,
        requirements: audit.requirements.map(r =>
            r.id === id ? { ...r, ...patch, reviewed: true, confidence: 'high' as const } : r
        ),
    };
}

export function confirmRequirement(audit: ParsedAudit, id: string): ParsedAudit {
    return {
        ...audit,
        requirements: audit.requirements.map(r => (r.id === id ? { ...r, reviewed: true } : r)),
    };
}

export function needsReview(audit: ParsedAudit): AuditRequirement[] {
    return audit.requirements.filter(r => !r.reviewed && r.confidence !== 'high');
}
