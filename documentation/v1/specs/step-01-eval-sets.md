# Step 1. Eval sets: about 48 tasks, mostly coding

| | |
|---|---|
| **Type** | PC (RLM repo; a Remote Control session on Rishi's PC, because the edit data lives only on `D:`) |
| **Cost** | $0. No model calls. Venv resolution touches PyPI, and the optional image fallback runs Docker locally |
| **Depends on** | none |
| **Unblocks** | 5, and through it 7, 8 and 10 |
| **Parallel with** | 2, 3 |
| **Decisions it uses** | S-19, S-44, S-46, D-169, D-170, D-172, D-176, D-180 (repo-disjoint splits), D-181 (L tasks carry `REQUIREMENTS.md`), D-183 (native validation rule), D-184 (pytest node ids from JUnit xunit1), D-185 (`import_root` for src layouts) |

## Goal

`scripts/harness_evalset.py` in the RLM repo builds the eval set `harness-eval-v1`: 48 tasks in the folder layout of [../architecture.md §6.1](../architecture.md#61-the-set-folder). There are 38 repo-mode Python tasks (14 S, 14 M, 10 L) and 10 read-mode tasks, split 24/24 between `tune` and `heldout` (D-176). Every repo task is validated natively on Rishi's PC, so `rlmh eval` (step 2) can grade it with nothing but a uv venv and pytest. The set lives in `RLM_DATA_DIR`, never in either repo. Step 5 runs the baseline on it.

## Read first

- [../architecture.md](../architecture.md) §6 (all of it: §6.1 to §6.3 are the contract this step writes, §6.4 is how step 2 grades it, so validation here must do the same) and §11. [../README.md](../README.md).
- [../../v0/decisions.md](../../v0/decisions.md): S-19, S-44, S-46, and D-168 to D-179.
- [../../v0/specs/step-09-smoke-run.md](../../v0/specs/step-09-smoke-run.md): the house style for RLM-repo scripts (`check_ignored`, `guard`, task files written as bytes, the no-task-text summary).
- RLM repo, branch `dev_rishi` (`git -C F:\Personal\RLM\RLM show origin/dev_rishi:<path>`, or the working tree), read whole:
  - `rlm_rl/tasks/__init__.py`: `GENERATORS`, `make_task`, `private_seed_list`, `fixed_set`, `PoolEmpty`.
  - `rlm_rl/tasks/editreal.py`: `level_of`, `records`, `_build_workspace`, `_context`, `to_task`, `PERMISSIVE`.
  - `rlm_rl/tasks/editspec.py`: `Pool`, `LEVELS`, `MIN_BODY`/`MAX_BODY`, `analyze`, `map_profile`, `eligible`, `graph`, `grow`, `spec_clusters`, `whole_module`, `stub_text`, `test_files_of`, `requirements`.
  - `rlm_rl/tasks/editbugs.py`: `LEVELS`, `FAMILIES`, the pool and its records.
  - `rlm_rl/tasks/aggregation.py` (the docstring, `make_task`, `HELDOUT`) and `rlm_rl/tasks/synthcode.py` (`LEVELS`, `make_task`, the callgraph and needle builders).
  - `rlm_rl/editdata.py`: `edit_path`, `patch_size`, `leaks`, `read_json`, `write_json`, `grader_cap`, `CAP_FACTOR`, `classify_licence`.
  - `rlm_rl/grader.py`: `TestSpec`, `parse_patch`, `is_test_path`, `pytest_key`, `PYTEST_BOOT_TEMPLATE`, `safe_path`, `_safe_apply`.
  - `rlm_rl/reward.py`: `score_answer`, `check_grading` (which `grading["type"]` values exist).
  - `rlm_rl/data.py`: `root`, `path`, `available`, `DATA_ENV`.
  - `rlm_rl/editbox.py`: `git`, `git_env`, `GIT_DATE`, `_commit_base`.
  - `scripts/build_edit_tasks_v2.py`, whole: `REPOS`, `KEEP`, `MAX_HIDDEN_FILES`, `registry`, `snapshot_texts`, `test_files`, `load_profile`, `repo_limits`, `Context`, `file_patch`, `base_record`, `changed_texts`, `stage_spec`. The L family reuses this machinery.
  - `scripts/build_edit_data.py`: `cmd_index` and the record format it writes (`edit/index.json`).
  - `scripts/harness_smoke.py`: `check_ignored`, `rlm_commit`, `guard`, `write_task_files`, `check_task_files`.
  - `.gitignore`: `private/` and `results/harness-*/`.
- On `D:` (read only): `edit/index.json`, `edit/v2/spec_index.json`, `edit/v2/bugs_index.json`, `edit/repos.json`, `edit/v2/profile/<key>.json` for the nine `REPOS`, `edit/repos/<key>.tar`.

## Starting state

- The RLM repo is on `dev_rishi` (`d83e71a` or later). Its Windows `.venv` imports `rlm_rl.tasks`, and `RLM_DATA_DIR` (default `D:\RLM-data`) holds the edit data above and the HuffPost headlines (`hf/heegyu__news-category-dataset/data.json`).
- `uv` is on PATH (`uv --version`). Git for Windows is installed. Docker is optional (only the venv fallback uses it, directly or as `wsl -d Ubuntu docker`).
- No `harness-eval` folder exists under `RLM_DATA_DIR`, and no `private/seeds/harness-eval-v1-*.json`.

## Deliverables

All in the RLM repo unless marked. Nothing in rlm-harness changes, except this step's row and log line in `documentation/v0/progress.md`.

| Path | What it is |
|---|---|
| `scripts/harness_evalset.py` | The builder and checker. Imports `rlm_rl` and `scripts/build_edit_tasks_v2.py` (by putting `scripts/` on `sys.path`), and nothing from rlm-harness. Changes no file under `rlm_rl/` |
| `tests/test_harness_evalset.py` | Offline unittest tests (below) |
| `documentation/harness-eval-v1.md` | The summary: counts, ids, sizes, families, gold sizes and test timings. Never task text, gold, test names or diffs |
| `RLM_DATA_DIR\harness-eval\harness-eval-v1\` | The set, in §6.1's layout. Outside both repos |
| `RLM_DATA_DIR\harness-eval\build\harness-eval-v1\` | The build cache: candidates, gold patches, build venvs, validation results, so a rerun resumes. Never read by `rlmh` |
| `private/seeds/harness-eval-v1-read.json`, `private/seeds/harness-eval-v1-repo.json` | Seeds, drawn once by `private_seed_list`. Git-ignored |

**CLI** (`.venv\Scripts\python.exe scripts\harness_evalset.py …`, from the RLM repo root):

| Command | Does |
|---|---|
| `build [--only R,S,M,L] [--jobs N] [--no-validate] [--force]` | Candidates, venvs, native validation, assembly, manifest. Resumes from the build cache. `--no-validate` is for tests only and writes `validated: false` into the manifest. `--force` replaces an existing set folder; without it, an existing set exits 2 |
| `check` | Offline, $0: layout, hashes, ids, leaks, tar safety. Exit 0, or 1 with every problem listed |
| `summary` | Writes `documentation/harness-eval-v1.md` from the set and the build cache |

`--set NAME` (default `harness-eval-v1`) and `--data DIR` (default `data.root()`) apply to all three. The set folder must resolve outside both git work trees (the RLM repo, and `--harness`, default `..\rlm-harness`), or the script exits 2. Task data never enters git.

**The plan (D-176).**

```python
SET = "harness-eval-v1"
READ_PLAN = {("aggregation_heldout", 1): 2, ("aggregation_heldout", 2): 2, ("aggregation_heldout", 3): 2,
             ("callgraph_heldout", 2): 2, ("needle_heldout", 3): 2}             # 10, size "R"
REPO_PLAN = {"S": 14, "M": 14, "L": 10}                                          # 38
SPLIT_REPOS = {"tune": ("andialbrecht__sqlparse.e57923b3", "pallets__jinja.ada0a9a6", "arrow-py__arrow.1d70d009",
                        "tkrajina__gpxpy.09fc46b3", "mahmoud__glom.fb3c4e76"),
               "heldout": ("marshmallow-code__marshmallow.9716fc62", "seperman__deepdiff.ed252022",
                           "lepture__mistune.bf54ef67", "pyparsing__pyparsing.533adf47")}   # D-180
```

Each `(family, level)` pair in the read plan gives one task to each split. Repo cells are split × size, and each split gets half: S 7/7, M 7/7, L 5/5.

**Where repo tasks come from** (Python only, `language == "python"`, licence in `editreal.PERMISSIVE`):

| Size | Families and levels | Extra rule |
|---|---|---|
| S | `edit_real` (all splits) and `edit_bugs` (all splits), levels 1–2 | `gold_files == 1` |
| M | `edit_spec`, `edit_bugs`, `edit_real`, levels 3–5 | `gold_files >= 2` |
| L | `edit_large`, new here (below) | at least 4 files and 300 gold lines |

- **Repository-disjoint splits (D-180).** Every task's repository belongs to exactly one split. The nine `edit_v2` repositories are fixed as in `SPLIT_REPOS`. Any other `edit_real` Python repository is assigned, in sorted order, to the split with fewer S and M candidates so far. A repository never contributes more than 2 tasks to one cell.
- **Drawing within a cell.** Go round-robin over the cell's families in table order, taking a seeded shuffle (`random.Random(f"{seed}-{cell}")`, with the seed from `private_seed_list("harness-eval-v1-repo", 1)`) and skipping candidates that fail validation, until the cell is full. A cell that can't fill stops the build with a report of which cell is short and by how many. Rishi then decides: allow 3 tasks per repository, or accept a smaller set. That decision is logged as a D-number.
- **The `edit_large` family (D-181).** It is built in this script from `build_edit_tasks_v2.Context(key, entry)` for each `REPOS` key, which reads the existing `edit/v2/profile/<key>.json`, so no Docker lab is needed:
  1. `cand = editspec.eligible(ctx.repo, ctx.tests_of, ctx.at_import)`, grouped by module path. Modules with at least 3 candidate functions qualify.
  2. Seed a module with the cell's RNG. Grow the set by adding the qualifying module with the most static edges to the set (`editspec.graph(...)[0]`, summed across modules); break ties by path. Stop at 8 modules, or once there are at least 4 modules and at least 300 body lines. Drop the cluster if it ends with fewer than 4 modules, fewer than 300 or more than 1,200 body lines, more than 16 hidden test files (`editspec.test_files_of`), or no documented function.
  3. The cluster is every candidate function in those modules. Stub them with `build_edit_tasks_v2.changed_texts(ctx, by_file, editspec.stub_text)`, and build the record with `base_record(ctx, "large", "L", ident, …)`. Set `split`, `kind = "large"` and `generator = "evalset-large-v1"` on the copy afterwards.
  4. The requirements document (`editspec.requirements(entry["repo"], ctx.repo, cluster)`) is written as `REQUIREMENTS.md` at the base snapshot's root. The task text is exactly:

     > Every function and method listed in REQUIREMENTS.md, at the root of this repository, has had its body replaced by `raise NotImplementedError`. Their signatures and docstrings are unchanged. Implement all of them so the package behaves as REQUIREMENTS.md and the docstrings describe, and keep the repository's other tests passing.

  5. At most 2 L clusters come from one repository, and no two share a module.
- **Read tasks.** `tasks.fixed_set("harness-eval-v1-read", READ_PLAN)`, re-identified as `<set>-<family>-R-<nn>`. Step 2 grades read tasks with one `answer` grader that ports `score_answer` for `int`, `float`, `count`, `entity` and `list`, and refuses `text` (its D-189). The three families fit: at `0b9af69`, aggregation grades as `int`, `count`, `entity` or `list`, callgraph as `list` and needle as `entity`. As a guard, a task whose `grading["type"]` is anything else is replaced by the next seed, drawn with `tasks.new_seed()` and appended to the private seed file; after 20 draws without one, the build stops and names the family. The first task of each pair goes to `tune`, the second to `heldout`.

**Files written** (all bytes, LF, never through text mode):
- `tasks.jsonl` and `grades.jsonl`, as in §6.2 and §6.3.
  - Repo `task` is the record's `issue` (S, M) or the L template above.
  - `test_hint` is `"{python} -m pytest -q"`.
  - A read grade line is exactly `{"id", "grader": "answer", "gold", "grading"}`, where `grading` is the RLM task's own grading fields. A repo grade line is §6.3's `{"id", "grader": "tests", ...}`, with no other keys.
  - Where each task came from (`family`, `record_id`, `repo`, `level`) goes to the build cache's `sources.jsonl`, never into the set. `summary` reads it from there.
- `repos/<id>.tar`: `editreal._build_workspace(record, folder)` plus `REQUIREMENTS.md` for L, tarred with members sorted, `mtime = 0`, `uid = gid = 0`, `uname = gname = ""`, and no `.git`, so the same inputs give the same bytes.
- `hidden/<id>.tar.gz`: the record's `tests.hidden` files (for L, the scope files' texts from `ctx.texts`), with the same normalisation, gzipped with `mtime=0`.
- `ctx/<id>/context.txt`: `task.context.encode("utf-8")`.
- `venvs/<key>.json`: `{"python": "3.12", "requirements": [...], "import_root": "." | "src"}` (D-185). `import_root` is `"src"` when the package's import directory is under `src/`.
- `manifest.json`: `{"format": 1, "name", "created", "builder": {"repo": "RishiJain905/rlm", "commit", "dirty"}, "permission_mode": "bypass", "validated": true, "counts": {"<split>/<kind>/<size>": n}, "tasks_sha256", "grades_sha256"}` (D-172 for the mode).

**Venvs.** For each repository key used:
- **Resolve.** With uv's `--exclude-newer` set to the commit's date (from `edit/repos.json`, or the SWE-smith row; when neither holds it, the newest mtime in the snapshot, logged as approximate), install into a build venv, in order:
  - the snapshot's test dependencies: the extras named `test`, `tests`, `testing` or `dev` in `pyproject.toml`/`setup.cfg`/`setup.py`, then `requirements*test*.txt`, `requirements-dev.txt` and `tox.ini`'s `[testenv] deps`;
  - pytest, if it isn't there yet;
  - the snapshot's own runtime dependencies, never the package itself.
- **Freeze.** Freeze the result with `uv pip freeze --python <venv>`, dropping the package's own line.
- **Python version.** Try Python `3.12`, then `3.11`, then `3.10`, and keep the first under which every task of that repository that is drawn passes its gold check.
- **Fallback.** If resolution fails and Docker answers, freeze the image instead: `docker run --rm <entry tag> python -m pip freeze`. Log which way each key went.
- **The `.pth` line.** Build venvs live in the build cache. Each gets a `.pth` file in its site-packages, holding one line that puts `<cwd>/src` on `sys.path` when `import_root` is `"src"`. `rlmh eval` writes the same `.pth` (step 2).

**Native validation (D-183, D-184).** For each candidate, on the PC, with the build venv. Every pytest run is `<python> -c <grader.PYTEST_BOOT_TEMPLATE filled for the work folder> -p no:cacheprovider -o junit_family=xunit1 --junitxml=<tmp>/junit.xml --tb=short -q <scope files>` in the work folder, which is exactly step 2's grading command (its task 5). Test ids are `grader.pytest_key(file, classname, name)` from the JUnit report.
1. **Base:** extract `repos/<id>.tar` and restore the hidden files. Every f2p test must fail or be missing.
2. **Gold, three times:** extract, `git apply` the gold patch (and remove `REQUIREMENTS.md` for L), then restore the hidden files.
   - Every f2p test must pass all three times, or the task is dropped.
   - A p2p test that doesn't pass all three times is removed from `p2p`, and the task is dropped if more than 10% of its p2p tests go.
   - `timeout_s = max(120, editdata.CAP_FACTOR × the slowest gold run)`.
3. **Visible collection:** the base without the hidden files. `pytest --collect-only -q -p no:cacheprovider` must exit 0 or 5.
4. **L only:** every stubbed function must be run by at least one surviving f2p test (`ctx.tests_of`), or the task is dropped.
5. **Leaks:** `editdata.leaks(task_text, gold_patch, f2p + p2p)` must be empty. A read task's question must not contain its gold as a string of 4 or more characters.

The results go to the build cache, one line per candidate: `{id, record_id, kept, why, f2p, p2p, dropped_p2p, gold_seconds, python}`.

## Tasks

1. [ ] Set row 1 of the v1 table in progress.md to `in progress`. Rishi OK'd on 2026-11-02 that this step creates its script, its test and its summary in the RLM repo on `dev_rishi`. Anything else there, and every commit or push there, still needs his OK (CLAUDE.md, "The RLM repo is outside this repo").
2. [ ] Check that `git -C F:\Personal\RLM\RLM check-ignore -v private/seeds/harness-eval-v1-read.json` prints `private/`. The set folder is outside the repo, so it needs no rule.
3. [ ] Write the plan constants, the CLI and the outside-the-repo guard.
4. [ ] Write the read builder and the files it writes. Test with `--only R --no-validate`.
5. [ ] Write the S and M candidate readers over the three indexes, with the Python, licence, level and file-count filters and the repository-to-split assignment.
6. [ ] Write the `edit_large` builder (above). Print each repository's L clusters (modules, functions, body lines, hidden files) before validating anything.
7. [ ] Write the venv resolver and freezer, with the Python-version ladder and the Docker fallback.
8. [ ] Write native validation exactly as above. Run it with `--jobs` processes (default 4), each in its own temp folder under the build cache. On Windows, remove folders with read-only bits cleared (as v0's `_rmtree` does).
9. [ ] Write the assembly, the manifest and `check`. `check` lists every problem:
   - an id in one of `tasks.jsonl`/`grades.jsonl` but not the other;
   - a missing file;
   - a hash mismatch;
   - an id outside `^harness-eval-v1-[a-z_]+-(R|S|M|L)-\d{2}$`;
   - a tar member that `grader.safe_path` refuses, or any `.git`;
   - a hidden file present in a base tar;
   - a `gold` string or test name in `tasks.jsonl`;
   - counts that differ from the plan.
10. [ ] Write `tests/test_harness_evalset.py` and make it pass.
11. [ ] Run `build` on the PC. Post the counts in chat: candidates per cell, kept, dropped with the top reasons, venvs by method and Python, gold test seconds (median and max), and set size on disk. A short cell stops here for Rishi's call.
12. [ ] Run `check` (exit 0), then `summary`.
13. [ ] Run `build` again with no changes. It must resume from the cache and give byte-identical `tasks.jsonl`, `grades.jsonl` and tars, so the same hashes.
14. [ ] Update progress.md (Hand-off). Commit nothing until Rishi says so, in either repo.

## Tests

`tests/test_harness_evalset.py` (`python -m unittest -v tests.test_harness_evalset`). The fixtures are built in a temp folder: a fake data root holding a tiny edit index and snapshot tars made by the test. Cases that run pytest need `uv` and skip without it. No case reads `D:`, makes a model call, or reads a key.

| Case | Asserts |
|---|---|
| `test_plan` | The read plan gives 10 tasks; the repo plan sums to 38; each cell halves into equal splits; 48 in all |
| `test_ids_reveal_nothing` | Ids match the `check` regex and contain no record id, repository name, seed or level number beyond the size letter |
| `test_tasks_jsonl_keys` | Read lines hold exactly `id, kind, split, size, family, question, input`; repo lines exactly `id, kind, split, size, family, task, base, venv, test_hint`. Read grade lines hold exactly `id, grader, gold, grading`, with `grader` `"answer"`. No gold or f2p name appears in `tasks.jsonl` |
| `test_repo_disjoint` | Over a fake index of six repositories, no repository is in both splits, and none has more than 2 tasks in a cell |
| `test_large_cluster` | `editspec.analyze` over six synthetic modules with enough documented, covered functions gives a cluster of ≥ 4 modules and ≥ 300 body lines. Three modules give `None` |
| `test_large_task_text` | The L task text equals the pinned template, and `REQUIREMENTS.md` is in the base tar and absent after the gold patch |
| `test_tar_deterministic` | Two builds give byte-identical tars, with no `.git` and no hidden file in the base tar |
| `test_validation_keeps_good` (uv) | A tiny package with a stubbed function: the base fails its f2p test, gold passes it three times, and the task is kept with `timeout_s >= 120` |
| `test_validation_drops_bad` (uv) | Gold that fails one f2p test is dropped with the reason. A flaky p2p (fails on the second run) is removed from `p2p`. Losing more than 10% of p2p drops the task |
| `test_src_layout` (uv) | A `src/`-layout package gets `import_root: "src"`, and with the `.pth` its tests import it from the work copy, not from site-packages |
| `test_leaks` | An issue quoting a 30-character gold line, or naming a hidden test, is dropped |
| `test_check_detects` | `check` exits 0 on a fresh build, and 1 after each of: a tampered `grades.jsonl` byte, a removed tar, a gold string inserted into `tasks.jsonl`, and a `.git` member |
| `test_outside_repo_guard` | `--data` inside the RLM repo or the harness checkout exits 2 |
| `test_bytes_lf` | Context files are byte-equal to `context.encode()`, with no `\r` anywhere in the written text files |
| `test_summary_no_text` | With sentinel strings as issue, question, gold and test names, none appears in the summary |

## Done when

- `.venv\Scripts\python.exe -m unittest -v tests.test_harness_evalset` passes on Rishi's PC.
- `build` finished, and `check` exits 0 on `D:\RLM-data\harness-eval\harness-eval-v1\`. Its `manifest.json` counts are 48 tasks: `tune` and `heldout` each have R 5, S 7, M 7, L 5. Any other count must have Rishi's OK, recorded as a D-number.
- Every repo task passed native validation on Windows, and every L task has at least 4 changed files and at least 300 gold lines (from the build cache).
- A second `build` reproduced the same `tasks_sha256` and `grades_sha256`.
- `documentation/harness-eval-v1.md` exists and holds no task text. `git -C F:\Personal\RLM\RLM status --short` shows only the script, the test and the summary.

## Out of scope

- `rlmh eval` itself (step 2). Running any model on the set (step 5).
- Go, JavaScript and other languages (D-176). Partial-credit rewards for training. Any change under `rlm_rl/`.
- Linux validation. The set is validated on Windows, where steps 5, 7, 8 and 10 run it. A Linux run needs the folder copied, and a check there first.

## Hand-off

- Step 5 can rely on:
  - the set folder at `D:\RLM-data\harness-eval\harness-eval-v1\` with `check` passing;
  - the manifest hashes;
  - `permission_mode: "bypass"`.
- Step 2's tests can rely on the exact §6 layout, plus `"grader": "answer"` on read grade lines, `import_root` in the venv JSON, and pytest node ids from JUnit xunit1 (the arch edits below).
- progress.md v1 row 1: set `review`, with the date, the counts per cell, the drops by reason, venvs by method, and the manifest's two hashes. Add a log line. Note anything later steps should know, such as a repository whose tests need longer than 300-second cells (the default profile's `cell_timeout_s`).

## If a decision goes the other way

- **D-176, Go and JavaScript tasks too.** Each language needs its toolchain on the PC, plus an offline module cache (Go) or `node_modules` (JS), exported from the images. Validation then also runs `go test -json` or the JS runners natively, and `rlmh eval` needs those runners' parsers (`grader.RUNNER_CLASSES`). That is a step 2 change too.
- **D-180, splits by task instead of by repository.** Drop `SPLIT_REPOS`, and halve each cell by the seeded shuffle. Tuning can then learn a repository that held-out tasks also use, so a DOM edit may look better on held-out than it is.
- **D-181, the L requirements in the task text.** The task text becomes `editspec.requirements(...)` itself, and `REQUIREMENTS.md` goes. The first message then carries tens of thousands of characters, which works against delegation.
- **D-172, a narrower permission mode for evals.** Only `manifest.permission_mode` changes. Validation here never runs the model.
