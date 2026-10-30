# Step 4. Native REPL worker, tools and permissions

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 3 (and through it 2) |
| **Unblocks** | 6 |
| **Parallel with** | 5 |
| **Decisions it uses** | 3a: keep `/work/repo`, the tools map it. 4a: Git Bash, else PowerShell. 4b: default mode is `accept-edits` (S-27). S-04, S-09, S-13, S-18. D-01, D-06, D-12 to D-17, D-29, D-35, D-37, D-42, D-47, D-48 |

## Goal

The engine can run cells in a native Python worker on macOS, Windows and Linux. The worker has the training tools plus `fetch`, a bridge that enforces the sub-call budget, and audit hooks that turn writes, shell commands and network use into approval requests under the three permission modes. This replaces the Docker sandbox, so it must be as solid on Windows as it was in WSL before step 6 wires a whole run.

## Read first

- [../architecture.md](../architecture.md) §5.2, §5.3 (`run.subcall`, `run.permission`, `run.budget`), §5.4, §6.1 (the worker protocol), §7.7, §12.
- [../decisions.md](../decisions.md): D-01, D-06, D-12 to D-17, D-29, D-35, D-37, and S-25 to S-27 (3a, 4a, 4b).
- [../../legacy/v0-design.md](../../legacy/v0-design.md) § REPL worker and tools, § Permissions, § Tests. [../../legacy/v0-build-plan.md](../../legacy/v0-build-plan.md) § Step 4.
- Training, all at `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/<file>`:
  - `repl_worker.py`: `_Capped`, `_FdCapture`, `_format_error`, `run_cell`, `llm`, `llm_batch`, `submit`, `normalize_answer`, `_bridge_seconds`, `cell_seconds_left`, `repl_main`.
  - `repl_tools.py`: all of it. `TOOLS_VERSION = "t1"`.
  - `sandbox.py`: `Sandbox.run_cell`, `_wait`, `_parse`, `_recover`, `_restart`, `_launch`, `CellResult`.
  - `bridge.py`: class `EpisodeBridge` (`_handle`, `_one`). `editbox.py`: `fingerprint`, `CACHE_DIRS`, `CACHE_SUFFIXES`.
  - `tests/test_repl_tools.py` (port it) and `tests/test_sandbox.py` (case ideas: `FailureTest`, `ReplTest`).
- Step 3's `contract.py`: `Limits`, `CellMessages`, `cell_messages`, `oversize_message`, `budget_exhausted_message`, `truncate_prompt`, `clean_text`, `valid_answer`, `OUTPUT_MAX_CHARS`, `TRACEBACK_LINES`, `SUBMIT_MAX_BYTES`, `SUBCALL_TRUNCATION_MARK`. Step 2's `errors.InfraError(kind, message)`. `profiles.Profile.mode(mode).limits`, `.sub_temperature`.

## Starting state

- Steps 2 and 3 are `done`; `uv run --project engine pytest engine/tests` passes. `errors.py` (`InfraError`, `SubcallError`, `ModelError`), `appport.py` (`AppPort`) and CI on three OSes exist.
- `engine/rlm_engine/worker/` and `workspace.py`, `permissions.py`, `bridge.py` do not exist. Python is 3.12 through uv. Standard library only at run time.
- Rishi's PC: Git for Windows lives at `F:\Personal\Git` (not Program Files), `C:\Windows\System32\bash.exe` is the WSL launcher, and `git`'s `cmd\` folder is on PATH. `find_shell` must work from that.

## Deliverables

Every module opens with a docstring naming its training source and `0b9af69` (§12) and a cache note. `workspace`, `permissions`, `hooks`, `manager`, `bridge`: `KV cache: none`. `worker.py` and `tools.py`: what they return becomes the next observation, so the note says their output text is frozen to training's. No module-level run state anywhere: a run's `Worker`, `Bridge` and `Permissions` are instances (D-35).

### `engine/rlm_engine/workspace.py`

- `ShellSpec`, `find_shell()` as §7.7. POSIX: `ShellSpec("sh", "sh", ["sh","-c"])`. Windows: Git Bash `ShellSpec("bash", "Git Bash", [bash, "-c"])`, else `ShellSpec("powershell", "PowerShell", [powershell, "-NoLogo","-NoProfile","-NonInteractive","-Command"])`.
- **Finding Git Bash.** Take `shutil.which("git")`, and for each of its first three ancestor folders try `bin\bash.exe`, then `usr\bin\bash.exe`. Then try `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LocalAppData%\Programs`, each plus `Git\bin\bash.exe`. Never plain `which("bash")`: reject any path under `System32` or `WindowsApps` (the WSL launcher, S-04). Keyword-only `which=`, `env=`, `platform=` let tests fake all of this.
- `snapshot(repo, scratch) -> str | None`, `diff(repo, base_tree, scratch) -> str` and `fingerprint(repo)` (copy of `editbox.fingerprint` with `CACHE_DIRS` and `CACHE_SUFFIXES`).
- **Snapshot and diff (one recipe, shared with `tools.diff`).** Git args on every call: `-c safe.directory=* -c core.quotepath=off -c core.fsmonitor=false -c core.safecrlf=false`.
  - `snapshot` returns `None` when `git rev-parse --absolute-git-dir` fails, `git` is missing, or the folder is not in a work tree.
  - Otherwise it copies `<git-dir>/index` (if present) to `<scratch>/git-index-<random>`, then runs `git add -A -- .` and `git write-tree` with env `GIT_INDEX_FILE=<that copy>`, `GIT_OBJECT_DIRECTORY=<scratch>/git-objects` and `GIT_ALTERNATE_OBJECT_DIRECTORIES=<the repo's objects folder, from git rev-parse --git-path objects, made absolute>`. New blobs land in scratch, so the repo's index, refs and object store are never written.
  - `diff` does the same `add` into a fresh temp index, then `git diff --cached --relative --no-color --no-ext-diff <base_tree> -- .`.
  - `<scratch>` must live for the whole run, because `base_tree` exists only in `<scratch>/git-objects`.

### `engine/rlm_engine/permissions.py`

- `MODES`, `Permissions` as §7.7, plus `self.repo_mode` (stored; no v0 rule depends on it, because read mode's workspace is the scratch folder).
- `decide(kind, detail, inside_workspace)` is pure and reads only the remembered set:

| Action | `default` | `accept-edits` | `bypass` |
|---|---|---|---|
| write inside the workspace | ask | allow | allow |
| write outside it | ask | ask | allow |
| shell | ask | ask | allow |
| network | ask | ask | allow |

  A write whose detail path is under `scratch` is always `allow` (D-12). "For the rest of this run" answers are remembered as keys (D-14):
  - `("write", inside_workspace)`, so allowing a write inside never allows one outside;
  - `("shell",)`;
  - `("network", host)`, with the host from `urlsplit("//" + detail).hostname`.
  A `network` request whose detail is a bare host (it came from `fetch`, D-47) is also remembered after a plain allow, so only the first fetch to each host asks.
- `check(...)` holds an `asyncio.Lock`, so one prompt shows at a time and a second waiting cell sees the first answer. In order:
  1. A scratch write returns `True` with no entry and no event.
  2. `allow` returns `True`.
  3. `ask` with `interactive=False` returns `False` and never calls the app (D-15).
  4. Otherwise `app.approve({run_id, kind, detail, turn, inside_workspace})`. A reply with `remember_for_run` stores the key above. Any exception from `approve` except `CancelledError` counts as a denial.
- `log` entries have exactly the six keys of `run.permission`: `turn, kind, detail, allowed, asked, remembered` (D-48). `remembered` means "allowed from an earlier answer, not asked". Each entry is also sent with `app.event("run.permission", {"run_id": …, **entry})`. After 200 entries, decisions still apply but are neither stored nor sent (`self.dropped` counts them).

### `engine/rlm_engine/bridge.py`

- `SubcallRecord`, `Bridge` as §7.7. Limits come from `profile.mode(mode).limits`; `max_subcalls` from there. The loop sets `bridge.turn` before each cell.
- `handle(request)` returns the `reply` fields, or **raises `InfraError`** after setting `infra_error` and `infra_kind` (the manager turns that into a killed worker and a raised `InfraError` from `run_cell`). Ops and their errors are training's `_handle`, strings unchanged: `malformed request`, `unknown request`, `prompts must be a list of strings`, `llm takes exactly one prompt`.
- **`llm`, `llm_batch`.** Checks in training's order: budget (`contract.budget_exhausted_message`), then oversize when `subcall_oversize == "error"` (`contract.oversize_message`). A refusal sends one `run.subcall` with `status "rejected"`, `subcall_id null`, `prompt_chars` = the longest prompt, and replies `{"error": …}`. Otherwise allocate in one synchronous step (no `await`, so threads in a cell can't oversubscribe): `subcalls_used += n`, ids `subcalls_used+1…`, batch id `b<k>` from a per-run counter (`llm` is a batch of one, D-24). An empty `llm_batch([])` replies `{"outputs": []}` and uses nothing.
- **Each sub-call.** Truncate mode: `contract.truncate_prompt(contract.clean_text(prompt), subcall_max_chars)` (idempotent with the worker's cut). Send `run.subcall` `sent`, then `app.complete` with §5.2's sub-call params: `messages [{"role":"user","content":prompt}]`, `tools []`, `max_tokens = subcall_max_tokens`, `temperature = profile.sub_temperature`, `thinking` = ref's value, else `limits.subcall_thinking`, else `"off"` (D-08), `turn = self.turn`, `subcall_id`, `origin {turn, line}`, `batch {id, index, size}`. Then `done` or `error`, a `SubcallRecord` (with `usage`), and after the batch `run.budget {turns_left: max(0, max_turns − turn), subcalls_left}`.
- **Errors (D-06).** `ModelError.kind == "bad_request"` becomes `SubcallError`, so the cell gets `RuntimeError("sub-call failed: <message>")` and the run goes on. Any other `ModelError`, any other exception, or a non-`str` text is infra: `infra_kind` = the `ModelError` kind, `"cancelled"` for a cancelled call, else `"other"`. If a batch has both, infra wins; otherwise the first `SubcallError` in prompt order is the reply.
- **`fetch`** (D-16): `urllib.request` in `asyncio.to_thread`, GET, 30 s timeout, `Accept-Encoding: identity`, text decoded with the charset (else UTF-8, `errors="replace"`), cut to 200,000 characters plus `"\n[truncated at 200,000 characters]"`. Up to 5 redirects, **same host only**: a redirect elsewhere fails with `fetch failed: redirected to another host (<host>); call fetch on that URL to allow it`. Only `http`/`https`. Errors reply `fetch failed: HTTP 404 Not Found`, `fetch failed: timed out after 30 s`, `fetch failed: <reason>`. Each call appends `{url, status, chars, error, seconds}` to `fetches`. It does not touch the budget.
- **`approve`**: `{"allow": await permissions.check(kind, detail, inside_workspace=…, turn=self.turn)}`. The engine does not ask for `fetch` itself: `tools.fetch` sends `approve` first (below), so there is one prompt.

### `engine/rlm_engine/worker/manager.py`

- `CellResult`, `RequestHandler`, `Worker` as §7.7. Private constants: `START_ATTEMPTS = 2`, `STARTUP_TIMEOUT_S = 60`, `RESULT_LINE_LIMIT = 4 MiB`, `STDERR_KEEP = 4000`. `_parse` slices stdout to `contract.OUTPUT_MAX_CHARS` and the error to twice that, as training did (the loop applies the profile's own cut later).
- **Process.** `subprocess.Popen([python, "-I", "-B", "-X", "utf8", <worker.py>], cwd=workspace, env=…)` with three pipes. `-X utf8` is added to D-01's command so `open()` in a cell defaults to UTF-8 on Windows (`-I` ignores `PYTHONUTF8`). POSIX: `start_new_session=True`. Windows: `creationflags=CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`. Env: the engine's, minus names matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH` (any case), plus `TMPDIR`, `TEMP`, `TMP` = scratch (D-29).
- **I/O.** Reader threads, not asyncio subprocess (D-30's reason, and it behaves alike on every event loop): one reads stdout lines (drop and log any over `RESULT_LINE_LIMIT`), parses JSON and calls `loop.call_soon_threadsafe(self._on_message, msg_or_None)`; one copies stderr to the engine's stderr as `[worker] …` and keeps the last 50 lines. Writes are `json.dumps(obj)` plus `\n` (ASCII), under a lock, through `asyncio.to_thread`.
- **`_on_message`** (on the loop): `request` starts a task that counts as in flight, awaits `on_request`, writes the `reply` (`{"type":"reply","id":…,**fields}`); `vars` resolves a future by id; `ready` and `result` go to an events queue; `None` (EOF) goes there too. The handler's `InfraError` (or any unexpected exception, kind `"internal"`) is stored, an error reply unblocks the worker, and `run_cell` wakes at once.
- **Time.** `blocked` = wall time with at least one request in flight (training's `blocked_seconds`); `compute = wall − blocked`.
- **`start()`**: spawn, send `init` (`mode, context, workspace, scratch, base_tree, cell_timeout_s, subcall_max_chars, subcall_oversize, shell: {kind, argv}, repo_alias: "/work/repo"`), wait for `ready`. Two attempts, then `InfraError("worker", "worker failed to start (2 attempts): <last stderr lines>")`. In repo mode `ready.tools` must be `"t1"`. Repo mode takes its first `fingerprint` here.
- **`run_cell`**: a line-for-line port of `Sandbox.run_cell`, `_wait`, `_parse`, `_recover`, `_restart`. Deltas from Docker:
  - No supervisor, so the death reason comes from `proc.poll()`: `"exit code N"`, or on POSIX a negative code gives `"killed by SIGKILL"`. An unparseable `result` gives `"it returned an unreadable result"` (`crash="unreadable result"`). A death found before the cell is sent (EOF, or `poll()` set) adds `messages.not_run`. No OOM or tamper cases.
  - Timeout: kill the tree, restart, return `CellResult("", 0, messages.timeout, restarted=True, crash="timeout", …)`. Wall cap: kill, raise `InfraError("worker", "a cell waited over N s on requests")`. The cap is `wall_cap_s`, plus `limits.cell_timeout_s` in repo mode as in training's edit sandbox, so step 6 need not pass it.
  - A `result` whose `id` is not the current cell's is ignored. `clean_text` and the slices follow `_parse`.
  - Repo mode: after every cell, restarts included, `repo_changed = fingerprint != previous` (run in `asyncio.to_thread`).
- **`vars()`** sends `vars`, waits up to 10 s, returns `[]` when the worker is gone. **`close()`** kills the tree, cancels request tasks, joins the threads for 2 s, and is safe twice.
- **Kill tree.** POSIX: `os.killpg(proc.pid, SIGKILL)`. Windows: `taskkill /T /F /PID <pid>` (output discarded), then `proc.kill()`. Counters `timeouts`, `crashes`, `restarts`, `start_retries`; `turn` is set by the loop (`bridge.turn = worker.turn = turn`) and only read here.

### `engine/rlm_engine/worker/worker.py`

Runs as `__main__`. Copy `repl_worker.py`, keeping what the step notes say and dropping the supervisor, Landlock, Docker paths, Unix socket, edit-metrics logging, `_ImportWatch` and the ctypes and gc blocks. No `from __future__ import annotations` (the model can `help(llm)`, and signatures must read as in training).

- **Start.** Put its own folder on `sys.path` for the imports of `hooks` and `tools`, then remove it (D-01). `proto_in = os.fdopen(os.dup(0), "rb")`, `proto_out = os.dup(1)`, `diag = os.dup(2)`; Windows: `msvcrt.setmode(fd, os.O_BINARY)` on the dups. Point fd 0, 1, 2 at `os.devnull`. `sys.stdin = io.StringIO()`. Diagnostics go to `diag`.
- **Reader thread** (`hooks.exempt_thread()` first). Reads lines: `reply` wakes the waiting thread by id; `vars` is answered right there from `list(namespace.items())` (user globals only: not `context, llm, llm_batch, submit, fetch`, the tools, or names starting `_`; `{name, type, len, chars}` with `chars = min(len(repr(v)), 10**6)`); `init` and `cell` go to a queue for the main thread; EOF wakes every waiter with `RuntimeError("the engine closed the connection")` and ends the process with `os._exit(0)`.
- **`_request(op, **fields)`**: next request id, `line` from the innermost `<repl>` frame on the calling thread (`sys._getframe`; `None` if none), write under a send lock, wait, return the reply or raise `RuntimeError(reply["error"])`. Wait time feeds `_bridge_seconds()` as in training, for every op, so `cell_seconds_left()` leaves approvals and fetches out. `_approve(kind, detail, inside)` sends `approve` and raises `PermissionError(13, "Permission denied (not approved)", detail)` when `allow` is false.
- **`init`**: `os.chdir(workspace)`; `tools.configure(root=workspace, base=base_tree, time_left=cell_seconds_left, scratch=scratch, shell=shell, alias=repo_alias, approve=_approve, remote_fetch=…)` in both modes; namespace `context, llm, llm_batch, submit, fetch` (+ the seven tools in repo mode); `hooks.install(...)`; set the sub-call limits; send `ready {python, tools: "t1" in repo mode else null}`.
- **Cells** (main thread). `run_cell` as training with `_FdCapture` always on, and `threads = active_count() − 2`. The cell's `<repl>` traceback is cut by `_format_error` (last `TRACEBACK_LINES = 6` lines, first frame dropped). **Known parity risk:** an error raised inside `llm` or a tool shows native file paths and line numbers, where training showed `/opt/rlm/repl_worker.py`. Do not fake them; step 8 reports it.
- Worker-side oversize: `_truncate` raises `ValueError` with text equal to `contract.oversize_message`, or cuts, per `init`.

### `engine/rlm_engine/worker/hooks.py`

`install(*, approve, workspace, scratch, tools)`, `exempt_thread()`. Standard library only. One `sys.addaudithook` function: a dict lookup by event name, then a handler. Reads never ask.

| Events | Kind | Detail |
|---|---|---|
| `open` with an `os.O_WRONLY/O_RDWR/O_APPEND/O_CREAT/O_TRUNC` flag or mode containing `w a x +`; `os.mkdir`, `os.remove`, `os.rmdir`, `os.truncate`, `os.chmod`, `os.chown`, `os.utime`, `os.setxattr`, `os.removexattr`, `os.rename` (both paths), `os.link` and `os.symlink` (the new path) | write | absolute path with `/`; a rename is `src -> dst`. Integer fds and `os.devnull` are ignored |
| `subprocess.Popen`, `os.system`, `os.exec`, `os.spawn`, `os.posix_spawn`, `os.startfile`, `_winapi.CreateProcess` | shell | the argv joined (`subprocess.list2cmdline` on Windows, `shlex.join` elsewhere), the string for `os.system`, the path for `startfile` |
| `socket.connect` | network | `host:port` (`[v6]:port`), or the path for a Unix socket |

- **`inside_workspace`**: `os.path.normcase(os.path.realpath(p))` under the same for the workspace (realpath also turns Windows 8.3 names like `RUNNER~1` into long ones). For shell it is `True` (the cwd is the workspace); for network `False`.
- **Never asks:** a write under `scratch` (D-12); any event while `tools.quiet()` is true on this thread (git reads in `find_files`, `grep`, `diff`; the `Popen` inside `shell()` after its own ask; `taskkill`) (D-13); the `_winapi.CreateProcess` or `os.posix_spawn` that follows an approved `Popen` on the same thread (a one-shot thread-local flag, so one `subprocess.run` is one prompt); a `connect` whose caller frames within three levels are `socketpair` in `socket.py` (on Windows `asyncio.run` makes a loopback socketpair).
- **No recursion.** A thread-local `busy` flag is set while a handler runs, and the hook returns at once when it is set, so anything the handler itself triggers (the request write, JSON, a lazy import) is ignored. `exempt_thread()` sets `busy` for good on the worker's own threads (reader, `_FdCapture` pump).
- A denial is the `PermissionError` that `approve` raises; it propagates out of the audited call into the cell.

### `engine/rlm_engine/worker/tools.py`

Copy `repl_tools.py`: seven tools, names, signatures, docstrings, `TOOLS_VERSION = "t1"`, `ShellResult`, `namespace()`, `active()`, `on_call` all unchanged. No `from __future__ import annotations`. Changes, each required:

1. `configure(root, base, time_left, on_call, *, scratch=None, shell=None, alias="/work/repo", approve=None, remote_fetch=None)`. `base` is a tree sha.
2. `_abs(path)`: if `path == alias` or starts with `alias + "/"`, replace that prefix with `root` (so `/work/repository/x` is not mapped); then `normpath(join(root, path))`. `alias=None` turns the mapping off. Known gap (3a): a `shell()` command that spells out `/work/repo` is not rewritten.
3. Paths shown and compared use `/` (D-17): `_show` returns `rel.replace(os.sep, "/")` (and the absolute path with `/` outside the root; a `ValueError` from `relpath` across drives is caught); `find_files` and `grep` match globs against `/` paths; `_files_under` normalises git's paths and **sorts by the `/` form**, so order is the same on every OS.
4. `_git` also sets `GIT_TERMINAL_PROMPT=0`, `-c core.fsmonitor=false`, stdin `DEVNULL`, Windows `CREATE_NO_WINDOW`, and runs inside `_quiet()` (a thread-local counter that `quiet()` reads).
5. `shell(cmd, timeout)`: first `approve("shell", cmd, True)` (D-13; skipped when `approve` is None), then `Popen([*shell.argv, cmd], …)` inside `_quiet()`. PowerShell gets `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ` prefixed. POSIX keeps `start_new_session=True` and `os.killpg`; Windows uses `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` and `taskkill /T /F /PID`. The docstring still says `sh -c` (frozen text).
6. `diff()`: needs `base` and `scratch`; with no `base` raises `RuntimeError("diff() is unavailable because the workspace is not a git repository")`. Same recipe as `workspace.diff`, temp files in a `tempfile.mkdtemp(dir=scratch)` that is removed afterwards.
7. New `fetch(url: str) -> str` (not in `namespace()` or `TOOL_NAMES`): reject non-http(s) with `ValueError("fetch takes an http:// or https:// URL")`; `approve("network", <host>, False)`; then `remote_fetch(url)`; with neither configured, `RuntimeError("fetch is not available here")`. Docstring: "Fetch a web page with a GET request and return its text (at most 200,000 characters). Asks for approval the first time for each site."
8. Everything else, including limits, messages and order of operations, is byte-for-byte training.

## Tasks

1. [ ] Set row 4 to `in progress` in progress.md. Run `uv run --project engine pytest engine/tests -q`; it must pass. Create `engine/rlm_engine/worker/__init__.py` (empty) and `engine/tests/conftest.py` fixtures (git fixture repo, `StubApp`) without touching step 2's.
2. [ ] `workspace.py` and `test_workspace.py`. Copy the training files in Git Bash, not PowerShell 5.1 (its `>` writes UTF-16): `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/repl_tools.py > engine/rlm_engine/worker/tools.py`.
3. [ ] `tools.py` with the eight changes above; port `tests/test_repl_tools.py` into `test_tools.py`, replacing `python3 -c` with `sys.executable` and `sh` commands with the per-shell table in the test.
4. [ ] `hooks.py`, then `worker.py` (copy `repl_worker.py`, delete the dropped parts, add the reader thread, `_request`, `init`). Run it by hand: `python -I -B -X utf8 engine/rlm_engine/worker/worker.py`, paste `{"type":"init",…}` then `{"type":"cell","id":1,"code":"print(1)"}`.
5. [ ] `manager.py` and `test_worker.py`. Get the POSIX cases green first, then the Windows list below.
6. [ ] `permissions.py`, `bridge.py`, their tests, and the hand-check driver (`__main__` of `test_permissions.py`, see Done when).
7. [ ] **Windows pass.** Confirm each on Rishi's PC, as a test in `test_worker` or `test_permissions` so CI repeats it:
   - a child process's output reaches the cell (`subprocess.run([sys.executable, "-c", "print('c')"])` shows `c`). If the CRT `dup2` does not reach the Win32 std handles, call `ctypes.windll.kernel32.SetStdHandle` for stdout and stderr in `_FdCapture` after each `dup2`.
   - `asyncio.run(asyncio.sleep(0))` raises no approval, and one `subprocess.run` is one prompt.
   - the timeout kills a grandchild process.
   - a path under an 8.3 or differently cased folder still counts as inside the workspace.
   - Git Bash `shell("ls")` and `shell("echo a | tr a b")` work from `bash.exe -c`. If PATH lacks the MSYS tools, switch the argv to `[bash, "-l", "-c"]` with `CHERE_INVOKING=1` in the shell's env.
   - `open(p, "w").write("é")` in a cell writes UTF-8.
8. [ ] Run all five test files plus the older ones. Write the progress.md row and log line (Hand-off). Do not commit or push without Rishi's say-so.

## Tests

All offline. Real workers are spawned with `sys.executable`; timeouts use `cell_timeout_s=1`. Tests needing git are skipped when `git` is missing.

- **`test_workspace.py`**
  - `find_shell`: POSIX gives `sh`. Windows, with faked `which` and `env`: found through `git.exe`'s ancestors (`cmd\`, `mingw64\bin\`), through Program Files, System32 and WindowsApps `bash.exe` rejected, none found gives PowerShell.
  - `snapshot`: a 40-hex sha; `None` outside git, with git missing, and for a non-work-tree; the repo's `git status --porcelain`, `git count-objects -v` and `.git/index` mtime are unchanged; untracked files in, ignored files out; works in a subfolder of a repo.
  - `diff`: shows modified, new and deleted files, equals `tools.diff()` on the same tree, survives `core.autocrlf=true`.
  - `fingerprint` changes on an edit or a new file and ignores `.git`, `__pycache__`, `*.pyc`, `node_modules`.
- **`test_tools.py`**
  - Training's cases, ported. Frozen API: names, signatures (the `ShellResult` module prefix stripped by regex), and the docstring fingerprint `b395ecf9f9bdb162`. The unstripped training value `816344133c226653` reproduces from the `0b9af69` source, so the pin is honest. No import of `rlm_rl`.
  - `/work/repo` mapping through `read_file`, `find_files(path="/work/repo")`, `write_file`, `edit_file`; `/work/repository/x` unmapped; `alias=None` turns it off; shown paths are relative and `/`-separated; `find_files` order for `a-b/x`, `a/x`, `a0/x` is the POSIX order on every OS.
  - `shell`: exit code, merged output, cwd is the root, timeout kills the group and keeps output, `time_left` caps it, `approve` is called once with `("shell", cmd, True)`, a denial raises before anything runs (a marker file is absent), the PowerShell spec works on Windows. Commands per shell live in a table in the test.
  - `diff`: edits and new files, the repo's own index untouched, `.git` gains no files, a commit does not hide the change, the exact `RuntimeError` text outside git.
  - `fetch`: scheme check, `approve("network", host, False)`, a denial skips `remote_fetch`, the unconfigured error. `on_call` and `active()`.
- **`test_worker.py`**
  - Globals persist; `context` arrives exactly (CRLF, non-ASCII, no final newline); truncation (`stdout_chars` counts everything); the traceback has no `worker.py` frame and at most 6 lines; `submit` types and the over-size `ValueError`.
  - Link safety: writes to fd 1 and 2, `os.close(1)`, `input()` and `sys.stdin.read()` can't break the link or hang. A child's output and `os.system` output are captured. `sys.stderr` text goes to `stderr` only.
  - Failures: a timeout restarts with `messages.timeout`, loses variables, kills a child process and sets the counters; time blocked in `on_request` does not count; `os._exit(7)` gives `exit code 7`; SIGKILL gives `killed by SIGKILL` (POSIX only); a thread that exits the worker between cells gives the crash text plus `not_run`, and the next cell works; `_parse` rejects bad results; the wall cap raises `InfraError`; a bad python path and a worker that exits at once raise `InfraError` after 2 attempts with stderr in the message; an `InfraError` from `on_request` kills the worker and is raised by `run_cell`.
  - `vars()` mid-cell lists user globals only; `line` is the `<repl>` line (same cell, inside a function, in a thread); key-like env vars are gone and `tempfile.gettempdir()` is the scratch folder; UTF-8 `open`; `repo_changed` true then false, `None` in read mode; `close()` twice; worker constants equal `contract`'s (`OUTPUT_MAX_CHARS`, `TRACEBACK_LINES`, `SUBMIT_MAX_BYTES`, `SUBCALL_TRUNCATION_MARK`, the oversize text).
- **`test_permissions.py`**
  - `decide` for all 3 modes x write-in, write-out, shell, network, scratch.
  - `check`: params sent exactly; remember per kind, per side of the workspace for writes (an inside "allow for the run" still asks for an outside write) and per host; a plain allow on a fetch host is not asked again; deny; non-interactive never calls the app; bypass; scratch silent; the 200 cap; events; concurrent checks prompt once; an `approve` exception denies.
  - End to end with a real worker, per mode: write outside, write inside (repo mode), scratch write via `tempfile`, reads, `shell`, `subprocess.run` (one ask), `os.system`, `os.startfile` (Windows, denied), raw `socket.create_connection` (ask, and no connection after a denial), `asyncio.run` (no ask), `find_files`/`grep`/`diff` (no ask), the `inside_workspace` flags.
  - `fetch` to a local `http.server`: one ask per host (`localhost` and `127.0.0.1` differ), and after a denial the server saw no request.
  - A denial prints `[Errno 13] Permission denied (not approved)` and the next cell still works; a non-interactive run denies; no recursion (one `open` is one ask).
- **`test_bridge.py`**
  - A private `StubApp`; do not depend on step 6's `FakeApp` features.
  - Ids `1…n` and batch ids `b1…`; `llm` is a batch of one; exact `model.complete` params (`training-v4` repo mode gives thinking `"low"`, a ref's own value wins, read mode `"off"`); events `sent` then `done`, then `run.budget`; answers in prompt order despite completion order.
  - Budget refusal (reply text, one `rejected` event, no call, counter unchanged); oversize in `error` and `truncate` modes; D-06 both branches and the mixed batch; non-`str` text; a cancelled call; an empty batch; malformed requests; `approve` delegates.
  - `fetch` against a local server: 200, the cap and its note, 404, a chain of 5 redirects and a 6th, a cross-host redirect refused, `ftp://`, a timeout (patch the constant), the `fetches` records.

## Done when

1. `uv run --project engine pytest engine/tests -q` passes on Rishi's Windows PC, and after Rishi allows a push, in the macOS, Windows and Ubuntu CI jobs. `test_worker`, `test_tools` and `test_permissions` are the ones that must be green on all three.
2. In Git Bash, `grep -rnE "^(from|import) (rlm_rl|anthropic|openai|requests)" engine/rlm_engine` and `grep -n "from __future__" engine/rlm_engine/worker/worker.py engine/rlm_engine/worker/tools.py` both print nothing.
3. **By hand on the PC**, before the app exists. `engine/tests/test_permissions.py` has a `__main__` driver that builds a real `Worker`, `Bridge` and `Permissions` with a `PrintApp` (an `AppPort` that prints each `approval.request` and reads `y`, `a` (for the run) or `n` from the keyboard), then runs each `--cell`, printing `error`, `stdout` and the permission log. In one terminal run `python -m http.server 8123`. In another, from `rlm-harness`:

```
uv run --project engine python engine/tests/test_permissions.py --mode default --repo . --cell "open(r'C:\Users\Public\rlmh-x.txt','w').write('x')" --cell "print(shell('dir'))" --cell "print(fetch('http://127.0.0.1:8123/')[:60])" --cell "print(write_file('rlmh-handcheck.txt','x'))"
```

   Run it for `--mode default`, `accept-edits` and `bypass`, twice each: answer `n` to every prompt (each asked cell ends in `PermissionError`), then `y` (the action happens). Expected (`ask` = a request is printed):

| Cell | `default` | `accept-edits` | `bypass` |
|---|---|---|---|
| write outside the workspace | ask | ask | none |
| `write_file` inside `--repo` | ask | none | none |
| `shell("dir")` | ask, detail `dir` | ask | none |
| `fetch(...)` | ask, detail `127.0.0.1` | ask | none |

   Without `--repo` the driver runs read mode in a temp scratch folder: writes there never ask. Afterwards stop the server and delete `rlmh-handcheck.txt` and `C:\Users\Public\rlmh-x.txt`.

## Out of scope

- The loop, `RunSpec`, calling `workspace.snapshot`, creating and deleting the scratch folder, and setting `bridge.turn`: step 6.
- The approval screen and terminal prompt: steps 6 and 7. The gateway and `model.complete`: step 5.
- Replaying training episodes and reporting traceback differences: step 8.
- An OS sandbox, memory or CPU limits, `ctypes` and `gc` blocking, and approvals for `socket.bind`, `sendto` and DNS (v0-design lists only `connect`).
- The `default` profile's guidance text (D-32): step 3.

## Hand-off

Step 6 can rely on:

- `Worker(...)`: `run_cell` raises only `InfraError` (and `CancelledError`), and `bridge.infra_error` and `infra_kind` are set before it does. `Bridge.handle` is the `on_request`. `Permissions.log` is ready for the run log.
- `workspace.snapshot` and `diff`, `find_shell().name` for `system_prompt(shell_name)`. A restarted worker keeps `base_tree`, so `diff()` works after a crash. The scratch folder holds read-only git object files on Windows, so its deletion (step 6's `_rmtree`) must clear read-only bits.

progress.md: set row 4 to `review`. Log which Windows items in task 7 needed a fallback, and the traceback-path parity risk for step 8. (`-X utf8` is already D-42.)

## If a decision goes the other way

Every decision below was settled at step 1 (2026-10-30; [decisions.md](../decisions.md) S-22 to S-34). Each line names the pick and says what would change if Rishi reversed it. Picks that went the alternative way are already written into this spec.

- **3a, show the real path** (settled: keep `/work/repo`, S-25). Send `repo_alias: null`; `tools.configure(alias=None)`; drop the alias mapping tests; the `shell()` gap goes away. The prompt text and its hash are step 3's and step 8's to fix.
- **4a, always PowerShell** (settled: Git Bash, else PowerShell, S-26). `find_shell` returns the PowerShell spec on Windows and the Git Bash lookup and its tests go. **(Require Git Bash.)** `find_shell` raises `RuntimeError("Git Bash is required on Windows; install Git for Windows")`, `Worker.start` turns it into `InfraError("worker", …)`, and step 10 checks for it.
