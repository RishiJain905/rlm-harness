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

**Status: design only.** There is no code yet. `documentation/` holds the design and a v0 build kit, and code lands in ten steps (step 2 creates `app/`, `engine/` and CI). Native on macOS, Windows and Linux, with no Docker and no WSL. Rishi's machine is Windows 11, the riskiest OS for this design.

## Working on a v0 step

The build kit in `documentation/v0/` is written so one thread can build one step without asking.

- **Read order:** `documentation/v0/README.md`, then `v0/architecture.md` (pins every shared path, message and signature), then `v0/decisions.md`, then your spec in `v0/specs/` and the parent-doc sections it lists under "Read first".
- **Which doc wins:** spec, then `v0/architecture.md`, then `documentation/v0-design.md` for gaps. If `v0/architecture.md` contradicts a parent doc (`documentation/architecture.md`, `v0-design.md`, `v0-build-plan.md`), the parent wins and `v0/architecture.md` gets fixed.
- **`v0/progress.md`:** a step starts only when every step it depends on is `done` (or `review` if Rishi says so). Re-read the file just before editing it, change only your own row, and add a log line.
- **New calls** go into `decisions.md` as the next D-number (D-51 is the latest). Changing a shared interface (a §7 signature, a wire message, a path) means updating `v0/architecture.md` too and saying so in the log.
- **Open decisions:** specs assume the default in the open-decisions table. 9a (the smoke-run models) has no default, so step 9 must ask. Step 1 is waiting on Rishi's answers.
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
- **Shared fakes:** `fake/scripted`, driven by the JSON file in `RLMH_FAKE_SCRIPT`, serves steps 6, 7 and 10 and CI. Engine-side tests use `engine/tests/fakeapp.py:FakeApp` instead of a pipe.
- **Parity (step 8) and smoke (step 9) scripts** live in `F:\Personal\RLM\RLM\scripts\`, never here. They import nothing from this repo.

## Commands

None of these work until step 2 lands. Bun 1.4.4 is installed in-repo at `.bun/`, which is git-excluded through `.git/info/exclude`, not `.gitignore`. If `bun` isn't on PATH, use `.bun\bin\bun.exe` (from `app/`, `..\.bun\bin\bun.exe`). Python 3.12 comes through uv.

| What | Command |
|---|---|
| Verify gate | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1`, or `bash scripts/verify.sh` |
| Engine tests | `uv run --project engine pytest engine/tests -q` |
| One engine test | `uv run --project engine pytest engine/tests/test_contract.py::test_hash_matches_training -q` |
| App typecheck and tests (in `app/`) | `bun run typecheck`, `bun test` |
| One app test file or test (in `app/`) | `bun test test/gateway`, `bun test -t "<name>"` |
| App from source (in `app/`) | `bun run src/main.ts info`, plus `--version`, `run …`, `batch …` |
| Compiled binary (in `app/`) | `bun run build`, which writes `../dist/rlmh` |

- **Engine by hand (Git Bash):** `echo '{"jsonrpc":"2.0","id":1,"method":"engine.info","params":{}}' | uv run --project engine python -X utf8 -m rlm_engine serve`.
- **Use a temp home.** Point `RLMH_HOME` at a temp folder for any manual run or test, so nothing lands in the real `~/.rlm-harness/`. `RLMH_DEBUG=1` registers `debug.roundtrip` for the link tests.
- **Dependencies:** add packages with `bun add --exact`, and commit `app/bun.lock` and `engine/uv.lock`. The engine uses the standard library only at run time, with pytest in the dev group. No linter is specified; for TypeScript, `tsc --noEmit` is the check.

## Conventions

- **Cache note.** Every module starts with a one-line KV-cache note: `KV cache: none`, or `KV cache: <what bytes it can change and how it keeps them stable>`.
- **Copied training code** keeps training's names, text and comments. Its module docstring names the source file and commit `0b9af69`. In `worker/worker.py` and `worker/tools.py`, annotations are frozen training text that `help()` shows, so they stay unquoted.
- **Python** uses type hints and `from __future__ import annotations`, except in those two files. **TypeScript** runs in strict mode with ES modules and no default exports, and only `.tsx` files import Ink.
- **UTF-8 mode.** Every engine and worker command gets `-X utf8`, and the engine also gets `PYTHONUTF8=1`. The worker is launched as `python -I -B -X utf8 <dir>/rlm_engine/worker/worker.py`, not with `-m` (D-01, D-42).
- **Line endings.** The repo stays LF (`.gitattributes`, D-43). Files the model reads are written as bytes or with `newline=""`.
- **Paths.** Use `pathlib` and `node:path`. Paths the model sees always use `/`, on every OS (D-17).

## Security

This repo is public, and `rlmh` holds other people's API keys and runs model-written code on their machines.

- **Never commit** keys, transcripts, gold answers, task data, run logs (`runs.jsonl`), or parity and smoke outputs. Those stay in the RLM repo, under the git-ignored `results/harness-*/`, and on Rishi's PC.
- **Never make a call with a user's key that they didn't ask for.** That means no validation calls and no pings: saving a key makes zero network requests, and a gateway test checks it. The gateway's only non-model request is "Refresh models", on click. `app/scripts/build-catalog.ts` is the only code that may touch the network, and only when a developer runs it.
- **Tests run offline against fakes:** a fake HTTP server, `fake/scripted` and `FakeApp`, never a real provider. Fake keys in tests must contain `FAKE` (for example `sk-ant-FAKE…`) so the gate's secret scan lets them through.
- **Keys live only in the app.** They're stored in `Bun.secrets` (service `rlm-harness`, entry `<provider>:<id>`), with an owner-only `keys.json` as the fallback. `key-index.json` never holds a key. A key never appears in `run.start`, events, the run log, stderr or an error message.
- **Strip key-like env vars at both hops.** The app removes variables whose names match `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH` (any case) before it starts the engine, and the engine removes them again for the worker (D-29). Keep both when you change how a process is launched.
- **No subscription logins** (Claude Pro or Max OAuth), and nothing that imitates Claude Code to Anthropic's servers (S-07).
- **Permission prompts stop accidents, not attackers.** They come from PEP 578 audit hooks with three modes: `default`, `accept-edits` and `bypass`. Don't describe them as a sandbox. Non-interactive runs deny anything that would ask (D-15). The default mode is open decision 4b, so changing it is Rishi's call.
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
- **SKIP lines.** The engine and app stages print SKIP until `engine/pyproject.toml` and `app/package.json` exist. After step 2, a PASS needs all four stages to run. Never add a skip or an exclusion to turn a FAIL into a PASS.
- **What it doesn't replace:** a spec's "Done when" list. Compile checks, hand checks, Windows Terminal checks and green CI on three OSes still apply.
- **New behaviour needs a test the gate runs.** A new check, such as a linter, goes into both scripts as a new stage.
- **Repeated failures.** If the same failure survives two fixes, stop patching and re-diagnose from first principles.
