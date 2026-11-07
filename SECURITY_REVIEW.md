# Security review of rlm-harness (2026-11-07)

Scope, in the order asked: the worker REPL and its permission layer, the gateway and secrets, untrusted-input
parsing, the tuner, and a read-only look at install, release and CI. Repository at `b27ea3b` (v1.0.0), reviewed
on the local branch `security-review`, one commit per finding, nothing pushed.

Two helper reviews (the tuner; install, release and CI) ran as delegated read-only agents on the same model as
this session. Every finding they raised that is listed here was re-read in the code by the main session before
it was patched or recorded; their reports are summarised, not pasted.

## 1. What ran offline, and what did not

| Tool | State | Used for |
|---|---|---|
| Python 3.12.3 (`/usr/bin/python3.12`), 3.13.18 | present | the engine tests, under 3.12 with pytest 9.1.1 from a uv tool install on `PYTHONPATH` |
| `uv run --project engine` | **not usable**: `uv.lock` needs `zizmor` and `pytest` wheels that are not in the cache, and there is no network | `scripts/verify.sh` could not run; its stages were run by hand instead (see below) |
| Bun 1.4.4, Node 22.23.4 | present; `app/node_modules` absent and the Bun cache empty | `bun test` on every test file that imports only `bun:test`, `node:*` and the app's own pure modules |
| `tsc` (typescript 7.0.2) | **not installed** | `bun run typecheck` was not run; Bun transpiles the edited files, so a type error in them would surface as a test failure, which is a weaker check |
| git 2.x | present | the worker, workspace and worktree tests, which drive real repositories |
| Network | none, and none attempted | nothing fetched; the `fetch` tool, update and setup paths were read, their tests use fakes |

Test results on the patched branch, Python 3.12:

- Engine: `833 passed, 6 skipped` (was `827 passed, 6 skipped` before the review's six new tests). The skips are
  Windows-only and `RLM_TRAINING_REPO` cases.
- App: `525 pass, 11 skip, 48 fail` (was `521 pass`, same 48 failures). The 48 failures are all environmental and
  unchanged by this review: files that import `ink`, `react`, `@anthropic-ai/sdk` or `openai` (no `node_modules`),
  the tests that start the real engine through `uv run` (no wheels), and the eval tests that build venvs.
- Verify gate: `secrets` stage logic checked by hand (no key-shaped strings in the diff; the only `sk-`/`hf_` strings
  in the touched tests already carry `FAKE`); `engine-tests` and `app-tests` as above; `workflows` (zizmor) **not
  run**, no wheel offline, and no workflow file was changed.

Every regression test below was run twice: once with its source patch stashed (it failed) and once with the
patch (it passed). "Ran" means exactly that.

## 2. Findings

Severity ranks exploitability and blast radius, not CVSS. Attacker positions: **model** (the root or a sub-call
model, including a prompt-injected one, writing REPL code), **repo** (a repository the user opens in rlmh),
**local file** (someone who can write a file rlmh later reads, which on a single-user machine is the model or a
test command it wrote), **release** (whoever can write release assets).

| Id | File:line (before the fix) | Class | Reachable | Severity | Test | Fix commit |
|---|---|---|---|---|---|---|
| SR-1 | `engine/rlm_engine/worker/tools.py:223-231` | quiet subprocess from a model-controlled PATH and environment | yes: model, every permission mode | **high** within the permission layer's own goal (an unprompted command) | ran (`test_security_review.py::test_sr1_*`, 2 tests) | `020f043` |
| SR-2 | `engine/rlm_engine/worker/hooks.py:170-176` | accept-edits lets writes under `.git/` through unasked | yes: model, accept-edits (the default mode) | medium | ran (`test_sr2_*`, 4 cases) | `fcce5dd` |
| SR-3 | `app/src/cli/setup.ts:507` (probe), `:472-478`, `:566` (uv) | Python started without `-I`; uv with the current folder's config files | yes: repo or model, on first run or upgrade of `rlmh` started inside that folder | medium | ran (`setup.test.ts`, 2 assertions) | `7830c63` |
| SR-4 | `app/src/eval/tar.ts:75-86` | Windows device names accepted in a tar entry | yes: a crafted eval set, Windows only | low | ran (`tar.test.ts`) | `e69a40a` |
| SR-5 | `app/src/tune/worktree.ts:449-450` | recursive removal of a path read from `work.json` | yes: local file under `<home>/tune/work` | low (the writer already runs as the user) | ran (`worktree.test.ts`) | `fbcc3a1` |
| SR-6 | `app/src/tune/candidate.ts:214-222` | `<home>/profiles/<name>` with an unchecked name from `tune.json` | yes: local file, `--continue OUT` | low | ran (`candidate.test.ts`) | `aac4d24` |
| SR-7 | `worker/worker.py:36-45`, `hooks.py:75-87`, `tools.py:110-123` | the permission layer is in-process and can be switched off by a cell | yes: model, every mode | **design limit**, not patched | ran as a scratch probe, not committed | none |
| SR-8 | `engine/rlm_engine/permissions.py:95`, `worker/tools.py:722-724` | a `fetch` approval shows and remembers only the host; the URL (path, query) is never shown | yes: model, after one approval of a host | low, design (D-47) | not run | none |
| SR-9 | `.github/workflows/release.yml:112,142`, `install.sh:224-227`, `install.ps1:145-158`, `app/src/cli/update.ts:310-316` | release integrity rests on an unsigned `SHA256SUMS` from the same release | yes: release | medium, out of scope to change | not run (read-only scope) | none |
| SR-10 | `.github/workflows/release.yml:97-103` | any `v*` tag with a green `ci.yml` run on its commit, on any branch, publishes a release | yes: anyone with push access | low | not run | none |
| SR-11 | `install.sh:117-125,199-209`, `install.ps1:117-124` | `RLMH_VERSION` unvalidated in the URL; `curl` without `--proto '=https' --proto-redir =https`; a custom `RLMH_DOWNLOAD_BASE` also serves the checksums | only through the user's own environment | low | not run (read-only scope) | none |
| SR-12 | `app/src/gateway/gateway.ts:684-687` | `asModelError` redacts without the key, so a non-`sk-` key (Gemini `AIza…`) in an SDK error message would pass | needs an SDK error that echoes the key; none known | info | not run | none |
| SR-13 | `app/src/tune/online.ts:883-895`, `interface/tuning.ts:278` | a kept tune installs model-written prompts and `scripts/*.py` as the active profile with no review | yes: model, with `/tune on` | medium, design (D-218, D-231) | not run | none |

### SR-1: the tools' quiet git came from the cell's PATH and environment

`find_files`, `grep` and `diff` run `git` under `tools._quiet()`, so the audit hook never asks about it (D-13).
`_git` found the program with `shutil.which("git")` and built its environment from `os.environ` at call time.
Both are the worker's own process state, which every cell can change: `os.environ["PATH"] = root + ":" + ...`
after writing a `git` script into the workspace (silent in accept-edits) or into scratch (silent in every mode,
D-12), then `find_files("*")`, runs that script with no prompt. `LD_PRELOAD` and `GIT_EXEC_PATH` give the same
result. The accidental version is real too: a cell that prepends a repository's `.venv/bin` to PATH runs
whatever `git` that repository ships.

Fix: `configure()` records `shutil.which("git")` and a copy of `os.environ`; `_git` and `diff()` use only
those. Residual, Windows only: the `taskkill` fallback after a timed-out `shell()` is still found on PATH
(`tools.py:653`); the same one-line treatment applies, left out because it cannot be tested here.

Variant hunt: `inputs._git_names`, `workspace._git` and `mentions.gitFiles` run in the engine and app processes,
whose environment the model does not control; `shell()` asks first and shows the command, so its PATH does not
matter. Clean.

### SR-2: writes under `.git/` were "inside the workspace"

`accept-edits` lets any write whose real path is under the workspace through without asking. `.git/` is under
the workspace. A cell could write `.git/hooks/pre-commit`, add `core.fsmonitor`, `diff.external` or an alias to
`.git/config`, or drop a file into `.git/hooks/`, all silently; the user's next `git commit`, `git status` or
`git diff` in that repository then runs it, outside rlmh and its prompts. rlmh's own git calls are hardened
against exactly these settings (`core.hooksPath`, `core.fsmonitor=false`, `--no-ext-diff`, filters off), which
shows the repository's config is in the threat model; the user's own git has none of that.

Fix: in `hooks._write`, a path with a `.git` segment (case folded) is never `inside`, so it asks like a write
outside the workspace, in accept-edits and default alike; `bypass` still asks nothing. The prompt's wording
says "outside the workspace" for it (`Approval.tsx:35`); an "in .git" label would read better. A "for the rest
of this run" answer on such a prompt is remembered as the outside-write key (D-14), as for any outside write.

Variant hunt: the engine's `workspace.fingerprint` already skips `.git`, so a `.git` write never showed as a
repository change either (`workspace.py:284`). A `.git` *file* (worktrees, submodules) and `.git/worktrees/…`
are covered by the segment rule. The tools' own `diff()` writes only under scratch. Clean.

### SR-3: `rlmh setup` trusted the folder it was started in

`ensureEngine` runs on the first run and on every upgrade, from whatever folder the user started `rlmh` in.
The Python probe ran `python -E -s -c <code>`: `-E -s` drop `PYTHON*` variables and the user site, but `-c`
still puts the current folder first on `sys.path`, so `platform.py` or `rlm_engine/` in that folder was
imported and ran as the user. The two uv calls honoured a `uv.toml` or `pyproject.toml [tool.uv]` found in the
current folder, which can set a Python download mirror or allow insecure hosts. Both files are things a
repository, or the model editing one, can leave behind.

Fix: the probe runs with `-I`; both uv calls get `UV_NO_CONFIG=1`. The user's own `UV_*` variables still pass
through, as documented (`UV_PYTHON_INSTALL_MIRROR` is the advertised proxy override).

### SR-4: Windows device names in a tar

`safePath` refused absolute paths, drive letters, `..`, the characters Windows cannot hold and trailing dots or
spaces, but not `CON`, `NUL`, `COM1`… (with or without an extension), which open a device in any folder on
Windows. Fix: refused. Also noted, not changed: `readTar` gunzips a `.tar.gz` fully into memory with no size
cap, so a crafted set can exhaust memory; sets are the user's own files.

### SR-5 and SR-6: tuner clean-up trusted files it had written

`pruneStale` removed, recursively, the `path` found in any leftover `work.json`; `uninstallProfiles` and
`installProfile` joined a name from `tune.json` onto `<home>/profiles/`. In both cases the only writer with
the opportunity (a test command running the model's diff, or a `bypass` run) already acts as the user, so
these are hardening, not escalations. Fixes: the worktree path must lie below the `work.json`'s own folder; the
profile name must match the engine's profile-name rule.

### SR-7: the permission layer is an in-process honour system

The docs say "code can get around an audit hook, for example through ctypes". The bar is lower than ctypes:
the worker imports `hooks` and `tools` as top-level modules that stay in `sys.modules`, and every tool is a
plain function whose `__globals__` is the tools module. Each of these cells ran `os.system` in `default` mode
with zero approval requests, checked with the test harness's real worker (scratch probe, not committed):

```python
import tools, os; tools._local.quiet = 1; os.system('...')
shell.__globals__['_config']['approve'] = None; shell('...')
import hooks, os; hooks._local.busy = True; os.system('...')
```

Also unaudited: `os.kill`, `os.killpg` (the model can end any of the user's processes), `socket.bind`/`accept`
(a listener), and `_in_socketpair` can be spoofed by code compiled with filename `socket.py` and a function
named `socketpair`. None of this is fixable inside the worker process. What would fix it is the optional OS
sandbox the architecture doc already names (Seatbelt, bubblewrap or Landlock), or at least running the worker
under a restricted user. Until then the documentation should say plainly that `default` and `accept-edits`
stop accidents and a cooperative model, and that a prompt-injected model is bound only by `bypass`'s limits,
that is, none. SR-1 and SR-2 are still worth their fixes: they close paths an honest-but-careless model takes
(activating a venv, writing into `.git`).

### SR-8: `fetch` approves a host, not a request

`fetch(url)` asks for the bare host (D-47) and a plain "allow" is remembered for the run. Everything after the
host is invisible to the user, and every later URL on that host is fetched silently. A model that has read a
file (reads never ask, `~/.rlm-harness/keys.json` and `~/.ssh` included) can send its contents in a query
string to any host the user approved once. The same is true of raw sockets after one approval. The engine's
fetch itself is well built: same-host redirects only, a 200k-character cap, a 30 s deadline with a socket
watchdog, http and https only. Suggest showing the full URL (cut to one line) in the prompt, and remembering a
host only when the user picks "for the rest of this run".

### SR-9 to SR-11: install and release (read-only)

`SHA256SUMS` is produced by the release job and served beside the binaries; the installers and `rlmh update`
check against it, nothing checks it. The release notes say so. A `v*` tag publishes when `ci.yml` was green on
that commit on any branch, not only `main`'s merge commit as the release process in `CLAUDE.md` requires. The
installers take `RLMH_VERSION` and `RLMH_DOWNLOAD_BASE` from the environment as given, and `curl -fsSL` does not
pin the scheme across redirects. The rest of this area is in good shape: every action pinned to a full SHA,
`persist-credentials: false` everywhere, minimal per-job permissions, no `pull_request_target`, no untrusted
context in `run:` steps, `--frozen-lockfile`, uv archives hash-pinned in both installers, npm publish behind an
environment approval with OIDC and `--provenance`, and `rlmh update` with a fixed repository URL, bounded bodies
and no credentials. Suggested, in order: build provenance attestation (`actions/attest-build-provenance`) with
`gh attestation verify` in `update.ts`; a tag ruleset or an actor check on `publish`; `--proto '=https'
--proto-redir =https` and a version regex in `install.sh`.

### SR-13: a kept tune activates model-written code without review

`/tune on` is the one consent; afterwards a composed candidate that beats the base is installed under
`<home>/profiles/tuned-*` and made the active profile, including `scripts/*.py` that every later run copies into
its scratch folder and puts on `sys.path`. The engine's `profile.check` only compiles them and requires
standard-library imports, which is hygiene, not a sandbox (`os`, `subprocess` and `socket` are standard
library). The scripts run under the audit hooks, so they are no stronger than a cell, but they persist across
sessions and run under whatever mode the user later picks. Suggest showing the profile diff (already computed by
`diffProfiles`) and asking before activation, or never auto-activating a profile whose `changed` list includes
`scripts/`.

## 3. Dependencies to audit with network (all unverified, offline)

Locked versions from `app/bun.lock` and `engine/uv.lock`. Only the ones that parse untrusted bytes, talk to
the network or handle secrets are listed. The versions of the two SDKs are later than this reviewer's training
data, so no vulnerability claim is made either way.

| Package | Version | Role | Called from | Note |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | 1.3.0 | HTTP client to Anthropic | `gateway/anthropic.ts`, `gateway.ts:631` | built with `fetch` injected, `maxRetries: 0`, `logLevel: "off"`, ambient header vars removed (D-76) |
| `openai` | 7.46.0 | HTTP client to OpenAI, DeepSeek, OpenRouter, Gemini, local, custom | `gateway/openai.ts`, `gateway.ts:632` | `organization: null, project: null`, same fetch injection; check its changelog for header or proxy env handling |
| `ws` | 7.5.13 | websockets | only through `react-devtools-core` (dev dependency, needed so `bun build --compile` resolves Ink's import) | 7.5.10 fixed the 2024 header DoS; nothing here opens a websocket |
| `standardwebhooks`, `json-schema-to-ts`, `@opentelemetry/api` | 1.1.1, 3.1.1, 1.10.0 | transitive from `openai` | not called by rlmh | audit as part of the SDK |
| `ink` / `react` / `react-reconciler` | 8.0.0 / 19.3.1 / 0.34.0 | terminal UI | interface | render only |
| `typescript` | 7.0.2 | typecheck | dev | |
| `zizmor` | 1.31.1 | workflow audit | verify gate, CI | hash-locked in `uv.lock` |
| `pytest`, `pluggy`, `packaging`, `pygments`, `iniconfig`, `colorama` | 9.2.0, 1.7.0, 26.3, 2.21.0, 2.3.1, 0.4.6 | test only | | |
| Bun | 1.4.4 | runtime; `Bun.secrets`, `Bun.gunzipSync`, `Bun.TOML.parse`, `Bun.spawn` | everywhere | the archive and TOML parsers in use are Bun's own; follow Bun's advisories |
| uv | 0.13.6 | Python download at setup | `install.sh`, `install.ps1`, `setup.ts` | hash-pinned per platform in the installers |
| Python | 3.12.x (uv's choice) | the engine | | the engine is standard library only at run time |

The engine has no run-time dependencies, so there is no Python parser or HTTP client to audit beyond the
standard library's `urllib`, `http.client`, `json` and `tarfile` (not used; the app has its own ustar reader).

## 4. Checked and found clean

Worker and permissions
- Writes: `open`, `os.open`, `os.rename`/`os.replace`, `os.remove`/`unlink`, `os.mkdir`, `os.rmdir`, `os.truncate`,
  `os.chmod`, `os.chown`, `os.utime`, `os.link`, `os.symlink`, xattrs all audited; paths resolved with
  `realpath` and `normcase`, so a symlink inside the workspace to the outside counts as outside, with `dir_fd`
  resolved on Linux and macOS. A dangling or relative symlink chain cannot land inside.
- Processes: `subprocess.Popen`, `os.system`, `os.exec*`, `os.spawn*`, `os.posix_spawn`, `_winapi.CreateProcess`,
  `os.startfile` audited; the Popen-then-spawn dedup is keyed on the same argv.
- Network: `socket.connect`, `connect_ex`, `sendto`, `sendmsg` audited; the worker opens no connection for
  `fetch`, the engine does, without keys.
- The worker runs `python -I -B -X utf8`, cwd the workspace, fds 0 to 2 pointed at the null device or a capture
  pipe, the protocol on private dups; a cell cannot forge a reply (replies come from the engine on stdin) and
  the manager strips the `turn` field from requests. Key-like variables are removed at both hops with matching
  regexes (`engine.ts:55`, `manager.py:59`), git's `GIT_CONFIG_*` set as a whole (D-62).
- Approvals: the engine's `Permissions.check` validates kinds, treats anything but `{"allow": true}` as a
  denial, serialises prompts, denies in non-interactive runs (D-15), and remembers only what D-14 lists. Read-only
  child runs (`child.ReadOnly`) refuse writes and commands outside their scratch folder without asking.
- Both git recipes (`workspace.py`, `tools._git`, `eval/work.ts`, `tune/worktree.ts`, `mentions.gitFiles`) set
  `core.hooksPath` to the null device, `core.fsmonitor=false`, `--no-ext-diff --no-textconv`, blank every filter
  driver, use a temporary index and a scratch object store, and never write the repository's index, refs or
  objects; work copies also get `GIT_CONFIG_NOSYSTEM=1` and a null global config.
- `kill_shell_groups` reads pgids from a scratch file the model can write, but never kills pgid 1 or its own
  group, and the model can call `os.killpg` itself (SR-7), so this adds nothing.

Gateway and secrets
- `keys.ts`: no network on save (and `nonetwork.test.ts` traps `fetch`, `Bun.connect` and the SDKs to prove it);
  `Bun.secrets` first, `keys.json` written `0o600` through a temp file with the handle held from create to close,
  ACL-restricted on Windows, mode tightened on read; `key-index.json` holds id, label and `last4` only (a short
  key shows nothing); a label cannot contain the key; a lost OS-store write is cleaned up.
- Errors: provider detail goes through `redact` (the key itself, `Bearer …`, `sk-…`) and is cut to 300
  characters; 401/403 messages name the key's label and last four only. `run.permission`, `run.subcall` and the
  run log carry prompts and outputs, never headers or keys. `--json` output (`print.ts`) carries usage and
  errors only.
- Clients: `apiKey` and `baseURL` always passed, `organization: null, project: null`, `anthropic-version` pinned,
  built inside `withoutAmbientHeaders`, retries and timeouts in the gateway, `refreshModels` only on request.
- `settings.toml` parsed by `Bun.TOML.parse` against a fixed schema; provider ids must match `PROVIDER_ID` and the
  catalog overlay skips `__proto__`-like keys (`catalog.ts:78`). `JSON.parse` results are never `Object.assign`ed
  onto prototypes; the three `Object.assign` calls target fresh objects.

Parsing
- `link.py` / `link.ts`: byte-split lines, fatal UTF-8 decoding, a 32 MB line limit both ways with an error reply
  rather than a hang, `classify` rejecting anything that is not JSON-RPC 2.0, params must be objects, unknown
  methods answered. The manager's worker reader has 4 MB / 64 MB limits with an error reply for an over-long
  request. The app–engine pipe is a same-user channel, so these are robustness, not a trust boundary.
- `tar.ts`: regular files and folders only, symlinks and hard links refused, `..`, absolute and drive paths
  refused, case-fold collisions refused, a final `startsWith(root + sep)` check before each write, modes reduced
  to `0o644`/`0o755`.
- `set.ts`: sha256 of `tasks.jsonl` and `grades.jsonl` checked against the manifest; every set-relative path
  refused if absolute, drive-lettered, containing `..`, or resolving outside the set; `manifest.name` restricted to
  one plain path part (it becomes a folder name). Symlinks inside a set are followed (lexical check), which only
  the set's author can place.
- `inputs.py`: input paths must be absolute files; repository listing through git with the hardened args; the
  test hint is a string for the model, run only through `shell()` with approval.
- `mentions.ts`: `@path` resolves against the cwd and must be a regular file; the repo task rewrites mentions so
  the worker's `/tmp` and `/work/repo` aliases cannot redirect the model; the `@` menu's git call sets
  `core.fsmonitor=false` with a 2 s timeout.
- `service._run_spec`: every `run.start` field type- and enum-checked; the batch name limited to `[A-Za-z0-9._-]+`
  not starting with `.` before it becomes a folder (`runlog.log_path`).

Tuner (from the delegated review, re-read)
- Candidate file paths: anchored regexes for `skills/<name>/SKILL.md`, `scripts/<name>.py` and, gated,
  `agents/…`; `\`, absolute, drive, `..`, `.` and empty parts refused; `profile.toml`, `guidance.md` and
  `system.md` only through their own channels; TOML values JSON-quoted so a value cannot open a new table.
- FROZEN parts enforced engine-side by `check_tunable` on effective values, `training-v4` refused as a base,
  `system` only on the `rlmh-1` contract; `profile.check` compiles scripts without running them.
- Worktrees: created from a snapshot through a temporary index, hooks and filters neutralised, `GIT_DIR`-style
  variables stripped, copy mode never follows links, `git apply` under `GIT_CEILING_DIRECTORIES`.
- No model text reaches an argv or a shell; `tune.test` is the user's own command, split without a shell.
- Spend: `tune.enabled` can only become true through `/tune on`; `tune.max_usd` is a live cap via `CostCap`,
  with in-flight calls able to overshoot by one call (documented behaviour).

Install, release and CI: listed under SR-9 to SR-11 above.

## 5. Open questions

1. **SR-7, the real decision.** Is the OS sandbox from the architecture doc on the roadmap? If not, the
   permission-mode text in `README.md`, `/permissions` and `documentation/legacy/architecture.md` should say that
   `default` and `accept-edits` bind a cooperative model only. Which do you want?
2. **SR-2's prompt wording.** A `.git` write now reads "outside the workspace". Keep that, or add an `in .git`
   label to `Approval.tsx` (a wire change: `approval.request` would need a reason field, so `examples.json` and
   both suites)?
3. **SR-8.** Show the full URL in `fetch` prompts, and only remember a host on "for the rest of this run"? Both
   are D-47 changes.
4. **SR-13.** Should a tune ever activate a profile with changed `scripts/` without a yes?
5. **Windows `taskkill` (SR-1 residual).** Resolve it at `configure()` too; untested here. Want it in?
6. **Release signing (SR-9).** Attestation or a signature key? Either changes `release.yml`, the installers and
   `update.ts`, which were read-only in this review.
7. **Branch.** This work is on the local branch `security-review`, as you asked, not on the session's designated
   `claude/hopeful-heisenberg-l4j7a1`, and nothing was pushed. Say which branch should carry it.
8. **`verify.sh` could not run offline** (no `zizmor` or `pytest` wheel in uv's cache). Run the full gate on
   your PC before merging: `scripts\verify.ps1`, then `bun run typecheck` in `app/`, which this review could not.
9. **Scratch-folder objects.** The engine's snapshot tree lives in `<scratch>/git-objects`, which the model may
   write freely (D-12). Whether git verifies a loose object's hash on read decides whether a model can alter the
   final diff the user reviews. Not tested here; worth a five-minute check on your PC.
