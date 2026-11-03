#!/usr/bin/env bash
# KV cache: none
# Installs the npm tarballs (D-130) the way a user would, from a throwaway Verdaccio registry on
# 127.0.0.1, and checks the result. Run from the repo root:
#   scripts/npm-check.sh <tarball folder> <assets folder> [--quick]
# The tarball folder is scripts/npm-pack.sh's output; the assets folder holds the rlmh-<os>-<arch>
# binary the tarballs were packed from. It checks that `rlmh` is the compiled binary itself (no Node
# or Bun in between, nothing read from a .env or bunfig.toml), under npm, `bun add -g --trust` and a
# plain `bun add -g`. Without --quick it then runs first-run setup with the bundled uv (no uv on PATH;
# uv downloads Python 3.12, the one network use besides installing Verdaccio) and a fake-provider
# question. Needs node, npm, bun and curl. Everything lands in a temp folder; no key is used.
set -euo pipefail

usage="usage: scripts/npm-check.sh <tarball folder> <assets folder> [--quick]"
tarballs=$(cd "${1:?$usage}" && pwd)
assets=$(cd "${2:?$usage}" && pwd)
quick=${3:-}
root=$(pwd)
version=$(sed -n 's/^export const APP_VERSION = "\(.*\)";$/\1/p' app/src/version.ts)
port=4873
registry="http://127.0.0.1:$port/"
work=$(mktemp -d)
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) win=1 exe=.exe ;; *) win=0 exe="" ;; esac
case "$(node -p 'process.platform + "-" + process.arch')" in
  win32-x64) asset=rlmh-windows-x64.exe ;;
  *) asset=rlmh-$(node -p 'process.platform + "-" + process.arch') ;;
esac
[ -f "$assets/$asset" ] || { printf 'FAIL: no %s in %s\n' "$asset" "$assets" >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
native() { if [ "$win" = 1 ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

say "a local registry"
npm install --silent --no-audit --no-fund --prefix "$work/verdaccio" verdaccio@6.10.5 >/dev/null
cat >"$work/verdaccio.yaml" <<EOF
storage: $(native "$work/storage")
auth:
  htpasswd:
    file: $(native "$work/htpasswd")
uplinks: {}
packages:
  "**":
    access: \$all
    publish: \$authenticated
max_body_size: 300mb
listen: 127.0.0.1:$port
log: { type: stdout, format: pretty, level: warn }
EOF
node "$work/verdaccio/node_modules/verdaccio/bin/verdaccio" --config "$(native "$work/verdaccio.yaml")" >"$work/verdaccio.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 100); do
  curl -fsS -o /dev/null "${registry}-/ping" 2>/dev/null && break
  sleep 0.2
done
token=$(curl -fsS -X PUT -H 'content-type: application/json' -d '{"name":"ci","password":"ci-pass-FAKE"}' \
  "${registry}-/user/org.couchdb.user:ci" | node -e 'process.stdin.on("data", d => process.stdout.write(JSON.parse(d).token))')
printf 'registry=%s\n//127.0.0.1:%s/:_authToken=%s\n' "$registry" "$port" "$token" >"$work/npmrc"
export NPM_CONFIG_USERCONFIG="$work/npmrc" BUN_CONFIG_REGISTRY="$registry" BUN_INSTALL_CACHE_DIR="$work/bun-cache"
# platform packages first, as the release does, so rlmh's optional dependencies resolve
for pass in platform rlmh; do
  for t in "$tarballs"/*.tgz; do
    case "$(basename "$t")" in rlmh-win32-* | rlmh-darwin-* | rlmh-linux-*) kind=platform ;; *) kind=rlmh ;; esac
    [ "$kind" = "$pass" ] || continue
    npm publish --silent "$(native "$t")" >/dev/null
    echo "published $(basename "$t")"
  done
done

# A folder rlmh is run from: a .env and a bunfig.toml preload that would show if Bun ran anything.
mkdir -p "$work/repo"
printf 'RLMH_PROBE=from-dotenv-FAKE\n' >"$work/repo/.env"
printf 'preload = ["./preload.ts"]\n' >"$work/repo/bunfig.toml"
printf 'console.log("PRELOAD RAN");\n' >"$work/repo/preload.ts"
# check_command NAME COMMAND...: runs `COMMAND --version` from that folder and checks the output.
check_command() {
  local name=$1
  shift
  local got
  got=$(cd "$work/repo" && "$@" --version 2>"$work/stderr" | tr -d '\r') || fail "$name: rlmh --version failed: $(cat "$work/stderr")"
  [ "$got" = "rlmh $version" ] || fail "$name: rlmh --version said '$got'"
  ! grep -q 'PRELOAD RAN' "$work/stderr" || fail "$name: a bunfig.toml preload ran"
  echo "$name: $got"
}

say "npm i -g rlm-harness"
npm install --silent --no-audit --no-fund -g --prefix "$work/npm" rlm-harness >/dev/null
if [ "$win" = 1 ]; then
  shim="$work/npm/rlmh.cmd"
  grep -q 'node_modules\\rlm-harness\\bin\\rlmh.exe' "$shim" || fail "npm's shim does not start bin\\rlmh.exe: $(cat "$shim")"
  ! grep -qi 'node' <(grep -v node_modules "$shim") || fail "npm's shim starts node: $(cat "$shim")"
  target="$work/npm/node_modules/rlm-harness/bin/rlmh.exe"
  check_command npm cmd //c "$(native "$shim")"
else
  target=$(cd "$work/npm/bin" && node -p 'require("fs").realpathSync("rlmh")')
  check_command npm "$work/npm/bin/rlmh"
fi
cmp -s "$target" "$assets/$asset" || fail "npm: the command's target is not $asset byte for byte"
[ -e "$(dirname "$target")/uv$exe" ] || fail "npm: no uv beside the binary"
npm_bin=$target

say "bun add -g --trust rlm-harness"
BUN_INSTALL="$work/bun" bun add -g --trust rlm-harness >/dev/null 2>&1 || fail "bun add -g --trust rlm-harness failed"
check_command "bun --trust" "$work/bun/bin/rlmh$exe"
cmp -s "$work/bun/install/global/node_modules/rlm-harness/bin/rlmh.exe" "$assets/$asset" ||
  fail "bun --trust: bin/rlmh.exe is not $asset byte for byte"

say "bun add -g rlm-harness (install step blocked)"
BUN_INSTALL="$work/bun-plain" bun add -g rlm-harness >/dev/null 2>&1 || fail "bun add -g rlm-harness failed"
if [ "$win" = 1 ]; then
  # Windows cannot run the placeholder: documented, and --trust is the fix
  ! "$work/bun-plain/bin/rlmh.exe" --version >/dev/null 2>&1 || fail "bun without --trust unexpectedly ran on Windows"
  echo "bun plain: fails as documented"
else
  check_command "bun plain (sh fallback)" "$work/bun-plain/bin/rlmh"
  grep -q 'bun pm -g trust rlm-harness' "$work/stderr" || fail "the fallback did not print its hint"
fi

[ "$quick" = --quick ] && {
  say "npm checks passed (quick)"
  exit 0
}

say "first run with the bundled uv"
! command -v uv >/dev/null || fail "uv is on PATH ($(command -v uv)); this check proves the bundled uv is used"
export RLMH_HOME="$work/home"
"$npm_bin" setup --yes </dev/null
[ ! -e "$RLMH_HOME/bin/uv$exe" ] || fail "setup used <home>/bin/uv"
ls -d "$RLMH_HOME"/python/cpython-3.12.* >/dev/null || fail "no $RLMH_HOME/python/cpython-3.12.*"
"$npm_bin" info </dev/null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const j = JSON.parse(s);
    if (j.engine.protocol !== 2 || j.engine.version !== process.argv[1] || !/^3\.12\./.test(j.engine.python)) { console.error(s); process.exit(1); }
    console.log("info ok");
  });' "$version"

say "a question on the fake provider"
printf 'one line of input\n' >"$work/input.txt"
cat >"$work/script.json" <<'EOF'
{"root":[{"text":"","tool_call":{"code":"submit(llm('Summarize x'))"}}],"sub":[{"match":"^Summarize","text":"a summary"}]}
EOF
(cd "$work" && RLMH_FAKE_SCRIPT="$(native "$work/script.json")" "$npm_bin" run --question q --input input.txt --root fake/scripted --sub fake/scripted --json </dev/null) >"$work/run.jsonl"
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const ok = lines.some(e => e.type === "run.finished" && e.answer === "a summary" && e.submitted === true && e.subcalls === 1 && e.infra_error === null);
  if (!ok) { console.error(lines); process.exit(1); }
  console.log("fake-provider run ok");' "$(native "$work/run.jsonl")"

say "npm checks passed"
cd "$root"
