# rlmh-dsh: RLM mode for DeepSeek Harness

`rlmh-dsh` adds **RLM mode** to [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh). RLM mode is the Recursive Language Model method from [rlm-harness](https://github.com/RishiJain905/rlm-harness), running inside dsh.

The model doesn't read long inputs. It works through a persistent Python REPL, the `run_code` tool:
- loading files into variables;
- measuring and slicing them with code;
- handing the reading to **sub-calls** (`llm`, `llm_batch`, `scan`, `ask_files`), which are separate model calls that each read one piece and answer briefly;
- doing exact counting, filtering and arithmetic in Python.

The model's own context stays small and its prompt cache stays warm, even on inputs far larger than its context window.

## Install

**dsh desktop:**
1. Open **Plugins** → **Add plugin** → **Install a third-party plugin**.
2. Enter `rlmh-dsh`, then click **Install** and **Enable now**.

There is no restart and no terminal. RLM mode needs Python, and the desktop app ships one.

**dsh CLI or web:**

```bash
dsh plugin --profile web add rlmh-dsh
```

Use your own profile's name in place of `web`.

Needs dsh 0.2.2-rc.1 or later, below 0.3.0.

**From dsh's plugin Discover tab** (needs the experimental "Custom plugin indexes" plugin to be on):
1. Add this index source: `https://raw.githubusercontent.com/RishiJain905/rlm-harness/dsh-plugin/dsh-plugin/market/index.json`.
2. Install RLM mode from Discover.

## Use it

Start a session with the **RLM mode** agent preset. The model gets `run_code` and the REPL, plus these helpers:

| In the REPL | What it does |
|---|---|
| `llm(prompt)` | One sub-call; returns the answer as text |
| `llm_batch(prompts, shared=…, over=…)` | Several sub-calls in parallel. `shared=` and `over=` put a fixed prefix first, so sub-calls hit the provider's cache |
| `segments(text, size)` | Cuts text at line breaks into pieces sized for one sub-call |
| `scan(text, question)` | Asks a question of every segment of a text |
| `ask_files(paths, question)` | Asks a question of files, without loading them into the model's prompt |
| `rlm(task, context=None)` | A child agent in RLM mode, with its own REPL, run as a dsh subagent |

Each sub-call shows up as an `llm` row in the Trajectory view, with a `[sub-call tokens: …]` line.

## Settings

Go to **Plugins** → **Built-in plugin settings** → **RLM mode**.

| Setting | Default |
|---|---|
| Sub-call provider and model | The session's own model |
| Sub-call reasoning effort | The session's own effort |
| Characters one `run_code` result shows | 8,000 |
| Sub-calls per `run_code` call | 200 |
| Parallel sub-calls | 8 |

Sub-calls cost tokens, mostly output tokens. A cheaper sub-call model or a lower effort cuts that cost.

## Python

RLM mode looks for Python 3.10 or later, in this order:
1. the runtime's `pythonBin` option, if you set one in the profile;
2. the Python bundled with dsh desktop;
3. an installed rlm-harness's Python;
4. a Python 3.12 that uv already has;
5. `python` or `python3` on PATH.

If none is found, the agent says so. Install the desktop app, or install Python 3.12 from python.org or with `uv python install 3.12`, then start a new session. RLM mode never downloads anything itself.

## Caching

RLM mode follows dsh's caching rules:
- its instructions and tool list are fixed for the session;
- it never rewrites requests;
- compaction is dsh's own;
- sub-calls put their fixed prefix first and use their own session affinity key, `<session>:sub`.

In tests on DeepSeek Flash through OpenRouter, long RLM sessions read 94% to 98% of their input from cache, about the same as Standard mode. Two settings outside the plugin matter:

- **OpenRouter host switching.** OpenRouter serves many open models from several hosts and may move a request to a host without your cache. Each move is one full miss. Two ways to keep requests on one host:
  - use dsh's own DeepSeek provider with a DeepSeek key;
  - on OpenRouter, create a preset with a provider **order** and use a model id ending in `@preset/<slug>`.
- **A huge output cap starts compaction early.** dsh compacts at about `context window − output cap − 65,536` tokens. Some imported OpenRouter models declare an output cap close to their context window, for example DeepSeek Flash Latest's 943,718. On those, every session compacts at about 39k tokens, and each compaction misses the cache. Set a smaller output cap, such as 65,536, on that model in dsh's model settings.

## Permissions

The REPL runs under dsh's file policy, through dsh's sandbox service, in the same way as dsh's own code runtime:
- **read-only** and **plan** mode: the REPL and everything it starts can't write;
- **workspace-write**: writes outside the workspace are denied;
- if the sandbox is unavailable, a confined mode fails closed;
- dsh's one-time escalation prompt still works.

How strongly writes are blocked depends on dsh's backend for your OS. On Windows, dsh reports enforcement as `partial`. Treat it as protection against accidents, not against a hostile program.

## Privacy

- **The plugin holds no keys.** Sub-calls go through dsh's model service, so dsh holds the key.
- **No key-like variables reach the REPL.** Environment variables whose names look like keys (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, `HEADERS`) are removed before it starts.
- **Nothing contacts the network except your model provider.** It is contacted only through dsh.

## Development

The source is on the `dsh-plugin` branch of [rlm-harness](https://github.com/RishiJain905/rlm-harness/tree/dsh-plugin/dsh-plugin):
- Node tests: `npm test`.
- Python tests: `python -m unittest discover -s test -p "test_*.py"`.
- Cache guard, which runs a real dsh against a fake model server: `node test/e2e/cache-guard.mjs`.

The design and its test results are in `documentation/v1.1/dsh-plugin-plan.md`.

## License

MIT
