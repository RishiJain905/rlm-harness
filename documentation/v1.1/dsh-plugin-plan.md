# v1.1 plan: rlmh as a DeepSeek Harness plugin

Status: draft for Rishi, 2026-11-07. Written after a spike on Rishi's PC (Windows 11), dsh desktop 0.2.2-rc.1, model `openrouter / ~deepseek/deepseek-flash-latest`, reasoning `high`. Nothing here is built in this repo yet; the spike code lives outside it, in `F:\Personal\RLM\dsh-spike\`.

## 1. The idea in one paragraph

DeepSeek Harness (dsh) is an MIT agent harness where everything is a plugin. Instead of building our own GUI, rlmh ships as a dsh **bundle** (an npm package dsh installs with `dsh plugin add` or its plugin manager). The bundle adds an **"RLM mode"** next to dsh's Standard, PTC, Minimal and Creator modes. In RLM mode the model's only tool is `run_code`, which runs in **our persistent Python REPL** with rlmh's sub-call API (`llm`, `llm_batch`, `segments`, `scan`, `rlm()`, …) built in, and dsh's own tools (read, grep, shell, web, …) callable from inside the REPL. dsh keeps the loop, sessions, approvals, compaction, caching, model routing, keys and the GUI. No fork: only public dsh seams.

## 2. What the spike proved

| # | Question | Result |
|---|---|---|
| 1 | Does dsh run on Windows? | Yes: desktop app, `dsh headless`, `dsh web`. Standard and PTC modes both answered a test task. |
| 2 | Can a plugin import dsh's packages? | Only as a bundle installed into a profile (`package.json` with `dsh.bundle`, dsh packages as `peerDependencies`, `engines.dsh`). A bare plugin file outside a profile gets `ERR_MODULE_NOT_FOUND`. |
| 3 | Can we replace the code runtime? | Yes. A `PtcRuntime` subclass (`language: 'python'`, `programFormat: 'repl'`, `retainsState: true`) backed by a CPython process over JSON lines on stdin/stdout works on Windows. dsh renders a Python `TypedDict` SDK of every tool into the prompt; the model calls `await tools.read({...})`. |
| 4 | Does state persist? | Yes. dsh's PTC executor passes the Agent as `stateOwner`; one REPL per agent, released when the agent ends. A variable from one `run_code` call was reused in the next. |
| 5 | Can sub-calls go through dsh? | Yes. `llm()`/`llm_batch()` are answered host-side with `ctx.llm.stream(...)` on the agent's own route (`agent.model.current()`), so dsh holds the key. |
| 6 | Does the plugin break dsh's caching? | No. One system message per session, no tool-change messages, new request series only at dsh's own compactions. Cache share per step stayed high; dsh's GUI reported 73% cache hit on a short run. |
| 7 | Does RLM mode delegate on its own? | Only with our prompt and an output cap. With dsh's generic prompt the model paged a 185 KB file into the conversation through `print()` and made 0 sub-calls. With a condensed rlmh `default` prompt plus an 8,000-character cap per cell, it made 27 sub-calls. |
| 8 | Can it be a selectable mode in the GUI? | Yes, after one fix. A preset row in the bundle shows up under Custom; it first failed with `service "ptcRuntime" has been registered at <NodePtcRuntime>`. Wrapping our runtime and `tool-executor-ptc` in a `cordis:group` with `isolate: { ptcRuntime: true }` fixed it. RLM mode then ran from the mode menu: 4 steps, 14 sub-calls, 14 s. |
| 9 | Python on the user's machine? | dsh desktop ships CPython 3.12.14 (`resources/runtime/primary-runtime/dependencies/python`). The npm/web install doesn't. dsh's own Python runtime is Unix-only and stateless, so it's no help. |

### The long-document comparison

Same question on a copy of `v0/decisions.md` (185 KB): list every decision that affects how the software talks to OpenRouter. The literal keyword hits 15 decisions.

| Run | Steps | Uncached input (root + sub-calls) | Cached input | Output | Sub-calls | Found |
|---|---|---|---|---|---|---|
| Standard mode | 78 | 433k | 2.06M | 22k | 0 | 15/15, 6 extra |
| RLM runtime, dsh prompt | 66 | 265k | 1.81M | 12k | 0 | 15/15, 3 extra |
| RLM runtime, rlmh prompt + cap | 52 | 134k + 94k | 1.32M | 19k + 2k | 27 | 15/15, 15 extra |

RLM mode used about half the uncached input of Standard mode. Its extras are judgement calls (Standard flagged several of the same ones). One run each, so these are signs, not results. Sub-calls got almost no cache hits (128 tokens): the second pass re-chunked the same text differently, which is exactly what rlmh's `segments()`/`over=` shaping fixes.

## 3. Architecture

```
dsh (Node, Cordis)                                   rlmh bundle (npm: rlmh-dsh)
  agent loop, sessions, compaction, approvals, GUI
  tool-executor-ptc ── run_code ──────────────────▶  RlmRuntime (PtcRuntime, agent scope, isolated)
  ctx.llm (keys, routes, caching) ◀── sub-calls ───    └─ worker: persistent CPython REPL
  tools (read, grep, pwsh, web, …) ◀── await tools.x ──     rlmh sub-call API + dsh tool bindings
```

- **Runtime.** A `PtcRuntime` provider in TypeScript, built to `lib/`. One worker per agent; `release(owner)` kills it. It honours dsh's `sandboxMode` (so plan mode and read-only reach the REPL), `timeout` and the run's abort signal.
- **Worker: reuse parts, not the engine.** Under dsh the root loop is dsh's agent, so rlmh's loop, `child.py`, `bridge.py` and `permissions.py` don't come along. Reuse the worker's fd discipline (fds 1 and 2 re-pointed per cell, so a `subprocess` can't write into the protocol pipe), its output cap and error formatting, and the sub-call helpers (`segments`, `over=`, `shared=`, `schema=` parsing). A timeout interrupts the cell instead of killing the REPL; if the REPL does restart, the next result says so ("REPL restarted; variables lost").
- **Sub-calls as dsh tools.** Register `llm`, `llm_batch`, `scan` and `ask_files` as ordinary dsh tools called from the REPL. In PTC mode the model can only call them inside `run_code`, and going through dsh's executor gives logging in the Trajectory view, cancellation with the run, dsh's parallelism cap, and usage in dsh's totals. The REPL keeps thin synchronous wrappers (`llm(prompt)`) so the rlmh API reads the same. They run on the agent's route by default, with preset settings for a sub-call model and thinking level, and are cache-shaped as in rlmh: fixed prefix first, question last.
- **`rlm()` child runs = dsh subagents** started with the RLM preset, not rlmh's `child.py`.
- **The preset.** "RLM mode": a minimal preset that lists only what it needs (our isolated runtime group, `tool-executor-ptc`, a curated tool set and our persona), not a 190-line copy of dsh's `ptc` preset that drifts every release. The persona is rlmh's `default` `system.md` and `guidance.md` adapted to `run_code`; `submit` becomes the final reply. Two reading paths (`tools.read` vs `segments`) and two delegation paths (`tools.subagent` vs `llm`) would confuse the model, so the preset narrows the tool set and the prompt names one way to do each. Check whether a plugin can replace dsh's generic `run_code` SDK instructions, which contradict rlmh's reading recipe.
- **A fixed tool set.** Everything is registered at load, so the tool list (and the cached prompt prefix) never changes during a session.

## 4. Roadmap (the build order, agreed 2026-11-07)

Work happens on branch `dsh-plugin`, folder `dsh-plugin/` (D-264). Steps run in this order. A step marked **needs Rishi** stops for him; everything else goes ahead without asking. Update the Status column when a step starts or ends, with its commit.

| # | Step | Status |
|---|---|---|
| 0 | Spike fixes (protocol fds, waits, abort, budgets, Python lookup, sub-call affinity key) | done, `b5f4de8` |
| 1 | Plugin tests in the verify gate and CI | done, `451f328` (CI run 42356257590 green on three OSes) |
| 2 | Sub-calls as dsh tools | done, `451f328` |
| 3 | rlmh's sub-call toolkit | done, `451f328`, except `rlm()` child runs (step 4b) |
| 4 | A proper RLM mode preset, with settings | done, `7b24bf7`, except a settings page in the GUI (step 4c) |
| 4c | A settings page in dsh's GUI (a client UI plugin) | done, `75cde1e` |
| 4b | `rlm()` child runs as dsh subagents on the RLM preset | done, `9a24f3b` |
| 5 | Works right after install (**needs Rishi**: installing into his dsh desktop) | done for dsh desktop (uncommitted) |
| 5b | Python for installs without dsh desktop: download it through uv after asking once in the GUI | todo |
| 6 | Cache guard | done, `390f2f5` (runs in CI, not the offline gate) |
| 7 | Permissions (dsh's read-only and plan modes inside the REPL) | done, `ac5c530` |
| 8 | Eval: RLM mode vs Standard (**needs Rishi**: spend estimate and go) | todo |
| 9 | Release: npm and dsh's plugin market (**needs Rishi**: publish OK) | todo |

### Progress notes (2026-11-07)
- **Step 2 result.** Each sub-call is an `llm` dsh tool call: the Trajectory view lists it as a `SUBTOOL llm` row with its prompt, answer and a `[sub-call tokens: N in, M of them cached; K out]` line (checked in the web UI). dsh's own usage total (the status bar) still counts only the main conversation: its token meter replays the session's main requests, so tool-internal model calls can't reach it without a dsh change.
- **Step 3 result.** `python/rlmapi.py` ports `segments`, `llm`/`llm_batch` with `over=`, `shared=`, `schema=` and `thinking=`, `scan` and `ask_files`. Shared prefixes go to the host once, by SHA-256 (checked), and tool calls carry only the id, so dsh's session log doesn't grow by a whole segment per sub-call. Live: a second pass over the same four 20k-character segments read 95-99% of its input from cache on 3 of 4 calls (the miss was a ~470-token tail segment). `thinking="off"` cut a counting answer to 2 output tokens, against about 6k at the inherited high effort.
- **Deferred:** `rlm()` child runs need dsh's subagent API; they are step 4b.
- **Step 4 result.** The preset is minimal now (persona, AGENTS.md instructions, time context, file, search, shell, web, ask-user, todo and present tools, compaction, and our isolated runtime group); jobs, scheduling, skills, goals, plan mode and subagents are left out (plan mode until step 7, subagents until 4b). The persona is rlmh `default`'s `system.md` and `guidance.md` adapted to `run_code`. RLM mode sets dsh's tool-result pruner to 12,000 characters, so a capped `run_code` result (8,000 plus a note) is never rewritten, which would miss the cache. Settings: `lib/settings.js` is a top-level `rlmhSettings` service with volatile fields (sub-call provider, model and reasoning effort, output cap, budgets), read live by the runtime and the `llm` tool; dsh's settings service can edit them and they survive in the profile's patch, but no dsh client builds forms from schemas yet (`autoGenerate`), so a GUI page is step 4c. dsh's PTC executor has no setting for its `run_code` SDK instructions (its only option is `maxParallelSubCalls`), so the persona and our runtime's instructions carry the RLM guidance.
- **Step 4 check (web UI, no hints in the task).** The §2 question: 33 steps (Standard 78), 12 sub-calls, 15/15 found plus 10 judgement-call extras. Main conversation 110k uncached, 682k cached (86%), 22k out; sub-calls 108k in, 86k out. Total uncached input about 218k against Standard's 433k. dsh compacted twice in 33 steps (the misses at steps 24 and 30; step 31 half-cached after), which step 6 should explain. Sub-calls inherited the main model's high effort and spent 86k output tokens: the default sub-call effort is a decision for Rishi.
- **Step 4b result.** `lib/rlm-tool.js` registers an `rlm` dsh tool, and the REPL's `rlm(task, context=None)` calls it. It starts a child through dsh's subagents service (`startActivation`, provider `spawn`, `agentPreset: 'rlm'`, `delivery: 'caller'`, so the parent waits for the answer and gets no completion notice in its conversation). The child is a dsh subagent session in RLM mode with its own REPL, shown in dsh's subagent views and limited by the user's Subagent settings (depth, default 1, so a child can't start its own children; at most 8 at once). `context` is written to a file under the temp folder and the child is told to load it, so the input never enters the child's prompt. Live check (web UI): a child given three lines as context loaded the file in its first cell and answered "Your input has 3 lines, and the last line is `gamma`." Not ported from rlmh: `tools=` (read/edit/none; a child has the RLM preset's tools and the parent's permissions), `max_turns` (dsh has no turn budget), and `rlm_async`/`gather` (several `rlm()` calls can go out together with `asyncio.gather` over `await tools.rlm(...)`).
- **Step 4c result.** `lib/client.js` is the browser half of the package (`package.json` `exports["./client"]` and `dsh.client`, loaded as-is with dsh's React and UI primitives, no build step). It puts an **RLM mode** card in Plugins → Built-in plugin settings, beside Subagent, Web search, Agent loop and Shell, with six fields: sub-call provider, model and reasoning effort, result size, sub-calls per `run_code` call, and the fallback parallel limit. It uses dsh's shared settings form (staged until Save, an Overridden badge and Reset per field, an empty field resets), over the volatile fields of the `rlmh-settings` entry. Checked in the web UI: a saved effort lands in the profile's patch and reaches the model call. A configured effort is now fitted to the model's own list (kept, mapped from an rlmh level, or dropped), so a mistyped value can't fail every sub-call. Text fields for now; a model drop-down would be friendlier.
- **A packaging rule that can stop dsh from starting.** A package with a browser half may have only one active top-level entry in the deployment. With two (`./lib/settings.js` and the package root), dsh's client-modules plugin failed and the whole web app refused to start ("package rlmh-dsh resolves from multiple active Loader sources"). The package root is now the settings service (`lib/index.js`) and every other top-level row is off by default; RLM mode's own rows load only inside a session and didn't trip the rule. Step 9 must test install and start-up on a clean profile, since a mistake here breaks dsh for the user, not just RLM mode.
- **Tracebacks** now show only the cell's own lines and the error, not the plugin's files (`rlm_repl.py`, `rlmapi.py`).
- **Step 6 result.** `test/e2e/cache-guard.mjs` runs the real dsh (a throwaway `DSH_HOME`, a headless profile with this plugin installed and RLM mode's runtime and `llm` tool on) against a fake OpenAI-compatible model server that records every request and answers from a script (a `run_code` with a sub-call, a second `run_code`, a reply). It checks that each main-conversation request declares the same tools and starts with the previous request's messages, byte for byte; that the main conversation keeps one `x-session-id` and sub-calls send `<session>:sub`; that a sub-call is a separate request with no tools; and that the REPL kept its variables. All 13 checks pass locally. The fake route is named `openrouter` (pi-ai only sends affinity headers for providers it knows) with its `baseURL` pointed at the fake. It needs a dsh CLI, which an offline gate can't assume, so it runs in CI (`npm install -g @deepseek-ai/dsh@0.2.2-rc.1` in the `dsh-plugin` job) and by hand (`node test/e2e/cache-guard.mjs`, dsh from `$DSH_CLI`, desktop's CLI, or PATH).
- **Why dsh compacted twice in 33 steps.** dsh compacts at `min(W × 0.8, W − O − 65,536)` tokens, where `O` is the request's output cap. The DeepSeek Flash entry dsh imported from OpenRouter declares `maxTokens: 943718`, and every request reserves it, so `1,048,576 − 943,718 − 65,536 = 39,322`: every session on that model, in every mode, compacts at about 39k tokens, and each compaction costs a cache miss. Fix: a smaller output cap on that model entry (for example 65,536 puts the trigger near 840k). It's the user's model configuration, not the plugin's. Step 9's README should warn about it, and the plugin could check it once at start-up.
- **Step 7 result.** The runtime reports the deployment's file-policy mode (`sandboxMode`), so dsh resolves each session's policy, passes it to every run, and offers the model its one-time, user-approved escalation (`sandbox_permissions` with a justification). The REPL is launched through dsh's sandbox service (`ctx.sandbox.confine`) under that policy, as dsh's own Node runtime is: read-only (plan mode included) and workspace-write confine the process and everything it starts; danger-full-access runs it directly. A policy change restarts the REPL under the new policy and says so. Without a sandbox service, or when the backend refuses, a confined mode fails closed (`sandbox-unavailable`). Results carry dsh's sandbox facts (mode, enforcement, and whether a denial shows in the error, from the backend's own signatures). Python runs with `-B`, so it writes no bytecode. Live on Windows (dsh's ACL backend, enforcement `partial`): under read-only a write in the workspace was denied and dsh showed its escalation guidance; under workspace-write a write inside the workspace succeeded and one to `C:/Users/Public` was denied. In `F:/Personal/RLM/dsh-spike/ws3`, workspace-write failed closed with `SetNamedSecurityInfoW failed (Win32 5)`, and so did dsh's own PTC mode there: dsh's Windows backend can't grant write access on that folder, which is a dsh/folder-permission matter, not the plugin's.
- **Step 5 result (2026-11-07).** `npm pack` makes a 30 kB `rlmh-dsh-0.0.1.tgz` (13 files). Installed from that file into a throwaway profile, it passes the cache guard (`RLMH_DSH_PLUGIN=<tgz> node test/e2e/cache-guard.mjs`). In Rishi's dsh desktop app: Plugins, Add plugin, "Install a third-party plugin" (it takes an npm package name, a GitHub repository or a local path; a `.tgz` path works), then Install and Enable now, with no restart and no terminal. The RLM mode settings card and the RLM mode preset appeared at once. A new RLM-mode session in the desktop app ran with the desktop's bundled Python and no other setup: asked how many decisions a 60k-character part of the log holds and which three are about API keys, it counted 167 in Python (48 S plus 119 D, correct; its final text swapped the two labels) and used 5 sub-calls for the judgement part, 12 steps, 68% cache hit. The desktop profile now holds `rlmh-dsh` as `file:F:/Personal/RLM/dsh-spike/pack/rlmh-dsh-0.0.1.tgz`; a newer build is installed the same way, and once it is on npm (step 9) the package name replaces the path.
- **Python without dsh desktop.** The lookup is now: the configured `pythonBin`, dsh desktop's bundled CPython, an installed rlmh's Python, the Python 3.12 uv already has (`uv python find`, which never downloads), then `python`/`python3` on PATH. With none, the agent gets a plain message (install the desktop app, or Python 3.12 from python.org or `uv python install 3.12`). Downloading Python automatically, which D-264 asks for, needs a bundled uv and a consent prompt in dsh's GUI: step 5b.

### Step 1. Plugin tests in the verify gate and CI
- A `dsh-plugin` stage in both `scripts/verify.ps1` and `scripts/verify.sh`: `npm ci --offline` in `dsh-plugin/` (from npm's cache, so the gate stays offline), then the Node tests (`node --test`) and the Python tests (`python -m unittest`, on uv's Python 3.12 from the engine project).
- A `dsh-plugin` job in `.github/workflows/ci.yml` on Windows, macOS and Linux: Node 24, `npm ci`, the same two test commands. Actions pinned by SHA like the rest; zizmor stays clean.
- Done when: the gate runs and passes the stage locally, and CI is green on the branch on all three OSes.

### Step 2. Sub-calls as dsh tools
- A plugin in the preset registers `llm` as an ordinary dsh tool. Its route is the agent's model and reasoning effort, or the preset's sub-call setting, with its own affinity key `<session>:sub`. The REPL's `llm()` and `llm_batch()` become thin synchronous wrappers that call this tool through the `run_code` binding, one call per prompt, so dsh's executor dispatches them.
- What that buys: each sub-call is logged as a `tool/ptc-dispatch` (it shows in the Trajectory view), is cancelled with the run, and runs under dsh's sub-call parallelism cap (`tool-executor-ptc.maxParallelSubCalls`).
- Find out whether dsh's usage display counts tokens spent inside a tool. If not, report them another way (the tool result, or the session's usage events) so users see what sub-calls cost.
- Done when: a live run's sub-calls show in the Trajectory view, their tokens are visible in dsh, and offline tests cover the wrappers.

### Step 3. rlmh's sub-call toolkit
- Port from rlmh's worker (`engine/rlm_engine/worker/agentapi.py`, `cacheapi.py`), adapted to the tool path: `segments(size)` (text cut at line ends, about 40,000 characters each), `llm(prompt, over=seg)` and `llm_batch(prompts, over=segs)` (the segment's bytes first, the same every time, so the provider caches them), `llm_batch(prompts, shared=text)`, `schema=` (parsed answers), `thinking=` per call, `scan(question)`, `ask_files(files, question)`.
- `rlm(task, ...)` child runs as a dsh subagent on the RLM preset (not rlmh's `child.py`), if dsh's subagent API allows it cleanly from a plugin; otherwise a later step.
- Done when: offline tests for each helper, and a live run shows cache hits on repeated `over=` segments.

### Step 4. A proper RLM mode preset, with settings
- Replace the 190-line copy of dsh's `ptc` preset with a minimal one: the isolated runtime group, `tool-executor-ptc`, the sub-call tool, a curated set of dsh tools (one way to read, through the REPL's helpers), and the persona: rlmh `default`'s `system.md` and `guidance.md` adapted to `run_code`.
- Settings a user can change in dsh's GUI: sub-call model (default: the agent's own), sub-call reasoning effort, output cap, budgets.
- Check whether a plugin can replace dsh's generic `run_code` SDK instructions, which contradict rlmh's reading recipe.
- Done when: the long-document test (§2) delegates with no hints in the task, in the web UI, with the settings visible.

### Step 5. Works right after install (needs Rishi)
- Install from dsh desktop's own plugin manager or plugin market, with no terminal. The desktop profile refuses changes from the `dsh` CLI ("managed exclusively by the Electron application"), so this is tested through the GUI on Rishi's machine.
- No Python on the machine: fetch Python 3.12 through uv automatically (bundling uv as rlmh's npm packages do), asking once in the GUI before downloading.
- Done when: a fresh profile installs the plugin from a packed `.tgz` through the GUI and runs RLM mode with no other step.

### Step 6. Cache guard
- A test that records every request in a session (fake provider) and asserts each starts with the previous one byte for byte, except right after dsh's own compactions.
- In real runs, check per-step `cacheReadTokens` (what the provider actually cached) and find the cause of any miss without a history rewrite. If OpenRouter routing causes main-conversation misses, pin the endpoint (D-120).
- Done when: the fake-provider test runs in the gate, and a live long run shows no unexplained misses.

### Step 7. Permissions
- Honour dsh's `sandboxMode`: read-only and plan mode must reach the REPL (today a plan-mode `run_code` can write files). Either run the worker under dsh's sandbox runner, or have the REPL's audit hooks ask through dsh's approval service.
- Done when: a write outside the workspace asks or is denied per dsh's mode, tested offline and live.

### Step 8. Eval (needs Rishi)
- `rlmh eval` drives `dsh headless --json` on `harness-eval-v1`, RLM mode against Standard, reading and coding tasks, with cost from both the root and sub-calls.
- Done when: a held-out comparison with cost, run after Rishi has seen the estimate and said go.

### Step 9. Release (needs Rishi)
- npm publish (trusted publishing, like rlmh's packages), a README, the `dsh-plugin` GitHub topic, a listing in dsh's plugin market.
- Done when: `dsh plugin add rlmh-dsh` works on a clean machine.

## 5. Caching rules for the plugin

1. Fixed text everywhere: persona, runtime instructions and settings text are constant for a session; no dates, ids or counters.
2. Fixed tool set: register nothing during a session. In PTC mode every tool's stub is in the system prompt, so one change misses the cache from the first token.
3. No request rewriting: don't use `agent/request` or the assembly hooks, and don't inject per-turn context.
4. dsh's compaction, not ours.
5. Sub-calls: fixed prefix first (segment or shared text), question last, through `ctx.llm` with no custom cache headers.
6. Two guards in step 7: the byte-prefix test (what dsh sends), and an assertion on per-step `cacheReadTokens` in real runs (what the provider actually cached). The spike had mid-run misses with no prompt change: t6 step 7 (14k uncached, 0 cached) and t5-rlm steps 22, 36, 41 and 45. Possible causes are dsh's tool-result pruner (it trims results over 8,192 characters, which rewrites earlier history) or OpenRouter moving the request to a cold backend (D-118). Find out which before blaming either; if it's routing, pin the OpenRouter endpoint for the root and sub-calls (D-120).

## 6. Compatibility rules (staying a plugin across dsh updates)

- Public seams only: `PtcRuntime`, the tools registry, `ctx.llm`, `@deepseek-ai/dsh-agent-preset` rows, `cordis:group` isolation. No internal imports, no patched dsh files.
- `engines.dsh` declares the tested range; dsh refuses to load us outside it rather than breaking mid-session. Widen it after each dsh release passes our tests.
- Read dsh's upgrade guides per release; the plugin contract is still preview and says so.
- Creator mode is a way to author plugins in chat, not a compatibility layer. We can use it to check that our bundle installs the way a user's would, but our package is hand-built and tested.

## 7. Risks and open questions

- **Preview API churn.** dsh 0.2.x breaks plugin contracts often. Mitigation: the narrow seams above, `engines.dsh`, and a CI job against dsh's `next` tag.
- **Python for npm/web installs.** Desktop ships CPython; npm installs don't. Options: rlmh's existing uv path (`rlmh setup`), or require desktop. Decision needed.
- **Sandbox: fixed in step 7.** The REPL now runs under dsh's sandbox service and the session's policy, like dsh's own runtime. It is dsh's same-world confinement (partial on Windows), not isolation; the README should say so.
- **Environment.** The spike gave the REPL almost no environment (only `SYSTEMROOT`), which breaks git, pip and temp files. Use rlmh's rule instead (D-29): strip only key-like names.
- **Spike bugs: fixed (2026-11-07, `dsh-plugin/`).** The REPL moves its protocol to private descriptors and captures fds 1 and 2 per cell, so a `subprocess` can't corrupt it (checked live in dsh). Every pending wait is released when input closes or a cell is interrupted. Tool results read as attributes. The environment strips key-like names only (D-29). The host passes the run's abort signal to sub-calls, caps their parallelism (8) and their number per `run_code` call (200), interrupts a cell on timeout and kills the REPL only after a grace period (the next result then says the REPL restarted), never writes to a dead REPL, and finds Python itself (configured, then dsh desktop's, then rlmh's, then PATH). Sub-calls default to the agent's model **and its reasoning effort**. Tests: `dsh-plugin/test/` (12 Python, 14 Node, all passing on Windows); they aren't in the verify gate yet.
- **Sub-call cache affinity: fixed.** dsh's loop gives every main request a session id, which pi-ai turns into OpenRouter's session-affinity headers and `prompt_cache_key`; the spike's sub-calls sent none, so each could land on a different backend (27 sub-calls, 128 cached tokens). Sub-calls now send `<agent session id>:sub`: their own stable key, never the root's (D-118). Live, a second pass over the same three 20k-character chunks read about 5k cached tokens on 2 of the 3 calls. The step-7 root miss in t6 had no history rewrite in dsh's log and no tool result near the pruner's 8,192-character threshold, so it was provider-side.
- **Python path.** The spike hard-codes the desktop app's Python. Resolve it from the dsh install, else fall back to rlmh's uv Python.
- **Precision, not only cost.** RLM mode halved uncached input but listed 15 extra decisions to Standard's 6 on a judgement question. One run each, reading tasks only. Making RLM mode the default needs `harness-eval-v1` results on both splits, coding tasks included.
- **Sub-call visibility and cost.** The spike's sub-calls don't appear as rows in dsh's Trajectory view (it shows the `run_code` calls only), and it's not checked whether dsh's token counter includes them. Users could undercount spend.
- **Model behaviour.** Without our prompt and cap the model doesn't delegate (§2 row 7). The prompt needs tuning for `run_code` and dsh's Python stubs; the spike model also tried attribute access (`r.lines`) on plain dicts.
- **Sub-call quality.** Sub-calls ran with no reasoning effort set and got an easy question wrong; RLM mode needs a sub-call thinking setting.
- **OpenRouter cold backends.** One mid-run cache miss with no prompt change looked like OpenRouter routing to a cold backend (rlmh's D-118 problem). dsh owns routing for the root.

## 8. Decisions (Rishi, 2026-11-07, D-264)

1. **Where it lives:** this repo, folder `dsh-plugin/`, on branch `dsh-plugin`, which is never merged into `main`.
2. **Python without dsh desktop:** fetched through uv, as `rlmh setup` does.
3. **The Ink TUI and the CLI** stay as they are.
4. **Sub-call model:** the agent's own model by default; users can pick another in the preset's settings.

Two requirements on top:
- **It works right after install.** No terminal steps, no Python to install by hand, no config file to edit: install the plugin, pick "RLM mode", go.
- **Caching is watched closely.** dsh's own cache rates are very high, so RLM mode must not lower them; every unexplained miss gets a cause.
