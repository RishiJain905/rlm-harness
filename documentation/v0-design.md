# v0 design

> Updated 2026-10-20 for the Bun app and Python engine split, for review before anything is built. The overall picture is in [architecture.md](architecture.md).

## Goal

Run any OpenAI-compatible model as an RLM root, with any model for sub-calls, from a terminal command that shows the run live. With the default profile, the root sees exactly the messages the trained LoRA saw in training (prompt v4). It works on long text (read mode, v0a) and then on a code repository (repo mode, v0b).

**Not in v0:**
- The full-screen TUI, the web UI, `rlm()` recursion and a native Anthropic client (v1).
- Harness² (v2).
- The Windows desktop app, and a sandbox without WSL (v3). v0 needs Linux or WSL2 with Docker, like training.
- MCP (deferred).
- Grading. This repo never holds gold answers; scoring stays in the RLM repo.

## Layout

One repo, two folders:

```
rlm-harness/
  engine/                     # Python 3.12, managed with uv
    pyproject.toml            # deps: openai; dev: pytest
    rlm_engine/
      __init__.py             # run(), Result, load_models(), load_profile()
      __main__.py             # python -m rlm_engine serve
      rpc.py                  # JSON-RPC over stdio: requests in, events out
      contract.py             # copy of the RLM repo's bridge.py: prompt v4, limits, observation text, code extraction
      loop.py                 # the run loop: env.run_episode without the training parts
      client.py               # OpenAI-compatible client: root turns, sub-calls, limiter, retries, usage, cost
      config.py               # models.toml and profile folders
      runlog.py               # one JSON line per run
      sandbox/
        docker.py             # copy of sandbox.py, with the EpisodeBridge socket server
        worker.py             # copy of repl_worker.py (runs inside the container)
        tools.py              # copy of repl_tools.py (repo mode, v0b)
        workspace.py          # the repo-copy and diff parts of editbox.py (v0b)
    profiles/default/profile.toml
    tests/
  app/                        # TypeScript on Bun
    package.json              # bin: rlmh; no runtime dependencies in v0
    src/
      cli.ts                  # argument parsing and the commands
      engine.ts               # starts the engine, sends requests, reads events
      render.ts               # the live view in the terminal
    test/
  documentation/
```

**Copy, don't import.** The training repo pulls in ART, W&B and the reward code, and it is shaped by training needs. Copying about 3,000 lines keeps the engine light. Two checks stop the copies drifting from training (see Tests).

## The frozen contract (`contract.py`)

This is what the trained LoRA learned, copied from `rlm_rl/bridge.py` at RLM commit `0b9af69`:

- **Names in the REPL:** `context`, `llm`, `llm_batch`, `submit`. Repo mode adds `read_file`, `find_files`, `grep`, `edit_file`, `write_file`, `shell` and `diff`. All are synchronous.
- **Prompt text:** the v4 system prompt, the first user message templates, and every observation and error string.
- **Turn format:** the first fenced `python` block in the reply. As in v3/v4, a `<function=python>` tool-call block is also accepted, because base Qwen sometimes answers that way.
- **Observation:** `REPL output:` cut to 8,000 characters, `(N turns left, M sub-calls left)`, and the last-turn line.
- **Hash:** `sha256` of `PROMPTS["v4"]` must equal `a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6`, the training repo's value.

A profile may append guidance to the system prompt (see Configuration). The default profile appends nothing, so its prompt hashes the same as training.

## App and engine

**How the app finds the engine.** `rlmh` starts the engine as a child process and talks to it over the child's stdin and stdout. In a checkout it runs `uv run --project engine python -m rlm_engine serve`. `RLMH_ENGINE` overrides the command. On Windows the app runs natively and prefixes the command with `wsl -d Ubuntu --`. It also turns Windows paths (the config folder, `--context-file`, `--repo`) into WSL paths, and forwards the key variables named in `models.toml` into WSL through `WSLENV`.

**Protocol.** JSON-RPC 2.0, one JSON object per line. The engine writes only protocol messages to stdout and sends its own logs to stderr, which the app shows with `--verbose`. One engine can hold several runs at once, which is how `rlmh batch --jobs N` works.

Requests from the app:

| Method | Params | Result |
|---|---|---|
| `run.start` | `question` and `context_path` (read mode), or `task` and `repo_path` (repo mode); `root`, `sub` (names in `models.toml`); `profile`; `log_dir` | `{run_id}` |
| `run.cancel` | `run_id` | `{}`; the run then finishes with `infra_error = "cancelled"` |
| `models.list` | none | Model names, endpoints and whether each key variable is set. Never the keys |
| `models.ping` | `name` | `{ok, seconds, error}` from a one-token request |

Events from the engine, all carrying `run_id`:

| Event | Fields |
|---|---|
| `run.reply` | `turn`, the root's reply text |
| `run.cell` | `turn`, `code`, `output` (as the model saw it), `error`, `seconds` |
| `run.subcall` | `turn`, `prompt_chars`, `output_chars`, `seconds`, `error` |
| `run.usage` | Running totals: root and sub-call tokens, `cost_usd`, sub-calls used |
| `run.finished` | `answer`, `submitted`, `turns`, `subcalls`, `cost_usd`, `infra_error`, `log_path` |

The protocol carries what happened, never what to do next: every decision about the model's messages stays in the engine.

## Configuration

Both files live in your own config folder: `~/.config/rlm-harness/` on Linux, `%APPDATA%\rlm-harness\` on Windows, or the folder named by `RLMH_CONFIG`. The app passes that folder to the engine.

**Models: `models.toml`.** Endpoints and the names of key variables, nothing about behaviour.

```toml
[deepseek]
base_url = "https://api.deepseek.com/v1"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"   # the key is read from this variable, never stored
max_in_flight = 16
usd_per_m_input = 0.0              # optional, fill in from the provider's price page for cost in the run log
usd_per_m_output = 0.0

[qwen-local]
base_url = "http://localhost:8000/v1"   # vLLM, Ollama, LM Studio or llama.cpp server
model = "Qwen/Qwen3.8-27B"
api_key_env = "LOCAL_KEY"               # local servers accept any value
extra_body = { chat_template_kwargs = { enable_thinking = false } }   # passed through unchanged
```

Thinking is set per model through `extra_body`, because every provider spells it differently. To match training exactly on repo tasks, the sub-call model needs a second entry with Qwen thinking at "low".

**Profiles: one folder each.** A profile holds behaviour: `profile.toml`, plus an optional `guidance.md`. The engine ships `default`; your own profiles go in `profiles/` in the config folder. The default profile is the training setup:

```toml
contract = "v4"
guidance = ""            # a file appended to the system prompt; empty keeps it identical to training

[root]
temperature = 1.0
[sub]
temperature = 0.3

[read]                   # training v4 read limits
max_turns = 20
max_subcalls = 80
root_max_tokens = 4096
output_max_chars = 8000
cell_timeout_s = 120
subcall_max_chars = 60000
subcall_max_tokens = 4096
subcall_oversize = "error"   # an oversize prompt raises in the REPL, so the model splits it

[repo]                   # training v4 edit limits (v0b)
max_turns = 30
max_subcalls = 80
root_max_tokens = 4096
output_max_chars = 8000
cell_timeout_s = 300
subcall_max_chars = 60000
subcall_max_tokens = 4096
subcall_oversize = "error"
```

Harness² (v2) will edit profile folders, adding `helpers.py`, skills and a sub-call system prompt. v0 reads only what is listed here.

## Interfaces

**CLI (`rlmh`).** The name avoids clashing with other RLM packages.

```
rlmh run --root deepseek --sub deepseek --question "Which ...?" --context-file big.txt
rlmh run --root qwen-local --sub qwen-local --task "Fix the failing test" --repo ./project   # v0b
rlmh batch tasks.jsonl --root deepseek --sub deepseek --jobs 4 --out runs/smoke
rlmh models   # lists models and pings each one
```

`rlmh run` shows the run as it happens: each turn's plan, the code, the output the model saw, a line per batch of sub-calls, and a footer with turns left, sub-calls left, tokens and cost. Ctrl+C sends `run.cancel`. `--quiet` prints only the answer, and `--json` prints the raw events, one per line, for scripts.

Each line of `tasks.jsonl` is `{"id": ..., "question": ..., "context_file": ...}`, with no gold answers. `rlmh batch` shows one status line per run and a summary at the end.

**Python.** The engine can also be imported directly. The RLM repo's parity and grading scripts use this, with no app involved.

```python
from rlm_engine import run, load_models, load_profile

models = load_models()
result = await run(question="Which ...?", context=text,
                   root=models["deepseek"], sub=models["deepseek"],
                   profile=load_profile("default"), log_dir="runs/")
result.answer, result.submitted, result.turns, result.subcalls, result.cost_usd, result.infra_error
```

Repo mode (v0b) is the same call with `task=` and `repo=` (a local path) instead of `question=` and `context=`. The result also carries `diff`.

## Engine components

**Loop (`loop.py`).** This is `env.run_episode` with the training parts removed: token ids, prompt logprobs, reward, detectors, grader, broken-reply redraws and format penalties. What stays:

1. Build the first messages from the contract and the profile.
2. Run each turn: ask the root, extract the code, run the cell, then append the observation.
3. Stop on `submit` or the turn limit.
4. In repo mode, add the pacing line (`pace_message`) that training used from halfway.

A reply with no code block gets the contract's error text and uses up the turn, as in training. The loop emits an event at each of these points; with no app attached, the events go nowhere.

**Client (`client.py`).** One `AsyncOpenAI` client per model entry. It keeps a per-model cap on requests in flight (`max_in_flight`) and retries up to 6 times with jittered backoff from 2 s, on 429s, 5xx errors and timeouts. Root turns send the message list, never storing reasoning text back into it, as in training. Sub-calls send one user message, as in training. Token counts and cost are added up per run.

**Sandbox (`sandbox/`).** This is the training Docker sandbox unchanged: a fresh container per run, `--network none`, a read-only root, CPU, memory and process limits, and the context mounted read-only. The bridge is the only way out, through a Unix socket. The bridge enforces the sub-call budget and the prompt size on the host. The image is built locally from `python:3.12-slim` pinned by digest, with no network during the build.

**Failures.** A cell timeout or REPL crash restarts the container and tells the model, as in training. If a model call still fails after retries, or Docker fails, the run stops with `infra_error` set. The model is never shown a fake answer. If the app exits, the engine sees stdin close, cancels its runs and removes their containers.

**Run log (`runlog.py`).** Each run is one line of `runs/<batch>/runs.jsonl` with these fields:
- **Identity:** run id, harness version, contract and prompt hash, profile name and hash, root and sub model names.
- **Input:** question, context size and sha256 (the context itself is not stored).
- **Trajectory:** the messages, each turn (reply, code, output, error, timings, tokens) and each sub-call (prompt, output, error, seconds).
- **Outcome:** answer, `submitted`, usage, cost, wall time and `infra_error`.

The `runs/` folder is gitignored. The v1 web UI and Harness² (v2) both read these logs.

## Tests

| Test | Checks | Needs |
|---|---|---|
| `test_contract` | Prompt v4 hash equals the training value; code extraction matches training on sample replies | Nothing |
| `test_loop` | A scripted fake root and fake sandbox produce the exact expected messages: counters, last-turn line, no-code error, truncation | Nothing |
| `test_rpc` | `run.start` with fakes emits the events in order and `run.finished` matches the result; nothing but protocol reaches stdout | Nothing |
| `test_sandbox` | `print(len(context))`, `llm` through a fake model, budget exhaustion error, timeout restart text | Docker |
| `test_client` | Retries, the in-flight cap and cost sums, against a fake HTTP server | Nothing |
| `bun test` | The app against a fake engine script: argument parsing, Windows path and `WSLENV` handling, rendering, Ctrl+C sends `run.cancel` | Bun |
| Parity (script in the RLM repo) | Replays recorded training episodes and checks the engine produces identical messages. The recorded replies stand in for the root and the recorded sub-call outputs for the sub model, against the real sandbox and the task's real context | Training transcripts and task data on the PC |

The parity script lives in the RLM repo, because task contexts and transcripts stay there. It imports the engine.

## Build order

Each step ends with its check passing before the next starts.

1. **Skeleton.** The engine answers `models.list` over stdio; `rlmh --help` and `rlmh models` work through it, natively on Windows with the engine in WSL.
2. **Contract.** `contract.py`; `test_contract`.
3. **Sandbox.** Copy the sandbox, worker and bridge, then build the image in WSL; `test_sandbox`.
4. **Client and config.** `models.toml`, profiles, `rlmh models` pings both test models; `test_client`.
5. **Loop, events and run log.** `rlmh run` with the live view; `test_loop`, `test_rpc`, `bun test` and one real run.
6. **Parity.** The script in the RLM repo shows identical messages on 3 recorded read-family episodes.
7. **Smoke run (end of v0a).** `rlmh batch` on 5 held-out context-search tasks with two models, graded by a script in the RLM repo. The report covers accuracy, sub-calls and turns per run, and cost.
8. **Repo mode (v0b).** Add tools, workspace and diff. Parity on 2 recorded edit episodes and one held-out find-and-fix task.

Steps 1 to 6 cost nothing. Step 7 costs whatever the two chosen models charge for 10 runs. It never uses W&B credit.

## Open questions

1. Which two models for the smoke run? I suggest one API model and one local model.
2. Licence: Apache-2.0, the same as Qwen and Harness². This was chosen by default and is easy to change before the first release.
