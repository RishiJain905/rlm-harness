# Step 6. Loop, events and run log; `rlmh run` and `--json`

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 4, 5 (and through them 2, 3) |
| **Unblocks** | 7, 8, and through them 9 and 10 |
| **Parallel with** | none |
| **Decisions it uses** | 4b: `accept-edits` is the default permission mode (S-27). 6a: one-shot runs (settled as S-11). 6b: native `python` tool for API models, fenced text for `local` and `custom`. 2b: `~/.rlm-harness/`. Relies on S-11, D-06, D-07, D-08, D-10, D-11, D-12, D-15, D-17, D-26, D-27, D-28, D-31, D-35, D-38, D-39, D-40, D-49, D-50, D-51 |

## Goal

A whole run works end to end. `loop.run` plays training's `run_episode` against any model through the gateway, emits every §5.3 event and writes one complete run-log line. `rlmh run`, `rlmh batch` and `rlmh config` drive it from a terminal or a script, with `--json` for machines. It is the first step where something real happens, and its run log gives step 9 the token counts for its estimate.

## Read first

- [../architecture.md](../architecture.md) §5 (all of it; §5.4 fixes the order of one run), §6.2, §6.3, §7.2, §7.4, §7.5, §7.8, §9, §10, §11. [../decisions.md](../decisions.md) for the D-numbers above.
- [../../legacy/v0-design.md](../../legacy/v0-design.md) § Run log, § Failures, § Non-interactive. [../../legacy/v0-build-plan.md](../../legacy/v0-build-plan.md) § Step 6.
- `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/env.py`: `run_episode` (copy the turn loop), `_cap_output`, `_cell_dict`.
- Same commit: `transcripts.py` (`episode_record`, `TranscriptLog.append` and its torn-line reader), `tasks/editreal.py` (`_context`), `bridge.py` (`observation`, `pace_message`), `repl_tools.py` (`_files_under`, `FALLBACK_SKIP_DIRS`), `editdata.py` (`LANGS`, `detect_runner`).
- Code from steps 2 to 5, read in place: `engine/rlm_engine/{appport,errors,link,contract,callformat,profiles,workspace,bridge,permissions}.py`, `worker/manager.py`, `engine/tests/fakeapp.py`, `app/src/{link,engine,bus,settings,protocol}.ts`, `app/src/gateway/{gateway,fake,providers}.ts`.

## Starting state

- Steps 2 to 5 are `done`. `uv run --project engine pytest engine/tests` and `bun test` (in `app/`) pass.
- `service.py` has `Engine` with `engine.info`. `FakeApp` records events and approvals but has no `script=`. The fake provider reads `RLMH_FAKE_SCRIPT` (§7.5). `main.ts` dispatches `--version`, `info` and `--help` only.
- `Worker`, `Bridge`, `Permissions`, `workspace.{find_shell,snapshot,diff}`, `contract.*`, `callformat.*` and `profiles.load_profile` exist as in §7.6 and §7.7.

## Deliverables

**Engine.** Each module opens with its cache note (`KV cache: none` where none is given below), in the TypeScript files too. Copied code names `0b9af69` in its docstring.

- `engine/rlm_engine/inputs.py`. *KV cache: builds `context` and the first message's numbers once, before the first request.*
  - `class InputError(Exception)`. The service turns it into -32012.
  - `read_context(paths)`: D-10. Every path is absolute and a file. Read with `encoding="utf-8", errors="replace", newline=""` (CRLF and a BOM stay). Several files: `=== <path.as_posix()> ===\n<text>`, joined by `\n\n`.
  - `repo_files(repo) -> list[tuple[str, int]]`: `git -C <repo> ls-files -z --cached --others --exclude-standard`, real files only, sizes from `stat`, `/` separators, `contract.clean_text` on names, sorted. If git is missing or exits non-zero, walk the folder skipping a private copy of training's `FALLBACK_SKIP_DIRS`.
  - `repo_context(task, files)`: `f"{task}\n\nRepository files (path, size in bytes):\n{listing}\n"`, with `listing = "\n".join(f"{p}  {s:,}")` (training's `_context`).
  - `detect_language(files)`: most common known extension, ties by name, else `"unknown"`. Map: `.py` python, `.go` go, `.js .jsx .mjs .cjs` javascript, `.ts .tsx` typescript, `.rs` rust, `.java` java, `.rb` ruby, `.php` php, `.c .h` c, `.cc .cpp .hpp` c++, `.cs` c#, `.kt` kotlin, `.swift` swift.
  - `detect_test_hint(repo, files, language)`: first rule that matches wins, the one for the detected language tried first. `package.json` with a string `scripts.test`: `npm test`. Same file with vitest, jest or mocha in its dependencies: `npx <runner>`. `pytest.ini`, `pyproject.toml`, `setup.py`, `setup.cfg`, `tox.ini` or `conftest.py` at the root: `python -m pytest -q`. `go.mod`: `go test ./...`. `Cargo.toml`: `cargo test`. `pom.xml`: `mvn -o -q test`. `build.gradle[.kts]`: `./gradlew test --offline` if `gradlew` exists, else `gradle test --offline`. A `Makefile` with a `test:` line: `make test`. Otherwise `no test command found; look for one in the repository`.
  - `prepare(spec)`: fills only the `None` fields of a `RunSpec`: `context`, and in repo mode `language`, `n_files`, `test_hint`. Idempotent. Skips git work when the overrides cover everything (D-07). Imports `RunSpec` under `TYPE_CHECKING` to avoid a cycle.
- `engine/rlm_engine/runlog.py`. *KV cache: none.*
  - `FORMAT_VERSION = 1`. `RECORD_KEYS`: the §7.8 key list (the tests use it). `log_path(home, batch, log_dir)`: `log_dir/"runs.jsonl"` if given, else `home/"runs"/batch/"runs.jsonl"` (D-26). `batch` must match `[A-Za-z0-9._-]+` and not start with `.`, else `ValueError`.
  - `RunLog.append(record)`: `json.dumps(record, ensure_ascii=False, default=str)` plus `\n`, encoded as UTF-8 bytes, written with one `os.write` on a descriptor opened `O_WRONLY|O_APPEND|O_CREAT|getattr(os, "O_BINARY", 0)` (**Windows**: without `O_BINARY` the CRT turns `\n` into `\r\n`), then `os.fsync`. A module lock makes it safe across threads. If the file does not end in `\n` (a torn line from a crash), write `\n` first. NaN and infinities are written as the strings `"nan"`, `"inf"`, `"-inf"`, so the TS reader never meets invalid JSON.
  - `RunLog.records()`: parse line by line, skip any line that fails (count them in `torn_lines`), `[]` if the file is missing.
- `engine/rlm_engine/loop.py`. *KV cache: appends to one message list, never edits or reorders an earlier message, and the system prompt and tool list are fixed for the run.* `RunSpec` and `run` exactly as §7.8. Private: `_cap_output` (copied), `_shown` (the `run.cell.output` text), `_add_usage`, `_infra(kind, text)`, `_rmtree`, `_emit`.
- `engine/rlm_engine/service.py` (adds to `Engine`, next to `engine.info`): `run.start`, `run.cancel`, `run.vars` handlers, and a private `_Run(task, worker, gate)` registry `self._runs`. `self.worker_factory` defaults to `Worker`; tests replace it. Registers `self._cancel_all` with `link.on_close`.
- `engine/tests/fakeapp.py`: `FakeApp(script=...)`, `FakeApp.requests` (deep copies of every `model.complete` params, in order). Same script format as §7.5; also an optional `usage` object on an entry.

**App.**

- `app/src/session.ts`. *KV cache: none; it fills defaults and the engine writes the bytes.* `StartRun` and `Session` exactly as §7.8. Also exports `UsageError`, `thinkingOf(settings, role)` (`default` becomes `null`) and `buildRunParams(r, { settings, resolveCallFormat })` (pure; it builds the snake_case `run.start` params).
- `app/src/cli/print.ts`: `jsonLine(type, body)`, `attachJson(bus, out)`, `attachPlain(bus, out)`, each returning an unsubscribe function. `LineSink` is `{ write(chunk: string): void }`.
- `app/src/cli/run.ts`: `runCommand(argv, io): Promise<number>`, `createTtyApprover(io)`, and `CliIO = { stdout, stderr: LineSink; stdin: NodeJS.ReadableStream; isTTY: boolean; home: string }`.
- `app/src/cli/batch.ts`: `batchCommand(argv, io)`. `app/src/cli/config.ts`: `configCommand(argv, io)`.
- `app/src/main.ts`: adds `run`, `batch`, `config` to the dispatch and to `--help`.

## Tasks

1. [ ] **Fake app first.** Add `script=` to `FakeApp`:
   - Root replies are served in order. `{"text", "tool_call": {"code"}}` becomes a `ToolCall` `{id: "call_<n>", name: "python", arguments: {code}}` (D-39).
   - A sub-call takes the first rule whose `match` regex finds the prompt, else the rule without `match`. `errors` raises `ModelError` as `errors.py` defines it.
   - Usage is ⌈chars/4⌉ with zero cost, unless the entry carries `usage`. Past the end of the root list: `ModelError` kind `other`, `fake script exhausted`. Record every `complete` call in `requests`.
2. [ ] **`runlog.py`, then `inputs.py`**, each with its tests, as specified above.
3. [ ] **`loop.run`, set-up.** In this order:
   - `started_at = time.time()`; `inputs.prepare(spec)`; `limits = spec.profile.mode(spec.mode).limits`; `shell = workspace.find_shell()`.
   - `scratch = home/"scratch"/run_id`, created with `parents=True`. The workspace is `spec.repo_path` in repo mode and `scratch` in read mode (D-12). Repo mode: `base_tree = await asyncio.to_thread(workspace.snapshot, repo, scratch)` (`None` outside git).
   - `messages = [system, user]`. System is `profile.system_prompt(shell.name)`. User is `contract.first_user_message(question, context, limits)`, or in repo mode `contract.edit_first_message(task, language=, n_files=, test_hint=, limits=)`.
   - Build `Permissions` (`repo_mode = mode == "repo"`), then `Bridge`, then `worker_factory(mode=, context=, workspace=, scratch=, limits=, messages=contract.cell_messages(limits, edit=repo_mode), on_request=bridge.handle, shell=shell, base_tree=base_tree)`, then `await worker.start()`.
   - Emit `run.started`. Input numbers (§5.3): `chars = len(context)`, `lines = len(context.splitlines())`, `sha256` of `context.encode("utf-8", "replace")`, and `files` as the list of input paths with `/` separators in read mode, `[]` in repo mode.
4. [ ] **`loop.run`, the turn loop.** Training's `run_episode` minus the parts the build plan lists. For `index in range(limits.max_turns)`, with `turn = index + 1`:
   - Set `bridge.turn = worker.turn = turn`. Root call: `await app.complete({run_id, role: "root", model: spec.root, messages: list(messages), tools: callformat.tools_for(call_format), max_tokens: limits.root_max_tokens, temperature: profile.root_temperature, thinking: spec.root.get("thinking") or "off", turn})`.
   - `code = callformat.code_from_reply(...)`. Append `callformat.assistant_message(...)`. Emit `run.reply`; its `seconds` is the call's wall time and is also `root_s` in the log. Add the turn to the log's `turns` now, with empty cell fields, so a stop mid-cell still shows the reply.
   - Cell: no code gives `CellResult("", 0, contract.no_code_error())`, else `await worker.run_cell(code)`. Then `_cap_output(result, limits.output_max_chars)`: stdout cut to the cap, error to twice the cap. `edited |= bool(result.repo_changed)`.
   - If `bridge.infra_error` is set, emit `run.cell` with `observation = None` and stop. On a submit, record `submitted`, `answer`, `answer_valid`, emit `run.cell` with `observation = None` and stop.
   - `turns_left = limits.max_turns - index - 1`. If it is not 0: `pace = contract.pace_message(turns_left, limits.max_turns, edited)` only in repo mode when `mode.pace_nudge`; `observation = contract.observation(result.stdout, result.stdout_chars, result.error, turns_left, bridge.subcalls_left(), max_chars=limits.output_max_chars, pace=pace)`; append `callformat.observation_message(assistant, observation)`. The last turn gets no observation.
   - Emit `run.cell`: `output` is `stdout[:cap]` plus `contract.OBS_TRUNCATED.format(n=...)` when `stdout_chars > len(stdout)`, and `seconds` is `compute_s`. Then emit `run.budget {turns_left, subcalls_left}`.
5. [ ] **`loop.run`, the end.**
   - After a normal exit in repo mode with a `base_tree`: `diff = await asyncio.to_thread(workspace.diff, repo, base_tree, scratch)`. Otherwise `diff` is `None`.
   - A `ModelError` on a root call, an `InfraError` from the worker or bridge, or `bridge.infra_error` gives `infra_kind = kind` and `infra_error = f"{kind}: {message}"` (no double prefix). `CancelledError` gives `infra_error = infra_kind = "cancelled"`. Any other exception gives `infra_kind = "host_bug"` and `infra_error = f"host error: {exc!r}"`; its traceback goes to stderr and into the record as `host_traceback`.
   - A `finally` then does these, each wrapped so one failure skips nothing: `await worker.close()`, `app.cancel_calls(run_id)`, `_rmtree(scratch)`, build the record, `RunLog(spec.log_path).append(record)` (called directly, not in a thread), emit `run.finished`. Return the record, or re-raise `CancelledError`.
   - `_rmtree` uses `shutil.rmtree(onexc=...)` that clears read-only bits and retries 5 times, 0.2 s apart (**Windows**: the folder can stay locked briefly after the kill). A leftover folder is a stderr note, never an error.
6. [ ] **The record** (§7.8).
   - `usage.root` is the sum of the replies' `usage`; `usage.sub` is the sum of `bridge.records[*].usage`; `cost_usd` is their sum rounded to 6 places. `cache = {read_tokens, write_tokens, hit_rate}` over both roles, with `hit_rate = reads / input_tokens`, or `null` when there is no input (D-22).
   - `limits` is `dataclasses.asdict(limits)`. `contract_hash = contract.prompt_hash(contract.PROMPTS_V4)`. `prompt_hash` and `profile_hash` come from the profile; `harness_version` and `protocol` from `rlm_engine`. The key is `question` in read mode and `task` in repo mode.
   - `subcalls` from `bridge.records`, `fetches` from `bridge.fetches`, `permissions` from `perms.log`, and `timeouts`, `crashes`, `restarts` from the worker. `run.finished.subcalls` is `bridge.subcalls_used`.
7. [ ] **`_emit`** wraps `app.event` so that a send failure (the app is gone) prints one line to stderr and never stops a run.
8. [ ] **`service.py`, `run.start`.**
   - Validate in this order: field types and enum values (-32602); `profiles.load_profile` (-32011; an unreadable profile is -32011 too); missing fields, relative or missing paths, a repo path that is not a folder (-32012); `runlog.log_path` (-32602 on `ValueError`).
   - Then `run_id = "r_" + secrets.token_hex(6)`, `inputs.prepare(spec)` in `asyncio.to_thread` (`InputError` is -32012), and `asyncio.create_task(loop.run(spec, gate, home=self.home, worker_factory=capture))`. `capture` wraps `self.worker_factory` and stores the worker on `_Run`.
   - `gate` is an `AppPort` wrapper. It holds every event and delays the first `complete` until released, and it sets a future when it sees `run.started`. The handler waits for that future or for the task to end (a worker that cannot start ends the task), registers the run, schedules `loop.call_soon(gate.release)` as its last statement, and returns `{run_id, log_path}`.
   - That order (result, then `run.started`, then the first root call) is §5.4. It relies on step 2's `Link` writing a result in the same step in which its handler returns. `test_service` proves it. If it fails, the fix is a post-reply hook in `link.py`, logged in progress.md.
9. [ ] **`run.cancel`, `run.vars`, shutdown.**
   - `run.cancel` calls `task.cancel()` and waits up to 10 s for the task to end, so `run.finished` has been sent when `{}` returns.
   - `run.vars` returns `{vars: await run.worker.vars()}` (empty before the worker exists). Both give -32010 for an unknown or finished run (a done-callback removes it).
   - `_cancel_all` cancels every run and gathers them, so no worker outlives stdin. Nothing else is kept between runs (D-35).
10. [ ] **`session.ts`.**
    - `open`: load settings; build `KeyStore`, `Catalog`, `Bus`, `Gateway`, and expose the first two as `session.keys` and `session.catalog` (§7.8; step 7's `/providers` and `/model` use the same instances); `findEngine({ home, env: process.env })`, then `startEngine`, passing `onStderr` only with `verbose`. engine.ts owns key stripping (D-29); do not repeat it.
    - Wire as §7.3: `link.handle("model.complete", (p, { signal }) => gateway.complete(p, signal))` (if `ModelError` is not already an `RpcError`, rethrow it as `new RpcError(-32001, message, data)`), `link.onNotification("model.cancel", ...)`, `link.handle("approval.request", opts.approvals)`, `link.onNotification("*", ...)` emitting `engine.event` for every method that starts with `run.`, and `engine.exited` emitting `engine.exit`.
    - Call `engine.info` and refuse a different `protocol` (D-36), killing the engine.
    - `start`: `buildRunParams` fills `profile`, `permission_mode` and the models from settings. `root` is required, else `UsageError` naming `--root` and `rlmh config set root.model`. An empty `sub.model` means the root's provider and model with the *sub* thinking setting, never the root's. `call_format` is `r.callFormat`, else the setting, and `auto` goes through `gateway.resolveCallFormat(root, "auto")`. Paths go through `path.resolve`.
    - `cancel` swallows -32010. `close`: `link.close()`, wait 10 s for `engine.exited`, then `engine.kill()`; safe to call twice.
11. [ ] **`print.ts`.** `jsonLine` is `JSON.stringify({ type, ...body }) + "\n"`, built whole and written with one `write`.
    - `attachJson` prints each `engine.event` as `{type: <method>, ...params}`. It keeps `call.start` data by `call_id` and prints `{type: "gateway.call", run_id, role, subcall_id, model, usage, seconds, error}` on `call.end`. `model.cancel` is not printed: it is a gateway order, not run state.
    - `attachPlain` prints: `run.started` (one line with run id, mode, profile, models, call format, input chars, then `log: <path>`); `run.reply` (`turn N: reply, T tokens, S s`); `run.cell` (`turn N: cell S s`, then stdout and error indented 4 spaces, capped at 20 lines); `run.subcall` for `done`, `error` and `rejected` only; `run.permission`; `run.finished` (submitted or not, turns, sub-calls, cost, seconds, and `infra error: …` when set). `run.budget` and `sent` stay silent.
12. [ ] **`run.ts`.** Parse with `node:util` `parseArgs`: `--question`, `--input` (repeatable), `--task`, `--repo`, `--test-hint`, `--root`, `--sub`, `--profile`, `--permission-mode`, `--call-format`, `--json`, `--verbose`.
    - Usage errors (mixed modes, neither mode, `--question` without `--input`, a bad enum, no root model) print to stderr and return 2, as do `RpcError` -32011 and -32012 from `start`.
    - `--root` and `--sub` go through `parseModelRef(value, thinkingOf(session.settings, role))`. Pass `batch: "cli"` and `interactive = stdin.isTTY && stderr.isTTY`.
    - Subscribe to `engine.event` before `start`, and keep every `run.finished` by `run_id` in a map, so a finish that arrives before the start result is not lost.
    - Plain mode sends progress to **stderr** and only the answer to stdout (a string raw, anything else as JSON). `--json` sends the event lines to stdout and everything else to stderr.
    - Return 0 when the run finished without `infra_error`, 1 with one (or when `engine.exit` comes first, after printing the engine's stderr tail), 2 for usage. First Ctrl-C: `session.cancel`, wait for `run.finished`, return 130. Second: `session.close()` and return 130. Always `session.close()` last.
    - Set `process.exitCode` and let the process end. Never call `process.exit()` right after a write to a pipe (**Windows** can truncate it).
13. [ ] **`createTtyApprover`.** Prompt on stderr: `[permission] <kind>: <detail> (inside|outside the workspace)\nAllow? [y]es / [a]llow for this run / [N]o: `. Read one line from `io.stdin` through `node:readline`. `y` or `yes` gives `{allow: true, remember_for_run: false}`, `a` gives `{allow: true, remember_for_run: true}`, and anything else, EOF or Ctrl-C denies. Prompts are served one at a time. Without a TTY the approver denies without prompting, and `interactive` is `false` (D-15).
14. [ ] **`batch.ts`.** `rlmh batch TASKS.jsonl [--jobs N] [--out DIR] [--json] [--root] [--sub] [--profile] [--permission-mode] [--call-format] [--verbose]`. `--jobs` defaults to 1.
    - Pre-flight, before the engine starts and before anything is spent: every line is valid JSON with D-28's keys (`id` plus `question` and `input`, or `task` and `repo`), ids are unique, and each input file and repo folder exists (paths resolved against the tasks file's folder). Any problem is listed on stderr and returns 2. Unknown keys are ignored and never forwarded.
    - Batch name: `<stem with [^A-Za-z0-9._-] replaced by _>-<YYYYMMDD-HHMMSS>` (D-26). `--out DIR` becomes `logDir`.
    - A pool of `--jobs` workers shares one `Session`: `start({ tag: id, interactive: false, batch, logDir })`, then await that run's `run.finished` (the same map as in `run.ts`). A start failure counts as a failed run; the others go on. Ctrl-C cancels every running run, starts no more, returns 130.
    - `--json`: all event lines, then `{"type":"batch.finished","runs","failed","cost_usd"}` last. Plain: one stdout line per finished run (`id  status  turns  sub-calls  $cost  seconds`) and a totals line. `failed` counts runs with `infra_error` plus start failures. Exit 0, 1 or 2 (D-40).
    - When the effective permission mode is `default` (set by flag or settings, since the default is `accept-edits`, S-27) and any task is repo mode, print a stderr warning: with no one to ask, every edit is denied, so pass `--permission-mode accept-edits`.
15. [ ] **`config.ts` and `main.ts`.** `list` prints `key = value` for every key the schema has (§8), in schema order. `get KEY` prints the bare value. `set KEY VALUE` passes the raw string to `setSetting` (coerce by the type of `getSetting` if it wants typed values), saves, and prints `KEY = VALUE`. An unknown key or invalid value prints the message and returns 2. It never starts the engine and makes no request. `main.ts` calls the three commands with the real `process` streams and `home()`.
16. [ ] Run everything on Windows (`.bun\bin\bun.exe test`, `uv run --project engine pytest engine/tests`). Commit nothing until Rishi says so. Update progress.md (see Hand-off).

## Tests

All offline, with the scripted fake. Engine tests use a temporary `home`. Tests that need git skip when `shutil.which("git")` is `None`. The test profile for short runs is a copy of the built-in `training-v4/profile.toml` text with one limit replaced.

**`engine/tests/test_loop.py`** (`FakeApp(script=...)`, real `Worker`, profile `training-v4`)
- `test_read_counters`: reply 1 prints `hello`; the second root request's messages are `[system, first_user, assistant, user]`, the system prompt equals `profile.system_prompt(shell.name)`, the first message equals `contract.first_user_message`, and the last is exactly `REPL output:\nhello\n(19 turns left, 80 sub-calls left)`.
- `test_subcall_counter`: `llm_batch(['a','b','c'])` makes the next observation end `(19 turns left, 77 sub-calls left)`; the record has 3 `subcalls` and `run.finished.subcalls == 3`.
- `test_last_turn_line`: a 3-turn profile. The turn-2 observation ends `(1 turns left, 80 sub-calls left)\nYour next turn is the last one: it must call submit() with your best answer.` Turn 3 gets none: `run.cell.observation is None`, `submitted` is false, there are exactly 3 root requests.
- `test_no_code_error`: a reply with no block gets `REPL output: (nothing printed)\nError:\n` plus `contract.no_code_error()` (it starts `No ```python code block found.`) before the counters; `run.cell.code is None`, no cell ran, and the log turn has `code None`.
- `test_truncation`: a profile with `output_max_chars = 100` and a cell printing 300 characters: the observation has the first 100, then `\n[... 200 more characters truncated]`, and `run.cell.output` equals that text; a long error is cut to 200 characters.
- `test_pacing_repo`: git repo, 10-turn `[repo]` profile, `accept-edits`. Unedited run: the line starting `Half your turns are gone` appears in the observations with 5, 4, 3 and 2 turns left, and not before. Run whose turn 1 calls `write_file`: only the observation with 5 turns left carries `5 turns left: run the tests, fix what fails, and call submit().`. With `pace_nudge = false`: no line. The record's `diff` is non-empty after `write_file`, `base_tree` is 40 hex characters, `workspace` is the repo path.
- `test_native_placement`: `call_format="native"`, `tools == [callformat.PYTHON_TOOL]`. A reply with a tool call gets `{role: "tool", tool_call_id: "call_1", content: <observation>}`; a text-only reply (fenced code, D-31) gets a `user` message; fenced format sends `tools == []`.
- `test_repo_first_message`: overrides `language`, `n_files`, `test_hint`, `context` give exactly `contract.edit_first_message(...)`, and the context is used as given.
- `test_event_shapes_and_order`: every event's key set equals its §5.3 row plus `run_id` (hard-coded `EVENT_KEYS`); first is `run.started`, last `run.finished`; per turn `run.reply` < `run.cell` < `run.budget`; turns count 1, 2, …; when `run.finished` is sent the log already holds the record (a `FakeApp` subclass reads the file inside `event`).
- `test_usage_sums`: script entries with `usage` and nonzero cost: `usage.root`, `usage.sub`, `cost_usd`, `cache.hit_rate` equal the hand-computed sums.
- `test_model_error_stops`: `errors: [{role: "root", at: 2, kind: "auth", status: 401}]`: one turn recorded, `infra_kind == "auth"`, `infra_error` starts `auth: `, `cancel_calls` was called, the scratch folder is gone, exactly one log line, `run.finished` carries the same fields.
- `test_subcall_server_error_stops` (`kind: "server", status: 500`: `infra_kind == "server"`) and `test_subcall_bad_request_continues` (400: the cell's error mentions `RuntimeError`, the run goes on) — D-06.
- `test_worker_start_failure`: a factory whose `start` raises `InfraError("worker", ...)`: no `run.started`, one `run.finished` with `infra_kind == "worker"`.
- `test_host_bug`: a factory that raises `RuntimeError("boom")`: `infra_kind == "host_bug"`, the record's `host_traceback` contains `boom`, stderr shows the traceback (`capsys`), nothing escapes.
- `test_cancel`: block the first root call, cancel the task: `run()` raises `CancelledError` after the record has `infra_error == "cancelled"`, `run.finished` was sent last, the scratch folder is gone.

**`engine/tests/test_inputs.py`**: one file keeps CRLF and turns an invalid byte into U+FFFD; several files get `=== C:/data/a.txt ===` headers from a `PureWindowsPath` and `\n\n` joins; a missing file, a folder, a relative path and an empty list raise `InputError`; a temp git repo (tracked, untracked, ignored, a deleted tracked file, a name with a space and one non-ASCII name, a 1,234-byte file) lists sorted, `  1,234`, without the ignored and deleted ones; the no-git walk skips `node_modules` and `.git`; an empty `PATH` falls back to the walk; the exact `repo_context` string; language majority, tie and `unknown`; one case per test-hint rule and the fallback text; `prepare` fills only `None` fields, is idempotent, and never calls `repo_files` when all four overrides are given.

**`engine/tests/test_runlog.py`**: `log_path` for batch, for `log_dir` and for the bad names `""`, `".."`, `"a/b"`, `"a\\b"`; round trip with a non-ASCII answer stored as raw UTF-8 (not `\u00e9`) and only `\n` line ends (read bytes, **Windows** check); a torn last line is skipped, and the next `append` starts on a fresh line; NaN becomes `"nan"`; 8 threads × 25 appends give 200 valid lines; a missing file gives `[]`; `RECORD_KEYS` matches §7.8.

**`engine/tests/test_service.py`** (`Engine` built as step 2's tests build it; the order test uses a real `Link` pair built as `test_link.py` does)
- `test_start_errors`: unknown profile -32011; missing question, missing file, relative path, repo path that is a file -32012; bad `permission_mode` -32602. None leaves a scratch folder or a run behind.
- `test_start_result`: `run_id` matches `^r_[0-9a-f]{12}$`; `log_path` is `home/runs/interactive/runs.jsonl`, or follows `batch`, or `log_dir`.
- `test_order_on_the_wire`: the lines the engine writes are the `run.start` result, then `run.started`, then the first `model.complete`, with the root call held open meanwhile. A worker that fails to start still gets its result before `run.finished`.
- `test_cancel`: `run.cancel` on a blocked run returns `{}` after `run.finished` (`infra_error == "cancelled"`); a second cancel and an unknown id give -32010.
- `test_vars`: after a turn that sets `x = 'abc'`, `run.vars` lists `{name: "x", type: "str", len: 3, chars: 5}` and none of `context`, `llm`, `submit`; -32010 after the run ends.
- `test_eight_runs_at_once`: 8 read runs on one engine: distinct ids, 8 lines in one `runs.jsonl`, each record's `answer` and `tag` match, all scratch folders gone.
- `test_stdin_close_cancels`: closing the link with a blocked run writes its `cancelled` record and leaves no worker process.

**`app/test/session.test.ts`**: `buildRunParams` table (defaults from settings, with `permission_mode` `accept-edits` (S-27); overrides; `default` thinking is `null`; empty `sub.model` falls back to root with the sub thinking; `auto` is `native` for `fake/scripted` and `fenced` for `local`; relative paths become absolute; no root model throws `UsageError`). A protocol mismatch is refused. With the real engine and the fake provider: a read run emits `run.started` to `run.finished` on `bus`, `approvals` gets one `network` request when the script calls `fetch('http://127.0.0.1:9/')` (answered `allow: false`, so nothing is fetched), `cancel` mid-run ends with `infra_error == "cancelled"` and the gateway saw `model.cancel`, and `close()` ends the engine process.

**`app/test/cli/run.test.ts`** (spawns `process.execPath src/main.ts run …` with `RLMH_HOME` set to a temp folder and `RLMH_FAKE_SCRIPT` set; asserts the exit code)
- `--json`, native: every stdout line parses; the types begin `run.started` and end `run.finished`; each event's keys equal its §5.3 row plus `type`; `gateway.call` appears for root and sub; stdout holds nothing else. The run log's last line has exactly `RECORD_KEYS`, `format == 1`, `usage.root.input_tokens > 0`, `answer == "42"`, `len(turns) == run.finished.turns`. A second case uses `--call-format fenced` with fenced-only replies, so it does not depend on 6b.
- Plain mode: stdout is exactly the answer and a newline; stderr has `run finished`.
- Usage errors return 2 with a message: no arguments, `--question` without `--input`, no root model (the message names `rlmh config set root.model`), an unknown profile, a missing input file.
- Non-TTY: a `fetch` in `default` mode is denied (`run.permission` has `allowed: false, asked: false`; the cell error says `PermissionError`).
- `createTtyApprover` with piped streams: `y`, `a`, Enter, `n`, EOF and two simultaneous prompts answered in order.

**`app/test/cli/batch.test.ts`**: three tasks (two read, one repo), `--jobs 2`, `--out`, `--json`, cwd elsewhere: relative paths resolve against the tasks file; `batch.finished` is last with `runs 3, failed 0, cost_usd 0`; `<out>/runs.jsonl` has 3 records tagged with the ids and 3 distinct run ids; exit 0. With `delay_ms` set, all `run.started` precede the first `run.finished` at `--jobs 3`, and runs do not overlap at `--jobs 1`. An `errors` entry that fails the first root call gives `failed 1` and exit 1. A bad JSON line, a duplicate id and a missing input each return 2 before any engine starts (no `runs` folder appears). The default log folder matches `<stem>-\d{8}-\d{6}`. A repo task under `default` prints the stderr warning.

**`app/test/cli/config.test.ts`**: `set` then `get` and `list` round trip in a temp home; every §8 key is listed; an unknown key and a bad value return 2; `settings.toml` is written.

## Done when

- `uv run --project engine pytest engine/tests/test_loop.py engine/tests/test_inputs.py engine/tests/test_runlog.py engine/tests/test_service.py` passes on Rishi's PC, and the whole suite passes in CI on macOS, Windows and Linux.
- `bun test` in `app/` passes, including `test/cli/*.test.ts` and `test/session.test.ts`.
- In `app/`, with `RLMH_FAKE_SCRIPT` set to a file holding the §7.5 example and a question file `q.txt`: `..\.bun\bin\bun.exe run src/main.ts run --question "Q?" --input q.txt --root fake/scripted --sub fake/scripted --call-format native --json` prints `run.started`, `run.reply`, `run.cell`, `run.budget`, `gateway.call`, `run.finished` lines and nothing else, and exits 0. (The first scripted reply is fenced text and the second a tool call, so this also shows D-31.)
- The last line of `~/.rlm-harness/runs/cli/runs.jsonl` (`%USERPROFILE%\.rlm-harness\runs\cli\runs.jsonl` on Windows) has every key in `runlog.RECORD_KEYS`: `uv run --project engine python -c "import json,sys; r=json.loads(open(sys.argv[1],encoding='utf-8').read().splitlines()[-1]); print(sorted(r)); print(r['usage'], r['cache'], r['cost_usd'])" <path>`.
- If a local model server (Ollama, LM Studio, vLLM or llama.cpp) is set up on Rishi's PC: `rlmh config set providers.local.base_url <url>/v1`, `rlmh config set root.model local/<model>`, then `rlmh run --question … --input <a small text file>` finishes with no `infra_error`, `cost_usd` 0 and nonzero tokens in its log line. A wrong answer is fine. Otherwise write "no local server" in progress.md; the first real run is step 9.
- **What step 9 reads from each run-log line:** `mode`, `root`, `sub`, `input.chars`, `usage.root` and `usage.sub` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`), `len(turns)`, `len(subcalls)`, per-turn `usage`, per-sub-call `usage`, `cache.hit_rate`, `wall_s`, `submitted`, `infra_error`, `tag`. It prices tokens from the catalog; this step records `cost_usd` only as the gateway computed it.

## Out of scope

- The interactive app, the `/runs` replay view and `/context` (step 7). The parity script (step 8). The smoke run and grading (step 9). `rlmh setup`, binaries, installers (step 10).
- Follow-up turns and compaction (v1, S-11). `rlm()` recursion. Resampling, format penalties, detectors, rewards, token ids (training only).
- The worker, bridge, permissions and gateway themselves (steps 4 and 5). This step only calls them. The bridge, not the loop, sends the `run.subcall` events and the `run.budget` that follows each batch.

## Hand-off

- Steps 7 and 8 can rely on: `RunSpec`, `loop.run`, `RECORD_KEYS`, `Session` (with `buildRunParams` and `thinkingOf`), the `--json` line shape, `FakeApp(script=)`, the order result, `run.started`, first root call, and exit codes 0, 1, 2 and 130.
- Step 7 reuses `Session` and must key events by `run_id`. Step 9 reads the fields listed above.
- progress.md row 6: set `review`, with the date, whether a local run was done (server and model, or "none"), and the log line "Link ordering held without a post-reply hook" or the hook that was added. (`host_traceback`, `RECORD_KEYS`, `listSettings`, `Session.keys`/`catalog` and the `rlmh run` exit codes are already in architecture.md §7.1 and §7.8: D-50, D-51.)

## If a decision goes the other way

Every decision below was settled at step 1 (2026-10-30; [decisions.md](../decisions.md) S-22 to S-34). Each line names the pick and says what would change if Rishi reversed it. Picks that went the alternative way are already written into this spec.

- **6a, follow-ups in v0** (settled: one-shot, S-11): nothing changes. They would need `loop.run` to keep the worker and messages between prompts (a `run.say` method), a compaction rule, one record per prompt, and `rlmh run --continue`; that is a redesign of §7.8.
- **6b, fenced text everywhere** (settled: native for API models, S-30): the `call_format` setting default becomes `fenced` and `buildRunParams` stops calling `resolveCallFormat`. `loop.py` is unchanged (it handles both). Only the `session.test.ts` defaults table changes, because `run.test.ts` names its format.
- **2b, OS-standard config folders** (settled: `~/.rlm-harness/`, S-24): `home` still arrives as a parameter, so only the test helpers that build `home/runs/...` and `home/scratch/...` paths change, plus the path in the Done-when command.
