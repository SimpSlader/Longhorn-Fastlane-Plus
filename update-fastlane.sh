#!/bin/bash
set -Eeuo pipefail
trap 'printf "\nFastlane update stopped at line %s. Review the error above; do not reload Chrome until a successful update.\n" "$LINENO" >&2' ERR
fail() { printf 'Fastlane update stopped: %s\n' "$*" >&2; exit 1; }
# Machine-specific values (paths, Chrome profile, extension ID) live in the git-ignored fastlane.local.json.
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
config() { python3 "$SCRIPT_DIR/scripts/local/local_config.py" "$1"; }
REPO="$(config repo)" || fail 'Create fastlane.local.json from fastlane.local.example.json first.'
readonly REPO
[[ "$REPO" == "$SCRIPT_DIR" ]] || fail 'fastlane.local.json "repo" does not match this checkout.'
BRANCH="$(config branch)" || fail 'fastlane.local.json is invalid (branch).'
readonly BRANCH
TOOLCHAIN_BIN="$(config toolchainBin)" || fail 'fastlane.local.json is invalid (toolchainBin).'
[[ -d "$TOOLCHAIN_BIN" ]] || fail "Toolchain folder not found: $TOOLCHAIN_BIN"
export PATH="$TOOLCHAIN_BIN:$PATH"
cd "$REPO"
[[ "$(git rev-parse --show-toplevel)" == "$REPO" ]] || fail 'Unexpected repository path.'
[[ "$(git remote get-url origin)" == 'https://github.com/SimpSlader/Longhorn-Fastlane-Plus.git' ]] || fail 'Unexpected origin remote.'
[[ "$(git branch --show-current)" == "$BRANCH" ]] || fail "Switch to $BRANCH first; your current work was preserved."
readonly LOCK="$REPO/.git/fastlane-update.lock"
mkdir "$LOCK" 2>/dev/null || fail "Another updater is running. If it was interrupted, remove the empty lock directory: $LOCK"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
[[ -z "$(git diff --name-only --diff-filter=U)" ]] || fail 'Resolve existing merge conflicts first.'
[[ -z "$(git status --porcelain --untracked-files=no | sed -n '/^[RCADMU?!][RCADMU?!]/p')" ]] || fail 'Resolve pending Git changes first.'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 14) process.exit(1)' || fail 'Node 24.14+ is required.'
[[ "pnpm@$(pnpm --version)" == "$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).packageManager')" ]] || fail 'Pinned pnpm version changed; update the local toolchain first.'
if [[ "${1:-}" != '--local' ]]; then
    [[ $# == 0 ]] || fail 'Usage: update-fastlane.sh [--local]'
    git fetch origin "$BRANCH"
    git merge --ff-only --autostash "origin/$BRANCH"
    [[ -z "$(git diff --name-only --diff-filter=U)" ]] || fail 'Local changes conflicted with the update. Git retained the autostash; resolve conflicts before retrying.'
else
    [[ $# == 1 ]] || fail 'Usage: update-fastlane.sh [--local]'
fi
[[ "pnpm@$(pnpm --version)" == "$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).packageManager')" ]] || fail 'The update changed the pinned pnpm version; update the local toolchain before continuing.'
# A frozen install is quick when unchanged and validates the lockfile every time.
pnpm install --frozen-lockfile
pnpm check-types
pnpm check
pnpm vitest run
# local builds include the self-reload helper (never used for store packages)
VITE_FASTLANE_DEV_AUTORELOAD=true pnpm build
pnpm security:check
pnpm e2e
python3 "$REPO/scripts/local/sync-extension.py"
printf '\nFastlane update succeeded. Fastlane installs it by itself within about 30 seconds (or when you open a UT or Fastlane page).\nIf a UT registration (add/drop) tab is open it waits and shows an "Install now" notification instead.\nAfterwards, refresh open UT tabs when convenient; they show a "Fastlane was updated" notice and are never refreshed for you.\n'
