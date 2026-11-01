/**
 * Live end-to-end benchmark: the REAL Fastlane AI endpoint (the free Groq model behind it) drives the REAL tools,
 * solver and validator over the synthetic Spring 2027 world, through genuine multi-turn conversations. Each turn is
 * graded on the schedule that results — not on how the model phrased its tool call — with the same checker the
 * engine benchmark uses.
 *
 * Skipped unless NL_LIVE=1. Needs FASTLANE_AI_CODE (read from the environment only, never printed or written).
 * Point it at a protected preview with FASTLANE_AI_URL=https://<preview>/api and FASTLANE_PREVIEW_SHARE_URL=<the
 * deployment's share link>; the link is exchanged for a short-lived cookie in memory and is not logged or saved.
 * NL_LIVE_REPORT=<path> writes per-turn results, tool calls, latency and rate-limit counts.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../core/agentTools';
import { formatMeeting } from '../core/meetings';
import { constraintsFromRules, statedRules } from '../core/plannerRules';
import { forModel, isPlanResult, renderPlanReply } from '../core/planReply';
import type { SectionRecord } from '../core/sections';
import { UT_SUBJECTS } from '../data/subjects';
import { cases, type Expect } from './nl/cases';
import { preservationProblems, problems } from './nl/check';
import { makeContext } from './nl/fixture';

const LIVE = process.env.NL_LIVE === '1';
const BASE = process.env.FASTLANE_AI_URL ?? 'https://longhorn-fastlane-plus.vercel.app/api';
const CODE = process.env.FASTLANE_AI_CODE ?? '';
const SUBJECTS = new Set(UT_SUBJECTS.map(s => s.code));
const pad = (n: number) => String(n).padStart(5, '0');
const LIMIT = Number(process.env.NL_LIMIT ?? Infinity);
/** NL_ONLY=F02,M05,… runs just those cases, in that order (to spend a limited daily quota on what matters) */
const ONLY = process.env.NL_ONLY?.split(',').map(x => x.trim());
/** set once the provider's free DAILY limit is gone: nothing more is sent, remaining turns are reported as untested */
let quotaGone = false;

interface Stat {
    status: number;
    ms: number;
    chars: number;
    waited: number;
    provider?: string;
    model?: string;
}
const stats: Stat[] = [];
const rows: Array<{
    id: string;
    category: string;
    turn: number;
    say: string;
    ok: boolean;
    problems: string[];
    calls: Array<{ name: string; args: unknown }>;
    rounds: number;
    http: number[];
    untested?: boolean;
}> = [];
let cookie = '';

async function signIn() {
    const share = process.env.FASTLANE_PREVIEW_SHARE_URL;
    if (!share) return;
    const res = await fetch(share, { redirect: 'manual' });
    cookie = res.headers
        .getSetCookie()
        .map(c => c.split(';')[0])
        .join('; ');
    if (!cookie) throw new Error('The preview share link did not produce a session (expired?).');
}

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const text = JSON.stringify(body);
    for (let tries = 0, waited = 0; ; tries++) {
        const started = Date.now();
        const res = await fetch(`${BASE}/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
            body: text,
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
            meta?: { provider?: string; model?: string };
            retryAfterSeconds?: number;
        };
        stats.push({
            status: res.status,
            ms: Date.now() - started,
            chars: text.length,
            waited,
            provider: json.meta?.provider,
            model: json.meta?.model,
        });
        if (res.status === 503 && /daily free limit/i.test(JSON.stringify(json))) {
            quotaGone = true;
            return { status: res.status, json };
        }
        if ((res.status === 429 || res.status === 503) && tries < 6) {
            const wait = Math.min(45, Math.max(3, Math.ceil(json.retryAfterSeconds ?? 8)));
            waited += wait;
            await new Promise(ok => setTimeout(ok, wait * 1000));
            continue;
        }
        return { status: res.status, json };
    }
}

interface Msg {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    tool_call_id?: string;
}

describe.skipIf(!LIVE)('live model through the real tools (multi-turn)', () => {
    afterAll(() => {
        const passed = rows.filter(r => r.ok).length;
        const ms = stats.map(s => s.ms).sort((a, b) => a - b);
        const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0;
        const summary = {
            at: new Date().toISOString(),
            endpoint: BASE.replace(/\/\/[^/]*preview[^/]*/, '//<preview>'),
            turnsPassed: passed,
            turnsTotal: rows.filter(r => !r.untested).length,
            turnsUntested: rows.filter(r => r.untested).length,
            quotaExhausted: quotaGone,
            requests: stats.length,
            http: Object.fromEntries(
                [...new Set(stats.map(s => s.status))].map(code => [code, stats.filter(s => s.status === code).length])
            ),
            latencyMs: { p50: pct(0.5), p95: pct(0.95), max: ms.at(-1) ?? 0 },
            secondsWaitedForRateLimits: stats.reduce((n, s) => n + (s.waited ?? 0), 0),
            requestChars: {
                median: stats.map(s => s.chars).sort((a, b) => a - b)[Math.floor(stats.length / 2)] ?? 0,
                max: Math.max(0, ...stats.map(s => s.chars)),
            },
            models: [...new Set(stats.map(s => s.model).filter(Boolean))],
            byCategory: Object.fromEntries(
                [...new Set(rows.map(r => r.category))].map(category => {
                    const mine = rows.filter(r => r.category === category);
                    return [category, { ok: mine.filter(r => r.ok).length, total: mine.length }];
                })
            ),
        };
        if (process.env.NL_LIVE_REPORT)
            writeFileSync(process.env.NL_LIVE_REPORT, JSON.stringify({ ...summary, rows }, null, 2));
        console.info(JSON.stringify(summary));
    });

    const chosen = ONLY
        ? ONLY.map(id => cases.find(c => c.id === id)).filter((c): c is (typeof cases)[number] => !!c)
        : cases.slice(0, LIMIT);
    for (const c of chosen)
        it(`${c.id} · ${c.category}: ${c.turns[0]!.say.slice(0, 60)}`, async () => {
            if (!CODE) throw new Error('Set FASTLANE_AI_CODE');
            if (c.id === cases[0]!.id) await signIn();
            const history: Msg[] = [];
            const said: string[] = [];
            let current: ToolContext['current'] = null;
            const all: string[] = [];
            for (const [i, turn] of c.turns.entries()) {
                if (quotaGone) {
                    // the free daily limit is gone: report this turn as untested rather than as a model failure
                    rows.push({
                        id: c.id,
                        category: c.category,
                        turn: i + 1,
                        say: turn.say,
                        ok: false,
                        untested: true,
                        problems: ['untested: provider daily limit reached'],
                        calls: [],
                        rounds: 0,
                        http: [],
                    });
                    continue;
                }
                said.push(turn.say);
                const stated = constraintsFromRules(statedRules(said, SUBJECTS, UT_SUBJECTS), 'Spring 2027');
                const ctx = makeContext({ stated, current });
                const onScreen = (current?.sections ?? [])
                    .map(
                        s =>
                            `${s.courseCode} (${pad(s.uniqueId)}) ${s.meetings.length ? s.meetings.map(formatMeeting).join('; ') : 'online'} ${s.instructors.join(', ')}`
                    )
                    .join(' | ');
                const messages: Msg[] = [...history, { role: 'user', content: turn.say }];
                const calls: Array<{ name: string; args: unknown }> = [];
                const http: number[] = [];
                let outcome: Awaited<ReturnType<typeof runTool>> | null = null;
                let finalText = '';
                let rounds = 0;
                for (; rounds < 7; rounds++) {
                    const { status, json } = await post({
                        accessCode: CODE,
                        messages,
                        context: {
                            today: 'Sat Oct 31 2026',
                            currentTerm: 'Fall 2026',
                            planningTerm: 'Spring 2027',
                            memory: [],
                            confirmed: '',
                            scheduleOnScreen: onScreen,
                            steps: rounds,
                        },
                        routing: { mode: 'auto', model: '', disabledProviders: [] },
                    });
                    http.push(status);
                    if (status !== 200) {
                        all.push(`turn ${i + 1}: HTTP ${status} ${String(json.error ?? '').slice(0, 80)}`);
                        break;
                    }
                    if (json.type !== 'tool_calls') {
                        finalText = String(json.text ?? '');
                        break;
                    }
                    const tc = json.calls as NonNullable<Msg['tool_calls']>;
                    messages.push({ role: 'assistant', content: String(json.text ?? ''), tool_calls: tc });
                    for (const call of tc) {
                        calls.push({ name: call.name, args: call.arguments });
                        const out = await runTool(call.name, call.arguments, {
                            ...ctx,
                            current: outcome?.plan
                                ? {
                                      sections: outcome.plan.sections,
                                      constraints: outcome.plan.constraints,
                                      pool: outcome.plan.pool,
                                  }
                                : current,
                        });
                        if (call.name === 'build_schedule' || call.name === 'modify_schedule') outcome = out;
                        const text = JSON.stringify(forModel(out.result) ?? null);
                        messages.push({
                            role: 'tool',
                            tool_call_id: call.id,
                            content: text.length > 4000 ? `${text.slice(0, 4000)}… (trimmed)` : text,
                        });
                    }
                }
                if (quotaGone && !outcome && !finalText) {
                    rows.push({
                        id: c.id,
                        category: c.category,
                        turn: i + 1,
                        say: turn.say,
                        ok: false,
                        untested: true,
                        problems: ['untested: provider daily limit reached'],
                        calls,
                        rounds,
                        http,
                    });
                    continue;
                }
                const expect_: Expect = {
                    ...turn.expect,
                    electivesDraftOk:
                        turn.expect.electivesDraftOk ??
                        (turn.args.allowElectives === true &&
                            !/elective|easy|gpa|whatever|anything|mix|fun|light|good|full load|few days|normal/i.test(
                                turn.say
                            )),
                };
                const graded = outcome ?? { result: { error: 'the model did not call a schedule tool' } };
                const found = problems(expect_, graded as never, current?.sections ?? null, s =>
                    ((graded.plan?.pool ?? []).find(p => p.section.uniqueId === s.uniqueId)?.applies ?? []).filter(t =>
                        /^CORE \d{3}$/.test(t)
                    )
                ).map(p => `turn ${i + 1}: ${p}`);
                rows.push({
                    id: c.id,
                    category: c.category,
                    turn: i + 1,
                    say: turn.say,
                    ok: found.length === 0,
                    problems: found,
                    calls,
                    rounds,
                    http,
                });
                all.push(...found);
                if (process.env.NL_LIVE_PROGRESS)
                    appendFileSync(
                        process.env.NL_LIVE_PROGRESS,
                        `${c.id} turn ${i + 1}: ${found.length ? `FAIL ${found.join(' | ').slice(0, 160)}` : 'ok'} (${stats.length} requests, ${stats.filter(x => x.status >= 429).length} rate-limited)\n`
                    );
                if (outcome?.plan)
                    current = {
                        sections: outcome.plan.sections,
                        constraints: outcome.plan.constraints,
                        pool: outcome.plan.pool,
                    };
                const shown = outcome && isPlanResult(outcome.result) ? renderPlanReply(outcome.result) : finalText;
                history.push({ role: 'user', content: turn.say }, { role: 'assistant', content: shown.slice(0, 1500) });
            }
            expect(all.filter(p => !p.includes('untested'))).toEqual([]);
        }, 900_000);
});
