# v0 decisions

> Updated 2026-10-30, when step 1 froze the spec; D-52 to D-58 were added while building step 2. One line per decision, with its date and reason. S entries were settled with Rishi. D entries are calls made while writing these build docs, where the parent docs were silent or vague; Rishi reviewed them at step 1 and kept every one (S-34). Rishi can overturn any of them; if he does, change the line, add a log line to [progress.md](progress.md), and fix the specs it names. The decisions that were open are numbered as in [../legacy/v0-build-plan.md](../legacy/v0-build-plan.md).

## Settled decisions

### With Rishi

- **S-01** (2026-10-19) A thin custom build, not a fork of DeepSeek Harness, because the fork would carry a large surface we'd then have to keep native on three OSes ([../legacy/options-research.md](../legacy/options-research.md)).
- **S-02** (2026-10-20) A TypeScript app on Bun drives a Python engine, because the screens and provider code belong in TypeScript and the trained loop is Python.
- **S-03** (2026-10-20) MCP is deferred, because nothing in v0 needs it.
- **S-04** (2026-10-21) Native on macOS, Windows and Linux: no Docker, no WSL, because a user tool must install with one command.
- **S-05** (2026-10-21) Harness² moves to v1, because v0 must first prove parity and a working app.
- **S-06** (2026-10-21) Keys are pasted into `/providers` and kept in the OS store through `Bun.secrets`, with an owner-only file as the fallback. There is no validation call and no ping, because the harness never makes a call with your key that you didn't ask for.
- **S-07** (2026-10-21) No subscription logins (Claude Pro or Max), because the open-source versions imitate Claude Code to Anthropic's servers, which breaks Anthropic's terms.
- **S-08** (2026-10-23) The model clients live in the app's gateway, and the engine never sees a key, because keys stay in the program that stored them and the sub-call panel comes free.
- **S-09** (2026-10-23) The model has one tool, `python`, and no native Read or Bash tools, because those would let the model pull files into its prompt and stop delegating (lever 1).
- **S-10** (2026-10-23) A sub-call panel with a subagent-style view, because every sub-call already passes through the gateway.
- **S-11** (2026-10-23) Runs are one-shot: one task, a fresh REPL, then the answer, as in training (6a). Follow-ups and compaction wait for v1.
- **S-12** (2026-10-23) Only v0 gets build steps, because what we learn building v0 shapes v1.
- **S-13** (2026-10-24) Copy the training contract, worker and tools from RLM `0b9af69` rather than importing them, because training pulls in ART, W&B and reward code.
- **S-14** (2026-10-24) Prompt v4 is frozen. Its hash must equal `a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6`, because the LoRA only works on the bytes it trained on.
- **S-15** (2026-10-24) Bun 1.4.4, pinned in `package.json` and installed in-repo at `rlm-harness/.bun/` (git-excluded). This replaces the build plan's "current 1.3", because 1.4.4 is what is installed.
- **S-16** (2026-10-24) Python 3.12 through uv. The engine uses the standard library only, with pytest only for tests, because it then has nothing to resolve on a user's machine.
- **S-17** (2026-10-24) The link is JSON-RPC 2.0 over the engine's stdio, one object per line, with requests both ways and logs on stderr, because it's simple and works on all three OSes.
- **S-18** (2026-10-24) Permission prompts come from PEP 578 audit hooks, not a sandbox, because they stop accidents and a native OS sandbox can come later.
- **S-19** (2026-10-24) Parity, smoke and grading scripts live in the RLM repo, because task data, gold answers and transcripts never enter this public repo.
- **S-20** (2026-10-24) CI on GitHub Actions on macOS, Windows and Linux, because it's free for a public repo and Windows is the riskiest OS.
- **S-21** (2026-10-24) Every module opens with a KV-cache note, as in DeepSeek Harness, because a broken prefix is the costliest silent bug.

Settled at step 1 (2026-10-30), when the spec was frozen. Three went the alternative way: 1a, 4b and 9a.

- **S-22** (2026-10-30) 1a Licence: MIT, the alternative. `LICENSE` holds the MIT text with `Copyright (c) 2026 Rishi Jain`, and step 2's `license` fields say `MIT`. The MIT notices of code taken from OMP and DeepSeek Harness are kept. Why: Rishi's pick (no reason given).
- **S-23** (2026-10-30) 2a Terminal UI library: Ink, the default. Why: accepted default.
- **S-24** (2026-10-30) 2b Config folder: `~/.rlm-harness/` on every OS, with `RLMH_HOME` overriding it, the default. Why: accepted default.
- **S-25** (2026-10-30) 3a `/work/repo` in repo mode: keep the training text, and the tools map `/work/repo` onto the workspace, the default. `training-v4` still hashes to `TRAINING_HASH`. Why: accepted default.
- **S-26** (2026-10-30) 4a Windows shell for `shell()`: Git Bash if found, otherwise PowerShell, the default. Why: accepted default.
- **S-27** (2026-10-30) 4b Default permission mode: `accept-edits`, the alternative. Writes inside the workspace go through without asking; shell commands, network and writes outside the workspace still ask. `permissions.mode` defaults to `accept-edits`. Why: Rishi's pick (no reason given).
- **S-28** (2026-10-30) 5a Providers in v0: Anthropic, OpenAI, DeepSeek, OpenRouter, Gemini, local (vLLM, Ollama, LM Studio, llama.cpp) and custom, the default. Why: accepted default.
- **S-29** (2026-10-30) 5c Catalog source: a subset of OMP's `packages/catalog/src/models.json` (MIT), with attribution, the default. Why: accepted default.
- **S-30** (2026-10-30) 6b Call format: the native `python` tool for API models, fenced text for the LoRA and local models, and the setting can force either, the default. Why: accepted default.
- **S-31** (2026-10-30) 6c What an interactive question runs on: `@path` mentions mean read mode on those files, and no mention means repo mode on the current folder, the default. Why: accepted default.
- **S-32** (2026-10-30) 9a Smoke-run models: two API models, the alternative, with slot b forced to `--call-format fenced` so the LoRA's fenced format still meets a real model. Step 9 asks which two models before it estimates anything (D-41) and adds their ids here. Why: Rishi's pick (no reason given); he also took the recommended fenced slot.
- **S-33** (2026-10-30) 10a How Python reaches the user: uv fetches Python 3.12 on first run, after asking, the default. Why: accepted default.
- **S-34** (2026-10-30) D-01 to D-51 all stay as written. Rishi reviewed the calls that change what the model or a user notices (D-01, D-08, D-09, D-11, D-13 to D-16, D-33, D-42, D-44, D-46) and the gap fills, and changed none. Why: accepted as written.

### Calls made in these docs (2026-10-28)

- **D-01** The worker is launched as `python -I -B -X utf8 <dir>/rlm_engine/worker/worker.py` (D-42) and imports only its sibling files, by putting its own folder on `sys.path`, as training did. v0-design's `python -I -m rlm_engine.worker` can't find the package outside a venv, because `-I` drops it from `sys.path`.
- **D-02** `protocol/examples.json` holds one example of every method, result, error and event, and both test suites check it, so parallel threads can't drift on the wire.
- **D-03** Files added to v0-design's layout (◆ in [architecture.md § 2](architecture.md#2-repo-layout)), each to keep one job per module: `version.ts`, `paths.ts`, `protocol.ts`, `bus.ts`, `session.ts`, `cli/*`, the private `interface/*.ts` helpers, `gateway/gateway.ts`, `gateway/fake.ts`, `scripts/build-catalog.ts`, `scripts/embed-engine.ts`, `errors.py`, `appport.py`, `service.py`, `profiles.py`, `workspace.py`, `inputs.py`, `.gitattributes` and `protocol/examples.json`.
- **D-04** Messages use a neutral chat shape, and an assistant message carries at most one tool call. The gateway keeps the first tool call and drops any others, so every tool call gets exactly one result.
- **D-05** `model.complete` also carries `turn`, `thinking` and, for sub-calls, `subcall_id`. Its result also carries `served_model` and `seconds`. Errors use code -32001 with a `kind`, so the engine can tell a rejected prompt from an outage.
- **D-06** A sub-call that fails with `bad_request` (HTTP 400, 413 or 422) reaches the model as `RuntimeError("sub-call failed: …")`. Any other failure stops the run with `infra_error`, as training's `SUBCALL_REJECT_STATUSES` and `InfraError` did.
- **D-07** `run.start` also takes `call_format` (resolved by the app from the setting and the catalog), `interactive`, `tag`, `batch` and `log_dir`. Repo mode also takes the overrides `test_hint`, `language`, `n_files` and `context`, so parity can reproduce a recorded first message byte for byte.
- **D-08** Thinking resolves as: the ref's value, else the profile's `subcall_thinking` for sub-calls, else `off`. For `local`, `off` is sent as `chat_template_kwargs: {enable_thinking: false}`, as training sent it, because Qwen otherwise thinks by default.
- **D-09** Each profile mode table starts from training's `READ_LIMITS_V4` or `EDIT_LIMITS_V4` and overrides only the keys it lists, because the v4 hash covers fields v0-design's profile.toml omits (`cpus`, `memory_mb`, `pids`, `grader_timeout_s`, `subcall_thinking`). `training-v4` `[repo]` sets `subcall_thinking = "low"`, as `EDIT_LIMITS_V4` does, and `pace_nudge = true`.
- **D-10** Read-mode `context`: one file is its exact text, read with `newline=""`. Several files are each `=== path ===\n<text>`, joined by a blank line, because v0-design names the header but not the joining.
- **D-11** Repo-mode `context` uses training's `editreal._context` format: the task, then `Repository files (path, size in bytes):` and `path  1,234` lines from `git ls-files`. `language` is the most common known extension. `test_hint` is detected from the project files (pytest, `npm test`, `go test ./...`, `cargo test`, …), otherwise `"no test command found; look for one in the repository"`.
- **D-12** The read-mode workspace is the run's scratch folder, `<home>/scratch/<run_id>/`. Writes there never ask, as `/scratch` was writable in training. `TMPDIR`, `TEMP` and `TMP` point at it, and it is deleted when the run ends.
- **D-13** Read-only git calls made inside `find_files`, `grep` and `diff` never ask. `shell(cmd)` asks once, showing `cmd`. A raw `subprocess` or `os.system` from model code asks, showing its argv.
- **D-14** "Allow for the rest of this run" covers every later request of the same kind in that run, with two limits. For `write`, it covers only the same side of the workspace: allowing a write inside never allows writes outside. For `network`, it covers only the same host. A host allowed once for `fetch` isn't asked again in that run, because v0-design asks on "the first fetch to each host".
- **D-15** A run with `interactive: false` (`rlmh batch`, or `rlmh run` without a TTY) denies anything that would ask, and the model sees a `PermissionError`. `rlmh run` on a TTY asks on the terminal.
- **D-16** `fetch(url)` is in the REPL in both modes; the seven coding tools, `shell` among them, are repo mode only. It makes an http(s) GET on the engine side, with a 30 s timeout, at most 5 redirects (same host only), and the decoded text capped at 200,000 characters. It doesn't count against the sub-call budget, and time spent waiting on it doesn't count as compute.
- **D-17** Paths the model sees use `/` on every OS (tools, listings and `=== path ===` headers), because the LoRA only saw POSIX paths.
- **D-18** The engine is found in this order: `RLMH_ENGINE`, then a source checkout (`uv run --project engine`), then the installed engine in `<home>/engine/<version>` (step 10).
- **D-19** `rlmh --version` prints only the app version. `rlmh info` prints the app version and `engine.info`, which is the build plan's "prints `rlmh --version` and the engine's `engine.info`".
- **D-20** The scripted fake provider `fake/scripted`, driven by the `RLMH_FAKE_SCRIPT` file, is the one fake that steps 6, 7, 10 and CI share.
- **D-21** `Bun.secrets` can't list entries, so key metadata (id, label, last 4 characters, store, active) lives in `<home>/key-index.json` and never holds a key. The service name is `rlm-harness` and the entry name `<provider>:<id>`. Each provider has one active key.
- **D-22** Usage: `input_tokens` counts every prompt token, cached ones included. Cost is uncached input × input price + cache reads × read price + cache writes × write price + output × output price. The hit rate is cache reads ÷ input.
- **D-23** Retries: 6 retries after the first try, with delays of 2, 4, 8, 16, 32 and 60 s, each multiplied by a random factor from 0.5 to 1.5. `Retry-After` is honoured up to 60 s. The SDKs' own retries are off, and a stream that breaks is retried whole.
- **D-24** A single `llm()` call is a batch of one. The gateway collects a batch's requests until all `size` have arrived or 100 ms have passed. It applies first-call-then-the-rest ordering on every provider that caches, and cache markers only on Anthropic.
- **D-25** The window check estimates characters ÷ 3, plus the tool definition, plus `max_tokens`, against the catalog's `context_window`, erring towards a clear error rather than a cut.
- **D-26** The run log goes to `--out DIR/runs.jsonl` if given, otherwise `<home>/runs/<batch>/runs.jsonl`. The batch names are `interactive`, `cli` and `<tasks stem>-<YYYYMMDD-HHMMSS>`.
- **D-27** `--json` writes `{"type": <event>, …}` lines, plus `gateway.call` per finished model call and `batch.finished` last, with nothing else on stdout, so scripts can parse it line by line.
- **D-28** `tasks.jsonl` lines: `{id, question, input}` for read mode or `{id, task, repo, test_hint?}` for repo mode, with paths relative to the file and no gold answers.
- **D-29** The app strips key-like environment variables before starting the engine, and the engine strips them again for the worker, so Python never sees a key.
- **D-30** The engine reads stdin on a thread and hands lines to asyncio, because asyncio pipe reading on Windows is unreliable.
- **D-31** In native format with no `python` tool call, the engine falls back to extracting fenced or `<function=python>` code from the text. The observation goes back as a tool result if the reply had any tool call, otherwise as a user message.
- **D-32** The `default` profile's `guidance.md` may contain `{shell}`, filled with the shell `shell()` uses on this machine. This is v0-design's "says which shell", kept stable within a run.
- **D-33** Where a provider rejects a tool-call turn unless the reasoning that came with it is sent back, the gateway re-attaches what it received, on the next request only. That covers Anthropic thinking blocks with their signatures, DeepSeek `reasoning_content`, Gemini `extra_content`, and OpenRouter `reasoning_details`. This is wire format the model already wrote, and the engine's messages stay reasoning-free.
- **D-34** Built-in profiles win over user profiles of the same name, with a warning, so `training-v4` can't be shadowed by accident.
- **D-35** The engine has no state across runs. Each run gets a fresh worker, bridge, permissions and log record.
- **D-36** The protocol version is the integer `1`. The app refuses an engine whose `engine.info.protocol` differs.
- **D-37** During a cell, fds 1 and 2 feed the cell output in both modes, as v0-design says. Training did that only in edit mode. Python's `sys.stderr` stays a hidden buffer, as in training.
- **D-38** Run ids are `r_` plus 12 lowercase hex characters, used as OpenAI's `prompt_cache_key` and OpenRouter's `session_id`.
- **D-39** The gateway passes the provider's tool-call ids through. The fake provider uses `call_<n>`.
- **D-40** `rlmh batch` exits 0 when every run finished without `infra_error`, 1 when any run had one, and 2 on a usage error.
- **D-41** 9a may stay open after step 1 is done. Step 9 asks for it before it estimates anything, because only step 9 uses it. (Step 1 settled 9a as two API models, S-32; step 9 still asks which two.)

Added on 2026-10-29 while reviewing the specs:

- **D-42** The engine and the worker run in Python's UTF-8 mode: `-X utf8` on every engine and worker command, plus `PYTHONUTF8=1` for the engine. Training ran under `C.UTF-8`, and `-I` and `-E` ignore `PYTHONUTF8`, so on Windows a cell's `open()` would otherwise use cp1252.
- **D-43** `.gitattributes` sets `* text=auto eol=lf`, and profiles are hashed after CRLF is normalised to LF, so a Windows checkout gives the same prompts and hashes.
- **D-44** Binaries are compiled with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. Otherwise `rlmh` would load a `.env` (keys) or a `bunfig.toml` preload (code) from whatever folder it runs in.
- **D-45** A model missing from the catalog is still called, at cost 0 and with no window check, and `auto` gives it fenced format. Local servers serve names no catalog lists.
- **D-46** The RLM repo gets one `.gitignore` line, `results/harness-*/`, for the parity and smoke outputs, which hold task text and answers. Rishi approves it before step 8 writes anything.
- **D-47** A `write` approval request's detail is the absolute path with `/`, and a rename shows `src -> dst`. A `shell` request shows the command, a `network` request shows `host:port` for a socket or the bare host for `fetch`.
- **D-48** `run.permission` carries `turn`. A refused `run.subcall` carries `subcall_id: null`.
- **D-49** The engine learns its home only from `RLMH_HOME`, which the app always sets. Parity sets it the same way.
- **D-50** `rlmh run` exits 0, 1 (`infra_error` or the engine died), 2 (usage) or 130 (Ctrl-C), like D-40. Bare `rlmh` with no TTY exits 1.
- **D-51** The run log's `started_at` is Unix seconds as a float, as training's `time.time()`. Its `input.files` is the list of input paths, and it gains `host_traceback`.

Added on 2026-10-30 while building step 2:

- **D-52** `link.ts` splits its input on raw `\n` bytes and decodes each line with a fatal UTF-8 decoder, instead of streaming through a lenient `TextDecoder`. A character split across chunks still survives, bad UTF-8 gets -32700 on both sides (link rule 3), and `MAX_LINE_BYTES` counts bytes, as `link.py` does. A lenient decoder would have turned bad bytes into U+FFFD without an error.
- **D-53** `startEngine` merges `cmd.env` over `process.env`, as §7.1 says, and then strips key-like names again. `findEngine` strips them too, so D-29 holds even for an `EngineCommand` built by hand.
- **D-54** Only `.tsx` files import Ink, so `interface/App.tsx` exports `runApp()` (render, then wait for exit) beside `App`, and `main.ts` imports it dynamically instead of calling `render(createElement(App))` itself.
- **D-55** On the wire, `tag` in `run.started` and `run.finished` is `null` when `run.start` had none, and `run.subcall.seconds` is `null` at `status: "sent"`. §5.3 and `protocol.ts` say so.
- **D-56** `react-devtools-core` (8.0.0) is an exact dev dependency of the app, because Ink 8 imports it and `bun build --compile` can't resolve it otherwise. This is the spec's own fallback; it was picked over `--external react-devtools-core` so the build command stays as specified. Ink loads devtools only when `DEV=true`.
- **D-57** When the engine process exits, `startEngine` waits up to 1 s for its stdout to reach EOF before it closes the link, so an answer written just before exit is not dropped as "link closed".
- **D-58** On Windows, `findEngine` puts `cmd /c` in front of an `RLMH_ENGINE` whose first word ends in `.cmd` or `.bat`, because such a script can't be spawned directly.

## Open decisions

**None are open.** Step 1 settled every one on 2026-10-30 (S-22 to S-33); 5b and 6a were already settled (S-06, S-11). Step 9 still asks which two API models to use (S-32, D-41). The table is the record of what was asked.

| # | Question | Pick | Default offered | Alternative offered | Used by |
|---|---|---|---|---|---|
| 1a | Licence | **MIT** (S-22, the alternative) | Apache-2.0, already in `LICENSE`; MIT notices kept for code taken from OMP and DeepSeek Harness | MIT | 1, 2, 5 |
| 2a | Terminal UI library | Ink (S-23) | Ink (React for the terminal) | OpenTUI | 2, 7 |
| 2b | Config folder | `~/.rlm-harness/` (S-24) | `~/.rlm-harness/` on every OS, `RLMH_HOME` overrides | each OS's standard folder | 2, 5, 6, 10 |
| 3a | `/work/repo` in repo mode | keep the training text (S-25) | keep the training text; tools map `/work/repo` onto the workspace | show the real path; the training-v4 hash then breaks | 3, 4, 8 |
| 4a | Windows shell for `shell()` | Git Bash, else PowerShell (S-26) | Git Bash if found, otherwise PowerShell | always PowerShell; or require Git Bash | 4, 10 |
| 4b | Default permission mode | **`accept-edits`** (S-27, the alternative) | `default`: asks for writes, shell and network | `accept-edits` | 2, 4, 6, 7, 8 |
| 5a | Providers in v0 | all seven (S-28) | Anthropic, OpenAI, DeepSeek, OpenRouter, Gemini, local (vLLM, Ollama, LM Studio, llama.cpp), custom | fewer, e.g. Anthropic, OpenAI and local | 5, 7 |
| 5b | Key storage | `Bun.secrets` with the file fallback (S-06) | `Bun.secrets` with the owner-only file fallback | an owner-only file only | 5 |
| 5c | Catalog source | OMP subset (S-29) | subset of OMP's `packages/catalog/src/models.json` (MIT), with attribution | models.dev (licence unchecked); or hand-written | 5 |
| 6a | One-shot runs | one-shot (S-11) | one task, a fresh REPL, then the answer | follow-ups in v0 | 6 |
| 6b | Call format per provider | native for API models, fenced for the LoRA and local (S-30) | native `python` tool for API models, fenced text for the LoRA and local models; the setting can force either | fenced text everywhere | 3, 5, 6 |
| 6c | What an interactive question runs on | `@path` means read mode (S-31) | `@path` mentions mean read mode on those files; no mention means repo mode on the current folder | always ask which mode | 7 |
| 9a | Which two models for the smoke run | **two API models, slot b forced fenced** (S-32, the alternative); ids asked at step 9 | no default. The build plan suggested one API model (e.g. DeepSeek) and one local model (e.g. base Qwen) | two API models | 9 |
| 10a | How Python reaches the user | uv on first run (S-33) | uv fetches Python 3.12 on first run, after asking | bundle a standalone Python in each release | 10 |
