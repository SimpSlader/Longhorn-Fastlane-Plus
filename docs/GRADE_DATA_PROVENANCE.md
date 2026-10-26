# Historical grade dataset — provenance and redistribution audit

_Audit date: October 21, 2026. Status: **bundled copy kept (same as UT Registration Plus); separate public hosting ON HOLD.**_

## What the dataset is
- File: `src/assets/database/grade_distributions.db` (SQLite, 13,078,528 bytes, SHA-256 `70ef69098cf0439e92c72b010060a5e7acb9656c23615c91bf61579645e2fea5`).
- 81,255 rows, Fall 2019 – Summer 2026. Each row is one section-semester with **aggregate counts** per letter grade (A … F, Other), department, course number, and instructor name.
- No student-level records. "Other" groups non-letter outcomes (in progress, incomplete, Q-drop, withdrawn, CR/NC, etc.).

## Chain of custody
1. **Origin — UT Austin.** The counts come from UT's official [UT Course Grade Distributions dashboard](https://reports.utexas.edu/spotlight-data/ut-course-grade-distributions) (Office of Institutional Reporting, Research, and Information Systems). UT publishes it publicly and suppresses courses where student confidentiality cannot be maintained (small classes), so the published counts are already de-identified by UT.
2. **Collection — [UT_Grade_Parser](https://github.com/doprz/UT_Grade_Parser)** (code licensed MIT OR Apache-2.0) downloads the dashboard's CSV exports and builds the SQLite file. The code license covers the tool, **not** the data.
3. **Redistribution — UT Registration Plus.** UTRP bundles the file and refreshes it through reviewed pull requests (most recently `1e3f278` "chore: summer 2026 grades", #968). UTRP has distributed it publicly in its Chrome Web Store extension and GitHub repository for several years, and links "Data Source" to the UT dashboard.
4. **Fastlane** ships the file **byte-for-byte unchanged** from UTRP (verified by the SHA-256 above and `pnpm data:check`).

## Rights analysis (not legal advice)
| Question | Finding |
| --- | --- |
| Is there an explicit open-data license? | **No.** Neither the UT dashboard nor UT_Grade_Parser nor UTRP states a license for the data. |
| Is it public information? | Yes. UT publishes it openly without sign-in; aggregate grade distributions are public information under the Texas Public Information Act. |
| Copyright | Raw factual counts are generally not copyrightable (Feist v. Rural). The dashboard's presentation/selection may be; Fastlane uses only the numbers. |
| Privacy (FERPA) | Aggregates published by UT after small-cell suppression; no student-level data. Fastlane adds none. |
| UT web policy | UT's web content reuse guidance asks reusers to identify the source and URL, add a non-endorsement disclaimer, and keep attribution. Fastlane's tooltips name the source and dataset date, the chart links to the UT dashboard, and every page states that Fastlane is not affiliated with or endorsed by UT. |
| Precedent | Distributed for years by UTRP (a recognized student organization project) without objection. |

## Decision
- **Keep bundling** the unchanged file inside the extension (same footprint as UTRP), with attribution and the non-endorsement disclaimer.
- **Do not host the dataset separately** (GitHub Pages / CDN) until written approval. The `Publish public datasets` workflow now has no automatic trigger and runs only when the repository variable `DATASET_REDISTRIBUTION_APPROVED=true` is set **and** a confirmation phrase is typed. GitHub Pages is not enabled on the repository, and the extension build has no dataset update URL (`VITE_FASTLANE_DATA_MANIFEST_URL` unset), so installed extensions make no dataset requests.

## To unblock separate hosting
1. Email UT IRRIS (via the dashboard's contact) and/or the Office of the Registrar describing: static redistribution of the dashboard's aggregate counts in a free student tool, with attribution and disclaimers. Ask for written permission or a stated license.
2. Optionally ask UTRP maintainers how they confirmed their use.
3. Record the reply in this file, then set `DATASET_REDISTRIBUTION_APPROVED=true`.
