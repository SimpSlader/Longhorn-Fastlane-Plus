import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditHtml } from '../audit/parseAudit';
import { gradFacts, gradScenarios, isAdviceQuestion, mccombsStatus } from '../core/gradPlan';
import { addMemory, forgetMemory, memoryCommand, wantsMcCombs } from '../core/memory';

const realAudit = () =>
    parseAuditHtml(
        new DOMParser().parseFromString(
            readFileSync(resolve(__dirname, 'fixtures/dap-audit-results-real.html'), 'utf8'),
            'text/html'
        )
    );

describe('graduating early', () => {
    it('scenarios trade UT hours per semester against ACC hours, never past the ACC room', () => {
        const s = gradScenarios(60, 9);
        expect(s).toContainEqual({ utPerSemester: 15, accHours: 0, longSemesters: 4 });
        expect(s).toContainEqual({ utPerSemester: 18, accHours: 6, longSemesters: 3 });
        expect(Math.max(...s.map(x => x.accHours))).toBe(9);
    });

    it('builds facts from the real IDA, with McCombs status only when asked', () => {
        const audit = realAudit();
        const f = gradFacts(audit, { mccombs: true });
        expect(f.hoursRemaining).not.toBeNull();
        expect(f.scenarios.length).toBeGreaterThan(0);
        expect(f.mccombs?.prerequisites.map(p => p.name)).toEqual([
            'Calculus I',
            'Calculus II',
            'Microeconomics',
            'Macroeconomics',
            'Rhetoric & Writing',
        ]);
        expect(f.mccombs?.rules.source).toBe('https://my.mccombs.utexas.edu/bba/internal-transfer/');
        expect(gradFacts(audit, { mccombs: false }).mccombs).toBeNull();
        expect(mccombsStatus(audit).utLongSemesters).toBeGreaterThan(0);
    });

    it('tells advice questions apart from schedule requests', () => {
        for (const q of [
            'How do I graduate early?',
            'how many classes should I take through ACC',
            'Am I on track for the McCombs internal transfer?',
            'what should I take to finish my degree early',
            'Which UT classes would protect my GPA?',
            'How many classes should I take through ACC?',
            'Plan my path to graduate early',
        ])
            expect(isAdviceQuestion(q)).toBe(true);
        for (const q of [
            'Build me a schedule with no Fridays',
            'remove history',
            'make it easier',
            '15 credits Tue/Thu',
        ])
            expect(isAdviceQuestion(q)).toBe(false);
    });
});

describe('memory', () => {
    it('understands remember / from now on / forget', () => {
        expect(memoryCommand('Remember that I want to internally transfer to McCombs')).toEqual({
            add: 'I want to internally transfer to McCombs',
        });
        expect(memoryCommand('from now on prioritize classes that are mostly As.')).toEqual({
            add: 'Prioritize classes that are mostly As',
        });
        expect(memoryCommand('forget McCombs')).toEqual({ forget: 'McCombs' });
        expect(memoryCommand('forget everything')).toEqual({ forgetAll: true });
        expect(memoryCommand('make it easier')).toBeNull();
    });

    it('keeps a short list without duplicates and forgets by keyword', () => {
        let items = addMemory([], 'I want to graduate early');
        items = addMemory(items, 'i want to graduate EARLY!');
        expect(items).toHaveLength(1);
        items = addMemory(items, 'I want to internally transfer to McCombs');
        expect(wantsMcCombs(items)).toBe(true);
        expect(forgetMemory(items, 'McCombs')).toEqual(['i want to graduate EARLY!']);
    });
});

describe('graduation timelines', () => {
    const october2026 = new Date(2026, 9, 26);
    it('"graduate in 2029" from fall 2026 means five more long semesters, through Spring 2029', async () => {
        const { requestedTimeline, timelinePlans } = await import('../core/gradPlan');
        expect(requestedTimeline('I want to graduate a year early in 2029', october2026)).toEqual({
            longSemesters: 5,
            endTerm: 'Spring 2029',
        });
        expect(requestedTimeline('graduate in five semesters', october2026)).toEqual({
            longSemesters: 5,
            endTerm: 'Spring 2029',
        });
        expect(requestedTimeline('can I finish by fall 2028', october2026)).toEqual({
            longSemesters: 4,
            endTerm: 'Fall 2028',
        });
        expect(requestedTimeline('build me a schedule', october2026)).toBeNull();
        const plans = timelinePlans(80, 5, 9);
        expect(plans[0]).toEqual({ summerHours: 0, accHours: 0, perSemester: 16 });
        expect(plans[1]).toEqual({ summerHours: 6, accHours: 0, perSemester: 15 });
        expect(plans[2]).toEqual({ summerHours: 12, accHours: 0, perSemester: 14 });
        expect(plans[3]).toEqual({ summerHours: 0, accHours: 9, perSemester: 15 });
    });
});
