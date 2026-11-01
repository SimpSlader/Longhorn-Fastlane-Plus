#!/usr/bin/env node
/**
 * Live natural-language benchmark: sends each case's student message to the REAL Fastlane AI endpoint and scores
 * the tool call the model makes against the gold interpretation. It measures interpretation only (did the model
 * set the right constraints?); the scheduling engine is covered by src/fastlane/__tests__/nlBenchmark.test.ts.
 *
 *   NL_EXPORT=scripts/fastlane/nl-cases.json npx vitest run src/fastlane/__tests__/nlBenchmark.test.ts   # once
 *   FASTLANE_AI_CODE=...  node scripts/fastlane/nl-benchmark.mjs [--limit 10] [--url https://.../api]
 *
 * The access code is read from the environment only; it is never printed or written to the report. Each turn is a
 * separate request, so a multi-turn case sends the earlier student messages as history. Free-tier rate limits
 * apply: 429s are waited out (bounded). Results go to reports/nl-benchmark-live.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const code = process.env.FASTLANE_AI_CODE;
if (!code) {
    console.error('Set FASTLANE_AI_CODE (your Fastlane AI access code). Nothing was sent.');
    process.exit(2);
}
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const base =
    (process.argv.includes('--url') ? arg('--url') : process.env.FASTLANE_AI_URL) ??
    'https://longhorn-fastlane-plus.vercel.app/api';
const limit = process.argv.includes('--limit') ? Number(arg('--limit')) : Infinity;
const cases = JSON.parse(readFileSync(new URL('./nl-cases.json', import.meta.url), 'utf8')).slice(0, limit);

const DAYS = {
    M: 'M',
    MON: 'M',
    MONDAY: 'M',
    T: 'T',
    TU: 'T',
    TUE: 'T',
    TUES: 'T',
    TUESDAY: 'T',
    W: 'W',
    WED: 'W',
    WEDNESDAY: 'W',
    TH: 'TH',
    THU: 'TH',
    THUR: 'TH',
    THURS: 'TH',
    THURSDAY: 'TH',
    F: 'F',
    FRI: 'F',
    FRIDAY: 'F',
};
const days = v =>
    [
        ...new Set(
            (v ?? [])
                .map(
                    d =>
                        DAYS[
                            String(d)
                                .toUpperCase()
                                .replace(/[^A-Z]/g, '')
                        ]
                )
                .filter(Boolean)
        ),
    ]
        .sort()
        .join(',');
const minutes = v => {
    const m = String(v ?? '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let h = Number(m[1]);
    if (/pm/i.test(m[3] ?? '') && h < 12) h += 12;
    return h * 60 + Number(m[2] ?? 0);
};
const norm = s =>
    String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
const set = v => (v ?? []).map(norm).sort().join(',');

/** Each scorer returns true/false for a field the gold call sets; fields the gold leaves out are not scored. */
const SCORERS = {
    minCredits: (g, m) => Number(m.minCredits ?? m.changeCredits?.min) === Number(g),
    maxCredits: (g, m) => Number(m.maxCredits ?? m.changeCredits?.max) === Number(g),
    changeCredits: (g, m) => Number(m.changeCredits?.min ?? m.minCredits) === Number(g.min),
    onlyDays: (g, m) => (g.length ? days(g) === days(m.onlyDays ?? m.changeOnlyDays) : !m.onlyDays),
    changeOnlyDays: (g, m) => days(g) === days(m.changeOnlyDays ?? m.onlyDays),
    avoidDays: (g, m) => days(g) === days(m.avoidDays),
    onlineMax: (g, m) => Number(m.onlineMax) === Number(g),
    coreOnly: (g, m) => Boolean(m.coreOnly) === Boolean(g),
    allowElectives: (g, m) => Boolean(m.allowElectives) === Boolean(g),
    objective: (g, m) => m.objective === g,
    includeSubjects: (g, m) =>
        set(g) === set(m.includeSubjects) || Boolean(m.exactCounts && g.every(x => m.exactCounts[x] === 1)),
    excludeSubjects: (g, m) => g.every(x => (m.excludeSubjects ?? []).map(norm).includes(norm(x))),
    exactCounts: (g, m) => Object.entries(g).every(([k, v]) => Number(m.exactCounts?.[k]) === Number(v)),
    requiredCourses: (g, m) =>
        g.every(x => (m.requiredCourses ?? []).some(y => norm(y).includes(norm(x)) || norm(x).includes(norm(y)))),
    earliestStart: (g, m) => minutes(m.earliestStart) === minutes(g),
    latestEnd: (g, m) => minutes(m.latestEnd) === minutes(g),
    dayWindows: (g, m) =>
        Object.entries(g).every(
            ([d, w]) => minutes(m.dayWindows?.[d]?.from ?? m.dayWindows?.[d.toUpperCase()]?.from) === minutes(w.from)
        ),
    remove: (g, m) => g.every(x => (m.remove ?? []).map(norm).includes(norm(x))),
    addCourse: (g, m) => norm(m.addCourse ?? '').length > 0,
    anotherOption: (g, m) => Boolean(m.anotherOption) === Boolean(g),
    swapSectionFor: (g, m) => norm(m.swapSectionFor ?? '').length > 0,
    sectionGoal: (g, m) => m.sectionGoal === g,
    replaceCourse: (g, m) => norm(m.replaceCourse ?? '').length > 0,
};
/** Hard rules the gold does NOT set: a model that adds them has invented a restriction the student never gave. */
const INVENTED = [
    'coreOnly',
    'onlyDays',
    'avoidDays',
    'excludeSubjects',
    'requiredCourses',
    'onlineMax',
    'exactCounts',
    'latestEnd',
    'earliestStart',
];

async function ask(history, text, onScreen) {
    const body = {
        accessCode: code,
        messages: [...history, { role: 'user', content: text }],
        context: {
            today: new Date().toDateString(),
            currentTerm: 'Fall 2026',
            planningTerm: 'Spring 2027',
            memory: [],
            confirmed: '',
            scheduleOnScreen: onScreen,
            steps: 0,
        },
        routing: { mode: 'auto', model: '', disabledProviders: [] },
    };
    for (let tries = 0; tries < 4; tries++) {
        const res = await fetch(`${base}/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 429) {
            await new Promise(r => setTimeout(r, Math.min(25, json.retryAfterSeconds ?? 10) * 1000));
            continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return json;
    }
    throw new Error('rate limited');
}

const rows = [];
for (const c of cases) {
    const history = [];
    let onScreen = '';
    for (const [i, t] of c.turns.entries()) {
        let call = null;
        let note = '';
        try {
            const reply = await ask(history, t.say, onScreen);
            call =
                reply.type === 'tool_calls'
                    ? reply.calls?.find(x => x.name === 'build_schedule' || x.name === 'modify_schedule')
                    : null;
            if (!call)
                note = reply.type === 'answer' ? 'answered without calling a schedule tool' : 'no schedule tool call';
        } catch (e) {
            note = `request failed: ${e.message}`;
        }
        const got = call?.arguments ?? {};
        const wrong = [];
        if (!call) wrong.push(note);
        else {
            if (call.name !== t.tool) wrong.push(`used ${call.name}, expected ${t.tool}`);
            for (const [k, g] of Object.entries(t.args)) {
                const score = SCORERS[k];
                if (score && !score(g, got))
                    wrong.push(`${k}: expected ${JSON.stringify(g)}, got ${JSON.stringify(got[k] ?? null)}`);
            }
            for (const k of INVENTED)
                if (
                    !(k in t.args) &&
                    got[k] != null &&
                    JSON.stringify(got[k]) !== '[]' &&
                    JSON.stringify(got[k]) !== 'false' &&
                    !(k === 'onlyDays' && 'avoidDays' in t.args)
                )
                    wrong.push(`invented ${k}: ${JSON.stringify(got[k])}`);
        }
        rows.push({ id: c.id, category: c.category, turn: i + 1, say: t.say, ok: wrong.length === 0, wrong });
        history.push(
            { role: 'user', content: t.say },
            { role: 'assistant', content: 'Here is your updated schedule.' }
        );
        onScreen = 'a schedule is on screen (built from the earlier requests)';
        process.stdout.write(wrong.length ? 'x' : '.');
    }
}
const pass = rows.filter(r => r.ok).length;
const by = {};
for (const r of rows)
    (by[r.category] ??= { ok: 0, total: 0 }), (by[r.category].total += 1), (by[r.category].ok += r.ok ? 1 : 0);
mkdirSync('reports', { recursive: true });
writeFileSync(
    'reports/nl-benchmark-live.json',
    JSON.stringify(
        { at: new Date().toISOString(), endpoint: base, passed: pass, total: rows.length, byCategory: by, rows },
        null,
        2
    )
);
console.log(`\n${pass}/${rows.length} turns interpreted correctly`, by);
