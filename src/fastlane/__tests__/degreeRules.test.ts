import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { correctRequirement, parseAuditHtml, takenCourseCodes } from '../audit/parseAudit';
import { academicSummary } from '../core/academic';
import { shortlistAiCandidates } from '../core/aiCandidates';
import { applicableTags, createDegreeMatcher, creditIdentity, degreeRules, evaluateDegree } from '../core/degreeRules';
import { confirmedAuditHours, DEFAULT_FILTERS, matchesFilters, roadmapProjection } from '../core/planning';
import { validatePlan } from '../core/planValidator';
import { checkPrerequisites, prerequisiteEligibility, subjectNameIndex } from '../core/prerequisites';
import { recommend } from '../core/recommend';
import { type ScheduleConstraints, solveSchedule } from '../core/scheduleSolver';
import { audit, NOW, record, rule, section, spring2027, TERM } from './fixtures/spring2027-degree';

const opts = { term: TERM, now: NOW };
const music = () => section(1, 'MUS 302L');
const theatre = () => section(2, 'T D 301');
const science = () => section(3, 'AST 301');
const otherScience = () => section(4, 'BIO 311C');
const constraints: ScheduleConstraints = {
    minCredits: 0,
    maxCredits: 18,
    creditsRequested: true,
    avoidDays: [],
    excludedSubjects: [],
    excludedTitleWords: [],
    excludedCourses: [],
    term: TERM,
    online: null,
    backToBack: false,
    checkTravel: false,
};
const source = {
    source: 'https://catalog.utexas.edu/general-information/academic-policies-and-procedures/core-curriculum/',
    verifiedAt: NOW,
    program: 'BA Economics',
    catalogYear: '2026-2028',
    effectiveTerm: TERM,
};
const evaluate = (a: ReturnType<typeof audit>, sections: ReturnType<typeof section>[]) =>
    evaluateDegree(a, sections, opts);

describe('deterministic remaining degree capacity', () => {
    it('no prior credit: a verified arts course advances three planned hours, never earned completion', () => {
        const a = audit(),
            out = evaluate(a, [music()]);
        expect(out.courses[0]).toMatchObject({ status: 'advances', degreeCredits: 3 });
        expect(out.rules[0]).toMatchObject({ counted: 0, remaining: 3, planned: 3 });
        expect(a.requirements[0]?.status).toBe('not-started');
    });
    it('completed single-slot requirements do not acquire new capacity', () =>
        expect(evaluate(audit([rule('CORE 050', 3, 3)]), [music()]).courses[0]?.status).toBe('redundant'));
    it('two different arts courses cannot each spend the same three-hour requirement', () => {
        const out = evaluate(audit(), [theatre(), music()]);
        expect(out.plannedDegreeCredits).toBe(3);
        expect(out.courses.map(c => c.status)).toEqual(['advances', 'redundant']);
    });
    it('a six-hour science rule still has three hours after one course', () => {
        const r = evaluate(audit([rule('CORE 030', 6)]), [science()]).rules[0]!;
        expect(r.remaining - r.planned).toBe(3);
    });
    it('a second distinct science course may fill the remaining three hours', () => {
        const out = evaluate(audit([rule('CORE 030', 6)]), [science(), otherScience()]);
        expect(out.plannedDegreeCredits).toBe(6);
        expect(out.courses.every(c => c.status === 'advances')).toBe(true);
    });
    it('pending CLEP is neither earned nor counted as completion', () => {
        const a = audit(
            [rule('CORE 080')],
            [record('ECO 304L', 'pending-transfer', { type: 'Credit By Exam; score 64' })]
        );
        expect(evaluate(a, [section(9, 'EDC 312')]).courses[0]?.status).toBe('advances');
        expect(academicSummary(a).completedHours).toBe(0);
        expect(evaluate(a, []).rules[0]?.pending).toBe(3);
    });
    it('officially posted CLEP uses the audit balance and prevents duplicate credit', () => {
        const a = audit(
            [rule('CORE 080', 3, 3)],
            [record('ECO 304L', 'completed', { grade: 'CR', type: 'Credit By Exam' })]
        );
        expect(academicSummary(a).examHours).toBe(3);
        expect(evaluate(a, [section(9, 'EDC 312')]).courses[0]?.status).toBe('redundant');
        expect(evaluate(a, [section(8, 'ECO 304L')]).courses[0]?.status).toBe('duplicate-credit');
    });
    it.each([
        'AP',
        'IB',
        'Dual Enrollment Transfer',
        'Credit By Exam',
        'Community College Transfer',
    ])('accepted %s credit stays posted without duplicate hours', type => {
        const c = record('E 316L', 'completed', { type, grade: 'CR' });
        const a = audit([rule('CORE 040', 3, 3)], [c, { ...c, code: 'ENGL 2323', equivalent: true, unique: '00000' }]);
        expect(academicSummary(a).completedHours).toBe(3);
        expect(evaluate(a, [section(8, 'ENGL 2323')]).courses[0]?.status).toBe('duplicate-credit');
    });
    it('a real repeat attempt does not award duplicate degree credit', () => {
        const a = audit(
            [],
            [record('ECO 304K'), record('ECO 304K', 'completed', { semester: 'Spring 2026', unique: '12346' })]
        );
        expect(academicSummary(a).completedHours).toBe(3);
        expect(confirmedAuditHours(a)).toBe(3);
    });
    it('failed/excluded records do not block a legitimate retake', () => {
        const a = audit(
            [rule('COURSE ECO 304K')],
            [record('ECO 304K', 'completed', { grade: 'F' }), record('MUS 302L', 'completed', { excluded: true })]
        );
        expect(takenCourseCodes(a)).toEqual([]);
        expect(applicableTags(a, section(7, 'ECO 304K'), opts)).toEqual(['COURSE ECO 304K']);
    });
    it('reserves ECO 304K in progress, so EDC 312 does not add another Core 080', () => {
        const a = audit([rule('CORE 080')], [record('ECO 304K', 'in-progress')]);
        expect(evaluate(a, [section(8, 'EDC 312')]).courses[0]?.status).toBe('redundant');
        expect(degreeRules(a, opts)[0]).toMatchObject({ counted: 0, inProgress: 3, remaining: 0 });
    });
    it('does not subtract in-progress credit twice when the IDA already includes it', () => {
        const a = audit(
            [rule('CORE 080', 3, 3, { status: 'in-progress', courses: ['ECO 304K'] })],
            [record('ECO 304K', 'in-progress')]
        );
        a.included = { inProgress: true, future: false, planned: false };
        expect(degreeRules(a, opts)[0]).toMatchObject({ counted: 0, inProgress: 3, remaining: 0 });
    });
    it('ambiguous in-progress science allocation stays unverified rather than spending it twice', () => {
        const a = audit([rule('CORE 030', 6), rule('CORE 093')], [record('AST 301', 'in-progress')]);
        const out = evaluate(a, [otherScience()]);
        expect(out.plannedDegreeCredits).toBe(0);
        expect(out.rules.every(r => r.evidence.validity === 'unverified' && r.inProgress === 0)).toBe(true);
    });
    it('changed major invalidates old-plan matches', () =>
        expect(evaluateDegree(audit(), [music()], { ...opts, program: 'BBA Finance' }).plannedDegreeCredits).toBe(0));
    it('changed catalog invalidates old-plan matches', () =>
        expect(evaluateDegree(audit(), [music()], { ...opts, catalogYear: '2028-2030' }).plannedDegreeCredits).toBe(0));
    it('add/remove always recomputes capacity without mutating the imported record', () => {
        const a = audit(),
            before = JSON.stringify(a);
        expect(evaluate(a, [music(), theatre()]).plannedDegreeCredits).toBe(3);
        expect(evaluate(a, []).plannedDegreeCredits).toBe(0);
        expect(evaluate(a, [theatre()]).courses[0]?.status).toBe('advances');
        expect(JSON.stringify(a)).toBe(before);
    });
    it.each([
        'missing',
        'stale',
        'contradictory',
        'manual',
        'pdf',
    ] as const)('%s data cannot silently become confirmed applicability', kind => {
        const a = audit();
        if (kind === 'missing') a.requirements[0]!.remaining = undefined;
        if (kind === 'stale') a.parsedAt = NOW - 121 * 86400000;
        if (kind === 'contradictory') a.requirements[0]!.remaining!.value = 8;
        if (kind === 'manual') a.requirements[0]!.manuallyChanged = true;
        if (kind === 'pdf') a.source = 'pdf';
        expect(evaluate(a, [music()]).plannedDegreeCredits).toBe(0);
    });
    it('all core complete means no additional core recommendations', () => {
        const a = audit(['020', '030', '040', '050', '060', '080', '090', '093'].map(c => rule(`CORE ${c}`, 3, 3)));
        expect(createDegreeMatcher(a, opts)(music())).toEqual([]);
        expect(evaluate(a, [music(), science()]).plannedDegreeCredits).toBe(0);
    });
    it('an explicitly approved elective contributes to elective hours, not already-completed core', () => {
        const a = audit([
            rule('CORE 050', 3, 3),
            rule('ELECTIVE', 3, 0, {
                kind: 'elective',
                category: 'general',
                approvedCourses: ['MUS 302L'],
                optionEvidence: source,
            }),
        ]);
        const c = evaluate(a, [music()]).courses[0]!;
        expect(c.status).toBe('elective');
        expect(c.contributions.map(c => c.tag)).toEqual(['ELECTIVE']);
    });
    it('a department tag is never proof of an elective or major requirement', () =>
        expect(evaluate(audit([rule('DEPT MUS')]), [music()]).courses[0]?.status).toBe('unverified'));
    it('a course can fill core plus a separately approved major requirement while hours count once', () => {
        const a = audit([
            rule('CORE 080'),
            rule('COURSE ECO 304L', 3, 0, {
                category: 'major',
                approvedCourses: ['ECO 304L'],
                optionEvidence: source,
                sharingGroup: 'major',
            }),
        ]);
        const out = evaluate(a, [section(5, 'ECO 304L')]);
        expect(out.courses[0]?.contributions).toHaveLength(2);
        expect(out.plannedDegreeCredits).toBe(3);
    });
    it('one science course cannot count in both core components', () => {
        const out = evaluate(audit([rule('CORE 030', 6), rule('CORE 093')]), [science()]);
        expect(out.courses[0]?.contributions).toHaveLength(1);
        expect(out.plannedDegreeCredits).toBe(3);
    });
    it('equivalent and cross-listed sections are duplicate enrollment, not extra degree progress', () => {
        const out = evaluate(audit([rule('CORE 050')]), [
            music(),
            section(7, 'F A 999', { equivalentCodes: ['MUS 302L'] }),
        ]);
        expect(out.courses[1]?.status).toBe('duplicate-enrollment');
        expect(out.plannedDegreeCredits).toBe(3);
    });
    it('repeated identical requirement rows do not create new slots', () => {
        const a = audit([rule('CORE 050'), rule('CORE 050', 3, 0, { id: 'copy' })]);
        expect(evaluate(a, [music(), theatre()]).plannedDegreeCredits).toBe(3);
    });
    it('source term expires: a 2026 snapshot does not certify an unknown 2029 section', () => {
        const s = music();
        s.capturedAt = 0;
        s.semester = { season: 'Spring', year: 2029 };
        expect(evaluateDegree(audit(), [s], { ...opts, term: 'Spring 2029' }).plannedDegreeCredits).toBe(0);
    });
    it('contradictory official listing/core snapshot is unverified', () =>
        expect(evaluate(audit(), [{ ...music(), core: ['CORE 030'] }]).plannedDegreeCredits).toBe(0));
    it('unrecognized course and arbitrary AI tags do not establish applicability', () =>
        expect(
            evaluate(audit(), [section(8, 'XYZ 301', { requirementTags: ['CORE 050'], title: 'Music and Theatre' })])
                .plannedDegreeCredits
        ).toBe(0));
    it('a saved correction does not masquerade as university verification', () => {
        const a = audit();
        const changed = correctRequirement(a, 'CORE 050', { status: 'not-started' });
        expect(changed.requirements[0]?.manuallyChanged).toBe(true);
        expect(evaluate(changed, [music()]).plannedDegreeCredits).toBe(0);
    });
});

describe('recommendation and independent schedule gates', () => {
    it('selected theatre removes redundant music from the next recommendation pass', () => {
        const a = audit();
        expect(createDegreeMatcher(a, opts, [theatre()])(music())).toEqual([]);
        expect(createDegreeMatcher(a, opts, [])(music())).toEqual(['CORE 050']);
    });
    it('revalidates a forged AI/cached candidate against the current audit, not its claimed tag', async () => {
        const a = audit([rule('CORE 050', 3, 3)]);
        const out = await solveSchedule(
            [{ section: music(), score: 100, applies: ['CORE 050'], prerequisite: 'none' }],
            { ...constraints, minCredits: 3 },
            { audit: a }
        );
        expect(out.best).toBeNull();
        const report = validatePlan(
            [music()],
            { ...constraints, coreOnly: true },
            { audit: a, auditAvailable: true, applies: () => ['CORE 050'], catalog: [music()], now: NOW }
        );
        expect(report.hardOk).toBe(false);
        expect(report.allRulesMet).toBe(false);
    });
    it('does not pad a target schedule with redundant arts or unrelated electives', async () => {
        const list = [music(), theatre(), section(8, 'XYZ 301')];
        const out = await solveSchedule(
            list.map(s => ({ section: s, score: 10, applies: ['CORE 050'], prerequisite: 'none' as const })),
            { ...constraints, minCredits: 6 },
            { audit: audit() }
        );
        expect(out.best).toBeNull();
    });
    it('solver accepts two science courses when six verified hours remain', async () => {
        const list = [science(), otherScience()];
        const out = await solveSchedule(
            list.map(s => ({ section: s, score: 10, applies: ['CORE 030'], prerequisite: 'none' as const })),
            { ...constraints, minCredits: 6, coreOnly: true },
            { audit: audit([rule('CORE 030', 6)]) }
        );
        expect(out.best?.credits).toBe(6);
    });
    it('candidate ranking uses real balances and does not trust an LLM department hint', () => {
        const input = {
            sections: [music(), theatre()],
            audit: audit([rule('CORE 050', 3, 3)]),
            term: TERM,
            taken: [],
            outstanding: ['CORE 050'],
            active: [],
            avoidFriday: false,
            preferAsync: false,
            subjectIndex: [],
        };
        expect(shortlistAiCandidates(input).every(x => !x.applies.length)).toBe(true);
    });
    it('recommendations exclude wrong semesters even when they carry a matching tag', () => {
        const s = music();
        s.semester = { season: 'Spring', year: 2028 };
        s.requirementTags = ['CORE 050'];
        expect(recommend({ requirements: ['CORE 050'], catalog: [s], semester: TERM, activeSchedule: [] })).toEqual([]);
    });
    it('missing prerequisite AND group is unmet even if a different group is satisfied', () => {
        const index = subjectNameIndex([
            { code: 'ECO', name: 'Economics' },
            { code: 'M', name: 'Mathematics' },
        ]);
        expect(checkPrerequisites('Economics 304K and Mathematics 408Q', ['ECO 304K'], index).status).toBe('unmet');
        expect(
            checkPrerequisites('Economics 304K', ['ECO 304K'], index, [record('ECO 304K', 'in-progress')]).status
        ).toBe('check');
        expect(checkPrerequisites('Economics 304K; admission to the program', ['ECO 304K'], index).status).toBe(
            'check'
        );
    });
    it('overlapping lab meetings are detected even when lectures do not overlap', () => {
        const a = music(),
            b = theatre();
        a.modality = b.modality = 'in-person';
        a.meetings = [
            { days: ['T'], start: 540, end: 600 },
            { days: ['W'], start: 780, end: 840 },
        ];
        b.meetings = [
            { days: ['T'], start: 660, end: 720 },
            { days: ['W'], start: 800, end: 860 },
        ];
        expect(
            validatePlan([a, b], constraints, {
                applies: () => [],
                auditAvailable: false,
                catalog: [a, b],
                now: NOW,
            }).failures.join(' ')
        ).toContain('overlaps');
    });
    it('partial required meeting data cannot produce an all-clear schedule', () => {
        const s = {
            ...music(),
            modality: 'in-person' as const,
            scheduleComplete: false,
            meetings: [{ days: ['T' as const], start: 540, end: 600 }],
        };
        expect(
            validatePlan([s], constraints, { applies: () => [], auditAvailable: false, catalog: [s], now: NOW }).hardOk
        ).toBe(false);
    });
    it('arranged/Other is not silently interpreted as asynchronous', () => {
        const s = { ...music(), modality: 'unknown' as const, scheduleComplete: false };
        expect(
            validatePlan([s], constraints, { applies: () => [], auditAvailable: false, catalog: [s], now: NOW }).hardOk
        ).toBe(false);
    });
    it('back-to-back classes may pass overlap checks but fail a known walking time', () => {
        const a = {
            ...music(),
            modality: 'in-person' as const,
            meetings: [{ days: ['T' as const], start: 540, end: 600, location: 'RLM 1.1' }],
        };
        const b = {
            ...theatre(),
            modality: 'in-person' as const,
            meetings: [{ days: ['T' as const], start: 600, end: 660, location: 'UTC 1.1' }],
        };
        const out = validatePlan(
            [a, b],
            { ...constraints, checkTravel: true },
            { applies: () => [], auditAvailable: false, catalog: [a, b], now: NOW, travel: () => 15 }
        );
        expect(out.checks.find(c => c.id === 'overlap')?.status).toBe('pass');
        expect(out.checks.find(c => c.id === 'travel')?.status).toBe('fail');
    });
    it('day-specific restrictions are independently rechecked after optimization', () => {
        const s = {
            ...music(),
            modality: 'in-person' as const,
            meetings: [{ days: ['F' as const], start: 780, end: 840 }],
        };
        expect(
            validatePlan(
                [s],
                { ...constraints, dayLimits: { F: { to: 720 } } },
                { applies: () => [], auditAvailable: false, catalog: [s], now: NOW }
            ).hardOk
        ).toBe(false);
    });
    it('roadmap deduplicates accepted aliases and classes already in progress', () => {
        const a = audit(
            [],
            [
                record('E 316L'),
                record('ENGL 2323', 'completed', { equivalent: true }),
                record('ECO 304K', 'in-progress'),
            ]
        );
        expect(
            roadmapProjection(
                [
                    { id: '1', term: TERM, code: 'ENGL 2323', hours: 3, kind: 'transfer', rule: '' },
                    { id: '2', term: TERM, code: 'ECO 304K', hours: 3, kind: 'course', rule: '' },
                ],
                a
            ).planned
        ).toBe(0);
    });
    it('reads actual degree program/catalog markup and stable IDs without private identity fields', () => {
        const doc = new DOMParser().parseFromString(
            readFileSync(resolve(__dirname, 'fixtures/dap-audit-results-real.html'), 'utf8'),
            'text/html'
        );
        const a = parseAuditHtml(doc, undefined, NOW);
        expect(a.program).toBe('B S Computer Science, CS');
        expect(a.catalogYear).toBe('2024-2026');
        const ids = a.requirements.map(r => r.id);
        doc.querySelector('#requirements')?.prepend(doc.createElement('table'));
        expect(parseAuditHtml(doc, undefined, NOW).requirements.map(r => r.id)).toEqual(ids);
        expect(JSON.stringify(a)).not.toContain('xy12345');
    });
});

describe('allocation invariants across varied requirement capacities', () => {
    for (let capacity = 0; capacity <= 12; capacity++)
        it(`capacity ${capacity}: repeated planning cannot manufacture or retain extra progress`, () => {
            const a = audit([rule('CORE 050', 12, 12 - capacity)]);
            const list = [music(), theatre(), section(5, 'MUS 303M'), section(6, 'ARH 301'), section(7, 'UGS 303')];
            const before = JSON.stringify(a);
            const result = evaluate(a, list);
            expect(result.plannedDegreeCredits).toBeLessThanOrEqual(capacity);
            expect(result.rules[0]!.planned).toBeLessThanOrEqual(result.rules[0]!.remaining);
            expect(result.courses[4]!.degreeCredits).toBe(0);
            expect(evaluate(a, list)).toEqual(result);
            expect(evaluate(a, []).plannedDegreeCredits).toBe(0);
            expect(JSON.stringify(a)).toBe(before);
            for (let n = 0; n < list.length; n++)
                expect(evaluate(a, list.slice(0, n)).plannedDegreeCredits).toBeLessThanOrEqual(
                    result.plannedDegreeCredits
                );
        });
});

it('Spring 2027 six-course regression: 16 enrollment hours, 9 conditional applicable hours in the explicitly synthetic audit', () => {
    const fixture = spring2027();
    const out = evaluate(fixture.audit, fixture.sections);
    expect(fixture.sections.reduce((n, s) => n + s.creditHours, 0)).toBe(16);
    expect(out.courses.map(c => c.status)).toEqual([
        'advances',
        'redundant',
        'advances',
        'advances',
        'redundant',
        'excluded',
    ]);
    expect(out.plannedDegreeCredits).toBe(9);
    const validation = validatePlan(fixture.sections, constraints, {
        audit: fixture.audit,
        auditAvailable: true,
        applies: () => ['AI said this counts'],
        catalog: fixture.sections,
        now: NOW,
    });
    expect(validation.allRulesMet).toBe(false);
    expect(validation.checks.find(c => c.id === 'overlap')?.status).toBe('pass');
    writeFileSync(
        '/tmp/fastlane-spring2027-audit.json',
        JSON.stringify(
            {
                fixtureOnly: true,
                notice: 'Synthetic audit assumptions; actual student IDA, catalog assignment, section unique numbers, restrictions, meetings and flags require verification.',
                enrollmentHours: 16,
                plannedDegreeCredits: out.plannedDegreeCredits,
                courses: out.courses.map((c, i) => ({ course: fixture.sections[i]!.courseCode, ...c })),
                validation,
            },
            null,
            2
        )
    );
});

describe('late-discovered integration boundaries', () => {
    it('conditional unavailability is not a request to exclude the subject', async () => {
        const { requestedSubjectExclusions } = await import('../core/chatPreferences');
        const subjects = [
            { code: 'UGS', name: 'Undergraduate Studies' },
            { code: 'HIS', name: 'History' },
        ];
        expect(
            requestedSubjectExclusions(
                "I won't need history. I want a UGS and a backup if no UGS are available.",
                subjects
            ).codes
        ).toEqual(['HIS']);
        expect(requestedSubjectExclusions('No UGS classes, please.', subjects).codes).toEqual(['UGS']);
    });
    it('semantic meeting equality ignores JSON property and day order after saving', () => {
        const s = section(22, 'BIO 311C', {
            modality: 'in-person',
            meetings: [{ days: ['M', 'W'], start: 600, end: 660, location: 'GEA 1' }],
            prerequisites: '',
        });
        const saved = {
            ...s,
            meetings: [{ location: 'GEA 1', end: 660, start: 600, days: ['W', 'M'] as ('W' | 'M')[] }],
        };
        expect(
            validatePlan([saved], constraints, {
                applies: () => [],
                auditAvailable: false,
                catalog: [s],
                now: NOW,
            }).checks.find(c => c.id === 'sections')?.status
        ).toBe('pass');
    });
    it('changed cached lab times invalidate an old proposal', () => {
        const old = section(22, 'BIO 311C', {
            modality: 'in-person',
            meetings: [{ days: ['M'], start: 600, end: 660 }],
        });
        const refreshed = { ...old, meetings: [{ days: ['M' as const], start: 620, end: 680 }] };
        expect(
            validatePlan([old], constraints, {
                applies: () => [],
                auditAvailable: false,
                catalog: [refreshed],
                now: NOW,
            }).hardOk
        ).toBe(false);
    });
    it('a missing prerequisite remains unverified after independent validation', () => {
        const s = music();
        const a = audit();
        const report = validatePlan([s], constraints, {
            audit: a,
            applies: () => ['CORE 050'],
            auditAvailable: true,
            catalog: [s],
            now: NOW,
        });
        expect(report.hardOk).toBe(true);
        expect(report.allRulesMet).toBe(false);
        expect(report.checks.find(c => c.id === 'prerequisites')?.status).toBe('unverified');
    });
    it('one pending group cannot hide a different missing AND prerequisite', () => {
        const index = subjectNameIndex([
            { code: 'ECO', name: 'Economics' },
            { code: 'M', name: 'Mathematics' },
        ]);
        expect(
            checkPrerequisites('Economics 304K and Mathematics 408Q', [], index, [
                record('ECO 304K', 'pending-transfer'),
            ]).status
        ).toBe('unmet');
    });
    it('the official astronomy credit exclusion is separate from available science capacity', () => {
        const a = audit([rule('CORE 030', 6)]);
        const out = evaluate(a, [science(), section(44, 'AST 307')]);
        expect(out.courses[1]?.status).toBe('duplicate-credit');
        expect(out.plannedDegreeCredits).toBe(3);
        expect(createDegreeMatcher(audit([rule('CORE 030', 6)], [record('AST 307')]), opts)(science())).toEqual([]);
    });
    it('raw flag decoration is never treated as a verified requirement', () => {
        const s = { ...music(), flags: ['Writing'], requirementTags: ['FLAG WR'] };
        expect(evaluate(audit([rule('FLAG WR')]), [s]).plannedDegreeCredits).toBe(0);
    });
    it('a stale fixed course cannot bypass solver validation', async () => {
        const s = music();
        const a = audit([rule('CORE 050', 3, 3)]);
        expect(
            (
                await solveSchedule(
                    [{ section: s, applies: ['CORE 050'], prerequisite: 'none', score: 1 }],
                    constraints,
                    { audit: a, fixed: [s] }
                )
            ).best
        ).toBeNull();
    });
    it('model prose cannot award credit to a redundant class', async () => {
        const { guardReply } = await import('../core/claimGuard');
        const a = audit([rule('CORE 050', 3, 3)]),
            s = music();
        const report = validatePlan([s], constraints, {
            audit: a,
            auditAvailable: true,
            applies: () => ['CORE 050'],
            catalog: [s],
            now: NOW,
        });
        const text = guardReply('MUS 302L satisfies your arts requirement.', report);
        expect(text).toContain('already satisfied');
        expect(text).not.toContain('MUS 302L satisfies');
    });
    it('saved courses use validated section identity, credit and meetings rather than stale serialized copies', async () => {
        const { courseFromSection } = await import('../services/planningService');
        const s = section(90011, 'BIO 301E', {
            creditHours: 3,
            meetings: [{ days: ['T'], start: 600, end: 660 }],
            modality: 'in-person',
            flags: ['Writing'],
            core: ['030'],
            url: 'https://utdirect.utexas.edu/apps/registrar/course_schedule/20272/90011/',
            course: {
                uniqueId: 90012,
                department: 'XYZ',
                number: '999',
                creditHours: 9,
                semester: { season: 'Fall', year: 2026 },
                schedule: { meetings: [] },
                instructors: [],
            },
        });
        const saved = courseFromSection(s);
        expect(saved.uniqueId).toBe(90011);
        expect(saved.department).toBe('BIO');
        expect(saved.creditHours).toBe(3);
        expect(saved.schedule.meetings[0]?.startTime).toBe(600);
        expect(saved.core).toEqual(['030']);
        expect(saved.flags).toEqual(['Writing']);
    });
    it('earned degree credit stays unknown when only raw enrollment totals are available', async () => {
        const { academicModel } = await import('../core/academicModel');
        const a = audit([], [record('PED 106C')]);
        a.creditHours = { required: 120, applied: 0, remaining: 120, confidence: 'high' };
        const model = academicModel(a);
        expect(model.degreeCreditsEarned.value).toBeNull();
        expect(model.degreeCreditsProjected.value).toBeNull();
    });
});

it('large tool results remain bounded valid JSON with all selected classes and the independent verdict', async () => {
    const { serializeToolResult } = await import('../core/toolSummary');
    const classes = Array.from({ length: 7 }, (_, i) => ({
        code: `ECO 30${i}`,
        unique: String(90000 + i),
        credits: 3,
        when: 'MWF',
        countsToward: ['COURSE ECO 304K'],
        degree: { status: 'advances', plannedHours: 3 },
        description: 'Long detailed source text '.repeat(100),
        historicalARate: { percent: 75, sample: 100 },
    }));
    const raw = serializeToolResult({
        totalCredits: 21,
        semester: TERM,
        validation: { hardOk: true, allRulesMet: false, unverified: ['Pending official review'] },
        classes,
        backups: { perClass: classes.map(c => ({ for: c.code, options: classes })), general: classes },
    });
    expect(raw.length).toBeLessThanOrEqual(3900);
    const parsed = JSON.parse(raw);
    expect(parsed.classes.map((c: { unique: string }) => c.unique)).toEqual(classes.map(c => c.unique));
    expect(parsed.validation.allRulesMet).toBe(false);
    expect(parsed.totalCredits).toBe(21);
});

it('the real imported signature rule retains both shorthand alternatives', () => {
    const doc = new DOMParser().parseFromString(
        readFileSync(resolve(__dirname, 'fixtures/dap-audit-results-real.html'), 'utf8'),
        'text/html'
    );
    const r = parseAuditHtml(doc, undefined, NOW).requirements.find(r => r.tags.includes('CORE 090'));
    expect(r?.tags).toContain('COURSE UGS 302');
    expect(r?.tags).toContain('COURSE UGS 303');
});
it('future/planned counted credit is not relabeled earned or completed', () => {
    const a = audit([rule('CORE 050', 3, 3, { courses: ['MUS 302L'] })], [record('MUS 302L', 'planned')]);
    const r = degreeRules(a, opts)[0]!;
    expect(r.counted).toBe(0);
    expect(r.importedPlanned).toBe(3);
    expect(r.evidence.validity).toBe('unverified');
});

it('core designation cannot override a verified college-specific degree exclusion', () => {
    const a = audit([rule('CORE 030', 6)]);
    a.program = 'B S Computer Science, CS';
    a.catalogYear = '2024-2026';
    expect(evaluate(a, [science()]).courses[0]?.status).toBe('excluded');
    expect(createDegreeMatcher(a, opts)(science())).toEqual([]);
});
it('the sourced Economics plan permits its explicit core/major overlap without duplicate degree hours', () => {
    const a = audit([rule('CORE 080'), rule('COURSE ECO 304L', 3, 0, { category: 'major' })]);
    const out = evaluate(a, [section(66, 'ECO 304L')]);
    expect(out.courses[0]?.contributions).toHaveLength(2);
    expect(out.plannedDegreeCredits).toBe(3);
});

it('IDA degree initials and appended major code retain the verified program policy', () => {
    const a = audit();
    a.program = 'B A Economics, ECO';
    expect(evaluate(a, [section(77, 'PED 106C')]).courses[0]?.status).toBe('excluded');
});
it.each([
    'AST 303',
    'AST 309G',
    'AST 309L',
    'AST 309N',
    'AST 309Q',
    'AST 309R',
    'AST 309S',
])('the explicit CNS exclusion is enforced for %s', code => {
    const a = audit([rule('CORE 030', 6)]);
    a.program = 'B S Computer Science, CS';
    a.catalogYear = '2026-2028';
    expect(evaluate(a, [section(78, code)]).courses[0]?.status).toBe('excluded');
    expect(createDegreeMatcher(a, opts)(section(78, code))).toEqual([]);
});

it('prerequisites use imported equivalent rows without counting them as extra earned courses', () => {
    const records = [record('M 408C'), record('M 408K', 'completed', { equivalent: true, unique: '00000' })];
    const index = subjectNameIndex([{ code: 'M', name: 'Mathematics' }]);
    expect(checkPrerequisites('Mathematics 408K', [], index, records).status).toBe('met');
    records[0]!.status = 'in-progress';
    expect(checkPrerequisites('Mathematics 408K', [], index, records).status).toBe('check');
    records[0]!.status = 'completed';
    records[0]!.grade = 'F';
    expect(checkPrerequisites('Mathematics 408K', ['M 408K'], index, records).status).toBe('unmet');
});

it('legacy recommendations keep in-progress prerequisite eligibility conditional', () => {
    const index = subjectNameIndex([{ code: 'ECO', name: 'Economics' }]);
    const result = prerequisiteEligibility(
        section(88, 'ECO 304L', { prerequisites: 'Economics 304K' }),
        ['ECO 304K'],
        index,
        [record('ECO 304K', 'in-progress')]
    );
    expect(result.status).toBe('unknown');
    expect(result.prerequisite.status).toBe('check');
});
it('a bounded summary never silently drops the ninth selected class', async () => {
    const { serializeToolResult } = await import('../core/toolSummary');
    const classes = Array.from({ length: 9 }, (_, i) => ({
        code: `PED 10${i}`,
        unique: String(91000 + i),
        credits: 1,
        description: 'Details '.repeat(100),
    }));
    const result = JSON.parse(serializeToolResult({ totalCredits: 9, classes }));
    expect(result.classes.map((c: { unique: string }) => c.unique)).toEqual(classes.map(c => c.unique));
});
