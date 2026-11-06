# rlm-harness

A model-agnostic harness for Recursive Language Models (RLMs). The model never reads a long input directly. It writes Python against the input in a REPL and hands pieces of it to sub-calls (`llm`, `llm_batch`), then calls `submit` with the answer. Any model can be the root or the sub-call model: Anthropic, OpenAI, DeepSeek, OpenRouter, Gemini, a local server (vLLM, Ollama, LM Studio, llama.cpp), or the RL-trained Qwen LoRA from [RishiJain905/RLM](https://github.com/RishiJain905/RLM).

It is one program, `rlmh`, in three parts:
- **The interface:** an interactive terminal app on Bun, with `/providers`, `/model`, a status line and a live sub-call panel.
- **The model gateway:** inside the same app. It holds your keys in the OS credential store and calls the providers.
- **The harness:** a Python engine with the agent loop, the trained contract, the REPL and its tools, and permission prompts.

It runs natively on macOS, Windows and Linux, with no Docker and no WSL. It never makes a call with your key that you didn't ask for.

## Install

macOS or Linux:

```
curl -fsSL https://github.com/RishiJain905/rlm-harness/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```
irm https://github.com/RishiJain905/rlm-harness/releases/latest/download/install.ps1 | iex
```

On first run, `rlmh` asks before it downloads Python 3.12 through uv.

Or through npm (from v0.1.1): `npm i -g rlm-harness`, or `bun add -g --trust rlm-harness`. Either installs the same compiled binary, and the command is still `rlmh` ([design](documentation/v0/npm-install.md)).

**Status: 1.0.0.** v0 (0.1 and 0.2) built the engine, the model gateway, the interactive app and the one-command install, with parity against training. v1 is the Harness² release. It adds `rlmh eval` (run and grade a profile on an eval set, price first), `rlmh tune` and `/tune` (a harness that tunes itself from your tasks, off by default, with a hard cost cap), `/tuned`, the experience library, follow-ups in one conversation, compaction, and rlmh's own contract for the `default` profile. The experiment's numbers are in [the v1 results](documentation/v1/results.md); the build kit is [documentation/v1/](documentation/v1/README.md) ([progress](documentation/v0/progress.md)).

- [Architecture](documentation/legacy/architecture.md): the three parts, how a run works, why the model delegates, caching, safety and the roadmap.
- [v0 design](documentation/legacy/v0-design.md): the v0 spec: the link between app and engine, contract, call formats, gateway, worker, permissions, interface and tests.
- [v0 build plan](documentation/legacy/v0-build-plan.md): the ten steps to v0, with the decisions each one needs.
- [v1 results](documentation/v1/results.md) and [release notes](documentation/releases/v1.0.0.md): what 1.0.0 adds and what the experiment found.
- [Options research](documentation/legacy/options-research.md): why a thin build and not a fork of DeepSeek Harness, and the Harness² experiment.

Licence: MIT.
