# rlm-harness

A model-agnostic harness for Recursive Language Models (RLMs). The model never reads a long input directly. It writes Python against the input in a sandboxed REPL and hands pieces of it to sub-calls (`llm`, `llm_batch`), then calls `submit` with the answer. Any OpenAI-compatible model can be the root or the sub-call model, whether it is an API model, a local one (vLLM, Ollama, LM Studio) or the RL-trained Qwen LoRA from [RishiJain905/RLM](https://github.com/RishiJain905/RLM).

**Status:** design. Nothing is built yet; this is an open build.

- [Architecture](documentation/architecture.md): what is built, how a run works, and why the model delegates.
- [v0 design](documentation/v0-design.md): layout, contract, configuration, interfaces, tests and build order.
- [Options research](documentation/options-research.md): why a thin build and not a fork of DeepSeek Harness, and the Harness² experiment.

Licence: Apache-2.0.
