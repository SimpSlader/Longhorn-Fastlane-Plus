# Schedule failure recovery — October 31, 2026

The reported request asked for 15–16 hours, Tuesday/Thursday only, outstanding core courses, no history, one UGS, preferably two online classes, and gaps of at most 15 minutes. The chat repeatedly displayed a generic failure sentence.

## Repairs

- The local scheduling tool already returned reasons and checked alternatives. The chat's error override discarded everything except `error`. `core/planningFailure.ts` now formats the local reasons, verified alternative course lists and actionable next steps. Model prose such as “Done. All rules met.” cannot replace a failed tool's actual result.
- `PlanningPreferences.maxGapMinutes` and `ScheduleConstraints.maxGapMinutes` preserve an explicit gap limit across follow-ups. The solver checks complete combinations, allowing another course to bridge a partial gap; the independent validator also rejects a result over the limit. Back-to-back preference alone remains a ranking preference.
- “Preferably two online classes” is a preference rather than a hard maximum. Explicit “at most” and “no online” rules remain hard constraints, including after a previous preference.
- Single-rule recovery searches now include widening the gap limit and lowering the requested credit range while retaining the other rules. Only real, validated cached-section combinations are displayed; changes are not applied automatically.
- Search explanations distinguish failure to find a complete combination from proof of impossibility. If the bounded search reaches its limit, the reply says so. Missing eligible sections or audit evidence produces import/verification guidance.

## Regression coverage

Unit tests cover detailed failure rendering, the exact request and retry, hard gap enforcement, gap bridging, independent rejection, soft online counts, and a later no-online instruction. A browser regression scripts an optimistic model response after the real scheduling tool fails, verifies that both conversation turns show blockers, and compares the actual saved schedules before and after.

The full local updater also exercises the public 11,118-section Spring 2027 catalog, existing planner flows, privacy, extension reloads and registration safeguards. Final run: **574 unit tests across 53 files and all 46 browser tests passed**, zero failures, retries or skips. TypeScript, Biome (warnings remain), build, security and diff checks passed. The updater backed up the existing extension and synchronized/hash-verified 194 files without resetting user data. The browser regression captured the rendered recovery reply for visual inspection.

A failed strict request can still be legitimate. These changes do not invent sections, assume unknown degree credit, or silently relax the student's requirements. They make the failure useful and expose checked alternatives when available. This regression uses synthetic audit evidence; it does not establish whether the actual student's current private audit admits the requested schedule.
