# Part 2 harness: which base, and the Harness² experiment

> Written 2026-10-19 while the RLM training run was paused. This is the research behind the choice of base. Rishi chose the thin build on 2026-10-19. Paths such as `rlm_rl/` and `documentation/production-spec.md` refer to the training repo, [RishiJain905/RLM](https://github.com/RishiJain905/RLM). Sources are at the end.
>
> **Superseded in part on 2026-10-20.** The harness is now a TypeScript app on Bun driving a Python engine, so it has its own CLI and UI rather than borrowing DeepSeek Harness's through MCP. The MCP server wrapper below is deferred until a real use for it appears. The thin-build choice and the Harness² experiment stand. Current design: [architecture.md](architecture.md).

## 1. Recommendation

**Build the harness thin, from our own training code, and connect to DeepSeek Harness from the outside instead of forking it.** The training environment already is an RLM harness for one model. `rlm_rl/env.py`'s `run_episode` takes any OpenAI-compatible client, and `bridge.py`, `repl_worker.py`, `repl_tools.py` and `sandbox.py` hold the frozen API, the prompts, the REPL, the coding tools and the sandbox (about 4,200 lines). The harness core is that loop with the training-only parts removed (token ids, reward, hack detectors, grader) and a plain model client added. It is the only base where the trained LoRA sees exactly what it saw in training.

DeepSeek Harness is a good harness, but it is a 400,000-line TypeScript codebase built around native tool calls. Its Python code runner is experimental and starts a fresh process every run, so variables do not persist. Making it run RLM means writing a persistent Python runtime and a new agent loop inside it, which is the RLM core anyway, plus tracking a developer preview that warns of breaking changes. The parts of it worth having (MCP, skills, sub-agents, UI) can reach our harness if we expose the harness as an MCP server, which dsh, Claude Code, Codex and OpenCode can all call.

**For the Google paper, use Google's own code.** Harness² was released (Apache-2.0, Python). Its runtime plug-in interface is five methods, so an `rlm` plug-in lets Harness² evolve our RLM harness without reimplementing the method.

This keeps decision 4 of 2026-10-10 (write our own loop; read alexzhang13/rlm for reference). Forking dsh would have reversed it.

## 2. What any base has to give the trained LoRA

The LoRA only knows what it saw in training (prompt v4, `rlm_rl/bridge.py`):

- **Turn format:** each turn is a short plan and one fenced `python` block in plain text. It is not a tool call. Prompt v3 exists because base Qwen kept answering in tool-call tags.
- **REPL names:** `context`, `llm`, `llm_batch`, `submit`, and for coding `read_file`, `find_files`, `grep`, `edit_file`, `write_file`, `shell`, `diff`. All are synchronous. The project map's `llm_query` versus `llm` question was settled on 2026-10-10 (spec §0, 1a). `llm_query` survives only in `rlm_rl/archive/`.
- **Observations:** `REPL output:` capped at 8,000 characters, then `(N turns left, M sub-calls left)`, using the same error texts.
- **Sub-calls:** a plain completion from a separate model (the frozen base in training), with prompts up to 60,000 characters under v4.

A general model (Claude, DeepSeek, GPT, base Qwen) can use anything. The LoRA needs this exact contract, and our own code is the only base that already has it.

## 3. DeepSeek Harness

| | |
|---|---|
| Repo | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) |
| Licence | MIT |
| Released | 13 Aug 2026, as a "developer preview" that warns of compatibility-breaking changes |
| Activity | about 252k stars, 22,395 commits, latest 17 Oct 2026 (release 0.2.1-rc.2). It does not accept outside pull requests; extension is meant to happen through plugins |
| Language | TypeScript/Node monorepo on the Cordis plugin framework, about 410k non-test lines under `packages/`. Its Python is only an SDK that drives `dsh` as a subprocess |

**How it works.** Everything is a plugin, including the model adapter, the tool registry, the session log and the agent loop itself. A step is one model request plus the tool calls it makes, with tools registered as JSON schemas (native function calling). Sub-agents are managed child agents (fresh, forked, or delegated to Claude Code, Codex or ACP) that return a child id and a completion notice later. They are not a synchronous call inside code.

**Caching.** It has no cache layer of its own. Its design is cache-friendly: an append-only session log ("model-visible means logged"), and every package documents its "KV cache effect", meaning whether it keeps the request prefix stable. The provider does the caching (DeepSeek's context cache, vLLM prefix caching, Anthropic cache markers). Compaction starts at 80% of the window and keeps 16%.

**Model-agnostic: yes.** It has a DeepSeek adapter plus a pi-ai adapter for Anthropic, OpenAI, Bedrock, Azure, Gemini and any OpenAI-compatible gateway, including self-hosted vLLM. A keyless local server needs a placeholder key.

**Closest feature to RLM.** Its "Code" (PTC) mode gives the model a `run_code` tool that runs a program against host-provided async functions. The Node runtime can keep state between runs. The Python runtime is experimental: it is macOS/Linux only, starts a fresh process per run, keeps no variables between runs, and is enabled in no shipped profile.

**Cost of adding RLM to it:**
1. A persistent Python runtime (a fork of the experimental one) that keeps one process per session.
2. Bindings for `llm`, `llm_batch`, `submit`, `context` and the seven coding tools, with synchronous wrappers because dsh bindings are async.
3. A new agent-loop driver that reads fenced `python` blocks from plain text and writes observations in the training format, because the LoRA was not trained on tool calls.
4. Prompt v4 as a preset.

All of this would be TypeScript inside Cordis, tracking a preview that changes weekly. It would stay model-agnostic.

## 4. The Google paper: Harness²

**"Harness²: Recursive Agent Harnessing for an Open World"**, [arXiv 2610.14224](https://arxiv.org/abs/2610.14224), submitted Friday 9 Oct 2026 by Google Cloud AI Research (Xu, Chen, … Lee, Pfister). Code: [google-research/harness2](https://github.com/google-research/harness2), Apache-2.0, Python 3.12, about 12.7k lines, last commit 13 Oct. Coverage of its open-source release peaked on 18-19 Oct. So a harness-level implementation does exist.

**What it improves.** It improves the harness around a frozen model, never the weights. A harness is eight editable files: system prompt, guardrails, memory, skills, tool guidance, scripts, sub-agents, and a middleware plugin.

**Task-level recursion (Propose, Probe, Compose), run on each task:**
1. Run the current harness once to get a reference trajectory.
2. An editor model proposes two edited harnesses: an "invariant" one (planning, tool use, context management, delegation) and a domain one.
3. Run both on the same task and compare their behaviour with the reference. There is no verifier: the contrast is evidence, not a grade.
4. The editor merges what the evidence supports into a final harness, which then runs.

This can repeat k times in parallel or in sequence, with a blind selector choosing the final output.

**Harnessing-level recursion.** After each task a reflection step writes the lessons into a library (harness plus `EXPERIENCE.md`). Later tasks start from the base harness but can reuse library entries.

**Results.** The editor was Claude Opus 4.8; the frozen executors were GLM-5 and Gemini 3.5 Flash under OpenCode and Codex. It gained up to +11.5 on WorkBuddy-Bench, +4.5 on JobBench and +11.8 on LAB (partial credit), with a few points more at k=5.

**The code.** A runtime plug-in ("substrate") implements five methods: `surface`, `materialise`, `execute`, `read_trajectory` and `preflight`. The interface is 83 lines; the OpenCode and Codex plug-ins are 395 and 480 lines. Models default to Vertex AI, and the editor runs through the `claude` CLI or OpenCode. The README warns that executors have unrestricted network access and that Codex runs unsandboxed.

**Cost shape.** At k=1 each task costs about four full executions (reference, two probes, the composed run) plus editor sessions. k=5 costs about 20. An RLM execution is itself 10-80 sub-calls, so this multiplies quickly.

**Two related papers, in case the one you meant was a different one:**
- **RRSI**, Google, [2609.24972](https://arxiv.org/abs/2609.24972) (21 Sep, code [google-research/rrsi](https://github.com/google-research/rrsi)). Offline harness evolution, with regularisation so the gains survive on unseen benchmarks.
- **Self-HPO**, [2610.22791](https://arxiv.org/abs/2610.22791) (16 Oct; Gao et al., not Google). It alternates harness proposals with RL weight updates on Qwen3.5-35B-A3B coding agents and reports 57.8% to 64.8%. It is the closest prior work to combining harness evolution with our RL training, and our write-up should cite it.

## 5. Other bases considered

**[alexzhang13/rlm](https://github.com/alexzhang13/rlm)** (MIT, about 5.6k stars, `pip install rlms`) is a better RLM base than dsh. It is Python and already does the RLM loop with OpenAI, Anthropic, OpenRouter and vLLM clients, local/Docker/Modal/E2B sandboxes, recursive `rlm_query`, and a trajectory visualiser. Its REPL names (`llm_query`, `llm_query_batched`) and turn format are not the ones the LoRA learned, and our env already has the exact loop. Borrow ideas from it (recursion, extra sandbox backends, the visualiser), not its code.

## 6. Fork versus thin build

| | Thin, from `rlm_rl` (recommended) | DeepSeek Harness plugin | Fork alexzhang13/rlm |
|---|---|---|---|
| Language | Python | TypeScript | Python |
| Matches the LoRA's contract | Exactly (same modules) | Needs a new loop driver and runtime | Needs renames and a new turn format |
| Model-agnostic | Yes (one OpenAI-compatible client, plus Anthropic) | Yes | Yes |
| Caching | Provider prefix caching, see below | Same, with cache-stable design throughout | Same |
| MCP, skills, UI | Later, through an MCP server and Harness² skills | Built in | Partial (visualiser) |
| Upstream churn | None | High (preview, weekly) | Low |
| Work to a first version | Small: reuse about 4.2k lines, add about 500 | Large | Medium |

**Caching in a thin harness.** RLM's main saving is that the long input never enters the prompt: it lives in the REPL. The root's message list is append-only, so automatic prefix caching works on vLLM (`--enable-prefix-caching`), the DeepSeek API and OpenAI. Anthropic needs one cache marker on the latest message, a few lines of code. `llm_batch` prompts should put the shared instructions first and the chunk last so they share a cached prefix. dsh's caching advantage matters little here.

## 7. Mixing the three: the experiment

**Question.** How much of the RLM skill can harness evolution give a frozen model, compared with RL training, and do the two add up?

Every arm uses the same tasks and the same sub-call model:

| Arm | Root model | Harness |
|---|---|---|
| A | Base model (base Qwen, plus a general model such as DeepSeek or Claude) | RLM harness, prompt v4 |
| B | Same | Harness²-evolved RLM harness |
| C | Trained LoRA (once prod-v2 delivers) | Prompt v4 |
| D | Trained LoRA | Evolved harness, without changing the system prompt the LoRA was trained on |

**What Harness² may edit in an RLM harness:**
- Root guidance appended to the system prompt.
- Guardrails (budget rules).
- Memory notes.
- Skills (playbooks such as "multi-hop search" or "find and fix").
- Tool guidance for `llm_batch` and `grep`.
- `helpers.py` preloaded into the REPL (chunkers, map-reduce helpers).
- The sub-call profile (its system prompt and model).

Middleware is left out at first. For the LoRA arm, the system prompt stays frozen and only the other parts change.

**Tasks.** Start with context search, the only family where sub-calls clearly paid off in the step 12 pilot (reward 0.34-0.35 with sub-calls, against 0.00-0.11 without). Use about 20 tasks held out from training. Gold answers stay on the PC and away from the editor, which matters because Harness²'s executors have open network access by default.

**What is new here.** Harness² and Self-HPO evolve general coding and office agents. Nobody has evolved an RLM harness (sub-call orchestration, REPL helpers, delegation prompts) or measured it against an RL-trained RLM root.

## 8. Smallest first version

1. **v0, the harness core.** Package `rlm_harness/` with `run(task, context, root, sub)`. Model profiles (base URL, model, key variable, thinking) go in one small file, and one OpenAI-compatible client covers vLLM, Ollama, LM Studio, llama.cpp, the DeepSeek API and OpenRouter. It reuses the Docker sandbox from training (Docker Desktop is already set up), with a plain-subprocess mode as an opt-in. It writes the trajectory as JSONL and adds a CLI. A parity test replays a recorded training episode through the harness and checks the messages are identical, which proves the LoRA will see what it saw in training. The smoke run is five context-search tasks on two models, using your own API keys or a local model and no W&B credit.
2. **v1.** `rlm()` recursion with a depth limit (off for the LoRA, which never saw it), and an MCP server wrapper so DeepSeek Harness, Claude Code, Codex and OpenCode can call it.
3. **v2, the experiment.** A Harness² `rlm` plug-in and arms A/B on about 20 tasks, sequential k=2. Arms C/D follow once the LoRA exists. The cost can't be estimated until v0 measures the cost per episode. It works out as tasks × about 4k executions × cost per episode, plus editor time.

v0 also settles step 13b: the final eval can run in the harness core instead of the training loop.

## 9. Decisions this touches

- **Decision 4 (own loop):** kept. Forking dsh would have reversed it.
- **Decision 2 (HTTP bridge):** training settled on a Unix socket into a `--network none` container (3b). The wire protocol doesn't depend on the transport, so v0 keeps the training transport.
- **Decision 3 (Claude Science primitives):** these come in v1 and later. MCP comes through the server wrapper, and skills, scripts and sub-agent profiles map onto Harness²'s editable files.
- **The bridge-name question in project-map.md:** already settled (`llm`, `llm_batch`, `submit`, `context`), so that open item is stale.

## Sources

- DeepSeek Harness: [repo](https://github.com/deepseek-ai/deepseek-harness), `docs/architecture.md`, `packages/ptc-runtime`, `packages/experimental/ptc-runtime-python`, `packages/llm/llm-pi-ai`, `packages/subagent` (read from a shallow clone of commit 2026-10-17); [The New Stack](https://thenewstack.io/deepseek-harness-open-source-plugins/)
- Harness²: [arXiv 2610.14224](https://arxiv.org/abs/2610.14224), [HTML](https://arxiv.org/html/2610.14224v1), [google-research/harness2](https://github.com/google-research/harness2) (read from a shallow clone, `harness2/substrate/base.py`, `core/spec.py`, `config.py`)
- RRSI: [arXiv 2609.24972](https://arxiv.org/abs/2609.24972), [google-research/rrsi](https://github.com/google-research/rrsi)
- Self-HPO: [arXiv 2610.22791](https://arxiv.org/abs/2610.22791)
- alexzhang13/rlm: [repo](https://github.com/alexzhang13/rlm)
- Our code: `rlm_rl/env.py` (`run_episode`), `rlm_rl/client.py` (`ModelClient`), `rlm_rl/bridge.py` (prompt v4, names), `rlm_rl/sandbox.py`, `documentation/production-spec.md` §0-1, `documentation/production-build-plan.md` 13a-13b
