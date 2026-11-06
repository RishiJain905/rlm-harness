#!/usr/bin/env bash
# KV cache: none
# The CI install job's checks (step 10 spec, "Done when" 2), in order, for one OS. Run from the repo
# root: scripts/install-check.sh <served folder>. The folder holds rlmh-<os>-<arch>[.exe],
# install.sh, install.ps1 and SHA256SUMS. It is served on 127.0.0.1:8099 for the length of this
# script only. Uses the default home ($HOME/.rlm-harness), so run it on a throwaway machine, or with
# HOME pointed at a scratch folder. UV_PRESENT=1 marks the leg where uv is already on PATH.
# This is the only test that touches the network on purpose: uv downloads Python 3.12. No key is used.
# shellcheck disable=SC2016  # the PowerShell snippets are single-quoted on purpose
set -euo pipefail

served=$(cd "${1:?usage: scripts/install-check.sh <served folder>}" && pwd)
uv_present=${UV_PRESENT:-0}
version=$(sed -n 's/^export const APP_VERSION = "\(.*\)";$/\1/p' app/src/version.ts)
port=8099
base="http://127.0.0.1:$port"
H="$HOME/.rlm-harness"
work=$(mktemp -d)
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) win=1 exe=.exe py=python ;; *) win=0 exe="" py=python3 ;; esac
bin="$H/bin/rlmh$exe"

say() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
ps() { powershell -NoProfile -NonInteractive -Command "$1"; }

(cd "$served" && exec "$py" -m http.server "$port" --bind 127.0.0.1) >"$work/server.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$base/SHA256SUMS" 2>/dev/null && break
  sleep 0.2
done

if [ "$win" = 1 ]; then
  homew=$(cygpath -w "$H")
  # a %VAR% entry the installer must leave unexpanded, and the Python registry keys before setup
  ps '$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
      $p = $k.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $k.SetValue("Path", ($p.TrimEnd(";") + ";%USERPROFILE%\rlmh-ci-marker").TrimStart(";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)'
  pykeys() { ps '(Get-ChildItem HKCU:\Software\Python -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count' | tr -d '\r'; }
  keys_before=$(pykeys)
fi

say "1. install"
if [ "$uv_present" = 1 ]; then command -v uv >/dev/null || fail "this leg needs uv on PATH"; else ! command -v uv >/dev/null || fail "uv is on PATH: $(command -v uv)"; fi
install() {
  if [ "$win" = 1 ]; then
    ps "\$env:RLMH_DOWNLOAD_BASE='$base'; irm $base/install.ps1 | iex"
  else
    curl -fsSL "$base/install.sh" | RLMH_DOWNLOAD_BASE="$base" sh
  fi
}
install
[ "$("$bin" --version | tr -d '\r')" = "rlmh $version" ] || fail "$bin --version is not rlmh $version"
if [ "$uv_present" = 1 ]; then [ ! -e "$H/bin/uv$exe" ] || fail "uv was installed although it was on PATH"; else [ -e "$H/bin/uv$exe" ] || fail "no $H/bin/uv$exe"; fi

say "2. PATH"
if [ "$win" = 1 ]; then
  raw=$(ps '[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment").GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)' | tr -d '\r')
  echo "HKCU Path: $raw"
  case "$raw" in *"$homew\\bin") ;; *) fail "the user Path does not end with $homew\\bin" ;; esac
  case "$raw" in *'%USERPROFILE%\rlmh-ci-marker'*) ;; *) fail "a %VAR% entry in the user Path was expanded or lost" ;; esac
else
  case "${SHELL:-}" in
    */zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    *) rc="$HOME/.profile" ;;
  esac
  marks() { grep -c '^# rlm-harness$' "$rc" || true; }
  [ "$(marks)" = 1 ] || fail "$rc has $(marks) '# rlm-harness' lines"
  case "$rc" in *.bash_profile | *.profile) flags=-lic ;; *) flags=-ic ;; esac
  found=$("${SHELL:-/bin/sh}" "$flags" 'command -v rlmh' 2>/dev/null | tail -n 1)
  [ "$found" = "$bin" ] || fail "a new $SHELL finds '$found', not $bin"
fi

say "3. before setup, no terminal"
printf 'one line of input\n' >"$work/input.txt"
start=$SECONDS
set +e
"$bin" run --question q --input "$work/input.txt" --root fake/scripted </dev/null >"$work/before.txt" 2>&1
code=$?
set -e
cat "$work/before.txt"
[ "$code" != 0 ] || fail "rlmh run before setup exited 0"
[ $((SECONDS - start)) -lt 20 ] || fail "rlmh run before setup took $((SECONDS - start)) s"
grep -q 'rlmh setup --yes' "$work/before.txt" || fail "the message does not name rlmh setup --yes"

say "4. setup"
"$bin" setup --yes </dev/null
ls -d "$H"/python/cpython-3.12.* >/dev/null || fail "no $H/python/cpython-3.12.*"
marker="$H/engine/$version/.installed.json"
[ -f "$marker" ] || fail "no $marker"
for f in "$HOME"/.local/bin/python3.12*; do [ ! -e "$f" ] || fail "setup wrote $f"; done
if [ "$win" = 1 ]; then [ "$(pykeys)" = "$keys_before" ] || fail "setup added keys under HKCU:\\Software\\Python"; fi

say "5. info"
"$bin" info </dev/null >"$work/info.json"
jq -e --arg v "$version" '.engine.protocol == 2 and .engine.version == $v and (.engine.python | test("^3\\.12\\."))' "$work/info.json" >/dev/null ||
  fail "info: $(cat "$work/info.json")"
python=$(jq -r .python "$marker")
pydir="$H/python"
if [ "$win" = 1 ]; then pydir=$(cygpath -w "$pydir"); fi
case "$(printf '%s' "$python" | tr '[:upper:]' '[:lower:]')" in "$(printf '%s' "$pydir" | tr '[:upper:]' '[:lower:]')"*) ;; *) fail "the marker's python $python is not under $pydir" ;; esac

say "6. a question on the fake provider"
cat >"$work/script.json" <<'EOF'
{"root":[{"text":"","tool_call":{"code":"submit(llm('Summarize x'))"}}],"sub":[{"match":"^Summarize","text":"a summary"}]}
EOF
(cd "$work" && RLMH_FAKE_SCRIPT="$work/script.json" "$bin" run --question q --input input.txt --root fake/scripted --sub fake/scripted --json </dev/null) >"$work/run.jsonl"
[ "$(jq -es 'any(.[]; .type=="run.finished" and .answer=="a summary" and .submitted==true and .subcalls==1 and .infra_error==null)' "$work/run.jsonl")" = true ] ||
  fail "the fake-provider run: $(cat "$work/run.jsonl")"

say "7. run the installer again"
install
if [ "$win" = 0 ]; then [ "$(marks)" = 1 ] || fail "$rc has $(marks) '# rlm-harness' lines after a second install"; fi
"$bin" setup --yes </dev/null | tee "$work/again.txt"
grep -q 'already installed' "$work/again.txt" || fail "a second setup did not say already installed"

say "8. a wrong SHA256SUMS"
asset=$(cd "$served" && ls rlmh-*)
# sha256sum in Git Bash writes "<hex> *<name>" (binary mode), so match the name without its *
awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n) } n == a { d = substr($1, 1, 1); $1 = (d == "0" ? "1" : "0") substr($1, 2) } { print $1 "  " $2 }' "$served/SHA256SUMS" >"$work/sums"
cmp -s "$work/sums" "$served/SHA256SUMS" && fail "could not corrupt the $asset line of SHA256SUMS"
cp "$work/sums" "$served/SHA256SUMS"
home2="$work/home2"
set +e
if [ "$win" = 1 ]; then
  RLMH_HOME=$(cygpath -w "$home2") RLMH_DOWNLOAD_BASE="$base" RLMH_NO_MODIFY_PATH=1 powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
else
  RLMH_HOME="$home2" RLMH_DOWNLOAD_BASE="$base" RLMH_NO_MODIFY_PATH=1 sh install.sh
fi
code=$?
set -e
[ "$code" != 0 ] || fail "the installer exited 0 on a wrong checksum"
[ ! -e "$home2/bin/rlmh$exe" ] || fail "the installer left $home2/bin/rlmh$exe"

if [ "$win" = 1 ]; then
  say "9. uninstall (the documented commands)"
  ps '$h = if ($env:RLMH_HOME) { $env:RLMH_HOME } else { "$env:USERPROFILE\.rlm-harness" }
      $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
      $p = $k.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $k.SetValue("Path", (($p -split ";" | Where-Object { $_ -and $_.TrimEnd("\") -ne "$h\bin" }) -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      Remove-Item -Recurse -Force $h
      if (Test-Path "$env:USERPROFILE\.rlm-harness") { throw "the home is still there" }
      if ($k.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -like "*.rlm-harness*") { throw "the user Path still names .rlm-harness" }'
fi

say "install checks passed"
