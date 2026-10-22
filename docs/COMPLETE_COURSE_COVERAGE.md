# Complete UT course coverage

## What students get
Fastlane can hold **every section of every subject** for a semester without the student opening each department.
The source is the Registrar's public **"PDF of courses offered"** (e.g. Spring 2027:
<https://registrar.utexas.edu/schedules/20272/print>, file `ut.courses.Spring2027.pdf`). No UT EID is needed to
download it. The student downloads it from UT and picks it once in **Find classes → All UT classes for the semester**.
It is parsed in the browser (bundled PDF.js) and stored in the extension's IndexedDB. Nothing is uploaded, and
Fastlane does not redistribute UT's file or a copy of its data.

Measured on the Spring 2027 document (as of 10/01/2026, 368 pages):

| | |
| --- | --- |
| sections parsed | 11,118, which is every printed unique number. None are missing or extra (`offerings-real-pdf.test.ts` compares against the PDF's own bullets). |
| courses / subjects | 5,109 courses in 231 subjects (245 subjects in the PDF legend) |
| unparsed rows | 7. Each is printed without days (e.g. `1200 - 1200`); they are kept with "meeting times unknown", not guessed. |
| printed prerequisites | 8,703 sections; 4,570 name specific courses |
| time to import / show a subject | about 5 s / about 7 s on first view (Chromium e2e) |

## Why not UT Registration Plus alone
UTRP's course scraper (`CourseCatalogScraper`), pagination (`loadNextCourseCatalogPage`) and unique-number lookup
(`getCourseByURL`, used by Quick Add) all read UT pages that the signed-in student opens, one listing at a time.
UTRP has no complete semester dataset. Crawling every department through the authenticated schedule would
mean automated bulk requests with the student's session, which Fastlane does not do. Fastlane reuses UTRP
where it fits:
- every listed section is a real UTRP `Course`, so UTRP's calendar, schedules and conflict checks work unchanged;
- historical grades come from UTRP's bundled database through `queryAggregateDistribution` (department, number,
  instructor last name). An in-memory index makes per-course lookups fast enough for browsing;
- **Confirm on UT** uses UTRP's `getCourseByURL` for one section with the student's own session, then stores the
  confirmed details and seat status.

## Evidence levels shown in the UI
1. **Listed by UT Registrar · as of <date>**: the section is in the official course list. Its seats were not checked.
2. **Confirmed on UT · <time>**: the student viewed the section on UT's course schedule, or pressed Confirm on UT.
3. **Availability**: shown only from a confirmed status, with when it was seen. Never shown as live.

A confirmed record is never replaced by a listing. The listing's provenance and prerequisites are attached to it.
Re-importing a newer PDF removes listings that disappeared and keeps confirmed sections, schedules and the IDA.

## One inventory for every feature
`loadCachedSections` → `data/sectionStore.ts` is the single source for Browse classes, For my degree,
AI recommendations, the schedule builder and Compare. Subject filters compare exact subject codes
(`subjectOf`), so ECO is only Economics, FIN only Finance, ACC only Accounting, `C S` only Computer Science.

## Recommendations and AI
- Rule-based ranking (`core/recommend.ts`): unfinished IDA requirement tags, semester, conflicts, modality,
  historical grades (looked up for the top 300 only), professor data, preferences, and **printed prerequisites**
  (`core/prerequisites.ts`). A clearly missing prerequisite moves a section below the others.
- AI candidates (`core/aiCandidates.ts`) are chosen locally from the whole inventory by applicability,
  prerequisites, conflicts, preferences and grades, spread across subjects (at most 2 sections per course).
  Each candidate is sent with those facts, and the server prompt explains them. AI drafts skip sections with
  clearly missing prerequisites.

## Open owner decisions
- Whether a future release may **ship** a pre-parsed course list (redistribution of UT's data). Until then the
  student imports UT's own file.
- Core-curriculum and flag codes are not printed in the PDF. They come from sections the student viewed on UT,
  and from course-specific IDA requirements.
