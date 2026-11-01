/**
 * Natural-language benchmark, engine half: every case's gold tool calls run through the real tools, solver and
 * validator across multi-turn conversations. It proves the scheduling engine and follow-up semantics behave for
 * ~60 differently phrased requests. It does NOT prove a live model produces those calls — see
 * scripts/fastlane/nl-benchmark.mjs for that.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../core/agentTools';
import { constraintsFromRules, statedRules } from '../core/plannerRules';
import type { SectionRecord } from '../core/sections';
import { UT_SUBJECTS } from '../data/subjects';
import { type Case, cases } from './nl/cases';
import { preservationProblems, problems } from './nl/check';
import { makeContext } from './nl/fixture';

const SUBJECTS = new Set(UT_SUBJECTS.map(s => s.code));
const rows: Array<{ id: string; category: string; turns: number; ok: boolean; problems: string[] }> = [];

describe('natural-language benchmark (gold interpretations through the real engine)', () => {
    for (const c of cases satisfies Case[])
        it(`${c.id} · ${c.category}: ${c.turns[0]!.say.slice(0, 70)}`, async () => {
            const said: string[] = [];
            let current: ToolContext['current'] = null;
            let before: SectionRecord[] | null = null;
            const all: string[] = [];
            for (const [i, turn] of c.turns.entries()) {
                said.push(turn.say);
                const stated = constraintsFromRules(statedRules(said, SUBJECTS, UT_SUBJECTS), 'Spring 2027');
                const ctx = makeContext({ stated, current });
                const out = await runTool(turn.tool, turn.args, ctx);
                const byId = new Map((out.plan?.pool ?? []).map(p => [p.section.uniqueId, p.applies]));
                const found = problems(turn.expect, out, before, s =>
                    (byId.get(s.uniqueId) ?? []).filter(t => /^CORE \d{3}$/.test(t))
                ).map(p => `turn ${i + 1}: ${p}`);
                all.push(...found);
                if (out.plan && current && turn.tool === 'modify_schedule')
                    all.push(
                        ...preservationProblems(current.constraints, out.plan.constraints, turn.args).map(
                            p => `turn ${i + 1}: ${p}`
                        )
                    );
                if (out.plan) {
                    // keep the rest of the conversation honest: a follow-up's "before" is what was last shown
                    before = current?.sections ?? null;
                    current = { sections: out.plan.sections, constraints: out.plan.constraints, pool: out.plan.pool };
                    if (turn.tool === 'modify_schedule') before = out.plan.sections && before;
                }
            }
            rows.push({ id: c.id, category: c.category, turns: c.turns.length, ok: all.length === 0, problems: all });
            expect(all).toEqual([]);
        }, 120_000);

    it('exports the gold cases for the live-model script', () => {
        if (process.env.NL_EXPORT)
            writeFileSync(
                process.env.NL_EXPORT,
                JSON.stringify(
                    cases.map(c => ({
                        id: c.id,
                        category: c.category,
                        turns: c.turns.map(t => ({ say: t.say, tool: t.tool, args: t.args })),
                    })),
                    null,
                    1
                )
            );
        expect(cases.length).toBeGreaterThanOrEqual(50);
    });

    it('summary', () => {
        const passed = rows.filter(r => r.ok).length;
        if (process.env.NL_REPORT)
            writeFileSync(process.env.NL_REPORT, JSON.stringify({ passed, total: rows.length, rows }, null, 2));
        expect(rows.length).toBe(cases.length);
    });
});
