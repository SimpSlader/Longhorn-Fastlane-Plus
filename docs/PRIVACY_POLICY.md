# Fastlane Course Planner — Privacy Policy

_Last updated: October 21, 2026 (opt-in AI beta)_

Fastlane Course Planner ("Fastlane") is an independent, student-developed Chrome extension. It is not affiliated with The University of Texas at Austin or the UT Registration Plus team.

## Summary

- Fastlane has **no account or analytics**. An optional AI feature uses an owner-operated Vercel endpoint and Groq only after explicit consent. There is no advertising or sale of user data.
- Everything you enter or import stays **in your browser profile** (Chrome storage and IndexedDB).
- Fastlane does **not** upload your complete IDA, EID, identity, or full schedules. If you opt into AI, it sends a limited subset of academic planning data to Vercel and Groq as described below.
- Fastlane does not collect browsing history or credentials, and it does not run on UT's sign-in page.

## What is stored, where, and why

| Data | Where | Purpose |
| --- | --- | --- |
| Schedules, planned classes and ranked backups | `chrome.storage.local` | Planning, calendar, conflicts |
| Registration priority queue and attempt history | `chrome.storage.local` | The manual registration assistant |
| Imported degree audit (requirements, course history, transfer credit) | `chrome.storage.local` | Requirement-aware recommendations. The file is parsed in your browser; it is never uploaded. |
| Memory: short preferences you ask the planner chat to remember (up to 12, for example “I want to graduate early”) | `chrome.storage.local` | Applied to every planning chat; shown in the chat’s Memory panel, where each item can be deleted. Sent with optional AI requests (below). |
| Roadmap, prerequisite rules, setup preference and up to 30 schedule snapshots | `chrome.storage.local` | Future planning and undo; no audit or registration queue in history |
| Reminder date/time/time zone | `chrome.storage.local` + `chrome.alarms` | Local notifications |
| Course sections shown on UT course-schedule pages you open (public catalog data such as unique number, course, times, room, instructor, seat status and when you saw it) | IndexedDB (extension) | Offline recommendations |
| UT's official course list for a semester that you import (the Registrar's public "PDF of courses offered": unique number, course, title, times, room, instructor, printed prerequisites, plus the file name, its SHA-256 and the date printed on it) | IndexedDB (extension) | Browse every subject, recommendations, AI candidate selection and schedule building. The PDF is read in your browser and never uploaded; Fastlane does not download it for you. |
| Successfully validated AI beta invite code (optional) | `chrome.storage.local` on this device, excluded from exports and Chrome Sync | Remember access across AI audit reviews and scheduling without prompting again. It is not the Groq API key; you can forget it in either AI panel. |
| Preferences (grade threshold, toggles) | `chrome.storage.sync` | Settings follow you if Chrome Sync is on. No academic data is stored here. |
| Downloaded public datasets (optional) | IndexedDB (extension) | Newer historical grade data |

## Network activity

The base features were audited via built-extension inspection and network tests (`e2e/extension.spec.ts` and `docs/NETWORK_AUDIT.md`). The optional AI feature below introduces a new explicitly initiated network request. AI analysis never happens automatically.

**Automatic requests (no personal data included):**

| When | Request | Why |
| --- | --- | --- |
| You open the UT Registration Plus calendar page | `registrar.utexas.edu/schedules` (public UT page) | Lists available semesters for Quick Add (inherited from UT Registration Plus). Fetched by the extension's background worker. |
| You open the extension's Settings (options) page | `api.github.com` (UT Registration Plus contributor statistics) | Shows the upstream project's contributors (inherited). Cached for a day. |
| You view UT course listings with “Show Rate My Professors ratings” on (default; turn off in Settings) | `www.ratemyprofessors.com` (public GraphQL search) | Sends only a listed professor's name and UT Austin's public RMP school ID, from the background worker without cookies, to show that professor's public rating. No student data is sent. Results are cached on this device for 7 days. |
| Optional dataset updates | A static file host configured at build time | **Not active in this build**: no update source is configured, so no request is made. |

**Optional AI analysis (only after you check the consent box and press Get recommendations):**

- Fastlane sends up to 35 unfinished IDA requirement descriptions and tags, up to 70 completed/planned **course codes**, selected scheduling preferences, and up to 38 **public** UT sections chosen locally (course names, professors, meeting days, grade-distribution statistics, UT's printed prerequisite text, and facts computed in your browser: which unfinished requirement tags a section matches, whether its listed prerequisite courses appear among your course codes, whether it conflicts with your schedule, and whether it was confirmed on UT) over HTTPS to `https://longhorn-fastlane-plus.vercel.app/api/recommend`.
- Saved memory items (up to 12 short preferences) are included with those AI requests.
- Degree questions in the planner chat (for example “how do I graduate early?”) send the question, up to 6 recent chat messages, saved memory, up to 30 unfinished requirement descriptions, up to 70 completed course codes, ACC transfer options from UT’s public table, and hour totals and semester scenarios **computed in your browser** from the IDA (hours required/applied/remaining, in-residence hours remaining, McCombs prerequisite status as “done at UT / in progress / transfer / not yet”) to `https://longhorn-fastlane-plus.vercel.app/api/advise`. No grades, GPA, name, EID or IDA file are sent.
- A separate, optional **Review IDA with AI** action sends up to 25 unfinished, unreviewed requirement descriptions (plus section labels, their current statuses, tags and parser warnings), completed/in-progress course codes and pending-transfer course codes to `https://longhorn-fastlane-plus.vercel.app/api/audit-review`. It does **not** send full IDA HTML or PDF files, UT account credentials, transcript grades, or the audit URL. AI suggestions are shown for individual approval and never automatically overwrite imported data.
- Vercel forwards this limited payload to Groq's `openai/gpt-oss-120b` model and returns a short ranked list. Fastlane never sends the raw IDA file/HTML, student name, EID, audit URL, UT cookies, UT authentication tokens, or full schedule exports.
- The server does not intentionally persist submitted prompts or model responses in a database. Your network provider and the hosting/inference platforms may process usage metadata according to their own terms. Check the [Vercel privacy policy](https://vercel.com/legal/privacy-policy) and [Groq privacy policy](https://groq.com/privacy-policy/). A beta invite code is sent only to Fastlane's API; it is not your Groq API key.
- The AI request is optional, requires explicit consent for each page session, and is not used to train a model controlled by Fastlane. If you decline, degree planning and the ordinary course finder stay local and continue working.
- Historical grade percentages shown to AI are aggregate public grade statistics, not your personal grades. You must verify potential degree matches, restrictions and seat availability in official UT systems.

**Requests that happen only when you act on UT pages (inherited from UT Registration Plus):** loading the next page of results when you scroll a UT course listing, loading a course's description when you open its grade popup, checking your UT sign-in when you add a course by unique number, loading one section's UT page when you press **Confirm on UT** next to a section from the official course list, and — only if you turn on "refresh course data" (off by default) — re-loading your saved courses' UT pages when you open the calendar. These go only to `utdirect.utexas.edu` and use your existing UT session; Fastlane does not read or store your credentials.

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
