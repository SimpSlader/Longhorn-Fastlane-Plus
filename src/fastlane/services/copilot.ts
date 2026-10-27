/**
 * The copilot loop: send the conversation to Fastlane's agent endpoint; when the model asks for tools, run
 * them here in the browser and send the results back; repeat until it answers (at most 8 tool rounds).
 * Tool results are trimmed so a big search can't crowd out the conversation.
 */
import { type AiMeta, aiErrorMessage, postAi } from './aiClient';

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface AgentMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}
interface AgentReply {
    type?: 'tool_calls' | 'answer';
    calls?: ToolCall[];
    text?: string;
    meta?: AiMeta;
    error?: string;
    retryAfterSeconds?: number;
}

const MAX_ROUNDS = 8;
const MAX_RESULT_CHARS = 7000;

export async function runCopilot(opts: {
    accessCode: string;
    history: AgentMessage[];
    userText: string;
    context: Record<string, unknown>;
    execute: (call: ToolCall) => Promise<unknown>;
    onProgress?: (text: string) => void;
    labels?: Record<string, string>;
    signal?: AbortSignal;
}): Promise<{ text: string; tools: string[]; meta?: AiMeta }> {
    const transcript: AgentMessage[] = [...opts.history, { role: 'user', content: opts.userText }];
    const tools: string[] = [];
    let meta: AiMeta | undefined;
    for (let step = 0; step <= MAX_ROUNDS; step++) {
        opts.onProgress?.(step === 0 ? 'Thinking…' : 'Putting it together…');
        const { response, payload } = await postAi<AgentReply>(
            'agent',
            'agent',
            { accessCode: opts.accessCode, messages: transcript, context: { ...opts.context, steps: step } },
            opts.signal
        );
        if (!response.ok)
            throw Object.assign(new Error(aiErrorMessage(response.status, payload)), { status: response.status });
        meta = payload.meta ?? meta;
        if (payload.type !== 'tool_calls' || !payload.calls?.length) {
            const text = (payload.text ?? '').trim();
            if (!text) throw new Error('Fastlane AI returned an empty answer. Try again.');
            return { text, tools, meta };
        }
        transcript.push({ role: 'assistant', content: payload.text ?? '', tool_calls: payload.calls });
        for (const call of payload.calls) {
            opts.onProgress?.(opts.labels?.[call.name] ?? 'Working…');
            tools.push(call.name);
            let result: unknown;
            try {
                result = await opts.execute(call);
            } catch (e) {
                if (opts.signal?.aborted) throw e;
                result = { error: e instanceof Error ? e.message : 'The tool failed.' };
            }
            const text = JSON.stringify(result ?? null);
            transcript.push({
                role: 'tool',
                tool_call_id: call.id,
                content: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (trimmed)` : text,
            });
        }
    }
    throw new Error('Fastlane AI used too many steps without answering. Try asking a little more specifically.');
}
