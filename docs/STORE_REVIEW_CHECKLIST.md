# Chrome Web Store review checklist

Status as of the release-readiness audit (2026-10-21). ✅ done/verified · ⏳ owner action · ⛔ blocked until resolved. Items marked **(auto)** are enforced by CI / `pnpm package:fastlane`.

## Build & policy
- ✅ **(auto)** Manifest V3; CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`
- ✅ **(auto)** No remotely hosted code (no remote `<script>`, `importScripts` or `import()`)
- ✅ **(auto)** Permissions limited to storage, unlimitedStorage, scripting, alarms, notifications
- ✅ **(auto)** Hosts limited to UT domains (+ inherited collegescheduler.com, bluera.com); no `<all_urls>`, no UT login page
- ✅ **(auto)** No telemetry/analytics endpoints; no Google Fonts, CDN or proxy requests (`docs/NETWORK_AUDIT.md`)
- ✅ **(auto)** Description ≤ 132 characters
- ✅ **(auto)** Type check, Biome, unit tests (215), dataset check, security check on `dist/` **and** on the unzipped ZIP
- ✅ **(auto)** End-to-end tests (15) against the **packaged ZIP** in fresh profiles without UT Registration Plus
- ✅ Source maps and dev-only files excluded from the ZIP
- ⏳ Bump `version` and tag `vX.Y.Z` → draft release (workflow never publishes)

## Listing
- ✅ Description matches features; no claims of UT approval or live seat availability
- ✅ Non-affiliation disclaimer on every surface
- ✅ Permission justifications (`docs/STORE_LISTING.md`)
- ⏳ Privacy policy published at a public URL and linked (text is final in `docs/PRIVACY_POLICY.md`)
- ⏳ Chrome Web Store privacy-practices form (no data collected/transmitted)
- ✅ Screenshots regenerated from the current build (`store-assets/screenshots/`, including the new chart)
- ✅ Original icons 16/32/48/128, no UT marks

## Legal / trademark / data
- ✅ Product renamed to **Fastlane Course Planner** (`docs/BRANDING.md`)
- ⏳ USPTO search for "Fastlane" (software classes); optional repository rename
- ✅ Highcharts removed; all shipped dependencies permissively licensed; `THIRD_PARTY_NOTICES.txt` regenerated
- ✅ Grade-data provenance documented (`docs/GRADE_DATA_PROVENANCE.md`)
- ⛔ **Separate public hosting of grade data:** blocked until written UT approval (workflow locked, Pages off)
- ⏳ Decide whether bundling the dataset (as UTRP does) is acceptable for this release

## Registration policy
- ✅ Autofill and on-screen result reading default **off**; autofill fills only `s_unique_add`, never radios/swap/submit (tested on UT's documented form structure)
- ✅ No code path submits forms, clicks UT buttons or sends registration requests (enforced by `integration.test.ts`)
- ✅ No automatic UT fetching: calendar auto-refresh now requires the opt-in setting
- ⏳ Ask the Registrar about the optional autofill/result-reading features; remove them if UT objects

## Live verification (signed in, manual)
- ⏳ Course schedule results page: grade chips, threshold selector, blue async rows, LIVE ONLINE labels, conflicts naming the right class
- ⏳ Add/drop page (during a registration window): assistant appears, copy/fill target the add field, outcomes advance, messages suggest correctly
- ⏳ Import a real IDA (HTML and PDF); review screen correct
- ⏳ Reminder test notification on macOS/Windows
- ⏳ Offline: Fastlane page, schedules, conflicts, grades, cached recommendations
