#!/usr/bin/env bash
# The rlm-harness verify gate. Offline and deterministic; the last line is the verdict:
#   VERIFY: PASS                 (exit 0)
#   VERIFY: FAIL (<stages>)      (exit 1)
# Usage: scripts/verify.sh [TEST_PATH]
#   TEST_PATH (optional) scopes the test stages: engine/... runs only that pytest path,
#   app/... runs only that bun test path. Only a full run with no TEST_PATH ends a task.
# Stages: secrets, engine-tests, app-typecheck, app-tests. The engine and app stages report
# SKIP until engine/ or app/ exists (step 2 of the v0 build).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
SCOPE="${1:-}"
SCOPE="${SCOPE//\\//}"
FAILED=()

stage() { printf '\n== %s ==\n' "$1"; }
fail() { echo "FAIL: $2"; FAILED+=("$1"); }

# Bun: PATH first, then the in-repo install (.bun/, git-excluded) on Rishi's PC.
BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$ROOT/.bun/bin/bun.exe" ] && BUN="$ROOT/.bun/bin/bun.exe"
[ -z "$BUN" ] && [ -x "$ROOT/.bun/bin/bun" ] && BUN="$ROOT/.bun/bin/bun"

# 1. secrets: this repo is public. No key-shaped strings and no key, run-log or .env files
#    in anything tracked or about to be (untracked and not ignored). Fake keys in tests must
#    contain FAKE (e.g. sk-ant-FAKE...), which this stage ignores.
stage secrets
KEY_RE='(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})|-----BEGIN [A-Z ]*PRIVATE KEY-----'
hits="$(git grep --untracked -nIE -e "$KEY_RE" -- . ':!scripts/verify.sh' ':!scripts/verify.ps1' | grep -v 'FAKE' || true)"
files="$(git ls-files --cached --others --exclude-standard | grep -E '(^|/)(\.env(\.[^/]*)?|keys\.json|key-index\.json|runs\.jsonl)$' | grep -vE '(^|/)\.env\.example$' || true)"
if [ -n "$hits" ]; then echo "$hits" | sed 's/^/  /'; fail secrets "key-shaped strings found (fake keys must contain FAKE)"; fi
if [ -n "$files" ]; then echo "$files" | sed 's/^/  /'; fail secrets "files that must never be committed"; fi
[ -z "$hits" ] && [ -z "$files" ] && echo "ok"

# 2. engine-tests
stage engine-tests
if [ -n "$SCOPE" ] && [[ "$SCOPE" != engine/* ]]; then
  echo "SKIP (scoped to $SCOPE)"
elif [ ! -f engine/pyproject.toml ]; then
  echo "SKIP (engine/ not built yet)"
elif ! command -v uv >/dev/null 2>&1; then
  fail engine-tests "uv not on PATH"
else
  uv run --locked --project engine pytest "${SCOPE:-engine/tests}" -q
  rc=$?
  [ $rc -eq 5 ] && echo "pytest collected no tests"
  [ $rc -ne 0 ] && fail engine-tests "pytest exit $rc"
fi

# 3, 4. app-typecheck and app-tests (run from app/)
if [ -n "$SCOPE" ] && [[ "$SCOPE" != app/* ]]; then
  stage app-typecheck; echo "SKIP (scoped to $SCOPE)"
  stage app-tests; echo "SKIP (scoped to $SCOPE)"
elif [ ! -f app/package.json ]; then
  stage app-typecheck; echo "SKIP (app/ not built yet)"
  stage app-tests; echo "SKIP (app/ not built yet)"
elif [ -z "$BUN" ]; then
  stage app-typecheck; fail app-typecheck "bun not found on PATH or in .bun/bin"
  stage app-tests; fail app-tests "bun not found on PATH or in .bun/bin"
elif [ ! -d app/node_modules ]; then
  stage app-typecheck; fail app-typecheck "app/node_modules missing: run bun install --frozen-lockfile in app/"
  stage app-tests; fail app-tests "app/node_modules missing"
else
  stage app-typecheck
  (cd app && "$BUN" run typecheck) || fail app-typecheck "bun run typecheck failed"
  stage app-tests
  if [ -n "$SCOPE" ]; then
    (cd app && "$BUN" test "${SCOPE#app/}") || fail app-tests "bun test ${SCOPE#app/} failed"
  else
    (cd app && "$BUN" test) || fail app-tests "bun test failed"
  fi
fi

echo
[ -n "$SCOPE" ] && echo "(scoped run: $SCOPE; a full run is still needed before calling work done)"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "VERIFY: PASS"
  exit 0
fi
stages="$(printf '%s\n' "${FAILED[@]}" | awk '!seen[$0]++' | paste -sd, - | sed 's/,/, /g')"
echo "VERIFY: FAIL ($stages)"
exit 1
