import type { DayCode } from './meetings';

/** Only exclusion wording counts: mentioning Tuesday alone does not mean avoid Tuesday. */
export function requestedDaysOff(request: string): DayCode[] {
    const fragment = request.toLowerCase().match(
        /(?:no\s+classes?(?:\s+on)?|avoid|no\s+class\s+on|not\s+on|free\s+on)\s*([^.;!?]{1,110})/
    )?.[1] ?? '';
    const days: Array<[DayCode, RegExp]> = [
        ['M', /\bmonday\b|\bmondays\b|\bmon\b/],
        ['T', /\btuesday\b|\btuesdays\b|\btue\b/],
        ['W', /\bwednesday\b|\bwednesdays\b|\bwed\b/],
        ['TH', /\bthursday\b|\bthursdays\b|\bthu\b|\bthurs\b/],
        ['F', /\bfriday\b|\bfridays\b|\bfri\b/],
        ['S', /\bsaturday\b|\bsaturdays\b|\bsat\b/],
        ['SU', /\bsunday\b|\bsundays\b|\bsun\b/],
    ];
    const excluded = days.filter(([, pattern]) => pattern.test(fragment)).map(([day]) => day);
    if (/\bmwf\b|\bm\s*\/\s*w\s*\/\s*f\b/.test(fragment)) return [...new Set([...excluded, ...(['M', 'W', 'F'] as DayCode[])])];
    return excluded;
}

