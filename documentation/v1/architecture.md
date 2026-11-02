# v1 build architecture

> Written 2026-11-02 for the threads that build v1. v1 adds to v0 rather than replacing it, so [../v0/architecture.md](../v0/architecture.md) still pins everything this file doesn't change. This file pins the names, paths, messages and signatures v1 adds, so threads working in parallel stay compatible. The design is the v1 alignment doc ([Claude Doc](https://claude.ai/artifact/LVWSoM6bRFk6kSoWZ1r71Z)), with Rishi's picks S-40 to S-48 in [../v0/decisions.md](../v0/decisions.md). v1's own calls are D-168 onwards in the same file. If this file and a spec disagree, the spec wins, and this file gets fixed.

## 1. What v1 adds

v1 makes the `default` profile measurably better, ships the better version, and lets users improve it on their own work. The order is measure, tune, then ship. Alongside that, the interactive app gains follow-ups, and long runs gain compaction.

| Part | Where | Steps |
|---|---|---|
| Eval sets: 48 tasks, mostly coding: Python repos, websites, LLM-engine kernels, plus research (S-46, S-48) | RLM repo, `scripts/harness_evalset.py`; data outside both repos | 1 |
| `rlmh eval`: run a set, grade it, report, compare | `app/src/eval/` | 2 |
| Compaction inside a run | `engine/rlm_engine/compaction.py`, `[compaction]` in the profile | 3 |
| Follow-ups: one REPL and conversation across questions | `loop.py`, `service.py`, the interactive app | 4 |
| Harness² tuner, developer side | `app/src/tune/`, `rlmh tune` | 6 |
| Harness² for users: `/tune` and the experience library | `app/src/tune/`, `/tune` | 9 |
| Three spend steps and the release | RLM repo results, `documentation/v1/results.md` | 5, 7, 8, 10 |

The three processes of v0 §1 stay as they are. Nothing new talks to a provider except through the gateway, and nothing new holds a key.

```mermaid
flowchart LR
    subgraph app["rlmh (Bun)"]
        evalc["eval/ (step 2)"]
        tunec["tune/ (steps 6, 9)"]
        ui["interface/ + /tune"]
        session["session.ts"]
        gw["gateway/"]
    end
    subgraph eng["engine (Python)"]
        svc["service.py: run.say, run.close, profile.check"]
        loop["loop.py: conversations"]
        comp["compaction.py"]
        child["child.py"]
    end
    set[("eval set folder\n(outside both repos)")]
    evalc --> session
    tunec --> evalc
    tunec --> session
    ui --> session
    session <-->|"JSON-RPC, protocol 2"| svc
    svc --> loop --> comp
    child --> comp
    evalc --> set
```

## 2. Repo layout

Each new or changed file, with the step that touches it. Files that v0 created and v1 changes are marked `+`.

```
rlm-harness/
  protocol/examples.json             +3 +4 +6   new methods and events (§3)
  engine/rlm_engine/
    __init__.py                      +3 +10     PROTOCOL_VERSION 2 (step 3); __version__ "1.0.0" (step 10)
    compaction.py                    3          trigger, compact(), the two pinned texts (§4)
    loop.py                          +3 +4      calls compaction before each root call; conversations (§5)
    child.py                         +3         calls compaction before each child turn
    runlog.py                        +3         FORMAT_VERSION 2, four new keys (§3.4)
    service.py                       +3 +4 +6   window and conversation on run.start; run.say, run.close; profile.check
    link.py                          +4         error -32013 RUN_BUSY beside -32010 to -32012
    followup.py                      4          the pinned follow-up texts: SUBMITTED_NOTE, UNANSWERED_NOTE, FOLLOW_UP (§5)
    profiles.py                      +3 +6      the [compaction] table; TUNABLE and check_tunable (§7.2)
    profiles/default/profile.toml    +3 +8      [compaction] (step 3); the tuned values (step 8)
    profiles/default/guidance.md     +8         the tuned text (step 8)
  engine/tests/
    test_compaction.py               3
    test_conversation.py             4
    test_profile_check.py            6
  app/src/
    version.ts                       +3 +10     PROTOCOL_VERSION 2; APP_VERSION "1.0.0"
    protocol.ts                      +3 +4 +6   the §3 types
    session.ts                       +3 +4 +6   window in buildRunParams; say(), closeRun(); run.closed; checkProfile()
    settings.ts                      +4 +9      §8 keys
    paths.ts                         +2 +6 +9   evalDir, tuneDir, libraryDir (§9)
    main.ts                          +2 +6      eval, tune
    cli/eval.ts                      2          rlmh eval, eval report, eval compare, eval ledger
    cli/tune.ts                      6          rlmh tune
    eval/runner.ts                   2 +6 +9    runEval(): the one entry point for rlmh eval, rlmh tune and /tune; logDir (2), ledger: false (6), /tune's options (9)
    eval/set.ts                      2          read and check a set folder (§6)
    eval/tar.ts                      2          a small ustar reader, the same on every OS; refuses links and path escapes
    eval/work.ts                     2          throwaway work copies and per-repo venvs
    eval/graders.ts                  2          the read grader (a port of score_answer: int, float, count, entity, list) and the tests grader
    eval/junit.ts                    2          JUnit XML to per-test results
    eval/report.ts                   2          report.json, report.md, compare, McNemar
    eval/estimate.ts                 2          the cost estimate before spending (§6.5)
    eval/ledger.ts                   2          <home>/eval/ledger.jsonl
    tune/evidence.ts                 6          the evidence folder, with the grader-leak guard (§7.3)
    tune/sessions.ts                 6          editor, composer and reflector sessions as rlmh runs (§7.4)
    tune/prompts/*.md                6          stage prompts adapted from google-research/harness2 (Apache-2.0 notice kept)
    tune/candidate.ts                6          write a candidate profile folder, check it with profile.check
    tune/offline.ts                  6          the set-based driver behind rlmh tune (§7.5)
    tune/online.ts                   9          the per-task driver behind /tune (§7.6)
    tune/worktree.ts                 9          throwaway git worktrees (or copies) of the user's folder
    tune/library.ts                  6 +9       the experience library (§7.7); step 9 adds user domains
    interface/App.tsx, store.ts      +4 +9      follow-ups; /tune
    interface/conversation.ts        4          when a question continues the open conversation (§5)
    interface/commands/tune.tsx      9          the /tune screen
  app/test/
    eval/*.test.ts                   2
    fixtures/evalset/                2          a tiny set: two read, two Python, one kernel and one web task, with hidden tests
    tune/*.test.ts                   6 +9
    interface/conversation.test.ts   4
    interface/tune.test.tsx          9
  documentation/v1/
    README.md, architecture.md       exists     this kit
    specs/step-01..10                exists
    results.md                       10         the experiment write-up: numbers only, no task text
  documentation/releases/v1.0.0.md   10         release notes; release.yml (+10) puts them above the install text
```

RLM repo (`F:\Personal\RLM\RLM`), as in v0 (S-19). Each change there needs Rishi's OK first.

```
scripts/harness_evalset.py           1          builds and checks the eval set folder (§6)
tests/test_harness_evalset.py        1          offline tests
documentation/harness-eval-v1.md     1 +5 +7 +8 numbers-only summaries; task ids and sizes, never task text
results/harness-eval/<date>-<what>/  5 7 8 10   git-ignored (results/harness-*/ since D-46): rlmh eval and rlmh tune output folders
private/seeds/harness-eval-v1.json   1          git-ignored seeds
```

The eval set itself lives in `D:\RLM-data\harness-eval\harness-eval-v1\` (`RLM_DATA_DIR`), outside both repos (D-169).

## 3. Wire changes: protocol 2

Step 3 bumps `PROTOCOL_VERSION` to 2 in `app/src/version.ts` and `engine/rlm_engine/__init__.py`, and every step that adds a message adds its example to `protocol/examples.json` (D-02). The app already refuses an engine with another protocol (D-36).

### 3.1 App → engine

| Method | Params | Result | Errors | Step |
|---|---|---|---|---|
| `run.start` | v0's params, plus `window: {context_window: int, max_output: int}` (the root model's catalog numbers; 0 means unknown) and `conversation: bool` (default `false`) | as v0 | as v0 | 3, 4 |
| `run.say` | `{run_id, text}` | `{prompt_index: int}`, returned before the prompt's first root call | -32010 no such open conversation; -32013 a prompt is still running | 4 |
| `run.close` | `{run_id}` | `{}`, after `run.closed` was sent | -32010 no such open conversation; -32013 a prompt is still running (use `run.cancel`) | 4 |
| `engine.info` | v0's params | each `profiles` entry gains `path`, `agent_api` and `limits: {read, repo}` (only added fields, so the protocol number doesn't change for it) | as v0 | 2, 6 |
| `profile.check` | `{path: str (absolute folder), base: str \| null (a profile name)}` | `{ok: bool, errors: [str], prompt_hash, profile_hash, changed: [str]}`; `changed` lists the dotted keys that differ from `base`, plus `"guidance"` when its text differs | -32602 for a relative path | 6 |

New error code: **-32013 `RUN_BUSY`**, in `link.py` (beside -32010 to -32012) and `protocol.ts`.

### 3.2 Engine → app

`model.complete` gains an optional `purpose: "compact"` on the summary call of §4 (role `root`, or role `sub` with `child` inside a child run). The gateway treats it as the role it carries: same routing key, same cache markers. The interface labels it "compacting". Step 3.

### 3.3 Events

| Event | Change | Step |
|---|---|---|
| `run.started` | adds `window` (as sent), `compaction: {window, trigger, keep} \| null` (the numbers of §4.1 for this run; `null` when the profile has no `[compaction]`), and `conversation: bool` | 3, 4 |
| `run.compacted` | new: `{run_id, turn, prompt_index, child_id: int \| null, before_tokens, after_tokens, dropped_messages, kept_messages, summary_chars, seconds}` | 3 |
| `run.finished` | adds `prompt_index: int` and `open: bool`. `open` is `true` when a conversation waits for `run.say`; the run's resources stay alive | 4 |
| `run.closed` | new: `{run_id, prompts: int}`, sent once when a conversation ends (`run.close`, cancel, stdin closing). Never sent for a run started with `conversation: false` | 4 |

### 3.4 Run log, format 2

`runlog.FORMAT_VERSION = 2` (step 3). `RECORD_KEYS` keeps v0's order and appends four keys: `window`, `compactions` (the list of `run.compacted` bodies, without `run_id`), `prompt_index`, `conversation`. Step 3 writes `prompt_index: 0` and `conversation: false`; step 4 fills them.

- **One record per prompt.** A conversation writes one line when each prompt ends. All of a conversation's records share its `run_id` and differ by `prompt_index`.
- **`messages`** is the whole list as it stood when that prompt ended, after any compaction: what the model last saw. A reader never has to stitch records together.
- **`turns`, `subcalls`, `children`, `usage`, `cost_usd`, `cache`** cover that prompt only. `diff` (repo mode) is the workspace against `base_tree` when the prompt ended, so it accumulates.
- `/runs` (`runs.ts`) reads format 1 and format 2 lines. A format 1 line gets the four keys as `null`, `[]`, `0` and `false`.

## 4. Compaction (step 3)

### 4.1 When

The profile's `[compaction]` table turns it on. `training-v4` never gets one, so its runs stay byte-identical to training's and still end with the gateway's `context_window` error when they outgrow the model (D-25).

```toml
[compaction]              # default profile
window = 262144           # W': compact as if the model's window were at most this many tokens
keep_ratio = 0.16         # DeepSeek Harness: keep the newest 16% of (W' - out) verbatim
reserve = 65536           # DeepSeek Harness's margin
summary_max_tokens = 8192
```

For each run, from `run.start.window` and the mode's limits (all in tokens):

```
W'      = min(window.context_window if > 0 else ∞, compaction.window)
out     = limits.root_max_tokens
trigger = max(min(0.8 * W', W' - out - reserve), 0.5 * W')      # DeepSeek Harness: min(0.8W, W - output - 65,536)
keep    = floor(keep_ratio * (W' - out))
```

With the default profile on DeepSeek V4.1 Flash or Haiku 5.5 (both about 1M tokens), W' = 262,144, trigger = 180,224 and keep = 39,321. The cap of 262,144 is deliberate: both models have a 1M window, so without it a 150-turn coding run (about 152K tokens) would never compact (D-171).

Before every root call, and before every child turn, the loop estimates the request:

```
estimate = last.input_tokens + last.output_tokens + ceil(chars_appended_since_last_reply / 3)
```

Here `last` is the previous reply's usage. When that reply has no usage, the estimate is `ceil(total_chars / 3)`, which is the gateway's own rule (D-25). The loop compacts when `estimate > trigger`.

### 4.2 How

`compaction.compact(messages, *, keep_tokens, summarize) -> Compacted | None`. It is pure apart from the `summarize` callback, so tests drive it without a model.

1. **Head.** `messages[:2]`, the system prompt and the first user message, stay byte for byte. The cached prefix survives.
2. **Tail.** Walk back from the end and keep whole turns while their `chars / 3` fits in `keep_tokens`. A turn is an assistant message plus the observation that follows it. The tail always holds at least the newest turn, and it starts at an assistant message. A native tool call is never separated from its tool result.
3. **Middle.** Everything between head and tail. When it is empty, return `None`: the run goes on, and the gateway's window check stays the last guard.
4. **Summary.** `summarize(messages + [{role: "user", content: COMPACT_REQUEST}])` makes one `model.complete` call:
   - `purpose: "compact"`, with the run's own model, tools, temperature and routing, so the whole prefix is a cache hit
   - `max_tokens: summary_max_tokens`, `thinking: "off"`
   - Its `text` is the summary, and any tool call it makes is ignored. An empty text falls back to a mechanical summary: for each dropped turn, its number and the first line of its code.
5. **Result.** `head + [{role: "user", content: COMPACTED.format(turns=..., summary=...)}] + tail`. That is two user messages in a row; step 3 checks that both clients send them, and that Anthropic's client merges them if it must.
6. **No loop.** A compaction that leaves the estimate above 80% of its old value is the last one for that prompt. Later turns go on uncompacted.

The REPL keeps every variable through a compaction. That is the RLM's edge: `COMPACT_REQUEST` asks the summary to name the variables that hold the state that matters. Step 3 pins the exact texts of `COMPACT_REQUEST` and `COMPACTED` in its spec. They are profile-level additions, not prompt v4.

### 4.3 What it records

The record's `compactions` holds every `run.compacted` body. Each compaction counts as one root call in `usage.root`, or as one sub-call in `usage.sub` inside a child. `run.finished` is unchanged, apart from §3.3.

## 5. Conversations and follow-ups (step 4)

- **Only the interactive app opens one.** `rlmh run`, `rlmh batch`, `rlmh eval` and the tuner always send `conversation: false`, so their runs stay one-shot as in v0 (S-11 holds there).
- **Prompt 0** runs exactly as a v0 run does. When it ends (by submit, by running out of turns, or with no answer), a run with `conversation: true`:
  - writes that prompt's record;
  - sends `run.finished {open: true}`;
  - keeps the worker, bridge, permissions (including "allow for this run"), children, scratch folder and message list;
  - waits for `run.say`, `run.close` or a cancel.
- **`run.say {text}`** starts prompt *k*.
  - The previous prompt is closed with a note (D-201): `SUBMITTED_NOTE` if it submitted, else `UNANSWERED_NOTE`. After an assistant message with a native tool call, the note is that call's tool result; otherwise it starts the user message.
  - Then the user message `FOLLOW_UP`, filled with the text, the mode's `WHERE` phrase, and the turns and sub-calls left.
  - The turn budget and the sub-call budget start over. `submit()` works again, and the answer from earlier prompts is cleared.
  - Mode, profile, models and workspace stay as prompt 0 set them.
  - Step 4 pins the texts of `SUBMITTED_NOTE`, `UNANSWERED_NOTE` and `FOLLOW_UP`.
- **Compaction (§4) covers the whole conversation.** The head stays prompt 0's system and first user message.
- **The wall cap.** The worker's wall cap is per cell (`manager.py`), so it already holds for each prompt, with no change.
- **Ending a conversation.** `run.close`, `run.cancel` or the engine's stdin closing ends it. The worker closes, model calls are cancelled, the scratch folder goes, and `run.closed` is sent. A cancel during a prompt also writes that prompt's `cancelled` record first, as in v0.
- **In the app.**
  - A question becomes a follow-up when a conversation is open, `conversation.follow_ups` is on (§8), and the question picks the same mode as the open conversation:
    - Read mode needs no new `@` mentions.
    - Repo mode needs the same folder.
  - Anything else closes the open conversation and starts a new one. So do `/clear`, a model or profile change, and quitting.
  - The status line shows the prompt number when it is above 0.
- **Under `training-v4`** follow-ups work, but the profile has no compaction (§4.1). A long conversation can still hit the window and end with `context_window`.

## 6. Eval sets and `rlmh eval` (steps 1 and 2)

### 6.1 The set folder

Step 1 writes it and step 2 reads it. The model never sees anything but the task text, the read inputs and its work copy.

```
<set>/
  manifest.json     {format: 1, name, created, builder: {repo: "RishiJain905/rlm", commit, dirty}, permission_mode,
                     validated, counts: {"<split>/<track>/<size>": n}, tasks_sha256, grades_sha256}
  tasks.jsonl       what rlmh is given, one task a line, never gold (§6.2)
  grades.jsonl      how each task is graded (§6.3); gold and test lists live only here
  ctx/<id>/...      read-mode inputs, written as bytes
  repos/<id>.tar    repo-mode base snapshot: the repo after the break, hidden tests removed, no .git
  hidden/<id>.tar.gz the hidden test files, restored only after the run ends
  venvs/<key>.json  {python: "3.12", requirements: [pinned lines], import_root: "." | "src"} for each Python repo and kernel task
  nodeenvs/<key>.json {node: "22", pnpm: "<exact version>", playwright: "<exact version>"} for each web project; its pnpm-lock.yaml is in the repo tar
```

The set has five tracks (D-176, S-48). Each split holds half of every cell:

| Track | Kind | Source | S | M | L | R | Tests |
|---|---|---|---|---|---|---|---|
| `python` | repo | training's held-out edit tasks (bug, feature, real PR, spec, multi-bug) | 6 | 6 | 4 | | pytest in a uv venv |
| `web` | repo | Web-Bench projects (ByteDance, Apache-2.0): build a site from its first 3, 6 or 12 feature requests (D-222) | 4 | 4 | 2 | | Playwright in Chromium |
| `kernel` | repo | CUDA kernels for an LLM inference engine, written for this set; needs an NVIDIA GPU (D-223) | 4 | 4 | 2 | | pytest against NumPy, compiled at run time by CuPy's NVRTC |
| `research` | read | training's `research_test`: multi-hop and list questions over 330K to 610K characters (D-224) | | | | 8 | `answer` grader |
| `search` | read | training's `callgraph_heldout` and `needle_heldout` | | | | 4 | `answer` grader |

### 6.2 `tasks.jsonl`

```
read: {"id", "kind": "read", "track": "research"|"search", "split": "tune"|"heldout", "size": "R", "question", "input": ["ctx/<id>/<file>", ...]}
repo: {"id", "kind": "repo", "track": "python"|"kernel"|"web", "split", "size": "S"|"M"|"L", "task", "base": "repos/<id>.tar",
       "venv": "<key>" (python, kernel) | "node_env": "<key>" (web), "test_hint", "requires": ["cuda"] (kernel only)}
```

- **Ids** are `<set>-<track>-<size>-<nn>`, and reveal nothing about content.
- **`test_hint`** is `{python} -m pytest -q <paths>` for `python` and `kernel` (a kernel task's `kernels.py` loads its `.cu` files with `cupy.RawModule`), and `{pnpm} exec playwright test` for `web`. `{python}` becomes the absolute path of the task's venv interpreter and `{pnpm}` the dev machine's pinned pnpm, so the run needs no global packages.
- **Paths** are relative to the set folder.

### 6.3 `grades.jsonl`

```
read: {"id", "grader": "answer", "gold", "grading": {...}, "pass_score": 1.0}   # the RLM task's own grading fields; type int, float, count, entity, list or text
repo: {"id", "grader": "tests", "runner": "pytest"|"playwright", "hidden": "hidden/<id>.tar.gz",
       "f2p": [test ids], "p2p": [test ids], "files": [test file paths to run], "timeout_s": int}
```

Where each task came from stays in step 1's build cache (`sources.jsonl`), never in the set. `validated` is false only for a `--no-validate` test build, and `rlmh eval` refuses such a set.

The read grader ports `rlm_rl/reward.py`'s `score_answer` for the types int, float, count, entity, list and text (an exact or alias match, else 0.8 × token F1; no judge model). Expected test values come from running training's functions in a scratch copy. For the primary metric, a read task passes when its score reaches its `pass_score`: 1.0, except 0.8 for research list questions, training's open-book bar (D-170, D-224). For a repo task, `resolved` means every f2p test passes and no p2p test fails. `f2p_share` is the fraction of f2p tests that pass, a secondary metric that breaks ties (D-170).

### 6.4 Running a set

`rlmh eval` drives the same `Session` as `rlmh batch`, with `conversation: false`.

1. **Read tasks** run with `inputs` resolved against the set folder.
2. **Repo tasks** each get a fresh work copy, `<home>/eval/work/<eval id>/<task id>/`:
   - `repos/<id>.tar` is extracted as bytes;
   - then `git init`, and one commit `base` by `rlmh-eval <eval@localhost>` with a fixed date, so the history gives nothing away;
   - a web task then gets `pnpm install --offline --frozen-lockfile --store-dir <home>/eval/pnpm-store` (hard links from the shared store; `node_modules` is git-ignored in the copy);
   - `test_hint` is filled.

   Web tasks run one at a time until their grading ends, because the model's own test runs serve the site on Web-Bench's default port. Kernel tasks run one at a time too, because they share one GPU. The two groups can overlap.
   - **GPU check.** When the selection holds a task with `requires: ["cuda"]`, pre-flight runs `nvidia-smi`, and env prep has the kernel venv's Python count devices and compile a trivial `RawKernel`. Without a GPU, `rlmh eval` exits 2 and names those tasks, so nothing is spent.
3. **Permission mode.** The run uses the manifest's `permission_mode`, `bypass` for this set (D-172), printed in the estimate. Without the model's own shell, a coding agent can't run tests.
4. **Grading, after `run.finished`:**
   - revert any change to a test path (`tests/`, `test/`, `test_*.py`, `*_test.py`, `*.spec.*`, `conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`, `pyproject.toml`'s pytest table, `playwright.config.*`, `package.json`, `pnpm-lock.yaml`, `vendor/`), and set `test_tamper` if there was one;
   - extract the hidden tests;
   - **pytest** (`python`, `kernel`): run `{python} -c <PYTEST_BOOT> -p no:cacheprovider -o junit_family=xunit1 --junitxml=<grade dir>/junit.xml --tb=short -q <files>` with `timeout_s` and key-like variables stripped (`PYTEST_BOOT` is training's, from `rlm_rl/grader.py`). When the venv's `import_root` is `"src"`, a `.pth` file points the venv at the work copy's `src/` for that run only;
   - **playwright** (`web`): run `{pnpm} exec playwright test --reporter=junit --retries=0 <files>` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<grade dir>/junit.xml`, `EVAL_PROJECT_PORT` set to a free port the runner picks, `CI` unset (Web-Bench's config retries under it), `IS_EVAL_PRODUCTION=1` (Web-Bench's own grading timeouts), `PLAYWRIGHT_BROWSERS_PATH`, `timeout_s` and key-like variables stripped. A test id is the JUnit `classname` (with `/` separators) `::` its `name`;
   - parse the JUnit report.
5. **Leak check.** `leak_suspect` is set when the run's messages contain the set folder's path or a hidden test's name.
6. **Clean up.** The work copy is removed after grading, unless `--keep`.

**Environments are made once, before the first run that needs them:**
- venvs per key, `<home>/eval/venvs/<key>/`, with `uv venv --python <python>` and `uv pip install -r`. Kernel venvs pin `cupy-cuda12x[ctk]` (the `ctk` extra brings the pip CUDA toolkit, NVRTC included, so no nvcc or MSVC is needed), `numpy` and `pytest`, and need only the NVIDIA driver;
- for web tasks, `node` 22 or later and the pinned `pnpm` must be on PATH. `pnpm fetch` fills `<home>/eval/pnpm-store/` from each project's lockfile, and `pnpm exec playwright install chromium` puts one Chromium in `<home>/eval/ms-playwright/`. `rlmh eval` sets `PLAYWRIGHT_BROWSERS_PATH` and `IS_EVAL_PRODUCTION=1` in the engine's environment, so the model's own Playwright runs find that browser.

That is a developer action that touches PyPI (the CUDA toolkit wheels are large), the npm registry and Playwright's browser download, and the estimate says so.

### 6.5 Commands and output

```
rlmh eval SET [--split tune|heldout|all] [--only ID,...] [--sample K --seed S] [--root M] [--sub M] [--profile P]
              [--call-format F] [--jobs N] [--out DIR] [--tokens-from RUNS.jsonl]... [--go] [--max-usd X] [--keep] [--json]
rlmh eval SET --rerun OUT [--go] [--max-usd X]
rlmh eval report OUT
rlmh eval compare OUT_A OUT_B
rlmh eval ledger
```

- **Without `--go`** it is an estimate and spends $0. It prints the planned runs, the price per run by size from the catalog and reference tokens, the total, and the cap.
- **`--go`** spends. `--max-usd` is a hard stop, defaulting to 2× the estimate: once the gateway's billed cost passes it, no new run starts and the running ones are cancelled.
- **`--out`** defaults to `<home>/eval/out/<eval id>/`, with eval id `<set>-<split>-<YYYYMMDD-HHMMSS>`. Spend steps pass `--out` into the RLM repo's `results/harness-eval/`.
- **`--rerun OUT`** reruns only the tasks in `OUT` that ended with a transient infra error, into `OUT/rerun/`. `report` and `compare` prefer the rerun lines.
- **`--sample K --seed S`** picks K tasks, stratified by track and size, the same K for the same seed. It is the probe subset of §7.5.

```
<out>/
  eval.json        set name, manifest hashes, split, models, profile, profile_hash, call_format, jobs, harness version and commit,
                   estimate, cap, capped, rerun_of, started, finished
  runs.jsonl       the engine's run log (logDir = <out>)
  grades.jsonl     one line per task: id, track, kind, size, split, run_id, submitted, infra_kind, pass, score, f2p_share,
                   test_tamper, leak_suspect, turns, subcalls, compactions, cost_usd, cache_hit, wall_s
  grade-logs/<id>/ the test runner's output and junit.xml (the tuner never reads this folder, §7.3)
  report.json      totals by split, track, kind and size: n, pass rate, mean score, mean f2p_share, turns, sub-calls,
                   compactions, cost, cache hit, wall time, infra errors
  report.md        the same as tables
```

- **`compare`** pairs the ids both outputs have. It gives both pass, A only, B only and neither; McNemar's exact p; the pass-rate difference; pass counts per track; mean `f2p_share`; and the cost ratio.
- **The ledger.** Every `--go` appends `{date, what: "eval"|"tune", set, split, root, profile, runs, cost_usd, out}` to `<home>/eval/ledger.jsonl`. `rlmh eval ledger` prints the lines and the total against S-44's $30.

### 6.6 The estimate

`eval/estimate.ts` prices each planned run as `reference tokens × catalog price`.

- **Reference tokens** are the mean `usage.root` and `usage.sub` by track and size, from the run logs passed with `--tokens-from` (repeatable).
- **Fallback.** With none, it uses these built-in reference figures, from v0's recorded runs (D-152, D-157):

| Size | Root in (M) | Root out (K) | Sub in (M) | Sub out (K) |
|---|---|---|---|---|
| R | 0.3 | 20 | 0.3 | 30 |
| S | 0.3 | 20 | 0.1 | 10 |
| M | 1.2 | 50 | 0.3 | 30 |
| L | 6.0 | 120 | 0.8 | 60 |

- **Profile cap.** Each figure is capped at the profile's own ceiling for that mode, using `scripts/harness_smoke.py`'s `ceiling_tokens` formula on the mode's limits, so a 30-turn profile such as `training-v4` is never priced as a 150-turn one. `engine.info`'s profile entries carry each mode's limits for this purpose (step 2 adds them if they are missing).
- **Cache.** Reads are assumed at 80% for root input on providers that cache, as v0 measured on DeepSeek; it is 0% elsewhere. OpenRouter can bill from 0.1× to 3× the catalog (D-121), so the default cap is 2× the estimate.

## 7. The Harness² tuner (steps 6 and 9)

Read the paper and the code before building either step:

- **Paper:** Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", arXiv [2610.14224](https://arxiv.org/abs/2610.14224) ([Hugging Face page](https://huggingface.co/papers/2610.14224), [project page](https://harness2.github.io/)).
- **Code:** [google-research/harness2](https://github.com/google-research/harness2), Apache-2.0, read at `6868817518876de8fd170c6a8354daca273b6191`. The files to read are:
  - `harness2/core/prompts.py`: `propose()` L824, `aggregate()` L893, `compose_round()` L964, `select()` L1040, `experience()` L1105, `GENERALIZE` L295, `_INV_TEMPLATE` L347, `_DOM_TEMPLATE` L372
  - `harness2/core/recursion.py`
  - `harness2/core/context.py`
  - `harness2/core/library.py`
  - `harness2/core/selection.py`
  - `harness2/core/ledger.py`
  - `harness2/core/tree.py`
  - `harness2/core/schedule.py`
  - `scripts/split_tasks.py`

### 7.1 How v1 maps the paper

| Harness² | v1 |
|---|---|
| The model is frozen and the harness evolves | Prompt v4, the call format and the one `python` tool are frozen (levers 1 and 2, S-14, S-09). `guidance.md` and the tunable TOML keys evolve (levers 3 and 4, §7.2) |
| 8 harness components (C1–C8) | Only the text ones map: guardrails (C2), memory (C3) and tool guidance (C4) all become `guidance.md`. Skills, scripts, subagents and plugins have no counterpart, because the REPL's helpers are code, not profile text |
| Two scoped editors: INV ("how the agent works") and DOM ("what a practitioner knows") | The same two editors with the same scopes. INV may also change TOML limits; DOM changes text only |
| Probe each candidate once | Probe each candidate on a fixed probe subset of the tune split (offline), or once on the task (online) |
| Composer: merge, revise, adopt or KEEP_BASE, with notes "kept\|revised\|dropped -> edit -> evidence" | The same, as a composer session |
| Editors and the composer never see a score or verdict (`context.py` guards) | The same: evidence holds trajectories and deliverables, never `grades.jsonl`, `grade-logs/` or gold (§7.3) |
| Online and label-free: each task is re-run on itself | User `/tune` (§7.6) |
| Meta-Harness baseline: offline search, replicates, acceptance margin, a lessons file (paper Appendix C) | Developer `rlmh tune` (§7.5). It is offline, uses labels for acceptance only, and adds a held-out check against `v1-baseline` (step 8) |
| The library: a reflector writes at most one lesson per task, NO_ENTRY by default, with cue lines in `INDEX.md` | The experience library (§7.7). It is read by later editor sessions and is not injected into ordinary runs (D-175) |
| Editor and composer: Claude Opus 4.8 under OpenCode; Figure 8 shows the executor model can edit too | Every session runs on the tuning model, DeepSeek V4.1 Flash 1017 (S-43), as an rlmh read run over the evidence (§7.4) |

### 7.2 What may change

`profiles.TUNABLE` (step 6) is the only list of keys a candidate may change, with bounds. `profiles.check_tunable(base, candidate) -> list[str]` returns the problems.

| Key | Bounds |
|---|---|
| `guidance.md` | at most 12,000 characters, UTF-8, LF line ends; `{shell}` stays the only placeholder |
| `read.max_turns`, `repo.max_turns` | 10 to 200 |
| `read.max_subcalls`, `repo.max_subcalls` | 10 to 200 |
| `repo.subcall_thinking` | `off`, `low`, `medium`, `high` |
| `repo.pace_nudge` | bool |
| `root.temperature`, `sub.temperature` | 0.0 to 1.0 |
| `rlm.max_runs` | 0 to 24 |
| `rlm.max_turns` | 5 to 60 |
| `rlm.max_parallel` | 1 to 8 |
| `compaction.window` | 65,536 to 1,048,576 |
| `compaction.keep_ratio` | 0.08 to 0.32 |

Every other key is frozen, and a candidate that changes one is invalid: `contract`, `cache_api`, `agent_api`, every `*_max_tokens`, `output_max_chars`, `cell_timeout_s`, `subcall_max_chars`, `subcall_oversize`, `rlm.max_depth`, `compaction.reserve` and `compaction.summary_max_tokens`. `training-v4` is never a base.

### 7.3 Evidence

`tune/evidence.ts` writes one folder for each session:

```
evidence/
  harness/profile.toml, harness/guidance.md    the harness under review
  tasks/<id>/task.md                           the task text, as rlmh gave it
  tasks/<id>/<run label>/trajectory.md         every turn: reply, code, output, error, sub-call summaries, compactions
  tasks/<id>/<run label>/deliverable.md        the diff (repo mode) or the submitted answer (read mode)
  candidates/<name>/diff.md, notes.md          (composer only) each candidate's edit and its editor's notes
  history.md                                   earlier rounds' composer notes
  library/INDEX.md, library/entries/...        the experience library for this domain (§7.7)
```

**Grader-leak guard.** `writeEvidence` refuses, and throws, if anything it is about to write comes from `grades.jsonl`, `grade-logs/`, a hidden tar or a `gold` field. It also refuses if a file contains a hidden test file's name. Its test plants each of those and expects the refusal. This follows `harness2/core/context.py`.

### 7.4 Sessions

Every session is an rlmh read run through `Session`. The question is a stage prompt, the inputs are the evidence files, the profile is the built-in `default` of the running harness (never a candidate), and the model is the tuning model. The model then reads the evidence through its REPL and sub-calls, which is the RLM idea applied to the paper's evidence folders (D-174). The session submits one JSON object as a string, `submit(json.dumps({...}))`, because `submit` refuses a dict:

| Session | Prompt (adapted from `prompts.py`) | Submits |
|---|---|---|
| Editor INV, editor DOM | `propose()` with `GENERALIZE` and `_INV_TEMPLATE` or `_DOM_TEMPLATE` | `{decision: "EDIT"\|"KEEP_BASE", notes: [str], guidance: str \| null (null keeps the base's text), toml: {"<table>.<key>": value}}`; DOM's `toml` must be empty |
| Composer | `aggregate()` | `{decision: "MERGE"\|"ADOPT"\|"REVISE"\|"KEEP_BASE", adopt: "inv"\|"dom"\|null, notes: [str], guidance, toml}` |
| Reflector | `experience()` | `{domain, entry: "NO_ENTRY" \| {cue, lesson, evidence, confidence}, edits: [...]}`, each edit with the fields `experience()` asks for, its verdict one of "helped", "hurt", "no observed effect", "confounded" |

- **A bad session.** An invalid submission (wrong shape, or `profile.check` not ok) gets one retry with the errors appended to the question. After that, the stage keeps its base, as `recursion.py` does.
- **Licence.** The prompts in `tune/prompts/` keep harness2's Apache-2.0 notice and name the source file and commit.

### 7.5 `rlmh tune`, offline (step 6, run at step 7)

```
rlmh tune SET --root M [--sub M] --base PROFILE --name NAME (--from EVAL_OUT | --continue OUT) [--rounds 2]
              [--probe 10 --seed S] [--jobs N] [--tokens-from RUNS.jsonl]... [--out DIR] [--go] [--max-usd X]
```

At step 7, `--base` is `v1-baseline`: the user profile step 5 creates as a byte copy of the built-in `default` after step 3, checked by its hash in steps 7, 8 and 10. Rounds are budget-driven. Round 1 always runs, and each later round runs only if its estimate (re-made from the runs so far, with `--tokens-from`) fits in what is left of `--max-usd`; `--rounds` is the maximum.

Per round *r* (incumbent = `--base` at round 1):

1. **Reference.** The incumbent's tune-split eval. Round 1 reuses `--from` (the tune half of step 5's baseline) instead of spending again; `--continue OUT` continues a finished tune with more rounds; a tune that stopped (cap or error) can't be resumed.
2. **Edit.** Evidence over the reference runs, then the INV editor and the DOM editor. That gives at most two candidates, written under `<out>/rounds/<r>/profiles/` and installed into `<home>/profiles/` only while they run.
3. **Probe.** Each candidate runs on the probe subset: `--probe` tasks from the tune split, `--sample` with `--seed`, fixed for the whole tune.
4. **Compose.** The composer session reads the reference runs, both candidates' probe runs, their diffs and their notes. It writes `<NAME>-r<r>`.
5. **Accept.** The composed profile runs on the whole tune split. It becomes the incumbent only when:
   - its pass count is at least the incumbent's + 1,
   - its mean `f2p_share` is not lower,
   - and its mean cost is at most 1.5× the incumbent's (D-173).
6. **Reflect.** The reflector session writes at most one lesson to `<out>/library/`.

The output folder `<out>/` holds:
- `tune.json`, with every stage's profile hash, decision, pass counts and cost;
- `rounds/<r>/{evidence-*/, sessions/, evals/}`;
- `library/`;
- `final/`, a copy of the last incumbent's folder.

`--max-usd` covers everything in the tune, and the estimate before `--go` lists every stage. The held-out split is never touched here: step 8 checks it, and ships the tuned profile only if it passes more held-out tasks than `v1-baseline` at a mean cost at most 1.5 times `v1-baseline`'s (D-173).

### 7.6 `/tune`, online, for users (step 9)

This is Harness²'s own setting, at k = 1, run sequentially over the user's tasks as `schedule.py` does.

- **Tasks.** One to five tasks the user types, or a `tasks.jsonl` in D-28's shape plus an optional `test` command. There is no gold.
- **Per task:**
  - one reference run;
  - the INV and DOM editors;
  - two probe runs;
  - the composer;
  - one composed run;
  - the reflector.

  That is at most four rollouts and four sessions: a stage whose profile equals its base isn't run, and the harness each task delivers is the next task's base, so `/tune` ends with one profile.
- **Isolation.** Repo tasks run in a throwaway `git worktree` of the user's folder at `HEAD`, never in the folder itself. A folder outside git gets a copy.
- **Delivery.** At k = 1 the composed harness is delivered as the paper does, except when the task has a test command: then it is kept unless the reference run's test exits 0 and the composed run's doesn't. Test output never reaches the evidence.
- **Cost first.** Before anything runs, `/tune` shows an estimate: per task, 4 × the median cost of the user's last 20 runs in that mode with that model, plus 4 sessions (3 with the library off) at the median cost of earlier `/tune` sessions, or §6.6's figures when there is no history (D-221). It runs only after an explicit yes, and stops at `tune.max_usd` (§8).
- **Output.** A user profile `<home>/profiles/tuned-<YYYYMMDD-HHMM>/` plus library entries. `/tune` then offers to set `profile` to it.
- **Runs.** Every `/tune` run and session is a normal run with `conversation: false` and a `tag` of `tune:<id>:t<i>-<stage>`, logged under `<home>/runs/tune-<id>/`, so `/runs` shows them.

### 7.7 The experience library

```
<library root>/<domain>/INDEX.md                         one cue line per entry: "- <cue> -> entries/<id>/EXPERIENCE.md"
<library root>/<domain>/entries/<id>/EXPERIENCE.md       the lesson, its evidence and confidence, and the edits table
<library root>/<domain>/entries/<id>/harness/            the adopted guidance.md and profile.toml
```

- **Where it lives.** The library root is `<tune out>/library/` for `rlmh tune` and `<home>/library/` for `/tune`. The domain is `read` or `repo` for the offline tuner, and `read` or `repo-<folder name>` for users.
- **Who writes it.** The reflector, after each round (offline) or each task (online). Its default is NO_ENTRY.
- **Who reads it.** Editor and composer sessions, through `evidence/library/`. Ordinary runs never read it (D-175).
- **The off switch.** `tune.library = false` (§8) stops both the writing and the reading.

## 8. Settings added

Added to `SCHEMA` in `settings.ts`, in this order after v0's keys. `rlmh config list` and `/settings` show them.

| Key | Type | Default | Step | Meaning |
|---|---|---|---|---|
| `conversation.follow_ups` | bool | `true` | 4 | a question in the interactive app continues the open conversation (§5); `false` gives v0's fresh run every time |
| `tune.max_usd` | number | `1.00` | 9 | `/tune`'s hard stop, in USD |
| `tune.library` | bool | `true` | 9 | write and read the experience library during `/tune` |

## 9. Folders at run time added

```
<home>/
  eval/ledger.jsonl                 every --go of rlmh eval and rlmh tune (§6.5)
  eval/out/<eval id>/               rlmh eval's default output folder
  eval/work/<eval id>/<task id>/    throwaway work copies, removed after grading unless --keep
  eval/venvs/<key>/                 per-repo test venvs (§6.4)
  profiles/<name>/                  candidates from rlmh tune; tuned-* profiles from /tune (loaded since v0, D-144)
  tune/<tune id>/                   rlmh tune's default output (step 6); /tune's stages and evidence (step 9)
  library/<domain>/                 /tune's experience library (§7.7)
```

`paths.ts` gains `evalDir(h)` (step 2), `tuneDir(h)` (step 6) and `libraryDir(h)` (step 9), and starts using the existing `profilesDir(h)`.

## 10. Commands added

| Command | Step |
|---|---|
| `rlmh eval SET …`, `rlmh eval report OUT`, `rlmh eval compare A B`, `rlmh eval ledger` | 2 |
| `rlmh tune SET …` | 6 |
| `/tune` in the interactive app, a tenth slash command. Step 9 raises `App.tsx`'s `MENU_MAX` from 9 to 10 | 9 |

## 11. Spending (S-44)

Everything v1 spends comes from Rishi's OpenRouter key, with a $30 cap for all of v1. Each spend step:
- prints its estimate;
- waits for Rishi's go in chat;
- runs with `--max-usd` set to its row below or less;
- writes its real cost into progress.md and the ledger.

Steps that come in under budget leave the rest for later rows.

| Step | What | Ceiling |
|---|---|---|
| 5 | Baseline: `v1-baseline` (v0.2.0's `default` plus step 3's `[compaction]`) on all 48 tasks, `training-v4` on the 24 held-out tasks, DeepSeek | $9 |
| 7 | Tuning on the tune split, DeepSeek: round 1, then round 2 if its estimate fits | $9 |
| 8 | The tuned profile on the held-out split, DeepSeek | $3 |
| 10 | `v1-baseline` and the tuned `default` on the held-out split, Haiku 5.5 | $6 |
| any | Reruns of infra errors, and the step 9 live check | $3 |
| | **Total** | **$30** |

Each run is one replicate. The paper's authors recommend repeats, and with 24 held-out tasks a single replicate can't show significance. `report.md` and `results.md` say so next to every comparison (D-170).

## 12. Tests and who writes them

All offline, against fakes (v0 §11 still holds). Each step owns the tests in its spec. The shared fixtures are:
- **`app/test/fixtures/evalset/`** (step 2): a set folder in §6.1's layout with six tasks: a search and a research read task, two pure-Python packages with one hidden f2p test and one p2p test each, one CUDA kernel task (its grading skips without a GPU) and one web task (its grading needs Node, pnpm and a Playwright Chromium, and runs on CI's Linux leg). Steps 2, 6 and 9 grade real pytest runs offline. Tests that need Python find it the way the engine does, and skip when none is found.
- **`fake/scripted` scripts** for sessions (step 6): a session's submit is a scripted `tool_call` whose code calls `submit(json.dumps({...}))`.

## 13. v0 facts that v0/architecture.md doesn't list

These exist in the code at `9f0cedd` and are not in v0/architecture.md. v1 steps rely on them:
- `model.complete`'s `child: {id, turn, max_turns, depth}` param and the `run.child` event (D-160, `protocol/examples.json`)
- `Profile.cache_api`, `.agent_api`, `.rlm` and `.file_hash`
- `RunSpec.input_spans` (D-157)
- `rlmh update` (D-149)
