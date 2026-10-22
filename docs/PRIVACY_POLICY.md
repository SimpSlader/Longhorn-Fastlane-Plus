# Fastlane Course Planner — Privacy Policy

_Last updated: October 21, 2026 (release-readiness audit)_

Fastlane Course Planner ("Fastlane") is an independent, student-developed Chrome extension. It is not affiliated with The University of Texas at Austin or the UT Registration Plus team.

## Summary

- Fastlane has **no server, no account and no analytics**. It does not sell, share, or transfer user data.
- Everything you enter or import stays **in your browser profile** (Chrome storage and IndexedDB).
- Fastlane never sends your EID, grades, degree audit, schedules, or registration activity to the developers or to any third party.
- Fastlane does not collect browsing history or credentials, and it does not run on UT's sign-in page.

## What is stored, where, and why

| Data | Where | Purpose |
| --- | --- | --- |
| Schedules, planned classes and ranked backups | `chrome.storage.local` | Planning, calendar, conflicts |
| Registration priority queue and attempt history | `chrome.storage.local` | The manual registration assistant |
| Imported degree audit (requirements, course history, transfer credit) | `chrome.storage.local` | Requirement-aware recommendations. The file is parsed in your browser; it is never uploaded. |
| Roadmap, prerequisite rules, setup preference and up to 30 schedule snapshots | `chrome.storage.local` | Future planning and undo; no audit or registration queue in history |
| Reminder date/time/time zone | `chrome.storage.local` + `chrome.alarms` | Local notifications |
| Course sections shown on UT course-schedule pages you open (public catalog data such as unique number, course, times, room, instructor, seat status and when you saw it) | IndexedDB (extension) | Offline recommendations |
| Preferences (grade threshold, toggles) | `chrome.storage.sync` | Settings follow you if Chrome Sync is on. No academic data is stored here. |
| Downloaded public datasets (optional) | IndexedDB (extension) | Newer historical grade data |

## Network activity

This list was verified by inspecting every URL in the built extension and by recording all requests in automated tests (`e2e/extension.spec.ts`, "network activity matches the privacy policy"; details in `docs/NETWORK_AUDIT.md`). Fastlane never sends your schedules, degree audit, registration queue, EID or grades anywhere.

**Automatic requests (no personal data included):**

| When | Request | Why |
| --- | --- | --- |
| You open the UT Registration Plus calendar page | `registrar.utexas.edu/schedules` (public UT page) | Lists available semesters for Quick Add (inherited from UT Registration Plus). Fetched by the extension's background worker. |
| You open the extension's Settings (options) page | `api.github.com` (UT Registration Plus contributor statistics) | Shows the upstream project's contributors (inherited). Cached for a day. |
| Optional dataset updates | A static file host configured at build time | **Not active in this build**: no update source is configured, so no request is made. |

**Requests that happen only when you act on UT pages (inherited from UT Registration Plus):** loading the next page of results when you scroll a UT course listing, loading a course's description when you open its grade popup, checking your UT sign-in when you add a course by unique number, and — only if you turn on "refresh course data" (off by default) — re-loading your saved courses' UT pages when you open the calendar. These go only to `utdirect.utexas.edu` and use your existing UT session; Fastlane does not read or store your credentials.

**Links you click** open in a new tab: UT pages, Rate My Professors, Google Maps walking directions, and the feedback link (a GitHub issue form that *you* submit publicly).

**Removed from the upstream code in Fastlane:** error telemetry (Sentry), Google Fonts requests (fonts are bundled), a third-party GitHub caching proxy, the "What's New" video loaded from the UT Registration Plus CDN, and the automatic calendar refresh.

## Reading UT pages

On UT IDA results pages, the **Add IDA** button reads academic tables only after you click it. It replaces the locally imported audit. Raw HTML, the audit URL and the page heading are not saved by this button. The host permission is limited to `https://utdirect.utexas.edu/apps/degree/audits/results/*`; it does not grant access to login pages.

On UT course-schedule pages, Fastlane reads the visible listing to show grades, delivery mode and conflicts. On UT's registration screen, the assistant reads nothing by default. Two optional settings, both off by default:

- **Registration autofill** places the next unique number in UT's add field. It never submits.
- **Suggest outcomes from on-screen messages** reads result messages that are already visible after *you* submit, in memory only, and asks you to confirm. Messages are never stored or sent.

## Your controls

- **Settings & privacy → Export** downloads your schedules/plans (and optionally your audit) as JSON.
- **Compare & share** exports a schedule-only JSON file or a comparison image. These omit personal schedule names, audit data, registration links, queue and notes. Files stay on your device until you choose to share them. Import appends a new schedule.
- **Delete Fastlane data** removes plans, backups, queue, audit, roadmap, prerequisite rules, history, reminders, cached sections and downloaded datasets.
- **Delete all saved information** removes everything the extension stored, including schedules.
- Uninstalling the extension removes all of its storage.

Local storage is not a password-protected vault. Anyone with access to your unlocked browser profile may be able to read it. Avoid importing private academic records on a shared computer.

## Children

Fastlane is intended for university students and is not directed at children under 13.

## Changes

Changes to this policy will be published with the extension's source code and noted in release notes.

## Contact

Open an issue on the project's GitHub repository.
