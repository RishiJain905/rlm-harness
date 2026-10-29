# v0 design

> Updated 2026-10-24 as the v0 spec, for review before anything is built. The overall picture is in [architecture.md](architecture.md), and the steps to build this are in [v0-build-plan.md](v0-build-plan.md). Choices still open are marked with their decision number from the build plan (for example 2a).

## Goal

`rlmh` runs any model as an RLM root, with any model for sub-calls, from an interactive terminal app on macOS, Windows or Linux. You install it with one command, paste a key into `/providers` and start. With the `training-v4` profile, the root sees exactly the messages the trained LoRA saw in training. It works on long text (read mode) and on a code repository (repo mode).

**Not in v0:**
- Harness², `rlm()` recursion and follow-up conversation within a run (v1).
- Full TUI polish and the web UI (v2).
- The Windows desktop app (v3).
- MCP (deferred).
- An OS sandbox beyond permission prompts (later).
- Grading. This repo never holds gold answers; scoring stays in the RLM repo.

## Layout

One repo, two halves:

```
rlm-harness/
  app/                          # TypeScript on Bun: the interface and the model gateway
    package.json                # bin: rlmh
    src/
      main.ts                   # entry: interactive app, run, batch, config
      link.ts                   # JSON-RPC over the engine's stdio, both directions
      engine.ts                 # gets Python through uv and starts the engine
      settings.ts               # one schema for /settings and `rlmh config`
      interface/                # Ink screens: prompt box, status line, sub-call panel, approvals, slash commands
      gateway/
        providers.ts            # the provider list and how each one is called
        keys.ts                 # Bun.secrets, with the owner-only file fallback
        catalog.ts              # loads the bundled model catalog
        openai.ts               # every OpenAI-compatible endpoint, through the openai SDK
        anthropic.ts            # Anthropic, through @anthropic-ai/sdk
        cache.ts                # cache markers and the llm_batch prefix rule
        usage.ts                # tokens, cost and cache hits
    catalog/models.json         # bundled catalog data, with its attribution
    test/
  engine/                       # Python 3.12, standard library only
    pyproject.toml
    rlm_engine/
      __main__.py               # python -m rlm_engine serve
      link.py                   # the engine side of the JSON-RPC link
      contract.py               # copy of the RLM repo's bridge.py: prompt v4, limits, texts, code extraction
      callformat.py             # fenced python text, and the native python tool
      loop.py                   # env.run_episode without the training parts
      bridge.py                 # sub-call budget and size limits, and fetch
      permissions.py            # modes and approval requests
      runlog.py                 # one JSON line per run
      worker/
        manager.py              # starts, feeds, times out and restarts the worker
        worker.py               # copy of repl_worker.py; runs as the REPL process
        hooks.py                # audit hooks that raise approval requests
        tools.py                # copy of repl_tools.py, plus fetch
      profiles/
        training-v4/profile.toml
        default/profile.toml, guidance.md
    tests/
  install.sh, install.ps1
  documentation/
```

**Every module starts with a cache note,** as in DeepSeek Harness: one line saying whether the module can change the bytes sent to the model, and if so, how it keeps them stable.

**Copy, don't import.** The training repo pulls in ART, W&B and the reward code. Copying the contract, the worker and the tools keeps the engine small and free of dependencies. Two checks stop the copies drifting from training (see Tests).

## The frozen contract (`contract.py`)

This is what the trained LoRA learned, copied from `rlm_rl/bridge.py` at RLM commit `0b9af69`:

- **Names in the REPL:** `context`, `llm`, `llm_batch`, `submit`. Repo mode adds `read_file`, `find_files`, `grep`, `edit_file`, `write_file`, `shell` and `diff`. All are synchronous.
- **Prompt text:** the v4 system prompts, the first user message templates, and every observation and error string, including the restart texts ("The cell timed out after … The REPL was restarted and all variables were lost").
- **Observation:** `REPL output:` cut to 8,000 characters, then `(N turns left, M sub-calls left)`, and the last-turn line.
- **Hash:** the engine computes its copy's hash the same way the training repo builds `PROMPT_HASHES` (sha256 of the sorted JSON of `PROMPTS["v4"]`). It must equal `a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6`.
- **Repo path:** the v4 repo-mode texts name `/work/repo`, the container path used in training. Decision 3a covers how a native run handles it. The default is to keep the text and have the tools map `/work/repo` onto the real workspace.

## Call formats (`callformat.py`)

| Model | How a turn arrives | How the observation goes back |
|---|---|---|
| API models (decision 6b) | One native tool call named `python`, whose single argument `code` is the cell | As the tool result, with the same observation text |
| The LoRA and local models | The first fenced `python` block in the reply text | As the next user message, exactly as in training |

The engine also accepts a `<function=python>` block written in plain text, as v4 does, because base Qwen sometimes answers that way. A reply with no code uses up the turn and gets the contract's no-code error, as in training. There are no other native tools.

## Profiles

A profile is a folder holding behaviour: `profile.toml` and an optional `guidance.md` appended to the system prompt.

- **`training-v4`:** the exact training text and limits. Parity runs and evaluations use it, and its prompt hashes the same as training.
- **`default`:** v4 plus a short guidance block. The block documents `fetch` and says which shell `shell()` runs on this machine. Its hash differs from training on purpose.

Your own profiles go in `profiles/` in the config folder. Harness² (v1) will edit profile folders, and only levers 3 and 4 (see [architecture.md](architecture.md#why-the-model-makes-sub-calls-instead-of-doing-the-work-itself)).

`training-v4/profile.toml`:

```toml
contract = "v4"
guidance = ""            # empty keeps the prompt identical to training

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

[repo]                   # training v4 edit limits
max_turns = 30
max_subcalls = 80
root_max_tokens = 4096
output_max_chars = 8000
cell_timeout_s = 300
subcall_max_chars = 60000
subcall_max_tokens = 4096
subcall_oversize = "error"
```

`default/profile.toml` is the same with `guidance = "guidance.md"`.

## The link between app and engine

**Processes.** `rlmh` starts the engine as a child process and talks to it over the child's stdin and stdout. The engine starts one REPL worker per run, also as a child process, and talks to it over the worker's stdin and stdout. In a checkout the app runs `uv run --project engine python -m rlm_engine serve`. `RLMH_ENGINE` overrides the command.

**Framing.** JSON-RPC 2.0, one JSON object per line. Both sides send requests, and each side numbers its own. The engine writes only protocol messages to stdout and its logs to stderr, which the app shows with `--verbose`. One engine holds several runs at once, which is how `rlmh batch --jobs N` works.

**Requests from the app to the engine:**

| Method | Params | Result |
|---|---|---|
| `run.start` | `mode` (`read` or `repo`); `question` and `inputs` (file paths) for read mode, or `task` and `repo_path` for repo mode; `profile`; `root` and `sub` model refs; `permission_mode` | `{run_id}` |
| `run.cancel` | `run_id` | `{}`; the run finishes with `infra_error = "cancelled"` |
| `run.vars` | `run_id` | The REPL's variables: name, type and size of each. For `/context` |
| `engine.info` | none | Engine version, contract hash and available profiles |

A model ref is `{provider, model, thinking}`. The engine passes it back unchanged in `model.complete` and never learns anything about keys.

**Requests from the engine to the app:**

| Method | Params | Result |
|---|---|---|
| `model.complete` | `run_id`, `role` (`root` or `sub`), the model ref, `messages`, `tools` (the `python` tool for API models, or none), `max_tokens`, `temperature`; for sub-calls also `origin` (turn and cell line) and `batch` (batch id, index, size) | `{text, tool_call, reasoning, usage, finish_reason}`, or an error |
| `approval.request` | `run_id`, `kind` (`write`, `shell` or `network`), and the detail: path, command or host | `{allow, remember_for_run}` |

The gateway streams each answer to the screen as it arrives and returns the whole answer to the engine at the end. The engine never needs the stream.

**Events from the engine,** all carrying `run_id`:

| Event | Fields |
|---|---|
| `run.started` | mode, profile, models, input size, limits |
| `run.reply` | `turn`, the root's reply text |
| `run.cell` | `turn`, `code`, `output` (as the model saw it), `error`, `seconds` |
| `run.subcall` | sub-call id, `origin`, `batch`, prompt size, `error` (the gateway fills in the rest of the panel itself) |
| `run.budget` | turns left, sub-calls left |
| `run.finished` | `answer`, `submitted`, `turns`, `subcalls`, `usage`, `cost_usd`, `infra_error`, `log_path` |

The link carries what happened and requests to deliver. Every decision about the model's messages stays in the engine.

## Model gateway

**Providers (decision 5a):**

| Provider | Client | Caching |
|---|---|---|
| Anthropic | `@anthropic-ai/sdk` | Breakpoints at the end of the system prompt and on the latest message |
| OpenAI | `openai` | Automatic; `prompt_cache_key` = run id |
| DeepSeek | `openai`, DeepSeek's endpoint | Automatic |
| OpenRouter | `openai`, OpenRouter's endpoint | `session_id` = run id |
| Google Gemini | `openai`, Gemini's OpenAI-compatible endpoint | What the endpoint offers |
| Local server: vLLM, Ollama, LM Studio, llama.cpp | `openai`, a localhost URL | The server's prefix cache |
| Custom | `openai`, any OpenAI-compatible URL | What the endpoint offers |

**Keys (decision 5b):**
- `/providers` lists the providers. You pick one, paste the key and it is saved. Each provider can hold several keys, and any of them can be deleted.
- Keys go into the OS credential store through `Bun.secrets`. Bun describes this API as new and experimental. If it fails, the key goes into `keys.json` in the config folder, readable only by you.
- Environment variables override saved keys, for scripts: each provider's usual name, such as `ANTHROPIC_API_KEY`.
- **Saving a key makes no network request.** The only check is the key's format. A test proves it (see Tests).
- A provider's error at first use (401 or 403) becomes a clear message: which provider rejected which key, and that `/providers` can re-enter or delete it.

**Catalog (decision 5c):**
- `app/catalog/models.json` ships with the app. It is a subset of OMP's MIT-licensed catalog (`packages/catalog/src/models.json`), with attribution.
- For each model it gives the context window, the maximum output, input and output prices, cache write and read prices, and whether the model takes tools and reasoning settings.
- "Refresh models" in `/providers` calls the provider's `/models` endpoint, only when clicked, and merges the result.

**Clients:**
- Every request streams.
- Retries: up to 6, with jittered backoff from 2 s, on 429s, 5xx errors and timeouts.
- A per-provider cap on requests in flight, 16 by default.
- Reasoning text is shown in the sub-call view when the provider returns it, but it is never put back into the messages, as in training.

**Caching (`cache.ts`):**
- Anthropic breakpoints as in the table.
- **The `llm_batch` rule.** The gateway finds the longest prefix the prompts in a batch share. When that prefix reaches the model's minimum cacheable length (512 to 4,096 tokens, from the catalog), it marks it, sends the first call, waits for that call's first token, then sends the rest.
- Nothing else touches the bytes.

**Usage and cost (`usage.ts`):**
- Token counts come from each response's usage fields, priced from the catalog.
- Cache reads and writes are counted separately, which gives the hit rate.
- Totals are kept per run and per role (root and sub-calls).

**Context window.** v0 runs are one-shot and capped, so they normally fit. Before each root call the gateway checks the request against the model's window. If it would not fit, the run stops with a clear error instead of being cut. Compaction arrives in v1, with follow-up conversation.

## REPL worker and tools

**The worker:**
- A plain local Python process, started with `python -I -m rlm_engine.worker`.
- Its working folder is the workspace in repo mode, or a scratch folder in the config home in read mode.
- Variables whose names look like keys or tokens are stripped from its environment, as in training.
- Globals persist from cell to cell for the whole run.
- **The link can't be corrupted by a cell.** At start the worker keeps a private copy of its original stdout for the protocol, then points file descriptors 1 and 2 at its capture buffer, so nothing a cell prints can break the link.

**Timeouts and crashes:**
- The cell timeout counts compute time: time blocked waiting for sub-calls or approvals doesn't count, as in training.
- A timeout kills the worker's process tree and starts a fresh worker, and the model gets the training restart text.
- A crash does the same with the crash text.
- v0 sets no memory or CPU limits beyond the timeout.

**Input:**
- Read mode: `context` is the text of the one input file. With several files, they are joined with a `=== path ===` line before each.
- Repo mode: `context` holds the task and the repository's file list with sizes, as in training.

**Tools (`tools.py`):**
- `read_file`, `find_files`, `grep`, `edit_file`, `write_file` and `diff` behave as in training.
- Paths are relative to the workspace. Under decision 3a, paths starting `/work/repo` map onto it.
- `diff()` shows what the run changed since it started. At run start the engine records the working tree as a git tree object through a temporary index, leaving your branch and index alone. v0 repo mode needs a git repository; outside one, `diff()` says it is unavailable.
- `shell(cmd)` runs `sh -c` on macOS and Linux. On Windows it uses Git Bash if installed, otherwise PowerShell (decision 4a). It has a per-call timeout and capped output, as in training.
- `fetch(url)` makes a GET request through the bridge. The engine performs it and returns the text, capped at 200,000 characters. The worker opens no connection.

**Bridge (`bridge.py`):**
- It enforces the run's sub-call budget and the 60,000-character prompt limit on the host side.
- It tags each sub-call with the turn and the cell line that made it, then sends it to the app as `model.complete`.
- `llm_batch` sends its prompts as one batch, so the gateway can apply the prefix rule.

## Permissions

**Audit hooks (`hooks.py`)** are installed before any model code runs, and Python doesn't allow removing them. The events they watch:

| Event | Kind |
|---|---|
| `open` for writing, outside the workspace | `write` |
| `open` for writing, inside the workspace | `write` (allowed in `accept-edits`) |
| `subprocess.Popen`, `os.system`, `os.exec*`, `os.spawn*` | `shell` |
| `socket.connect`, and the first `fetch` to each host | `network` |

**Modes (decision 4b):**

| Mode | Asks for |
|---|---|
| `default` | Writes, shell commands and network |
| `accept-edits` | Shell commands, network, and writes outside the workspace |
| `bypass` | Nothing |

**The round trip.**
1. The hook pauses the cell and sends `approval.request` through the engine to the app.
2. The app shows the action (the path, command or host) with three choices: allow, allow for the rest of this run, or deny.
3. A denial raises `PermissionError` in the cell, so the model reads it in its output and can try something else.

**Limits, stated plainly.** This stops accidents, not a determined attacker, the same as Claude Code's prompts. Code can get around audit hooks, for example through `ctypes`. An optional OS sandbox can come later.

## Interface

**`rlmh` opens the interactive app** in the current folder: a prompt box, the transcript of the current run above it, and a status line below.

**Starting a run (decision 6c):**
- A question with `@path` mentions starts a read-mode run, with those files as `context`.
- A question with no mention starts a repo-mode run on the folder `rlmh` was opened in.
- Each run is one-shot (decision 6a): one task, a fresh REPL, and then the answer. Esc cancels a run.

**Slash commands:**

| Command | What it does |
|---|---|
| `/providers` | Add, list and delete keys per provider. "Refresh models" runs only when you click it |
| `/model` | Pick the root and sub-call models (the two roles) and each one's thinking level |
| `/settings` | Every setting, drawn from the one schema that `rlmh config get` and `set` also use |
| `/permissions` | Switch mode, and see what was allowed in this run |
| `/context` | The root's prompt broken down (system, first message, turns) against its window, and the REPL's variables with their sizes |
| `/runs` | Past runs from the run log; open one to replay it read-only |
| `/help`, `/quit` | |

**Status line:** root and sub-call models, the context used out of the window, cost (root plus sub-calls), cache hit rate, and turns and sub-calls left.

**Sub-call panel.**
- Each `llm_batch` fan-out shows as a block of rows, one per sub-call, with its status, tokens and time. A single `llm` call is a block of one.
- Opening a row gives a subagent-style view:
  - the full prompt
  - the answer as it streams
  - the reasoning, when the provider exposes it
  - tokens, cost and time
  - the cell line that issued the call
- Every sub-call passes through the gateway, so this needs no extra plumbing in the engine. In v1, `rlm()` recursion turns a sub-call into a nested run with its own turns, which this view will show as a true sub-agent.

**Approval prompts** appear inline above the prompt box while a cell waits.

**Non-interactive:**

```
rlmh run --question "Which ...?" --input big.txt
rlmh run --task "Fix the failing test" --repo ./project
rlmh run ... --root deepseek/deepseek-chat --sub deepseek/deepseek-chat --profile training-v4 --json
rlmh batch tasks.jsonl --jobs 4 --out runs/smoke --json
rlmh config get root.model
```

- `--json` prints the events and the gateway's usage, one JSON object per line, for scripts. The RLM repo's evaluations use `rlmh batch --json`.
- Each line of `tasks.jsonl` is `{"id": ..., "question": ..., "input": ...}`, with no gold answers.

## Configuration

Everything lives in `~/.rlm-harness/` on every OS (decision 2b), or in the folder named by `RLMH_HOME`:

```
~/.rlm-harness/
  settings.toml     # models, thinking levels, permission mode, default profile, display
  keys.json         # only if the OS credential store is unavailable; owner-only
  profiles/         # your own profiles
  runs/             # the run log
  python/           # the uv-managed Python 3.12
```

## Run log (`runlog.py`)

Each run is one line of `runs/<batch>/runs.jsonl`. Interactive runs go under `runs/interactive/`. Each line holds:

- **Identity:** run id, harness version, contract and prompt hash, profile name and hash, root and sub-call model refs, call format.
- **Input:** question or task, input size and sha256 (the input itself is not stored).
- **Trajectory:** the messages, each turn (reply, code, output, error, timings, tokens) and each sub-call (prompt, answer, error, seconds, origin).
- **Outcome:** answer, `submitted`, usage, cost, cache hits, wall time and `infra_error`.

The log stays on your machine. `/runs` reads it, and so will Harness² in v1.

## Failures

- **A model call fails after retries:** the run stops with `infra_error` set, and the model is never shown a fake answer. A rejected key gets the `/providers` message.
- **A cell times out or the worker crashes:** the worker restarts and the model is told, as in training.
- **The app exits:** the engine sees its stdin close, cancels its runs and kills their workers.
- **The engine exits:** the app shows its last stderr lines and marks the runs failed.

## Tests

| Test | Checks | Needs |
|---|---|---|
| `test_contract` | Prompt v4 hash equals the training value; code extraction matches training on sample replies | Nothing |
| `test_callformat` | Fenced text, `<function=python>` and the native `python` tool yield the same code, and the observation goes back in the right place | Nothing |
| `test_loop` | A scripted fake app produces the exact expected messages: counters, last-turn line, no-code error, truncation, pacing line | Nothing |
| `test_link` | Requests both ways, interleaved; nothing but protocol reaches stdout; stdin closing cancels runs | Nothing |
| `test_worker` | Globals persist; timeout and crash restart with the training texts; a cell printing to fd 1 can't break the link | Each OS in CI |
| `test_tools` | The seven tools against a fixture repo, the `/work/repo` mapping, `diff()` from the run-start snapshot, `shell` on each OS | Each OS in CI |
| `test_permissions` | Each event kind in each mode, and a denial reaching the cell as `PermissionError` | Each OS in CI |
| `bun test` gateway | Against a fake HTTP server: retries, the in-flight cap, cost sums, Anthropic breakpoints, the `llm_batch` prefix rule, `prompt_cache_key` and `session_id`. **Saving a key makes zero network requests** | Bun |
| `bun test` interface | Screens against a fake engine, including a 20-way fan-out in the sub-call panel and an approval prompt | Bun |
| Parity (script in the RLM repo) | Replays recorded training episodes through the engine, with a fake app answering `model.complete` from the recorded replies and sub-call outputs, and checks that the engine's requests match the recorded messages | Training transcripts and task data on the PC |

CI runs everything except parity on macOS, Windows and Linux. The parity script lives in the RLM repo, because task contexts and transcripts stay there.

## Open questions

1. Which two models for the smoke run (decision 9a)? I suggest one API model and one local model.
2. Licence: Apache-2.0, the same as Qwen and Harness². It was chosen by default and is easy to change before the first release.
