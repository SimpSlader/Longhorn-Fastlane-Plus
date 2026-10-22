# Complete UT course-offerings coverage — implementation requirements

## Why this is needed
Fastlane originally collects only UT course-schedule result pages a user has opened. If the browser cache contains UGS only, changing the subject to Economics cannot yield ECO sections. An AI ranking model cannot fix an incomplete input corpus.

PR #9 solves the **subject menu and filter correctness** but does **not** claim complete semester **course/section offerings**.

## Authoritative sources
- 2026–27 official A–Z fields of study: https://catalog.utexas.edu/general-information/coursesatoz/
- Spring 2027 printable course-offerings PDF: https://registrar.utexas.edu/schedules/272/print (PDF link is a public UT Box share).
- Live UT section schedule: https://utdirect.utexas.edu/apps/registrar/course_schedule/ (university sign-in may be required).

## Next implementation (for local coding agent)
1. Download the official Spring 2027 offerings PDF from UT's Registrar page using the user's browser (the PDF host is blocked in this remote coding environment). Inspect its real table/text structure before designing or claiming a parser.
2. Build a **verified full semester offering inventory** with source URL, publication/import date, term, subject, course code, title and any genuinely available unique numbers. Test against actual PDF pages from A, E, F, M, S and U. Track parse errors and unknown rows; do not fabricate sections or professors.
3. Determine redistribution rights before committing a full extracted snapshot to this repo or hosting it on Vercel. If redistribution permission is unclear, make the original PDF import run **locally in the student's browser** with an opt-in file picker. The import should persist only user-owned derived factual records in IndexedDB.
4. Distinguish `catalog course`, `semester offering`, and `verified current section` in types and UI. Do not treat a catalog course as offered next semester, assign a unique number when none is known, or label cached seat availability as live.
5. Merge the approved semester inventory with existing local section cache without deleting any schedules, degree audits, or verified observed seat statuses. Use semester+course+unique ID keys, avoid duplicate cross-listed sections, normalize spaced subjects (e.g., C S, B A, A I), and keep provenance.
6. Search A–Z for real course offerings by subject, code, course title, level and optional modality. For codes without actual section details, show **View in UT** instead of Add to Schedule. Only real verified sections can be added or used in time-conflict schedule generation.
7. Extend AI to consider all verified catalog/semester offerings for advising, but require actual section records to create a schedule. Do not pass fabricated unique numbers or fake grade distributions. Explain when only course-level (not section-level) evidence is available.
8. Add per-semester refresh/version and coverage diagnostics (e.g. `Spring 2027: 243 subjects known, 185 with verified offerings, 34 with fully parsed sections`, only with grounded counts).
9. Test realistic scenarios: selecting ECO does not show UGS, browsing FIN and ACC works without previous page visits, historical A data joins by course, no non-UT origin auth leaks, correct behavior offline, cached data preserved on update.
10. Keep CI green (type, Biome, unit, packaged Chrome e2e, security) before syncing the existing unpacked extension directory.

**Acceptance criteria:** An ordinary student installing Fastlane can browse all officially listed subjects; selecting ECO/ACC/FIN/M/HIS displays actual source-grounded courses without requiring the student to visit every department manually. If a chosen term's complete offerings are not available, UI explicitly states that, rather than returning UGS.

If the official PDF cannot be parsed accurately, ship the valid A–Z subject picker and explain the data limitation rather than injecting guessed offerings.
