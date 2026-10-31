# Step 8. Parity with training

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 6 (and through it 2 to 5) |
| **Unblocks** | 9 |
| **Parallel with** | 7 |
| **Decisions it uses** | 2b: the script sets `RLMH_HOME`. 3a: the training text and the `/work/repo` mapping stay. 4a: Git Bash, else PowerShell. 4b: the script passes its own mode, `accept-edits` by default like the app (S-27). 6b: the script passes `call_format: "fenced"` itself. S-13, S-14, S-19. D-07, D-09, D-17, D-34, D-35, D-37, D-42, D-46, D-49 |

## Goal

A script in the RLM repo replays 5 recorded v4 training episodes (3 read, 2 edit) through the real engine, acting as the app, and compares every root request with the messages the trained LoRA saw. When it exits 0, every request matched byte for byte, or each difference is in a written-down class whose reason says why the model can't notice it. This is the proof that `training-v4` gives the LoRA the bytes it trained on, and that the native worker changed nothing the model can use.

## Read first

- [../architecture.md §3 to §5.4](../architecture.md#3-the-link) (the link, `run.start`, `model.complete`, events, one run in order), [§6.3](../architecture.md#63-the-models-context), [§7.6](../architecture.md#76-step-3--4-6-8-contract-call-format-profiles), [§7.8](../architecture.md#78-step-6--7-8-9-runs-run-log-commands), [§7.9](../architecture.md#79-steps-8-and-9-scripts-in-the-rlm-repo).
- [../decisions.md](../decisions.md): D-07, D-09, D-17, D-34, D-35, D-37, and S-25 (3a), S-26 (4a), S-27 (4b) and S-30 (6b).
- [../../legacy/v0-build-plan.md § Step 8](../../legacy/v0-build-plan.md#step-8-parity-with-training), [../../legacy/v0-design.md § Tests](../../legacy/v0-design.md#tests) (the Parity row).
- Training, `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/<file>`:
  - `transcripts.py`: `episode_record`, `TranscriptLog`, `find_logs`.
  - `env.py`: `run_episode` (how `messages` grow; `resample_broken` redraws before a reply enters `messages`; `pace_nudge`; `Task`).
  - `bridge.py`: `limits`, `initial_messages`, `observation`, `pace_message`, `OBS_PACE_*`, `PROMPT_HASHES`.
  - `evals.py`: `eval_set`, `SELECTION_V4_READ`, `SELECTION_V4_EDIT`. `tasks/__init__.py`: `fixed_set`, `private_seed_list`, `generator`.
  - `tasks/editspec.py`: `Pool.to_task`, `Pool.eval_tasks`. `tasks/editbugs.py`: `POOL`. `tasks/editreal.py`: `_build_workspace`, `_context`.
  - `editbox.py`: `Workspace`, `_commit_base`, `git_env`, `GIT_DATE`, `diff`. `client.py`: `subcaller`, `ROOT_TEMPERATURE`.
- Current branch, read-only: `documentation/step-12-runbook.md` (pacing nudge, §7d fixes), `results/prod-v2.json` (`config`, `notices`), `.gitignore`.

## Starting state

- Steps 2 to 6 are `done`. `uv run --project engine pytest engine/tests` passes on Windows, and `rlmh run --json` on the fake provider prints a full event stream.
- `engine.info` on the `training-v4` profile reports `prompt_hash == training_hash == a71401e2…a1d6` (step 3).
- On Rishi's PC: transcripts under `F:\Personal\RLM\RLM\results\{prod-v2,prod-v1}\transcripts\` (git-ignored), task data at `D:\RLM-data` (`rlm_rl/data.py` finds it), the private eval seeds in `private\seeds\`, `uv` and `git` on PATH, and the RLM repo's `.venv\Scripts\python.exe`, which can import `rlm_rl`.
- **No `.gitignore` rule covers `results/harness-parity/`.** The existing rules cover `results/*/transcripts/`, `results/**/audit/` and a few named folders, and `git status` already lists `results/prod-v1/` as untracked. Task 1 adds `results/harness-*/` (D-46), which also covers step 9's `results/harness-smoke/`.

## Deliverables

All in `F:\Personal\RLM\RLM`, except the last row.

| Path | Responsibility |
|---|---|
| `scripts/harness_parity.py` | The replay and comparison. Imports nothing from rlm-harness. Imports `rlm_rl` (current branch) only to read transcripts, rebuild tasks and workspaces, and look up limits and hashes. |
| `results/harness-parity/<date>/report.md`, `report.json` | Full report, with task text in the diffs. Git-ignored through the new rule. `<date>` is `YYYY-MM-DD`. |
| `documentation/harness-parity-v0.md` | Summary with no task text: episode ids, families, counts, difference classes with their reasons, the fixes made, the commits. Written by `--write-summary`. |
| `.gitignore` | One added line: `results/harness-*/` (D-46). Rishi approves it before the first run. |
| `tests/test_harness_parity.py` | Offline unit tests of the script's pure parts (not in architecture.md §11, because they are the RLM repo's own). |
| rlm-harness `engine/…` | Only fixes the report demands, each with a test in an existing engine test file. No new file. |

**Command line**

```
python scripts\harness_parity.py --harness F:\Personal\RLM\rlm-harness [--read 3] [--edit 2] [--episodes ID,ID,…]
    [--runs prod-v2,prod-v1] [--permission-mode accept-edits|default|bypass] [--engine-cmd "CMD"] [--work-dir DIR]
    [--keep-work] [--strict] [--write-summary] [--date YYYY-MM-DD] [--episode-timeout-s 1800]
```

| Exit | Meaning |
|---|---|
| 0 | Every selected episode ran to its end, and every difference is in an accepted class. |
| 1 | An unexplained difference, an unmatched sub-call, an extra or missing root call, an `infra_error` in a run, or the engine died. |
| 2 | Setup failed: engine did not start, hash or protocol mismatch, fewer eligible episodes than asked, bad flags, or the summary guard found task text. |

`--strict` makes accepted classes count as failures, which shows the byte-for-byte count on its own.

## Tasks

1. [ ] Ask Rishi to approve the line, then add `results/harness-*/` to `.gitignore` (D-46). Check with `git check-ignore -v results/harness-parity/2026-10-28/report.md`, which must print that line.
2. [ ] **Load.** For each run in `--runs`, `transcripts.find_logs(results/<run>/transcripts)` then `TranscriptLog(p).records()`. The record's `task_id` never holds the seed.
3. [ ] **Filter to eligible records.** All must hold, else skip with a reason code kept for the report:
   - `prompt_version == "v4"`, no `infra_error`, `hacks == []`, `flags == []`, no event with `blocked` true, `timeouts == crashes == restarts == 0` (a blocked write or restart can't replay: the harness asks and allows instead of blocking). Amended at build (D-110): this said `events == []`, but training's edit-mode REPL logs every tool call, program and repo access as an unblocked event, so that rule rejected every edit episode.
   - `limits == bridge.limits(family, "v4").as_dict()`. This drops the pilot arms and tasks with their own `cell_timeout_s`.
   - `messages[0].content == bridge.system_prompt("v4")`. This drops warm-start episodes, whose system prompt carries a hint.
   - Pace is known (below). Edit episodes are eligible only when it is.
4. [ ] **Pace.** Training added a pacing line to edit observations only when `RunConfig.pace_nudge` was on. `results/prod-v2.json` has `config.pace_nudge = true`, and its notice "edit episodes' observations carry a pacing line from here on" dates from checkpoint 1. So pace is **on** for prod-v2 `train` transcripts from step 2, and for every prod-v2 `val` transcript. `prod-v1` has no `pace_nudge` key, so it is **off**. Anything else is unknown, so ineligible. If a record says off but its observations hold `OBS_PACE_EDIT` or `OBS_PACE_TEST` text, abort with exit 2: the table is wrong.
   - Pace on: profile `training-v4` (`[repo] pace_nudge = true`).
   - Pace off: a user profile named `training-v4-nopace` in `<RLMH_HOME>/profiles/`, made by copying the harness's `engine/rlm_engine/profiles/training-v4/profile.toml` and replacing the one `pace_nudge = true` line with `false` (D-34 forbids reusing the built-in name; the pace flag is not in the prompt hash, so its `prompt_hash` still equals `training_hash`: check it in `engine.info`).
5. [ ] **Rebuild each candidate's context, then check it.** Recompute `sha256(context.encode("utf-8", "replace"))` and `len(context)`; they must equal `context_sha256` and `context_chars`, else skip with `context_not_rebuildable`.
   - **Read, `split == "val"`:** `rlm_rl.evals.eval_set(record["eval"])` (`selection-v4`), find the task with the same `task_id`, using the seeds in `private\seeds\`. Training-split read tasks use fresh random seeds that were never recorded, so they can't be rebuilt: skip them as `seed_not_recorded`.
   - **Edit, any split:** for `train`, the `task_id` is the pool record's own id. Find it in `rlm_rl.tasks.generator(family).records("train")` and call `generator(family).POOL.to_task(record, family)` (`edit_real*`: `editreal.to_task`). For `val`, use `generator(family).eval_tasks(split_of(family), family)` and match `task_id`.
   - Check `bridge.initial_messages(task.question, task.context, "v4", limits, edit=task.edit or None)` equals `record["messages"][:2]`, else skip with `first_message_differs`.
6. [ ] **Select.** Walk the eligible list in a fixed order (sort by family, then `task_id`, then `episode_id`) until the quotas are met. Read: one `aggregation`, one `research_select`, and the eligible read episode with the most sub-calls (so an `llm_batch` is covered). Edit: one `edit_spec*` and one `edit_bugs*`, `language == "python"` first. `--episodes` pins ids instead. A skipped or replaced candidate is replaced by the next one. Fewer than asked: exit 2.
7. [ ] **Materialise an edit workspace natively**, in `--work-dir` (default `%TEMP%\rlm-parity`, short on purpose: MAX_PATH).
   - Run `task.workspace.build(folder)` on an empty folder. Never call `Workspace.ensure` or `materialize`: they need `fcntl` and `cp`.
   - Then `git init -q`, `git add -A`, `git commit -q --allow-empty --no-verify -m base` with `-c core.autocrlf=false -c core.safecrlf=false -c core.longpaths=true -c init.defaultBranch=main`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<os.devnull>`, author and committer `rlm <rlm@localhost>`, and both dates `2000-01-01T00:00:00+00:00` (training's `editbox.GIT_DATE`). The engine's run-start snapshot and `diff()` then work with no change.
   - Fidelity check: parse the `path  size` listing at the end of the task's `context`. At least 99% of the listed paths must exist with the listed byte size, else skip with `workspace_mismatch` (CRLF, symlinks or case-folding can't be reproduced on Windows). An exception from `build` is the same skip.
   - Delete the folder after the episode, with an `onerror` that clears the read-only bit on `.git` objects, and 3 retries for antivirus locks.
8. [ ] **Start the engine once for all episodes**: `uv run --project <harness>\engine python -X utf8 -m rlm_engine serve` (D-42), cwd `<harness>`, or `--engine-cmd`. Environment: `RLMH_HOME=<work-dir>\home`, and every variable matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH` removed (D-29). Pipes are binary and the script decodes UTF-8 itself. The reader is a thread that feeds an asyncio queue (as D-30 does for the engine); a lock serialises writes. Stderr goes to `<report dir>\engine-stderr.log`. Close stdin to stop it, wait 10 s, then `taskkill /F /T /PID`. Call `engine.info` first and check: `protocol == 1`, `training_hash` equals the literal in the script and `rlm_rl.bridge.PROMPT_HASHES["v4"]`, `training-v4` listed with `prompt_hash == training_hash`.
9. [ ] **Replay each episode, in order, one at a time** (D-35: the same engine must carry no state across runs).
   - `run.start`, read: `{mode:"read", question, inputs:[<utf-8 file holding the context, written with write_bytes>], …}`. One input means the exact text (D-10).
   - `run.start`, repo: `{mode:"repo", task: record["question"], repo_path, test_hint, language, n_files, context, …}`, taken from `task.edit` and `task.context` (D-07).
   - Common: `profile`, `root` and `sub` = `{provider:"parity", model:"recorded", thinking:null}`, `permission_mode` from the flag (default `accept-edits`, S-27), `call_format:"fenced"`, `interactive:true`, `tag:<episode_id>`, `batch:"parity"`, `log_dir:<report dir>\runlogs`.
   - **Root `model.complete` number k** (its `turn` must be k): answer `{text: turns[k-1].reply, tool_call:null, reasoning:null, finish_reason: turns[k-1].finish_reason, usage: zeros, served_model:"recorded", seconds:0}`. Past the last recorded turn: error -32001, kind `other`, and the verdict `extra_root_call`.
   - **Sub-call `model.complete`:** its `messages` must be one `user` message. Look the text up in a map from recorded prompt to a queue of records (exact match; duplicates are consumed in order, since concurrent `llm_batch` calls arrive in any order). A record with `error` is answered as -32001, kind `bad_request`, status 400, message = the error (the message inside training's `repr(SubcallError(msg))`, D-111). Otherwise `{text: output, …}`. **No recorded prompt matches:** answer -32001, kind `other` (the run stops with `infra_error`, D-06), and record `subcall_unmatched` with the prompt's length, its sha256 and the longest common prefix against the closest recorded prompt. Wait for `run.finished`, and fail the episode if recorded prompts remain unused.
   - **`approval.request`:** `{allow:true, remember_for_run:false}`, counted by kind. With `accept-edits`, writes inside the workspace don't ask, and with `bypass` none arrive.
10. [ ] **Compare** (below), classify every difference (below), write `report.json` and `report.md`, and with `--write-summary` the summary doc. Set the exit code.
11. [ ] Run it, read the report, and for each `unexplained` difference either fix the engine (add a test to the matching engine test file, rerun `uv run --project engine pytest engine/tests`) or, only if it fits the rule below, add a class to the script's `ACCEPTED` table. Repeat until exit 0. Run it twice on the final engine: the verdicts must be identical.
12. [ ] Write the summary, update progress.md (Hand-off), and tell Rishi the result. Don't commit either repo.

## The comparison

- **Every root request k** (the gate): `messages` must equal the recorded `messages[:2 + 2*(k-1)]` in length, in order, with exactly the keys `role` and `content`, and `content` equal as strings. Also `tools == []`, `max_tokens == limits.root_max_tokens`, `temperature == 1.0`, `thinking == "off"`.
- **Every sub-call request:** `temperature == 0.3`, `max_tokens == limits.subcall_max_tokens`, `thinking == (limits.subcall_thinking or "off")`, and `tools == []`.
- **Per cell** (to locate a difference): from `run.cell`, `code`, `error`, `observation` and `restarted` against `turns[i]`.
- **End:** `run.finished` has `turns == len(turns)`, `submitted` and `answer` equal, `subcalls == subcalls_used`. `run.started.limits` equals the recorded limits on their shared keys. `run.started.input` has `chars` and `sha256` equal to the record, and `lines` equal to `len(context.splitlines())`, as architecture.md §5.3 defines them.
- **Info only, not gated:** the run log record's `messages` against the recorded ones (as a prefix), and its `diff` against the recorded `diff`.
- A message that differs is reported once, at the first request where it differs, by index. A request counts as byte-for-byte only when none of its messages differ.

## Difference classes

`classify(recorded, got)` applies these masks to both texts. If the masked texts are equal, the difference belongs to every class whose mask changed something. If not, it is `unexplained` and fails the run.

| Class | Mask | Can the model notice? | Verdict |
|---|---|---|---|
| `timing` | `\d+(\.\d+)?\s?(ms\|s\|sec\|seconds)` replaced by `<T>`, which covers the times in pytest, unittest, go and cargo summary lines; pytest's `=` padding is normalised and the counts stay (D-112) | No. The same cell prints different times on two runs in training too, so no behaviour can depend on the value. | Accepted. |
| `python-version` | `3\.12\.\d+` becomes `3.12.x` | No. Docker had 3.12.15 and uv's 3.12 is another patch release. Patch releases keep the language the cells use, and the string shows only if a cell prints `sys.version`. | Accepted. |
| `traceback-path` | `File "(?!<repl>)[^"]+", line \d+` becomes `File "<F>", line <N>` | Only inside the last lines of a traceback of an error raised in a harness function. Training showed `/opt/rlm/repl_worker.py` and `/opt/rlm/repl_tools.py`. The file is not part of the task and the name doesn't change what was raised. | Accepted. Optional small fix: the worker shows training's two file names for its own frames. Training's line numbers can't be reproduced without copying the files verbatim, so the line part stays a known difference (step 4 says not to fake it). |
| `path-form` | native workspace root and scratch folder become `/work/repo` and `/scratch`; `\` becomes `/` inside them | Yes, if a cell prints `os.getcwd()` or an absolute path. Tools return relative paths, and `/work/repo/…` still works through the alias (3a). | Accepted only when the report shows it in cell-printed text and never in a tool's return value. |

Everything else is `unexplained`. Differences the first run will probably show, with the fix to try (all are in Windows-only behaviour and can be noticed):

| Seen as | Cause | Fix |
|---|---|---|
| non-ASCII text differs, or `open(p).read()` fails | Windows default encoding is cp1252, training ran `C.UTF-8` | the worker already runs with `-X utf8` (D-42; `-I` ignores `PYTHONUTF8`). If it still differs, find which call bypasses UTF-8 mode, fix it in `worker/manager.py` or `worker.py`, and add a case to `test_worker.py` |
| files differ by `\r`, or a huge `diff()` | `write_text` translates `\n` on Windows | tools write with `newline=""` or bytes (`worker/tools.py`), with a case in `test_tools.py` |
| `FileNotFoundError` on `/tmp/…` | no `/tmp` on Windows | the worker environment's `TMPDIR` is already the scratch folder; a hard-coded `/tmp` is an `unexplained` difference to report to Rishi, not hide |
| `command not found`, `No module named`, `is not recognized` | the PC lacks the repo's own toolchain or packages (the training images had them) | **Not a parity difference.** The episode is `replaced(toolchain)`: the script takes the next candidate and lists the replaced one in the report. |

## Report format

`report.md`, top to bottom:

1. Header lines, which the checks grep: `date`, `harness commit` (`git -C <harness> rev-parse HEAD`, plus `dirty` when it is), `RLM commit`, `engine` (version, `python` from `engine.info`), `OS`, `git`, `shell` kind, `permission mode`.
2. `episodes: N (read R, edit E)`, `requests compared: Y`, `byte-for-byte requests: X of Y`, `accepted differences: <class: count, …>`, `unexplained differences: Z`, `replaced: <id: reason, …>`, `skipped: <reason code: count, …>`, `verdict: PASS` or `FAIL`.
3. One table row per episode: id, family, mode, profile, turns, sub-calls, requests matched of total, sub-calls matched or unmatched, approvals by kind, verdict.
4. Per episode, per differing message: index, class, accepted or not, and a unified diff. These hold task text, so only this file has them.
5. A table of the classes seen, with the reason text from the script's `ACCEPTED` table.

`report.json` holds the same data. `--write-summary` writes `documentation/harness-parity-v0.md` from counters and class names only. It then checks that no episode's question and no first context line (first 60 characters) occurs in the summary text, prints `summary guard: ok`, and otherwise exits 2.

## Tests

`tests/test_harness_parity.py` (RLM repo, `unittest`, no engine, no network, no transcripts):

| Case | Asserts |
|---|---|
| `test_message_prefix_length` | request k is compared with `messages[:2 + 2*(k-1)]`; one changed character in one message fails that request only |
| `test_subcall_matching` | exact prompts match; duplicates are consumed in order, in any arrival order; an unknown prompt gives `subcall_unmatched` with a prefix length |
| `test_recorded_subcall_error` | a record with `error` becomes -32001, `bad_request`, 400 |
| `test_classify_timing_and_version` | texts equal after `<T>` and `3.12.x` masks land in those classes; a one-digit change in a non-time number is `unexplained` |
| `test_classify_traceback_keeps_repl_frames` | `File "<repl>", line 3` is never masked |
| `test_pace_table` | prod-v2 `train` step 1 is unknown, step 2 on, any prod-v2 `val` on, prod-v1 off, pace text in an off record aborts |
| `test_eligibility` | each reason code (`events`, `limits`, `system_prompt`, `seed_not_recorded`, …) rejects a synthetic record |
| `test_exit_codes` | PASS gives 0, one unexplained gives 1, `--strict` turns an accepted class into 1, missing episodes give 2 |
| `test_summary_guard` | a summary containing a question's first 60 characters is refused |

## Done when

- [ ] `.venv\Scripts\python.exe -m unittest tests.test_harness_parity -v` passes.
- [ ] `git -C F:\Personal\RLM\RLM check-ignore -v results/harness-parity/2026-10-28/report.md` prints the `results/harness-*/` rule.
- [ ] `.venv\Scripts\python.exe scripts\harness_parity.py --harness F:\Personal\RLM\rlm-harness --write-summary` exits 0 (`$LASTEXITCODE` in PowerShell). The report header says `episodes: 5 (read 3, edit 2)` and `unexplained differences: 0`, with `verdict: PASS` and `summary guard: ok`.
- [ ] Each of the Y - X requests that are not byte-for-byte is listed in the report with only accepted classes. The summary states `X of Y`, and notes that a `--strict` run exits 1 whenever X < Y.
- [ ] A second run gives the same verdicts and counts (only times and run ids differ).
- [ ] `git -C F:\Personal\RLM\RLM status --short` lists only `.gitignore`, `scripts/harness_parity.py`, `tests/test_harness_parity.py` and `documentation/harness-parity-v0.md` among the step's files, and nothing under `results/harness-parity/`.
- [ ] `git -C F:\Personal\RLM\rlm-harness status --short` lists no transcript, context, gold answer or report file, and `uv run --project engine pytest engine/tests` passes after any engine fix.
- [ ] Every fix and every accepted class is named in `documentation/harness-parity-v0.md`, each accepted class with its reason.

## Out of scope

- Native-format parity: training never saw the `python` tool, so nothing records what it should send. Step 9 tests that path with real models.
- Running the recorded replies against a real model, grading, or any score: step 9 and the RLM repo's own graders.
- Replaying training-split read episodes: their seeds were not recorded, so their contexts can't be rebuilt.
- Replaying warm-start, pilot or `system_extra` episodes, or episodes with blocked writes, restarts or timeouts.
- Changing the contract text, the profile hash or the tool behaviour for any reason except a difference found here. A fix needs a test, and a log line in progress.md if it touches architecture.md.
- A parity test in CI: transcripts and task data stay on the PC (S-19).

## Hand-off

- **Step 9** can rely on: the same code path, as `training-v4` with `fenced`, gives the trained LoRA training's bytes, up to the accepted classes. The summary doc lists the engine fixes made here, and the shell and Python the PC used.
- **Re-run the script** after any later change to `contract.py`, `callformat.py`, `profiles.py`, `loop.py`, or the worker, tools or bridge.
- **In progress.md**, row 8: `done`, the date, and `5 episodes, X of Y requests byte-for-byte, classes: …, fixes: …`. Log line: `<date> step 8 (<thread>): parity …; engine fixes …; RLM .gitignore gained results/harness-*/`.

## If a decision goes the other way

Every decision below was settled at step 1 (2026-10-30; [decisions.md](../decisions.md) S-22 to S-34). Each line names the pick and says what would change if Rishi reversed it. Picks that went the alternative way are already written into this spec.

- **2b, other config folder** (settled: `~/.rlm-harness/`, S-24): only the `RLMH_HOME` line in task 8 changes, to whatever variable `paths.ts` reads.
- **3a, real path in the text** (settled: keep `/work/repo`, S-25): the first message names the real folder, so `training-v4`'s repo text and hash change and edit episodes fail on that one line. Add an accepted class `repo-path-text` for it ("by decision 3a, on purpose; the model sees the path it works in"), compare edit first messages with the real path replaced by `/work/repo`, and skip the `prompt_hash == training_hash` check for repo mode only. Read episodes still must match exactly.
- **4a, always PowerShell or Git Bash required** (settled: Git Bash, else PowerShell, S-26): nothing in the script changes. Expect more `replaced(toolchain)` episodes from POSIX commands under PowerShell, and print the shell kind in the header.
- **6b, fenced text everywhere** (settled: native for API models, S-30): no change. Parity always sends `call_format: "fenced"`, so it holds under either pick.
