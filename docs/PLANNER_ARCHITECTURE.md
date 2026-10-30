# AI planner: how a schedule is produced and checked

## Flow
`chat message` → `AiRecommendations.copilot()` → `runCopilot` (model + tool loop, `api/agent.mjs` on Vercel; the router in `api/_ai` picks the provider/model with fallback) → `runTool` (`core/agentTools.ts`) → `solveSchedule` (`core/scheduleSolver.ts`) → `validatePlan` (`core/planValidator.ts`) → `showPlan` → `WeekGrid` calendar. The model's final text passes through `guardReply` (`core/claimGuard.ts`).

## What the model may and may not do
- **May:** read the request, pick tools, pass arguments, explain a validated result.
- **May not:** choose final sections, decide that rules are met, or loosen a rule the student stated. Tool arguments are schema-checked (`core/toolArgs.ts`); bad calls return errors (the loop is bounded at 8 rounds) and never reach the solver or calendar.

## Hard rules vs preferences
Hard (solver filters + validator re-checks): one semester; credit range (async classes count in full); allowed meeting days/times; excluded subjects/titles/courses/sections; no overlaps; walking time between buildings (`core/travel.ts`, campus walkway graph, conservative detour factor, unknown building = *unverified*); exactly N classes of a subject (one UGS); core-only (every class fills its own outstanding Core requirement, matched with a bipartite assignment in `core/requirementFit.ts`, so UGS 302/303 are alternatives); online cap; real, identifiable sections.
Preferences (score only): GPA outlook, compactness, online count, stability on follow-ups, secondary professor ratings.
`core/plannerRules.ts` extracts the hard rules **from the student's own words, deterministically** and `enforceStated` merges them over whatever the model passed. Persistent rules come from "remember …" (memory store); everything else is session scope; `reduce/undoLast/anotherOption/isCurrent` give per-field follow-ups, undo, different-option and stale-response protection.

## Infeasible requests
No schedule is invented. `build_schedule` returns the reasons plus `closestAlternatives`: each solved and validated with exactly one rule relaxed, labelled as requiring the student's permission, never placed on the calendar.

## GPA model (`core/gpaModel.ts`)
Dirichlet-smoothed grade distribution (typical-UT prior worth 25 students), UT grade points, A and A− kept separate, old data (≥4 years) at half weight, ranking by a conservative lower bound on expected grade points. Instructor vs course scope is carried through. No counts → no estimate (never a default percentage). Not available in the data, and therefore not claimed: per-semester consistency (one aggregated distribution per course/instructor) and future instructor assignments beyond the listing. Rate My Professors is a small secondary nudge only.

## Validator (`core/planValidator.ts`)
Every check is `pass | fail | unverified`. `hardOk` = no fail; `allRulesMet` = everything passed *and* the records were verified (degree audit present and used, section data fresh, buildings mapped, grade figures backed by counts, pending transfer/exam credit not counted as awarded). The panel's "All rules met" pill and the appended chat verdict come only from this report; struck claims in model text read "[not confirmed by the validator]". Backups are swapped into the schedule and re-validated.

## Known gaps
- Section data comes from what the student viewed / the Registrar offerings import; seat status is the student's observation, not live.
- Prerequisite verification is unchanged (printed prerequisites vs audit).
- The legacy non-copilot local planner still exists; its proposals are validated by the same report for the pill, but its solver path was not otherwise changed.
