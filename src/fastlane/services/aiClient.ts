/**
 * How the extension talks to Fastlane's AI server: every request carries the student's router settings, and
 * every answer's routing result (provider, model, cache, fallback) is kept locally for the AI dashboard.
 * Failures are reported as they are, with the server's retry time; nothing is retried behind the student's back.
 */
import {
    type AiUsageEvent,
    FastlaneAiUsageStore,
    FastlaneDevServerStore,
    FastlaneSettingsStore,
} from '../storage/stores';

export const AI_BASE = 'https://longhorn-fastlane-plus.vercel.app/api';

/** Only this project's own Vercel preview hosts may be used as a test server (never an arbitrary URL). */
const PREVIEW_ORIGIN = /^https:\/\/longhorn-fastlane-plus[a-z0-9-]*-simpsladers-projects\.vercel\.app$/;
export const isPreviewOrigin = (origin: string) => PREVIEW_ORIGIN.test(origin);

export interface AiTarget {
    base: string;
    /** the developer test code, used instead of the saved access code (only when `dev`) */
    code?: string;
    dev: boolean;
}

/** Explicit TEST SERVER selections fail closed: never redirect failed preview requests to production. */
export async function aiTarget(): Promise<AiTarget> {
    // the developer test server exists only in local builds; a store build always talks to production
    if (import.meta.env.VITE_FASTLANE_DEV_AUTORELOAD !== 'true') return { base: AI_BASE, dev: false };
    let base: string;
    let code: string;
    try {
        ({ base, code } = await FastlaneDevServerStore.all());
    } catch {
        throw new Error(
            'Cannot read AI test-server settings. Check extension storage and reload; production was not contacted.'
        );
    }
    if (!base) return { base: AI_BASE, dev: false };
    let origin: string;
    try {
        origin = new URL(base).origin;
    } catch {
        throw new Error(
            'Invalid AI test-server URL. Open Settings → Developer: AI test server to correct it; production was not contacted.'
        );
    }
    if (!isPreviewOrigin(origin))
        throw new Error(
            'AI test-server URL is not an authorized candidate preview. Correct it in Settings; production was not contacted.'
        );
    return { base: `${origin}/api`, code: code || undefined, dev: true };
}

/** POST JSON to one AI endpoint of the active target. Preview requests carry the browser's Vercel login cookie. */
export function aiFetch(path: string, body: Record<string, unknown>, signal?: AbortSignal, target?: AiTarget) {
    return (async () => {
        const t = target ?? (await aiTarget());
        const payload = t.dev && t.code && 'accessCode' in body ? { ...body, accessCode: t.code } : body;
        return fetch(`${t.base}/${path}`, {
            method: 'POST',
            signal,
            credentials: t.dev ? 'include' : 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    })();
}

export interface AiMeta {
    requestId?: string;
    task?: string;
    provider?: string | null;
    model?: string | null;
    label?: string | null;
    latencyMs?: number;
    cached?: boolean;
    fallback?: boolean;
}

export async function routingSettings() {
    const s = await FastlaneSettingsStore.all();
    return {
        mode: s.aiRouting ?? 'auto',
        model: s.aiManualModel ?? '',
        disabledProviders: s.aiDisabledProviders ?? [],
    };
}

export async function recordUsage(event: AiUsageEvent): Promise<void> {
    const events = (await FastlaneAiUsageStore.get('events')) ?? [];
    await FastlaneAiUsageStore.set('events', [...events, event].slice(-100));
}

/** POST to an AI endpoint with routing settings; records what served it. */
export async function postAi<T extends { meta?: AiMeta; error?: string; retryAfterSeconds?: number }>(
    path: string,
    task: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
): Promise<{ response: Response; payload: T }> {
    const started = Date.now();
    const response = await aiFetch(path, { ...body, routing: await routingSettings() }, signal);
    const payload = (await response.json().catch(() => ({}))) as T;
    const meta = payload.meta;
    await recordUsage({
        at: Date.now(),
        task,
        ok: response.ok,
        provider: meta?.provider ?? null,
        model: meta?.model ?? null,
        cached: !!meta?.cached,
        fallback: !!meta?.fallback,
        latencyMs: meta?.latencyMs ?? Date.now() - started,
    });
    return { response, payload };
}

/** A clear message for a failed AI request, including when to try again. */
export function aiErrorMessage(status: number, payload: { error?: string; retryAfterSeconds?: number }): string {
    const base = payload.error ?? `AI service unavailable (HTTP ${status})`;
    return payload.retryAfterSeconds && status >= 429
        ? `${base} Try again in about ${payload.retryAfterSeconds} s.`
        : base;
}
