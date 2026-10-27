/**
 * AI dashboard in Settings: which AI providers Fastlane can use right now, how close each model is to its free
 * limits (Fastlane's own counts against the published limits; the provider's console is the real source), how
 * requests were routed, and the student's router settings. No keys or prompts are ever shown or stored here.
 */
import { useEffect, useState } from 'react';
import { requestAi } from '../services/aiClient';
import {
    FastlaneAiAccessStore,
    FastlaneAiUsageStore,
    FastlanePersonalAiStore,
    FastlaneSettingsStore,
} from '../storage/stores';

interface ModelStatus {
    id: string;
    provider: string;
    label: string;
    tier: string;
    maxLevel: number;
    limits: { rpm?: number; rpd?: number; tpm?: number; tpd?: number; neuronsPerDay?: number };
    today: { requests: number; tokens: number; neurons: number };
    stats: {
        ok?: number;
        invalid?: number;
        failed?: number;
        rateLimited?: number;
        latencyMs?: number;
        lastOk?: number;
        lastErrorCategory?: string;
    };
    cooldownUntil: number;
    cooldownReason: string;
    trainsOnFreeTier: boolean;
}
interface Status {
    strictFreeTier: boolean;
    storage: 'memory' | 'persistent';
    providers: Record<string, { configured: boolean; eligible: boolean; reason: string }>;
    models: ModelStatus[];
    decisions: Array<{
        at: number;
        task: string;
        level: number;
        model: string | null;
        ok: boolean;
        cached?: boolean;
        fallback?: boolean;
        reason: string;
    }>;
    totals: Record<string, number>;
    openai: { enabled: boolean; reason: string };
}

const PROVIDERS: Array<[string, string]> = [
    ['groq', 'Groq'],
    ['gemini', 'Google Gemini'],
    ['cloudflare', 'Cloudflare Workers AI'],
    ['openai', 'OpenAI (Sign in with ChatGPT)'],
];
const ago = (t?: number) => {
    if (!t) return 'never';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1
        ? 'just now'
        : m < 60
          ? `${m} min ago`
          : m < 1440
            ? `${Math.round(m / 60)} h ago`
            : `${Math.round(m / 1440)} d ago`;
};

export default function AiDashboard() {
    const code = FastlaneAiAccessStore.useStore(s => s.accessCode);
    const personal = FastlanePersonalAiStore.useStore(s => s);
    const settings = FastlaneSettingsStore.useStore(s => s);
    const events = FastlaneAiUsageStore.useStore(s => s.events) ?? [];
    const [status, setStatus] = useState<Status | null>(null);
    const [error, setError] = useState('');
    const [testing, setTesting] = useState('');
    const [tests, setTests] = useState<Record<string, string>>({});

    const load = async () => {
        if (!code || personal.enabled) return;
        setError('');
        try {
            const res = await requestAi('ai-status', { accessCode: code });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
            setStatus(body as Status);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not reach Fastlane’s AI server.');
        }
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: load once per access code
    useEffect(() => {
        void load();
    }, [code, personal.enabled]);

    const test = async (provider: string) => {
        setTesting(provider);
        try {
            const res = await requestAi('ai-status', { accessCode: code, test: provider });
            const body = await res.json();
            setTests(t => ({ ...t, [provider]: body.ok ? `Working. ${body.message}` : (body.message ?? body.error) }));
            await load();
        } finally {
            setTesting('');
        }
    };
    const disabled = settings.aiDisabledProviders ?? [];
    const toggle = (p: string) =>
        void FastlaneSettingsStore.set(
            'aiDisabledProviders',
            disabled.includes(p) ? disabled.filter(x => x !== p) : [...disabled, p]
        );

    const local = events.filter(e => e.local).length;
    const remote = events.filter(e => !e.local);
    const byProvider = remote.reduce<Record<string, number>>((acc, e) => {
        const k = e.ok ? (e.provider ?? 'unknown') : 'failed';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
    }, {});

    if (personal.enabled)
        return (
            <div className='card stack ai-dashboard'>
                <h2>AI assistant</h2>
                <p className='small muted'>
                    Your own key is active. Use Test connection above to check it. AI requests go directly to your
                    selected provider; your provider controls its quota. Questions about your own records are still
                    answered locally.
                </p>
                <p className='small'>
                    {local} local answers · {remote.filter(e => e.ok).length} successful AI requests
                </p>
            </div>
        );

    return (
        <div className='card stack ai-dashboard'>
            <div className='row between'>
                <h2>AI assistant</h2>
                <button type='button' className='btn sm' onClick={() => void load()} disabled={!code}>
                    Refresh
                </button>
            </div>
            <p className='small muted' style={{ margin: 0 }}>
                Fastlane picks a free AI model for each request, skips models that are rate limited or failing, and
                never switches to paid usage. Questions about your own records (hours, GPA, current classes) are
                answered in your browser without any AI.
            </p>
            <label className='field'>
                How Fastlane chooses a model
                <select
                    value={settings.aiRouting ?? 'auto'}
                    onChange={e => void FastlaneSettingsStore.set('aiRouting', e.target.value as never)}
                >
                    <option value='auto'>Automatic (recommended)</option>
                    <option value='fastest'>Fastest response</option>
                    <option value='quality'>Highest measured quality</option>
                    <option value='preserve'>Save free quota</option>
                    <option value='manual'>One model (for testing)</option>
                </select>
            </label>
            {settings.aiRouting === 'manual' && (
                <label className='field'>
                    Model
                    <select
                        value={settings.aiManualModel ?? ''}
                        onChange={e => void FastlaneSettingsStore.set('aiManualModel', e.target.value)}
                    >
                        <option value=''>Choose…</option>
                        {(status?.models ?? []).map(m => (
                            <option key={m.id} value={m.id}>
                                {m.label}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {!code && <p className='notice small'>Enter your beta code in Find classes once to see the AI status.</p>}
            {error && <p className='notice warn small'>{error}</p>}
            {status && (
                <>
                    <p className='small muted' style={{ margin: 0 }}>
                        Strict free mode is <b>{status.strictFreeTier ? 'on' : 'off'}</b>. Usage counts are{' '}
                        {status.storage === 'persistent'
                            ? 'kept across server restarts'
                            : 'kept per server instance (add a KV store in Vercel to keep them across restarts)'}
                        ; they are Fastlane’s own counts against published free limits, not a billing statement.
                    </p>
                    <div className='ai-providers'>
                        {PROVIDERS.map(([id, label]) => {
                            const p = status.providers[id];
                            const models = status.models.filter(m => m.provider === id);
                            const cooling = models.some(m => m.cooldownUntil);
                            const badge =
                                id === 'openai'
                                    ? 'Unavailable'
                                    : !p?.configured
                                      ? 'Not set up'
                                      : !p.eligible
                                        ? 'Off'
                                        : disabled.includes(id)
                                          ? 'Turned off'
                                          : cooling
                                            ? 'Rate limited'
                                            : 'Connected';
                            return (
                                <section key={id} className='ai-provider' aria-label={label}>
                                    <div className='row between'>
                                        <b>{label}</b>
                                        <span className={`fl-pill ${badge === 'Connected' ? 'ok' : 'warn'}`}>
                                            {badge}
                                        </span>
                                    </div>
                                    {id === 'openai' ? (
                                        <p className='small muted'>{status.openai.reason}</p>
                                    ) : (
                                        <>
                                            {p?.reason && <p className='small muted'>{p.reason}</p>}
                                            {models.map(m => {
                                                const total =
                                                    (m.stats.ok ?? 0) +
                                                    (m.stats.failed ?? 0) +
                                                    (m.stats.invalid ?? 0) +
                                                    (m.stats.rateLimited ?? 0);
                                                const errors = total
                                                    ? Math.round((100 * (total - (m.stats.ok ?? 0))) / total)
                                                    : 0;
                                                return (
                                                    <div key={m.id} className='ai-model small'>
                                                        <span>
                                                            {m.label} · {m.tier === 'fast' ? 'quick tasks' : 'planning'}
                                                            {m.trainsOnFreeTier
                                                                ? ' · no student data (free tier may train on inputs)'
                                                                : ''}
                                                        </span>
                                                        <span className='muted'>
                                                            Today {m.today.requests}
                                                            {m.limits.rpd ? ` / ${m.limits.rpd}` : ''} requests
                                                            {m.limits.neuronsPerDay
                                                                ? ` · ~${Math.round(m.today.neurons)} / ${m.limits.neuronsPerDay} neurons`
                                                                : ''}
                                                            {m.stats.latencyMs
                                                                ? ` · ${(m.stats.latencyMs / 1000).toFixed(1)} s`
                                                                : ''}{' '}
                                                            · {total ? `${errors}% errors` : 'no requests yet'} · last
                                                            success {ago(m.stats.lastOk)}
                                                            {m.cooldownUntil
                                                                ? ` · paused until ${new Date(m.cooldownUntil).toLocaleTimeString()} (${m.cooldownReason})`
                                                                : ''}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                            <div className='row'>
                                                <label className='check small'>
                                                    <input
                                                        type='checkbox'
                                                        checked={!!p?.eligible && !disabled.includes(id)}
                                                        onChange={() => toggle(id)}
                                                        disabled={!p?.eligible}
                                                    />
                                                    Use {label}
                                                </label>
                                                <button
                                                    type='button'
                                                    className='btn sm'
                                                    disabled={!p?.eligible || testing === id}
                                                    onClick={() => void test(id)}
                                                >
                                                    {testing === id ? 'Testing…' : 'Test connection'}
                                                </button>
                                            </div>
                                            {tests[id] && <p className='small'>{tests[id]}</p>}
                                        </>
                                    )}
                                </section>
                            );
                        })}
                    </div>
                    <h3>Usage</h3>
                    <p className='small' style={{ margin: 0 }}>
                        Server: {status.totals.requests ?? 0} AI requests · {status.totals.fallbacks ?? 0} automatic
                        fallbacks · {status.totals.rateLimitEvents ?? 0} rate-limit events ·{' '}
                        {status.totals.cacheHits ?? 0} answered from cache · {status.totals.unavailable ?? 0}{' '}
                        unavailable.
                        <br />
                        This browser (last {events.length}): {local} answered locally without AI
                        {Object.entries(byProvider)
                            .map(([k, n]) => ` · ${n} via ${k}`)
                            .join('')}
                        .
                    </p>
                    {status.decisions.length > 0 && (
                        <details>
                            <summary className='small'>Recent routing decisions</summary>
                            <ul className='small ai-decisions'>
                                {[...status.decisions]
                                    .reverse()
                                    .slice(0, 12)
                                    .map(d => (
                                        <li key={`${d.at}-${d.task}`}>
                                            {new Date(d.at).toLocaleTimeString()} · {d.task} (level {d.level}) →{' '}
                                            {d.ok ? (d.model ?? '—') : 'unavailable'}
                                            {d.cached ? ' (cache)' : ''}: {d.reason}
                                        </li>
                                    ))}
                            </ul>
                        </details>
                    )}
                </>
            )}
        </div>
    );
}
