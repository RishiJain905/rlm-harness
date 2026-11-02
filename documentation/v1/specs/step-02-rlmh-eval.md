# Step 2. `rlmh eval`: run a set, grade it, report, compare

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0. Every test runs offline against `fake/scripted` and a fixture set |
| **Depends on** | none (the set format is pinned in architecture.md §6, so this step and step 1 build in parallel) |
| **Unblocks** | 5, 6, and through 6, 7 and 9 |
| **Parallel with** | 1, 3, 4 |
| **Decisions it uses** | S-19, S-44, S-46; D-169 (set folder), D-170 (pass, `f2p_share`, one replicate), D-172 (`bypass` in throwaway copies), D-176 (Python repo tasks in uv venvs), D-179 (ledger). From v0: D-15, D-17, D-26, D-28, D-40, D-62, D-121, D-133, D-165. New here: D-188 to D-193, D-196 to D-198 |

## Goal

`rlmh eval SET` runs one eval set (step 1's folder) through `rlmh`, then grades every run. Read answers are graded with training's own scoring rules. Repo tasks are graded by their hidden tests, in a throwaway work copy. The command writes a report that steps 5, 7, 8 and 10 compare.

Before anything is spent, it prints a priced estimate. It spends only with `--go`, and stops at `--max-usd`. `--rerun OUT` reruns the tasks a transient infra error stopped. `eval compare` pairs two outputs task by task, and `eval ledger` keeps the running total against the $30 cap (S-44).

Everything v1 measures goes through this command. The tuner (step 6) and `/tune` (step 9) call its library functions, not the CLI.

## Read first

Read these whole, before writing code:

- [../architecture.md](../architecture.md):
  - §6 (all of it: the set folder, `tasks.jsonl`, `grades.jsonl`, running a set, commands and output, the estimate)
  - §9, §10, §11, §12
- [../../v0/architecture.md](../../v0/architecture.md):
  - §7.3 (gateway, `AppEvents`, `Usage`, `ModelInfo.price`)
  - §7.5 (the fake provider and its script)
  - §7.8 (`Session`, `rlmh batch`, the `--json` line shape, the run-log record)
  - §8, §9, §12
- [../../v0/decisions.md](../../v0/decisions.md): D-15, D-17, D-26, D-28, D-40, D-62, D-121, D-133, D-152, D-157, D-165, and S-44, S-46, D-169, D-170, D-172, D-176, D-179.
- This repo, whole files:
  - `app/src/cli/batch.ts`: the model for the runner. Copy its pool, its `RunWatcher` use, its Ctrl-C handling and its pre-flight-before-engine rule.
  - `app/src/cli/run.ts`: `CliIO`, `RunWatcher`, `modelFlags`, `onInterrupt`, `openFailed`, `message`.
  - `app/src/cli/print.ts`: `jsonLine`, `attachJson`, `attachPlain`.
  - `app/src/session.ts`: `StartRun`, `Session.open/start/cancel/close`, `buildRunParams`.
  - `app/src/main.ts`: the dispatch, `preflightBatch` then `engineReady` then the command.
  - `app/src/paths.ts`, `app/src/settings.ts`.
  - `app/src/engine.ts`: `stripKeys`, `KEY_LIKE`, `GIT_ENV_CONFIG`.
  - `app/src/gateway/gateway.ts`: `AppEvents` `call.start`/`call.end`, `totals`, and the OpenRouter `billedCost` path at about line 542.
  - `app/src/gateway/usage.ts`: `costOf`, `billedCost`, `hitRate`.
  - `app/src/gateway/catalog.ts`: `ModelInfo`, `Catalog`.
  - `app/src/gateway/fake.ts`.
  - `app/src/cli/setup.ts`: `findUv`, and how its `UvRunner` keeps the proxy env and CA bundle.
  - `app/test/cli/helpers.ts`, `app/test/cli/batch.test.ts`.
  - `engine/rlm_engine/permissions.py` (`decide`: what `bypass` allows).
  - `engine/rlm_engine/workspace.py` (`GIT_ARGS`: the git flags the harness uses on any repository).
  - `engine/rlm_engine/runlog.py` (`RECORD_KEYS`; `messages` is what the leak check reads).
  - `engine/rlm_engine/service.py` (`engine.info`), `engine/rlm_engine/profiles.py` (`Profile.read`/`.repo`, `agent_api`) and `contract.Limits`: what the estimate's ceiling reads.
  - `protocol/examples.json` and `app/src/protocol.ts` (`EngineInfo`), which gain the profile limits.
- RLM repo, read-only. On the PC use `git -C F:\Personal\RLM\RLM show origin/dev_rishi:<path>`. In a cloud container, clone it outside this repo as CLAUDE.md says. `reward.py` was last changed at `705ebcf`.
  - `rlm_rl/reward.py`, whole file. You port `parse_number`, `normalize_entity`, `_normalize_item`, `normalize_set`, `set_f1`, `check_grading`, `near_miss_credit`, `strip_id_labels`, `score_answer` and `score_count`, plus the constants they read.
  - `rlm_rl/grader.py`:
    - `TEST_DIRS`, `TEST_NAMES`, `TEST_CONFIGS`, `SECTIONED`, `INI_TEST_SECTIONS`, `TOML_TEST_SECTIONS`
    - `is_test_path`, `is_test_config`, `touches_test_config`
    - `_junit_cases`, `_merge`, `pytest_key`
    - `PYTEST_BOOT_TEMPLATE`, `Pytest.commands`, `Pytest.parse`, and `score` (how f2p and p2p decide "resolved", missing tests included)
  - `rlm_rl/editdata.py`: `leaks`.
  - `scripts/harness_smoke.py`: `estimate`, `ceiling_tokens`, `role_cost`, and `run_slot`'s cost cap.

## Starting state

- v0.2.0 at `9f0cedd` on `dev_rishi`. `rlmh batch` works on `fake/scripted`.
- There is no `app/src/eval/` and no `cli/eval.ts`, and `paths.ts` has no `evalDir`.
- uv is on the developer's machine. CI has uv through `astral-sh/setup-uv`, and `engine/.venv` (`uv run --project engine`) has pytest in its dev group.

## Deliverables

Every module opens with its cache note (`KV cache: none` for all of them). Code ported from training names `rlm_rl/<file>.py` and the RLM commit in a header comment.

| Path | What it holds |
|---|---|
| `app/src/eval/set.ts` | `loadSet(dir): EvalSet`, the types `Manifest`, `EvalTask`, `Grade`, and `selectTasks(set, {split, only, sample, seed}): EvalTask[]` |
| `app/src/eval/tar.ts` | `readTar(bytes): TarEntry[]` and `extractTar(bytes, dest)`, a small ustar reader (D-188). `.tar.gz` goes through `Bun.gunzipSync` first |
| `app/src/eval/work.ts` | `makeWorkCopy(set, task, dir): Promise<string>`, `ensureVenv(set, key, {home, uv}): Promise<Venv>` (`{python, purelib}`), `writeSrcPth(venv, copy)`, `removeSrcPth(venv)`, `fillHint(hint, python): string`, `revertTestPaths(dir): Promise<string[]>` |
| `app/src/eval/graders.ts` | `scoreAnswer(answer, gold, grading): {score, exact, components}` (training's `score_answer`); `gradeRepo(task, grade, {dir, python, set, logDir}): Promise<RepoGrade>` |
| `app/src/eval/junit.ts` | `parseJunit(xml): Map<string, "passed"\|"failed"\|"error"\|"skipped">` and `pytestKey(file, classname, name, base)`, ports of `_junit_cases`, `_merge` and `pytest_key` |
| `app/src/eval/estimate.ts` | `REFERENCE` (architecture §6.6's table), `referenceFrom(runLogs, set)`, `ceilingFor(limits, agentApi)`, `estimate(tasks, {root, sub, catalog, refs, profile}): Estimate` |
| `app/src/eval/report.ts` | `readGrades(out): Grade[]` (rerun lines win), `buildReport(lines): Report`, `renderReport(report): string`, `compare(a, b): Comparison`, `renderCompare(c): string`, `mcnemarExact(b, c): number` |
| `app/src/eval/ledger.ts` | `appendLedger(home, line)`, `readLedger(home)`, `LEDGER_CAP_USD = 30` |
| `app/src/eval/runner.ts` | `runEval(opts, deps): Promise<EvalResult>`: the pool, the cap, grading as each run finishes. `rlmh tune` (step 6) and `/tune` (step 9) call this |
| `app/src/cli/eval.ts` | `evalCommand(argv, io)`, `preflightEval(argv, io)`, and the subcommands `report`, `compare`, `ledger` |
| `app/src/main.ts` | `eval` in the dispatch: `preflightEval`, then `engineReady`, then `evalCommand`, as for `batch`. `report`, `compare` and `ledger` start no engine. `--help` gains the four lines |
| `app/src/paths.ts` | `evalDir(h) = <h>/eval` |
| `engine/rlm_engine/service.py`, `app/src/protocol.ts`, `protocol/examples.json` | `engine.info`'s profile entries gain `agent_api` and `limits: {read, repo}` (each `contract.Limits.as_dict()`), an added field, so `PROTOCOL_VERSION` stays (D-198). The engine test that checks `engine.info` checks them |
| `app/test/fixtures/evalset/` | The fixture set's text files and plain source trees (below) |
| `app/test/eval/fixture.ts` | `buildFixtureSet(tmp): string`: packs the trees into tars with a test-only ustar writer, writes `manifest.json` with the real hashes, and returns the set folder. No binary is committed |
| `app/test/eval/reward-vectors.json`, `junit-vectors.json` | Expected values produced by running training's functions (task 4) |

`runner.ts` is the shared entry point the tuner and `/tune` need (D-192).

**The fixture set** `harness-eval-fixture` holds four tasks, two per split:
- **`fx-read-R-01`** (tune): a count. `ctx/fx-read-R-01/log.txt` has five lines, the gold is 5, and `grading: {type: "count", blind: 0}`.
- **`fx-read-R-02`** (heldout): a list of ids, `{type: "list", item: "entity", blind: []}`.
- **`fx-repo-S-01`** (tune) and **`fx-repo-S-02`** (heldout): `src/fx-repo-S-0n/`, a one-module package `calc/` with a bug, at the repo root in S-01 (venv `fx`) and under `src/calc/` in S-02 (venv `fx-src`). Each has:
  - a visible `tests/test_basic.py`, whose test is in `p2p`;
  - a hidden `hidden-src/fx-repo-S-0n/tests/test_fix.py`, whose test is in `f2p`.

  Both run under pytest with only the standard library.
- **`venvs/fx.json`** is `{"python": "3.12", "requirements": ["pytest"], "import_root": "."}`, and **`venvs/fx-src.json`** the same with `"import_root": "src"`. Tests build both for real with `UV_OFFLINE=1`, from uv's cache, which holds pytest once the engine's dev group is installed. Nothing reaches PyPI.

## Tasks

1. [ ] **`set.ts`.** `loadSet(dir)` reads `manifest.json` (`format` must be 1), `tasks.jsonl` and `grades.jsonl`, and checks:
   - `validated` is true (step 1's `--no-validate` test builds write false; the fixture's manifest writes true);
   - `tasks_sha256` and `grades_sha256` over the files' bytes;
   - unique ids, matching `<set>-<family>-<size>-<nn>` for real sets (the fixture's `fx-` ids pass because the manifest's `name` starts with `harness-eval-fixture`);
   - one grade per task and one task per grade;
   - `kind` is `read` or `repo`; `split` is `tune` or `heldout`; `size` is `R` for read and `S`, `M` or `L` for repo;
   - every path is relative, inside the set folder, and exists;
   - every `venv` key has `venvs/<key>.json`, with `python`, `requirements` and `import_root` (`"."` or `"src"`; with `"src"`, the repo tar has a `src/` folder);
   - `permission_mode` is one of v0's three modes;
   - each read grade passes a port of `check_grading`;
   - `grader` is `answer` for read and `tests` for repo (D-189).

   All problems are listed together, and nothing starts. `selectTasks`:
   - filters by `split` (`all` keeps both), then `only`;
   - `sample K` with `seed S` takes K tasks stratified by `kind/size`: K × the stratum's share, largest remainders first. Within a stratum, take the K lowest `sha256(seed + ":" + id)`, so one seed always picks the same tasks on every OS;
   - returns tasks in file order.
2. [ ] **`tar.ts`** (D-188). A ustar reader over a `Uint8Array`:
   - **Entry types.** Regular files (`0`, `\0`) and directories (`5`). It applies pax `x` `path` records and GNU `L` long names, and skips `g`. It refuses any other type, symlinks and hard links included, with the entry name and type: step 1 resolves or drops links.
   - **Path checks.** It refuses absolute paths, drive letters, `..` parts and names that fold to the same path on a case-insensitive disk.
   - **Writing.** Bytes go out exactly as stored (CRLF kept), and the executable bit is set with `chmod` on POSIX.

   The point is the same result on all three OSes: Windows `tar.exe` (bsdtar) and Git Bash's GNU tar both exist on PCs, GNU tar reads `C:\…` as a remote host without `--force-local`, and they differ on modes and long names.
3. [ ] **`work.ts`.**
   - **`makeWorkCopy`** extracts `repos/<id>.tar` into `<home>/eval/work/<eval id>/<task id>/`, then commits it once:
     - `git init -q`, then `git add -A` and `git commit -q -m base --no-verify`;
     - with `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME=rlmh-eval`, `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL=eval@localhost` and `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE=2000-01-01T00:00:00+0000`;
     - on every call, workspace.py's `GIT_ARGS` equivalents plus `-c core.autocrlf=false -c commit.gpgsign=false -c init.defaultBranch=main`, and an env that has been through `stripKeys`.

     The base commit's hash is then the same on every machine for the same tar. A test checks that.
   - **`ensureVenv`**:
     - reuses `<home>/eval/venvs/<key>/` when its `.rlmh-venv.json` holds the sha256 of `venvs/<key>.json`;
     - otherwise runs `uv venv --python <python> <dir>`, then `uv pip install --python <interpreter> -r <tmp>/requirements.txt`, through `findUv` and setup's env rules. It then asks the interpreter for `sysconfig.get_path("purelib")` and writes the marker with the hash and `purelib`;
     - the interpreter is `Scripts/python.exe` on Windows and `bin/python` elsewhere.
   - **`writeSrcPth(venv, copy)`** (D-196), for a venv whose `import_root` is `"src"`, writes `<purelib>/rlmh-eval-src.pth` as one line, `import sys; sys.path.append("<copy>/src")`. The path is written with `/`, and every non-ASCII character as a `\u`/`\U` escape, because Python 3.12 reads `.pth` files in the locale encoding. A fixed name means a file a crashed eval left behind is overwritten. **`removeSrcPth`** deletes it, and does nothing when it is absent.
   - **`fillHint`** replaces `{python}` with the interpreter's absolute path, written with `/` (D-17), and double-quoted when it holds a space.
4. [ ] **Ported scorers, with vectors from training.**
   - **`scoreAnswer`** covers types `int`, `float`, `count`, `entity` and `list` (with `strip_id_labels`), with training's constants, rounding and `Score` fields (`score`, `exact`, `components`). Type `text` is refused at `loadSet` (D-189).
   - **JSON values map as Python's do.** A JSON number is a Python `int` or `float`, and `true` and `false` are `bool`, which `parse_number` and `normalize_entity` refuse. A float with an integer value prints as an int in `normalize_entity`.
   - **`pytestKey`, `parseJunit`** (including `_merge`'s rule for a test reported twice) and **`isTestPath`/`isTestConfig`** for Python port `grader.py`.
   - **The vectors.** Write about 60 `(answer, gold, grading)` inputs and about 25 `(file, classname, name, base)` inputs into a scratch script outside both repos. Run training's own functions over them in the RLM repo's venv, and commit only the inputs and the outputs as `reward-vectors.json` and `junit-vectors.json`, with a header naming the RLM commit. **Never type an expected value by hand** (CLAUDE.md).
5. [ ] **`gradeRepo`**, run in the work copy after `run.finished`:
   1. **`revertTestPaths`.** For every path `git diff --name-only -z base` and `git ls-files -z --others --exclude-standard` report, where `isTestPath` or `isTestConfig` holds, or `setup.cfg`/`pyproject.toml`/`tox.ini` changed a line inside a test section (`SECTIONED`): restore it from `base`, or delete it if it is new. It returns the paths, and `test_tamper = paths.length > 0` (D-190).
   2. **Hidden tests.** Extract `hidden/<id>.tar.gz` over the copy.
   3. **Run pytest**, with the command and flags step 1 validates its tasks with. The grade dir is `<out>/grade-logs/<id>/`: `<python> -c <PYTEST_BOOT for this copy> -p no:cacheprovider -o junit_family=xunit1 --junitxml=<grade dir>/junit.xml --tb=short -q <grade.files>`:
      - cwd is the copy, and the env has been through `stripKeys`, so a key in the app's environment never reaches code the model wrote;
      - kill the process tree after `timeout_s`;
      - stdout and stderr go to `<grade dir>/pytest.txt`.
   4. **Results.**
      - `resolved` is true when every f2p id is `passed` and no p2p id is `failed` or `error`. A missing id counts as training's `score` counts it.
      - `f2p_share` is f2p passed / f2p count.
      - A report that doesn't parse, or a timeout, gives `resolved: false` and `grade_error`.
   5. **`leak_suspect`** is true when the record's `messages` (read from `<out>/runs.jsonl` by `run_id`) contain the set folder's path (either separator, case-folded on Windows and macOS), `hidden/`, or the function name of any f2p id. It never changes `resolved`.
6. [ ] **`runner.ts`.** `runEval({set, tasks, root, sub, profile, callFormat, jobs, out, maxUsd, keep, logDir}, deps)`:
   - **`logDir`** is where the runs' `runs.jsonl` goes. It defaults to `out`; `/tune` (step 9) passes `<home>/runs/tune-<id>/`, so `/runs` lists its runs.
   - **`deps`** holds `{session?, uv?, now?}`, so tests can inject a recording uv and a fixed clock.
   - **The eval id** is `<manifest.name>-<split>-<YYYYMMDD-HHMMSS>`. It is also the `batch` name and the work folder (D-192).
   - **Preparation.** Make every venv the chosen tasks need, before the first run.
   - **The pool.** One `Session` for the whole eval, with `approvals` that always deny and `interactive: false`. For each task, `start({..., tag: task.id, batch, logDir})`:
     - read tasks pass `inputs` resolved against the set and `permissionMode: "accept-edits"`;
     - repo tasks pass `repoPath`, the filled `testHint` and `permissionMode: manifest.permission_mode` (D-172, D-191).
   - **`src` venvs** (D-196). For a task whose venv has `import_root: "src"`, `writeSrcPth` runs after `makeWorkCopy` and before `start`, and `removeSrcPth` runs after grading, in a `finally`, so a cancelled or failed run removes it too. The pool never runs two tasks that share such a venv at once: it starts the next task that doesn't wait on a busy one, and `--jobs` stays the upper bound. Tasks with `import_root: "."` need no file, because pytest's `-c` puts the copy's root on `sys.path`.
   - **Grading** happens per task, right after its `run.finished`. Each grade line is appended to `<out>/grades.jsonl` with architecture §6.5's keys. The work copy is removed afterwards unless `keep`.
   - **The cap** (D-193). A `CostCap` sums `usage.cost_usd` of every `call.end` on the session's bus, which is OpenRouter's billed cost when it reports one (D-121). Once the total passes `maxUsd`, no task starts and every running run is cancelled. Their lines get `infra_kind: "capped"`, and `eval.json` gets `capped: true`.
   - **Ctrl-C** works as in batch: the first cancels the running runs, the second quits. Exit 130.
7. [ ] **`estimate.ts`.**
   - **Reference tokens.** With `--tokens-from` run logs, it uses the mean `usage.root` and `usage.sub` (input, output and cache read) by `kind/size`, matching records to the set's tasks by `tag`. A stratum with no records falls back to `REFERENCE`.
   - **The profile's ceiling** (D-198). Each figure is capped at what the run's mode limits allow, from `engine.info`'s entry for `--profile` (read limits for read tasks, repo limits for repo tasks), with `harness_smoke.py`'s `ceiling_tokens` formula:
     - `per_turn = root_max_tokens + output_max_chars/3`;
     - root input `Σ_{t=1..max_turns} (4000 + (t-1)·per_turn)`, root output `max_turns · root_max_tokens`;
     - sub input `max_subcalls · subcall_max_chars/3`, sub output `max_subcalls · subcall_max_tokens`.

     The sub cap applies only when the profile's `agent_api` is off: a child run's root turns count as sub usage (D-160), so the sub ceiling would underprice `default`. This keeps `training-v4` (30 repo turns, 4,096 tokens) from being priced like `default` (150 turns).
   - **Price.** Root tokens at the root model's catalog price and sub tokens at the sub model's, with 80% of root input as cache reads when `price.cache_read > 0`.
   - **The cap.** The default `maxUsd` is twice the total.
   - **Unpriced models.** A model the catalog doesn't price (`costOf` gives 0) is printed as "unpriced", and `--go` then requires an explicit `--max-usd`.
   - **Venvs.** The estimate also lists the venvs it would create, since that downloads from PyPI.
8. [ ] **`report.ts`.**
   - **`readGrades(out)`** reads `<out>/grades.jsonl` and, when `<out>/rerun/grades.jsonl` exists, puts each rerun line in place of the original with the same id. `report`, `compare` and the tuner read grades only through it.
   - **`buildReport`** totals by `split`, `kind` and `size`, plus a total row: `n`, `passed`, `pass_rate`, `mean_score`, `mean_f2p_share` (repo only), `mean_turns`, `mean_subcalls`, `mean_compactions`, `cost_usd`, `mean_cost_usd`, `cache_hit` (cache reads over input), `mean_wall_s`, `infra`, `test_tamper` and `leak_suspect`. Infra runs count as not passed.
   - **`compare`** pairs the ids present in both outputs and prints how many were in one only, so step 5's all-split run compares with step 8's held-out run: `both`, `a_only`, `b_only`, `neither`; `mcnemarExact(a_only, b_only)`; the pass-rate difference; the mean `f2p_share` difference; and the cost ratio.
   - **`mcnemarExact(b, c)`** is two-sided: `min(1, 2 · Σ_{k=0}^{min(b,c)} C(b+c, k) / 2^(b+c))`, and 1 when `b + c = 0`.
   - **Every rendered comparison** ends with D-170's line: one replicate per task, so a held-out difference of a few tasks is within noise.
9. [ ] **`ledger.ts`.** On every `--go`, after the last grade, even when capped or interrupted, `runEval` appends one JSON line to `<home>/eval/ledger.jsonl`: `{date, what: "eval", set, split, root, profile, runs, cost_usd, out}`. `readLedger` skips torn lines, like `RunLog.records`.
10. [ ] **`cli/eval.ts`.** The usage and output:
    ```
    rlmh eval SET [--split tune|heldout|all] [--only ID,...] [--sample K --seed S] [--root P/M] [--sub P/M]
                  [--profile NAME] [--call-format F] [--jobs N] [--out DIR] [--tokens-from RUNS.jsonl]...
                  [--go] [--max-usd X] [--keep] [--json] [--verbose]
    rlmh eval SET --rerun OUT [--jobs N] [--go] [--max-usd X] [--keep] [--json]
    rlmh eval report OUT
    rlmh eval compare OUT_A OUT_B
    rlmh eval ledger
    ```
    - **Defaults:** `--split all`, `--jobs 4`, `--out <home>/eval/out/<eval id>/`.
    - **Pre-flight.** Before an engine starts, check the flags, `loadSet`, the selection, the models through `modelFlags` and `buildRunParams`, and that `--out` doesn't exist or is empty. Any problem returns 2.
    - **Without `--go`:** print the estimate, write nothing, start no run, exit 0. The engine starts only for `engine.info`, whose profile limits the ceiling needs.
    - **With `--go`:** write `eval.json` first (architecture §6.5's keys, plus `call_format`, `jobs`, and `harness_commit` when `git rev-parse HEAD` works in a source checkout), then run, then write `report.json` and `report.md`.
    - **`--rerun OUT`** (D-197) takes the split, models, profile and call format from `OUT/eval.json`, and reruns once the tasks in `OUT/grades.jsonl` whose `infra_kind` is transient: `rate_limit`, `server`, `timeout`, `network`, `worker`, `runlog` or `other`. Never `auth`, `no_key`, `bad_request`, `context_window`, `unknown_model`, `cancelled`, `capped`, `workspace` or `host_bug`: those are setup errors or the run's own limits, and a rerun only spends again.
      - The output is `OUT/rerun/`, an ordinary output folder whose `eval.json` adds `rerun_of`. It ends by rewriting `OUT/report.json` and `OUT/report.md` through `readGrades`.
      - Exit 2 before anything runs when `OUT/rerun/` is not empty (one rerun only), when the set's hashes or the profile's `profile_hash` differ from `OUT/eval.json`, or when no task qualifies.
      - Without `--go` it estimates the rerun, like any eval, and every `--go` adds its own ledger line.
    - **Plain output.** Progress goes to stderr through `attachPlain`. stdout gets one line per graded task, `id  kind/size  pass|fail|infra:<kind>  score  turns  $cost  seconds`, then a totals line.
    - **`--json` output.** stdout gets batch's lines (`run.*`, `gateway.call`), one `{"type":"eval.task", …grade line}` per task, and `{"type":"eval.finished", runs, passed, infra, cost_usd, capped, out}` last.
    - **Exit codes:** 0 when no run had an infra error and the cap wasn't hit, 1 otherwise, 2 for usage, 130 for Ctrl-C.
    - **`report OUT`** rebuilds `report.json` and `report.md` from `readGrades(OUT)`. **`compare A B`** prints `renderCompare`, and writes nothing. **`ledger`** prints each line and the total, as `$x of $30`. None of the three starts an engine.
11. [ ] **Docs.**
    - CLAUDE.md's commands table gains `rlmh eval` (estimate, `--go`, `compare`) and the one-test command for `test/eval`.
    - architecture.md already lists `eval/runner.ts` and `eval/tar.ts` (§2), `--tokens-from`, `--rerun`, the default `--out`, the `answer` grader and `eval.json`'s keys (§6.5), and the ceiling cap (§6.6). Check them against what you built and fix any drift. v0/architecture.md §7 gains the `engine.info` fields. Log each change in progress.md.

## Tests

Every test is offline. The fixture set is built into a temp folder by `buildFixtureSet`, and `RLMH_HOME` is a temp home. Tests that need Python let `ensureVenv` build the fixture's venvs with `UV_OFFLINE=1`, from uv's cache. They skip only when uv is missing, which never happens in CI.

- **`app/test/eval/set.test.ts`**:
  - the fixture loads;
  - each of these is reported, all in one call: a changed byte (hash mismatch), a duplicate id, a task without a grade, a path with `..`, `text` grading, `kind: "repo"` with `size: "R"`, and a missing venv file;
  - `selectTasks` with `--split`, `--only`, and `--sample 2 --seed a` twice gives the same ids, one per stratum.
- **`app/test/eval/tar.test.ts`**:
  - a round trip with the test writer keeps bytes (CRLF, a NUL byte, UTF-8 names) and the executable bit (POSIX);
  - a 150-character name works through pax and through GNU `L`;
  - it refuses `../x`, `/etc/x`, `C:x`, a symlink entry, and two names that differ only in case;
  - a `.tar.gz` round trip works.
- **`app/test/eval/graders.test.ts`**:
  - every line of `reward-vectors.json` gives training's `score` and `exact` (to 4 places);
  - `junit-vectors.json` gives `pytestKey`;
  - `parseJunit` handles a report with a failure, an error, a skip, and one test reported twice.
- **`app/test/eval/work.test.ts`**:
  - the work copy has one commit, `base`, whose hash is the same in two runs;
  - `git log --format=%an%ae%ad` is fixed, and the files are byte-identical to the tar;
  - `fillHint` writes `/` paths and quotes a path with a space;
  - `ensureVenv` with a recording fake uv calls `venv` then `pip install` once, and reuses the folder the second time;
  - `writeSrcPth` writes one line with `/` and escapes a non-ASCII path; `removeSrcPth` removes it and is quiet when it is gone.
- **`app/test/eval/grade.test.ts`**, real pytest on the fixture's repo tasks:
  - the base fails f2p, so `resolved: false` and `f2p_share 0`;
  - with the fix written, `resolved: true`;
  - a model edit to `tests/test_basic.py` that makes it pass trivially is reverted and gives `test_tamper: true`;
  - a new `conftest.py` is deleted and flagged;
  - a `pytest.py` in the copy doesn't replace the runner (PYTEST_BOOT);
  - a 1-second `timeout_s` on a sleeping test gives `grade_error`;
  - `fx-repo-S-02` (the `src` layout) imports the copy's `calc` through the `.pth`, and after grading the file is gone;
  - a key-like variable set in the test's env is absent inside the test (the hidden test prints `os.environ` keys to a file).
- **`app/test/eval/report.test.ts`**:
  - `mcnemarExact(0,5) = 0.0625`, `(1,6) = 0.125`, `(3,3) = 1`, `(0,0) = 1`;
  - `buildReport` totals on a hand-made `grades.jsonl`;
  - `compare` counts and the D-170 line;
  - `renderReport` is stable (a snapshot);
  - `readGrades` puts a rerun line in place of the original.
- **`app/test/eval/estimate.test.ts`**:
  - `REFERENCE` pricing for the two S-43 models from the bundled catalog;
  - `--tokens-from` means replace the reference by stratum;
  - an unpriced model makes `--go` need `--max-usd`;
  - `ceilingFor` with `training-v4`'s repo limits equals a hand calculation and caps an M/L reference figure, and with `agent_api` on the sub figure is not capped.
- **`app/test/eval/cap.test.ts`**: `CostCap` on a bare `Bus`: `call.end` events summing past the cap call the cancel function for each running run exactly once and stop new starts.
- **`app/test/cli/eval.test.ts`**, the real engine with `fake/scripted` and `RLMH_FAKE_SCRIPT`:
  - **The script.** One root entry, a tool call whose code branches on the task: in `fx-repo-S-01` it writes the fix; in `fx-repo-S-02` it changes nothing; in read mode it submits `len(context.splitlines())`. Then it calls `submit('done')` or the count.
  - **`--go --json --jobs 2`:**
    - `eval.task` lines show S-01 resolved, S-02 not, and R-01 passed (5) and R-02 not;
    - `eval.finished` is last;
    - `grades.jsonl`, `report.json`, `report.md`, `eval.json` and `runs.jsonl` exist;
    - the ledger has one line with `cost_usd: 0`;
    - no work copy is left;
    - exit 0.
  - **Without `--go`:** the estimate prints, no `out` folder appears, exit 0.
  - **Exit 2** before any engine starts for: a bad set, `--out` not empty, and `--sample` without `--seed`.
  - **`--jobs 2` with two `src`-layout tasks on one venv** never runs them at once (a stub `start` records the overlap).
  - **`--rerun`.** After a `--go`, the test rewrites two lines of `OUT/grades.jsonl` to `infra_kind` `server` and `auth` (fake errors are counted per run, so they can't pick one task). `--rerun OUT --go` reruns only the `server` task into `OUT/rerun/`, `OUT/report.json` counts its rerun line, a second `--rerun` exits 2, and the ledger has two lines.
  - **`eval compare`** of two outputs prints the pair counts; **`eval ledger`** prints the total.

## Done when

- The full verify gate passes (`bash scripts/verify.sh` or `scripts\verify.ps1`), including the new `test/eval` and `test/cli/eval.test.ts`.
- CI is green on macOS, Windows and Linux; the tar, git and pytest tests are the Windows-sensitive ones.
- On Rishi's PC, in `app/`: `..\.bun\bin\bun.exe test test/eval test/cli/eval.test.ts` passes.
- In a temp home, `rlmh eval <a fixture set built by buildFixtureSet> --root fake/scripted` prints an estimate of $0.00 and exits 0.
- The two vectors files carry the RLM commit they were produced from, and the progress log names the scratch script's command, never its outputs typed in.

## Out of scope

- Building the real set (step 1), and running it on a real model (step 5).
- Repeats per task, and runners other than pytest (D-176: Python only).
- Grading free-text answers (`text`), which no v1 read family uses.
- The tuner and `/tune` (steps 6 and 9), which call `runEval`, `loadSet`, `selectTasks` and `compare`.
- Any sandbox. `bypass` is not one (CLAUDE.md), so evals run only on a developer's machine, in throwaway copies.

## Hand-off

- **Steps 5, 7, 8 and 10 rely on** `rlmh eval SET --split … --profile … --root … --go --max-usd … --out …`, `--rerun OUT`, `eval compare` and `eval ledger`, and on the output layout of architecture §6.5.
- **Step 6 relies on** `runEval`, `loadSet`, `selectTasks` (`--sample/--seed` is its probe subset), `readGrades`, `compare`, `buildReport` and `CostCap`. **The tuner never reads `grades.jsonl` or `grade-logs/`**, apart from pass counts for acceptance (architecture §7.3).
- **Step 1 relies on** `loadSet`'s checks, which are the definition of a valid set; step 1's `check` covers the same ground in Python. The first `rlmh eval` on the real set is step 5's estimate.
- **progress.md row 2:** set `review`, with the date, the CI run, and the commands that produced the two vectors files.

## If a decision goes the other way

- **D-172, allow only the test command instead of `bypass`.**
  - `permissions.py`: `Permissions.__init__` takes `allow_commands: list[str]`, and `decide()` returns `allow` for kind `shell` (and `subprocess`) when the detail, whitespace-collapsed, equals one of them, before the mode rules. The model can then run exactly the task's test command and nothing else (no `python -c`, no single test file).
  - The wire: `run.start` gains `allow_commands` (`protocol.ts`, `service.py`'s checks, `protocol/examples.json`, `RunSpec`), and `loop.py` passes it on.
  - Here: `runEval` sends `[filled test_hint]` with `accept-edits`, and the manifest's `permission_mode` must then be `accept-edits`.
  - The cost: the model can't run a narrower test or a quick script, so long-running coding tasks get harder and measure the permission rule as much as the profile.
- **D-170, repeats.** `runEval` takes `repeats: n`; `tag` becomes `<id>#<k>`; grade lines carry `repeat`; `buildReport` averages per task before totalling, and `compare` uses the per-task majority. Each extra repeat costs one more full pass against S-44.
- **D-176, more languages.** `grades.jsonl`'s `runner` takes `go` or `jest`; `gradeRepo` grows a runner table like `RUNNER_CLASSES`, and `ensureVenv` becomes a per-language toolchain check. Nothing in the set or report format changes.
