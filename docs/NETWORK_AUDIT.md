# Network & permission audit (release readiness, 2026-10-21)

## Method
1. **Static:** every absolute `http(s)://` host in the built `dist/` JavaScript/HTML was listed and traced to its source.
2. **Dynamic:** an end-to-end test loads the packaged extension in a fresh Chromium profile, exercises the demo listing, grade popup, every Fastlane tab, the calendar, map, toolbar popup and Settings, and records every network request. Only the disclosed hosts are allowed (`network activity matches the privacy policy`).

## Findings and fixes
| Host / behavior | Source | Status |
| --- | --- | --- |
| `fonts.googleapis.com` stylesheet `@import` on every styled page | UTRP `fonts.module.scss` | **Removed** (fonts are bundled) |
| `cdn.longhorns.dev` video in "What's New" dialog | UTRP calendar | **Removed** (dialog not shown; it described UTRP releases) |
| `github.cachedapi.com` (third-party proxy) before `api.github.com` | UTRP contributors list | **Removed**; GitHub API only, disclosed |
| Silent refresh of saved courses from UT with the student's session on every calendar open | UTRP `Calendar.tsx` | **Gated** behind the "refresh course data" option (off by default) |
| `registrar.utexas.edu/schedules` when the calendar opens | UTRP Quick Add semester list | Kept (public page, no data sent); **disclosed** |
| `api.github.com` on Settings page | UTRP contributors | Kept; **disclosed** |
| Sentry DSN | UTRP | Removed earlier; security check fails the build if a telemetry endpoint reappears |
| Links only (never fetched): UT pages, Rate My Professors, Google Maps, GitHub, Discord/Instagram/LinkedIn (UTRP team links), contributor websites, Chrome Web Store | various | No request unless clicked |

## Permissions (manifest) vs. use
| Permission | Used by | Verified |
| --- | --- | --- |
| storage, unlimitedStorage | schedules, plans, queue, audit, settings; 13 MB grade DB + caches | e2e persistence tests |
| alarms, notifications | reminders | e2e reminders test (alarms created) |
| scripting | course-evaluation (bluera.com) shortcut | inherited; unchanged |
| hosts: UT course schedule, registrar schedules, catalog | listing integration | e2e listing tests (demo), real-page fixture test |
| host: utdirect.utexas.edu/registration/* | assistant | real-structure form test |
| hosts: collegescheduler.com, my.utexas.edu/student, bluera.com | inherited integrations | unchanged |

No `<all_urls>`, no UT login page match, web-accessible resources limited to UT/collegescheduler/bluera origins, CSP `script-src 'self' 'wasm-unsafe-eval'`.
