import { describe, expect, it } from 'vitest';

import type { SectionTimes } from '../core/meetings';
import {
    conflictingSections,
    detectConflicts,
    meetingsFromRaw,
    parseDays,
    parseTimeRange,
    scheduleConflicts,
} from '../core/meetings';
import { classifyModality } from '../core/modality';

const raw = (daysText: string, hoursText: string, roomText = '') => ({ daysText, hoursText, roomText });

describe('parseDays', () => {
    it('handles UT day strings', () => {
        expect(parseDays('MWF')).toEqual(['M', 'W', 'F']);
        expect(parseDays('TTH')).toEqual(['T', 'TH']);
        expect(parseDays('TH')).toEqual(['TH']);
        expect(parseDays('MTWTHF')).toEqual(['M', 'T', 'W', 'TH', 'F']);
        expect(parseDays('Tu Th')).toEqual(['T', 'TH']);
        expect(parseDays('')).toBeNull();
        expect(parseDays('TBA')).toBeNull();
    });
});

describe('parseTimeRange', () => {
    it('parses UT formats', () => {
        expect(parseTimeRange('10:00 a.m.-11:00 a.m.')).toEqual({ start: 600, end: 660 });
        expect(parseTimeRange('3:30 pm - 5:00 pm')).toEqual({ start: 930, end: 1020 });
        expect(parseTimeRange('12:00 p.m.-1:00 p.m.')).toEqual({ start: 720, end: 780 });
        expect(parseTimeRange('11:00-12:30 p.m.')).toEqual({ start: 660, end: 750 });
        expect(parseTimeRange('14:00-15:30')).toEqual({ start: 840, end: 930 });
    });
    it('rejects TBA, blanks and inverted ranges', () => {
        expect(parseTimeRange('TBA')).toBeNull();
        expect(parseTimeRange('')).toBeNull();
        expect(parseTimeRange('2:00 pm-1:00 pm')).toBeNull();
    });
});

describe('meetingsFromRaw', () => {
    it('marks partially listed meetings incomplete', () => {
        expect(meetingsFromRaw([raw('MWF', '10:00 a.m.-11:00 a.m.', 'GDC 2.216')]).complete).toBe(true);
        expect(meetingsFromRaw([raw('MWF', '', '')]).complete).toBe(false);
        expect(meetingsFromRaw([raw('TBA', 'TBA')]).complete).toBe(false);
        expect(meetingsFromRaw([raw('', '', 'WB')])).toEqual({ meetings: [], complete: true });
    });
});

const section = (uniqueId: number, lines: ReturnType<typeof raw>[], asynchronous = false): SectionTimes => {
    const { meetings, complete } = meetingsFromRaw(lines);
    return { uniqueId, label: `X (${uniqueId})`, meetings, complete, asynchronous };
};

describe('detectConflicts', () => {
    const lecture = section(1, [raw('MWF', '10:00 a.m.-11:00 a.m.')]);
    const lab = section(2, [raw('TTH', '9:30 a.m.-11:00 a.m.'), raw('F', '2:00 p.m.-4:00 p.m.')]);

    it('finds overlaps in any meeting, including secondary lab/discussion meetings', () => {
        const candidate = section(3, [raw('TH', '8:00 a.m.-9:00 a.m.'), raw('F', '3:00 p.m.-3:50 p.m.')]);
        const r = detectConflicts(candidate, [lecture, lab]);
        expect(r.status).toBe('conflict');
        expect(conflictingSections(r).map(s => s.uniqueId)).toEqual([2]);
        expect(r.conflicts[0]!.days).toEqual(['F']);
    });

    it('back-to-back classes do not conflict', () => {
        const next = section(4, [raw('MWF', '11:00 a.m.-12:00 p.m.')]);
        expect(detectConflicts(next, [lecture]).status).toBe('clear');
    });

    it('same time on different days does not conflict', () => {
        const tth = section(5, [raw('TTH', '10:00 a.m.-11:00 a.m.')]);
        expect(detectConflicts(tth, [lecture]).status).toBe('clear');
    });

    it('never flags an async section by modality alone', () => {
        const asyncSection = section(6, [], true);
        expect(detectConflicts(asyncSection, [lecture, lab]).status).toBe('clear');
    });

    it('reports unknown when meeting info is incomplete on either side', () => {
        const tba = section(7, [raw('MWF', 'TBA')]);
        expect(detectConflicts(tba, [lecture]).status).toBe('unknown');
        expect(detectConflicts(tba, [lecture]).candidateIncomplete).toBe(true);
        const clean = section(8, [raw('TTH', '1:00 p.m.-2:00 p.m.')]);
        const r = detectConflicts(clean, [lecture, tba]);
        expect(r.status).toBe('unknown');
        expect(r.unknownWith.map(s => s.uniqueId)).toEqual([7]);
    });

    it('a confirmed conflict wins over unknowns', () => {
        const tba = section(7, [raw('MWF', 'TBA')]);
        const overlap = section(9, [raw('M', '10:30 a.m.-11:30 a.m.')]);
        expect(detectConflicts(overlap, [lecture, tba]).status).toBe('conflict');
    });

    it('ignores the same unique number already in the schedule', () => {
        expect(detectConflicts(lecture, [lecture]).status).toBe('clear');
    });

    it('lists pairwise conflicts in a schedule', () => {
        const overlap = section(9, [raw('M', '10:30 a.m.-11:30 a.m.')]);
        expect(scheduleConflicts([lecture, lab, overlap]).map(([a, b]) => [a.uniqueId, b.uniqueId])).toEqual([[1, 9]]);
    });
});

describe('classifyModality', () => {
    it('blue (async) only for internet mode with no meeting times and no physical room', () => {
        expect(classifyModality({ instructionModeText: 'Internet', meetings: [] }).modality).toBe('async-online');
        expect(classifyModality({ instructionModeText: 'Internet', meetings: [raw('', '', 'WB')] }).modality).toBe(
            'async-online'
        );
    });

    it('internet with scheduled meetings is live online, even in room WB', () => {
        const r = classifyModality({
            instructionModeText: 'Internet',
            meetings: [raw('TTH', '12:30 p.m.-2:00 p.m.', 'WB')],
        });
        expect(r.modality).toBe('live-online');
        expect(r.reasons.join(' ')).toContain('Scheduled online meetings');
    });

    it('does not assume a WB room means asynchronous', () => {
        expect(classifyModality({ instructionModeText: '', meetings: [raw('', '', 'WB')] }).modality).toBe('unknown');
        expect(
            classifyModality({ instructionModeText: '', meetings: [raw('MW', '1:00 p.m.-2:30 p.m.', 'WB')] }).modality
        ).toBe('live-online');
    });

    it('TBA or partial times on an internet section are unknown, not async', () => {
        expect(classifyModality({ instructionModeText: 'Internet', meetings: [raw('TBA', 'TBA')] }).modality).toBe(
            'unknown'
        );
        expect(classifyModality({ instructionModeText: 'Internet', meetings: [raw('MW', '')] }).modality).toBe(
            'unknown'
        );
    });

    it('internet with a physical room is unknown (attendance may be required)', () => {
        expect(
            classifyModality({ instructionModeText: 'Internet', meetings: [raw('', '', 'JES A121A')] }).modality
        ).toBe('unknown');
    });

    it('hybrid and face-to-face keep normal styling', () => {
        expect(classifyModality({ instructionModeText: 'Hybrid/Blended', meetings: [] }).modality).toBe('hybrid');
        expect(
            classifyModality({
                instructionModeText: 'Face-to-face',
                meetings: [raw('MWF', '9:00 a.m.-10:00 a.m.', 'GDC 1.304')],
            }).modality
        ).toBe('in-person');
        expect(
            classifyModality({ instructionModeText: '', meetings: [raw('MWF', '9:00 a.m.-10:00 a.m.', 'GDC 1.304')] })
                .modality
        ).toBe('in-person');
    });
});
