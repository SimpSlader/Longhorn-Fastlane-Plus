# Release, versioning and upstream maintenance

## Branches and remotes
- `fastlane-plus` — main development branch of this fork.
- `upstream` remote → `https://github.com/Longhorn-Developers/UT-Registration-Plus` (`main`).
- `package.json → upstream` records the reviewed UTRP and Degree Audit Plus commits.

## Versioning
Semantic versioning on `package.json` `version` (the manifest version is derived from it). Bump:
- **patch** — fixes, dataset refreshes, upstream syncs without behavior changes
- **minor** — new features
- **major** — storage format changes requiring migration

## Release steps
1. `pnpm install && pnpm vitest run && pnpm exec playwright test`
2. Bump `version` in `package.json`, update release notes.
3. `git tag vX.Y.Z && git push --tags` → **Prepare Chrome Web Store release** workflow builds, tests, packages and creates a **draft** GitHub release with `fastlane-course-planner-X.Y.Z.zip` and `RELEASE.json` (SHA-256).
4. Walk through `docs/STORE_REVIEW_CHECKLIST.md`.
5. Upload the ZIP in the Chrome Web Store Developer Dashboard (or run the workflow manually with *upload_to_store*; it uploads a draft and never publishes).
6. Submit for review. Students receive the update through Chrome's normal extension updates after approval.

Executable code reaches students **only** through reviewed store releases. Nothing downloaded at runtime is executed.

## Upstream workflow (`.github/workflows/fastlane-upstream-sync.yml`)
Weekly (and on demand):
1. Fetches UTRP `main`; if there are new commits, creates `upstream-sync/<sha>` and merges.
2. The PR body lists upstream commits, files that both upstream and Fastlane modified (review carefully), and grade-database changes.
3. The bundled dataset manifest is regenerated so the grade data hash/date stay accurate.
4. The PR runs **Fastlane CI**: type check, unit tests (including `integration.test.ts`, which fails if a Fastlane hook in an upstream file was lost), build, MV3 security check, Chromium e2e tests, and a packaged ZIP artifact.
5. If the merge conflicts, an issue lists the conflicting files and the commands to resolve locally.
6. Separately, Degree Audit Plus is compared with the reviewed commit; parser-relevant changes open an issue.

Nothing is merged or deployed automatically. A maintainer reviews, merges, then follows the release steps.

### Resolving a sync manually
```bash
git fetch upstream && git checkout -b upstream-sync/manual && git merge upstream/main
```
Keep the `Fastlane:` hooks noted in `src/fastlane/__tests__/integration.test.ts`, then run the full test suite.

## Dataset workflow (`.github/workflows/fastlane-datasets.yml`)
Publishes **data only** to GitHub Pages (`data/manifest.json` + versioned SQLite) when the grade database changes. To let installed extensions use it, build with `VITE_FASTLANE_DATA_MANIFEST_URL=https://<owner>.github.io/<repo>/data/manifest.json`. Extensions check at most once a day, verify host, schema, freshness and SHA-256, and keep the previous data on any failure. Confirm redistribution rights first (`docs/DATA_SOURCES.md`).
