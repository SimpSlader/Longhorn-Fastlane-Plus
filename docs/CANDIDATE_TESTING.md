# Testing the candidate (PR #35) end to end

Architecture: **AI interprets → deterministic solver builds → independent validator checks → UI shows.** Nothing here
touches production: the candidate extension can be pointed at a protected Vercel *preview* of the same branch.

## 1. Install the candidate extension
From the repo on branch `feat/nl-planner-candidate` (set `branch` in your git-ignored `fastlane.local.json`):

    ./update-fastlane.sh --local

Chrome reloads the installed copy within ~30 s. Local builds include a **Developer: AI test server** card in
Settings; store builds do not (and `package.mjs` refuses to package a manifest that has its permission).

## 2. Point the AI at the preview (instead of production)
1. Open the preview once in a Chrome tab and sign in to Vercel:
   `https://longhorn-fastlane-plus-git-feat-nl-fc50bc-simpsladers-projects.vercel.app`
   (this sets your own `_vercel_jwt` cookie; deployment protection stays on).
2. Fastlane → Settings → Developer: AI test server → keep the suggested URL, paste the preview's test access code
   (the Preview-only `FASTLANE_AI_ACCESS_CODE` for this branch), click **Connect**, approve Chrome's permission
   prompt, then **Check connection**.
3. The chat header now shows `TEST SERVER: …`. **Use production** switches back at any time.
Only this project's own preview hosts are accepted; the test code is stored locally and never synced.

## 3. What to try
Import your IDA → "15 hours Tuesday/Thursday, 1–2 online, back to back, I need ECO 304L, easy A's for the rest" →
"make my Tuesdays start later" → "find me an easier professor for economics" → click GPA / Convenience / Degree →
**Copy all unique numbers** → "make it 24 hours" (must refuse honestly, never claim success).
Electives are used by default to reach the credit total and are labelled "counts toward total credit hours only".

## 4. Automated checks
- `pnpm vitest run` — unit + engine benchmark (59 cases / 88 turns), preservation invariant on every follow-up,
  validator oracle over 2,000 random schedules.
- `pnpm e2e` — browser tests incl. `student-journey` and `dev-server`.
- Live model benchmark (needs a test access code; spends the provider's free quota):
  `NL_LIVE=1 FASTLANE_AI_URL=<preview>/api FASTLANE_PREVIEW_SHARE_URL=<share link> FASTLANE_AI_CODE=<code> \
   NL_LIVE_REPORT=report.json NL_LIVE_PROGRESS=progress.log npx vitest run src/fastlane/__tests__/nlLive.test.ts`
  Stops cleanly (remaining turns reported as *untested*) when the provider's daily limit is reached.
