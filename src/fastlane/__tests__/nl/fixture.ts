/**
 * A small, fully synthetic Spring 2027 world for the natural-language benchmark: real-looking sections with
 * different instructors, grade histories, Rate My Professors entries and a degree audit that still needs five
 * Core areas. Nothing here is real UT data.
 */
import { parseAuditHtml } from '../../audit/parseAudit';
import type { ParsedAudit } from '../../audit/types';
import { academicModel } from '../../core/academicModel';
import type { ToolContext } from '../../core/agentTools';
import type { GradeCounts, GradeStat } from '../../core/grades';
import type { RmpRating } from '../../core/rmp';
import type { SectionRecord } from '../../core/sections';
import { sectionFixture } from '../factories';

export const NOW = Date.parse('2026-10-30T12:00:00Z');
type Slot = 'a' | 'b' | 'c' | 'd' | 'e';
const HOURS: Record<Slot, string> = {
    a: '9:30 a.m.-11:00 a.m.',
    b: '11:00 a.m.-12:30 p.m.',
    c: '12:30 p.m.-2:00 p.m.',
    d: '2:00 p.m.-3:30 p.m.',
    e: '3:30 p.m.-5:00 p.m.',
};

/** grade histories by instructor: the planner must prefer EASY over HARD with real counts, not guesses */
const PROFILES: Record<string, GradeCounts> = {
    'EASY, ALEX': { A: 900, 'A-': 120, B: 60, C: 10 },
    'VEASY, VAL': { A: 1500, 'A-': 100, B: 30 },
    'MID, MAX': { A: 400, 'A-': 200, B: 250, C: 100, D: 20 },
    'HARD, HAL': { A: 80, 'A-': 60, B: 250, C: 300, D: 100, F: 60 },
    'NEW, NIA': { A: 10 }, // tiny sample: must not outrank EASY
};
const RMP: Record<string, RmpRating> = {
    easy: {
        legacyId: 1,
        name: 'Alex Easy',
        department: 'X',
        avgRating: 4.7,
        avgDifficulty: 1.8,
        numRatings: 120,
        wouldTakeAgainPercent: 95,
    },
    hard: {
        legacyId: 2,
        name: 'Hal Hard',
        department: 'X',
        avgRating: 2.4,
        avgDifficulty: 4.5,
        numRatings: 60,
        wouldTakeAgainPercent: 30,
    },
};

let course = 0;
function sec(
    id: number,
    code: string,
    title: string,
    pattern: 'TTH' | 'MWF' | 'async',
    slot: Slot | string,
    opts: { core?: string[]; who?: string; credits?: number; room?: string } = {}
): SectionRecord {
    const times: Array<[string, string, string?]> =
        pattern === 'async'
            ? []
            : [[pattern, pattern === 'TTH' ? HOURS[slot as Slot] : (slot as string), opts.room ?? 'GDC 1.304']];
    return {
        ...sectionFixture(id, code, {
            title,
            times,
            core: opts.core ?? [],
            instructors: [opts.who ?? 'MID, MAX'],
            creditHours: opts.credits ?? 3,
        }),
        course: { n: ++course },
        capturedAt: NOW - 3_600_000,
        status: { value: 'OPEN', observedAt: NOW - 7_200_000, source: 'UT course schedule page you viewed' },
    };
}
const WF = {
    nine: '9:00 a.m.-10:00 a.m.',
    ten: '10:00 a.m.-11:00 a.m.',
    eleven: '11:00 a.m.-12:00 p.m.',
};

export const catalog: SectionRecord[] = [
    sec(1, 'UGS 302', 'ART AND THE EPIDEMIC', 'TTH', 'a', { core: ['090'], who: 'EASY, ALEX' }),
    sec(2, 'UGS 303', 'DIY ASSISTIVE TECH', 'TTH', 'b', { core: ['090'], who: 'MID, MAX' }),
    sec(3, 'UGS 302', 'ART AND THE EPIDEMIC', 'MWF', WF.nine, { core: ['090'], who: 'MID, MAX' }),
    sec(4, 'GOV 312L', 'ISSUES AND POLICIES IN AMERICAN GOVERNMENT', 'TTH', 'c', { core: ['070'], who: 'EASY, ALEX' }),
    sec(5, 'GOV 312L', 'ISSUES AND POLICIES IN AMERICAN GOVERNMENT', 'TTH', 'e', { core: ['070'], who: 'HARD, HAL' }),
    sec(6, 'GOV 312L', 'ISSUES AND POLICIES IN AMERICAN GOVERNMENT', 'MWF', WF.ten, {
        core: ['070'],
        who: 'EASY, ALEX',
    }),
    sec(7, 'HIS 315L', 'THE UNITED STATES SINCE 1865', 'TTH', 'd', { core: ['060'], who: 'MID, MAX' }),
    sec(8, 'HIS 315K', 'THE UNITED STATES, 1492 TO 1865', 'MWF', WF.eleven, { core: ['060'], who: 'MID, MAX' }),
    sec(9, 'MUS 306M', 'ELEMENTS OF MUSIC', 'TTH', 'd', { core: ['050'], who: 'EASY, ALEX' }),
    sec(10, 'MUS 306M', 'ELEMENTS OF MUSIC', 'async', '', { core: ['050'], who: 'EASY, ALEX' }),
    sec(11, 'ART 301', 'SURVEY OF ART', 'MWF', WF.ten, { core: ['050'], who: 'MID, MAX' }),
    sec(12, 'NTR 306', 'FUNDAMENTALS OF NUTRITION', 'async', '', { core: ['030'], who: 'VEASY, VAL' }),
    sec(13, 'BIO 301D', 'ECOLOGY, EVOLUTION, AND SOCIETY', 'TTH', 'e', { core: ['030'], who: 'MID, MAX' }),
    sec(14, 'AST 301', 'INTRODUCTION TO ASTRONOMY', 'TTH', 'b', { core: ['030'], who: 'HARD, HAL' }),
    sec(15, 'ECO 304L', 'INTRODUCTION TO MACROECONOMICS', 'TTH', 'b', { who: 'HARD, HAL' }),
    sec(16, 'ECO 304L', 'INTRODUCTION TO MACROECONOMICS', 'TTH', 'c', { who: 'EASY, ALEX' }),
    sec(17, 'ECO 304L', 'INTRODUCTION TO MACROECONOMICS', 'async', '', { who: 'MID, MAX' }),
    sec(18, 'SED 303', 'EXPLORING LEARNING', 'async', '', { who: 'VEASY, VAL' }),
    sec(19, 'KIN 302', 'PHYSICAL ACTIVITY AND WELLNESS', 'TTH', 'a', { who: 'EASY, ALEX' }),
    sec(20, 'ANT 301', 'INTRODUCTION TO ANTHROPOLOGY', 'TTH', 'e', { who: 'MID, MAX' }),
    sec(21, 'SOC 302', 'INTRODUCTION TO SOCIOLOGY', 'MWF', WF.nine, { who: 'MID, MAX' }),
    sec(22, 'AMS 310', 'INTRODUCTION TO AMERICAN STUDIES', 'TTH', 'd', { who: 'HARD, HAL', room: 'PMA 6.104' }),
    sec(23, 'C C 302', 'INTRODUCTION TO CLASSICAL CULTURE', 'TTH', 'c', { who: 'EASY, ALEX' }),
    sec(24, 'ADV 318', 'INTRODUCTION TO ADVERTISING', 'TTH', 'b', { who: 'MID, MAX' }),
    sec(25, 'E 316L', 'BRITISH LITERATURE', 'async', '', { who: 'MID, MAX' }),
    sec(26, 'M 408C', 'DIFFERENTIAL AND INTEGRAL CALCULUS', 'MWF', WF.nine, { who: 'MID, MAX', credits: 4 }),
    sec(27, 'PSY 301', 'INTRODUCTION TO PSYCHOLOGY', 'TTH', 'a', { who: 'NEW, NIA' }), // tiny-sample 100% A
    sec(28, 'PSY 301', 'INTRODUCTION TO PSYCHOLOGY', 'TTH', 'b', { who: 'EASY, ALEX' }),
];

export const outstanding = ['CORE 090', 'CORE 070', 'CORE 060', 'CORE 050', 'CORE 030'];
// the planner reads this from the real audit; the list above is what that audit leaves unfinished
export const subjectIndex: Array<[string, string]> = [
    ['nutritional sciences', 'NTR'],
    ['economics', 'ECO'],
    ['government', 'GOV'],
    ['history', 'HIS'],
    ['undergraduate studies', 'UGS'],
    ['music', 'MUS'],
    ['psychology', 'PSY'],
    ['sociology', 'SOC'],
    ['astronomy', 'AST'],
];

/** The Core Curriculum section of a real-looking IDA (rows modelled on a student's actual audit). */
function auditHtml(): string {
    const row = (
        n: number,
        text: string,
        req: string,
        counted: string,
        lacking: string,
        done: boolean,
        courses: string[]
    ) =>
        `<tr class="rule ${done ? 'fulfilled' : 'notstarted'}"><td>${n}</td><td></td><td>${text}</td><td>${req}</td><td>${counted}</td><td>${lacking}</td></tr>
         <tr class="details"><td colspan="6"><table><tbody>${courses.map(c => `<tr><td>${c}</td><td>x</td><td></td><td></td><td></td><td>3</td></tr>`).join('')}</tbody></table></td></tr>`;
    return `<html><body>
      <div id="coursework"><table class="results"><tbody>
        <tr><th class="section_title">Fall 2025 Courses</th></tr>
        <tr><td>RHE 306</td><td>RHETORIC</td><td>A</td><td></td><td>In-Residence</td><td>3</td></tr>
        <tr><td>E 316L</td><td>BRITISH LIT</td><td>A</td><td></td><td>In-Residence</td><td>3</td></tr>
        <tr><td>ECO 304K</td><td>MICRO</td><td>A</td><td></td><td>In-Residence</td><td>3</td></tr>
        <tr><td>M 408Q</td><td>CALCULUS</td><td>A</td><td></td><td>In-Residence</td><td>3</td></tr>
      </tbody></table></div>
      <div id="requirements"><table class="results"><thead><tr><th class="section_title"><a>Core Curriculum</a></th></tr></thead>
        <tbody class="section">
          ${row(1, 'CORE (090): A first-year signature course (UGS 302 or 303 or the equivalent) is required.', '3 hours', 'none', '3 hours', false, [])}
          ${row(2, 'CORE (010): RHE 306 or its equivalent are required.', '3 hours', '3 hours', '0 hours', true, ['RHE 306'])}
          ${row(3, 'CORE (040): 3 hours in humanities (E 316L, M, N, P, or the equivalent) are required.', '3 hours', '3 hours', '0 hours', true, ['E 316L'])}
          ${row(4, 'CORE (070): 6 hours in American &amp; Texas government, generally completed with GOV 310L or CIV 303C and GOV 312L when taken in-residence.', '6 hours', '3 hours', '3 hours', false, ['GOV 310L'])}
          ${row(5, 'CORE (060): 6 hours in U.S. history, including no more than 3 hours in Texas history, are required.', '6 hours', '3 hours', '3 hours', false, ['HIS 315L'])}
          ${row(6, 'CORE (080): 3 hours in social and behavioral sciences are required.', '3 hours', '3 hours', '0 hours', true, ['ECO 304K'])}
          ${row(7, 'CORE (020): 3 hours in mathematics are required.', '3 hours', '3 hours', '0 hours', true, ['M 408Q'])}
          ${row(8, 'CORE (030 and 031/093): 9 hrs from Science &amp; Technology Part I OR 6 hrs from NST Part I &amp; 3 hrs from NST Part II.', '9 hours', 'none', '9 hours', false, [])}
          ${row(9, 'CORE (050): 3 hours in the visual and performing arts are required.', '3 hours', 'none', '3 hours', false, [])}
        </tbody></table></div></body></html>`;
}
export const audit: ParsedAudit = parseAuditHtml(
    new DOMParser().parseFromString(auditHtml(), 'text/html'),
    'bench.html',
    NOW
);

export function makeContext(over: Partial<ToolContext> = {}): ToolContext {
    return {
        catalog,
        term: 'Spring 2027',
        audit,
        model: academicModel(null),
        taken: new Set(),
        outstanding,
        subjectIndex,
        gradeStat: async s =>
            ({
                result: { percent: 80, graded: 1000 },
                scope: 'instructor',
                courseCode: s.courseCode,
                source: 'synthetic test data',
                semesters: ['Fall 2025', 'Spring 2026'],
                counts: PROFILES[s.instructors[0] ?? ''] ?? { A: 200, B: 200, C: 100 },
            }) as unknown as GradeStat,
        rmp: async (_first, last) => (/easy/i.test(last) ? RMP.easy! : /hard/i.test(last) ? RMP.hard! : null),
        current: null,
        remember: async () => {},
        now: NOW,
        ...over,
    };
}
