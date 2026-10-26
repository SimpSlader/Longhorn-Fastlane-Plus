# Automated test results (release-readiness audit)

_Run on 2026-10-21, branch `release/readiness-audit`. Node 24.13, Playwright 1.64 with its bundled Chromium (`channel: 'chromium'`, the same setup CI uses)._

## Unit tests (Vitest, jsdom): 215/215 passed in 20 files

Includes UT Registration Plus's 80 original tests.

| File | Passed |
| --- | --- |
| `src/fastlane/__tests__/audit.test.ts` | 14/14 |
| `src/fastlane/__tests__/datasets.test.ts` | 11/11 |
| `src/fastlane/__tests__/grades.test.ts` | 15/15 |
| `src/fastlane/__tests__/integration.test.ts` | 23/23 |
| `src/fastlane/__tests__/meetings-modality.test.ts` | 18/18 |
| `src/fastlane/__tests__/plans.test.ts` | 12/12 |
| `src/fastlane/__tests__/queue-detect.test.ts` | 12/12 |
| `src/fastlane/__tests__/recommend.test.ts` | 10/10 |
| `src/fastlane/__tests__/reminders-autofill.test.ts` | 13/13 |
| `src/fastlane/__tests__/ut-structures.test.ts` | 5/5 |
| `src/shared/types/tests/Course.test.ts` | 2/2 |
| `src/shared/util/tests/colors.test.ts` | 19/19 |
| `src/shared/util/tests/random.test.ts` | 2/2 |
| `src/shared/util/tests/string.test.ts` | 9/9 |
| `src/shared/util/tests/themeColors.test.ts` | 2/2 |
| `src/shared/util/tests/time.test.ts` | 1/1 |
| `src/views/components/calendar/utils.test.ts` | 37/37 |
| `src/views/components/injected/CourseCatalogInjectedPopup/GradeBarChart.test.tsx` | 2/2 |
| `src/views/hooks/tests/useFlattenedCourseSchedule.test.ts` | 4/4 |
| `src/views/lib/CourseCatalogScraper.test.ts` | 4/4 |

## End-to-end tests against the packaged ZIP: 15/15 passed

The release ZIP (`fastlane-course-planner-1.0.0.zip`, 8,457,620 bytes, SHA-256 `8d50877a1a05fbe3530b0bb9b6c76557277463876a2516de789ff2fe8065dacb`) was unzipped into an empty folder and loaded unpacked. Every test launches a **fresh Chromium profile** containing only this extension (UT Registration Plus not installed).

| Scenario | Result |
| --- | --- |
| Chrome extension permissions & security › manifest requests only the minimal permissions and UT hosts | pass |
| fresh profile › only this extension is installed and its pages load without errors | pass |
| course listing integration (demo fixtures, real code) › inline grade percentages, threshold changes, async and conflict indicators | pass |
| course listing integration (demo fixtures, real code) › backups do not join the active schedule, prevent duplicates, and persist after reload | pass |
| grade distribution graph (Highcharts replacement) › opens the course popup with a dependency-free SVG chart | pass |
| registration assistant › queue transitions, undo, history, and persistence | pass |
| registration assistant › optional autofill fills the ADD field only and never submits | pass |
| optional outcome suggestions (UT-shaped add/drop form) › suggests from #message only after the student submits, and waits for confirmation | pass |
| network activity matches the privacy policy › extension pages contact no third-party hosts | pass |
| degree audit, recommendations, reminders, map, wallpaper › imports an IDA HTML file locally and shows review items | pass |
| degree audit, recommendations, reminders, map, wallpaper › recommends only cached, requirement-matching sections with honest availability | pass |
| degree audit, recommendations, reminders, map, wallpaper › reminders create chrome.alarms and can be cleared | pass |
| degree audit, recommendations, reminders, map, wallpaper › campus map and wallpaper render locally | pass |
| degree audit, recommendations, reminders, map, wallpaper › works offline: grades, conflicts, plans and cached recommendations | pass |
| degree audit, recommendations, reminders, map, wallpaper › delete all Fastlane data removes plans, queue and audit | pass |

Stability: the suite was also run with `--repeat-each=2` (28/28 passed).

## Other checks

| Check | Result |
| --- | --- |
| Type check (`tsgo --noEmit`) | no errors |
| Biome lint/format (`pnpm run check`, UTRP's best-practices workflow) | no errors (124 style warnings, same categories as upstream) |
| Security check on `dist/` and on the unzipped ZIP | passed (MV3, CSP, 5 permissions, UT-only hosts, no remote code, no telemetry endpoints) |
| Bundled grade DB manifest (`data:check`) | up to date |
| Third-party notices | regenerated; 391 packages; no Highcharts |

## GitHub Actions

See the pull request checks for the CI run on this branch (`Fastlane CI`: type check → unit → data check → build → security → package → security on ZIP → e2e on ZIP).
