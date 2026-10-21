# Open-source license compliance report

Generated for Fastlane Course Planner 1.0.0 (October 21, 2026). Regenerate the shipped notices with `pnpm notices`.

## Highcharts removed

UT Registration Plus used Highcharts (free only for non-commercial use) for the grade-distribution graph. It was replaced by an in-house SVG chart (`GradeBarChart.tsx`, MIT as part of this project) and removed from `package.json`. All remaining bundled dependencies use permissive licenses (MIT, Apache-2.0, ISC, BSD, 0BSD, CC0, BlueOak); MPL-2.0 `lightningcss` is build-time only.

## Upstream projects

| Project | License | Use in Fastlane | Obligations and how they are met |
| --- | --- | --- | --- |
| UT Registration Plus (`1e3f278`, v2.4.1) | MIT, © 2023 Sriram Hariharan | This repository is a fork; most of the codebase | Original copyright and permission notice kept in `LICENSE.md` (modification line added), in `docs/UPSTREAM_README.md`, and in the shipped `THIRD_PARTY_NOTICES.txt`. |
| Degree Audit Plus (`83e0265`) | MIT, © 2026 Longhorn Developers | Parsing approach for IDA markup (re-implemented in `src/fastlane/audit/parseAudit.ts`); two HTML fixtures copied into `src/fastlane/__tests__/fixtures/` for tests only (not shipped) | License text in `docs/licenses/Degree-Audit-Plus-LICENSE.txt` and in `THIRD_PARTY_NOTICES.txt`. |
| UT_Grade_Parser | MIT OR Apache-2.0 | Produced the grade database (data, not code) | Credited in notices and `docs/DATA_SOURCES.md`. |
| Original Fastlane prototype (v0.2) | Owned by the requesting student | Queue logic, detection patterns, planner ideas | Re-implemented in TypeScript. |

## Bundled third-party packages

`pnpm licenses list --prod` reports 393 packages:

| License | Count | Notes |
| --- | --- | --- |
| MIT | 353 | Notices included |
| Apache-2.0 | 14 | Includes **pdfjs-dist** (bundled for local PDF parsing). License text included; no NOTICE file modifications required. |
| ISC | 13 | Notices included |
| BSD-2/3-Clause | 6 | Notices included |
| MPL-2.0 | 2 | `lightningcss` — build-time only, not shipped in the extension bundle |
| 0BSD, CC0-1.0, BlueOak-1.0.0, Python-2.0 | 4 | Permissive |

Some packages are listed as production dependencies only because UT Registration Plus declares them that way (e.g. `typescript`, `@typescript/native-preview`); they are build tools and are not in the shipped bundle.

## Trademarks and branding

- The product was renamed from "Longhorn Fastlane Plus" to **Fastlane Course Planner** so the name contains no UT Austin marks ("Longhorn(s)" and the longhorn silhouette are registered UT marks). See `docs/BRANDING.md` for the name check and alternatives.
- Original icon; no longhorn silhouette, UT seal or wordmark. UTRP's logo was replaced in the extension UI.
- "UT Registration Plus" and "UT Austin" appear only in attribution and descriptive text.
- The listing, privacy policy and UI state that the product is independent and not approved by UT.
- Remaining owner action: USPTO search for "Fastlane" in software classes; optional courtesy check with UT Trademark Licensing about the orange accent color.
