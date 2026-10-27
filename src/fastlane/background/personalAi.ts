/** Keys are read only in the extension worker and sent only to the selected provider's fixed API origin. */
import { callModel, ProviderError } from '../../../api/_ai/providers.mjs';
import { preparePersonalTask } from '../../../api/_ai/tasks/index.mjs';
import { PERSONAL_PROVIDER_IDS, PERSONAL_PROVIDERS, type PersonalProvider } from '../core/personalAi';
import { FastlanePersonalAiStore } from '../storage/stores';

const active = new Map<string, AbortController>();
const cancelled = new Set<string>();
export function trustedAiSender(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}
export function cancelPersonalAi(requestId: string) {
    const controller = active.get(requestId);
    if (controller) controller.abort();
    else {
        if (cancelled.size > 100) cancelled.clear();
        cancelled.add(requestId);
    }
}
const response = (status: number, payload: Record<string, unknown>) => ({ status, payload });

export async function personalAiRequest(path: string, body: Record<string, unknown>, requestId: string) {
    const config = await FastlanePersonalAiStore.all();
    const testing = path === 'ai-status';
    const p = (
        testing && PERSONAL_PROVIDER_IDS.includes(body.test as PersonalProvider) ? body.test : config.provider
    ) as PersonalProvider;
    if (!PERSONAL_PROVIDER_IDS.includes(p)) return response(400, { error: 'Choose an AI provider in Settings.' });
    const provider = PERSONAL_PROVIDERS[p];
    const credential = config.providers[p];
    if ((!config.enabled && !testing) || !credential.key)
        return response(400, { error: 'Add your own API key in Settings → Use your own API keys.' });
    if (!credential.freeConfirmed)
        return response(403, { error: 'Confirm your free provider plan in Settings first.' });
    if (p === 'cloudflare' && !/^[a-f\d]{32}$/i.test(credential.accountId))
        return response(400, { error: 'Cloudflare needs the 32-character Account ID from its dashboard.' });
    if (!(await chrome.permissions.contains({ origins: [provider.origin] })))
        return response(403, { error: 'Click Save & use in Settings to allow access to this provider.' });
    const controller = new AbortController();
    active.set(requestId, controller);
    if (cancelled.delete(requestId)) controller.abort();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
        const job = testing
            ? {
                  task: 'test',
                  system: 'You are a connection check.',
                  user: 'Reply with the single word OK.',
                  maxTokens: 1024,
                  containsStudentData: false,
                  validate: () => null,
                  format: () => ({}),
              }
            : preparePersonalTask(path, body);
        if (p === 'gemini' && job.containsStudentData && !credential.allowAcademic)
            return response(403, {
                error: 'Google may use free-tier input to improve its products. Allow degree summaries for Gemini in Settings, or choose Groq or Cloudflare.',
            });
        const env: Record<string, string> =
            p === 'groq'
                ? { GROQ_API_KEY: credential.key }
                : p === 'gemini'
                  ? { GEMINI_API_KEY: credential.key }
                  : { CLOUDFLARE_API_TOKEN: credential.key, CLOUDFLARE_ACCOUNT_ID: credential.accountId };
        const model = p === 'groq' && ['advise', 'recommend'].includes(path) ? 'openai/gpt-oss-120b' : provider.model;
        const started = Date.now();
        const result = await callModel(
            { provider: p, model, nativeJson: p !== 'cloudflare' },
            { ...job, signal: controller.signal },
            env
        );
        if (job.validate(result))
            return response(502, {
                error: 'The AI answer did not pass FastLane’s checks. Your saved plan was not changed.',
            });
        const meta = {
            provider: p,
            model: `${p}:${model}`,
            label: model === 'openai/gpt-oss-120b' ? 'GPT-OSS 120B' : provider.labelModel,
            latencyMs: Date.now() - started,
            cached: false,
            fallback: false,
            validation: 'passed',
            usage: result.usage,
        };
        return response(
            200,
            testing ? { ok: true, message: `${provider.label} is connected.`, meta } : { ...job.format(result), meta }
        );
    } catch (error) {
        const category = error instanceof ProviderError ? error.category : 'invalid';
        const message =
            category === 'auth'
                ? 'The provider rejected this key or its permissions. Re-copy the key in Settings.'
                : category === 'rate_limit'
                  ? 'Your provider’s free limit was reached. Try again later.'
                  : controller.signal.aborted
                    ? 'The request was cancelled or took too long. Try again.'
                    : category === 'bad_request'
                      ? 'The provider rejected this request or model. Check the key’s project and model access.'
                      : 'The provider could not finish this request. Check your connection and try again.';
        return response(category === 'rate_limit' ? 429 : 502, {
            error: message,
            ...(testing ? { ok: false, message } : {}),
        });
    } finally {
        clearTimeout(timeout);
        active.delete(requestId);
    }
}
