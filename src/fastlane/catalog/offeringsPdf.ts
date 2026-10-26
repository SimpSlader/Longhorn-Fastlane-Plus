/**
 * Parser for the Registrar's public "Course offerings" PDF (registrar.utexas.edu/schedules/<term>/print).
 *
 * The PDF is a two-column listing. Each column has, from top to bottom:
 *   - subject legend lines            "Economics - ECO"
 *   - a course header                 "ECO 304K  INTRODUCTION TO MICROECONOMICS"
 *   - description / prerequisite text
 *   - optional topic titles           "SURVEYS OF THE ANTHROPOCENE"  (topic courses)
 *   - section lines                   "• 34075  TTH  200 - 330P  PAR 105  OXENFORD, S"
 *   - extra meeting lines             "         W    200 - 300P  ACS 0.108"
 *
 * Field positions are read from each page's own column header ("course unique days time room instructor"),
 * so both page templates (left margin 36 or 18) parse the same way. Nothing is guessed: a section is
 * emitted only for a printed five-digit unique number, and anything unparsable is reported in `issues`.
 * Pure: takes positioned text items, no PDF.js or DOM here.
 */
import type { DayCode, Meeting } from '../core/meetings';

export interface PdfTextItem {
    page: number;
    x: number;
    y: number;
    str: string;
}

export interface OfferingSection {
    uniqueId: number;
    /** "C S" */
    subject: string;
    /** "312H" */
    number: string;
    /** "C S 312H" */
    courseCode: string;
    /** course title as printed in the header */
    courseTitle: string;
    /** topic title for topic courses, else undefined */
    topic?: string;
    /** description text that precedes the section (course or topic description) */
    description: string;
    /** "Prerequisite: …" clause from the description, if printed */
    prerequisites?: string;
    meetings: Meeting[];
    /** as printed, "SMITH, M" */
    instructors: string[];
    /** description says the class is (partially) taught as a Web-based course */
    webBased: 'full' | 'partial' | null;
    page: number;
}

export interface OfferingsParse {
    term: { season: 'Spring' | 'Summer' | 'Fall'; year: number; code: string } | null;
    /** "2026-10-01" from "as of 10/01/2026" */
    asOf: string | null;
    /** subject code → name, from the PDF's own subject legend */
    subjects: Record<string, string>;
    sections: OfferingSection[];
    issues: string[];
    pages: number;
}

const COURSE_CODE = /^([A-Z](?: ?[A-Z]){0,2}) (\d{3}[A-Z]{0,2})$/;
const SUBJECT_CODE = /^[A-Z](?: ?[A-Z]){0,2}$/;
const UNIQUE = /^\d{5}$/;
const DAYS = /^(?:TH|SU|M|T|W|F|S)+$/;
const TIME = /^(\d{3,4})(P?)$/;
const SEASON_CODE = { Spring: '2', Summer: '6', Fall: '9' } as const;

interface Columns {
    code: number;
    title: number;
    days: number;
    time: number;
    room: number;
    instructor: number;
}

interface Line {
    y: number;
    items: Array<{ x: number; s: string }>;
}

/** Joins PDF text pieces; PDF.js splits hyphenated words into "upper | - | division". */
export function joinText(parts: string[]): string {
    return parts
        .join(' ')
        .replace(/\s*-\s*/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Joins printed lines; a word broken at a line end ("Statis-" / "tics") is rejoined without the hyphen. */
export function joinLines(lines: string[]): string {
    let out = '';
    for (const line of lines) {
        if (!line) continue;
        if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
        else out = out ? `${out} ${line}` : line;
    }
    return out;
}

/** "MWF" → ["M","W","F"], "TTH" → ["T","TH"]; null when not a day string. */
export function parseDays(text: string): DayCode[] | null {
    if (!DAYS.test(text)) return null;
    return (text.match(/TH|SU|M|T|W|F|S/g) ?? []) as DayCode[];
}

/**
 * Registrar times: "930" … "1100", "1230" … "200P". A trailing P marks p.m. on the end time; the start is
 * p.m. too when that still makes it start before the end (e.g. "200 - 330P" = 2:00–3:30 p.m.).
 */
export function parseTimeRange(start: string, end: string): { start: number; end: number } | null {
    const a = start.match(TIME);
    const b = end.match(TIME);
    if (!a?.[1] || !b?.[1] || a[2]) return null;
    const toMinutes = (digits: string) => {
        const h = Number(digits.slice(0, -2));
        const m = Number(digits.slice(-2));
        return h > 12 || m > 59 ? null : { h, m };
    };
    const s = toMinutes(a[1]);
    const e = toMinutes(b[1]);
    if (!s || !e) return null;
    const endH = b[2] === 'P' && e.h < 12 ? e.h + 12 : e.h;
    const endMin = endH * 60 + e.m;
    let startMin = s.h * 60 + s.m;
    if (b[2] === 'P' && s.h < 12 && (s.h + 12) * 60 + s.m < endMin) startMin += 12 * 60;
    return startMin < endMin ? { start: startMin, end: endMin } : null;
}

export function prerequisiteClause(description: string): string | undefined {
    const at = description.search(/Prerequisites?:/);
    if (at < 0) return undefined;
    const clause = description
        .slice(at)
        .split(/\s(?:same as|also meets with|meets with)\s/)[0]
        ?.trim();
    return clause ? clause.slice(0, 400) : undefined;
}

function webBased(description: string): OfferingSection['webBased'] {
    if (/Partially taught as a Web-based course/i.test(description)) return 'partial';
    if (/Taught as a Web-based course/i.test(description)) return 'full';
    return null;
}

/** A line of capitals ("SPATIAL STORIES", "2-MANAGING THE DESIGN PROJECT") printed where titles go. */
function looksLikeTopicTitle(text: string): boolean {
    return !/[a-z]/.test(text) && (text.match(/[A-Z]/g)?.length ?? 0) >= 3 && !COURSE_CODE.test(text);
}

function groupLines(items: Array<{ x: number; y: number; s: string }>): Line[] {
    const lines: Line[] = [];
    for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - item.y) < 2.5) last.items.push({ x: item.x, s: item.s });
        else lines.push({ y: item.y, items: [{ x: item.x, s: item.s }] });
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);
    return lines;
}

/** Reads both columns' field positions from the page's own header row. */
function pageColumns(items: PdfTextItem[]): [Columns, Columns] | null {
    // only the top header row: descriptions can also contain the words "time" or "room"
    const top = Math.max(...items.filter(i => i.str.trim() === 'course').map(i => i.y));
    const header = items.filter(
        i =>
            Math.abs(i.y - top) < 2.5 &&
            ['course', 'unique', 'days', 'time', 'room', 'instructor'].includes(i.str.trim())
    );
    const byName = (name: string) =>
        header
            .filter(i => i.str.trim() === name)
            .map(i => i.x)
            .sort((a, b) => a - b);
    const course = byName('course');
    const unique = byName('unique');
    const days = byName('days');
    const time = byName('time');
    const room = byName('room');
    const instructor = byName('instructor');
    if ([course, unique, days, time, room, instructor].some(xs => xs.length !== 2)) return null;
    const col = (i: 0 | 1): Columns => ({
        code: course[i] as number,
        title: unique[i] as number,
        days: days[i] as number,
        time: time[i] as number,
        room: room[i] as number,
        instructor: instructor[i] as number,
    });
    return [col(0), col(1)];
}

interface State {
    subject: string;
    number: string;
    courseTitle: string;
    topic?: string;
    text: string[];
    afterSection: boolean;
    current?: OfferingSection;
}

/** Parses section and continuation tokens (everything right of the bullet) using column positions. */
function readMeeting(
    tokens: Array<{ x: number; s: string }>,
    cols: Columns
): { meeting?: Meeting; instructors: string[]; ok: boolean } {
    const near = 4;
    const days = tokens.filter(t => t.x >= cols.days - near && t.x < cols.time - 12 && parseDays(t.s));
    // PDF.js occasionally splits a time ("80 | 0", "3 | 00"); rejoin the digits on each side of the dash
    const timeTokens = tokens.filter(t => t.x >= cols.time - 26 && t.x < cols.room - near);
    const dash = timeTokens.findIndex(t => t.s === '-');
    const times =
        dash < 0
            ? timeTokens
            : [timeTokens.slice(0, dash), timeTokens.slice(dash + 1)]
                  .map(side => side.map(t => t.s).join(''))
                  .filter(Boolean)
                  .map(s => ({ x: 0, s }));
    const room = tokens.filter(t => t.x >= cols.room - near && t.x < cols.instructor - near).map(t => t.s);
    const instructors = tokens.filter(t => t.x >= cols.instructor - near).map(t => t.s.trim());
    const instructorNames = instructors.length ? [joinText(instructors).replace(/,(?=\S)/, ', ')] : [];
    if (!days.length && !times.length) return { instructors: instructorNames, ok: room.length === 0 };
    const dayCodes = parseDays(days[0]?.s ?? '');
    const range = times.length === 2 ? parseTimeRange(times[0]?.s ?? '', times[1]?.s ?? '') : null;
    if (!dayCodes || !range) return { instructors: instructorNames, ok: false };
    const location = room.join(' ').trim();
    return {
        meeting: { days: dayCodes, start: range.start, end: range.end, ...(location ? { location } : {}) },
        instructors: instructorNames,
        ok: true,
    };
}

export function parseOfferingsItems(items: PdfTextItem[]): OfferingsParse {
    const result: OfferingsParse = { term: null, asOf: null, subjects: {}, sections: [], issues: [], pages: 0 };
    const pages = new Map<number, PdfTextItem[]>();
    for (const item of items) {
        if (!item.str.trim()) continue;
        const list = pages.get(item.page) ?? [];
        list.push(item);
        pages.set(item.page, list);
    }
    result.pages = pages.size;
    const seen = new Set<number>();
    const state: State = { subject: '', number: '', courseTitle: '', text: [], afterSection: false };

    const finishSection = (section: OfferingSection) => {
        if (seen.has(section.uniqueId)) {
            result.issues.push(`p${section.page}: duplicate unique ${section.uniqueId} skipped`);
            return;
        }
        seen.add(section.uniqueId);
        result.sections.push(section);
    };

    for (const page of [...pages.keys()].sort((a, b) => a - b)) {
        const pageItems = pages.get(page) ?? [];
        for (const item of pageItems) {
            const s = item.str.trim();
            const asOf = s.match(/^as of (\d{2})\/(\d{2})\/(\d{4})$/);
            if (asOf && !result.asOf) result.asOf = `${asOf[3]}-${asOf[1]}-${asOf[2]}`;
            const term = s.match(/^(SPRING|SUMMER|FALL) (20\d{2})$/);
            if (term?.[1] && term[2] && !result.term) {
                const season = (term[1][0] + term[1].slice(1).toLowerCase()) as 'Spring' | 'Summer' | 'Fall';
                result.term = { season, year: Number(term[2]), code: `${term[2]}${SEASON_CODE[season]}` };
            }
        }
        const cols = pageColumns(pageItems);
        if (!cols) {
            result.issues.push(`p${page}: no column header; page skipped`);
            continue;
        }
        const split = cols[1].code - 6;
        for (const [index, column] of cols.entries()) {
            const columnItems = pageItems
                .filter(i => (index === 0 ? i.x < split : i.x >= split))
                .map(i => ({ x: i.x, y: i.y, s: i.str.trim() }));
            for (const line of groupLines(columnItems)) {
                const first = line.items[0];
                if (!first) continue;
                const rel = first.x - column.code;
                const strings = line.items.map(i => i.s);
                if (strings.includes('course') && strings.includes('unique')) continue;

                // course header "ECO 304K  TITLE"
                const header = Math.abs(rel) <= 3 ? first.s.match(COURSE_CODE) : null;
                if (header?.[1] && header[2]) {
                    if (state.current) finishSection(state.current);
                    state.current = undefined;
                    state.subject = header[1];
                    state.number = header[2];
                    state.courseTitle = joinText(line.items.slice(1).map(i => i.s));
                    state.topic = undefined;
                    state.text = [];
                    state.afterSection = false;
                    continue;
                }
                // subject legend "Economics - ECO"
                if (Math.abs(rel) <= 3 && strings.length >= 3 && strings[strings.length - 2] === '-') {
                    const code = strings[strings.length - 1] ?? '';
                    if (SUBJECT_CODE.test(code)) {
                        result.subjects[code] = joinText(strings.slice(0, -2));
                        continue;
                    }
                }
                // section line "• 34075 …"
                const bulletAt = line.items.findIndex(i => i.s === '•');
                if (bulletAt >= 0 && Math.abs((line.items[bulletAt]?.x ?? 0) - column.title) <= 4) {
                    const unique = line.items[bulletAt + 1];
                    if (!unique || !UNIQUE.test(unique.s)) {
                        result.issues.push(`p${page}: section line without unique number`);
                        continue;
                    }
                    if (!state.subject) {
                        result.issues.push(`p${page}: unique ${unique.s} before any course header`);
                        continue;
                    }
                    if (state.current) finishSection(state.current);
                    const parsed = readMeeting(line.items.slice(bulletAt + 2), column);
                    if (!parsed.ok)
                        result.issues.push(`p${page}: unique ${unique.s} meeting not parsed: ${strings.join(' ')}`);
                    const description = joinLines(state.text);
                    state.current = {
                        uniqueId: Number(unique.s),
                        subject: state.subject,
                        number: state.number,
                        courseCode: `${state.subject} ${state.number}`,
                        courseTitle: state.courseTitle,
                        ...(state.topic ? { topic: state.topic } : {}),
                        description,
                        ...(prerequisiteClause(description) ? { prerequisites: prerequisiteClause(description) } : {}),
                        meetings: parsed.meeting ? [parsed.meeting] : [],
                        instructors: parsed.instructors,
                        webBased: webBased(description),
                        page,
                    };
                    state.afterSection = true;
                    continue;
                }
                // extra meeting / instructor line for the current section (wrapped banners have no such tokens)
                const meetingShaped = line.items.some(
                    i => parseDays(i.s) || TIME.test(i.s) || (i.x >= column.instructor - 4 && i.s.includes(','))
                );
                if (state.current && first.x >= column.days - 4 && meetingShaped) {
                    const parsed = readMeeting(line.items, column);
                    if (parsed.meeting) state.current.meetings.push(parsed.meeting);
                    for (const name of parsed.instructors)
                        if (!state.current.instructors.includes(name)) state.current.instructors.push(name);
                    if (!parsed.ok)
                        result.issues.push(
                            `p${page}: unique ${state.current.uniqueId} extra line not parsed: ${strings.join(' ')}`
                        );
                    continue;
                }
                // title-column text: topic title or description
                if (state.subject && Math.abs(first.x - column.title) <= 4) {
                    const text = joinText(strings);
                    if (state.afterSection && looksLikeTopicTitle(text)) {
                        if (state.current) finishSection(state.current);
                        state.current = undefined;
                        state.topic = text;
                        state.text = [];
                        state.afterSection = false;
                    } else {
                        state.text.push(text);
                    }
                }
                // anything else (department banners, page titles) carries no section data
            }
        }
    }
    if (state.current) finishSection(state.current);
    return result;
}

/** UT's printed credit-hour rule: the first digit of the course number (e.g. 408C → 4). */
export function creditHoursFor(number: string): number {
    const digit = Number(number.replace(/^\D/, '')[0]);
    return Number.isFinite(digit) ? digit : 0;
}
