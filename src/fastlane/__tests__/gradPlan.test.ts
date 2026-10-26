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
