# Step 1. Eval sets: 48 tasks, mostly coding

| | |
|---|---|
| **Type** | PC (RLM repo; a Remote Control session on Rishi's PC, because the edit and research data live only on `D:` and the kernel track needs its NVIDIA GPU) |
| **Cost** | $0. No model calls. The build downloads from PyPI (including CUDA toolkit wheels), the npm registry, github.com and Playwright's browser host, and the optional image fallback runs Docker locally |
| **Depends on** | none |
| **Unblocks** | 5, and through it 7, 8 and 10 |
| **Parallel with** | 2, 3 |
| **Decisions it uses** | S-19, S-44, S-46, S-48, D-169, D-170, D-172, D-176 (the five tracks), D-180 (disjoint splits), D-181 (long specs live in a file), D-183 (native validation rule), D-184 (test ids), D-185 (`import_root` for src layouts), D-189 (`text` grading), D-222 (Web-Bench), D-223 (kernels), D-224 (research), D-225 (`track`) |

## Goal

`scripts/harness_evalset.py` in the RLM repo builds the eval set `harness-eval-v1`: 48 tasks in the folder layout of [../architecture.md §6.1](../architecture.md#61-the-set-folder), in five tracks (D-176):

| Track | Kind | Source | S | M | L | R |
|---|---|---|---|---|---|---|
| `python` | repo | training's held-out edit tasks | 6 | 6 | 4 | |
| `web` | repo | Web-Bench projects (D-222) | 4 | 4 | 2 | |
| `kernel` | repo | CUDA kernels of an LLM inference engine, written here (D-223) | 4 | 4 | 2 | |
| `research` | read | training's `research_test`, levels 2 and 3 (D-224) | | | | 8 |
| `search` | read | training's `callgraph_heldout` and `needle_heldout` | | | | 4 |

Each split, `tune` and `heldout`, holds half of every cell, so each has R 6, S 7, M 7 and L 4. Every repo task is validated natively on Rishi's PC with the same commands `rlmh eval` (step 2) grades with: pytest in a uv venv for `python` and `kernel` (on the GPU, through CuPy), and Playwright in Chromium for `web`. The set lives in `RLM_DATA_DIR`, never in either repo. Step 5 runs the baseline on it.

## Read first

- [../architecture.md](../architecture.md) §6 (all of it: §6.1 to §6.3 are the contract this step writes, and §6.4 is how step 2 grades it, so validation here must do the same) and §11. [../README.md](../README.md).
- [../../v0/decisions.md](../../v0/decisions.md): S-19, S-44, S-46, S-48, D-168 to D-189, and D-222 to D-225.
- [../../v0/specs/step-09-smoke-run.md](../../v0/specs/step-09-smoke-run.md): the house style for RLM-repo scripts (`check_ignored`, `guard`, task files written as bytes, the no-task-text summary).
- RLM repo, branch `dev_rishi` (`git -C F:\Personal\RLM\RLM show origin/dev_rishi:<path>`, or the working tree), read whole:
  - `rlm_rl/tasks/__init__.py`: `GENERATORS`, `make_task`, `private_seed_list`, `fixed_set`, `new_seed`, `PoolEmpty`.
  - `rlm_rl/tasks/editreal.py`: `level_of`, `records`, `_build_workspace`, `_context`, `to_task`, `PERMISSIVE`.
  - `rlm_rl/tasks/editspec.py`: `Pool`, `LEVELS`, `MIN_BODY`/`MAX_BODY`, `analyze`, `map_profile`, `eligible`, `graph`, `grow`, `spec_clusters`, `whole_module`, `stub_text`, `test_files_of`, `requirements`.
  - `rlm_rl/tasks/editbugs.py`: `LEVELS`, `FAMILIES`, the pool and its records.
  - `rlm_rl/tasks/research.py`: the docstring, `FAMILIES`, `LEVELS`, `LIST_SHARE`, `closed_book`, `open_book`, `usable`, `build`, `make_task`, and the grading dicts `build` writes. It is the same at `0b9af69` and `dev_rishi`.
  - `rlm_rl/tasks/synthcode.py`: `LEVELS`, `make_task`, the callgraph and needle builders, `HELDOUT_STYLES`, `HELDOUT_QUESTIONS`.
  - `rlm_rl/reward.py`: `check_grading` (which `grading["type"]` values exist), `score_answer`, `score_text`, `normalize_text`, `set_f1`.
  - `rlm_rl/data.py`: `root`, `path`, `derived`, `available`, `DATA_ENV`, `RESEARCH_POOLS`, `research_pool`.
  - `rlm_rl/editdata.py`: `edit_path`, `patch_size`, `leaks`, `read_json`, `write_json`, `grader_cap`, `CAP_FACTOR`, `classify_licence`.
  - `rlm_rl/grader.py`: `TestSpec`, `parse_patch`, `is_test_path`, `pytest_key`, `PYTEST_BOOT_TEMPLATE`, `safe_path`, `_safe_apply`.
  - `rlm_rl/editbox.py`: `git`, `git_env`, `GIT_DATE`, `_commit_base`.
  - `scripts/build_edit_tasks_v2.py`, whole: `REPOS`, `KEEP`, `MAX_HIDDEN_FILES`, `registry`, `snapshot_texts`, `test_files`, `load_profile`, `repo_limits`, `Context`, `file_patch`, `base_record`, `changed_texts`, `stage_spec`. The Python L family reuses this machinery.
  - `scripts/build_edit_data.py`: `cmd_index` and the record format it writes (`edit/index.json`).
  - `scripts/build_research_data.py`, `scripts/closed_book.py` and `scripts/open_book.py`: what the research pool files and the two check files hold, and which versions the research generator expects.
  - `scripts/harness_smoke.py`: `check_ignored`, `rlm_commit`, `guard`, `write_task_files`, `check_task_files`.
  - `.gitignore`: `private/` and `results/harness-*/`.
- Web-Bench at `7b31ca2b786eef120dd49ce63dd03d0c0006046d` (D-222), in the build cache's clone (task 8), read whole:
  - `README.md`, `LICENSE.md`, and `rush.json` (`pnpmVersion`, `nodeSupportedVersionRange`).
  - `libraries/test-util/`: `package.json`, `src/index.js`, `src/css.js`, `test.sh`. Every spec requires `@web-bench/test-util`.
  - `projects/react/`: `package.json`, `playwright.config.js` (`EVAL_PROJECT_PORT`, `IS_EVAL_PRODUCTION`, `CI`, `webServer`), `vite.config.ts`, `tasks.jsonl`, `src-init/`, and `test/task-1.spec.js` and `test/task-2.spec.js`.
  - `projects/form/test/util/`: a project whose specs share helpers.
  - `tools/evaluator/src/index.ts` and `tools/evaluator/src/plugins/`: how Web-Bench itself copies `src-init/`, runs the specs and counts a pass, so this step grades the same way.
  - The root `pnpm-lock.yaml`: the importer entries of the projects you pick, for their resolved versions.
- For the kernel track:
  - CuPy's user guide page on user-defined kernels (docs.cupy.dev, "User-Defined Kernels": `RawKernel`, `RawModule`, `get_function`, NVRTC `options`, `name_expressions`) and its installation page (the `ctk` extra and the CUDA toolkit wheels).
  - As reference for style and layouts only (read, don't copy code into tasks): llama.cpp's `ggml/src/ggml-cuda/softmax.cu`, `norm.cu` and `rope.cu` (MIT, github.com/ggml-org/llama.cpp), and vLLM's `csrc/attention/paged_attention_v1.cu` and `csrc/cache_kernels.cu` (Apache-2.0, github.com/vllm-project/vllm) for block tables.
- On `D:` (read only):
  - `edit/index.json`, `edit/v2/spec_index.json`, `edit/v2/bugs_index.json`, `edit/repos.json`, `edit/v2/profile/<key>.json` for the nine `REPOS`, and `edit/repos/<key>.tar`;
  - `derived/research/musique-v1.json.gz`, `derived/research/qampari-v1.json.gz`, `derived/research/closed-book-v1.json` and `derived/research/open-book-v1.json`.

## Starting state

- The RLM repo is on `dev_rishi` (`d83e71a` or later). Its Windows `.venv` imports `rlm_rl.tasks`, and `RLM_DATA_DIR` (default `D:\RLM-data`) holds the edit data and the four research files above.
- **The research checks are in force.** `research.closed_book()` and `research.open_book()` both return a dict, not `None`. Without them the generator draws questions the base model answers from memory, or broken ones. If either is missing, stop and tell Rishi; don't run `closed_book.py` or `open_book.py` yourself, because they make model calls.
- `uv` is on PATH (`uv --version`). Git for Windows is installed, and `git clone` from github.com works. Docker is optional: only the Python venv fallback uses it, directly or as `wsl -d Ubuntu docker`.
- **An NVIDIA GPU** (kernel track): `nvidia-smi` lists one, and its "CUDA Version" is 12.0 or later, so the driver runs CUDA 12 code. Without it the kernel track can't be built: stop and tell Rishi.
- **Node and pnpm** (web track): `node --version` is 22 or later, and `pnpm --version` equals `PNPM` (below). Installing either is a step on Rishi's machine: ask before you run an installer.
- No `harness-eval` folder exists under `RLM_DATA_DIR`, and no `private/seeds/harness-eval-v1-*.json`.

## Deliverables

All in the RLM repo unless marked. Nothing in rlm-harness changes, except this step's row and log line in `documentation/v0/progress.md`.

| Path | What it is |
|---|---|
| `scripts/harness_evalset.py` | The builder and checker. Imports `rlm_rl` and `scripts/build_edit_tasks_v2.py` (by putting `scripts/` on `sys.path`), and nothing from rlm-harness. Changes no file under `rlm_rl/` |
| `tests/test_harness_evalset.py` | Offline unittest tests (below) |
| `documentation/harness-eval-v1.md` | The summary: counts by track and size, ids, gold sizes and test timings. Never task text, gold, test names, diffs, or the names of repositories, Web-Bench projects or kernel ops |
| `RLM_DATA_DIR\harness-eval\harness-eval-v1\` | The set, in §6.1's layout. Outside both repos |
| `RLM_DATA_DIR\harness-eval\build\harness-eval-v1\` | The build cache: candidates, gold, build venvs (the kernel venv holds the CUDA toolkit wheels), the Web-Bench clone, the pnpm store, Playwright's Chromium, the kernel sources and validation results, so a rerun resumes. Never read by `rlmh` |
| `…\build\harness-eval-v1\kernels\<op>\` | The 10 kernel tasks, written in task 9 (layout below). Private: never in git, never in a summary |
| `private/seeds/harness-eval-v1-read.json`, `private/seeds/harness-eval-v1-repo.json` | Seeds, drawn once by `private_seed_list`. Git-ignored |

**CLI** (`.venv\Scripts\python.exe scripts\harness_evalset.py …`, from the RLM repo root):

| Command | Does |
|---|---|
| `build [--only TRACKS] [--jobs N] [--no-validate] [--force]` | Candidates, environments, native validation, assembly, manifest. `--only` takes a comma list of `python`, `web`, `kernel`, `research`, `search`. Resumes from the build cache. `--no-validate` is for tests only and writes `validated: false` into the manifest. `--force` replaces an existing set folder; without it, an existing set exits 2 |
| `check` | Offline, $0: layout, hashes, ids, leaks, tar safety. Exit 0, or 1 with every problem listed |
| `summary` | Writes `documentation/harness-eval-v1.md` from the set and the build cache |

`--set NAME` (default `harness-eval-v1`) and `--data DIR` (default `data.root()`) apply to all three. The set folder and the build cache must resolve outside both git work trees (the RLM repo, and `--harness`, default `..\rlm-harness`), or the script exits 2. Task data never enters git.

**The plan (D-176).**

```python
SET = "harness-eval-v1"
READ_PLAN = {("research_test", 2): 4, ("research_test", 3): 4,       # track "research"
             ("callgraph_heldout", 2): 2, ("needle_heldout", 3): 2}   # track "search"; 12 in all, size "R"
PYTHON_PLAN = {"S": 6, "M": 6, "L": 4}                                 # 16
WEB_PLAN = {"S": 4, "M": 4, "L": 2}                                    # 10
KERNEL_PLAN = {"S": 4, "M": 4, "L": 2}                                 # 10
SPLIT_REPOS = {"tune": ("andialbrecht__sqlparse.e57923b3", "pallets__jinja.ada0a9a6", "arrow-py__arrow.1d70d009",
                        "tkrajina__gpxpy.09fc46b3", "mahmoud__glom.fb3c4e76"),
               "heldout": ("marshmallow-code__marshmallow.9716fc62", "seperman__deepdiff.ed252022",
                           "lepture__mistune.bf54ef67", "pyparsing__pyparsing.533adf47")}   # D-180, python
WEBBENCH = ("https://github.com/bytedance/web-bench", "7b31ca2b786eef120dd49ce63dd03d0c0006046d")
WEB_SPLIT = {"tune": ("react", "svelte", "tailwind", "canvas", "form", "sass", "dom", "calculator"),
             "heldout": ("vue", "angular", "unocss", "table", "stylus", "survey", "bom", "grid")}   # D-180, preference order
WEB_REQUESTS = {"S": 3, "M": 6, "L": 12}                               # requests 1..n
CUPY = "cupy-cuda12x[ctk]==14.2.0"   # win_amd64 and manylinux wheels; the ctk extra pulls cuda-toolkit[...,nvrtc]==12.*
PNPM = "<the newest 10.x release at least two weeks old on build day>"  # fixed once, recorded in nodeenvs/
```

Every cell is split × track × size, and each split gets half: per split, `python` S 3, M 3, L 2; `web` and `kernel` S 2, M 2, L 1 each; `research` 4; `search` 2.

### The `python` track

**Where tasks come from** (Python only, `language == "python"`, licence in `editreal.PERMISSIVE`):

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
- **Venvs.** For each repository key used:
  - **Resolve.** With uv's `--exclude-newer` set to the commit's date (from `edit/repos.json`, or the SWE-smith row; when neither holds it, the newest mtime in the snapshot, logged as approximate), install into a build venv, in order:
    - the snapshot's test dependencies: the extras named `test`, `tests`, `testing` or `dev` in `pyproject.toml`/`setup.cfg`/`setup.py`, then `requirements*test*.txt`, `requirements-dev.txt` and `tox.ini`'s `[testenv] deps`;
    - pytest, if it isn't there yet;
    - the snapshot's own runtime dependencies, never the package itself.
  - **Freeze.** Freeze the result with `uv pip freeze --python <venv>`, dropping the package's own line.
  - **Python version.** Try Python `3.12`, then `3.11`, then `3.10`, and keep the first under which every task of that repository that is drawn passes its gold check.
  - **Fallback.** If resolution fails and Docker answers, freeze the image instead: `docker run --rm <entry tag> python -m pip freeze`. Log which way each key went.
  - **The `.pth` line.** Build venvs live in the build cache. Each gets a `.pth` file in its site-packages, holding one line that puts `<cwd>/src` on `sys.path` when `import_root` is `"src"`. `rlmh eval` writes the same `.pth` (step 2).

### The `web` track (D-222)

- **The clone.** `git clone --filter=blob:none https://github.com/bytedance/web-bench <cache>\web-bench`, then check out the pinned commit. Never write into the clone; every change happens in a copy.
- **Which projects.** Walk `WEB_SPLIT[split]` in order and take the first projects that validate: one for L (requests 1–12), then two for M (1–6), then two for S (1–3). A project gives at most one task. Skip a project, with the reason logged, when:
  - its `package.json` lacks `"eval": {"stable": true}`, or its `tasks.jsonl` has fewer than 12 requests;
  - its start script runs a server of its own (`node scripts/dev.js`) or it depends on `sqlite3`, `mongoose`, `prisma` or another native or database package;
  - its config or specs require a path outside the project, other than `@web-bench/test-util`;
  - it is one of the variants kept out of both splits: `dom1`, `calculator-files`, `svg-solar`, `react-no-ts`. A project and its variant would otherwise sit on both sides of D-180.

  A split that runs out of projects stops the build with the shortfall, for Rishi's call.
- **A standalone project.** Each chosen project becomes a folder with no workspace link:
  - every file of `projects/<p>/` except `src/`, `src-init/`, `test/`, `tasks.jsonl` and `readme.md`, plus `src/` copied from `src-init/`. That is the base;
  - `libraries/test-util/` copied to `vendor/test-util/`, and `@web-bench/test-util` in `package.json` rewritten to `"file:vendor/test-util"`;
  - Web-Bench's `LICENSE.md` at the root, and a `NOTICE` line naming Web-Bench, its commit and the project;
  - in `package.json`: every dependency pinned to the exact version the root `pnpm-lock.yaml` resolves for that project; `dotenv` and anything else the config or specs require from the monorepo root added the same way; `scripts.test` set to `playwright test`; and `pnpm.onlyBuiltDependencies` listing each package whose install script the gold run needs (`esbuild` at least);
  - a `pnpm-lock.yaml` made with `pnpm install --lockfile-only` under `PNPM`, and a `.gitignore` holding `node_modules/`, `test-results/` and `playwright-report/`.
- **The task text.** S lists its three requests, numbered, in the text itself. M and L write them to `FEATURES.md` at the root (D-181's pattern), and their text is exactly:

  > This is a web project: its source is in `src/`, and `package.json` and `playwright.config.js` set up its dev server and browser tests. FEATURES.md, at the root of this repository, lists feature requests. Implement them in order, each on top of the ones before it, so the site does everything the requests describe.

  S's text is the same, with "FEATURES.md, at the root of this repository, lists feature requests." replaced by "The feature requests are:" and the numbered list after the last sentence.
- **Hidden tests and gold.** The hidden files are `test/task-1.spec.js` to `test/task-<n>.spec.js`, plus any `test/util/` the specs require. The gold is the project's `src/` at the pin; Web-Bench's specs are cumulative, so it passes every request's spec.
- **Environments.** One `nodeenvs/<key>.json` per project, `{"node": "22", "pnpm": PNPM, "playwright": "<the project's @playwright/test version>"}`, where the key is `web-` plus the first 12 hex digits of the lockfile's sha256. The build fills `<cache>\pnpm-store\` with `pnpm fetch` and installs Chromium into `<cache>\ms-playwright\` with `pnpm exec playwright install chromium`.

### The `kernel` track (D-223)

Ten CUDA C kernel tasks, written for this set in task 9 and kept in the build cache only. Each is a piece of an LLM inference engine's GPU backend. The kernels compile at run time through CuPy: `cupy.RawModule(code=…)` hands the source to NVRTC from the pip CUDA toolkit, so the PC needs no nvcc, no MSVC and no system CUDA toolkit, only an NVIDIA GPU and its driver. The splits use different groups of ops (D-180):

| Split | Size | Op (folder name) | What it asks for |
|---|---|---|---|
| tune | S | `softmax_rows` | Row softmax with max-subtraction, fp32 and fp16 in, for rows from 1 to 128K long; a row of all `-inf` gives the header's defined output |
| tune | S | `swiglu` | Fused SwiGLU, `silu(gate) * up`, fp32 and fp16, any length |
| tune | M | `dequant_gemv` | int8 per-row-scale and int4 group-wise (packed nibbles, fp16 scales) dequantization, and a GEMV over each format |
| tune | M | `topk_topp` | Temperature, top-k and top-p over one logits row, then a sample from a given uniform draw; ties broken by the lower index |
| tune | L | `paged_attention` | KV-cache append through a block table, and paged-attention decode with grouped-query heads over it; at least 4 source files |
| heldout | S | `rmsnorm` | RMSNorm over rows with `eps` and a weight vector, fp32 and fp16, with row strides |
| heldout | S | `rope` | Rotary position embedding in both the NeoX and GPT-J layouts, with a position offset and a `theta` base |
| heldout | M | `tiled_matmul` | Shared-memory tiled SGEMM, a transposed-B variant, and an fp16-in, fp32-accumulate variant; any shape, including 1 |
| heldout | M | `reductions` | Row logsumexp and argmax with warp shuffles over long rows, with `-inf` and NaN rules and ties by the lower index |
| heldout | L | `flash_attention` | A flash-attention-style forward: tiled QKᵀ, online softmax and the output, with a causal mask and head dims 64 and 128; at least 4 source files |

If an op can't get a test suite that passes the mutant rule below, swap in one of the same split's spares (tune: `gelu_tanh`, `int4_pack`; heldout: `layernorm`, `transpose_tiled`), and log it.

**The source layout**, `kernels/<op>/`:

```
meta.json              {op, split, size, files}
base/
  kernels/*.cu         stubs: every kernel's signature and doc comment (layouts, dtypes, edge cases, tolerances), empty bodies
  kernels.py           loads every .cu file with cupy.RawModule and exposes the Python functions the tests call.
                       The function signatures are the contract; the launch configuration inside each is the model's to choose
  tests/conftest.py    a session fixture that imports kernels.py and fails the session if no CUDA device is found
  tests/test_smoke.py  a few visible cases at small, easy shapes
  REQUIREMENTS.md      the spec, written for the model: formats, layouts, edge cases and tolerances
gold/kernels/*.cu, gold/kernels.py      the reference implementation
hidden/tests/test_<op>_*.py             the graded suite: NumPy references, seeded random inputs and edge cases
mutants/<k>/kernels/*.cu               four plausible wrong implementations (k = 1..4)
```

- **The hidden suite** covers: sizes that aren't a multiple of the block or tile size, n = 1, long rows, `-inf` masks, NaN, block tables with gaps and out-of-order pages, and shapes that cross tiles, so a missing `__syncthreads` shows. Each test states its tolerance: indices compare exactly, fp32 results to about 1e-5 relative, and fp16 results to about 1e-2.
- **The four mutants** are the bugs a hurried kernel author makes, chosen per op: a missing bounds check, no max-subtraction, a wrong block-table index, a race (a missing `__syncthreads`), an off-by-one tile edge, or fp16 accumulation where fp32 is required.
- **The task text** is the same for every kernel task:

  > This repository is part of the CUDA backend of an LLM inference engine. The kernels in kernels/*.cu have empty bodies, and kernels.py compiles them at run time with CuPy (NVRTC) and wraps them for Python. Implement them as REQUIREMENTS.md and the doc comments describe, including every edge case they name, and choose each launch configuration in kernels.py. Test on the GPU with the command below, and add tests of your own.

- **`requires`.** Every kernel task line carries `"requires": ["cuda"]`. Kernel tasks validate one at a time, because there is one GPU, and step 2 runs them one at a time too.
- **The venv.** One key for every kernel task, `kernel-` plus the first 12 hex digits of the requirements' sha256. The build installs `CUPY`, plus numpy and pytest pinned to their newest releases at least two weeks old on build day that have cp312 wheels for Windows and Linux, then freezes the result with `uv pip freeze`, so every CUDA toolkit wheel is pinned exactly: `{"python": "3.12", "requirements": [frozen lines], "import_root": "."}`. The venv check runs `cupy.cuda.runtime.getDeviceCount()` (at least 1) and compiles and runs a trivial `RawKernel`.

### The `research` and `search` tracks (D-224)

- **Tasks.** `tasks.fixed_set("harness-eval-v1-read", READ_PLAN)`. Within each `(family, level)` entry the tasks alternate `tune`, `heldout`. `research_test` tasks get track `research`, and the two synthcode families track `search`.
- **A list question in each split.** `research.build` picks multi-hop or list from the seed (`LIST_SHARE` = 0.2). If a split's 4 research tasks hold no list question, its last multi-hop task's seed is replaced by new ones from `tasks.new_seed()`, appended to the private seed file, until a list question appears. After 20 draws without one, the build stops and says so.
- **Grading types.** Step 2's `answer` grader ports `score_answer` for `int`, `float`, `count`, `entity`, `list` and `text` (D-189). At `0b9af69`, callgraph grades as `list`, needle as `entity`, research multi-hop as `text` and research lists as `list`. As a guard, a task whose `grading["type"]` is anything else is replaced the same way, after at most 20 draws.
- **`pass_score`.** 0.8 for a research list question, training's open-book bar (D-224); 1.0 for every other read task (D-170).
- **Checks recorded.** Each research task's `grading` carries the `closed_book` and `open_book` versions `build` writes. A `None` in either stops the build.

### Files written

All bytes, LF, never through text mode:
- `tasks.jsonl` and `grades.jsonl`, as in §6.2 and §6.3.
  - A read line is exactly `{"id", "kind": "read", "track", "split", "size": "R", "question", "input"}`. A repo line is exactly `{"id", "kind": "repo", "track", "split", "size", "task", "base", "venv" | "node_env", "test_hint"}`, plus `"requires": ["cuda"]` on kernel lines.
  - Repo `task` is the record's `issue` (python S, M), the L template (python L), the web text, or the kernel text.
  - `test_hint` is `"{python} -m pytest -q"` for `python`, `"{python} -m pytest -q tests"` for `kernel`, and `"{pnpm} exec playwright test"` for `web`.
  - A read grade line is exactly `{"id", "grader": "answer", "gold", "grading", "pass_score"}`, where `grading` is the RLM task's own grading fields. A repo grade line is §6.3's `{"id", "grader": "tests", "runner": "pytest" | "playwright", "hidden", "f2p", "p2p", "files", "timeout_s"}`, with no other keys.
  - Where each task came from (`family`, `record_id`, `repo`, `project`, `op`, `level`) goes to the build cache's `sources.jsonl`, never into the set. `summary` reads it from there.
- `repos/<id>.tar`, tarred with members sorted, `mtime = 0`, `uid = gid = 0`, `uname = gname = ""`, and no `.git`, so the same inputs give the same bytes:
  - python: `editreal._build_workspace(record, folder)`, plus `REQUIREMENTS.md` for L;
  - web: the standalone base above, with `FEATURES.md` for M and L, and no `node_modules`;
  - kernel: the op's `base/`, with no gold or mutant file.
- `hidden/<id>.tar.gz`: the hidden files (python: the record's `tests.hidden`, and for L the scope files' texts from `ctx.texts`; web: the request specs and their `test/util/`; kernel: `hidden/tests/`), with the same normalisation, gzipped with `mtime=0`.
- `ctx/<id>/context.txt`: `task.context.encode("utf-8")`.
- `venvs/<key>.json`: `{"python", "requirements", "import_root"}` for python (D-185; `"src"` when the package's import directory is under `src/`) and kernel tasks. `nodeenvs/<key>.json` for web tasks.
- `manifest.json`: `{"format": 1, "name", "created", "builder": {"repo": "RishiJain905/rlm", "commit", "dirty"}, "permission_mode": "bypass", "validated": true, "counts": {"<split>/<track>/<size>": n}, "tasks_sha256", "grades_sha256"}` (D-172 for the mode).

### Native validation (D-183, D-184)

For each candidate, on the PC, in its own temp folder under the build cache. The runs are exactly step 2's grading commands (architecture §6.4).

- **pytest** (`python`, `kernel`): `<python> -c <grader.PYTEST_BOOT_TEMPLATE filled for the work folder> -p no:cacheprovider -o junit_family=xunit1 --junitxml=<tmp>/junit.xml --tb=short -q <scope files>`, with the build venv. Test ids are `grader.pytest_key(file, classname, name)` from the JUnit report. Kernel runs go one at a time, on the GPU.
- **playwright** (`web`): `pnpm install --offline --frozen-lockfile --store-dir <cache>\pnpm-store`, then `pnpm exec playwright test --reporter=junit --retries=0 <spec files>` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<tmp>\junit.xml`, `IS_EVAL_PRODUCTION=1`, `PLAYWRIGHT_BROWSERS_PATH=<cache>\ms-playwright`, a free `EVAL_PROJECT_PORT` per job, and `CI` unset. Test ids follow D-184 exactly as step 2's `playwrightKey` builds them: the testcase's `classname` (the spec file relative to `testDir`, with `\` turned into `/`), `::`, then its `name`.

The steps:
1. **Base:** extract the base and restore the hidden files. Every f2p test must fail or be missing. A test that passes is p2p if it also passes on gold, and is dropped if not.
2. **Gold, three times:** extract, apply the gold (python: `git apply` the gold patch, and remove `REQUIREMENTS.md` for L; web: replace `src/` with the pinned `src/`; kernel: copy `gold/kernels/` and `gold/kernels.py`), then restore the hidden files.
   - Every f2p test must pass all three times, or the task is dropped. For a kernel task, a test that fails on gold is a bug in the task: fix the test or the gold and validate again.
   - A p2p test that doesn't pass all three times is removed from `p2p`, and the task is dropped if more than 10% of its p2p tests go.
   - `timeout_s = max(120, editdata.CAP_FACTOR × the slowest gold run)`.
3. **Visible collection:** the base without the hidden files. python: `pytest --collect-only -q -p no:cacheprovider` must exit 0 or 5. kernel: `tests/test_smoke.py` must import `kernels.py`, compile the stubs through NVRTC and run (it may fail on the stubs). web: `pnpm exec playwright test --list` must exit 0 with an empty `test/`.
4. **python L only:** every stubbed function must be run by at least one surviving f2p test (`ctx.tests_of`), or the task is dropped.
5. **kernel only, the mutant rule:** for each of the four mutants, run the hidden suite once. At least 3 of the 4 must fail at least one f2p test. If not, the tests are too weak: strengthen them and validate again. The gold also compiles under NVRTC with no warnings.
6. **Leaks:**
   - python and kernel: `editdata.leaks(task_text, gold_patch, f2p + p2p)` must be empty, and for kernel the same holds for `REQUIREMENTS.md` and the stubs' doc comments;
   - web: no spec title or spec file name appears in the task text or `FEATURES.md` (Web-Bench's requests name class names and texts on purpose, so gold-line overlap is allowed);
   - read: a question must not contain its gold, or any gold list item, as a string of 4 or more characters.

The results go to the build cache, one line per candidate: `{id, track, source, kept, why, f2p, p2p, dropped_p2p, gold_seconds, env, mutants_caught}`.

## Tasks

1. [ ] Set row 1 of the v1 table in progress.md to `in progress`. Rishi OK'd on 2026-11-02 that this step creates its script, its test and its summary in the RLM repo on `dev_rishi`. Anything else there, and every commit or push there, still needs his OK (CLAUDE.md, "The RLM repo is outside this repo").
2. [ ] Check that `git -C F:\Personal\RLM\RLM check-ignore -v private/seeds/harness-eval-v1-read.json` prints `private/`. The set folder and build cache are outside the repo, so they need no rule. Check the starting state: `nvidia-smi`, Node, pnpm, the four research files, and that `closed_book()` and `open_book()` aren't `None`.
3. [ ] Write the plan constants, the CLI and the outside-the-repo guard.
4. [ ] Write the read builder (research and search), the list and type guards, `pass_score`, and the files it writes. Test with `--only research,search --no-validate`.
5. [ ] Write the python S and M candidate readers over the three indexes, with the Python, licence, level and file-count filters and the repository-to-split assignment.
6. [ ] Write the `edit_large` builder (above). Print each repository's L clusters (modules, functions, body lines, hidden files) before validating anything.
7. [ ] Write the python venv resolver and freezer, with the Python-version ladder and the Docker fallback, and the kernel venv with its GPU check.
8. [ ] Write the web builder: the clone at the pin, the project filter, the standalone copy, the lockfile, the pnpm store and Chromium. Print the projects each split would use, in order, before validating anything.
9. [ ] Write the ten kernel tasks in `kernels/<op>/`, as the table and layout above say. Write the gold first, then the hidden suite against NumPy, then the four mutants, then the stubs, `kernels.py` and `REQUIREMENTS.md`. Then write the reader that turns them into candidates.
10. [ ] Write native validation exactly as above. Run it with `--jobs` processes (default 4), each in its own temp folder under the build cache; kernel tasks take one slot at a time, never two at once. On Windows, remove folders with read-only bits cleared (as v0's `_rmtree` does).
11. [ ] Write the assembly, the manifest and `check`. `check` lists every problem:
    - an id in one of `tasks.jsonl`/`grades.jsonl` but not the other;
    - a missing file, including a `venvs/` or `nodeenvs/` key;
    - a hash mismatch;
    - an id outside `^harness-eval-v1-(python|web|kernel|research|search)-(R|S|M|L)-\d{2}$`;
    - a tar member that `grader.safe_path` refuses, or any `.git` or `node_modules`;
    - a hidden file present in a base tar, or a kernel gold or mutant file in any tar;
    - a kernel line without `"requires": ["cuda"]`, or another line with `requires`;
    - a `gold` string or test name in `tasks.jsonl`;
    - counts that differ from the plan.
12. [ ] Write `tests/test_harness_evalset.py` and make it pass.
13. [ ] Run `build` on the PC. Post the counts in chat: candidates per cell, kept, dropped with the top reasons, environments by kind, method and Python, gold test seconds (median and max), mutants caught per kernel task, and set size on disk. A short cell stops here for Rishi's call.
14. [ ] Run `check` (exit 0), then `summary`.
15. [ ] Run `build` again with no changes. It must resume from the cache and give byte-identical `tasks.jsonl`, `grades.jsonl` and tars, so the same hashes.
16. [ ] Update progress.md (Hand-off). Commit nothing until Rishi says so, in either repo.

## Tests

`tests/test_harness_evalset.py` (`python -m unittest -v tests.test_harness_evalset`). The fixtures are built in a temp folder: a fake data root holding a tiny edit index and snapshot tars, a tiny fake Web-Bench tree, and a tiny kernel source folder, all made by the test. Cases that run pytest need `uv` and skip without it; cases that run Playwright need Node, pnpm and an installed Chromium, and cases that run CUDA need a GPU and the kernel venv; each skips without them. No case reads `D:`, clones from the network, makes a model call, or reads a key.

| Case | Asserts |
|---|---|
| `test_plan` | The read plan gives 12 tasks; python, web and kernel give 16, 10 and 10; 48 in all; each cell halves into equal splits, so each split has R 6, S 7, M 7 and L 4 |
| `test_ids_reveal_nothing` | Ids match the `check` regex and contain no record id, repository, project or op name, seed or level number beyond the size letter |
| `test_tasks_jsonl_keys` | Read and repo lines hold exactly the keys under "Files written", with `node_env` on web lines, `venv` on the others, and `requires` only on kernel lines. Read grade lines hold exactly `id, grader, gold, grading, pass_score`. No gold or f2p name appears in `tasks.jsonl` |
| `test_pass_score` | A research list task gets 0.8; research multi-hop, callgraph and needle tasks get 1.0 |
| `test_research_guards` | A split with no list question gets a redrawn seed, appended to the seed file; 20 failed draws stop the build; a `None` check file stops it with exit 2 |
| `test_repo_disjoint` | Over a fake index of six repositories, no repository is in both splits, and none has more than 2 tasks in a cell. Web projects and their variants never appear in both splits |
| `test_large_cluster` | `editspec.analyze` over six synthetic modules with enough documented, covered functions gives a cluster of ≥ 4 modules and ≥ 300 body lines. Three modules give `None` |
| `test_large_task_text` | The L task text equals the pinned template, and `REQUIREMENTS.md` is in the base tar and absent after the gold patch |
| `test_web_standalone` | From the fake Web-Bench tree: `package.json` has no `workspace:` spec and points `@web-bench/test-util` at `vendor/test-util`; `LICENSE.md` and `NOTICE` are present; `src/` equals `src-init/`; no `src-init/`, `test/` or `tasks.jsonl` in the base tar; `FEATURES.md` holds requests 1 to 6 for M, and the S text holds requests 1 to 3; the hidden tar holds exactly the request specs and `test/util/` |
| `test_web_filter` | A project with a `node scripts/dev.js` start script, a `sqlite3` dependency, an outside-path require, `stable: false`, or a variant name is skipped with its reason |
| `test_web_validation` (Node, pnpm, Chromium) | A fake project whose spec checks a heading: the base fails it, the gold passes it three times, and the task is kept with Playwright test ids |
| `test_kernel_layout` | From the fake kernel folder: the base tar holds the `.cu` stubs, `kernels.py`, `conftest.py`, the smoke tests and `REQUIREMENTS.md`, and no hidden test, gold or mutant file. The task text equals the pinned template, and the line carries `"requires": ["cuda"]` |
| `test_kernel_validation` (GPU) | A tiny `vec_add` kernel through `RawModule`: the stub fails every f2p test, the gold passes three times, and 3 of 4 mutants are caught, so it is kept. A suite that catches only 2 is reported as too weak |
| `test_tar_deterministic` | Two builds give byte-identical tars, with no `.git`, no `node_modules` and no hidden file in a base tar |
| `test_validation_keeps_good` (uv) | A tiny package with a stubbed function: the base fails its f2p test, gold passes it three times, and the task is kept with `timeout_s >= 120` |
| `test_validation_drops_bad` (uv) | Gold that fails one f2p test is dropped with the reason. A flaky p2p (fails on the second run) is removed from `p2p`. Losing more than 10% of p2p drops the task |
| `test_src_layout` (uv) | A `src/`-layout package gets `import_root: "src"`, and with the `.pth` its tests import it from the work copy, not from site-packages |
| `test_leaks` | An issue quoting a 30-character gold line, or naming a hidden test, is dropped. A web request naming a spec title is dropped |
| `test_check_detects` | `check` exits 0 on a fresh build, and 1 after each of: a tampered `grades.jsonl` byte, a removed tar, a gold string inserted into `tasks.jsonl`, a `.git` member, and a kernel gold file in a base tar |
| `test_outside_repo_guard` | `--data` inside the RLM repo or the harness checkout exits 2 |
| `test_bytes_lf` | Context files are byte-equal to `context.encode()`, with no `\r` anywhere in the written text files |
| `test_summary_no_text` | With sentinel strings as issue, question, gold, test names, project and op names, none appears in the summary |

## Done when

- `.venv\Scripts\python.exe -m unittest -v tests.test_harness_evalset` passes on Rishi's PC, with the Node, pnpm, Chromium and GPU cases running, not skipped.
- `build` finished, and `check` exits 0 on `D:\RLM-data\harness-eval\harness-eval-v1\`. Its `manifest.json` counts are 48 tasks: `tune` and `heldout` each have R 6, S 7, M 7 and L 4, split by track as the plan says. Any other count must have Rishi's OK, recorded as a D-number.
- Every repo task passed native validation on Windows. Every python L task has at least 4 changed files and at least 300 gold lines, every kernel task caught at least 3 of its 4 mutants, and every web task's specs passed the gold three times (all from the build cache).
- A second `build` reproduced the same `tasks_sha256` and `grades_sha256`.
- `documentation/harness-eval-v1.md` exists and holds no task text and no repository, project or op name. `git -C F:\Personal\RLM\RLM status --short` shows only the script, the test and the summary.

## Out of scope

- `rlmh eval` itself (step 2). Running any model on the set (step 5).
- CPU kernels in C, Triton and PyTorch extensions (see the last two bullets below). Running the kernel track on a machine without an NVIDIA GPU. Go, Rust and other languages from training's data. Web-Bench projects that need their own server or a database.
- Partial-credit rewards for training. Any change under `rlm_rl/`. Running `closed_book.py` or `open_book.py`.
- Linux and macOS validation. The set is validated on Windows, where steps 5, 7, 8 and 10 run it. A run elsewhere needs the folder copied, and a check there first.

## Hand-off

- Step 5 can rely on:
  - the set folder at `D:\RLM-data\harness-eval\harness-eval-v1\` with `check` passing;
  - the manifest hashes;
  - `permission_mode: "bypass"`;
  - the build cache's `pnpm-store\` and `ms-playwright\`, which step 2's environment setup can copy instead of downloading again;
  - the PC's GPU, which the kernel tasks need while step 5 runs.
- Step 2's tests can rely on the exact §6 layout: `track` on every task line, `"grader": "answer"` and `pass_score` on read grade lines, `runner` on repo grade lines, `requires: ["cuda"]` on kernel task lines (run one at a time), `import_root` in the venv JSON, `nodeenvs/`, pytest node ids from JUnit xunit1, and Playwright ids as `test/<file>::<title>`.
- progress.md v1 row 1: set `review`, with the date, the counts per cell, the drops by reason, environments by kind and method, and the manifest's two hashes. Add a log line. Note anything later steps should know: a repository whose tests need longer than 300-second cells (the default profile's `cell_timeout_s`), a web project whose specs run long, or a kernel op that was swapped for a spare.

## If a decision goes the other way

- **D-180, splits by task instead of by repository or project.** Drop `SPLIT_REPOS` and `WEB_SPLIT`, and halve each cell by the seeded shuffle. Tuning can then learn a repository or project that held-out tasks also use, so a DOM edit may look better on held-out than it is.
- **D-181, long specs in the task text.** The task text becomes `editspec.requirements(...)`, the request list or the kernel spec itself, and `REQUIREMENTS.md`/`FEATURES.md` go. The first message then carries tens of thousands of characters, which works against delegation.
- **D-172, a narrower permission mode for evals.** Only `manifest.permission_mode` changes. Validation here never runs the model.
- **D-222, web tasks written for this set instead of Web-Bench.** Web-Bench has been public since 2025, so a model may have seen it. Written tasks would follow the kernel track's layout (gold, hidden Playwright specs, mutants), with the same standalone pnpm project shape.
- **D-224, AA-LCR instead of `research_test`.** Its answers need a judge model, so the `answer` grader would need a judge and every eval would spend on it. That is a step 2 change too.
- **D-223, CPU kernels in C instead of CUDA.** The same ops in C11, compiled by `ziglang==0.16.0` from PyPI (wheels for Windows, macOS and Linux; 0.17.0 has no Windows wheel) through a `conftest.py` that builds a shared library and loads it with ctypes. That runs on any machine and in step 2's CI, with no GPU, but it tests no GPU skills: no thread blocks, shared memory or synchronisation.
- **Rejected for the CUDA track:** Triton, because it has no official Windows build; PyTorch's `load_inline`, because it needs nvcc and MSVC on the PC. CuPy's `RawModule` needs neither.
