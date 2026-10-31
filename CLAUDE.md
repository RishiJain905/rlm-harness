# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working style: keep going, stop only when needed

- **When a step doesn't need Rishi's input, keep going.** Put status notes in the same message as your next action, not in a separate message that ends your turn.
- **Stop and ask only** when you can't continue without Rishi, or **before anything destructive**: deleting data, force-pushing, or changing anything outside this repository.
- **End every task run with three headings: Blocked on me, Changed, Found.** A task run is work: building, running pipelines, editing files, phase work. These go into the end-of-run summary, alongside the usual content (checkpoint output, commands to run, next step). They don't replace it. **Not for plain questions:** when Rishi just asks something, answer it directly without the headings.
  - **Blocked on me:** what needs Rishi before work can continue: decisions, approvals, env-file fixes. Write "Nothing" if nothing is blocked.
  - **Changed:** what the run changed: code, docs, config, data on D:, the Neo4j graph, W&B runs, commits and pushes (with hashes).
  - **Found:** what the run learned or noticed: data quirks, bugs, surprises, results worth knowing, risks for later phases.
- **A waiver never covers the Security section or the destructive actions above.** Those always need an explicit, case-by-case OK.

## What this repo is

`rlmh` is a model-agnostic harness for Recursive Language Models: the model never reads a long input directly; it writes Python against it in a REPL, hands pieces to sub-calls (`llm`, `llm_batch`), and calls `submit`. Any provider can be the root or sub-call model, including the RL-trained Qwen LoRA from the training repo ([RishiJain905/RLM](https://github.com/RishiJain905/RLM), local at `F:\Personal\RLM\RLM`).

**Status: building v0.** Steps 1 to 6 are done. Step 2 (2026-10-30): `app/` and `engine/` exist, the link works both ways, `rlmh info` and `--version` work, and CI builds and tests `rlmh` on three OSes. Step 3 (2026-10-31): `contract.py` (prompt v4, hashing to `TRAINING_HASH`), `callformat.py` and `profiles.py` with the `training-v4` and `default` built-ins; `engine.info` reports them. Step 4 (2026-10-31): the native REPL worker (`worker/worker.py`, `manager.py`), the training tools plus `fetch` (`worker/tools.py`), the audit hooks (`worker/hooks.py`), `permissions.py`, `bridge.py` and `workspace.py`, green on three OSes. Step 5 (2026-10-31): the model gateway in `app/src/gateway/` (providers, keys, catalog, usage, cache, the `openai` and `@anthropic-ai/sdk` clients, the scripted fake and `gateway.ts`), the bundled catalog `app/catalog/models.json` (391 models from OMP `c29f7c5`), and `app/test/fakes/http.ts`. Step 6 (2026-10-31): the loop (`loop.py`, training's `run_episode`), `inputs.py`, `runlog.py` and `run.start`/`run.cancel`/`run.vars` in `service.py`; `session.ts` and `rlmh run`, `rlmh batch` and `rlmh config` (`app/src/cli/`), with `--json`. Steps 7 (interactive view) and 8 (parity) are next and can run in parallel. The v0 spec was frozen at step 1, and `documentation/` holds the design and a v0 build kit; code lands in ten steps. Native on macOS, Windows and Linux, with no Docker and no WSL. Rishi's machine is Windows 11, the riskiest OS for this design.

## Working on a v0 step

The build kit in `documentation/v0/` is written so one thread can build one step without asking.

- **Read order:** `documentation/v0/README.md`, then `v0/architecture.md` (pins every shared path, message and signature), then `v0/decisions.md`, then your spec in `v0/specs/` and the parent-doc sections it lists under "Read first".
- **Which doc wins:** spec, then `v0/architecture.md`, then `documentation/legacy/v0-design.md` for gaps. If `v0/architecture.md` contradicts a parent doc (`documentation/legacy/architecture.md`, `v0-design.md`, `v0-build-plan.md`), the parent wins and `v0/architecture.md` gets fixed.
- **`v0/progress.md`:** a step starts only when every step it depends on is `done` (or `review` if Rishi says so). Re-read the file just before editing it, change only your own row, and add a log line.
- **New calls** go into `decisions.md` as the next D-number (D-98 is the latest). Changing a shared interface (a §7 signature, a wire message, a path) means updating `v0/architecture.md` too and saying so in the log.
- **Decisions:** step 1 settled every open decision (S-22 to S-34 in `decisions.md`). Three went the alternative way: 1a MIT, 4b `accept-edits` as the default mode, and 9a two API models with slot b forced to fenced. Step 9 still asks which two API models before it estimates.
- **Training sources.** Copied code comes from the RLM repo at `0b9af69`. On Rishi's PC: `git -C F:\Personal\RLM\RLM show 0b9af69:<path>`. In a cloud container the repo is public: clone it outside this repo with `git clone --filter=blob:none --no-checkout https://github.com/RishiJain905/rlm <dir>`, then `git -C <dir> show 0b9af69:<path>`. Never write into it. Produce expected test strings by running training's own function from a scratch copy, never by typing them.
- **Network in a cloud container** is limited. Reachable: platform.claude.com (append `.md` to a docs URL for clean text), raw.githubusercontent.com, registry.npmjs.org and git over github.com. Blocked at step 5 (2026-10-31): api-docs.deepseek.com, openrouter.ai, ai.google.dev, platform.openai.com and bun.com. A "verify at build" fact on a blocked host keeps the spec's value and is logged as not re-checked (S-37).
- **"OMP" in these docs** means the oh-my-pi repo, the MIT source of the model catalog and some ideas. It is not a reason to run `omp`.

## Architecture

Three processes, one per layer:

```
rlmh (Bun 1.4.4: Ink UI, CLI, model gateway)
  └─ engine  python -X utf8 -m rlm_engine serve   JSON-RPC 2.0 over the engine's stdin/stdout, one object per line
       └─ worker.py, one per run                  JSON lines over the worker's stdin/stdout
```

- **The link carries requests both ways.** App → engine: `engine.info`, `run.start`, `run.cancel`, `run.vars`. Engine → app: `model.complete`, `approval.request`, plus `run.*` event notifications. `protocol/examples.json` holds one example of every message, and both test suites check it, so change it with any wire change. `PROTOCOL_VERSION = 1` lives in both `app/src/version.ts` and `engine/rlm_engine/__init__.py`.
- **Engine stdout carries protocol only.** `claim_stdio()` points fd 1 at stderr, so a stray `print` can't corrupt the link. Logs go to stderr. Stdin is read on a thread, because asyncio pipe reads are unreliable on Windows.
- **Only the app talks to providers.** All model calls go through `app/src/gateway/`. The engine asks with `model.complete`, and neither the engine nor the worker ever holds a key.
- **The model has exactly one tool, `python`** (S-09). Don't add Read- or Bash-style tools: they would let the model pull files into its prompt instead of delegating through sub-calls.
- **Runs are one-shot.** One task gets a fresh worker and then an answer. The engine keeps no state across runs (S-11, D-35).
- **Two call formats.** `native` (a `python` tool call) is for API models, and `fenced` text is for the LoRA and local models. The app resolves `auto` before `run.start`.
- **The contract is copied from training, not imported.** Prompt v4, the worker, the tools and the loop are copied from the RLM repo at commit `0b9af69`. Prompt v4 is frozen: `test_contract` pins its hash to `TRAINING_HASH` (S-14), because the LoRA only works on those exact bytes. The `training-v4` profile must hash to it. `default` is training-v4 plus `guidance.md`.
- **Engine discovery order:** `RLMH_ENGINE`, then a source checkout (`uv run --project engine …`), then the installed engine in `<home>/engine/<version>`.
- **Runtime home:** `RLMH_HOME`, else `~/.rlm-harness/`. It holds `settings.toml`, `key-index.json`, `runs/<batch>/runs.jsonl` and `scratch/<run_id>/`.
- **Shared fakes:** `fake/scripted`, driven by the JSON file in `RLMH_FAKE_SCRIPT`, serves steps 6, 7 and 10 and CI. Engine-side tests use `engine/tests/fakeapp.py:FakeApp` instead of a pipe; `FakeApp(script=…)` reads the same §7.5 script format and records every request in `requests`. CLI tests use `app/test/cli/helpers.ts` (`rlmh(...)` runs `src/main.ts` with a temp home and a key-free env). App-side gateway tests use `app/test/fakes/http.ts` (a fake provider on `127.0.0.1`, port 0, with `redirectFetch`) and `app/test/gateway/helpers.ts` (`rig()`, `params()`, `recordSleeps()`); every retrying test replaces `RETRY.sleep`, so nothing waits.
- **Parity (step 8) and smoke (step 9) scripts** live in `F:\Personal\RLM\RLM\scripts\`, never here. They import nothing from this repo.

## Commands

These work since step 2. On Rishi's PC, Bun 1.4.4 is installed in-repo at `.bun/`, which is git-excluded through `.git/info/exclude`, not `.gitignore`. If `bun` isn't on PATH, use `.bun\bin\bun.exe` (from `app/`, `..\.bun\bin\bun.exe`). Python 3.12 comes through uv. In a Linux cloud container, `bun` 1.4.4 and `uv` are already on PATH; there is no PowerShell, so only `verify.sh` runs there.

| What | Command |
|---|---|
| Verify gate | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1`, or `bash scripts/verify.sh` |
| Engine tests | `uv run --project engine pytest engine/tests -q` |
| One engine test | `uv run --project engine pytest engine/tests/test_contract.py::test_hash_matches_training -q` |
| Contract against training | set `RLM_TRAINING_REPO` to an RLM checkout, then `uv run --project engine pytest engine/tests/test_contract.py -q` (`test_against_training_source` is skipped without it) |
| App typecheck and tests (in `app/`) | `bun run typecheck`, `bun test` |
| One app test file or test (in `app/`) | `bun test test/gateway`, `bun test -t "<name>"` |
| App from source (in `app/`) | `bun run src/main.ts info`, plus `--version`, `run …`, `batch …`, `config list` |
| A run on the fake provider (in `app/`) | `RLMH_HOME=<tmp> RLMH_FAKE_SCRIPT=<script.json> bun run src/main.ts run --question Q --input <file> --root fake/scripted --json`; the script format is architecture.md §7.5, and the record lands in `<tmp>/runs/cli/runs.jsonl` |
| Compiled binary (in `app/`) | `bun run build`, which writes `../dist/rlmh` |
| Rebuild the catalog (in `app/`) | `bun run scripts/build-catalog.ts --commit <OMP sha>`, or `--file <path> --commit <sha>`. The only code here that touches the network, and only when a developer runs it. Run it twice and compare `sha256sum catalog/models.json` |
| Permission hand check (step 4) | `uv run --project engine python engine/tests/test_permissions.py --mode default --repo <dir> --cell "<code>" …`: a real worker, bridge and permissions; it prints each `approval.request` and reads `y`, `a` or `n`. Without `--repo` it runs read mode in a temp folder |

- **Engine by hand (Git Bash):** `echo '{"jsonrpc":"2.0","id":1,"method":"engine.info","params":{}}' | uv run --project engine python -X utf8 -m rlm_engine serve`.
- **Use a temp home.** Point `RLMH_HOME` at a temp folder for any manual run or test, so nothing lands in the real `~/.rlm-harness/`. `RLMH_DEBUG=1` registers `debug.roundtrip` for the link tests.
- **Dependencies:** add packages with `bun add --exact`, and commit `app/bun.lock` and `engine/uv.lock`. The engine uses the standard library only at run time, with pytest in the dev group. No linter is specified; for TypeScript, `tsc --noEmit` is the check (`typescript` 7, the native compiler). `react-devtools-core` is a dev dependency only so `bun build --compile` can resolve Ink's devtools import (D-56).

## Conventions

- **Cache note.** Every module starts with a one-line KV-cache note: `KV cache: none`, or `KV cache: <what bytes it can change and how it keeps them stable>`.
- **Copied training code** keeps training's names, text and comments. Its module docstring names the source file and commit `0b9af69`. In `worker/worker.py` and `worker/tools.py`, annotations are frozen training text that `help()` shows, so they stay unquoted.
- **Python** uses type hints and `from __future__ import annotations`, except in those two files.
- **Worker-side modules** (`worker/worker.py`, `hooks.py`, `tools.py`) run inside the worker under `-I` and import only each other and the standard library, never `rlm_engine`. A git or shell call a tool makes for itself runs inside `tools._quiet()`, or the audit hook asks for it. **TypeScript** runs in strict mode with ES modules and no default exports, and only `.tsx` files import Ink.
- **UTF-8 mode.** Every engine and worker command gets `-X utf8`, and the engine also gets `PYTHONUTF8=1`. The worker is launched as `python -I -B -X utf8 <dir>/rlm_engine/worker/worker.py`, not with `-m` (D-01, D-42).
- **Line endings.** The repo stays LF (`.gitattributes`, D-43). Files the model reads are written as bytes or with `newline=""`.
- **Paths.** Use `pathlib` and `node:path`. Paths the model sees always use `/`, on every OS (D-17).

## Security

This repo is public, and `rlmh` holds other people's API keys and runs model-written code on their machines.

- **Never commit** keys, transcripts, gold answers, task data, run logs (`runs.jsonl`), or parity and smoke outputs. Those stay in the RLM repo, under the git-ignored `results/harness-*/`, and on Rishi's PC.
- **Never make a call with a user's key that they didn't ask for.** That means no validation calls and no pings: saving a key makes zero network requests, and a gateway test checks it. The gateway's only non-model request is "Refresh models", on click. `app/scripts/build-catalog.ts` is the only code that may touch the network, and only when a developer runs it.
- **Tests run offline against fakes:** a fake HTTP server, `fake/scripted` and `FakeApp`, never a real provider. Fake keys in tests must contain `FAKE` (for example `sk-ant-FAKE…`) so the gate's secret scan lets them through.
- **Keys live only in the app.** They're stored in `Bun.secrets` (service `rlm-harness`, entry `<provider>:<id>`), with an owner-only `keys.json` as the fallback. `key-index.json` never holds a key. A key never appears in `run.start`, events, the run log, stderr or an error message.
- **Strip key-like env vars at both hops.** The app removes variables whose names match `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH` (any case) before it starts the engine, and the engine removes them again for the worker (D-29). Git's `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` set goes as a whole at both hops, because git refuses a partial set (D-62). Keep both when you change how a process is launched.
- **The SDKs read env vars themselves** (D-76). The gateway always passes `apiKey` and `baseURL`, `organization: null, project: null` to OpenAI, `logLevel: "off"` to both, and pins `anthropic-version: 2023-06-01`. Keep all of these when you change how a client is built, or a user's `OPENAI_ORG_ID` or `ANTHROPIC_AUTH_TOKEN` reaches the wrong provider.
- **No subscription logins** (Claude Pro or Max OAuth), and nothing that imitates Claude Code to Anthropic's servers (S-07).
- **Permission prompts stop accidents, not attackers.** They come from PEP 578 audit hooks with three modes: `default`, `accept-edits` and `bypass`. Don't describe them as a sandbox. Non-interactive runs deny anything that would ask (D-15). The default mode is `accept-edits` (4b, S-27), and changing it is Rishi's call.
- **Binary build flags.** Compiled binaries always use `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, so `rlmh` never loads a `.env` (keys) or a `bunfig.toml` preload (code) from the folder it runs in (D-44).
- **Spending.** Step 9 spends Rishi's own API keys, and only after he has seen the estimate and said go. Nothing here uses W&B credit.
- **Git and releases.** Never commit or push without Rishi's say-so. Each push, tag, release and `workflow_dispatch` run is its own OK.
- **The RLM repo is outside this repo.** Changes there, such as the D-46 `.gitignore` line, need Rishi's OK first.

## Verify gate

`scripts/verify.ps1` (Windows PowerShell 5.1) and `scripts/verify.sh` (Git Bash, macOS, Linux) are the passing gate. Both run offline, and the last line is the verdict: `VERIFY: PASS` (exit 0) or `VERIFY: FAIL (<stages>)` (exit 1).

| Stage | Checks |
|---|---|
| `secrets` | Key-shaped strings (`sk-…`, `AIza…`, `gh?_…`, `hf_…`, private-key blocks) in tracked or untracked, not-ignored files, skipping lines that contain `FAKE`. Also fails on any `.env*` file (except `.env.example`), `keys.json`, `key-index.json` or `runs.jsonl` |
| `engine-tests` | `uv run --locked --project engine pytest engine/tests -q`. `--locked` also fails when `uv.lock` is out of date |
| `app-typecheck` | `bun run typecheck` in `app/` |
| `app-tests` | `bun test` in `app/` |

- **When to run it:** run the full gate before saying a step or task is done, and before asking Rishi to commit. Read the verdict and the FAIL blocks; for detail on one failing test, rerun just that test.
- **Scoped runs.** While iterating, pass a path: `scripts\verify.ps1 engine/tests/test_link.py`, or `app/test/gateway`. Only a full, unscoped PASS ends a task.
- **SKIP lines.** The engine and app stages print SKIP only when `engine/pyproject.toml` or `app/package.json` is missing. Both exist since step 2, so a PASS needs all four stages to run. Never add a skip or an exclusion to turn a FAIL into a PASS.
- **What it doesn't replace:** a spec's "Done when" list. Compile checks, hand checks, Windows Terminal checks and green CI on three OSes still apply.
- **New behaviour needs a test the gate runs.** A new check, such as a linter, goes into both scripts as a new stage.
- **Repeated failures.** If the same failure survives two fixes, stop patching and re-diagnose from first principles.
