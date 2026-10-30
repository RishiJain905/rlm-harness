# rlm-harness

A model-agnostic harness for Recursive Language Models (RLMs). The model never reads a long input directly. It writes Python against the input in a REPL and hands pieces of it to sub-calls (`llm`, `llm_batch`), then calls `submit` with the answer. Any model can be the root or the sub-call model: Anthropic, OpenAI, DeepSeek, OpenRouter, Gemini, a local server (vLLM, Ollama, LM Studio, llama.cpp), or the RL-trained Qwen LoRA from [RishiJain905/RLM](https://github.com/RishiJain905/RLM).

It is one program, `rlmh`, in three parts:
- **The interface:** an interactive terminal app on Bun, with `/providers`, `/model`, a status line and a live sub-call panel.
- **The model gateway:** inside the same app. It holds your keys in the OS credential store and calls the providers.
- **The harness:** a Python engine with the agent loop, the trained contract, the REPL and its tools, and permission prompts.

It runs natively on macOS, Windows and Linux, with no Docker and no WSL. It never makes a call with your key that you didn't ask for.

**Status:** v0 is being built in the open. The skeleton works: `rlmh info` starts the Python engine and talks to it over stdio, and CI builds `rlmh` for macOS, Windows and Linux. Runs, the model gateway and the real interface come in the next steps ([progress](documentation/v0/progress.md)).

- [Architecture](documentation/legacy/architecture.md): the three parts, how a run works, why the model delegates, caching, safety and the roadmap.
- [v0 design](documentation/legacy/v0-design.md): the v0 spec: the link between app and engine, contract, call formats, gateway, worker, permissions, interface and tests.
- [v0 build plan](documentation/legacy/v0-build-plan.md): the ten steps to v0, with the decisions each one needs.
- [Options research](documentation/legacy/options-research.md): why a thin build and not a fork of DeepSeek Harness, and the Harness² experiment.

Licence: MIT.
