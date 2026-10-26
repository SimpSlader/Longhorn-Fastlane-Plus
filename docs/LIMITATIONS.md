# Known limitations

Honest list of what is not verified or not implemented.

## Not verified against live, signed-in UT pages
These were tested against UT Registration Plus's scraper selectors, a real saved UT course-schedule page and a real IDA page (both from Degree Audit Plus), and local fixtures shaped like UT markup. They have **not** been run against a live, authenticated UT session in this build:
1. **Registration screen** (partially validated): the field names `s_unique_add`, `s_unique_drop`, `s_swap_unique_add/drop`, the `s_request` radios and the `#message` areas were confirmed from public sources and are covered by `ut-structures.test.ts`, but no capture of the live page was available. The add/drop page URL pattern (`utdirect.utexas.edu/registration/*.WBX`, excluding classlist/waitlist) and the "add" field detection (`name`/`id`/label containing *unique* + *add*, never *drop*). If UT's field is not recognized, autofill does nothing and says so; copy still works. Calibrate with a redacted copy of the real page.
2. **Result messages** for the optional outcome suggestions use conservative phrase matching from the prototype. Exact UT wording is unconfirmed; suggestions always require a click.
3. **Instruction-mode text**: async detection relies on UT's "Instruction Mode" column (e.g. "Internet") and empty Days/Hour cells. If UT changes wording, sections fall back to "Delivery unclear" rather than blue.
4. **Core column**: requirement tags are derived from the Core column's text (full names or codes). Unusual wording is not tagged, so such sections won't appear in requirement-based recommendations.

## Data
5. **Grade data** covers Fall 2019 – Summer 2026 (bundled from UTRP). UTRP matches professors by **last name** only, so two instructors with the same last name teaching the same course are combined. Professor-specific vs course-wide is always labeled.
6. **Recommendations only know sections you have viewed** on UT's course schedule (cached locally) — there is no bundled full course catalog, because UT's schedule requires sign-in and Fastlane does not crawl it. Browse a requirement once (e.g. search by core) to populate options.
7. **Seat availability** is whatever UT displayed when you viewed the page; after 30 minutes it reverts to "Check availability".
8. **Prerequisites and reserved seats** are surfaced as warnings (reserved flag from the listing, restriction sentences from the audit). Fastlane does not verify prerequisite completion.
9. **IDA PDF parsing** is heuristic (PDFs lose status icons); statuses are inferred from hours and every item is marked for review. Saved HTML is more accurate.
10. **Credit hours remaining** appear only when the audit contains a recognizable total-hours rule.
11. **Dataset updates** are off (no `VITE_FASTLANE_DATA_MANIFEST_URL`). Separate public hosting of the grade data is on hold pending UT approval; the publishing workflow is gated (see `GRADE_DATA_PROVENANCE.md`).

## Features
12. **Campus map paths** follow UTRP's walkway graph and are estimates; buildings missing from that graph show by name only. Turn-by-turn routes open in Google Maps.
13. **Reminders** need Chrome running (MV3 alarms); notifications depend on OS notification permissions.
14. **Wallpaper** text shrinks for very long schedules; extremely dense weeks may need the "minimal" style.
15. **Drag-and-drop** reordering uses native HTML drag events; keyboard users use the ↑/↓ buttons.
16. **Dark mode** applies to Fastlane's pages and the assistant; UTRP's own calendar uses its existing (beta) theme setting.
17. Running UT Registration Plus and Fastlane side by side duplicates injected UI; disable one.

## Policy / legal (needs a human decision)
18. **Autofill and on-screen result reading** are implemented as optional, off-by-default helpers that never submit. Whether UT considers them acceptable has not been confirmed — ask the Registrar before enabling or publishing them.
19. **Naming:** the product is now "Fastlane Course Planner" (no UT marks). A USPTO search for "Fastlane" is still recommended; the GitHub repository still has the old name (see `BRANDING.md`).
20. **Highcharts** was replaced with an in-house SVG chart; no non-commercial-only dependencies remain.
21. Not done here: creating the public GitHub fork, enabling Pages, publishing the privacy policy URL, and submitting to the Chrome Web Store — these need the owner's accounts and decisions.
22. The original handoff document `CODING_AGENT_HANDOFF.md` was not included in the provided ZIP, so its "exact acceptance tests" could not be checked individually; the requirements in the request were implemented and tested instead.
