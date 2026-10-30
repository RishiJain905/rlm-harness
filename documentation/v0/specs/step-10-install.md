# Step 10. One-command install on three OSes

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 9 (the install runs what steps 2 to 6 built; 9 is the order in progress.md) |
| **Unblocks** | none: this ends v0 |
| **Parallel with** | none |
| **Decisions it uses** | 2b: `~/.rlm-harness/` · 4a: Git Bash if found, else PowerShell; the installer does not check for it · 10a: uv fetches Python 3.12 on first run, after asking. S-04, S-15, S-16, S-20; D-01, D-18, D-19, D-20, D-29, D-42, D-44 |

## Goal

A `v*` tag builds four `rlmh` binaries and publishes them with a `SHA256SUMS` file. One command per OS installs one into `<home>/bin/`. On first run `rlmh` asks, fetches Python 3.12 through uv into `<home>/python/`, and copies the engine out of its own binary into `<home>/engine/<APP_VERSION>/`. After that a question runs with no checkout and no Docker. Until this is done, v0 works only for someone with the repo and uv on their machine.

## Read first

- `../architecture.md §7.1` (`findEngine`, D-18 order), `§9` (home layout), `§10` (commands), `§7.5` (fake provider), `§12` (Bun on the PC; CI uses `setup-bun` 1.4.4).
- `../decisions.md`: S-04, S-16, D-01, D-18, D-19, D-20, D-29 and the open 2b, 4a, 10a.
- `../../legacy/v0-build-plan.md § Step 10` and `../../legacy/architecture.md § Platforms and install`.
- Check, do not guess: `bun build --help` (1.4.4: `--compile`, `--reject-unresolved`, `--no-compile-autoload-dotenv`, `--no-compile-autoload-bunfig`, `--windows-*`); uv's "Environment variables" page (`UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_BIN_DIR`, `UV_PYTHON_INSTALL_BIN`, `UV_PYTHON_INSTALL_REGISTRY`, `UV_MANAGED_PYTHON`, `UV_PYTHON_INSTALL_MIRROR`); GitHub's `releases/latest/download/<asset>` URL form. No training files.

## Starting state

- Steps 2 to 9 are done. `ci.yml` (step 2) builds a binary per OS and uploads it. `findEngine` handles items 1 and 2 and throws `EngineNotFound` after them. `rlmh run --json` works on `fake/scripted` (steps 5, 6).
- `version.ts` holds `APP_VERSION`, and `engine/rlm_engine/__init__.py` has the same `__version__`.
- `.gitignore` already ignores `dist/` and `build/` (any depth). Bun 1.4.4 is in `.bun/` on the PC.
- uv is on Rishi's PC. A clean CI runner has neither uv nor the engine's Python.

## Deliverables

### Where things go (`<home>` is `RLMH_HOME`, else `~/.rlm-harness`)

| What | Path | Made by |
|---|---|---|
| `rlmh` | `<home>/bin/rlmh[.exe]` | install script |
| uv, only if not on PATH | `<home>/bin/uv[.exe]` | install script |
| Python 3.12 | `<home>/python/cpython-3.12.<n>-<os>-<arch>-<libc>/` (uv's own layout) | `rlmh setup` |
| the engine | `<home>/engine/<APP_VERSION>/rlm_engine/…` and `.installed.json` | `rlmh setup` |
| PATH entry | one line in a shell rc file (Unix), or `HKCU\Environment\Path` (Windows) | install script |

Deleting `<home>` plus the PATH entry removes everything. One exception: saved keys live in the OS credential store (§9), not in `<home>`. Uninstall says so.

### `.github/workflows/release.yml`

- Triggers: push of a `v*` tag, and `workflow_dispatch`, which builds and uploads artifacts but skips `publish`.
- `build`, a matrix of native runners (no cross-compiling, so each binary runs its own `--version`):

| runner | os-arch | output |
|---|---|---|
| `ubuntu-latest` | linux-x64 | `dist/rlmh-linux-x64` |
| `windows-latest` | windows-x64 | `dist/rlmh-windows-x64.exe` |
| `macos-14` | darwin-arm64 | `dist/rlmh-darwin-arm64` |
| `macos-15-intel` | darwin-x64 | `dist/rlmh-darwin-x64` |

  Steps: checkout; `oven-sh/setup-bun` 1.4.4; `bun install --frozen-lockfile` in `app/`; `bun run scripts/embed-engine.ts`; then, from `app/`:
  `bun build --compile --reject-unresolved --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile ../dist/<output> src/main.ts`.
  On Windows add `--windows-title rlmh --windows-publisher rlm-harness --windows-version <APP_VERSION>.0 --windows-description "RLM harness"`. On macOS run `codesign --force --sign - dist/<output>` (ad hoc; Apple Silicon kills unsigned binaries). On a tag run, `dist/<output> --version` must equal `rlmh <tag without v>`. Upload as artifact `rlmh-<os>-<arch>`.
- `publish`: `needs: build`, runs only on a tag, `permissions: contents: write, actions: read`.
  1. Gate: `gh run list --workflow ci.yml --commit "$GITHUB_SHA" --status success --json databaseId --jq length` must be at least 1, else fail ("CI has not passed on this commit").
  2. Download all artifacts into `dist/` (`merge-multiple: true`), copy `install.sh` and `install.ps1` in.
  3. `cd dist && sha256sum rlmh-* install.sh install.ps1 > SHA256SUMS`.
  4. `gh release create "$GITHUB_REF_NAME" dist/* --verify-tag --title "$GITHUB_REF_NAME" --notes-file <notes>`, with `--prerelease` when the tag contains `-` (so `latest` never moves to an rc). The notes carry the two one-liners and this line: the checksums catch a corrupted download, not a compromised release.
- **Never push a branch, a tag or a release without Rishi's say-so.** Prepare the workflow, then ask.

### `.github/workflows/ci.yml` (+ `install` job; the build step gains `bun run scripts/embed-engine.ts` and `--reject-unresolved`; step 2 already passes the D-44 flags)

`install`, `needs:` step 2's build job, matrix `ubuntu-latest`, `windows-latest`, `macos-14`, plus one extra `ubuntu-latest` leg that runs `astral-sh/setup-uv` first. The job downloads that build's artifact into `served/` and writes `served/SHA256SUMS` itself. The default home is used, since the VM is throwaway. This is the only CI job that touches the network on purpose (uv and Python come from GitHub). It uses no key.
Per OS, in one bash step, so the local server dies with the step (Windows: the install call alone is `shell: powershell`, which is 5.1 on the runner, not `pwsh`):
1. Assert uv is absent (`! command -v uv`) in the normal legs.
2. Serve `served/` with `python -m http.server 8099 --bind 127.0.0.1`.
3. Install with the real one-liner, aimed at the local server: `curl -fsSL http://127.0.0.1:8099/install.sh | RLMH_DOWNLOAD_BASE=http://127.0.0.1:8099 sh`; Windows: `$env:RLMH_DOWNLOAD_BASE='http://127.0.0.1:8099'; irm http://127.0.0.1:8099/install.ps1 | iex`.
4. Assert the exact results listed under "Done when", then run the fake-provider question and the failure cases.
Also in the Linux leg: `shellcheck install.sh`, and `! grep -q $'\r' install.sh`. In the Windows leg: parse `install.ps1` with `[System.Management.Automation.Language.Parser]::ParseFile` under 5.1 and fail on any error.

### `install.sh` (POSIX `sh`, `set -eu`)

- **Inputs (env only):** `RLMH_VERSION` (`latest`, `0.1.0` or `v0.1.0`), `RLMH_HOME`, `RLMH_DOWNLOAD_BASE`, `RLMH_NO_MODIFY_PATH=1`. Default base: `https://github.com/RishiJain905/rlm-harness/releases/latest/download`, or `…/releases/download/v<ver>`. When `RLMH_DOWNLOAD_BASE` is set it is used as given: a folder holding `rlmh-<os>-<arch>` and `SHA256SUMS`.
- **Platform:** `uname -s` Darwin or Linux. On macOS, `uname -m` x86_64 with `sysctl -n hw.optional.arm64` equal to 1 means Apple Silicon under Rosetta: pick arm64. Anything else (Linux arm64, musl/Alpine, BSD, MSYS) exits 1 with: `rlmh v0 ships macOS arm64 and x64, Windows x64 and Linux x64 (glibc). This machine is <uname -sm>.`
- **Download** with `curl -fsSL`, else `wget -q`, into `<home>/bin/.install.$$` (same filesystem, removed by `trap`). **Verify:** the `SHA256SUMS` line for the exact file name (strip a leading `*`) against `sha256sum`, else `shasum -a 256`, else `openssl dgst -sha256`. A missing line or a mismatch prints both values, deletes the download and exits 1. Nothing in `<home>/bin` changes before the check passes.
- **Install:** `chmod +x`, `mv -f` onto `<home>/bin/rlmh`. macOS: `xattr -d com.apple.quarantine` (ignore failure).
- **uv:** skip if `command -v uv` or `<home>/bin/uv` exists. Else download `uv-<triple>.tar.gz` (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`) from `https://github.com/astral-sh/uv/releases/download/$UV_VERSION/`, check it against the SHA-256 pinned in the script, `tar -xzf` into a temp dir, copy the file named `uv` (find it; do not assume the folder layout) to `<home>/bin/uv`. Pin `UV_VERSION` to the latest uv on the build day (0.13.6 on 2026-10-26) and copy the hashes from that release's `<archive>.sha256` files. Never invent one.
- **PATH:** skip if `<home>/bin` is already on `$PATH` or the rc file already has the marker. Else append `# rlm-harness` then `export PATH="<home>/bin:$PATH"` (`$HOME/.rlm-harness/bin` when default). File by `$SHELL`: zsh `${ZDOTDIR:-$HOME}/.zshrc`; bash `~/.bash_profile` on macOS, `~/.bashrc` on Linux; fish `~/.config/fish/conf.d/rlmh.fish` with `fish_add_path "<home>/bin"` (no marker line needed, the file is ours); else `~/.profile`.
- **Output**, then `<home>/bin/rlmh --version` as the last check:
```
rlmh 0.1.0 installed
  binary   <home>/bin/rlmh
  uv       <path> (installed by this script | already on PATH)
  data     <home>   (Python and the engine are added on first run)
  PATH     added to <rc file>; open a new terminal, or run: export PATH="<home>/bin:$PATH"
Next: run "rlmh". It asks before it downloads Python 3.12.
Uninstall: rm -rf <home>, and delete the "# rlm-harness" lines from <rc file>. Saved keys: delete them in /providers first.
```
A custom `RLMH_HOME` is not persisted; the output adds: `Set RLMH_HOME=<home> in your profile, or rlmh will look in ~/.rlm-harness.`

### `install.ps1` (Windows PowerShell 5.1 and 7; ASCII only, no BOM)

- **Same inputs and output** as `install.sh`, in env vars (`irm | iex` cannot take parameters). Default base uses `…/latest/download/rlmh-windows-x64.exe`.
- **5.1 rules:** top of file `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'` (the progress bar makes `Invoke-WebRequest` crawl) and `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12`. Use `Invoke-WebRequest -UseBasicParsing`. No `&&`, `??`, ternary or `-AsHashtable`. All logic sits in `function Install-Rlmh`, which fails with `throw` caught at the bottom: **never `exit` under `iex`, it closes the user's terminal**. Only when the script was run as a file (`$MyInvocation.MyCommand.Path` non-empty, read at script scope) does a failure end in `exit 1`; CI relies on that.
- **Platform:** `$env:PROCESSOR_ARCHITEW6432`, else `$env:PROCESSOR_ARCHITECTURE`. Only `AMD64`; ARM64 and x86 get the unsupported message.
- **Verify:** `Get-FileHash -Algorithm SHA256`, lower-cased, against `SHA256SUMS`.
- **Install:** write `bin\rlmh.exe.new`; if `rlmh.exe` exists (even running) rename it to `rlmh.exe.old`, move the new file in, `Unblock-File`, try to delete `.old` and ignore failure. Upgrade over a running `rlmh.exe` then works.
- **uv:** as in `install.sh`: `uv-x86_64-pc-windows-msvc.zip`, `Expand-Archive`, find `uv.exe` under the temp dir, copy to `bin\uv.exe`.
- **PATH:** read the raw value with `[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true).GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`, so `%VARS%` in it survive. Skip if an entry equals `<home>\bin` (trailing `\` and case ignored). Else `SetValue('Path', "$old;<home>\bin", ExpandString)`. Update `$env:Path` for this session. Broadcast `WM_SETTINGCHANGE` (`Add-Type` with `SendMessageTimeout` to `HWND_BROADCAST`, `"Environment"`); wrap it in try/catch, since it fails under Constrained Language Mode and is not worth failing for. No admin rights; no machine-wide change.
- **Output:** as above, with `rlmh.exe`. Uninstall lines are the commands in the table below. If `RLMH_HOME` is custom, tell the user to set it as a user variable.

| Windows detail | What happens |
|---|---|
| Execution policy | `irm \| iex` is not blocked: the policy covers script files. A saved `install.ps1` under `Restricted` fails with "running scripts is disabled on this system". Document `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` (this process only). The installer never changes the policy |
| SmartScreen | A browser-downloaded `rlmh-windows-x64.exe` shows "Windows protected your PC / Unknown publisher" (More info, Run anyway). A download by `irm` carries no Mark-of-the-Web (inferred), and the installer calls `Unblock-File` anyway |
| Defender, Smart App Control | An unsigned Bun binary can be flagged as a false positive (possible, not yet seen). Smart App Control, if on, blocks unsigned binaries with no per-file bypass. v0 does not sign; the release notes say so |
| Long paths | The installer does not enable `LongPathsEnabled` (a system setting). `setup` prints a warning when `<home>` is over 60 characters on Windows and suggests `RLMH_HOME=C:\rlmh`. Default paths stay well under 260 |
| Executable name | The release asset ends in `.exe` and `-windows-x64`; it is installed as plain `rlmh.exe` |

### `app/scripts/embed-engine.ts` (new, private to this step) and `app/build/engine-files.ts` (generated, git-ignored)

How the binary carries the engine. Bun 1.4.4 also has `--asset <dir>`, but its mount rule is in dispute (oven-sh/bun issues 44062 and 44065: it keeps only the last path segment) and it needs a walk of the embedded filesystem. This spec uses one `import … with { type: "file" }` per file instead, a long-documented mechanism that reads back bytes exactly (profile hashes cover file bytes). In source mode the import returns the real path; in a compiled binary, a path `Bun.file()` reads from the embedded filesystem.
- The script walks `engine/rlm_engine/` (every file: `.py`, `profile.toml`, `guidance.md`), skipping `__pycache__` and `*.pyc`, sorted by `/`-path, and writes `engine-files.ts`: one import per file, `ENGINE_FILES: {path: string; sha256: string; file: string}[]` and `ENGINE_BUNDLE_SHA256` (sha256 of the `path\0sha256\n` lines). It fails if `rlm_engine/__main__.py` is missing.
- `setup.ts` loads it with `await import("../../build/engine-files.ts")` inside try/catch. Missing means "this build has no engine inside" (a source run), so `bun test` and `bun run` work on a fresh checkout. The release builds pass `--reject-unresolved`, so a binary can never ship without it.

### `app/src/cli/setup.ts`

```ts
export interface SetupOptions { home: string; yes: boolean; force?: boolean; interactive: boolean;
  env?: Record<string, string | undefined>; out?: (line: string) => void;
  ask?: (q: string) => Promise<boolean>; runUv?: UvRunner; bundle?: EngineBundle | null; platform?: NodeJS.Platform }
export function findUv(opts: { home: string; env?: Record<string, string | undefined> }): string | null; // <home>/bin/uv[.exe], then PATH
export function extractEngine(bundle: EngineBundle, dest: string): void;     // byte-exact, via <dest>.tmp then rename
export async function runSetup(o: SetupOptions): Promise<number>;            // `rlmh setup [--yes] [--force]`; exit code
export async function ensureEngine(o: Omit<SetupOptions, "yes">): Promise<void>; // main.ts calls it; throws EngineNotFound
```

`runSetup` in order:
1. If `.installed.json` for this `APP_VERSION` has this binary's `ENGINE_BUNDLE_SHA256` and its `python` exists (and no `--force`): print `already installed`, return 0.
2. Find a Python: the `python` in any `<home>/engine/*/.installed.json` that still exists, else `uv python find 3.12` (env `UV_PYTHON_INSTALL_DIR=<home>/python`, `UV_MANAGED_PYTHON=1`, `UV_PYTHON_DOWNLOADS=never`) when uv exists. Found: no download and no question.
3. Not found: needs uv (else the no-uv message). Unless `--yes`, ask the question below. Then run `uv python install 3.12` (add `--reinstall` under `--force`) with env `UV_PYTHON_INSTALL_DIR=<home>/python`, `UV_PYTHON_BIN_DIR=<home>/python/bin`, `UV_PYTHON_INSTALL_BIN=0`, `UV_PYTHON_INSTALL_REGISTRY=0`, so no `python3.12` lands in `~/.local/bin` and no Windows registry key is written. uv's progress shows on a TTY. The environment passes through with key-like variables removed (D-29). Then `uv python find` again; the path must lie inside `<home>/python`, else refuse.
4. `extractEngine` to `<home>/engine/<APP_VERSION>/`; write `.installed.json` `{app_version, bundle_sha256, python, python_version, installed_at}` last.
5. Check: `startEngine(findEngine({home}))`, `engine.info`, `protocol` equals `PROTOCOL_VERSION`, then `kill()`. On failure delete the marker, print `engine.stderrTail()`, return 1. This is the code `rlmh info` runs.
6. Print the Python path and version, the engine folder, and `shell() will use: <name>` (`python -E -s -c` calling `rlm_engine.workspace.find_shell()`; ignore failure). Return 0.

| Situation | Result |
|---|---|
| engine found already (`RLMH_ENGINE`, checkout, installed) | `ensureEngine` returns at once |
| missing, TTY, Enter or `y` | install, then the user's command continues |
| missing, TTY, `n` | `Not installed. Run "rlmh setup" when you are ready, or set RLMH_ENGINE to your own engine command.` exit 1; the command does not run |
| missing, no TTY, no `--yes` | no prompt, no hang: throw `EngineNotFound` (message names `rlmh setup --yes` and `RLMH_ENGINE`), exit 1 |
| Python present, only this version's engine missing (an upgrade) | extract with one printed line, no question, no network |
| no uv | `uv was not found in <home>/bin or on PATH. Re-run the install script, or install uv (https://docs.astral.sh/uv/) and run "rlmh setup".` exit 1 |
| offline or blocked during `uv python install` | `Could not download Python 3.12 (uv exited <code>). Check your network or proxy (uv honours HTTPS_PROXY), or set UV_PYTHON_INSTALL_MIRROR. Nothing was recorded; run "rlmh setup" again when online.` exit 1; the next start asks again |
| set up once, then offline | everything runs; only calls to remote providers need a network |

The question: `rlmh needs Python 3.12 for its engine and has none yet. Download it now (standalone build, through uv, tens of MB) into <home>/python/ and copy the engine to <home>/engine/<version>/? Nothing else on this machine changes. [Y/n]`

### `app/src/engine.ts` (+10)

Item 3 of `findEngine`: read `<home>/engine/<APP_VERSION>/.installed.json` synchronously. If it parses, its `python` file exists and `rlm_engine/__main__.py` exists in that folder, return `{cmd: [python, "-E", "-s", "-X", "utf8", "-m", "rlm_engine", "serve"], cwd: <that folder>, env: {}}`; otherwise fall through to item 4. `-E` ignores `PYTHON*` variables (so `-X utf8` gives UTF-8 mode, D-42), and there is no `-I`, so `-m` finds the package through the cwd. The worker is started by the engine as `python -I -B -X utf8 <folder>/rlm_engine/worker/worker.py` (D-01), unchanged. `startEngine` must merge `env` over the process environment: on Windows, Python fails at startup without `SYSTEMROOT`.

### `app/src/main.ts` (+10)

`rlmh setup [--yes|-y] [--force]` calls `runSetup` and exits with its code. `info`, `run`, `batch` and the bare `rlmh` call `ensureEngine` first, with `interactive` = stdin and stdout are both TTYs, before anything else starts (so the prompt is plain text, before Ink). `--version`, `--help` and `config` never call it. `--help` lists `setup`.

### Uninstall (exact commands; the scripts print the short form)

macOS and Linux:
```
rm -rf "${RLMH_HOME:-$HOME/.rlm-harness}"
sed -i.bak '/# rlm-harness/,+1d' ~/.zshrc    # or ~/.bashrc, ~/.bash_profile, ~/.profile; the .bak file is yours to delete
rm -f ~/.config/fish/conf.d/rlmh.fish         # fish only
```
Windows PowerShell:
```
$h = if ($env:RLMH_HOME) { $env:RLMH_HOME } else { "$env:USERPROFILE\.rlm-harness" }
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$p = $k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$k.SetValue('Path', (($p -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne "$h\bin" }) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
Remove-Item -Recurse -Force $h
```
First delete saved keys in `/providers`; removing `<home>` leaves them in the Keychain, Credential Manager or libsecret (service `rlm-harness`).

## Tasks

1. [ ] Write `scripts/embed-engine.ts`, then `extractEngine` and the loader in `setup.ts`, with the extraction cases of `setup.test.ts`.
2. [ ] Prove the embedding on the PC before building more. From `app/`: `..\.bun\bin\bun.exe run scripts/embed-engine.ts`, then compile with the flags above to `..\dist\rlmh-windows-x64.exe`. With `RLMH_HOME=%TEMP%\rlmh-try`, run `rlmh setup --yes`. If an embedded file cannot be read in the compiled binary, stop and tell Rishi before choosing another mechanism.
3. [ ] Write `findUv`, `runSetup`, `ensureEngine`, and their cases in `setup.test.ts`.
4. [ ] Add `findEngine` item 3 and its cases to `engine.test.ts`; wire `main.ts`.
5. [ ] Write `install.ps1` and run it on the PC against a local server. Serve `dist\` (`python -m http.server 8099 --directory dist`), write `dist\SHA256SUMS` with the same two-space lines as CI, then `$env:RLMH_DOWNLOAD_BASE='http://127.0.0.1:8099'; $env:RLMH_HOME="$env:TEMP\rlmh-try"; irm http://127.0.0.1:8099/install.ps1 | iex`. Run it from Windows PowerShell 5.1 (`powershell.exe`) and from `pwsh`.
6. [ ] Write `install.sh`. It cannot run on the PC; CI is its test. Run `shellcheck` if available.
7. [ ] Fill the uv pin tables from the uv release's `.sha256` files. Add the `install` job to `ci.yml` and the new flags to its build step. Run the unit tests first, then ask Rishi before pushing a branch to get CI to run.
8. [ ] Write `release.yml`. Run `actionlint` if available; otherwise at least parse the YAML. Ask Rishi before any push. After CI is green, ask again before pushing a `workflow_dispatch` run, and again before tagging `v0.1.0`.
9. [ ] On Rishi's PC, install from the real release (see Done when), and write the progress.md lines.

## Tests

Offline, no real uv, no network. They use a temp `<home>` and a stand-in `uv` script that records its argv and env.

**`app/test/setup.test.ts` (new)**
- `findUv`: `<home>/bin/uv[.exe]` beats PATH; PATH works; neither gives `null`.
- `extractEngine`: every file is written byte-identical (sha256 equals the manifest), folders created, no `__pycache__`; a half-written `<dest>.tmp` from an earlier crash is replaced. Against the real generated bundle (skipped when `app/build/engine-files.ts` is absent): it holds `rlm_engine/__main__.py`, `rlm_engine/worker/worker.py` and `rlm_engine/profiles/training-v4/profile.toml`.
- Declined question: no uv call, exit 1, `<home>` has no `python/` or `engine/`.
- `--yes`: uv called with `python install 3.12` and env `UV_PYTHON_INSTALL_DIR=<home>/python`, `UV_PYTHON_INSTALL_BIN=0`, `UV_PYTHON_INSTALL_REGISTRY=0`; no key-like variable is passed; the marker names the Python; a second run prints `already installed` and does not call uv.
- Upgrade: marker for an older version with an existing Python, new `APP_VERSION`: no question, no uv `install` call, new engine folder written.
- uv exits non-zero: exit 1, message has `UV_PYTHON_INSTALL_MIRROR`, no marker, no `engine/<version>/` left.
- `uv python find` returns a path outside `<home>/python`: refused.
- No uv anywhere: exit 1 with the no-uv message; nothing written.
- `ensureEngine`: non-interactive and no engine throws `EngineNotFound` (message has `rlmh setup --yes` and `RLMH_ENGINE`) without asking; with `RLMH_ENGINE` set it returns without asking.
- `platform: "win32"` with a 70-character `home` prints the long-path warning; 40 characters does not.

**`app/test/engine.test.ts` (+cases from step 2)**
- Installed mode returns exactly `[python, "-E", "-s", "-X", "utf8", "-m", "rlm_engine", "serve"]` and cwd `<home>/engine/<APP_VERSION>`.
- A marker whose `python` is missing, or an engine folder without `__main__.py`, ends in `EngineNotFound`.
- `RLMH_ENGINE` beats the installed engine; the source checkout beats it too when not compiled.

**CI `install` job** (the install scripts and the compiled binary are tested here, on all three OSes).

## Done when

1. `cd app && bun test` passes on all three OSes in CI, including `setup.test.ts` and the new `engine.test.ts` cases.
2. The CI `install` job is green on `ubuntu-latest`, `windows-latest` and `macos-14`, and on the extra uv-present Linux leg. Each leg asserts, in order:
   1. `install.sh | sh` / `irm | iex` exits 0; `<home>/bin/rlmh[.exe] --version` prints `rlmh <APP_VERSION>`; `<home>/bin/uv[.exe]` exists (not in the uv-present leg).
   2. PATH: exactly one `# rlm-harness` line in the rc file that `$SHELL` selects, and `"$SHELL" -ic 'command -v rlmh'` finds it; Windows: the registry `Path` ends with `<home>\bin`, and its `%VARS%` entries are still unexpanded.
   3. Before setup, in a fresh home with no TTY: `rlmh run …` exits non-zero within 20 s and prints `rlmh setup --yes`.
   4. `rlmh setup --yes` exits 0. `<home>/python/cpython-3.12.*` exists and `<home>/engine/<APP_VERSION>/.installed.json` exists. Outside `<home>` nothing was added except the PATH entry: no `~/.local/bin/python3.12`, and on Windows no new key under `HKCU:\Software\Python` (count before and after).
   5. `rlmh info` prints JSON whose `engine.protocol` is `1`, whose `engine.version` equals the `--version` number and whose `engine.python` mentions `3.12`; the `python` in `.installed.json` lies under `<home>/python`.
   6. The fake-provider question completes. With `RLMH_FAKE_SCRIPT` naming `{"root":[{"text":"","tool_call":{"code":"submit(llm('Summarize x'))"}}],"sub":[{"match":"^Summarize","text":"a summary"}]}` and a one-line `input.txt`, `rlmh run --question q --input input.txt --root fake/scripted --sub fake/scripted --json | jq -es 'any(.[]; .type=="run.finished" and .answer=="a summary" and .submitted==true and .subcalls==1 and .infra_error==null)'` prints `true`. This runs the worker from the extracted folder with `-I`.
   7. Re-running the installer exits 0 and leaves one marker line; `rlmh setup --yes` prints `already installed`.
   8. A `SHA256SUMS` with one wrong digit makes the installer run as a file (`sh install.sh`; `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`) exit non-zero, and `<home2>/bin/rlmh[.exe]` does not exist (`RLMH_HOME=<home2>`).
3. `release.yml`, run by `workflow_dispatch` on a branch Rishi agreed to push, uploads four artifacts named as in the table and its `publish` job is skipped.
4. After Rishi agrees to tag `v0.1.0`: the release page lists the four binaries, `install.sh`, `install.ps1` and `SHA256SUMS`; downloaded to one folder, `sha256sum -c SHA256SUMS` (Windows: compare `Get-FileHash`) passes; each binary's size is recorded in the progress.md log.
5. On Rishi's PC, in a fresh Windows PowerShell 5.1: `irm https://github.com/RishiJain905/rlm-harness/releases/latest/download/install.ps1 | iex` prints the summary. In a new terminal opened from a folder that is not a checkout, `rlmh --version` works, then `rlmh` asks the question, a `y` puts Python under `C:\Users\<user>\.rlm-harness\python\`, and `.installed.json` names it. Rishi saves a key in `/providers` himself and runs one real question (or says go and names the model); the builder makes no call with his key otherwise.
6. The Windows uninstall commands leave `Test-Path $env:USERPROFILE\.rlm-harness` false and no `.rlm-harness` in `HKCU:\Environment` `Path`.

## Out of scope

- Code signing and notarization, Windows ARM64, Linux arm64 and musl, `-baseline` CPU builds: later. The installer rejects these with a clear message.
- Bundling Python (10a alternative), winget, Homebrew and Scoop packages, an `rlmh update` command (re-run the installer), and removing old `engine/<version>/` folders.
- Installing Git for Windows, enabling long paths, changing the execution policy: system changes, never done by the installer.
- Any call to a real provider in CI. The real question is Rishi's check, not CI's.

## Hand-off

- v0 is functionally complete. Anyone can `rlmh setup`, `rlmh run` and `rlmh batch` from the installed binary.
- progress.md row 10: `review` once the PC check passes, `done` after Rishi's word. Log: the release tag, the CI run links, the four binary sizes, `UV_VERSION`, the Python patch version uv fetched, and the minutes `rlmh setup` took on the PC.
- One change to step 2's work is part of this step and must be logged: the engine embedding (and `--reject-unresolved`) in the binary build. The `--no-compile-autoload-*` flags are step 2's already (D-44); check they are still there.
- v1 inherits: `.installed.json` (the one place that names the installed Python), the `<home>/bin` layout, and the `install` job as the regression test for the compiled binary on each OS.

## If a decision goes the other way

Every decision below was settled at step 1 (2026-10-30; [decisions.md](../decisions.md) S-22 to S-34). Each line names the pick and says what would change if Rishi reversed it. Picks that went the alternative way are already written into this spec.

- **2b, each OS's standard folder** (settled: `~/.rlm-harness/`, S-24): `paths.ts` is the only code that changes for `rlmh`, but both install scripts compute `<home>` and the PATH line themselves, so edit them. The "one folder to delete" promise ends: `bin/`, `python/` and `engine/` belong in the data folder (`~/.local/share/rlm-harness`, `~/Library/Application Support/rlm-harness`, `%LOCALAPPDATA%\rlm-harness`), `settings.toml` in the config one, and the uninstall commands list each. The CI assertions use `paths.ts` output instead of `$HOME/.rlm-harness`. `RLMH_HOME` still overrides everything.
- **4a, always PowerShell** (settled: Git Bash, else PowerShell, S-26): only the `shell() will use:` line changes. **(Require Git Bash):** `install.ps1` probes for Git Bash the way `workspace.find_shell` does and exits with a link to Git for Windows; `rlmh setup` returns 1 when `find_shell()` is not `bash`. The Windows CI leg keeps working, since runners have Git for Windows.
- **10a, bundle a standalone Python** (settled: uv on first run, S-33): each binary grows by 30 to 50 MB (the build plan's figure; a stripped 3.12 is nearer 30, inferred), so each release asset is roughly 130 to 150 MB. The release build fetches the matching python-build-standalone `install_only_stripped` archive, checks a pinned hash and embeds it next to the engine files; `setup` unpacks it to `<home>/python/` (the same folder, so uninstall is unchanged) with no uv, no question and no network. `findEngine` does not change: it still reads `.installed.json`, whose `python` now points into `<home>/python/python/`. The uv pin tables, the uv step in both scripts, the `UV_*` variables and the offline rows of the table all go. The CI `install` job then needs no network after the download from the local server. Python security updates ship only with an `rlmh` release.
