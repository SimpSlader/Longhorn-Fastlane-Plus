import { describe, expect, it } from 'vitest';

import { DEFAULT_AUTOFILL, decideAutofill, fillInput, findUniqueAddInput } from '../core/autofill';
import { buildIcs, foldLine } from '../core/ics';
import {
    defaultReminderConfig,
    normalizeReminderConfig,
    planReminders,
    ReminderError,
    windowToEpoch,
} from '../core/reminders';
import { groupByDay } from '../core/wallpaper';

describe('reminders', () => {
    it('converts a Central-time registration window to UTC, DST-aware', () => {
        // Nov 9 2026 08:00 CST = 14:00 UTC; Apr 6 2027 08:00 CDT = 13:00 UTC
        expect(windowToEpoch({ date: '2026-11-09', time: '08:00', timeZone: 'America/Chicago' })).toBe(
            Date.UTC(2026, 10, 9, 14, 0)
        );
        expect(windowToEpoch({ date: '2027-04-06', time: '08:00', timeZone: 'America/Chicago' })).toBe(
            Date.UTC(2027, 3, 6, 13, 0)
        );
    });

    it('rejects invalid input', () => {
        expect(() => windowToEpoch({ date: '2026-02-30', time: '08:00', timeZone: 'America/Chicago' })).toThrow(
            ReminderError
        );
        expect(() => windowToEpoch({ date: '11/9/2026', time: '08:00', timeZone: 'America/Chicago' })).toThrow(
            ReminderError
        );
        expect(() => windowToEpoch({ date: '2026-11-09', time: '08:00', timeZone: 'Mars/Olympus' })).toThrow(
            ReminderError
        );
    });

    it('plans 24h / 1h / 10min plus custom and task reminders, dropping past ones', () => {
        const config = {
            ...defaultReminderConfig(),
            enabled: true,
            window: { date: '2026-11-09', time: '08:00', timeZone: 'America/Chicago' },
            offsets: [1440, 60, 10, 30],
        };
        const opens = Date.UTC(2026, 10, 9, 14, 0);
        const plan = planReminders(config, opens - 3 * 24 * 60 * 60_000);
        expect(plan.map(r => r.id)).toEqual([
            'fastlane-reminder:review-backups',
            'fastlane-reminder:registration:1440',
            'fastlane-reminder:confirm-queue',
            'fastlane-reminder:registration:60',
            'fastlane-reminder:registration:30',
            'fastlane-reminder:registration:10',
        ]);
        expect(plan.find(r => r.id.endsWith(':60'))!.when).toBe(opens - 60 * 60_000);
        expect(planReminders(config, opens - 20 * 60_000).map(r => r.id)).toEqual([
            'fastlane-reminder:registration:10',
        ]);
        expect(planReminders({ ...config, enabled: false })).toEqual([]);
    });

    it('schedules from a partially written config (fresh profile race)', () => {
        const partial = { enabled: true, window: { date: '2026-11-09', time: '08:00', timeZone: 'America/Chicago' } };
        const config = normalizeReminderConfig(partial as never);
        expect(config.offsets).toEqual([1440, 60, 10]);
        const opens = Date.UTC(2026, 10, 9, 14, 0);
        expect(planReminders(config, opens - 3 * 24 * 60 * 60_000).length).toBeGreaterThanOrEqual(4);
        expect(normalizeReminderConfig(undefined)).toEqual(defaultReminderConfig());
    });

    it('exports a valid .ics with alarms', () => {
        const ics = buildIcs(
            [
                {
                    uid: 'r1@fastlane',
                    start: Date.UTC(2026, 10, 9, 14),
                    durationMinutes: 30,
                    summary: 'UT registration opens, bring backups',
                    alarms: [1440, 10],
                },
            ],
            Date.UTC(2026, 9, 1)
        );
        expect(ics).toContain('DTSTART:20261109T140000Z');
        expect(ics).toContain('SUMMARY:UT registration opens\\, bring backups');
        expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
        expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
        expect(foldLine('x'.repeat(80)).split('\r\n')[1]).toBe(` ${'x'.repeat(5)}`);
    });
});

describe('autofill decisions', () => {
    const on = { ...DEFAULT_AUTOFILL, enabled: true };

    it('is off by default and respects pause', () => {
        expect(DEFAULT_AUTOFILL.enabled).toBe(false);
        expect(decideAutofill({ settings: DEFAULT_AUTOFILL, code: '23095', fieldValue: '', lastFilled: null })).toEqual(
            {
                action: 'skip',
                reason: 'disabled',
            }
        );
        expect(
            decideAutofill({ settings: { ...on, paused: true }, code: '23095', fieldValue: '', lastFilled: null })
                .action
        ).toBe('skip');
    });

    it('fills an empty field and replaces its own previous fill after a failure', () => {
        expect(decideAutofill({ settings: on, code: '23095', fieldValue: '', lastFilled: null })).toEqual({
            action: 'fill',
            code: '23095',
        });
        expect(decideAutofill({ settings: on, code: '33515', fieldValue: '23095', lastFilled: '23095' })).toEqual({
            action: 'fill',
            code: '33515',
        });
    });

    it('never overwrites a number the student typed when that setting is on', () => {
        expect(decideAutofill({ settings: on, code: '33515', fieldValue: '99999', lastFilled: '23095' })).toEqual({
            action: 'skip',
            reason: 'non-empty',
        });
        expect(
            decideAutofill({
                settings: { ...on, preserveNonEmpty: false },
                code: '33515',
                fieldValue: '99999',
                lastFilled: null,
            }).action
        ).toBe('fill');
    });

    it('manual "Fill next code" works while autofill is off, but still respects typed values', () => {
        expect(
            decideAutofill({
                settings: DEFAULT_AUTOFILL,
                code: '23095',
                fieldValue: '',
                lastFilled: null,
                manual: true,
            }).action
        ).toBe('fill');
        expect(
            decideAutofill({
                settings: DEFAULT_AUTOFILL,
                code: '23095',
                fieldValue: '1',
                lastFilled: null,
                manual: true,
            }).action
        ).toBe('skip');
    });

    it('needs a valid code and a field', () => {
        expect(decideAutofill({ settings: on, code: null, fieldValue: '', lastFilled: null })).toMatchObject({
            reason: 'no-code',
        });
        expect(decideAutofill({ settings: on, code: '23095', fieldValue: null, lastFilled: null })).toMatchObject({
            reason: 'no-field',
        });
    });
});

describe('registration field detection', () => {
    const page = (body: string) => new DOMParser().parseFromString(`<html><body>${body}</body></html>`, 'text/html');

    it('finds the ADD unique field and never the drop field', () => {
        const doc = page(`
          <form><table><tr><td>Unique number to drop</td><td><input name="s_unique_drop" maxlength="5"></td></tr>
          <tr><td>Unique number to add</td><td><input name="s_unique_add" maxlength="5"></td></tr></table>
          <input type="password" name="pw"><button type="submit">Submit</button></form>`);
        expect(findUniqueAddInput(doc)?.name).toBe('s_unique_add');
    });

    it('returns null when the choice is ambiguous', () => {
        const doc = page('<input name="unique_add_1" maxlength="5"><input name="unique_add_2" maxlength="5">');
        expect(findUniqueAddInput(doc)).toBeNull();
    });

    it('fills without submitting', () => {
        const doc = page('<form id="f"><label for="u">Add unique</label><input id="u" maxlength="5"></form>');
        let submitted = false;
        doc.getElementById('f')!.addEventListener('submit', () => {
            submitted = true;
        });
        const input = findUniqueAddInput(doc)!;
        let inputEvents = 0;
        input.addEventListener('input', () => inputEvents++);
        fillInput(input, '23095');
        expect(input.value).toBe('23095');
        expect(inputEvents).toBe(1);
        expect(submitted).toBe(false);
    });
});

describe('wallpaper layout', () => {
    it('groups by weekday in time order and lists async classes separately', () => {
        const { days, asynchronous } = groupByDay(
            [
                {
                    uniqueId: 1,
                    courseCode: 'NTR 306',
                    title: 'Nutrition',
                    meetings: [{ days: ['T', 'TH'], start: 750, end: 840, location: 'PAI 3.02' }],
                    asynchronous: false,
                    color: '#000',
                },
                {
                    uniqueId: 2,
                    courseCode: 'UGS 302',
                    title: 'Signature',
                    meetings: [{ days: ['T'], start: 540, end: 630, location: 'GEA 105' }],
                    asynchronous: false,
                    color: '#111',
                },
                {
                    uniqueId: 3,
                    courseCode: 'MUS 302L',
                    title: 'Western Music',
                    meetings: [],
                    asynchronous: true,
                    color: '#222',
                },
            ],
            { showProfessor: false, showRoom: false }
        );
        expect(days.map(d => d.label)).toEqual(['TUE', 'THU']);
        expect(days[0]!.entries.map(e => e.courseCode)).toEqual(['UGS 302', 'NTR 306']);
        expect(days[0]!.entries[0]!.location).toBe('GEA');
        expect(asynchronous.map(a => a.courseCode)).toEqual(['MUS 302L']);
    });
});
