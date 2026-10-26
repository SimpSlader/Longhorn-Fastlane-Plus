# Fastlane AI router

All AI requests from the extension go to Fastlane's Vercel functions (`api/recommend`, `api/advise`,
`api/chat`, `api/audit-review`), and every one of them calls `routeAI()` in `api/_ai/router.mjs`. No provider
is called directly. Questions about the student's own records never reach the server: the extension answers
them from the imported IDA (`src/fastlane/core/academic.ts`, `intent.ts`, `localAnswers.ts`).

## Flow of a chat message

1. `classifyIntent()` (typo-tolerant, no AI) decides what the message is:
   - **Records:** hours completed, hours in progress, totals, hours remaining, GPA, current classes, sections of
     a course, or the easiest class. These are answered locally from the IDA and course data; nothing is sent.
   - **Correction:** "I've completed 9, not 33" is stored as student-reported, beside the IDA, never over it.
   - **Degree planning:** goes to `api/advise`, with numbers computed in the browser.
   - **Schedule build or change:** the deterministic solver builds the week. `api/recommend` only ranks real
     sections, and every schedule is validated before it is shown.
   - **Conversation:** goes to `api/chat`, with only the context the question needs.
2. The router scores each eligible model and tries them best-first.

## Providers and models

| Model | Used for | Free-tier limits assumed (override with `AI_LIMITS_JSON`) |
|---|---|---|
| Groq `openai/gpt-oss-20b` | quick tasks (level ≤ 3) | 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD |
| Groq `openai/gpt-oss-120b` | planning (any level) | same |
| Gemini `gemini-2.5-flash` | large-context planning | 10 RPM, 250 RPD |
| Gemini `gemini-2.5-flash-lite` | quick tasks (≤ 3) | 15 RPM, 1,000 RPD |
| Cloudflare `@cf/meta/llama-3.1-8b-instruct-fp8` | simple chat (≤ 2) | 10,000 Neurons/day (estimated per request) |

These were the published figures on 2026-10-26, and providers change them. The limits in each provider's
console are the real ones.

## Configuration (Vercel environment variables; never in the extension or Git)

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq (already set) |
| `GEMINI_API_KEY` | Google Gemini |
| `GEMINI_BILLING=off` | Required in strict mode: confirms the key's Google Cloud project has no billing account (a billed project pays per request) |
| `GEMINI_ALLOW_STUDENT_DATA=true` | Optional. Free-tier Gemini may use inputs for training, so by default it only gets requests without academic data |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Workers AI (token needs only the "Workers AI" permission) |
| `CLOUDFLARE_PLAN=free` | Required in strict mode: confirms Workers Free (Workers Paid bills beyond 10,000 Neurons/day) |
| `STRICT_FREE_TIER` | Default `true`. Leave it on |
| `GROQ_PLAN=paid` | Set only if the Groq org has a card on file; strict mode then stops using Groq |
| `AI_DISABLE_GROQ` / `_GEMINI` / `_CLOUDFLARE` | `true` turns a provider off server-wide |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) | Optional. Keeps quota counts, cooldowns and quality across restarts and instances. Without them, they live in each instance's memory |
| `AI_LIMITS_JSON` | Optional per-model limit overrides, e.g. `{"gemini:gemini-2.5-flash":{"rpd":500}}` |
| `OPENAI_CHATGPT_OAUTH_ENABLED` | Ignored: see below |

## Routing and scoring

- **Complexity levels:** chat and explanations are 2; IDA review and filtering are 3; degree advice and schedule
  ranking are 4; large inputs add 1.
- **Hard filters run before any scoring.** A model is skipped when:
  - its provider isn't configured or isn't confirmed free;
  - the student turned the provider off;
  - the level is above the model's limit;
  - the context is too small;
  - it's free-tier Gemini and the request contains student data;
  - it's cooling down;
  - it would pass 85% of any free limit (15% is kept in reserve).
- **Score weights.** The base is 40% measured quality, 20% reliability, 20% free-quota room, 15% latency and 5%
  features. Level 4–5 shifts to 55/20/10/10/5; level 1–2 to 25/20/25/25/5. The student can choose fastest,
  quality, save-quota or manual mode.
- **Quality is learned.** Each model starts from a prior per level, and every deterministic validation result
  updates it. Results include JSON/schema failures, hallucinated section IDs, and stated "completed" hours that
  don't match the computed ones. No AI is ever asked to grade or choose models.

## Failures

- **HTTP 429:** the model cools down for the Retry-After time (or Gemini's `retryDelay`, or 60 s) and the
  request moves to the next model.
- **401/403:** the provider cools down for 15 minutes, with no retries.
- **Timeouts, 5xx and network errors:** one retry after 250–750 ms of jitter, then the next model.
- **Invalid output:** the next model is tried.
- **Limits per request:** at most 4 attempts within 25 s.
- **Concurrent and repeated requests:** identical concurrent requests share one call, and identical repeats
  within 10 minutes come from the cache (keyed by the full request, so any change in data or preferences misses).
- **When nothing is available,** the endpoint returns 429 or 503 with `retryAfterSeconds` and the message
  "Nothing was charged". Nothing is ever faked.

## OpenAI "Sign in with ChatGPT": not enabled

OpenAI's plan sharing (developers.openai.com/siwc, read 2026-10-26) is documented for open-source apps that run
locally:
- the OAuth callback must be an HTTP loopback on `127.0.0.1`;
- tokens must stay out of browser storage;
- hosted or paid apps go through an interest form first.

Fastlane is a Chrome extension with a hosted server, so the feature stays off, and the dashboard shows why.
Enabling it would need OpenAI's approval and a design where tokens never leave the student's machine.

## Status

Settings → **AI assistant** shows, without keys or prompts:
- each provider's state and the models' usage today against their limits;
- latency, error rate and last success;
- cooldowns, totals, recent routing decisions, the router mode, and per-provider switches.

**Test connection** sends one tiny request through a provider.
