# Step 2. Skeleton, the stdio link both ways, CI and a binary per OS

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 1 |
| **Unblocks** | 3 and 5, and through them 4, 6, 7, 8, 9, 10 |
| **Parallel with** | none |
| **Decisions it uses** | 1a: MIT (S-22), no per-file headers; 2a: Ink (S-23); 2b: `~/.rlm-harness/` (S-24); 4b (`accept-edits`, S-27) and 6b (S-30) only as the defaults in the settings schema. S-15 (Bun 1.4.4), S-16, S-17, S-20, S-21; D-02, D-18, D-19, D-29, D-30, D-36, D-40, D-42, D-43, D-44, D-49, D-50 |

## Goal

`rlmh` exists as a Bun program with a Python engine behind it. The app starts the engine and the two talk JSON-RPC both ways over the engine's stdio, interleaved. CI builds and tests it on macOS, Windows and Linux and keeps a compiled `rlmh` per OS. Every later step plugs into this link, and Windows is the riskiest OS, so it is proven now.

## Read first

- [../architecture.md](../architecture.md) §1, §2 (the rows marked 2), §3, §4, §5 (all tables), [§5.4](../architecture.md#54-one-run-in-order), §7.1, §7.2, §8, §9, §10, §11, §12.
- [../decisions.md](../decisions.md): D-02, D-18, D-19, D-29, D-30, D-36, D-40, and S-22 to S-24 (1a, 2a, 2b) and S-27 (4b).
- [../../legacy/v0-build-plan.md § Step 2](../../legacy/v0-build-plan.md#step-2-skeleton-the-stdio-link-both-ways-ci-and-a-binary-per-os) and [../../legacy/v0-design.md § The link between app and engine](../../legacy/v0-design.md#the-link-between-app-and-engine).
- Style only, `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/bridge.py`: `MAX_REQUEST_BYTES`, `EpisodeBridge._serve` and `_handle`. One JSON object per line, a size limit on the line, and a bad request answered with an error, never a crash. Our link is JSON-RPC and two-way, so copy the idea, not the code.

## Starting state

- Step 1 is `done`. The repo is at `e3ae151` plus `documentation/v0/`. There is no `app/`, `engine/`, `protocol/` or `.github/`.
- `.gitignore` already lists `dist/`, `node_modules/`, `.venv/` and `.pytest_cache/`. `.gitattributes` exists with one line, `scripts/*.sh text eol=lf`, which keeps the verify gate's bash script LF on a Windows checkout.
- Bun 1.4.4 is at `F:\Personal\RLM\rlm-harness\.bun\bin\bun.exe` (git-excluded). uv and gh are installed.

## Deliverables

Paths are exactly those of architecture §2. Every module starts with `KV cache: none` (S-21): `// KV cache: none` as line 1 of a `.ts`/`.tsx` file (line 2 after the shebang), and as the first line of the module docstring in `.py`.

### Link rules (both `link.py` and `link.ts`)

1. **Framing.** UTF-8, no BOM, objects ended by `\n` only. The reader ignores blank lines and one trailing `\r`. `jsonrpc` is always sent and not required on receipt.
2. **Size.** `MAX_LINE_BYTES = 32 * 1024 * 1024`, overridable by `max_line_bytes` (Python kwarg) or `maxLineBytes` (TS option) for tests. A longer line is dropped up to its `\n`, answered with -32600 `line too long (over N bytes)` and `id: null`. The link stays open, because it serves every run.
3. **Classes.** A `method` string plus an `id` (string or integer) is a request; without `id`, a notification. No `method`, an `id`, and exactly one of `result`/`error` is a response. Bad JSON or bad UTF-8 is -32700; any other shape is -32600; both use `id: null` unless the line had a usable `id`. Export `classify(msg): "request"|"notification"|"result"|"error"|"invalid"` for the protocol tests.
4. **Requests.** `params` absent means `{}`; a non-object is -32602 `params must be an object`. An unknown method is -32601 `method not found: <name>`. A handler that raises `RpcError` sends its code, message and data. Any other exception sends -32603 `internal error: <Type>: <text>` (the engine prints the traceback to stderr). A `None`/`undefined` result is sent as `null`. Each request runs concurrently; the reader never awaits a handler.
5. **Notifications** run their handler or listeners in arrival order, get no reply, and their errors are logged on stderr and never sent.
6. **Responses** match a pending request by id; an `error` rejects with `RpcError(code, message, data)`; an unknown id is ignored.
7. **Ids.** The app: integers from 1, or `${idPrefix}${n}` if `idPrefix` is given (the tests give `"e"` to the fake engine). The engine: `"e1"`, `"e2"`, ….
8. **Close.** When input ends or `close()` is called: pending requests reject with `RpcError(-32800, "link closed")`; later `request` calls reject the same way; handler `AbortSignal`s abort; `closed` resolves; later writes are dropped without error. A broken output pipe counts as closed.
9. **Cancel.** A TS `request` whose `signal` aborts rejects with `RpcError(-32800, "cancelled")`, sends nothing, and ignores a late answer. In Python, cancelling the awaiting task drops the pending entry. Run-level cancel is `model.cancel` (step 6), not this.
10. **Ordering.** Notifications are delivered synchronously in the read loop, so a caller that wants a run's events subscribes before it sends `run.start`.

### Engine (`engine/`)

| Path | Contents |
|---|---|
| `pyproject.toml`, `uv.lock` | `name = "rlm-engine"`, `version = "0.1.0"`, `requires-python = "==3.12.*"`, `dependencies = []`, `license = "MIT"`, `[dependency-groups] dev = ["pytest>=8"]`, `[tool.pytest.ini_options] testpaths = ["tests"]`. It needs `[build-system]` (hatchling) and `[tool.hatch.build.targets.wheel] packages = ["rlm_engine"]`, so `uv run` installs the package editable and `python -m rlm_engine` works from the repo root (D-18 sets that cwd). `uv.lock` comes from `uv lock` and is committed |
| `rlm_engine/__init__.py` | `__version__ = "0.1.0"`, `PROTOCOL_VERSION = 1` |
| `errors.py` | `InfraError(kind, message="")` (step 4 writes `InfraError("worker", …)`), `SubcallError(message)`, `ModelError(message, *, kind="other", status=None, provider="", model="")` with `.data() -> dict` giving a ModelErrorData |
| `link.py` | `RpcError(code, message, data=None)`, `Link` as architecture §7.1, constants `PARSE_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `INTERNAL_ERROR`, `MODEL_ERROR`, `UNKNOWN_RUN`, `UNKNOWN_PROFILE`, `BAD_INPUT`, `CANCELLED`, plus `classify`. `Link.__init__(reader, writer, *, max_line_bytes=MAX_LINE_BYTES)`. Private design: a daemon reader thread reads 64 KiB chunks (`read1` if the object has it, else `read`), splits on `b"\n"`, and hands lines to the loop with `call_soon_threadsafe` (D-30). A writer thread drains a `queue.SimpleQueue`, so `notify` is safe from any thread and a stalled app never blocks the loop. `serve()` on EOF runs, in order: reject pending requests, run `on_close` callbacks in registration order (one that raises is logged and the next still runs), cancel running handler tasks, drain the writer (5 s cap), return. JSON is dumped with `ensure_ascii=False`, falling back to ASCII escapes when a `str` holds a lone surrogate |
| `appport.py` | `AppPort` and `LinkAppPort` as §7.2. `complete` sends `model.complete`; -32001 becomes `ModelError(data.message, **data)`, -32800 becomes `ModelError(kind="cancelled")`, any other `RpcError` becomes kind `other`. `approve` sends `approval.request`, and on any `RpcError` returns `{"allow": False, "remember_for_run": False}` (deny when the app can't answer). `event` notifies. `cancel_calls(run_id)` notifies `model.cancel` with `{run_id}` |
| `service.py` | `Engine(app: AppPort, *, debug=False, home: Path \| None = None)`. `home` defaults to `RLMH_HOME`, else `Path.home() / ".rlm-harness"` (step 3 reads it). `info() -> dict` returns `{version, protocol, python: platform.python_version(), contract: None, contract_hash: None, training_hash: None, profiles: []}`; step 3 fills it. `register(link)` adds `engine.info`, and `debug.roundtrip` only if `debug`. `debug.roundtrip` rejects a `count` outside 1 to 1000 with -32602, then sends `count` concurrent `app.complete` calls with `{run_id: "debug", role: "root", model: {provider: "debug", model: "roundtrip", thinking: null}, messages: [{role: "user", content: "ping <i>"}], tools: [], max_tokens: 16, temperature: 0.0, thinking: "off", turn: 1}`, returns `{texts}` in index order, and turns a `ModelError` into `RpcError(MODEL_ERROR, message, ModelError.data())` |
| `__main__.py` | `main(argv) -> int`: only `serve` is accepted (else usage on stderr, exit 2). `claim_stdio()` dups fds 0 and 1 into private unbuffered binary files, then points fd 0 at the null device and fd 1 at fd 2 and sets `sys.stdout = sys.stderr`, so a stray `print` can never reach the protocol. It never touches `sys.stdin.buffer`, because a daemon thread blocked in a `BufferedReader` can abort interpreter shutdown. Then: build `Link`, `LinkAppPort`, `Engine(debug=os.environ.get("RLMH_DEBUG") == "1")`, `register`, `asyncio.run(link.serve())`. Clean EOF exits 0; `KeyboardInterrupt` exits 130 without a traceback. The call sits under `if __name__ == "__main__"`, so tests can import `claim_stdio` |

Writes loop until every byte is out (a pipe `write` can be partial). Windows: set the dups to binary with `msvcrt.setmode(fd, os.O_BINARY)`, so no `\r\n` is ever written.

### App (`app/`)

| Path | Contents |
|---|---|
| `package.json` | `name: "rlm-harness"`, `version: "0.1.0"`, `private`, `type: "module"`, `license: "MIT"`, `bin: {rlmh: "src/main.ts"}`, `packageManager: "bun@1.4.4"`, `engines: {bun: "1.4.4"}`, scripts `test` (`bun test`), `typecheck` (`tsc --noEmit`), `build` (`bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/main.ts --outfile ../dist/rlmh`; the two flags stop the binary loading a `.env` or `bunfig.toml` from the folder it runs in, D-44). Dependencies `ink`, `react`; dev `@types/bun`, `@types/react`, `typescript`. Add with `bun add --exact …` so every version is pinned |
| `bun.lock`, `tsconfig.json` | Lockfile committed. tsconfig: `strict`, `jsx: react-jsx`, `moduleResolution: bundler`, `module`/`target: ESNext`, `types: ["bun"]`, `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `skipLibCheck`; include `src` and `test` |
| `src/version.ts` | `APP_VERSION = "0.1.0"`, `PROTOCOL_VERSION = 1` |
| `src/paths.ts` | `home(env = process.env)`: `RLMH_HOME` if non-empty (made absolute), else `join(os.homedir(), ".rlm-harness")`. Then, each with a trailing `h = home()` argument and creating nothing: `settingsPath`, `keyIndexPath`, `keysPath`, `refreshedModelsPath`, `profilesDir`, `runsDir`, `scratchDir(runId, h)`, `pythonDir`, `engineDir(version, h)`, `binDir`. Names and layout follow §9 |
| `src/protocol.ts` | Types for §4 to §6 under the names later signatures use: `ModelRef`, `Message`, `ToolCall`, `ToolDef`, `Usage`, `ModelErrorData`, `Origin`, `Batch`, `EngineInfo`, `VarInfo`, `RunStartParams`, `ModelCompleteParams`, `ModelCompleteResult`, `ApprovalParams`, `ApprovalResult`, one params type per §5.3 event. `ErrorCode` (a const object with the same ten names as `link.py`'s constants and the §3 values). `PYTHON_TOOL` is not here (step 3, Python) |
| `src/link.ts` | `RpcError`, `Link` as §7.1, plus `classify`, `MAX_LINE_BYTES` and the `maxLineBytes` option. `onNotification` has two overloads: `("*", fn(method, params))` and `(method, fn(params))`. Reads with `getReader()` and a streaming `TextDecoder`, so a multi-byte character split across chunks survives. Writes are chained through one promise so their order holds |
| `src/engine.ts` | `EngineNotFound`, `ProtocolMismatch`, `splitCommand(line)`, `findEngine`, `startEngine`, `fetchInfo(link)`. See below |
| `src/bus.ts` | `Bus<E>` as §7.1. A throwing listener is caught and logged to stderr, and the other listeners still run |
| `src/settings.ts` | The §8 schema as an exported `SCHEMA` array of `{key, type, default, choices?, doc}` (`doc` is the one-line text `/settings` shows), `Settings` (nested like the TOML), `SettingsError`, `defaultSettings()`, `loadSettings(home)`, `saveSettings(home, s)`, `getSetting(s, key)`, `setSetting(s, key, value): Settings` (pure; strings are coerced: `true`/`false`, whole numbers), `listSettings(s)`. Defaults are §8's: `root.model ""`, `root.thinking default`, `profile default`, `permissions.mode accept-edits`, `call_format auto`, `display.verbose false`, `providers.<id>.max_in_flight 16`, `providers.local.base_url http://localhost:8000/v1`, other `base_url` `""`. A provider id matches `^[a-z][a-z0-9_-]*$` (step 5 adds the list check). Errors name the key and the allowed values. Parse with `Bun.TOML.parse`. Write with a small private serializer: top-level scalars, then `[table]`s, strings via `JSON.stringify`. `saveSettings` creates `home`, writes `settings.toml.tmp`, then renames over the file. `loadSettings` returns defaults for a missing file and throws `SettingsError` (with the file path) on bad TOML, an unknown key or a wrong type, and never rewrites the file |
| `src/main.ts` | `#!/usr/bin/env bun`. Argv by hand (§10); table below |
| `src/interface/App.tsx` | `export function App()` renders one dim line, `rlmh 0.1.0  press q or Ctrl+C to quit`, and `useInput` calls `exit()` on `q`. Ctrl+C is Ink's own exit |

**`engine.ts` details.**

- `splitCommand`: splits on whitespace and honours `"…"` and `'…'`. Backslashes are plain characters, so `"C:\Program Files\x"` survives. An unbalanced quote throws an `Error` that names `RLMH_ENGINE`.
- `findEngine` follows D-18. (1) `RLMH_ENGINE` (empty counts as unset), with cwd `process.cwd()`. (2) A source checkout: `uv run --project <root>/engine python -X utf8 -m rlm_engine serve` (D-42), cwd `<root>`, where `<root>` is two levels above `import.meta.dir` and contains `engine/pyproject.toml`, and `import.meta.dir` contains neither `$bunfs` nor `~BUN` (the compiled binary's virtual folder). (3) The installed engine: a private `findInstalledEngine(home): EngineCommand | null` that returns `null`, with a `// step 10` marker. (4) Otherwise it throws `EngineNotFound`, with a message that names `RLMH_ENGINE` and `rlmh setup`. An optional `sourceDir` in the options replaces `import.meta.dir` for tests.
- The child env is the given env minus every name matching `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i` (D-29), plus `RLMH_HOME=<home>`, `PYTHONUTF8=1` and `PYTHONUNBUFFERED=1`.
- `startEngine` uses `Bun.spawn` with all three stdio piped. The writer given to `Link` writes to `proc.stdin` and flushes. Stderr is read as UTF-8 lines, passed to `onStderr`, and kept in a 200-line ring for `stderrTail(n = 50)`. `proc.exited` resolves `exited` and closes the link. `kill()` returns at once; it ends stdin, waits 2 s for the engine to exit by itself (its normal path), then kills the whole tree: `taskkill /PID <pid> /T /F` on Windows (the chain is `uv.exe` then `python.exe`), `proc.kill()` elsewhere.
- `fetchInfo(link)` requests `engine.info` and throws `ProtocolMismatch` (message `engine speaks protocol X, this rlmh speaks Y`) when `protocol !== PROTOCOL_VERSION` (D-36).

**`main.ts` commands.** Exit 0 is success, 1 a runtime failure, 2 a usage error (as D-40). `--verbose` may appear anywhere and forwards engine stderr to the app's stderr.

| Input | Behaviour |
|---|---|
| `rlmh --version` | stdout `rlmh 0.1.0`. Loads neither Ink, React nor the settings, so it stays fast |
| `rlmh --help` | `Usage: rlmh [command] [options]`, then one line per command that exists now (`rlmh`, `info`, `--version`, `--help`, `--verbose`) |
| `rlmh info` | `findEngine`, `startEngine`, `fetchInfo` (120 s cap, because a first `uv run` may fetch Python), then stdout is only `JSON.stringify({app: {version, protocol}, engine}, null, 2)`. Then `kill()` and exit 0. An engine that exits early, `EngineNotFound` or `ProtocolMismatch` prints one line plus `stderrTail()` to stderr and exits 1 |
| `rlmh` | If stdin or stdout is not a TTY: stderr `rlmh: the interactive app needs a terminal. Try "rlmh --help".`, exit 1. Otherwise import `./interface/App.tsx` dynamically, `render(createElement(App))`, await exit, exit 0 |
| anything else | stderr `rlmh: unknown command "<x>". Try "rlmh --help".`, exit 2 |

### Protocol examples (`protocol/examples.json`)

```json
{ "protocol": 1,
  "examples": [ { "name": "run.start:request:repo", "direction": "app->engine",
                  "kind": "request", "message": { "jsonrpc": "2.0", "id": 2, "method": "run.start", "params": {} } } ] }
```

- `name` is `<method>:<kind>` or `<method>:<kind>:<variant>`, unique. `direction` is who sends the message (`app->engine` or `engine->app`). `kind` is `request`, `result`, `error` or `notification`. `message` is the full JSON-RPC object, using only made-up values (`/example/input.txt`, "Example question?").
- App requests use integer ids, engine requests `"e1"`…. A `result` or method-specific `error` example reuses the id of the same method's request example; the method comes from the name. Errors with no method are named `rpc:error:<NAME>`.
- Required names (these are the lists both test suites hold):

| Group | Names |
|---|---|
| App to engine | `engine.info`, `run.cancel`, `run.vars`, `debug.roundtrip`: `:request` and `:result`; `run.start:request:read`, `run.start:request:repo`, `run.start:result` |
| Engine to app | `model.complete:request:root` (native: one message of each role, `tools: [PYTHON_TOOL]`), `model.complete:request:sub` (with `subcall_id`, `origin`, `batch`), `model.complete:result`, `approval.request:request`, `approval.request:result` |
| Errors | `run.start:error:UNKNOWN_PROFILE`, `run.start:error:BAD_INPUT`, `run.cancel:error:UNKNOWN_RUN`, `model.complete:error:MODEL_ERROR` (with ModelErrorData), `rpc:error:PARSE_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `INTERNAL_ERROR`, `CANCELLED` |
| Events | `run.started`, `run.reply`, `run.cell`, `run.subcall`, `run.permission`, `run.budget`, `run.finished`, `model.cancel`, each `:notification` |

### CI (`.github/workflows/ci.yml`) and `.gitignore`

- **Triggers:** `push`, `pull_request`, `workflow_dispatch`; `permissions: contents: read`; a `concurrency` group cancels superseded runs. **Matrix** (`fail-fast: false`): `ubuntu-latest` with target `linux-x64`; `macos-latest` with `darwin-arm64`; `windows-latest` with `windows-x64` and suffix `.exe`. Use `defaults.run.shell: bash` on all three.
- **Steps, in order:** `git config --global core.autocrlf false`; `actions/checkout`; `oven-sh/setup-bun` with `bun-version: 1.4.4`; `astral-sh/setup-uv`; `uv run --project engine pytest engine/tests`; in `app/`: `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`; `bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/main.ts --outfile ../dist/rlmh-<target>[.exe]`; the smoke steps; `actions/upload-artifact` of `dist/rlmh-<target>[.exe]` with artifact name `rlmh-<target>` (`if-no-files-found: error`; step 10's install job downloads these by name). Use each action's current major tag, and check its README.
- **Smoke steps** (from the repo root, with `RLMH_ENGINE="uv run --project engine python -X utf8 -m rlm_engine serve"`): `dist/rlmh-<target> --version` prints `rlmh 0.1.0`; `dist/rlmh-<target> info` is piped into `bun -e` that fails unless `engine.protocol === 1` and `app.version === engine.version`; the binary with `RLMH_ENGINE` unset and `info` must exit 1 with a message naming `RLMH_ENGINE` (this checks the compiled binary does not mistake the checkout for a source run); `dist/rlmh-<target> < /dev/null` must exit 1.
- **`.gitignore`:** add `*.bun-build` (Bun's temp files from a failed compile) and `*.tsbuildinfo`. `release.yml` and the `darwin-x64` binary are step 10's.
- **`.gitattributes`** (D-43): add `* text=auto eol=lf`, plus `*.png binary` and `*.ico binary`, above the existing `scripts/*.sh` line. With `core.autocrlf false` in CI, every OS checks out the same bytes, so the step 3 hashes and profiles agree.

**Windows specifics.**

- Binary mode and UTF-8 on the engine's pipes, and the stdin thread, are above. `-X utf8` and `PYTHONUTF8=1` keep the engine's own `open()` calls off the console code page (D-42). The worker (step 4) gets `-X utf8` on its own command line, because `-I` ignores `PYTHONUTF8`.
- `Bun.spawn` finds `uv.exe` on PATH. An `RLMH_ENGINE` that is a `.cmd` or `.bat` needs `cmd /c` in front. Paths may hold spaces: `findEngine` returns an argv array, so only `RLMH_ENGINE` text needs quotes.
- Ink must be checked in Windows Terminal and in the PowerShell console, under Bun and in the compiled binary. If it fails on Bun 1.4.4 there, stop and tell Rishi; do not switch to OpenTUI (2a) on your own.
- If `bun build --compile` fails with `Could not resolve "react-devtools-core"`, add it as a dev dependency (or pass `--external react-devtools-core`) and write that down in progress.md.

## Tasks

> Built on 2026-10-30 in a Linux cloud container (Bun 1.4.4 and uv on PATH), not on Rishi's PC. The checks below marked "on the PC" or "in Git Bash" ran there in bash, and CI repeats them on `windows-latest`, `macos-latest` and `ubuntu-latest`. Rishi marked the step done without the PC-only checks.

1. [x] Set row 2 in `progress.md` to `in progress`. In PowerShell run `$env:Path = "F:\Personal\RLM\rlm-harness\.bun\bin;$env:Path"`; `bun --version` must print `1.4.4`, and `uv --version` must work.
2. [x] Engine first. Write `pyproject.toml`, run `uv lock`, then `errors.py`, `__init__.py`, `link.py`, `appport.py`, `service.py`, `__main__.py`, with `conftest.py`, `fakeapp.py` and `test_link.py` beside them. Run `uv run --project engine pytest engine/tests`.
3. [x] Check by hand in Git Bash: `echo '{"jsonrpc":"2.0","id":1,"method":"engine.info","params":{}}' | uv run --project engine python -X utf8 -m rlm_engine serve` prints one JSON line, exit 0.
4. [x] App next. Write `package.json`, run `bun add --exact ink react` and `bun add -d --exact @types/bun @types/react typescript`. Write `tsconfig.json`, `version.ts`, `paths.ts`, `protocol.ts`, `link.ts`, `bus.ts`, `settings.ts`, `engine.ts`, `main.ts`, `interface/App.tsx`, then `link.test.ts`, `settings.test.ts` and `engine.test.ts`.
5. [x] Write `protocol/examples.json` from architecture §4 to §5.3 (copy the §6.2 tool text exactly), then `test_protocol.py` and `protocol.test.ts`. Fix the examples or the docs, whichever is wrong, until both pass. If architecture.md is wrong, change it and log that in progress.md.
6. [x] In `app/`: `bun run typecheck`, `bun test`. Then from source: `bun run src/main.ts info`, `--version`, `--help`, `--bogus` (exit 2), `info --verbose`.
7. [ ] *(Not run: PC only. The Linux binary passed the same checks in the cloud container, and CI compiles and smoke-tests `rlmh-windows-x64.exe` on `windows-latest`. Rishi marked step 2 done without it, 2026-10-30.)* Compile on the PC: `bun run build` (the `package.json` script, with the D-44 flags), copied to `../dist/rlmh-windows-x64.exe`. Run its `--version`, then `info` with `$env:RLMH_ENGINE = "uv run --project engine python -X utf8 -m rlm_engine serve"`, then `info` without it (exit 1).
8. [ ] *(Not run: PC only. In a Linux pseudo-terminal, from source and as the binary, the line shows and `q` and Ctrl+C both exit 0. Rishi marked step 2 done without the Windows check, 2026-10-30.)* Open `rlmh` (from source, then the `.exe`) in Windows Terminal and in the PowerShell console. Check the line appears, `q` exits, Ctrl+C exits, and the shell works normally afterwards. No WSL.
9. [x] Write `.github/workflows/ci.yml` and the `.gitignore` lines. Run every CI command by hand on the PC first (bash syntax).
10. [ ] Ask Rishi for leave to commit and push a branch so CI can run. Never commit or push without it. After a yes, watch with `gh run watch`, and fix and re-push until all three jobs pass.
11. [ ] Run the checks under "Done when". Update `progress.md`.

## Tests

All offline. Python tests are plain functions that call `asyncio.run` through a `run(coro, timeout=10)` helper (no pytest plugin). `conftest.py` provides `run`, `pipes()` (two `os.pipe()` pairs returned as unbuffered binary files, one for the Link and one for a raw test peer) and `EngineProc` (spawns `[sys.executable, "-m", "rlm_engine", "serve"]` with `PYTHONUTF8=1`, with `send`, `recv(timeout)`, `close_stdin`, `wait` and `stderr_text`). `fakeapp.py` holds `FakeApp(AppPort)`: it records `completes`, `approvals`, `events` and `cancelled`, answers `complete` with a valid `model.complete` result whose `text` is the last message with `ping` turned into `pong`, and takes optional `complete=` and `approve=` callables (step 6 adds `script=`).

### `engine/tests/test_link.py`

| Case | Asserts |
|---|---|
| `request_result` | A registered method answers; `jsonrpc`, the id (int and str) and `result` come back; `None` becomes `null` |
| `errors` | Unknown method -32601; JSON array -32600; bad JSON and invalid UTF-8 -32700 with `id: null`; non-object params -32602; handler `RpcError(-32012, data)` keeps code and data; `ValueError` -32603; the link keeps serving after each |
| `notification_no_reply` | A notification runs its handler and writes nothing; the next line is the next request's answer |
| `both_ways_interleaved` | The peer sends request A; A's handler calls `link.request`; the peer sees `e1`, sends request B and gets B's result, answers `e1`, then gets A's result. The line order is asserted |
| `slow_handler_does_not_block` | While one handler waits on an event, a second request is answered |
| `concurrent_requests` | 20 concurrent `link.request` calls use `e1` to `e20`; answered in reverse, each future gets its own result |
| `error_response_raises` | A peer error becomes `RpcError` with code, message and data |
| `utf8_and_long_lines` | `é`, an emoji, U+2028 and `\r\n` inside strings, and a 2 MiB string, round trip byte-exact both ways; a lone surrogate leaves as `\ud800`; no `0x0D` byte is ever written |
| `line_too_long` | With `max_line_bytes=1024`, a 2000-byte line gets -32600 with `id: null`, and the next request works |
| `eof` | Closing the peer: a pending request raises `RpcError(-32800)`, a running handler is cancelled, both `on_close` callbacks run in order (the first raises), `serve()` returns |
| `notify_threadsafe` | 50 `notify` calls from another thread arrive complete and in order |
| `link_app_port` | -32001 gives `ModelError` with kind, status, provider, model; -32800 gives kind `cancelled`; `approve` denies on `RpcError`; `event` and `cancel_calls` write the right notifications |
| `process_info` | Real `serve` (no `RLMH_DEBUG`): `engine.info` has exactly the seven keys of §5.1 with `contract` null and `profiles == []`; `debug.roundtrip` is -32601 |
| `process_roundtrip` | With `RLMH_DEBUG=1` and `count=8`: eight `model.complete` requests `e1` to `e8` with `run_id "debug"`; the test answers them out of order, with an `engine.info` request in between, and gets `texts` in order. A -32001 answer (kind `rate_limit`) for one makes `debug.roundtrip` fail with -32001 and that `data.kind` |
| `process_stdout_clean` | Every stdout line of the two cases above is a JSON-RPC object; `python -c` calling `claim_stdio()` then `print("stray")` leaves stdout without it and puts it on stderr |
| `process_stdin_close` | Closing stdin, even with a `model.complete` unanswered, exits 0 within 5 s with no further stdout |

### `app/test/link.test.ts`

The same cases as `request_result` to `notify` (no thread case) against `Link`, with two Links wired by stream pairs (the fake engine uses `idPrefix: "e"`), plus these.

| Case | Asserts |
|---|---|
| `split_chunks` | A message split mid-UTF-8 character across chunks parses; two messages in one chunk both arrive |
| `abort_and_close` | An aborted `signal` rejects with -32800 and a late answer is ignored; a handler's `ctx.signal` aborts on close; `closed` resolves; `request` after close rejects |
| `notification_listeners` | `"*"` gets `(method, params)` in order; the unsubscribe function works; a throwing listener does not stop the next |
| `bus` | `Bus.on/emit` delivers; unsubscribe works; a throwing listener does not stop the others |

### `engine/tests/test_protocol.py` and `app/test/protocol.test.ts`

Both suites read `protocol/examples.json` and hold the same required-name list, taken from the table above.

| Case | Asserts |
|---|---|
| `file_shape` | Top-level `protocol == 1` (equals `PROTOCOL_VERSION`); each entry has exactly `name`, `direction`, `kind`, `message`; unique names; the name's second part equals `kind` |
| `coverage` | Every required name exists; no example names a method outside §5; every §3 error code appears in an error example and matches its name |
| `classify` | `classify(message) == kind`; `jsonrpc == "2.0"`; id types and `e<n>` form per direction |
| `pairing` | Each result or method error has a request example of the same method with the same id |
| `round_trip` | Dump, then parse, equals the original; the dumped line holds no raw `\n` |
| `fields` | `params` and `result` keys per `<method>:<kind>` equal the §5 tables (required and optional; extra keys fail). Shared types are checked deep: ModelRef, Message (the four roles), ToolCall, ToolDef, Usage (the six keys), ModelErrorData (`kind` in the §4 list), Origin, Batch, and the enums `thinking`, `finish_reason`, `permission_mode`, `call_format`, `status` |
| `python_tool` | `tools[0]` in `model.complete:request:root` equals the §6.2 JSON, key for key |
| `constants` | Python: `link.py` constants equal §3. TS: `ErrorCode` equals §3 |

### `app/test/engine.test.ts`

Tests that start the real engine (via `uv run`) get a 120 s timeout. `RLMH_HOME` points at a temp folder throughout.

| Case | Asserts |
|---|---|
| `split_command` | Quotes, single quotes, a quoted Windows path with spaces, empty input; an unbalanced quote throws and names `RLMH_ENGINE` |
| `discovery_order` | `RLMH_ENGINE` beats a checkout (cwd `process.cwd()`); without it, the `uv run --project <root>/engine …` command with cwd `<root>`; with `sourceDir` set to a `$bunfs` path or an empty folder, `EngineNotFound` names `RLMH_ENGINE` and `rlmh setup` |
| `child_env` | `OPENAI_API_KEY`, `github_token`, `MY_SECRET` are dropped, `PATH` stays, `RLMH_HOME` and `PYTHONUTF8` are set |
| `real_engine_info` | `fetchInfo` returns `version == APP_VERSION`, `protocol == 1`, `python` matching `^3\.12\.`, `contract` null, `profiles == []`. `kill()` ends it and `exited` resolves within 10 s |
| `real_engine_roundtrip` | With `RLMH_DEBUG=1` and a `model.complete` handler that answers `pong i` after random delays, `debug.roundtrip` with `count: 20` returns the 20 texts in order, while a parallel `engine.info` is answered |
| `model_error_passthrough` | A handler throwing `RpcError(-32001, …, {kind: "rate_limit", …})` for one call makes the request reject with -32001 and that `data.kind` |
| `stderr_and_exit` | `onStderr` and `stderrTail()` see engine stderr lines; closing the engine mid-request rejects the pending request with -32800; stdin close gives exit code 0 |
| `protocol_mismatch` | A fake engine (`process.execPath -e …`) answering `protocol: 2` makes `fetchInfo` throw `ProtocolMismatch` |
| `versions_agree` | `package.json`, `pyproject.toml`, `APP_VERSION` and the engine's `version` are equal |

### `app/test/settings.test.ts`

| Case | Asserts |
|---|---|
| `home` | `RLMH_HOME` wins and is made absolute; empty is ignored; the default is `join(os.homedir(), ".rlm-harness")`; each §9 path helper returns the §9 name |
| `defaults` | `defaultSettings()` and `getSetting` give every §8 default |
| `save_load` | A missing file loads defaults; save then load round trips (including `providers.local.max_in_flight`); the file has `\n` endings and no `.tmp` is left |
| `set_setting` | Each enum rejects a bad value with the allowed values in the message; bool takes `true`/`false`; ints reject `0`, `-1`, `1.5`, `abc` and accept `32`; an unknown key and a bad provider id are errors; the input object is unchanged |
| `load_errors` | Bad TOML, an unknown key and a wrong type each throw `SettingsError` naming the file and key; the file is not rewritten |

## Done when

> Built on 2026-10-30 in a Linux cloud container (Bun 1.4.4 and uv on PATH), not on Rishi's PC. The checks below marked "on the PC" or "in Git Bash" ran there in bash, and CI repeats them on `windows-latest`, `macos-latest` and `ubuntu-latest`. Rishi marked the step done without the PC-only checks.

- [x] `uv run --project engine pytest engine/tests` and, in `app/`, `bun run typecheck` and `bun test` pass on the PC.
- [x] `grep -rL "KV cache:" app/src engine/rlm_engine --include=*.ts --include=*.tsx --include=*.py` prints nothing, and `git status --short` shows only the paths in architecture §2 for step 2 (`.gitattributes` among them), plus `.gitignore`, `progress.md` and the already untracked `documentation/v0/`.
- [x] The Git Bash check in task 3 prints one JSON line and exits 0.
- [x] `bun run src/main.ts info` (no `RLMH_ENGINE`) prints JSON with `"protocol": 1`, a `3.12.x` Python, `"contract": null` and `"profiles": []`.
- [ ] One CI run is green on `ubuntu-latest`, `macos-latest` and `windows-latest`. Its log on each OS shows `rlmh 0.1.0` and the `info` JSON, and the run lists three artifacts: `rlmh-linux-x64`, `rlmh-darwin-arm64`, `rlmh-windows-x64` (artifact names carry no `.exe`, as the CI section and step 10 say; the file inside is `rlmh-windows-x64.exe`). `test_link` passed in each job.
- [ ] *(PC only, not run; see tasks 7 and 8.)* On the PC, `dist\rlmh-windows-x64.exe --version` prints `rlmh 0.1.0`, and with `RLMH_ENGINE` set `info` prints the engine JSON. `rlmh` opens its line in Windows Terminal and in PowerShell, `q` and Ctrl+C both quit, and nothing needs WSL.

## Out of scope

- Contract, `contract_hash`, profiles and `engine.info`'s real fields: step 3. The worker, tools and permissions: step 4. The gateway, keys, the catalog and the fake provider: step 5.
- `run.start`, `run.cancel`, `run.vars` and every event: until step 6 they exist only as examples and types. Error codes -32010 to -32012 exist but nothing raises them yet.
- `Session`, `rlmh run`, `batch`, `config`: step 6. The real interface and `ink-testing-library`: step 7.
- The installed-engine lookup, `rlmh setup`, `release.yml`, `install.*` and the `darwin-x64` binary: step 10.

## Hand-off

- **Step 3** edits `service.py` (`Engine.info`) and adds `rlm_engine/contract.py` and the rest; `Engine.home` is already there. It can compare `PYTHON_TOOL` with the `model.complete:request:root` example.
- **Step 5** uses `Link`, `RpcError`, `Bus`, the `protocol.ts` types, `settings.ts` (it adds the provider-list check) and `paths.ts`. `debug.roundtrip` plus a `model.complete` handler is its way to test the gateway through the real engine.
- **Step 6** builds `Session` on `findEngine`, `startEngine`, `fetchInfo`, `Link` and `Engine.register`; it adds the `run.*` handlers, and must subscribe to events before sending `run.start` (rule 10).
- **Step 10** fills `findInstalledEngine`, adds the `darwin-x64` job and `release.yml`.
- **progress.md:** row 2 becomes `review` when CI is green and the PC check is done, and `done` when Rishi has seen the screen. The log line gives: exact `ink`, `react`, `typescript`, `@types/*` versions; the action versions used; the first green CI run; the `react-devtools-core` outcome; and any edit to architecture.md.

## If a decision goes the other way

Every decision below was settled at step 1 (2026-10-30; [decisions.md](../decisions.md) S-22 to S-34). Each line names the pick and says what would change if Rishi reversed it. Picks that went the alternative way are already written into this spec.

- **2a, OpenTUI** (settled: Ink, S-23): replace `ink` and `react` with OpenTUI's packages, rewrite `App.tsx` (still one line, `q` and Ctrl+C quit), and revisit the `tsconfig` `jsx` setting. OpenTUI has a native core, so first check that `bun build --compile` embeds it on all three CI targets. Everything else is unchanged.
- **2b, each OS's folder** (settled: `~/.rlm-harness/`, S-24): only `home()` in `paths.ts`, the fallback in `service.py`, and the `home` case in `settings.test.ts` change: `%APPDATA%\rlm-harness`, `~/Library/Application Support/rlm-harness`, or `$XDG_CONFIG_HOME` / `~/.config` plus `rlm-harness`. `RLMH_HOME` still wins.
- **6b, fenced everywhere** (settled: native for API models, S-30): `call_format` defaults to `fenced` in `SCHEMA`, and the `defaults` test follows.
