# Data sources and licensing

Fastlane never invents statistics, sections, openings or requirements. Every number shown comes from one of the sources below, and each display names its source and date.

| Dataset | Source | How it gets into Fastlane | Redistribution status | Freshness shown to students |
| --- | --- | --- | --- | --- |
| **Historical grade distributions** (`src/assets/database/grade_distributions.db`, SQLite, 81,255 rows, Fall 2019 – Summer 2026 at the time of writing) — full audit in `GRADE_DATA_PROVENANCE.md` | UT Austin's public [UT Course Grade Distributions dashboard](https://reports.utexas.edu/spotlight-data/ut-course-grade-distributions) (IRRIS), compiled by [UT_Grade_Parser](https://github.com/doprz/UT_Grade_Parser) (code: MIT OR Apache-2.0) and redistributed in UT Registration Plus | Bundled unchanged from UT Registration Plus; refreshed through the upstream-sync workflow; optionally re-published as a versioned file on GitHub Pages | Already redistributed publicly by UT Registration Plus. The underlying records are public information, but **no explicit open-data license is attached**. **Separate hosting is on hold** (workflow gated, Pages disabled). Before enabling it, confirm with UT's Office of the Registrar / IRRIS (or legal counsel) that redistribution is acceptable. | Dataset version, last-updated date and latest semester in every tooltip and in Settings; warning after 200 days |
| **Course sections** (times, rooms, instructors, instruction mode, core, status) | UT's course schedule pages that the student opens while signed in | Read from the visible page, saved locally in the student's IndexedDB | Not redistributed. Never uploaded. | "Open as of <time>" only within 30 minutes of being seen; otherwise "Check availability" |
| **Degree requirements** | The student's own Interactive Degree Audit file | Parsed locally; stored in `chrome.storage.local` | Personal data; never leaves the browser | Import date shown |
| **Core curriculum names/codes** | UT core curriculum component codes (010–093) | Small table in `src/fastlane/core/requirements.ts` | Factual identifiers | n/a |
| **Campus map & walkway graph** | UT Registration Plus (`src/assets/UT-Map.svg`, `graphNodes.ts`) | Bundled | MIT (UT Registration Plus). The map artwork depicts UT's campus; keep UTRP attribution. | Labeled as estimates |
| **Professor information** | Instructor names from UT listings; links to UT's syllabus/CV archive and Rate My Professors search (inherited from UTRP) | Links only | Fastlane does **not** scrape or bundle Rate My Professors ratings or syllabus files | n/a |

## Not used

- No scraping of authenticated UT systems in the background, no seat polling, no registration APIs.
- No Rate My Professors data is copied or redistributed (their terms prohibit it).
- No third-party grade datasets beyond the one above. Community datasets (e.g. `DereC4/ut-grade-data`) must have provenance and licensing reviewed before inclusion.

## Dataset update format

`data/manifest.json` (see `src/fastlane/data/datasets.ts`):

```json
{
  "manifestVersion": 1,
  "generatedAt": "2026-10-21T00:00:00Z",
  "datasets": [{
    "id": "grades", "version": "2026.10.20.70ef6909", "schemaVersion": 1, "format": "sqlite",
    "url": "https://<owner>.github.io/<repo>/data/grades-2026.10.20.70ef6909.sqlite",
    "sha256": "<64 hex>", "bytes": 13078528, "publishedAt": "2026-10-20T00:00:00Z",
    "source": "…", "license": "…"
  }]
}
```

The extension accepts an update only if: the host is the configured HTTPS host; the manifest and schema versions are supported; `publishedAt` is not in the future; the download size and SHA-256 match; the payload is a SQLite file or a JSON envelope `{dataset, schemaVersion, records[]}`; and the data is newer than both the installed and the bundled copy. Otherwise the previous valid data stays in use. Downloads contain data only — never code.
