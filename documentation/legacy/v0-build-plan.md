# v0 build plan

> **Status:** draft for review, 2026-10-24. Step 1 is done (2026-10-30): every decision below is answered in [v0/decisions.md](../v0/decisions.md) (S-22 to S-34). Nothing is built and nothing has been spent. This plan covers v0 only. v1 and later get their steps once v0 is done, because what we learn building v0 should shape them.
>
> **Source of truth:** [v0-design.md](v0-design.md) is the spec each step is coded against, and [architecture.md](architecture.md) is the overall picture. Anything marked *(mine)* is my recommendation. Anything marked *(inferred)* hasn't been checked yet.
>
> **How to answer:** each step ends with its open decisions, numbered by step (2a, 2b, …). Reply with the number and your pick, for example "2a Ink, 4a yes, 9a DeepSeek and local Qwen". Where a step lists defaults, I'll use them unless you say otherwise.

## The goal

The goal is one program, `rlmh`, that runs any model as a Recursive Language Model on macOS, Windows and Linux. You install it with one command, paste a key into `/providers`, ask a question about a long file or a repository, and watch the root model write Python and fan out sub-calls in a live panel. Run with the `training-v4` profile, it must give the trained LoRA exactly the messages it saw in training. Proving that is the parity step.

## Where we start

- **Design:** [architecture.md](architecture.md) and [v0-design.md](v0-design.md), agreed with Rishi on 2026-10-21 and 2026-10-23.
- **Training code to copy**, in [RishiJain905/RLM](https://github.com/RishiJain905/RLM) `rlm_rl/` at commit `0b9af69`:
  - `bridge.py` (about 460 lines): prompt v4, limits, observation text, code extraction.
  - `repl_worker.py` (about 740 lines): the REPL process and its audit hooks.
  - `repl_tools.py` (about 310 lines): the seven coding tools.
  - `env.py` (about 470 lines): `run_episode`, the loop.
  - `sandbox.py` (the Docker sandbox) is not carried over. The worker runs natively now.
- **For parity and the smoke run:** recorded training episodes and held-out context-search tasks are on the PC, in the RLM repo. They never come into this repo.
- **Nothing in TypeScript exists yet.**
- **Tools on the PC:**
  - uv is installed.
  - Bun is not. Installing it is part of step 2, and I'll ask before installing anything.
  - CI runs on GitHub Actions, which is free for a public repo.

## At a glance

**Types:**
- *Design*: doc work, no code.
- *PC*: code that runs on your PC through a Remote Control thread.
- *Spend*: uses your own API keys and waits for your go-ahead. It never uses W&B credit.

| # | Step | Type | Cost | Decisions | Status (2026-10-24) |
|---|---|---|---|---|---|
| 1 | Freeze the v0 spec | Design | $0 | 1a | Done 2026-10-30 |
| 2 | Skeleton, the stdio link both ways, CI and a binary per OS | PC | $0 | 2a, 2b | After step 1 |
| 3 | Contract: prompt v4, hash test, both call formats | PC | $0 | 3a | After step 2 |
| 4 | Native REPL worker, tools and permissions | PC | $0 | 4a, 4b | After step 3 |
| 5 | Model gateway: providers, keys, catalog, clients, caching, cost | PC | $0 | 5a, 5b, 5c | After step 2; can run alongside 3 and 4 |
| 6 | Loop, events and run log; `rlmh run` and `--json` | PC | $0 | 6a, 6b, 6c | After steps 4 and 5 |
| 7 | Interactive view: screens, status line, sub-call panel | PC | $0 | none | After step 6 |
| 8 | Parity with training | PC | $0 | none | After step 6 |
| 9 | Smoke run | Spend | estimated before it runs | 9a | After steps 7 and 8, with your go-ahead |
| 10 | One-command install on three OSes | PC | $0 | 10a | After step 9 |

Everything costs $0 except step 9, which uses your own keys. I'll give you its estimate once step 6 has measured what one run uses.

---

## Step 1. Freeze the v0 spec

**Type:** Design · **Cost:** $0

### What we make

[v0-design.md](v0-design.md) is the spec every later step is coded against. It covers:
- the three parts and what each one holds
- the JSON-RPC link in both directions, with every method and event
- the contract, the call formats and the two profiles
- the gateway: providers, keys, catalog, caching and cost
- the worker, its tools and permissions
- the interface, the config folder, the run log, failures and tests

### Why it comes first

The engine, the gateway and the screens are all built against the link and the contract. The contract is what the LoRA learned, so it has to be pinned before any code copies it.

### Starts from

The architecture and spec as agreed on 2026-10-21 and 2026-10-23, and the training code at RLM commit `0b9af69`.

### Done when

You have read the spec and answered the decisions in this plan, or accepted their defaults.

### Decisions for this step

**1a. Licence**
- **Apache-2.0: recommended (mine).** It is the licence of Qwen and Harness², and it includes a patent grant. Code we take from OMP and DeepSeek Harness is MIT, which can sit inside an Apache-2.0 project as long as their notices are kept.
- **MIT.** It is shorter and matches the two harnesses we borrow from, but it has no patent grant.

---

## Step 2. Skeleton, the stdio link both ways, CI and a binary per OS

**Type:** PC · **Cost:** $0

### What we build

- **`app/`:** a Bun project with the `rlmh` entry point, `link.ts` and an empty Ink screen.
- **`engine/`:** a Python package that answers `engine.info` over stdio.
- **The link in both directions:**
  - The app sends a request and the engine answers.
  - The engine sends a request (a dummy `model.complete`) and the app answers.
  - Both kinds interleave on the same pipe.
- **Engine discovery:** in a checkout, the app starts the engine with `uv run --project engine`.
- **CI:** GitHub Actions on macOS, Windows and Linux, running the Python tests and `bun test` on every push.
- **A compiled `rlmh` binary per OS:** built in CI with `bun build --compile` and kept as a build artifact.

### Why it comes here

The link is the one thing every other step plugs into, and the three OSes are the riskiest assumption in v0. Finding a Windows problem now costs an afternoon; finding it in step 10 costs a redesign.

### Starts from

Nothing. The protocol comes from the link section of the spec.

### Done when

- On all three OSes in CI, the compiled binary prints `rlmh --version` and the engine's `engine.info`.
- `test_link` passes on all three: requests both ways, interleaved, and nothing but protocol on stdout.
- On your PC, `rlmh` opens its empty screen in Windows Terminal and PowerShell, with no WSL.

### Defaults I'll pin unless you change them

| Setting | Default |
|---|---|
| Bun | The current 1.3 release, pinned in `package.json` *(mine)*; superseded by S-15 (1.4.4) |
| Python | 3.12, through uv, the same as training |
| Engine dependencies | None at run time; pytest for tests |
| Framing | JSON-RPC 2.0, one object per line, logs on stderr |

### Decisions for this step

**2a. Terminal UI library**
- **Ink (React for the terminal): recommended (mine).** It is the most used option and has the most examples. Public write-ups say Claude Code ships Ink compiled with Bun *(inferred)*.
- **OpenTUI.** It is newer and fast, with a native core, but it has fewer users and its API is still moving.

**2b. Config folder**
- **`~/.rlm-harness/` on every OS: recommended (mine).** It is one path to document and support, easy to find, and easy to delete.
- **Each OS's standard folder** (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux). This is more correct by each OS's own rules, but it means three paths in every doc and bug report.

---

## Step 3. Contract: prompt v4, hash test, both call formats

**Type:** PC · **Cost:** $0

### What we build

- **`contract.py`:** a copy of the v4 texts, limits, observation and error strings, and code extraction from `rlm_rl/bridge.py`.
- **The hash test** against the training value `a71401e2…a1d6`.
- **`callformat.py`:**
  - fenced `python` text
  - `<function=python>` in plain text
  - the native `python` tool: its definition, and how its call and result fit into the messages
- **The two profiles:** `training-v4` and `default`, the latter with its `guidance.md`.

### Why it comes here

The worker, the loop and parity all depend on these exact strings. Getting them pinned before the loop exists means the loop is written against the real text from the start.

### Starts from

`rlm_rl/bridge.py` at `0b9af69`, and its sample replies in the training tests.

### Done when

- `test_contract` passes: the hash matches, and extraction matches training on the sample replies.
- `test_callformat` passes: the three formats yield the same code.
- The `default` profile's prompt differs from `training-v4` only by its guidance block.

### Decisions for this step

**3a. The `/work/repo` path in repo mode**
- **Keep `/work/repo` in the text and map it onto the real workspace in the tools: recommended (mine).** The LoRA sees exactly its training text, and `read_file("/work/repo/x.py")` and the other tools still work. The one gap is that a `shell()` command spelling out `/work/repo` won't find it, which is rare because the training tools run from the repo root *(inferred)*.
- **Show the real path in the text.** Shell commands work too, but the repo-mode prompt then differs from training, so `training-v4` no longer hashes the same.

---

## Step 4. Native REPL worker, tools and permissions

**Type:** PC · **Cost:** $0

### What we build

- **`worker/worker.py`:** the training REPL process, run natively:
  - persistent globals
  - keys stripped from its environment
  - a private copy of stdout for the protocol, so a cell's prints can't break the link
- **`worker/manager.py`:**
  - starts the worker and feeds it cells
  - counts compute time
  - on a timeout or crash, kills the process tree, restarts the worker and returns the training restart texts
- **`worker/tools.py`:** the seven training tools plus `fetch`, with the `/work/repo` mapping from 3a and `diff()` from a run-start git snapshot.
- **`worker/hooks.py` and `permissions.py`:** audit hooks for writes, shell and network. They send `approval.request` up the link, and the three modes decide what is allowed.
- **`bridge.py`:** the sub-call budget, the 60,000-character limit, origin tags, and `fetch` performed on the engine side.

### Why it comes here

This replaces the Docker sandbox, so it has to work on Windows as well as it did in WSL before anything runs a real model. It needs the contract's restart texts from step 3.

### Starts from

`rlm_rl/repl_worker.py` (its audit hooks already block network sockets and writes outside scratch; here they ask instead of blocking) and `rlm_rl/repl_tools.py`.

### Done when

- `test_worker`, `test_tools` and `test_permissions` pass on all three OSes in CI.
- On your PC, a cell that writes outside the workspace, runs `shell("dir")` or calls `fetch` brings up an approval request, in each mode as the spec says.

### Decisions for this step

**4a. Which shell `shell()` uses on Windows**
- **Git Bash if it is installed, otherwise PowerShell: recommended (mine).** The LoRA was trained on `sh`, and most developers on Windows have Git Bash (it comes with Git for Windows). PowerShell is always there as the fallback. The `default` profile's guidance says which one is in use.
- **Always PowerShell.** This is one behaviour everywhere on Windows, but shell commands written for `sh` will fail.
- **Require Git Bash.** This is closest to training, but it adds an install step for some users.

**4b. Default permission mode**
- **`default`, which asks for writes, shell commands and network: recommended (mine).** It is the safe choice for a first run on someone's own machine, and the same starting point as Claude Code.
- **`accept-edits`.** There are fewer prompts in repo mode, but the first run can change files without asking.

---

## Step 5. Model gateway: providers, keys, catalog, clients, caching, cost

**Type:** PC · **Cost:** $0, because every test uses a fake HTTP server

### What we build

- **`providers.ts`:** the provider list from 5a, each mapped to the `openai` or `@anthropic-ai/sdk` client.
- **`keys.ts`:**
  - `Bun.secrets`, with the owner-only `keys.json` fallback
  - several keys per provider, and delete
  - environment variables as an override
  - format checks only
- **`catalog.ts` and `catalog/models.json`:** the bundled catalog with its attribution, plus "Refresh models" that runs only on request.
- **Clients:**
  - streaming
  - 6 retries with jittered backoff from 2 s
  - a per-provider in-flight cap
  - reasoning passed to the screen, never into the messages
- **`cache.ts`:**
  - Anthropic breakpoints
  - the `llm_batch` shared-prefix rule
  - `prompt_cache_key` for OpenAI and `session_id` for OpenRouter
- **`usage.ts`:** tokens, cost, cache reads and writes, per run and per role.
- **The window check** before each root call.
- **`model.complete`** answering the engine over the link.

### Why it comes here

The loop needs a way to reach models. This step only needs the link from step 2, so it can be built alongside steps 3 and 4.

### Starts from

The spec's gateway section, and how OMP and DeepSeek Harness handle providers and the catalog (read for ideas; we don't depend on their packages).

### Done when

- **A test proves that saving a key makes zero network requests.** Every outgoing request is intercepted during the `/providers` flow and the count must be 0.
- Against a fake server:
  - retries happen
  - the in-flight cap holds
  - cost sums match the catalog prices
  - Anthropic breakpoints sit where the spec says
  - the batch prefix rule sends one call, waits for its first token, then sends the rest
  - the cache keys are set
- A 401 becomes the `/providers` message.
- `Bun.secrets` round-trips a key on each OS in CI, or the fallback file is used where it can't.

### Decisions for this step

**5a. Providers in v0**
- **Anthropic, OpenAI, DeepSeek, OpenRouter, Google Gemini (OpenAI-compatible endpoint), local servers (vLLM, Ollama, LM Studio, llama.cpp) and a custom OpenAI-compatible URL: recommended (mine).** Two clients cover all of them, and OpenRouter alone reaches most other models.
- **Fewer to start**, for example Anthropic, OpenAI and local only. That means less to test, but users of other providers can't start.

**5b. Key storage**
- **`Bun.secrets` (OS credential store), falling back to an owner-only file: recommended (mine).** Keys sit where the OS protects them, and the fallback covers Linux machines without a secret service. Bun marks the API as new and experimental, so the fallback also guards against it changing.
- **An owner-only file only.** This is simpler and the same on every OS, which is roughly what OMP does with its SQLite file. But the key sits in a plain file on disk.

**5c. Catalog source**
- **A subset of OMP's catalog data (`packages/catalog/src/models.json`, MIT), with attribution: recommended (mine).** It is already maintained, has the fields we need, and its licence is clear.
- **models.dev.** It is broader and community-kept, but its licence is unverified, so we'd check it first.
- **Hand-written** for the providers in 5a. This gives full control, but we have to keep prices current ourselves.

---

## Step 6. Loop, events and run log; `rlmh run` and `--json`

**Type:** PC · **Cost:** $0

### What we build

- **`loop.py`:** `env.run_episode` without token ids, logprobs, reward, detectors, the grader, broken-reply redraws and format penalties. It:
  1. builds the first messages from the contract and the profile
  2. asks the app for each root turn
  3. extracts the code with the call format from 6b
  4. runs the cell and appends the observation
  5. stops on `submit` or the turn limit
  In repo mode it adds the pacing line from halfway, as in training.
- **Events:** every event in the spec, emitted as the loop reaches each point.
- **`runlog.py`:** one JSON line per run.
- **The commands:** `rlmh run` and `rlmh batch`, with `--json` and a plain line-by-line view.

### Why it comes here

It is the first step where a whole run works, and it needs the worker (step 4) and the gateway (step 5).

### Starts from

`rlm_rl/env.py:run_episode`.

### Done when

- `test_loop` passes against a scripted fake app: counters, the last-turn line, the no-code error, truncation and the pacing line.
- `rlmh run --json` on a fake provider prints the full event stream, and the run log line is complete.
- If a local model server is set up on your PC, one real read-mode run completes on it at $0. Otherwise the first real run is step 9.
- The run log records tokens per run, which gives step 9 its estimate.

### Decisions for this step

**6a. One-shot runs**
- **One task per run, with a fresh REPL, as in training: recommended (mine).** It matches what the LoRA was trained on and keeps v0 small. Follow-up conversation, and the compaction it needs, is a v1 question.
- **Follow-ups in v0.** This is closer to Claude Code, but it needs compaction now, and it gives the LoRA a situation it never trained on.

**6b. Call format per provider**
- **The native `python` tool for API models, and fenced text for the LoRA and local models: recommended (mine).** API models are trained on tool calls and use them reliably, while the LoRA gets its exact training format. A setting can force fenced text for any model.
- **Fenced text everywhere.** One format means one path, but API models sometimes wrap or format code oddly when they aren't using a tool.

**6c. What a question in the interactive app runs on**
- **`@path` mentions start read mode on those files; no mention starts repo mode on the current folder: recommended (mine).** It works like Claude Code, where opening the app in a project means working on that project.
- **Always ask which mode.** This is explicit, but it adds a step before every run.

---

## Step 7. Interactive view: screens, status line, sub-call panel

**Type:** PC · **Cost:** $0

### What we build

- **The interactive app:** the prompt box, the run transcript, approval prompts and Esc to cancel.
- **The status line:** models, context used out of the window, cost (root plus sub-calls), cache hit rate, and turns and sub-calls left.
- **The sub-call panel:** a block of rows per `llm_batch` fan-out. Opening one gives the subagent-style view, with the full prompt, the streamed answer, reasoning when available, tokens, cost, time and the cell line that issued it.
- **The slash commands:**
  - `/providers` (the key flow from step 5)
  - `/model` (the root and sub-call roles, and thinking levels)
  - `/settings` (drawn from the one schema that `rlmh config` uses)
  - `/permissions`
  - `/context` (the prompt breakdown and the REPL's variables with sizes)
  - `/runs` (past runs, replayed read-only)
  - `/help` and `/quit`

### Why it comes here

The engine and gateway now produce every event and number these screens draw, so the screens are built against real data shapes, not guesses.

### Starts from

Ink from step 2, the events from step 6 and the gateway's usage from step 5. Ideas come from OMP's status-line segments and `/context` grid, and DeepSeek Harness's context ring and cache-hit pill.

### Done when

- `bun test` interface passes, including a fake 20-way fan-out that streams into the panel and an approval prompt answered from the keyboard.
- On your PC, a run against the fake provider looks right in Windows Terminal, and you're happy with it.
- The `/providers` flow still makes zero network requests when it saves a key.

---

## Step 8. Parity with training

**Type:** PC · **Cost:** $0

### What we build

A script in the RLM repo, not this one, that:
1. loads 3 recorded read-family episodes and 2 recorded edit episodes from training
2. starts the engine with the `training-v4` profile and fenced-text format
3. acts as a fake app, answering each `model.complete` with the recorded root reply or sub-call output
4. compares every request the engine sends with the messages recorded in training

The real worker runs the real cells against each task's real context.

### Why it comes here

It is the proof that the product runs what we trained: the LoRA sees the same bytes. It needs the loop (step 6), and it is the check that decides whether the native worker changed anything the model can notice.

### Starts from

The recorded episodes and task contexts on the PC, and the engine from step 6.

### Done when

All 5 episodes match byte for byte. Any difference is either fixed or written down with the reason the model can't notice it.

---

## Step 9. Smoke run

**Type:** Spend · **Cost:** your own API keys, estimated before it runs, never W&B credit

### What we build

`rlmh batch --json` on 5 held-out context-search tasks with each of two models, so 10 runs, graded by a script in the RLM repo. The report covers:
- accuracy
- sub-calls and turns per run
- cost
- cache hit rate

### Why it comes here

It is the first end-to-end check with real models and real money, so it waits until the screens (step 7) and parity (step 8) are done.

### Starts from

The held-out tasks on the PC, and the token counts from step 6 for the estimate.

### Done when

The 10 runs finish and the report is written. A run that fails on infrastructure is rerun once and noted. This step ends v0's functional work.

### Decisions for this step

**9a. Which two models**
- **One API model and one local model: suggested (mine).** This exercises both clients and both call formats. The API model could be a cheap one, such as DeepSeek's, to keep the cost to cents. The local model could be base Qwen if your PC can serve it.
- **Two API models.** This needs no local server, but the fenced-text path the LoRA uses then goes untested with a real model.

Still open: tell me which two, and I'll price them from the catalog before anything runs.

---

## Step 10. One-command install on three OSes

**Type:** PC · **Cost:** $0

### What we build

- **GitHub Releases:** `rlmh` binaries for macOS (arm64 and x64), Windows x64 and Linux x64, from the CI build in step 2.
- **`install.sh` and `install.ps1`:** they download the right binary, put it on the PATH, and print where everything went.
- **First run:** `rlmh` says it will fetch Python 3.12 through uv into `~/.rlm-harness/python/`, asks, does it, and then installs the engine there.
- **Uninstall:** delete the binary and `~/.rlm-harness/`.

### Why it comes here

The install only matters once there is something worth installing. Doing it last also means it packages the final v0 engine.

### Starts from

The binaries from step 2 and the engine from steps 3 to 6.

### Done when

- On a clean CI runner for each OS, the one-line install followed by a run against the fake provider completes.
- On your PC, installing from the release and running a real question works with no checkout.

### Decisions for this step

**10a. How Python reaches the user**
- **uv fetches Python 3.12 on first run, after asking: recommended (mine).** The download stays small, uv is fast and handles all three OSes, and the engine has no dependencies to resolve.
- **Bundle a standalone Python in the release.** It works offline from the first run, but each download is 30 to 50 MB larger, and we'd ship Python updates ourselves *(inferred)*.

---

## Where the numbers and choices come from

The design comes from [architecture.md](architecture.md) and [v0-design.md](v0-design.md). The training code is RLM commit `0b9af69`. The step 12 sub-call results are in the RLM repo's step 12 docs. Anything marked *(mine)* or *(inferred)* is mine, not from those sources.
