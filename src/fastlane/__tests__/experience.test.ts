import { describe, expect, it } from 'vitest';
import { runTool } from '../core/agentTools';
import { renderPlanReply } from '../core/planReply';
import { registrationText, uniqueNumbers } from '../core/registrationText';
import { validateBuildArgs, validateModifyArgs } from '../core/toolArgs';
import { catalog, makeContext } from './nl/fixture';

describe('registration text', () => {
    const picks = [catalog[0]!, catalog[3]!, catalog[11]!];
    it('leads each line with the 5-digit unique number and says when seats were last seen', () => {
        const text = registrationText(picks, 'Spring 2027');
        const lines = text.split('\n').filter(l => /^\d{5}\s/.test(l));
        expect(lines.map(l => l.slice(0, 5))).toEqual(['00001', '00004', '00012']);
        expect(text).toMatch(/open as last seen 2026-10-30/);
        expect(text).toMatch(/never live/);
        expect(uniqueNumbers(picks)).toBe('00001, 00004, 00012');
    });
    it('does not claim seat status for a section that was never checked', () => {
        const unchecked = { ...catalog[0]!, status: undefined };
        expect(registrationText([unchecked])).toContain('seats not checked');
    });
});

describe('tool arguments are never silently dropped', () => {
    it('a follow-up can change any rule the first request could set', () => {
        for (const args of [
            { latestEnd: '3:30 pm' },
            { exactCounts: { UGS: 0 } },
            { dayWindows: { T: { from: '11:00 am' } } },
            { onlineMax: 1 },
        ])
            expect(validateModifyArgs(args).ok).toBe(true);
    });
    it('an unknown argument is reported back to the model, not ignored', () => {
        const r = validateBuildArgs({ minCredits: 15, maxOnline: 2 });
        expect(r.ok).toBe(false);
        expect(JSON.stringify(r)).toMatch(/maxOnline.*not an argument/);
        expect(validateModifyArgs({ sectionGoal: 'sparkly' }).ok).toBe(false);
    });
});

describe('what the student sees', () => {
    it('shows RMP next to grades, "none on file" when there is no rating, and when seats were last seen', async () => {
        const out = await runTool(
            'build_schedule',
            { minCredits: 12, maxCredits: 12, onlyDays: ['T', 'TH'], allowElectives: true, onlineMax: 2 },
            makeContext()
        );
        const text = renderPlanReply(out.result as never);
        // one markdown table block (blank lines between rows would break it)
        const table = text.split('\n\n').find(b => b.startsWith('| Class'))!;
        expect(table.split('\n').length).toBe(2 + out.plan!.sections.length);
        expect(table).toMatch(/Rate My Professors \| Seats/);
        expect(table).toMatch(/none on file|\/5, difficulty/);
        expect(table).toMatch(/open when viewed 2026-10-30|not checked/);
    });

    it('offers GPA / convenience / degree versions that are different and independently validated', async () => {
        const out = await runTool(
            'build_schedule',
            { minCredits: 15, maxCredits: 15, onlyDays: ['T', 'TH'], allowElectives: true, onlineMax: 2 },
            makeContext()
        );
        const main = out
            .plan!.sections.map(s => s.uniqueId)
            .sort()
            .join();
        expect(out.plan!.alternatives!.length).toBeGreaterThan(0);
        for (const alt of out.plan!.alternatives!) {
            expect(alt.validation.hardOk).toBe(true);
            expect(
                alt.sections
                    .map(s => s.uniqueId)
                    .sort()
                    .join()
            ).not.toBe(main);
        }
    });
});

describe('follow-up fixes found by the live run', () => {
    const rules = {
        minCredits: 15,
        maxCredits: 15,
        onlyDays: ['T', 'TH'],
        includeSubjects: ['UGS'],
        allowElectives: true,
        onlineMax: 2,
    };
    it('dropping the only signature course lowers the exact UGS count instead of making the request impossible', async () => {
        const built = await runTool('build_schedule', rules, makeContext());
        const current = {
            sections: built.plan!.sections,
            constraints: built.plan!.constraints,
            pool: built.plan!.pool,
        };
        const dropped = await runTool('modify_schedule', { remove: ['UGS 302'] }, makeContext({ current }));
        expect(dropped.plan).toBeDefined();
        expect(dropped.plan!.sections.some(s => s.courseCode.startsWith('UGS'))).toBe(false);
        expect(dropped.plan!.constraints.subjectCounts).toEqual({ UGS: 0 });
        expect(dropped.plan!.validation.credits).toBe(15);
    });
    it('a made-up department code resolves to the one real course of that subject, and the table shows which', async () => {
        const built = await runTool('build_schedule', { ...rules, includeSubjects: [] }, makeContext());
        const current = {
            sections: built.plan!.sections,
            constraints: built.plan!.constraints,
            pool: built.plan!.pool,
        };
        const added = await runTool('modify_schedule', { addCourse: 'NUTR 301' }, makeContext({ current }));
        if (added.plan) expect(added.plan.sections.map(s => s.courseCode)).toContain('NTR 306');
        else expect(JSON.stringify(added.result)).toMatch(/only be added|NOT added|credit hours/);
        expect(JSON.stringify(added.result)).not.toMatch(/matches “NUTR 301”/);
    });
});

describe('electives: degree first, then labelled electives to reach the credit total', () => {
    const ask = { minCredits: 15, maxCredits: 15, onlyDays: ['T', 'TH'], onlineMax: 2 }; // electives never mentioned

    it('fills the credit total with electives by default and labels each one', async () => {
        const out = await runTool('build_schedule', ask, makeContext());
        expect(out.plan).toBeDefined();
        const r = out.result as {
            classes: Array<{ code: string; kind: string; countsToward: string[] }>;
            electives: { count: number; hours: number };
        };
        expect(r.classes.filter(c => c.kind === 'requirement').every(c => c.countsToward.length > 0)).toBe(true);
        expect(r.classes.filter(c => c.kind === 'elective').every(c => c.countsToward.length === 0)).toBe(true);
        expect(r.electives.count).toBe(r.classes.filter(c => c.kind === 'elective').length);
        const text = renderPlanReply(out.result as never);
        if (r.electives.count) {
            expect(text).toMatch(/Elective: counts toward total credit hours only/);
            expect(text).toMatch(/do \*\*not\*\* satisfy any unmet degree requirement/);
        }
        expect(out.plan!.validation.hardOk).toBe(true);
    });

    it('degree requirements outrank electives even when the elective has much better grades', async () => {
        const [ugs303, psyEasy] = [catalog.find(s => s.uniqueId === 2)!, catalog.find(s => s.uniqueId === 28)!];
        // same slot: UGS 303 fills an unmet requirement (MID grades); PSY 301 is an elective with EASY grades
        const out = await runTool(
            'build_schedule',
            { minCredits: 3, maxCredits: 3, onlyDays: ['T', 'TH'] },
            makeContext({ catalog: [ugs303, psyEasy] })
        );
        expect(out.plan!.sections.map(s => s.courseCode)).toEqual(['UGS 303']);
    });

    it('a student who says no electives is never given them silently', async () => {
        const out = await runTool(
            'build_schedule',
            { ...ask, minCredits: 21, maxCredits: 21, allowElectives: false },
            makeContext()
        );
        // whether it finds a smaller schedule or a labelled draft, no elective is ever slipped in
        for (const c of (out.result as { classes?: Array<{ kind: string }> }).classes ?? [])
            expect(c.kind).not.toBe('elective');
        if (out.plan)
            expect(out.plan.validation.credits === 21 && !out.plan.validation.allRulesMet).toBe(
                out.plan.validation.credits === 21
            );
    });

    it('a class the student asked for by name is labelled as requested, not as a degree requirement', async () => {
        const out = await runTool('build_schedule', { ...ask, requiredCourses: ['ECO 304L'] }, makeContext());
        const eco = (out.result as { classes: Array<{ code: string; kind: string }> }).classes.find(
            c => c.code === 'ECO 304L'
        );
        expect(eco?.kind).toBe('requested');
        expect(renderPlanReply(out.result as never)).toMatch(/Requested by you: no unmet requirement/);
    });
});
