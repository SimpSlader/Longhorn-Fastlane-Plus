/**
 * How the extension talks to Fastlane's AI server: every request carries the student's router settings, and
 * every answer's routing result (provider, model, cache, fallback) is kept locally for the AI dashboard.
 * Failures are reported as they are, with the server's retry time; nothing is retried behind the student's back.
 */
import { type AiUsageEvent, FastlaneAiUsageStore, FastlaneSettingsStore } from '../storage/stores';

export const AI_BASE = 'https://longhorn-fastlane-plus.vercel.app/api';

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
    const response = await fetch(`${AI_BASE}/${path}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, routing: await routingSettings() }),
    });
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
