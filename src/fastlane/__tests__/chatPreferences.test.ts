import { describe, expect, it } from 'vitest';
import { requestedDaysOff } from '../core/chatPreferences';

describe('natural-language day exclusions', () => {
    it('detects three days in a typical scheduling request', () => {
        expect(
            requestedDaysOff('Please find classes with no classes on Monday, Wednesday, Friday; 1-2 online')
        ).toEqual(['M', 'W', 'F']);
    });
    it('supports common M/W/F shorthand and single days', () => {
        expect(requestedDaysOff('Avoid M/W/F. Prefer asynchronous courses.')).toEqual(['M', 'W', 'F']);
        expect(requestedDaysOff('No class on Tuesday and Thursday.')).toEqual(['T', 'TH']);
    });
    it('does not interpret a mentioned day as a prohibited day', () => {
        expect(requestedDaysOff('I can take classes Monday and Tuesday.')).toEqual([]);
    });
});
