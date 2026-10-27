export type PersonalProvider = 'groq' | 'gemini' | 'cloudflare';
export interface PersonalCredential {
    key: string;
    accountId: string;
    freeConfirmed: boolean;
    allowAcademic: boolean;
}
export interface PersonalAiConfig {
    enabled: boolean;
    provider: PersonalProvider;
    providers: Record<PersonalProvider, PersonalCredential>;
}
const empty = (): PersonalCredential => ({ key: '', accountId: '', freeConfirmed: false, allowAcademic: false });
export const DEFAULT_PERSONAL_AI: PersonalAiConfig = {
    enabled: false,
    provider: 'groq',
    providers: { groq: empty(), gemini: empty(), cloudflare: empty() },
};
export const PERSONAL_PROVIDERS = {
    groq: {
        label: 'Groq',
        origin: 'https://api.groq.com/*',
        url: 'https://console.groq.com/keys',
        help: 'https://console.groq.com/docs/quickstart',
        model: 'openai/gpt-oss-20b',
        labelModel: 'GPT-OSS 20B',
    },
    gemini: {
        label: 'Google Gemini',
        origin: 'https://generativelanguage.googleapis.com/*',
        url: 'https://aistudio.google.com/api-keys',
        help: 'https://ai.google.dev/gemini-api/docs/api-key',
        model: 'gemini-3.1-flash-lite',
        labelModel: 'Gemini 3.1 Flash-Lite',
    },
    cloudflare: {
        label: 'Cloudflare Workers AI',
        origin: 'https://api.cloudflare.com/*',
        url: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
        help: 'https://developers.cloudflare.com/workers-ai/get-started/rest-api/',
        model: '@cf/meta/llama-3.1-8b-instruct-fp8',
        labelModel: 'Llama 3.1 8B',
    },
} as const;
export const PERSONAL_PROVIDER_IDS = Object.keys(PERSONAL_PROVIDERS) as PersonalProvider[];
export function personalReady(config: PersonalAiConfig): boolean {
    const c = config.providers[config.provider];
    return !!c?.key && c.freeConfirmed && (config.provider !== 'cloudflare' || /^[a-f\d]{32}$/i.test(c.accountId));
}
