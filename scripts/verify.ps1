# The rlm-harness verify gate. Offline and deterministic; the last line is the verdict:
#   VERIFY: PASS                 (exit 0)
#   VERIFY: FAIL (<stages>)      (exit 1)
# Usage: scripts\verify.ps1 [TEST_PATH]
#   TEST_PATH (optional) scopes the test stages: engine/... runs only that pytest path,
#   app/... runs only that bun test path. Only a full run with no TEST_PATH ends a task.
# Stages: secrets, engine-tests, app-typecheck, app-tests, workflows, dsh-plugin. The engine and app stages report
# SKIP until engine/ or app/ exists (step 2 of the v0 build). Windows PowerShell 5.1 compatible.
param([string]$Scope = "")

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Scope = $Scope -replace '\\', '/'
$Failed = New-Object System.Collections.Generic.List[string]

function Stage([string]$name) { Write-Output ""; Write-Output "== $name ==" }
function Fail([string]$name, [string]$why) { Write-Output "FAIL: $why"; if (-not $Failed.Contains($name)) { $Failed.Add($name) } }

# Bun: PATH first, then the in-repo install (.bun/, git-excluded) on Rishi's PC.
$Bun = $null
$cmd = Get-Command bun -ErrorAction SilentlyContinue
if ($cmd) { $Bun = $cmd.Source } elseif (Test-Path "$Root\.bun\bin\bun.exe") { $Bun = "$Root\.bun\bin\bun.exe" }

# 1. secrets: this repo is public. No key-shaped strings and no key, run-log or .env files
#    in anything tracked or about to be (untracked and not ignored). Fake keys in tests must
#    contain FAKE (e.g. sk-ant-FAKE...), which this stage ignores. Hits print as path:line
#    only, never the matching text, and a git failure fails the stage instead of passing it.
Stage "secrets"
$KeyRe = '(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})|-----BEGIN [A-Z ]*PRIVATE KEY-----'
$scanOk = $true
$grepOut = @(git grep --untracked -nIE -e $KeyRe -- . ':!scripts/verify.sh' ':!scripts/verify.ps1')
if ($LASTEXITCODE -gt 1) { $scanOk = $false; Fail "secrets" "git grep failed (exit $LASTEXITCODE)" }
$hits = @($grepOut | Where-Object { $_ -and $_ -notmatch 'FAKE' } | ForEach-Object { ($_ -split ':', 3)[0..1] -join ':' })
$listed = @(git ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { $scanOk = $false; Fail "secrets" "git ls-files failed (exit $LASTEXITCODE)" }
$files = @($listed | Where-Object {
    $_ -match '(^|/)(\.env[^/]*|keys\.json|key-index\.json|runs\.jsonl)$' -and $_ -notmatch '(^|/)\.env\.example$' })
if ($hits.Count -gt 0) { $hits | ForEach-Object { "  $_" }; Fail "secrets" "key-shaped strings found (fake keys must contain FAKE)" }
if ($files.Count -gt 0) { $files | ForEach-Object { "  $_" }; Fail "secrets" "files that must never be committed" }
if ($scanOk -and $hits.Count -eq 0 -and $files.Count -eq 0) { Write-Output "ok" }

# 2. engine-tests
Stage "engine-tests"
if ($Scope -and -not $Scope.StartsWith("engine/")) {
    Write-Output "SKIP (scoped to $Scope)"
} elseif (-not (Test-Path "engine/pyproject.toml")) {
    Write-Output "SKIP (engine/ not built yet)"
} elseif (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "engine-tests" "uv not on PATH"
} else {
    $target = "engine/tests"
    if ($Scope) { $target = $Scope }
    uv run --locked --project engine pytest $target -q
    $rc = $LASTEXITCODE
    if ($rc -eq 5) { Write-Output "pytest collected no tests" }
    if ($rc -ne 0) { Fail "engine-tests" "pytest exit $rc" }
}

# 3, 4. app-typecheck and app-tests (run from app/)
$appSkip = $null
if ($Scope -and -not $Scope.StartsWith("app/")) { $appSkip = "scoped to $Scope" }
elseif (-not (Test-Path "app/package.json")) { $appSkip = "app/ not built yet" }

if ($appSkip) {
    Stage "app-typecheck"; Write-Output "SKIP ($appSkip)"
    Stage "app-tests"; Write-Output "SKIP ($appSkip)"
} elseif (-not $Bun) {
    Stage "app-typecheck"; Fail "app-typecheck" "bun not found on PATH or in .bun\bin"
    Stage "app-tests"; Fail "app-tests" "bun not found on PATH or in .bun\bin"
} elseif (-not (Test-Path "app/node_modules")) {
    Stage "app-typecheck"; Fail "app-typecheck" "app/node_modules missing: run bun install --frozen-lockfile in app/"
    Stage "app-tests"; Fail "app-tests" "app/node_modules missing"
} else {
    Push-Location app
    try {
        Stage "app-typecheck"
        & $Bun run typecheck
        if ($LASTEXITCODE -ne 0) { Fail "app-typecheck" "bun run typecheck failed" }
        Stage "app-tests"
        if ($Scope) {
            $rel = $Scope.Substring(4)
            & $Bun test $rel
            if ($LASTEXITCODE -ne 0) { Fail "app-tests" "bun test $rel failed" }
        } else {
            & $Bun test
            if ($LASTEXITCODE -ne 0) { Fail "app-tests" "bun test failed" }
        }
    } finally {
        Pop-Location
    }
}

# 5. workflows: zizmor (pinned in engine's dev group) audits .github/ offline; any finding fails
Stage "workflows"
if ($Scope) {
    Write-Output "SKIP (scoped to $Scope)"
} elseif (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "workflows" "uv not on PATH"
} else {
    uv run --locked --project engine zizmor --offline --no-progress .github/
    if ($LASTEXITCODE -ne 0) { Fail "workflows" "zizmor reported findings" }
}

# 6. dsh-plugin (branch dsh-plugin, D-264): the RLM mode bundle's offline tests. npm ci --offline installs its dev
#    dependencies from npm's cache (run `npm ci` in dsh-plugin/ once online to fill it); the Python tests run on the
#    engine project's Python. A scope of dsh-plugin/... runs only this stage.
Stage "dsh-plugin"
if ($Scope -and -not $Scope.StartsWith("dsh-plugin/")) {
    Write-Output "SKIP (scoped to $Scope)"
} elseif (-not (Test-Path "dsh-plugin/package.json")) {
    Write-Output "SKIP (dsh-plugin/ not on this branch)"
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "dsh-plugin" "node or npm not on PATH"
} elseif (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "dsh-plugin" "uv not on PATH"
} else {
    Push-Location dsh-plugin
    try {
        npm ci --offline --no-audit --no-fund --ignore-scripts --loglevel=error
        if ($LASTEXITCODE -ne 0) {
            Fail "dsh-plugin" "npm ci --offline failed (run npm ci in dsh-plugin/ once online)"
        } else {
            node --test "test/*.test.mjs"
            if ($LASTEXITCODE -ne 0) { Fail "dsh-plugin" "node tests failed" }
        }
    } finally {
        Pop-Location
    }
    uv run --locked --project engine python -m unittest discover -s dsh-plugin/test -p "test_*.py"
    if ($LASTEXITCODE -ne 0) { Fail "dsh-plugin" "python tests failed" }
}

Write-Output ""
if ($Scope) { Write-Output "(scoped run: $Scope; a full run is still needed before calling work done)" }
if ($Failed.Count -eq 0) {
    Write-Output "VERIFY: PASS"
    exit 0
}
Write-Output ("VERIFY: FAIL (" + ($Failed -join ", ") + ")")
exit 1
