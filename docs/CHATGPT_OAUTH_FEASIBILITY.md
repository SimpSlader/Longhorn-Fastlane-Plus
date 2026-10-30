# Sign in with ChatGPT (plan usage) — feasibility for this extension

Based on the four pages named in the task (read 2026-10-30): quickstart, token-sharing-open-source/sign-in, /models-and-inference, /preview-limitations. Pages linked from them (request-client-id, errors-and-recovery, token-reference, profiles-and-sessions) were **not** read, so refresh details and client-ID approval terms are unconfirmed.

## What the docs require
- Eligible ChatGPT Plus/Pro users; "available to all open-source partners and selected private clients" during a preview.
- OIDC + PKCE (S256). Authorize `https://auth.openai.com/api/accounts/authorize`, token `https://auth.openai.com/api/accounts/oauth/token`. Public client, no secret. First sign-in registers with `client_id=dynamic_agent_client` plus `agent_name_hint` and a stable `ext_agent_host_id`; the issued `oaiapp_…` id must be saved and reused.
- **Redirect must be an `http://127.0.0.1:<port>/auth/callback` loopback** (only the port may vary; `localhost` is not allowed) with a listener started before the browser opens. `chrome-extension://` and `chrome.identity` redirect URIs are not mentioned — neither allowed nor forbidden.
- Scopes `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; the granted scope must include `chatgpt.tokens.use.direct`; ID token verified against OpenAI's JWKS (`iss`, `aud`, `exp`, `nonce`).
- The app must refresh tokens itself (rotating refresh token); the refresh request format is not on these pages. Tokens go in a protected per-account record (docs example: a `0600` file under `~/.config/<tool>/`).
- Inference: `POST https://api.openai.com/v1/responses` only, `store:false`, `stream:true`, many parameters forbidden (`max_output_tokens`, `temperature`, `metadata`, …), no `previous_response_id`; function tools are supported. No ChatGPT backend endpoints.

## Fit with this project
| Requirement | Chrome MV3 extension | Verdict |
| --- | --- | --- |
| Loopback listener on 127.0.0.1 | Extensions cannot open a listening socket | **Blocks a pure-extension flow** |
| `chrome.identity.launchWebAuthFlow` | Redirects to `https://<id>.chromiumapp.org/` — not the documented loopback | Not documented as supported; do not rely on it |
| Secure token storage | `chrome.storage` is readable by the extension profile; docs ask for a protected file/keychain | Weaker than documented guidance |
| Tool calling | Existing agent loop is server-side (`api/agent.mjs`, provider router) using a different request shape | Needs a Responses-API provider adapter |
| Client registration | `ext_agent_host_id` + issued client id; approval path (`/siwc/request-client-id`) unread | Needs the owner's registration with OpenAI |

## Conclusion
**Not implemented: not supported by the documented flow for a pure MV3 extension, and not practical to ship safely without extra infrastructure.** Nothing was added that pretends otherwise; the existing provider path is unchanged and nothing was stubbed in.

## Safest approach if you want it anyway
A small **native-messaging companion** (signed binary per OS, Chrome `nativeMessaging` permission):
1. Companion runs PKCE, binds `127.0.0.1`, opens the system browser, validates state/nonce/ID token/scopes, stores tokens in the OS keychain, refreshes them.
2. It exposes only "list models" and "run this planner request" to the extension; tokens never enter extension code or GitHub; no shared secret or API key is embedded anywhere.
3. A new provider adapter speaks the Responses API (streaming, `store:false`) with the same verified scheduling tools — the validator stays authoritative regardless of provider.
Operational burden: per-OS installers and code signing, an auto-update path, Chrome Web Store disclosure of native messaging, OpenAI client-ID approval, and handling a preview API that may change. Recommended alternative with no new infrastructure: keep the current provider routing and (optionally) add a bring-your-own-API-key provider that calls the Responses API directly.
