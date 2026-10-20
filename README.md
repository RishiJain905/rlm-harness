# rlm-harness

A model-agnostic harness for Recursive Language Models (RLMs). The model never reads a long input directly. It writes Python against the input in a sandboxed REPL and hands pieces of it to sub-calls (`llm`, `llm_batch`), then calls `submit` with the answer. Any OpenAI-compatible model can be the root or the sub-call model, whether it is an API model, a local one (vLLM, Ollama, LM Studio) or the RL-trained Qwen LoRA from [RishiJain905/RLM](https://github.com/RishiJain905/RLM).

It has two halves: a TypeScript app on Bun (the `rlmh` CLI now; a TUI, a web UI and a Windows desktop app later) and a Python engine (the agent loop, the Docker REPL, the sub-call bridge and the model clients). API keys stay in your own environment variables.

**Status:** design. Nothing is built yet; this is an open build.

- [Architecture](documentation/architecture.md): the two halves, how a run works, why the model delegates, and the v0 to v3 roadmap.
- [v0 design](documentation/v0-design.md): layout, the app-engine protocol, contract, configuration, tests and build order.
- [Options research](documentation/options-research.md): why a thin build and not a fork of DeepSeek Harness, and the Harness² experiment.

Licence: Apache-2.0.
