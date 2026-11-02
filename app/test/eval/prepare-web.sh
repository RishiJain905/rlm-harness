#!/usr/bin/env bash
# KV cache: none
# Fills a pnpm store and a Playwright browser folder for the web fixture (v1 step 2, task 11), so the
# web grading tests can run offline afterwards. CI's Linux leg runs it; on a PC, run it from Git Bash.
#   RLMH_TEST_PNPM_STORE=<dir> PLAYWRIGHT_BROWSERS_PATH=<dir> bash app/test/eval/prepare-web.sh
# It needs node 22 or later and pnpm 10.34.7 on PATH. It touches the npm registry and Playwright's download
# host, and on Linux `--with-deps` installs Chromium's system packages (it asks sudo for that).
set -euo pipefail

: "${RLMH_TEST_PNPM_STORE:?set RLMH_TEST_PNPM_STORE to the pnpm store folder to fill}"
: "${PLAYWRIGHT_BROWSERS_PATH:?set PLAYWRIGHT_BROWSERS_PATH to the browser folder to fill}"
export PLAYWRIGHT_BROWSERS_PATH

here="$(cd "$(dirname "$0")" && pwd)"
web="$here/../fixtures/evalset/src/fx-web-S-01"
playwright="$(sed -n 's/.*"playwright": *"\([^"]*\)".*/\1/p' "$here/../fixtures/evalset/nodeenvs/fx-web.json")"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$RLMH_TEST_PNPM_STORE" "$PLAYWRIGHT_BROWSERS_PATH"
cp "$web/package.json" "$web/pnpm-lock.yaml" "$scratch/"
cd "$scratch"
pnpm fetch --store-dir "$RLMH_TEST_PNPM_STORE"
pnpm install --offline --frozen-lockfile --store-dir "$RLMH_TEST_PNPM_STORE"
if [ "$(uname -s)" = Linux ]; then
  pnpm exec playwright install --with-deps chromium
else
  pnpm exec playwright install chromium
fi

# the markers rlmh eval writes after the same two steps, so ensureNodeEnv and ensureBrowser skip them
lock="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
mkdir -p "$RLMH_TEST_PNPM_STORE/.rlmh-fetched"
: > "$RLMH_TEST_PNPM_STORE/.rlmh-fetched/$lock"
: > "$PLAYWRIGHT_BROWSERS_PATH/.rlmh-$playwright"
echo "prepare-web: store $RLMH_TEST_PNPM_STORE and browsers $PLAYWRIGHT_BROWSERS_PATH are ready (Playwright $playwright)"
