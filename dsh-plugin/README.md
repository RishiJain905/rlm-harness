# rlmh-dsh: RLM mode for DeepSeek Harness

`rlmh-dsh` adds an **RLM mode** to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). In RLM mode the agent works as a Recursive Language Model: it never reads a long input straight into its conversation. It writes Python in a persistent REPL, hands pieces of the input to sub-calls (other model calls) and combines their answers in code. In our first tests on a long document, it answered with about half the uncached input of dsh's Standard mode.

It is the [rlmh](https://github.com/RishiJain905/rlm-harness) harness as a dsh plugin: dsh keeps the loop, sessions, approvals, compaction, caching, model routing, keys and the GUI.

## Install

In dsh desktop or `dsh web`: **Plugins → Add plugin → Install a third-party plugin**, enter `rlmh-dsh`, then **Install** and **Enable now**. No restart and no terminal.

From a terminal: `dsh plugin add rlmh-dsh` (add `--profile <name>` for another profile).

Then pick **RLM mode** in the mode menu of a new session.

Needs DeepSeek Harness 0.2.2-rc.1 or a later 0.2.x.

### Python

RLM mode runs code in Python 3.10 or later. It looks for one in this order: the CPython dsh desktop ships, an installed rlmh's, one in `~/.rlm-harness/python`, the 3.12 uv already has, then `python3`/`python` on PATH.

If there is none (for example a `dsh web` install without the desktop app), the first `run_code` asks you, through dsh's approval prompt, whether to download one. On yes it fetches uv 0.13.6 from its GitHub release (checked against a pinned SHA-256; skipped when uv is already on PATH) into `~/.rlm-harness/bin`, then a standalone Python 3.12 through uv into `~/.rlm-harness/python` (about 50 MB to download and 150 MB on disk, once). Nothing else on the computer changes. On no, that session doesn't ask again. `RLMH_HOME` moves `~/.rlm-harness`. Headless runs have no one to ask, so they fail with install advice instead.

## What the agent gets

One tool, `run_code`, a Python REPL whose variables persist across calls. Inside it:

| Function | What it does |
|---|---|
| `llm(prompt, over=None, schema=None, thinking=None)` | One sub-call. |
| `llm_batch(prompts, shared=None, over=None, schema=None, thinking=None)` | Sub-calls in parallel, answers in order. |
| `segments(text, size=None)` | Text cut into about 40,000-character slices at line ends. `over=segment` sends the slice first, byte for byte, so asking about it again hits the provider's cache. |
| `scan(text, question)` | The passages, quoted with offsets, that bear on the question, from every segment. |
| `ask_files(files, question)` | One sub-call per file (a glob or a list of paths). |
| `rlm(task, context=None)` | A child run: a dsh subagent in RLM mode with its own REPL. |
| `await tools.read(...)`, `tools.grep`, `tools.edit`, shell, web, … | dsh's own tools, called from Python. |

`schema=` takes `str`, `int`, `bool`, `list[str]`, `{"key": type}`, a list of choices or a JSON Schema and returns parsed values. `thinking=` ("off" to "max") sets a sub-call's reasoning effort.

Each sub-call is an `llm` tool call in dsh's Trajectory view, with its prompt, answer and token counts. dsh's status-bar total counts only the main conversation, so add the sub-calls' tokens from the Trajectory view when you work out cost.

## Settings

**Plugins → Built-in plugin settings → RLM mode**:

| Setting | Default |
|---|---|
| Sub-call provider and model | the agent's own |
| Sub-call reasoning effort | the agent's own when the model is the agent's |
| Result size (characters of one `run_code` result the agent sees) | 8,000 |
| Sub-calls per `run_code` call | 200 |
| Parallel sub-calls (when dsh has no sub-call limit of its own) | 8 |

A cheaper, low-effort sub-call model is often enough for reading; keep judgment-heavy sub-calls on a stronger model.

## Caching: two settings worth checking

RLM mode keeps dsh's prompt prefix byte-identical from request to request, and caches as well as Standard mode (94-98% of input read from cache on long runs). Two things outside the plugin can still cost cache hits:

- **A model entry with a huge output cap.** dsh compacts a conversation at `min(window × 0.8, window − max output − 65,536)` tokens. Some imported model entries declare an output cap close to the whole window (DeepSeek Flash from OpenRouter: 943,718 of 1,048,576), so every session compacts at about 39k tokens, in every mode, and each compaction is a full cache miss. Lower that model's max output tokens in dsh's model settings (65,536 is plenty).
- **OpenRouter moving requests between hosts.** OpenRouter serves many models from several hosts, at different quantizations, and a request that lands on a new host reads nothing from cache. dsh doesn't let you pin a host per model, so set it in your OpenRouter account's provider preferences (a default provider order, or allowed providers). In our tests, pinning one host removed every routing miss. Or use dsh's built-in DeepSeek provider with a DeepSeek key.

## Permissions

The REPL starts through dsh's sandbox service under the session's file policy, as dsh's own code runtime does: read-only and plan mode can't write, workspace-write can write only in the workspace, and dsh offers its usual one-time escalation. This is dsh's confinement (partial on Windows), not isolation: treat model-written code as you would in any dsh mode. Sub-calls and the REPL never see your API keys; the REPL's environment drops every variable whose name looks like a secret.

## Limits

- The plugin API of dsh 0.2.x is a preview, so each `rlmh-dsh` release declares the dsh versions it was tested with, and dsh refuses to load it outside them.
- `rlm()` children follow dsh's Subagent settings (depth 1 by default, so a child can't start its own children).

## License

MIT. Source and issues: [github.com/RishiJain905/rlm-harness](https://github.com/RishiJain905/rlm-harness/tree/dsh-plugin/dsh-plugin).
