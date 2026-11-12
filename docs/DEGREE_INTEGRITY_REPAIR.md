# Degree recommendation integrity repair — October 31, 2026

## A. Root causes

| Boundary | Actual defect | Consequence |
| --- | --- | --- |
| IDA identity | A comma-separated selector returned the first `h1` in document order, sometimes “NAVIGATION MENU”; catalog text was searched in the wrong order | Degree program/catalog were missing or wrong |
| Requirement extraction | Completion was reduced to a flat set of tags, including partial requirements; shorthand course alternatives could be dropped | Counted, in-progress, planned and remaining capacity disappeared; UGS 303 could be lost from a 302-or-303 rule |
| Matching | Any matching tag or department could become “satisfies,” without a numeric remaining balance | Already-covered cores and unverified departmental electives appeared as progress |
| Solver allocation | One owner per tag regardless of hours | A three-hour arts slot and six-hour science component were treated identically |
| Multiple paths | AI tools, local backups, course finder and legacy recommendations computed applicability separately | Different answers for the same record |
| Final verification | Saved proposal verdicts were reused; exact codes alone defined duplicates | Audit edits, aliases and repeated credit could leave a stale positive verdict |
| JSON comparison | Meeting object order was treated as a data change | Saving/restoring identical meeting times could invalidate a plan |
| Academic totals | Course-list credits were sometimes relabeled degree credits; counted totals could include planned work | Unsupported earned-hour and graduation projections |
| Prerequisites | A partially satisfied AND expression returned “check”; in-progress work could appear fully satisfied | Missing or conditional prerequisites could be obscured |
| Schedule persistence | The stored serialized course could override the validated public section's identity/times | Saved calendar could disagree with a validated proposal |
| Language constraints | Conditional “if no UGS are available” became an exclusion; “won't need history” was missed | Correct sections could be excluded while unwanted ones remained |
| AI reporting | An optimistic final answer could conceal a failed scheduling tool; a 4,000-character string cut could break tool-result JSON | “Done” without a valid plan or a reliable machine-readable result |
| Old tests | Some scheduling tests supplied an empty audit but asserted verified applicability; recommendation tests expected arts classes despite an already-completed arts rule | Tests protected behavior that caused the reported bugs |

## B. Implemented architecture

`Student record → sourced rule balances → verified available capacity → real cached sections → prerequisites/time/travel constraints → grade/preference ranking → AI explanation → independent current-record validation → UI`

- `core/degreeRules.ts` provides a pure, deterministic ledger. It preserves units, counted hours, in-progress reservations, pending credit, remaining capacity and planned allocations. It never marks a planned course earned or mutates an imported audit. Courses share credit only through explicit sourced sharing groups; Core components remain mutually exclusive. Course alternatives are assigned globally within a bounded search. A search limit may under-assign; it cannot exceed capacity.
- The imported HTML audit supplies balances. PDF ambiguity, student edits, contradictory balances, repeated rules, stale audits, unknown complex conditions and broad department matches stay unverified. Pairing-sensitive broad Core 010/070 rules require individual course options. Major/catalog context changes invalidate old-plan applicability.
- `data/ut-core-2026.json` contains 945 course designations read from the official 2026–27 Core Curriculum page, with source, verification date and effective term. Part I courses are also options for Part II, but a course is allocated to only one component. This snapshot ends Summer 2027; future curricula require a new source. A contradictory recent listing is not accepted as proof.
- `data/ut-degree-policies-2026.json` records the verified BA Economics 2026–28 exclusions and permitted core/major sharing, explicit CNS astronomy exclusions scoped to recognized Computer Science programs/catalogs, and documented astronomy/music credit-exclusion groups. Degree initials and appended IDA major codes are normalized before policy lookup. It is a scoped policy set, not a fabricated complete catalog for every major.
- `audit/parseAudit.ts`, `core/academic.ts`, `core/academicModel.ts`, `core/gradPlan.ts` and `core/planning.ts` repair program/catalog detection, stable rule identifiers, failed/alias exclusions, repeat-credit totals, roadmap duplication and unsupported degree projections. Official IDA percentages and GPA are read, not invented or recomputed from requirement counts.
- `core/aiCandidates.ts`, `core/recommend.ts`, `services/recommendationService.ts`, `core/agentTools.ts`, `core/backups.ts` and `core/scheduleSolver.ts` share the ledger. Search/AI explanations cannot create course options or capacity. No unverified elective is inserted merely to reach a minimum load. Explicit manual exploration remains possible, with uncertain credit labeled accordingly.
- `core/toolSummary.ts` keeps oversized AI tool replies valid JSON, retaining all selected classes and the independent verdict or returning an explicit size error.
- `core/planValidator.ts` independently rechecks current audit, catalog identity/meetings, semester, finite credit hours, duplicates/equivalents, all required meetings, day-specific windows, prerequisites/restrictions, walking time, data freshness and quoted grade evidence. Missing prerequisite data prevents “All rules met.”
- `page/AiRecommendations.tsx`, `page/ProposalPanel.tsx`, `page/DegreeFitList.tsx` and `page/PlanningTools.tsx` recalculate current degree fit, cancel obsolete work after audit changes, show individual course outcomes and block saving invalid proposals. Raw AI preference prose cannot replace the deterministic degree label. Failed scheduling tools override optimistic model answers.
- `services/planningService.ts` guards duplicate enrollment and term consistency and saves canonical section identity, hours and meetings while retaining relevant course metadata. No Chrome storage schema migration or production student-record mutation is required.

## C. Verification record

Tests use the existing Vitest and Playwright frameworks; browser profiles are disposable. No live registration, student-record edit or provider charge is required for these regression tests. The complete updater runs locked dependency installation, TypeScript, Biome, unit tests, build, security checks, browser tests and a verified, backed-up sync to the existing unpacked Chrome installation. It retains the extension identity and does not reset user storage.

Final run: October 31, 2026, using the pinned Node/pnpm toolchain and `CI=1` (the existing two-worker browser configuration), with the public full-term PDF enabled.

| Check | Executed result |
| --- | --- |
| Locked dependency install | Passed |
| TypeScript | Passed |
| Biome | Passed; 412 warnings and six informational diagnostics remain, including test non-null assertions; not a warning-free lint run |
| Vitest | **569 passed across 52 files; zero failures or skips** |
| Production bundle with local reload helper | Passed |
| Extension security | Passed: 194 built files, existing five permissions |
| Playwright | **45 passed; zero failures, retries or skips** |
| Full public catalog | 11,118 sections; PDF import approximately nine seconds; no fabricated filler plan |
| Full-catalog responsiveness | Opening max task 0 ms; typing max task 0 ms; submitting max task 185 ms, within existing budgets |
| Verified installation | 194 files synchronized and hash-verified; backup created; existing extension identity retained |
| Diff whitespace | `git diff --check` passed |

An earlier full-catalog run exposed an outdated course-title selector, which was corrected to select the actual course-code element. One registration timing test flaked under four-worker catalog load; the final supported two-worker run passed without retry or relaxed assertions. The browser checks also cover offline use, privacy/network boundaries, extension reload recovery, registration non-submission, saved settings and plan persistence in disposable profiles. No assertion was weakened to accept fabricated degree progress.

The dedicated suite covers no prior credit; completed single-slot rules; arts redundancy; six-hour science; pending and accepted CLEP/AP/IB/transfer/dual credit; aliases and repeats; major/catalog changes; add/remove; missing/stale/contradictory data; core-complete records; approved electives; sharing; prerequisite AND groups; conditional prerequisites in both legacy and AI paths; imported prerequisite aliases; oversized tool-result JSON and nine-class summaries; lecture/lab conflicts; incomplete/arranged data; travel; invented AI matches; current-record revalidation; semantic meeting comparison; canonical saved courses; and capacity invariants across thirteen different balances. The browser regression deliberately seeds a false saved positive verdict, changes the audit and verifies that the displayed contribution is recomputed without AI or network requests.

The full public Spring 2027 Registrar PDF was available locally: all 11,118 parsed sections were exercised by the opt-in inventory, real-catalog planning and responsiveness checks. The real-catalog planner returned an explicit incomplete result instead of inventing extra degree-applicable courses. Live provider response quality is not proved by deterministic/mocked integration tests. No provider configuration or production API contract changed in this repair.

## D. Spring 2027 schedule audit

**This is a synthetic regression audit, not a determination of the student's actual degree progress.** The actual current IDA, catalog assignment, officially posted transfer/exam credit, unique section numbers, seat restrictions, prerequisites and complete meeting components were unavailable. The six proposed courses and times came from the request. Fixture identifiers are fictional and never become production offerings.

Fixture assumptions: six Part I science hours and three Part II hours remain; arts and signature requirements are unmet; Fall 2026 ECO 304K/GOV 310L are in progress; ENGL 2323's UT evaluation and the reported CLEP score's official posting remain pending. No other prior credit is assumed.

| Course | Validated fixture outcome | Planned degree hours identified |
| --- | --- | ---: |
| AST 301 | Advances one science component; cannot also spend the same credit in Part II | 3 |
| EDC 312 | Redundant for Core 080 while ECO 304K reserves that slot; elective applicability unverified | 0 |
| T D 301 | Uses the one arts slot in the supplied order | 3 |
| UGS 303 | Uses the outstanding signature slot, conditional on eligibility and successful completion | 3 |
| MUS 302L | Same Core 050 capacity as T D 301; redundant for that requirement, elective applicability unverified | 0 |
| PED 106C | Excluded from BA Economics 2026–28 degree hours; enrollment credit is separate | 0 |

Result: **16 enrollment hours, six courses; nine conditional degree-applicable hours identified in this fixture.** Selecting music instead of theatre can use the same arts slot; this does not establish that either course is unnecessary as a separately verified elective. No degree percentage or graduation date is inferred from this subset.

The four supplied timed classes have no overlaps using half-open intervals. T D 301 ending at 3:30 and UGS 303 starting at 3:30 leave zero travel time; room/building evidence is missing. “Asynchronous/Other” is insufficient to verify MUS/PED meetings. MUS 302L's catalog includes a required lab hour, so the actual section's full components matter. The fixture therefore never receives “All rules met.”

Official evidence checked October 31, 2026:

- [UT 2026–27 Core Curriculum](https://catalog.utexas.edu/general-information/academic-policies-and-procedures/core-curriculum/): the listed course/component relationships. [UT Core guidance](https://undergraduates.utexas.edu/core-curriculum/requirements/current) states the single-core-component limit; its linked printable list is older, so current course designations use the catalog snapshot.
- [Economics degree-plan index](https://liberalarts.utexas.edu/economics/undergraduate-program/degree-requirements/degree-plans.html) requires selecting the appropriate catalog. It notes the removal of prior Skills and Experience Flag requirements, while core writing requirements remain. The [2026–28 BA Economics plan](https://minio.la.utexas.edu/webeditor-files/economics/pdf/26-28%20ECO%20BA.pdf) connects ECO 304K to Core 080, distinguishes the additional ECO 304L requirement and excludes physical activity from the hour minimum. Flags are not guessed from historical course labels.
- [College of Liberal Arts policy](https://catalog.utexas.edu/undergraduate/colleges-schools/liberal-arts/) explains the PED exclusion, repetition restrictions and the role of an official degree check.
- [UT CLEP Macroeconomics](https://testingservices.utexas.edu/clep-exam-principles-macroeconomics): 64 falls within the ECO 304L score range, but a score report is not proof of posted, accepted credit. [UT transfer resources](https://admissions.utexas.edu/apply/transfer-students/transfer-credit-resources/) distinguishes transcript evaluation from degree applicability. [UT English catalog](https://catalog.utexas.edu/courses/e/) lists ENGL 2323 with E 316L; the actual student's UT evaluation remains unverified.
- [Astronomy catalog](https://catalog.utexas.edu/courses/ast/) documents overlapping-credit restrictions and [Music catalog](https://catalog.utexas.edu/courses/mus/) documents MUS 302L's components and credit restrictions.

## E. Remaining boundaries

- No access to this student's current private IDA was required or obtained. Reimport a current audit to replace assumptions. Considering McCombs does not silently change the declared degree; an official audit for the new program/catalog is needed.
- The app does not contain a complete machine-readable rule catalog for every UT major, all college-specific exclusions, petitions, residency/grade exceptions, topic-specific repeats or all cross-listings. The verified college exclusions are scoped to the programs explicitly named in the bundled policy set; this is not a claim that every other program has been reviewed. Unsupported rules remain unverified and may reduce or prevent automatic schedules. Only explicitly approved course options with scoped source evidence can fill those rules.
- Course designations do not establish current seat availability, registration permission or complete meeting components. The planner uses real cached sections and reports stale/unknown evidence. It does not fetch private SAML pages, submit registration or invent sections.
- Graduation timelines remain conditional hour scenarios, subject to course sequence, residency, minimum GPA, degree applicability, offerings and credit posting. They are not official graduation clearance.
- Store exports and local history retain existing privacy behavior. The source changes add no provider permission, analytics, account service or transmission of the full audit. Test fixtures and screenshots contain no actual student record.

## F. Reliability assessment

The executable checks establish numeric capacity limits, conditional versus posted credit, nonduplicated course identities, deterministic ranking/assignment, current-record revalidation and explicit uncertainty for unsupported data. They do not certify a particular student's graduation eligibility. FastLane is suitable for advisory course planning with those visible boundaries; an official UT audit/advisor remains necessary for final degree and registration decisions.
