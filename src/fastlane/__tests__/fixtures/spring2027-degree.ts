/** Synthetic IDA and section identifiers. The user's actual audit, catalog assignment and registration data were not available. */
import type { AuditCourse, AuditRequirement, ParsedAudit } from '../../audit/types';
import type { SectionRecord } from '../../core/sections';
import { sectionFixture } from '../factories';
export const NOW = Date.parse('2026-10-31T12:00:00Z');
export const TERM = 'Spring 2027';
export const rule = (
    tag: string,
    required = 3,
    counted = 0,
    extra: Partial<AuditRequirement> = {}
): AuditRequirement => ({
    id: tag,
    section: 'Core Curriculum',
    text: `Complete ${tag}`,
    category: 'core',
    status: counted >= required ? 'completed' : counted ? 'in-progress' : 'not-started',
    required: { value: required, unit: 'hours' },
    applied: { value: counted, unit: 'hours' },
    remaining: { value: required - counted, unit: 'hours' },
    tags: [tag],
    courses: [],
    confidence: 'high',
    issues: [],
    ...extra,
});
export const record = (
    code: string,
    status: AuditCourse['status'] = 'completed',
    extra: Partial<AuditCourse> = {}
): AuditCourse => ({
    code,
    name: code,
    grade: status === 'completed' ? 'A' : '',
    unique: '12345',
    type: 'In-Residence',
    hours: 3,
    semester: 'Fall 2026',
    status,
    ...extra,
});
export const audit = (
    requirements: AuditRequirement[] = [rule('CORE 050')],
    courses: AuditCourse[] = []
): ParsedAudit => ({
    source: 'html',
    parsedAt: NOW,
    program: 'BA Economics',
    catalogYear: '2026-2028',
    requirements,
    courses,
    transfer: {
        accepted: courses.filter(c => c.status === 'completed' && /transfer/i.test(c.type)),
        pending: courses.filter(c => c.status === 'pending-transfer'),
    },
    creditHours: { confidence: 'low' },
    restrictions: [],
    warnings: ['SYNTHETIC TEST AUDIT — not a student record'],
});
export const section = (id: number, code: string, extra: Partial<SectionRecord> = {}): SectionRecord => ({
    ...sectionFixture(id, code),
    capturedAt: NOW,
    course: {},
    ...extra,
});
export const spring2027 = () => {
    const sections = [
        section(90001, 'AST 301', {
            ...sectionFixture(90001, 'AST 301', { times: [['TTH', '9:30 am-11:00 am']] }),
            capturedAt: NOW,
            course: {},
        }),
        section(90002, 'EDC 312', {
            ...sectionFixture(90002, 'EDC 312', { times: [['TTH', '11:30 am-1:00 pm']] }),
            capturedAt: NOW,
            course: {},
        }),
        section(90003, 'T D 301', {
            ...sectionFixture(90003, 'T D 301', { times: [['TTH', '2:00 pm-3:30 pm']] }),
            capturedAt: NOW,
            course: {},
        }),
        section(90004, 'UGS 303', {
            ...sectionFixture(90004, 'UGS 303', { times: [['TTH', '3:30 pm-5:00 pm']] }),
            capturedAt: NOW,
            course: {},
        }),
        // "Asynchronous/Other" was not a verified delivery mode: preserve unknown meetings in this fixture.
        section(90005, 'MUS 302L', { modality: 'unknown', scheduleComplete: false }),
        section(90006, 'PED 106C', { creditHours: 1, modality: 'unknown', scheduleComplete: false }),
    ];
    const a = audit(
        [rule('CORE 030', 6), rule('CORE 093'), rule('CORE 050'), rule('CORE 090'), rule('CORE 080')],
        [
            record('ECO 304K', 'in-progress'),
            record('GOV 310L', 'in-progress'),
            record('ENGL 2323', 'pending-transfer', { type: 'ACC course reported complete; UT evaluation pending' }),
            record('ECO 304L', 'pending-transfer', { type: 'CLEP reported score 64; official posting not verified' }),
        ]
    );
    return { audit: a, sections };
};
