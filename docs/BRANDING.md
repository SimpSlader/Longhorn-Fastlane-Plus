# Branding and trademark-safe naming

## Product name: **Fastlane Course Planner**
- Short name (toolbar / manifest `short_name`): **Fastlane Plus**
- Store summary uses "UT Austin" only **descriptively** ("planner for UT Austin students"), never as part of the name.
- Previous working name "Longhorn Fastlane Plus" was retired: "Longhorn"/"Longhorns" and the longhorn silhouette are registered UT Austin marks.

### Why this name
| Check | Result |
| --- | --- |
| Contains UT marks (Longhorn(s), Hook 'em, Bevo, UT seal, "Texas" as a brand)? | No |
| Implies endorsement by UT or the UT Registration Plus team? | No; every surface carries a non-affiliation statement |
| Existing Chrome Web Store extension named "Fastlane"? | None found (search on 2026-10-21) |
| Known uses of "fastlane" elsewhere | *fastlane* (open-source iOS/Android release automation, fastlane.tools), "FastLane" toll programs, NSF's former FastLane grants portal. Different goods/services; low confusion risk for a course planner, but **run a USPTO search (tess/"Trademark Search") in class 009/042 before publishing.** |

### Alternatives (if a conflict appears)
1. **Course Fastlane** 2. **Registration Fastlane** 3. **Schedule Fastlane** 4. **Planlane** — all avoid UT marks.

## Original branding
- **Icon:** original mark — dark slate rounded square with an orange lightning "lane" and two white speed lines (`store-assets/icon.svg`, rendered by `scripts/fastlane/render-icons.mjs`). No longhorn silhouette, no UT seal, no tower, no UT wordmark.
- **UTRP logo** removed from the UI (`LogoIcon.tsx` now draws the Fastlane mark and "Fastlane / Course Planner").
- **Colors:** the interface keeps UT Registration Plus's orange accent for familiarity (as UTRP does). The icon uses #E87722 rather than UT's licensed burnt orange #BF5700. If UT Trademark Licensing objects to the in-app accent, change `--accent` in `src/fastlane/page/fastlane.css` and the injected chip colors — layout is unaffected.
- **Screenshots** show only the offline demo page labeled "Not a UT page".

## Required disclaimer (keep everywhere)
> Fastlane Course Planner is an independent, student-developed project. It is not affiliated with, endorsed by, or approved by The University of Texas at Austin or the UT Registration Plus team.

## Repository name
The GitHub repository is still `SimpSlader/Longhorn-Fastlane-Plus`. Renaming it (GitHub keeps redirects) is recommended before public promotion; update `homepage` in `package.json` and `FASTLANE_REPO_URL` in `src/fastlane/config.ts` afterwards.
