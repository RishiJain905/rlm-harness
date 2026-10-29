# Step 9. Smoke run

| | |
|---|---|
| **Type** | Spend |
| **Cost** | Rishi's own API keys, estimated by the script before it runs and spent only after his "go" in chat. A local model costs $0. Never W&B credit |
| **Depends on** | 7, 8 |
| **Unblocks** | 10 |
| **Parallel with** | none |
| **Decisions it uses** | **9a: no default; the thread asks Rishi first (D-41).** 6b: native `python` tool for API models, fenced text for local ones, via `call_format = auto`. Also S-06, S-11, S-19, D-15, D-22, D-26, D-27, D-28, D-40, D-45, D-46 |

## Goal

`scripts/harness_smoke.py` in the RLM repo runs `rlmh batch --json` on 5 context-search tasks with each of two models, 10 runs in all, grades them with RLM's own scorer and writes a report: accuracy, turns and sub-calls per run, cost and cache hit rate. It is the first end-to-end run of the finished `rlmh` with real models. It ends v0's functional work, and step 10 packages what it proved.

## Read first

- [../architecture.md](../architecture.md) §7.8 (`rlmh batch`, `--json`, `tasks.jsonl`, run-log record), §7.9, §5.3 (`run.started`, `run.finished`), §5.4, §4 (Usage), §7.3 (ModelInfo, `price` per 1M tokens), §7.4 (call-format resolution), §8 (settings), §9 (folders).
- [../decisions.md](../decisions.md): D-15, D-22, D-25 to D-28, D-40, D-41, and the open-decisions table (9a, 6b).
- [../../v0-build-plan.md § Step 9](../../v0-build-plan.md#step-9-smoke-run) and [../../v0-design.md § Non-interactive](../../v0-design.md#interface).
- `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/tasks/__init__.py`: `fixed_set`, `private_seed_list`, `make_task`, `eval_only`.
- `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/tasks/aggregation.py`: the docstring, `make_task`, `version_for`, `_build_dense`, `HELDOUT` and `HELDOUT_TEMPLATES`. This is the context-search family.
- `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/reward.py`: `score_answer`, `score_count`, `set_f1`, `check_grading`, `score` (which answers count). `bridge.py`: `READ_LIMITS_V4`. `env.py`: `Task`. `transcripts.py`: `episode_record` (the `usage` keys, for the fallback estimate).
- RLM working tree, read-only: `rlm_rl/reward.py` also has `strip_id_labels` (added after 0b9af69, so "user 11952" scores as "11952"); the script grades with the working tree. `scripts/benchmark.py` shows the house style (`--live`, `--ceiling`). `.gitignore`.

## Starting state

- Steps 7 and 8 are `done` in progress.md. `rlmh` is built (`bun build --compile` output, or the CI artifact) and `rlmh batch` works on the fake provider (step 6, D-20).
- `app/catalog/models.json` exists (step 5). Keys, if any, are saved through `/providers` or sit in the provider's environment variable. The script never reads or prints one.
- RLM repo: `.venv\Scripts\python.exe` (Python 3.12) imports `rlm_rl.tasks`, and the data root `D:\RLM-data` holds the HuffPost headlines (`data.huffpost_pools`). `private/` is git-ignored.
- **`.gitignore`:** step 8 added `results/harness-*/` (D-46). Without it, a new folder under `results/` would show up as untracked, because the other `results/` rules cover only `transcripts/`, `audit/`, `pilot-*/` and a few named folders. The run logs there hold the questions and the models' answers, which are as good as gold answers.

## Deliverables

All in the RLM repo (`F:\Personal\RLM\RLM`) unless marked. Nothing in rlm-harness changes except progress.md and, for 9a, decisions.md.

| Path | What it is |
|---|---|
| `scripts/harness_smoke.py` | The script. Imports `rlm_rl.tasks`, `rlm_rl.reward` and `rlm_rl.bridge` from this repo and nothing from rlm-harness |
| `tests/test_harness_smoke.py` | Offline tests (below). Not in architecture.md §11; this step owns it |
| `.gitignore` | One line, **`results/harness-*/`** (D-46), normally already added by step 8; if not, added here with Rishi's approval before any output exists |
| `documentation/harness-smoke-v0.md` | The summary: tables of numbers, task ids and levels only. No task text, no answers, no gold |
| `results/harness-smoke/<date>/` | Git-ignored outputs (layout below). `<date>` is `YYYY-MM-DD` |
| `private/seeds/harness-smoke-v1.json` | The task seeds, created on first build by `private_seed_list`. Git-ignored |
| `%TEMP%\rlmh-smoke\<date>\` | `tasks.jsonl` and `ctx\<task id>.txt`. Outside both repos. Holds no gold. Left in place; the script prints the path |

```
results\harness-smoke\<date>\
  a-<slug>\  b-<slug>\     per slot: runs.jsonl (rlmh's run log), events.jsonl (every --json line, verbatim),
                           stderr.log, and rerun\ with the same three files if a rerun happened
  grades.jsonl             one line per final run: slot, task_id, level, run_id, answer, gold, exact, reward,
                           components, reran (answers and gold are here and nowhere in git)
  report.md                the summary's numbers plus failure notes
```

**The task set (decided here).** Set name `harness-smoke-v1`, family `aggregation_heldout`, from `tasks.fixed_set`:

```python
PLAN = {("aggregation_heldout", 1): 2, ("aggregation_heldout", 2): 2, ("aggregation_heldout", 3): 1}
```

- **Why this family.** Context search is the aggregation family (step 12 plan: "context search"). `aggregation_heldout` is held out by design: a source training never saw (HuffPost headlines), its own line formats and question templates, eval-only (`_heldout`). The generator is aggregation-v4 (task ids outside `FROZEN_EVAL_SETS`).
- **Why a new seed list.** `heldout-test-v1` and `-v2` are touched once, in training step 13, and the v1 experiment will draw its own 20 tasks. The smoke run takes fresh seeds under its own name. Task ids look like `harness-smoke-v1-aggregation_heldout-L1-00` and never hold a seed.
- **Why levels 1 to 3.** Each context is about 0.25M to 0.55M characters, in the REPL and never in the prompt, so cost comes from sub-calls. Level 1 is where sub-calls paid in step 12. Levels 4 and 5 add cost and little else.
- **Grading.** `answer = run.finished.answer if submitted and answer_valid else None`, then `reward.score_answer(answer, task.answer, task.grading)`, which is what `reward.score` does for a training episode. `exact` is `Score.correct`, and `reward` is the partial credit. Hack detectors are not run: v0 logs hold no sandbox audit events. The report prints the RLM commit (`git rev-parse HEAD`).

**CLI** (run from the RLM repo root with `.venv\Scripts\python.exe`, not WSL, because `rlmh.exe` and `%TEMP%` are Windows):

| Flag | Meaning |
|---|---|
| `--model-a P/M`, `--model-b P/M` | **Required, no default.** Exit 2 with "9a has no default: pass --model-a and --model-b" if missing. Root and sub-call model are the same in a slot |
| `--profile-a`, `--profile-b` | Default `training-v4` when the provider is `local`, otherwise `default` |
| `--estimate` (default) / `--rehearse` / `--go` / `--report` | Modes (below). Only `--go` spends. `--report` rebuilds `report.md`, `grades.jsonl` and the summary from saved `events.jsonl` files |
| `--rlmh PATH` | The binary. Default: `rlmh` on PATH |
| `--harness PATH` | Default `..\rlm-harness`. Only used to find `app\catalog\models.json` |
| `--catalog PATH`, `--price-a`, `--price-b` | Override the catalog file, or give `in,out,cache_read,cache_write` in USD per 1M tokens |
| `--tokens-from PATH` | Repeatable. A run log `runs.jsonl`, or a training transcripts folder. Default: `results\prod-v2\transcripts` |
| `--margin X` (1.5), `--cost-cap USD`, `--jobs N` (5), `--only a\|b`, `--date D` | Planned = expected x margin. Cap default = 2 x planned total, over both slots. `--only` runs one slot |

## Tasks

1. [ ] Check that rows 7 and 8 are `done` in progress.md. Set row 9 to `in progress`.
2. [ ] **Ask Rishi 9a, then stop until he answers.** Do not run `--estimate` before. Send:
   > Step 9 needs 9a: which two models for the smoke run? (A) One API model and one local model. This exercises both clients and both call formats. I need the API model's provider/model id (a cheap one such as DeepSeek's keeps it to cents) and a key saved in `/providers` or in the provider's environment variable. For the local one I need the server (vLLM, Ollama, LM Studio or llama.cpp), its URL, the model name it serves (for example base Qwen on vLLM) and its context length, with the server running when I start. (B) Two API models: no local server, but the fenced-text path goes untested with a real model. Nothing is estimated or run until you answer.
3. [ ] Record the answer in decisions.md (9a settled, with the date and the picks) and one line in progress.md.
4. [ ] **Fix the profile and call format per slot** and write them in the report. The call format is never set by the script. It follows from `call_format = auto` (§7.4, 6b):

   | Slot model | Profile | Call format | Why |
   |---|---|---|---|
   | API model, catalog `tool_call: true` | `default` | native | It is the product's own profile and path. Pick an API model with `tool_call: true`, or the native path goes untested |
   | API model, `tool_call: false` | `default` | fenced | `auto` falls back. Tell Rishi, since it changes what is tested |
   | Local Qwen (`local/...`) | `training-v4` | fenced | The exact training text and the format base Qwen was trained and piloted on |
   | Any other local model | `default` | fenced | `training-v4` is the LoRA's contract. Ask Rishi if unsure |

   The slots use different profiles on purpose. The report ranks nothing: 5 tasks per model cannot.
5. [ ] **Check the `.gitignore` line** (D-46). Step 8 normally added `results/harness-*/` already; if not, ask Rishi to approve it and apply it. Then run `git -C F:\Personal\RLM\RLM check-ignore -v results/harness-smoke/2026-01-01/a-x/runs.jsonl`. It must print the rule. Do not commit.
6. [ ] **Local slot only.** Rishi starts the server (or approves the thread starting it). Run one `curl http://<host>:<port>/v1/models` against it, with no key, to get the served model name, and use `local/<name>` as `--model-b`. A model missing from the catalog still runs, at cost 0, with no window check and fenced format (D-45), so no refresh is needed. A request too long for the server's own context length then fails at the server as `bad_request` or `other`. If that happens, stop and tell Rishi: the server needs a longer context, or the slot a different model.
7. [ ] **Task build** (`build_tasks`, `write_task_files`). Call `tasks.fixed_set("harness-smoke-v1", PLAN)`. Write each context with `write_bytes(task.context.encode("utf-8"))`, because text mode on Windows would turn `\n` into `\r\n` and change the text the model reads (D-10 reads with `newline=""`). Write `tasks.jsonl`, one line `{"id", "question", "input": "ctx/<id>.txt"}` (D-28), forward slashes, no gold. Keep `task.answer` and `task.grading` in memory. On `--go` rebuild the tasks and refuse to start if any context's sha256 differs from the files in the temp folder.
8. [ ] **Estimate mode** (`load_prices`, `load_tokens`, `estimate`). Needs no network and reads no key.
   - Prices come from the catalog for the slot's `provider/model`. Provider `local` is priced 0,0,0,0 without a lookup. A missing entry exits 2 and names `--price-a`. `load_prices` reads step 5's layout, `{"version": 1, "source": …, "models": [ModelInfo…]}` (architecture.md §7.3), and exits 2 naming the file on anything else.
   - Reference tokens per run come from `--tokens-from`. A harness `runs.jsonl` gives `usage.root` and `usage.sub` (`input_tokens`, `output_tokens`) and the counts `len(turns)` and `len(subcalls)`, from records without `infra_error`. A training transcript gives `usage.root_prompt_tokens`, `root_completion_tokens`, `subcall_prompt_tokens`, `subcall_completion_tokens`, `root_calls`, `subcalls`, from `aggregation` and `aggregation_heldout` episodes without `infra_error`. Print n and the source. The default, step 12's recorded episodes, is mostly level 1 and comes from Qwen; a real run log from step 6 beats it if one exists.
   - Cost (D-22), per role: `uncached_in*p.input + cache_read*p.cache_read + cache_write*p.cache_write + out*p.output`, per 1M tokens.
     - **expected**: the mean reference tokens with no cache reads (a hit can only lower it).
     - **planned** = expected x margin.
     - **ceiling**: every limit used, from `bridge.READ_LIMITS_V4`. Sub-calls: `max_subcalls x subcall_max_chars/3` in and `max_subcalls x subcall_max_tokens` out. Root: `sum over t=1..max_turns of (4000 + (t-1) x (root_max_tokens + output_max_chars/3))` in and `max_turns x root_max_tokens` out. Chars/3 is the gateway's own estimate (D-25), and 4000 is the system prompt plus first message *(mine)*. About 3.0M in and 0.41M out per run.
   - Also print the expected call format and profile per slot, the context sizes, `rlmh --version`, and `rlmh config get` for `call_format`, `permissions.mode`, `root.thinking`, `sub.thinking`, `profile`. These are local reads. Print the cap, and "nothing runs until `--go`".
9. [ ] **Batch runner** (`run_slot`, `run_batch`). Per slot, in order a then b:
   - Command, as an argument list with no shell: `[rlmh, "batch", <tasks.jsonl>, "--json", "--jobs", N, "--out", <slot dir>, "--root", ref, "--sub", ref, "--profile", name]`. Do not pass `--call-format` or `--permission-mode`. Batch runs are non-interactive (D-15), so a guarded action (shell, network, write) is denied and the model sees a `PermissionError`.
   - `Popen(..., stdout=PIPE, stderr=<slot dir>\stderr.log, text=True, encoding="utf-8", errors="replace")`, inheriting the environment unchanged. Never print the environment.
   - Read stdout line by line. Append each line to `events.jsonl` before parsing. Keep `run.started` (note `call_format`, `profile`, `input.chars` and `input.sha256`), `run.finished` (the tag is the task id), `run.permission` (count denials per run) and `gateway.call` (add `usage.cost_usd` to the running total). A line that is not JSON goes in the report as an error.
   - **Cap.** When the running total passes `--cost-cap`, terminate the process, mark its unfinished runs and every later slot "not run: cost cap", and say so first in the report. Windows: `terminate()` kills `rlmh.exe`; the engine then sees stdin close and exits (§1). The tests check for no orphan.
   - Exit code 0 or 1 from `rlmh` is normal (D-40). Exit 2 is a usage error: stop and show the tail of `stderr.log`.
10. [ ] **Reruns** (`plan_reruns`). A run that ends with `infra_error` is rerun once, together, with `--out <slot dir>\rerun` and a `tasks-rerun.jsonl` in the temp folder. A task with no `run.finished` (the batch died) counts as `infra_error` "batch_crashed". Rerun for kinds `rate_limit`, `server`, `timeout`, `network`, `worker`, `other` and "batch_crashed". Never rerun `auth`, `no_key`, `unknown_model`, `context_window`, `bad_request` or `cancelled`: they are setup problems, and a repeat fails the same way. Stop and tell Rishi. The rerun's result replaces the first in the grades. A second failure stays a failure: excluded from accuracy, counted and listed. Both attempts are noted in the report (task id, kind, message, outcome).
11. [ ] **Grade and report** (`grade`, `write_report`). Per slot: n finished, n infra-failed; accuracy as exact/graded plus mean `reward` (partial credit); mean and per-run turns and sub-calls; cost (total, per run, from `run.finished.cost_usd`); cache hit rate = cache reads / input tokens (D-22), for root, sub and overall, with a note that a provider may report no cache tokens at all; mean wall time; denied actions. Also the resolved profile, `call_format` (flag a mismatch with Task 4's table), models, `rlmh --version`, the RLM commit, the estimate against the actual cost, and the rerun list. `harness-smoke-v0.md` is built from a fixed template with these numbers, task ids and levels. It never takes question, answer or gold text.
12. [ ] Write `tests/test_harness_smoke.py` and make it pass.
13. [ ] **Rehearse, $0.** `--rehearse` runs the whole pipeline on the fake provider: the script writes an `RLMH_FAKE_SCRIPT` file whose root reply is `{"text": "", "tool_call": {"code": "submit('0')"}}`, and runs both slots with `--root fake/scripted --sub fake/scripted` into `results\harness-smoke\<date>-rehearsal\`. It proves the real contexts load, every event parses, `run.started.input.chars` equals the context length and the report builds, before any money moves. Fix what it finds, in the script, or report a bug in `rlmh` to Rishi and name the step that owns it.
14. [ ] Run `--estimate` with Rishi's models. **Post the whole estimate in chat and wait for his "go".** A go covers that estimate only. If the models, jobs or cap change, estimate again and ask again.
15. [ ] On "go", run `--go`. Watch the progress lines (task id, turns, sub-calls, cost so far). Do not interrupt a run unless the cap or Rishi says so. When it ends, read `report.md`, then answer Rishi with the numbers and the reruns.
16. [ ] Write `documentation\harness-smoke-v0.md`. Update progress.md (below). Do not commit or push either repo.

## Tests

`tests/test_harness_smoke.py` (unittest: `python -m unittest -v tests.test_harness_smoke`). It uses a stub `rlmh`, a small Python script that prints canned `--json` lines and takes the failures to simulate from its arguments; the tests call `run_slot` with `[sys.executable, stub]`. Cases needing the data root use `data.available()` and skip without it. No test makes a network call or reads a key.

| Case | Asserts |
|---|---|
| `test_plan_and_task_files` (needs data) | 5 tasks, levels 1,1,2,2,3. Two builds give equal context sha256. `tasks.jsonl` lines hold exactly `id`, `question`, `input`, with `/` paths. Context files are byte-equal to `context.encode()` with no `\r`. No line holds the gold |
| `test_no_default_models` | `--estimate` without `--model-a` exits 2 with "9a has no default" |
| `test_estimate_math` | With fixed prices and tokens the expected, planned and ceiling numbers equal a hand calculation. The ceiling is 2,964,907 in (rounded) and 409,600 out per run for READ_LIMITS_V4. Cache reads lower the cost. `local` is $0. A missing catalog entry exits 2 |
| `test_load_tokens` | A synthetic `runs.jsonl` and a synthetic transcript file give the same shape of means. Infra records are skipped |
| `test_load_prices_layouts` | Step 5's `{"version", "source", "models"}` layout loads. Any other layout exits 2 naming the file |
| `test_parse_stream` | The stub's `run.started`, `run.finished`, `gateway.call` and `batch.finished` are parsed. A garbage line is reported, and `events.jsonl` keeps it verbatim |
| `test_grading` | Hand-made `Task` objects: exact int, `count` near miss (partial credit), exact list, list with `user 123` labels, no submit, `answer_valid` false |
| `test_rerun_once` | A `server` failure is rerun once and the rerun's result is graded, with a note. An `auth` failure is not rerun. A second failure is listed and excluded from accuracy. A missing `run.finished` is "batch_crashed" and rerun |
| `test_cost_cap` | The stub's `gateway.call` costs cross the cap: the stub is terminated, the unfinished runs and slot b are "not run: cost cap", and no process is left |
| `test_report_has_no_task_text` | With sentinel strings as question, gold and answer, they appear in `grades.jsonl` (answer, gold) and nowhere in `report.md` or the summary |
| `test_refuses_existing_output` | `--go` exits 2 if the slot dir already holds `runs.jsonl` |
| `test_windows_paths` | A stub path and temp path with spaces work, UTF-8 text with accents in a question survives, and the stub gets an argument list |
| `test_no_key_output` | With `FAKE_API_KEY=sk-sentinel-123` in the environment, no mode prints it to stdout, stderr or any file |

## Done when

- `.venv\Scripts\python.exe -m unittest -v tests.test_harness_smoke` passes on Rishi's PC.
- `git -C F:\Personal\RLM\RLM check-ignore -v results/harness-smoke/2026-01-01/a-x/runs.jsonl` prints `results/harness-*/`. After the run, `git status --short` shows no path under `results/` or `private/`, only the script, the test, `.gitignore` and the summary.
- `harness_smoke.py --estimate` with no model flags exits 2 naming 9a. With Rishi's picks it prints the estimate and exits 0, with no network call and no key read.
- `--rehearse` exits 0: `grades.jsonl` has 10 lines, the report exists, the cost is $0.
- Rishi's "go" is in the chat after the estimate, before `--go` started.
- `--go` exits 0, and `results\harness-smoke\<date>\grades.jsonl` has 10 lines. Each slot's `runs.jsonl` has 5 final records. Any infra failure shows in `report.md` under "Reruns" with its single rerun. The total cost is at most the cap.
- `documentation\harness-smoke-v0.md` holds the numbers for both slots and no question, answer or gold text.
- `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*rlm_engine*' -or $_.Name -eq 'rlmh.exe' }` prints nothing after the run.

## Out of scope

- Any change to `rlmh` or the engine. A bug found here is reported to Rishi and fixed in the step that owns the file, with a line in progress.md.
- Parity (step 8) and the installer (step 10).
- The v1 experiment: its 20 held-out tasks, Harness² and the LoRA arm. The smoke seeds are not reused there.
- Hack detectors, significance tests and any ranking of models. 5 tasks is a functional check.
- Keys: the script never reads, validates or prints one, and makes no call itself. All model calls go through `rlmh`.

## Hand-off

- v0's functional work is finished. Step 10 can rely on: a built `rlmh` that completed read-mode batches on two real models, on Windows.
- progress.md: set row 9 to `review`, with the date, the two models, the profiles, estimate against actual cost, accuracy per slot, any reruns, and the path `F:\Personal\RLM\RLM\results\harness-smoke\<date>\`. Add a log line with the same. Note anything v1 should know, for example a fenced-format failure or a native-format quirk.
- The summary doc and the `.gitignore` line wait in the RLM working tree for Rishi to commit.

## If a decision goes the other way

- **9a, one API model and one local model (assumed shape).** Slot a is the API model on `default` and native format. Slot b is the local model on `training-v4` and fenced format, priced $0. Both clients and both call formats get a real model.
- **9a, two API models.** No local server, Task 6 is skipped, and both slots are `default` and native. The fenced path is untested with a real model. To cover it, add `--call-format fenced` to one slot's `rlmh batch` command (§7.8 lists the flag for `batch` too), and write that in the report.
- **9a, anything else** (two local models, a custom endpoint): `--profile-a/-b` and `--price-a/-b` cover it. A `custom` provider is priced from the catalog or the flag, and it resolves to fenced.
- **6b, fenced text everywhere.** `auto` becomes `fenced` for every model, so Task 4's table has no native rows and the API model's native tool call goes untested. The script does not change, and its format check reads the new expectation. Token use differs, so the estimate's margin matters more.
- **5a, fewer providers** (Anthropic, OpenAI and local only): the API model must be one of those, and the DeepSeek suggestion drops out.
