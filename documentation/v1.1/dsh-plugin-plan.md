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

## 4. Build steps

| Step | What | Done when |
|---|---|---|
| 1 | **Bundle skeleton**: `packages/dsh/` in this repo (or its own repo, decision below), TypeScript, `engines.dsh`, peer deps, build to `lib/`, `dsh plugin add` from a local path and from a packed `.tgz` | installs into a fresh profile on Windows, macOS, Linux; CI checks it |
| 2 | **Runtime + worker**: `PtcRuntime` provider; a worker built from rlmh's fd discipline, output cap and error formatting; async `tools` bindings; cell interrupt on timeout; abort; sandbox mode | the spike's three tests pass; a `subprocess` printing in a cell can't corrupt the protocol; offline tests on a fake `ctx.llm` |
| 3 | **Sub-calls as dsh tools**: `llm`, `llm_batch`, `scan`, `ask_files` registered as tools, with `segments`, `over=`, `shared=`, `schema=`, `thinking=`, and synchronous REPL wrappers; budgets; `rlm()` as a dsh subagent on the RLM preset | sub-calls appear in the Trajectory view and dsh's usage totals; a sub-call cache test shows hits on repeated segments |
| 4 | **RLM mode preset**: a minimal preset (isolated runtime group, PTC executor, curated tools, persona from `default`'s prompt adapted to `run_code`), settings for sub-call model, thinking, cap and budgets | selectable in desktop and web; the long-document test delegates without hints |
| 5 | **Visibility check**: confirm sub-call tokens and cost reach dsh's usage display and the `--json` events (step 3 should give this for free) | a run's sub-calls show in the GUI with tokens |
| 6 | **Permissions and safety**: map rlmh's permission modes onto dsh's sandbox policy and approvals; env stripping at the worker hop | a write outside the workspace asks or is denied per dsh's mode |
| 7 | **Cache guard**: a test that records every request in a session and asserts each is a byte-prefix extension of the previous, except at dsh compactions | runs in CI on a fake provider |
| 8 | **Eval**: `rlmh eval` drives `dsh headless --json` (RLM mode vs Standard) on `harness-eval-v1` | a held-out comparison with cost |
| 9 | **Release**: npm publish (same trusted-publishing route as rlmh), README, a `dsh-plugin` GitHub topic, plugin market listing | `dsh plugin add rlmh-dsh` works on a clean machine |

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
- **Sandbox.** dsh's Node runtime confines file writes through its sandbox service; the spike runtime has none (`sandboxMode` undefined), so dsh's plan mode and read-only mode don't reach the REPL and a plan-mode `run_code` could write files. We need dsh's sandbox runner around the worker, or rlmh's audit hooks answering through dsh's approval service. The README says plainly that it is not a sandbox.
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
