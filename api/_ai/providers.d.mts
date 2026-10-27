import type { ModelOutput } from './tasks/index.mjs';
export class ProviderError extends Error {
    category: string;
    status: number;
    retryAfterMs: number;
}
export function callModel(
    model: { provider: string; model: string; nativeJson: boolean },
    request: {
        system: string;
        user: string;
        schema?: object;
        schemaName?: string;
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    },
    env: Record<string, string>
): Promise<ModelOutput>;
