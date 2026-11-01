# Testing the candidate (PR #35) as a real student

Architecture: **AI interprets → deterministic solver builds → independent validator checks → UI shows.**
Production is untouched; the candidate extension can talk to a protected Vercel *preview* of this branch.

## A. Install / reload
`./update-fastlane.sh --local` on branch `feat/nl-planner-candidate` (set `branch` in the git-ignored
`fastlane.local.json`). Chrome reloads the installed copy in ~30 s; or `chrome://extensions` → reload "Fastlane Course Planner".

## B. Connect the AI to the preview (once)
1. Open `https://longhorn-fastlane-plus-git-feat-nl-fc50bc-simpsladers-projects.vercel.app` in a tab and sign in to Vercel.
   (This sets your own `_vercel_jwt` cookie. Verified: with the host permission granted, a Chromium extension page sends it
   and gets the backend's JSON; without the permission the request is blocked and the app says so.)
2. Fastlane → Settings → **Developer: AI test server** → keep the suggested URL → paste the Preview test access code.
3. **Connect** → approve Chrome's permission prompt for `*.vercel.app`.
4. Expect: *"Connected to … — backend reports: preview build <commit> (feat/nl-planner-candidate)"*. If the commit is not the
   latest pushed commit, the preview is still building: wait a minute and press **Check connection**.
5. Find classes: the chat header must show `TEST SERVER: …` and, after the first answer, `model: …`.
Never falls back to production while a test server is set: any failure says "Production was not contacted".
**Use production** (Settings) switches back.

## C. Student checklist (in the chat, plain language)
1. Import your IDA (Degree progress). Expect your unfinished core areas listed; "none" counted rows must appear as unmet.
2. *"15 hours, only Tuesday and Thursday, 1–2 online, back to back, I need ECO 304L, easy A's for everything else."*
   Expect: a calendar, a table (class, unique, hours, when, counts toward, past A rate, GPA outlook, RMP, seats),
   "What I understood", electives labelled "counts toward total credit hours only", a **Compare the versions** table,
   and buttons Recommended / GPA / Convenience / Degree above the calendar.
3. Click each version button: the calendar changes, no new chat message, each version is valid.
4. *"Make my Tuesdays start later."* → Tuesday classes move after your time; credits, days, ECO 304L, online cap unchanged.
5. *"Find me an easier professor for economics."* → same course, different section/instructor — or an honest "no better section".
6. *"Actually make it 12 hours."* then *"back to 15."* → credits change only when you say so.
7. *"Add a nutrition class."* → NTR course appears or you are told exactly why it can't.
8. *"Make it 24 hours."* → must refuse or show a labelled draft; never "all rules met".
9. **Copy all unique numbers** → paste into a note: one 5-digit unique per line with "seats as last seen <date>".
10. Seats: "not checked"/date only — never claimed live.

## D. If something fails, send me
The exact prompt; a screenshot of the chat + calendar; the chat header text (TEST SERVER / model); Settings → Developer →
**Check connection** text; for slow/odd answers the time it took. No passwords or codes.

## E. Automated checks already run
`pnpm vitest run` (engine benchmark 61 cases/99 turns with a preservation check on every follow-up; validator oracle over
2,000 random schedules); `pnpm e2e` (student journey, dev-server routing + 401 handling); live-model benchmark
(`nlLive.test.ts`, needs a test code; stops cleanly and reports untested turns when the provider limit is hit).
