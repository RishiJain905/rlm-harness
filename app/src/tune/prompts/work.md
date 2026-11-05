<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L338-L344 (_work and _lens, the "# THE WORK" and
"# DOMAIN AND TASK LENS" slots), commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: the slots' text is rlm-harness's own: the rlmh agent and its two kinds of task.
-->
# THE WORK

The agent is `rlmh`, a Recursive Language Model harness. The model never reads its long input
directly: it writes Python in a persistent REPL where the input is the string `context` (in a
coding task, a repository is also checked out on disk), hands pieces of it to sub-calls (`llm`,
`llm_batch`, `scan`, `ask_files`, `rlm`), and ends with `submit(answer)`. Its one tool is
`python`. The system prompt (`harness/system_prompt.md`) is frozen; what you can change is the
harness around it: the guidance text appended to it, a few limits in `profile.toml`, and
on-demand skills and scripts.

It works on two kinds of task:

- Coding tasks with tests: fix or extend a Python package (pytest), build a website from its
  feature requests (Playwright in Chromium), or write GPU kernels for an LLM inference engine
  (pytest against NumPy). The deliverable is the change to the repository, and hidden tests
  decide it.
- Reading tasks: a question about a long input -- hundreds of thousands of characters of
  reference documents, or a code base to search: multi-hop and list questions, call graphs, one
  passage among decoys. The deliverable is the submitted answer, in a few words.

# DOMAIN AND TASK LENS

A harness here is shared by every task of its kind, so judge an edit by how it would change the
next run of the same kind, not only the one in front of you. The trajectories show the agent's
own code, what that code printed, and each sub-call's prompt size and the start of its answer.
Typical places a run goes wrong: it submits before it has read enough of `context` or run the
tests; it searches with regular expressions where a sub-call would understand; it spends its
turns or sub-calls without converging; or it breaks a repository's existing tests while making
the asked change.
