# Fastlane Course Planner

A local-first Chrome extension (Manifest V3) for UT Austin students: browse the course schedule with historical grade percentages inline, spot asynchronous classes and conflicts at a glance, build an ideal schedule with ranked backup classes, import your Interactive Degree Audit, get degree-aware fallback recommendations, and prepare registration codes quickly — **without any automatic enrollment**.

> **Independent student project.** Fastlane Course Planner is not affiliated with, endorsed by, or approved by The University of Texas at Austin or the UT Registration Plus team. It is a fork of [UT Registration Plus](https://github.com/Longhorn-Developers/UT-Registration-Plus) (MIT) and borrows its degree-audit parsing approach from [Degree Audit Plus](https://github.com/Longhorn-Developers/Degree-Audit-Plus) (MIT). All of UT Registration Plus's existing features (course search integration, grade graphs, calendar, professor/syllabus links, campus map) are kept.

## What it adds

| Area | What you get |
| --- | --- |
| **Inline grades** | `72.4% A-+ · Prof` beside the grade-graph button (the graph itself is now a dependency-free SVG chart) on every course row. Threshold is global (A … D-, default A- or better) and can be changed right in the listing header or Settings. Percentages are computed from real historical grade counts; non-letter outcomes (CR/NC, Q, W …) are excluded from numerator and denominator. Hover for sample size, semesters, professor vs. course-wide scope, source and dataset date. Missing data shows **No grade data** — nothing is estimated. |
| **Async / live online** | Blue row + **ASYNC ONLINE** only when the listing shows an internet instruction mode, no meeting days/times and no physical room. Sections that meet online at scheduled times get a separate **LIVE ONLINE** label. A `WB` room alone is never treated as asynchronous. In-person and hybrid rows keep normal styling. |
| **Conflicts** | Every meeting (lecture, lab, discussion) is compared with your active schedule. Confirmed overlaps are struck through and show **Conflicts: M 408C (53780)**. Incomplete/TBA times show **Conflict ?** instead of guessing. Async sections never conflict by modality alone. |
| **Schedules & backups** | Ideal / Backup / custom schedules (UTRP's calendar), credit hours, conflicts, locations, professors, weekly grid. Each planned class has **ranked backups** (drag-and-drop or ↑/↓) that never count toward the active schedule or create conflicts until you **Activate** one (class swapping updates the calendar). Mark a class full → the next backup in the same requirement category is suggested. Duplicate unique numbers are rejected. |
| **Degree audit** | Import your IDA as saved HTML (best) or PDF. Parsed locally (bundled PDF.js). Shows completed / in-progress / remaining core and major requirements, credit hours, accepted vs **pending** transfer credit (pending is never counted), and prerequisite/restriction notes. A review screen highlights uncertain items so you can correct them. |
| **Recommendations** | When your preferred class and all backups are full, Fastlane ranks real sections it has seen (saved locally from UT course-schedule pages you opened) by: outstanding requirement → semester → no conflicts → online/async preference → historical grade % (reliable samples first) → professor info → avoid-Friday → prerequisite/reserved-seat eligibility. Shows exact unique numbers. Availability says **Open as of <time>** only when a UT page displayed it recently; otherwise **Check availability**. |
| **Registration assistant** | Floating panel on UT's add/drop screen: next unique number, one-click copy, course, requirement, next fallback, attempt history, Success / Full / Conflict / Restriction / Skip / Undo. Your priority queue is fully editable (groups, conditions such as "no CLEP credit", revisits). Optional **autofill** (off by default) only types the code into UT's *add* field — it never clicks, submits or presses Enter. Optional on-screen result reading only *suggests* an outcome for you to confirm (off by default). |
| **Reminders** | Registration date/time/time zone → Chrome notifications 24 h / 1 h / 10 min before (plus custom), and optional prep reminders. Test button, `.ics` export, notification buttons open UT registration or your plan. |
| **Campus map** | Final schedule by weekday on the bundled campus map: numbered pins with class/time/room, per-day colored order lines (estimated along campus walkways, clearly labeled), gap vs. walking time, and **Open walking directions** links. |
| **Phone wallpaper** | Minimal, aesthetic, campus-map and hybrid styles; iPhone / Android / generic sizes; light/dark; optional rooms, professors, course colors. Drawn locally on a canvas. |
| **Privacy** | No account, no backend, no analytics. Upstream error telemetry (Sentry) is disabled. Export/import JSON, delete Fastlane data, or delete everything. |

## Install (unpacked)

1. Download `fastlane-course-planner-<version>.zip` from the release (or build it, below) and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder (the one containing `manifest.json`).
3. Click the extension icon → **Fastlane**. To try everything offline, open `chrome-extension://<id>/demo.html` (shown on the details page as *Inspect views*) — it mounts the real integration on local fixtures.
4. If you also have UT Registration Plus installed, disable one of them: both inject into the same pages.

## Build from source

Requirements: Node 24 (see `.nvmrc`), pnpm 10 (`corepack enable`).

```bash
pnpm install
```

```bash
pnpm build                  # dist/ = unpacked MV3 extension
```

```bash
pnpm vitest run             # unit tests (UTRP + Fastlane)
```

```bash
pnpm exec playwright install chromium && pnpm e2e    # end-to-end tests with the real extension
```

```bash
pnpm package:fastlane       # notices → build → security check → package/fastlane-course-planner-<version>.zip
```

Optional build-time configuration (all off by default):

| Variable | Purpose |
| --- | --- |
| `VITE_FASTLANE_DATA_MANIFEST_URL` | HTTPS URL of a static dataset manifest (e.g. GitHub Pages) for optional dataset updates |
| `VITE_FASTLANE_REPO_URL` | Repository used by the in-app "feedback → GitHub issue" link |
| `VITE_FASTLANE_UNINSTALL_URL` | Optional uninstall survey page |
| `VITE_SENTRY_DSN` | Re-enables error telemetry. **Do not set** without updating the privacy policy and store disclosures. |

## Project layout

- `src/fastlane/core/` — pure, tested logic: grades, meetings & conflicts, modality, requirements, plans/backups, recommendations, queue, detection, autofill decisions, reminders, ICS, campus stops, wallpaper layout
- `src/fastlane/audit/` — IDA HTML/PDF parsing
- `src/fastlane/data/` — versioned dataset manifest, validation, IndexedDB store
- `src/fastlane/injected/` — UI injected into UT pages (row insights, header, registration assistant)
- `src/fastlane/page/` — the Fastlane workspace (`fastlane.html`)
- `src/fastlane/background/` — alarms, notifications, section cache, dataset updates
- `src/pages/demo/` — offline demo page
- `e2e/` — Playwright tests that load the built extension
- `docs/` — privacy policy, data sources, licenses, store listing, release & upstream process, limitations

## Documentation

- [Privacy policy](docs/PRIVACY_POLICY.md)
- [Data sources and licensing](docs/DATA_SOURCES.md)
- [Open-source license compliance report](docs/LICENSE_COMPLIANCE.md)
- [Chrome Web Store listing & permission justifications](docs/STORE_LISTING.md)
- [Chrome Web Store review checklist](docs/STORE_REVIEW_CHECKLIST.md)
- [Release, versioning and upstream maintenance](docs/RELEASE_AND_UPSTREAM.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Test results](docs/TEST_RESULTS.md)
- [Known limitations](docs/LIMITATIONS.md)
- [Release-readiness audit](docs/RELEASE_READINESS.md)
- [Grade data provenance](docs/GRADE_DATA_PROVENANCE.md)
- [Network & permission audit](docs/NETWORK_AUDIT.md)
- [Branding & naming](docs/BRANDING.md)

## Registration policy

UT Austin [prohibits automated add/drop/registration programs](https://registrar.utexas.edu/schedules/272/whentoregister). Fastlane never submits forms, clicks registration buttons, sends enrollment requests, refreshes pages, polls seat availability, or bypasses login. You submit every registration request yourself.

## License

MIT — see [LICENSE.md](LICENSE.md). Upstream copyright notices are preserved; third-party notices ship in the extension as `THIRD_PARTY_NOTICES.txt`.
