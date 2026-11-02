# Step 2. `rlmh eval`: run a set, grade it, report, compare

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0. Every test runs offline against `fake/scripted` and a fixture set |
| **Depends on** | none (the set format is pinned in architecture.md §6, so this step and step 1 build in parallel) |
| **Unblocks** | 5, 6, and through 6, 7 and 9 |
| **Parallel with** | 1, 3, 4 |
| **Decisions it uses** | S-19, S-44, S-46, S-48; D-169 (set folder), D-170 (pass, `pass_score`, `f2p_share`, one replicate), D-172 (`bypass` in throwaway copies), D-176 (five tracks, uv venvs and Node), D-179 (ledger), D-184 (test ids), D-189 (the `answer` grader, `text` included), D-222 (web tasks from Web-Bench, Playwright), D-223 (vendor-neutral GPU kernels through `gpu.py`, `requires: gpu`), D-224 (research, `pass_score` 0.8 for lists), D-225 (`track`). From v0: D-15, D-17, D-26, D-28, D-40, D-62, D-121, D-133, D-165. New here: D-188 to D-193, D-196 to D-198 |

## Goal

`rlmh eval SET` runs one eval set (step 1's folder) through `rlmh`, then grades every run. Read answers (the `research` and `search` tracks) are graded with training's own scoring rules. Repo tasks are graded by their hidden tests, in a throwaway work copy: pytest for the `python` and `kernel` tracks (kernel tasks are GPU kernels in one CUDA/HIP dialect, run on whichever of an NVIDIA or AMD GPU the machine has), and Playwright in Chromium for the `web` track. The command writes a report, totalled by track and size, that steps 5, 7, 8 and 10 compare.

Before anything is spent, it prints a priced estimate. It spends only with `--go`, and stops at `--max-usd`. `--rerun OUT` reruns the tasks a transient infra error stopped. `eval compare` pairs two outputs task by task, and `eval ledger` keeps the running total against the $30 cap (S-44).

Everything v1 measures goes through this command. The tuner (step 6) and `/tune` (step 9) call its library functions, not the CLI.

## Read first

Read these whole, before writing code:

- [../architecture.md](../architecture.md):
  - §6 (all of it: the set folder and its five tracks, `tasks.jsonl`, `grades.jsonl`, running a set, environments, commands and output, the estimate)
  - §9, §10, §11, §12
- [../../v0/architecture.md](../../v0/architecture.md):
  - §7.3 (gateway, `AppEvents`, `Usage`, `ModelInfo.price`)
  - §7.5 (the fake provider and its script)
  - §7.8 (`Session`, `rlmh batch`, the `--json` line shape, the run-log record)
  - §8, §9, §12
- [../../v0/decisions.md](../../v0/decisions.md): D-15, D-17, D-26, D-28, D-29, D-40, D-62, D-121, D-133, D-152, D-157, D-165, and S-44, S-46, S-48, D-169, D-170, D-172, D-176, D-179, D-184, D-189, D-222 to D-225.
- This repo, whole files:
  - `app/src/cli/batch.ts`: the model for the runner. Copy its pool, its `RunWatcher` use, its Ctrl-C handling and its pre-flight-before-engine rule.
  - `app/src/cli/run.ts`: `CliIO`, `RunWatcher`, `modelFlags`, `onInterrupt`, `openFailed`, `message`.
  - `app/src/cli/print.ts`: `jsonLine`, `attachJson`, `attachPlain`.
  - `app/src/session.ts`: `StartRun`, `Session.open/start/cancel/close`, `buildRunParams`.
  - `app/src/main.ts`: the dispatch, `preflightBatch` then `engineReady` then the command.
  - `app/src/paths.ts`, `app/src/settings.ts`.
  - `app/src/engine.ts`: `stripKeys`, `KEY_LIKE`, `GIT_ENV_CONFIG`, `engineEnv`, `findEngine` (how `.cmd` files run through `cmd /c` on Windows), `startEngine`.
  - `app/src/gateway/gateway.ts`: `AppEvents` `call.start`/`call.end`, `totals`, and the OpenRouter `billedCost` path at about line 542.
  - `app/src/gateway/usage.ts`: `costOf`, `billedCost`, `hitRate`.
  - `app/src/gateway/catalog.ts`: `ModelInfo`, `Catalog`.
  - `app/src/gateway/fake.ts`.
  - `app/src/cli/setup.ts`: `findUv`, and how its `UvRunner` keeps the proxy env and CA bundle.
  - `app/test/cli/helpers.ts`, `app/test/cli/batch.test.ts`.
  - `.github/workflows/ci.yml`: the `build` job, which gains the fixture steps below.
  - `engine/rlm_engine/permissions.py` (`decide`: what `bypass` allows).
  - `engine/rlm_engine/workspace.py` (`GIT_ARGS`: the git flags the harness uses on any repository).
  - `engine/rlm_engine/manager.py`: the env the worker gets, after the engine's own key stripping (D-133).
  - `engine/rlm_engine/runlog.py` (`RECORD_KEYS`; `messages` is what the leak check reads).
  - `engine/rlm_engine/service.py` (`engine.info`), `engine/rlm_engine/profiles.py` (`Profile.read`/`.repo`, `agent_api`) and `contract.Limits`: what the estimate's ceiling reads.
  - `protocol/examples.json` and `app/src/protocol.ts` (`EngineInfo`), which gain the profile limits.
- RLM repo, read-only. On the PC use `git -C F:\Personal\RLM\RLM show origin/dev_rishi:<path>`. In a cloud container, clone it outside this repo as CLAUDE.md says. `reward.py` was last changed at `705ebcf` on `dev_rishi`; port from that version.
  - `rlm_rl/reward.py`, whole file. You port:
    - for numbers, entities and lists: `parse_number`, `normalize_entity`, `_normalize_item`, `normalize_set`, `set_f1`, `check_grading`, `near_miss_credit`, `strip_id_labels`, `score_answer` and `score_count`;
    - for free text (the research family): `_GENERIC`, `normalize_text`, `GENERIC_ANSWERS`, `token_f1`, `_MONTH_NAMES`, `_MONTHS`, `_DAY_RE`, `_date`, `_NUMBER_UNIT_RE`, `_number_unit`, `_COUNTRY_NAMES`, `_COUNTRIES`, `same_answer` and `score_text`;
    - plus the constants they read.
  - `rlm_rl/tasks/research.py`: the docstring, for what a research question and its `grading` look like (`text` with `aliases` and `ignore`, and `list`).
  - `rlm_rl/grader.py`:
    - `TEST_DIRS`, `TEST_NAMES`, `TEST_CONFIGS`, `SECTIONED`, `INI_TEST_SECTIONS`, `TOML_TEST_SECTIONS`
    - `is_test_path`, `is_test_config`, `touches_test_config`
    - `_junit_cases`, `_merge`, `pytest_key`
    - `PYTEST_BOOT_TEMPLATE`, `Pytest.commands`, `Pytest.parse`, and `score` (how f2p and p2p decide "resolved", missing tests included)
  - `rlm_rl/editdata.py`: `leaks`.
  - `scripts/harness_smoke.py`: `estimate`, `ceiling_tokens`, `role_cost`, and `run_slot`'s cost cap.
- Web-Bench, read-only, at the commit D-222 pins (`7b31ca2b786eef120dd49ce63dd03d0c0006046d`). Clone it outside both repos with `git clone --filter=blob:none --no-checkout https://github.com/bytedance/web-bench <dir>`, then `git -C <dir> show <commit>:<path>`:
  - `projects/react/playwright.config.js` (`EVAL_PROJECT_PORT`, `IS_EVAL_PRODUCTION`, `webServer`, `retries`);
  - `projects/react/package.json`, `projects/react/test/task-1.spec.js` and the first two lines of `projects/react/tasks.jsonl` (the shape of one task, never its text in a commit);
  - `README.md`, its section on running the evaluation.
- Playwright's JUnit reporter: the "JUnit reporter" section of playwright.dev's reporters page. If that host is blocked, read `packages/playwright/src/reporters/junit.ts` from `microsoft/playwright` at the version the fixture pins, through git as above.
- pnpm's `fetch` and `install --offline` pages (pnpm.io). If blocked, read `pnpm help fetch` and `pnpm help install` from the pinned pnpm.
- For `gpu.py` (task 3), the C APIs it calls through `ctypes`: NVIDIA's NVRTC guide (`nvrtcCreateProgram`, `nvrtcCompileProgram`, `nvrtcGetPTX`) and the CUDA driver API's module and launch calls (`cuInit`, `cuDeviceGetCount`, `cuCtxCreate`, `cuModuleLoadData`, `cuModuleGetFunction`, `cuMemAlloc`, `cuMemcpyHtoD`/`DtoH`, `cuLaunchKernel`); AMD's HIP RTC guide (`hiprtcCreateProgram`, `hiprtcCompileProgram`, `hiprtcGetCode`) and HIP's module API (`hipGetDeviceCount`, `hipModuleLoadData`, `hipModuleGetFunction`, `hipModuleLaunchKernel`), plus HIP's porting notes on warp size and shuffles; and the file list of the `nvidia-cuda-nvrtc-cu12` wheel on PyPI (where its DLL or `.so` sits). If a docs host is blocked, read the headers shipped in that wheel and in ROCm's public `hip` repository through git.

## Starting state

- v0.2.0 at `9f0cedd` on `dev_rishi`. `rlmh batch` works on `fake/scripted`.
- There is no `app/src/eval/` and no `cli/eval.ts`, and `paths.ts` has no `evalDir`.
- uv is on the developer's machine. CI has uv through `astral-sh/setup-uv`, and `engine/.venv` (`uv run --project engine`) has pytest in its dev group.
- Node and pnpm may not be on Rishi's PC. Check `node --version` and `pnpm --version` first. Installing either is a change outside this repo, so ask Rishi before you do it; until then the web fixture tests skip there.

## Deliverables

Every module opens with its cache note (`KV cache: none` for all of them). Code ported from training names `rlm_rl/<file>.py` and the RLM commit in a header comment.

| Path | What it holds |
|---|---|
| `app/src/eval/set.ts` | `loadSet(dir): EvalSet`, the types `Manifest`, `EvalTask`, `Grade`, `Track`, and `selectTasks(set, {split, only, sample, seed}): EvalTask[]` |
| `app/src/eval/tar.ts` | `readTar(bytes): TarEntry[]` and `extractTar(bytes, dest)`, a small ustar reader (D-188). `.tar.gz` goes through `Bun.gunzipSync` first |
| `app/src/eval/work.ts` | `makeWorkCopy(set, task, dir): Promise<string>`; `ensureVenv(set, key, {home, uv}): Promise<Venv>` (`{python, purelib}`); `findNodeTools(env): NodeTools` (`{node, pnpm, nodeVersion, pnpmVersion}` or the missing tool); `ensureNodeEnv(set, key, {home, tools}): Promise<void>`; `installNodeModules(copy, {home, tools})`; `ensureBrowser(playwrightVersion, {home, tools, copy})`; `probeGpu(venv, shimDir, {backend?}): Promise<{backend, devices}>` and `parseProbe(line)` (D-223); `writeSrcPth(venv, copy)`, `removeSrcPth(venv)`; `fillHint(hint, {python?, pnpm?}): string`; `revertTestPaths(dir): Promise<string[]>` |
| `app/src/eval/graders.ts` | `scoreAnswer(answer, gold, grading): {score, exact, components}` (training's `score_answer`, `text` included); `readPassed(score, grade): boolean`; `gradeRepo(task, grade, {dir, python?, tools?, set, logDir, port?}): Promise<RepoGrade>`, which picks the runner from `grade.runner` |
| `app/src/eval/junit.ts` | `parseJunit(xml, keyOf): Map<string, "passed"\|"failed"\|"error"\|"skipped">`; `pytestKey(file, classname, name, base)`, ports of `_junit_cases`, `_merge` and `pytest_key`; `playwrightKey(classname, name)` (D-184) |
| `app/src/eval/estimate.ts` | `REFERENCE` (architecture §6.6's table), `referenceFrom(runLogs, set)`, `ceilingFor(limits, agentApi)`, `estimate(tasks, {root, sub, catalog, refs, profile, home}): Estimate` |
| `app/src/eval/report.ts` | `readGrades(out): Grade[]` (rerun lines win), `buildReport(lines): Report`, `renderReport(report): string`, `compare(a, b): Comparison`, `renderCompare(c): string`, `mcnemarExact(b, c): number` |
| `app/src/eval/ledger.ts` | `appendLedger(home, line)`, `readLedger(home)`, `LEDGER_CAP_USD = 30` |
| `app/src/eval/runner.ts` | `runEval(opts, deps): Promise<EvalResult>`: the pool, the cap, grading as each run finishes. `rlmh tune` (step 6) and `/tune` (step 9) call this. Also `evalEngineEnv(home)` |
| `app/src/cli/eval.ts` | `evalCommand(argv, io)`, `preflightEval(argv, io)`, and the subcommands `report`, `compare`, `ledger` |
| `app/src/main.ts` | `eval` in the dispatch: `preflightEval`, then `engineReady`, then `evalCommand`, as for `batch`. `report`, `compare` and `ledger` start no engine. `--help` gains the four lines |
| `app/src/session.ts` (+) | `Session.open` takes an optional `env`, merged over `process.env` before `findEngine` |
| `app/src/paths.ts` | `evalDir(h) = <h>/eval` |
| `engine/rlm_engine/service.py`, `app/src/protocol.ts`, `protocol/examples.json` | `engine.info`'s profile entries gain `agent_api` and `limits: {read, repo}` (each `contract.Limits.as_dict()`), an added field, so `PROTOCOL_VERSION` stays (D-198). The engine test that checks `engine.info` checks them |
| `app/test/fixtures/evalset/` | The fixture set's text files and plain source trees (below) |
| `app/test/eval/fixture.ts` | `buildFixtureSet(tmp): string`: packs the trees into tars with a test-only ustar writer, writes `manifest.json` with the real hashes, and returns the set folder. No binary is committed |
| `app/test/eval/reward-vectors.json`, `junit-vectors.json` | Expected values produced by running training's functions (task 4) |
| `app/test/fixtures/evalset/gpu/gpu.py`, `gpu_compat.h` | The shared GPU shim and dialect header (task 3). Step 1 copies these bytes into every kernel task's base |
| `app/test/eval/prepare-web.sh` | Fills a pnpm store and a Playwright browser folder for the web fixture (bash; CI's Linux leg and Git Bash) |
| `.github/workflows/ci.yml` (+) | The fixture environment steps (task 11) |

`runner.ts` is the shared entry point the tuner and `/tune` need (D-192).

**The fixture set** `harness-eval-fixture` holds six tasks, three per split. Its ids are `fx-<track>-<size>-<nn>`.
- **`fx-search-R-01`** (tune, track `search`): a count. `ctx/fx-search-R-01/log.txt` has five lines, the gold is 5, and `grading: {type: "count", blind: 0}`.
- **`fx-research-R-01`** (heldout, track `research`): free text. A short `ctx/fx-research-R-01/notes.md`, gold `"Ada Lovelace"`, `grading: {type: "text", aliases: ["Augusta Ada King"], blind: null, ignore: ["who"]}`, `pass_score: 1.0`.
- **`fx-python-S-01`** (tune) and **`fx-python-S-02`** (heldout): `src/fx-python-S-0n/`, a one-module package `calc/` with a bug, at the repo root in S-01 (venv `fx`) and under `src/calc/` in S-02 (venv `fx-src`). Each has:
  - a visible `tests/test_basic.py`, whose test is in `p2p`;
  - a hidden `hidden-src/fx-python-S-0n/tests/test_fix.py`, whose test is in `f2p`.

  Both run under pytest with only the standard library.
- **`fx-kernel-S-01`** (tune, track `kernel`, `requires: ["gpu"]`): `kernels/add.gpu.cu` in the common dialect (no `#include`: `gpu.py` puts `gpu_compat.h` in front, D-226), with a stub `GPU_KERNEL void fx_add(const float *a, const float *b, float *out, int n)` that writes zeros; the shared `gpu.py` and `gpu_compat.h`; and a `kernels.py` that loads `kernels/*.gpu.cu` through `gpu.load` and exposes `add(a, b) -> numpy.ndarray`, launched with a fixed block size. A visible `tests/test_smoke.py` (compiles and launches with `n = 0`, in `p2p`), and a hidden `tests/test_add.py` (`n = 1000`, several blocks, against NumPy's `a + b` within `1e-6`, in `f2p`). Venv `fx-kernel`.
- **`fx-web-S-01`** (heldout, track `web`): a static `index.html` whose `<h1>` reads `Helo`, a dependency-free `server.js` (Node's `http`, serving the folder on `EVAL_PROJECT_PORT`, default 3211), and a `playwright.config.js` modelled on Web-Bench's (`testDir: './test'`, `webServer: node server.js`, the same port rule, `retries: 0`). `package.json` depends only on `@playwright/test` at the pinned version, and its `pnpm-lock.yaml` is committed as text. The hidden `test/task-1.spec.js` expects `<h1>` to read `Hello` (in `f2p`). Node env `fx-web`.
- **`venvs/fx.json`** is `{"python": "3.12", "requirements": ["pytest"], "import_root": "."}`, **`venvs/fx-src.json`** the same with `"import_root": "src"`, and **`venvs/fx-kernel.json`** `{"python": "3.12", "requirements": ["numpy==<pin>", "pytest", "nvidia-cuda-nvrtc-cu12==<pin>; sys_platform != 'darwin'"], "import_root": "."}`. Tests build the first two for real with `UV_OFFLINE=1`, from uv's cache. The kernel venv is built only on a machine with a GPU, by the hand check.
- **The shared shim**, `app/test/fixtures/evalset/gpu/gpu.py` and `gpu_compat.h` (task 3). `buildFixtureSet` copies both into the kernel task's tree, and step 1 copies the same bytes into every kernel task's base. Nothing reaches PyPI during a test.
- **`nodeenvs/fx-web.json`** is `{"node": "22", "pnpm": "<pin>", "playwright": "<pin>"}`.

## Tasks

1. [ ] **`set.ts`.** `loadSet(dir)` reads `manifest.json` (`format` must be 1), `tasks.jsonl` and `grades.jsonl`, and checks:
   - `validated` is true (step 1's `--no-validate` test builds write false; the fixture's manifest writes true);
   - `tasks_sha256` and `grades_sha256` over the files' bytes;
   - unique ids, matching `<set>-<track>-<size>-<nn>` for real sets (D-225; the fixture's `fx-` ids pass because the manifest's `name` starts with `harness-eval-fixture`);
   - one grade per task and one task per grade;
   - `track` is one of `python`, `web`, `kernel`, `research`, `search`, and its `kind` follows: `repo` for the first three, `read` for the other two;
   - `split` is `tune` or `heldout`; `size` is `R` for read and `S`, `M` or `L` for repo;
   - every path is relative, inside the set folder, and exists;
   - `requires`, when present, is a list whose only allowed value is `"gpu"`; every `kernel` task carries `["gpu"]`, and no other track carries it;
   - `python` and `kernel` tasks name a `venv` key with `venvs/<key>.json`, holding `python`, `requirements` and `import_root` (`"."` or `"src"`; with `"src"`, the repo tar has a `src/` folder);
   - `web` tasks name a `node_env` key with `nodeenvs/<key>.json`, holding `node`, `pnpm` and `playwright`. Every node env in the set pins the same `pnpm` and the same `playwright`, so one pnpm and one Chromium serve the whole set;
   - `permission_mode` is one of v0's three modes;
   - `grader` is `answer` for read and `tests` for repo (D-189), and `runner` is `pytest` for `python` and `kernel`, `playwright` for `web`;
   - each read grade passes a port of `check_grading`, `text` included, and its `pass_score`, when present, is a number above 0 and at most 1 (absent means 1.0).

   All problems are listed together, and nothing starts. `selectTasks`:
   - filters by `split` (`all` keeps both), then `only`;
   - `sample K` with `seed S` takes K tasks stratified by `track/size` (D-225): K × the stratum's share, largest remainders first. Within a stratum, take the K lowest `sha256(seed + ":" + id)`, so one seed always picks the same tasks on every OS;
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
     - on every call, workspace.py's `GIT_ARGS` equivalents plus `-c core.autocrlf=false -c commit.gpgsign=false -c init.defaultBranch=main`, and an env that has been through `stripKeys`;
     - before the commit, it writes `node_modules/`, `test-results/` and `playwright-report/` to `.git/info/exclude`, never to a `.gitignore`, so the copy's own files are untouched and `revertTestPaths` never walks installed packages.

     The base commit's hash is then the same on every machine for the same tar. A test checks that.
   - **`ensureVenv`**:
     - reuses `<home>/eval/venvs/<key>/` when its `.rlmh-venv.json` holds the sha256 of `venvs/<key>.json`;
     - otherwise runs `uv venv --python <python> <dir>`, then `uv pip install --python <interpreter> -r <tmp>/requirements.txt`, through `findUv` and setup's env rules. It then asks the interpreter for `sysconfig.get_path("purelib")` and writes the marker with the hash and `purelib`;
     - the interpreter is `Scripts/python.exe` on Windows and `bin/python` elsewhere.

     Kernel venvs pin `numpy`, `pytest` and the `nvidia-cuda-nvrtc-cu12` wheel (skipped on macOS by its marker). No CuPy or other GPU library, and nothing from AMD comes through pip.
   - **`gpu.py`** (D-223, D-226), the shared shim, standard library only, pure `ctypes` (numpy only when arrays move). Step 1 wrote it first, at this path; this step owns it and its CI tests:
     - **`cuda` backend:** NVRTC from the `nvidia-cuda-nvrtc-cu12` wheel in the running venv, and the driver's `nvcuda.dll` (Windows) or `libcuda.so.1` (Linux).
     - **`hip` backend:** `hiprtc` and `amdhip64` from the AMD HIP SDK on Windows, found through `HIP_PATH` (globbing `amdhip64*.dll` and `hiprtc*.dll` in its `bin`), or from ROCm on Linux (`ROCM_PATH`, else `/opt/rocm/lib`).
     - **Choice.** `RLMH_GPU_BACKEND` forces one. Otherwise `cuda` when its driver loads and counts a device, then `hip`, else none.
     - **API** (D-226). `backend()`, `load(paths) -> Module` (each file compiled on its own with `gpu_compat.h` put in front), `Module.launch(name, grid, block, args, shared=0)`, `Module.logs`, `to_device(ndarray)`, `empty(shape, dtype, fill=None)`, `DeviceArray.to_host()`, and `compile_check(paths, arch)` (NVRTC without a GPU), so a task's `kernels.py` never names a vendor.
     - **`python gpu.py --probe [--backend cuda|hip]`** prints exactly one line, `backend=<cuda|hip|none> devices=<n>`, and nothing else: never a device name, UUID, serial or driver version. A library that is missing or fails to load means 0 devices for that backend, never a traceback.
   - **`gpu_compat.h`** makes one kernel source compile under NVRTC and hiprtc (D-226): `GPU_KERNEL` (`extern "C" __global__`), `LAUNCH_BOUNDS`, `WARP_SIZE` (32 on NVIDIA, `__AMDGCN_WAVEFRONT_SIZE` on AMD), `shfl_down`/`shfl_xor` over CUDA's `_sync` shuffles and HIP's, `warp_ballot` (64-bit), `GPU_INFINITY`/`GPU_NAN`, and `h2f`/`f2h` for fp16 kept as raw 16-bit storage.
   - **`probeGpu(venv, shimDir, {backend?})`** runs the kernel venv's interpreter on `gpu.py --probe` (no shell, a 30 s limit, `stripKeys` env), with `shimDir` holding `gpu.py` and `gpu_compat.h` extracted from the first selected kernel task's tar. **`parseProbe`** accepts only the one-line shape above; anything else is a probe error, shown without the output's other lines.
   - **`findNodeTools(env)`** looks up `node` and `pnpm` on `PATH` (on Windows also `pnpm.cmd`, run through `cmd /c` as `findEngine` does), runs `--version` on each, and returns their paths and versions, or which one is missing.
   - **`ensureNodeEnv`** (D-222):
     - refuses a `node` below the major version in `nodeenvs/<key>.json`, and a `pnpm` whose version isn't exactly the pinned one, with the fix in the message (for pnpm, `npm install -g pnpm@<pin>` or `corepack`);
     - extracts the task's `package.json` and `pnpm-lock.yaml` from its repo tar into a temp folder and runs `pnpm fetch --store-dir <home>/eval/pnpm-store` there;
     - writes `<home>/eval/pnpm-store/.rlmh-fetched/<sha256 of the lockfile>` and skips the fetch next time it exists.
   - **`installNodeModules(copy)`** runs `pnpm install --offline --frozen-lockfile --store-dir <home>/eval/pnpm-store` in the work copy, after `makeWorkCopy`. The store and the work folder are both under `<home>`, so pnpm can hard-link from the store.
   - **`ensureBrowser(version)`** runs `pnpm exec playwright install chromium` once, in the first installed web copy, with `PLAYWRIGHT_BROWSERS_PATH=<home>/eval/ms-playwright`, and writes `<home>/eval/ms-playwright/.rlmh-<version>`. It never passes `--with-deps`, which needs root.
   - Every `pnpm` and `node` call above runs with `stripKeys(process.env)`, keeps the proxy env and CA bundle as setup's `UvRunner` does, and logs its output to `<home>/eval/env-logs/`.
   - **`writeSrcPth(venv, copy)`** (D-196), for a venv whose `import_root` is `"src"`, writes `<purelib>/rlmh-eval-src.pth` as one line, `import sys; sys.path.append("<copy>/src")`. The path is written with `/`, and every non-ASCII character as a `\u`/`\U` escape, because Python 3.12 reads `.pth` files in the locale encoding. A fixed name means a file a crashed eval left behind is overwritten. **`removeSrcPth`** deletes it, and does nothing when it is absent.
   - **`fillHint`** replaces `{python}` with the interpreter's absolute path and `{pnpm}` with pnpm's, each written with `/` (D-17) and double-quoted when it holds a space.
4. [ ] **Ported scorers, with vectors from training.**
   - **`scoreAnswer`** covers types `int`, `float`, `count`, `entity`, `list` (with `strip_id_labels`) and `text` (D-189), with training's constants, rounding and `Score` fields (`score`, `exact`, `components`, plus `f1` for text).
   - **`readPassed(score, grade)`** is `score >= (grade.pass_score ?? 1)` (D-170, D-224).
   - **JSON values map as Python's do.** A JSON number is a Python `int` or `float`, and `true` and `false` are `bool`, which `parse_number`, `normalize_entity` and `normalize_text` refuse. A float with an integer value prints as an int in `normalize_entity` and `normalize_text`.
   - **Where JavaScript differs from Python in `normalize_text` and `same_answer`:**
     - Python's `casefold` has no JavaScript twin. Use `toUpperCase()` then `toLowerCase()`, and let the vectors check `ß`, `ſ`, `ς` and `İ`.
     - `unicodedata.normalize("NFKD")` is `String.prototype.normalize("NFKD")`. Categories are `\p{Mn}`, `\p{Pd}`, `\p{Zs}` and `\p{P}`/`\p{S}`, with the `u` flag.
     - Python's `\b` and `\d` are Unicode-aware on `str`, and JavaScript's are ASCII. Write the article rule as `(?<![\p{L}\p{N}_])(?:a|an|the)(?![\p{L}\p{N}_])`, and digits as `\p{Nd}` where Python's `\d` reads them.
     - `str.split()` with no argument splits on every Unicode space and drops empty parts.
   - **`pytestKey`, `parseJunit`** (including `_merge`'s rule for a test reported twice) and **`isTestPath`/`isTestConfig`** for Python port `grader.py`.
   - **`playwrightKey(classname, name)`** is our own rule (D-184): the testcase's `classname` (the spec file, relative to the config's `testDir`) with `\` turned into `/`, then `::`, then its `name` exactly as the report prints it (describe titles joined by ` › `). Step 1 writes its `f2p` and `p2p` ids with the same rule from the same reporter, so check the rule against a real report from `fx-web-S-01` before you rely on it.
   - **The vectors.** Write about 90 `(answer, gold, grading)` inputs, about 30 of them `text` (exact, alias, dates in several forms, numbers with and without units, country names, generic answers, accents, articles, dashes and slashes, the casefold cases above, `ignore` words), and about 25 `(file, classname, name, base)` inputs into a scratch script outside both repos. Run training's own functions over them in the RLM repo's venv, and commit only the inputs and the outputs as `reward-vectors.json` and `junit-vectors.json`, with a header naming the RLM commit. **Never type an expected value by hand** (CLAUDE.md). `playwrightKey` has no training twin, so its tests use small hand-written reports.
5. [ ] **`gradeRepo`**, run in the work copy after `run.finished`:
   1. **`revertTestPaths`.** For every path `git diff --name-only -z base` and `git ls-files -z --others --exclude-standard` report, where `isTestPath` or `isTestConfig` holds, or `setup.cfg`/`pyproject.toml`/`tox.ini` changed a line inside a test section (`SECTIONED`): restore it from `base`, or delete it if it is new. For web copies the test paths also include architecture §6.4's `test/`, `*.spec.*`, `playwright.config.*`, `package.json`, `pnpm-lock.yaml` and `vendor/` (step 1 puts Web-Bench's `test-util` there), and for kernel copies `gpu.py`, `gpu_compat.h` and `kernels.py`. It returns the paths, and `test_tamper = paths.length > 0` (D-190).
   2. **Hidden tests.** Extract `hidden/<id>.tar.gz` over the copy.
   3. **Run the task's runner.** The grade dir is `<out>/grade-logs/<id>/`. For both runners, cwd is the copy, the env has been through `stripKeys` (so a key in the app's environment never reaches code the model wrote), the process tree is killed after `timeout_s`, and stdout and stderr go to `<grade dir>/output.txt`.
      - **`pytest`** (`python`, `kernel`), with the command and flags step 1 validates its tasks with: `<python> -c <PYTEST_BOOT for this copy> -p no:cacheprovider -o junit_family=xunit1 --junitxml=<grade dir>/junit.xml --tb=short -q <grade.files>`.
      - **`playwright`** (`web`): `<pnpm> exec playwright test --reporter=junit --retries=0 <grade.files>`, with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<grade dir>/junit.xml`, `IS_EVAL_PRODUCTION=1`, `PLAYWRIGHT_BROWSERS_PATH=<home>/eval/ms-playwright` and `EVAL_PROJECT_PORT=<port>`, with `CI` removed from the env (Web-Bench's config retries under it). The runner picks the port (bind port 0, read it, close), so a dev server the model left running can't answer for the graded copy. `--retries=0` keeps one try per test: step 1 dropped flaky tests already.
   4. **Results.**
      - The report is parsed with `pytestKey` or `playwrightKey`, by runner.
      - `resolved` is true when every f2p id is `passed` and no p2p id is `failed` or `error`. A missing id counts as training's `score` counts it.
      - `f2p_share` is f2p passed / f2p count.
      - A report that doesn't parse, or a timeout, gives `resolved: false` and `grade_error`.
   5. **`leak_suspect`** is true when the record's `messages` (read from `<out>/runs.jsonl` by `run_id`) contain the set folder's path (either separator, case-folded on Windows and macOS), `hidden/`, the function name of any pytest f2p id, or the title of any Playwright f2p id of 20 characters or more. It never changes `resolved`.
6. [ ] **`runner.ts`.** `runEval({set, tasks, root, sub, profile, callFormat, jobs, out, maxUsd, keep, logDir}, deps)`:
   - **`logDir`** is where the runs' `runs.jsonl` goes. It defaults to `out`; `/tune` (step 9) passes `<home>/runs/tune-<id>/`, so `/runs` lists its runs.
   - **`deps`** holds `{session?, uv?, tools?, probeGpu?, storeDir?, browsersDir?, now?}`, so tests can inject a recording uv, fake node tools, a stub GPU probe, a pre-filled pnpm store and browser folder, and a fixed clock. Without them, the store is `<home>/eval/pnpm-store` and the browsers `<home>/eval/ms-playwright`.
   - **The eval id** is `<manifest.name>-<split>-<YYYYMMDD-HHMMSS>`. It is also the `batch` name and the work folder (D-192).
   - **Preparation.** Before the first run, make every venv the chosen tasks need, and, when any is a web task, run `ensureNodeEnv` for each node env and `ensureBrowser` once. When any task `requires` `gpu`, and only then, run `probeGpu` with the `--gpu` choice (task 10). Nothing else in `rlmh` probes a GPU, and ordinary runs never do. If the probe finds 0 devices, nothing has been spent yet: `runEval` stops with a `GpuMissing` error naming those tasks, and the CLI exits 2 and suggests `--gpu none`.
   - **The engine's environment.** When `runEval` opens its own `Session`, it passes `evalEngineEnv(home)`: `PLAYWRIGHT_BROWSERS_PATH=<home>/eval/ms-playwright`, `IS_EVAL_PRODUCTION=1` and, when a backend was chosen, `RLMH_GPU_BACKEND=<cuda|hip>`, which grading's pytest gets too. None of these names matches `KEY_LIKE` or the engine's own list (D-29, D-133), so both reach the worker, and the model's own Playwright runs find the browser and use Web-Bench's grading timeouts. A test checks that they arrive and that a key-like variable still doesn't.
   - **The pool.** One `Session` for the whole eval, with `approvals` that always deny and `interactive: false`. For each task, `start({..., tag: task.id, batch, logDir})`:
     - read tasks pass `inputs` resolved against the set and `permissionMode: "accept-edits"`;
     - repo tasks pass `repoPath`, the filled `testHint` and `permissionMode: manifest.permission_mode` (D-172, D-191). A web task's copy has its `node_modules` installed before `start`.
   - **`src` venvs** (D-196). For a task whose venv has `import_root: "src"`, `writeSrcPth` runs after `makeWorkCopy` and before `start`, and `removeSrcPth` runs after grading, in a `finally`, so a cancelled or failed run removes it too. The pool never runs two tasks that share such a venv at once. Tasks with `import_root: "."` need no file, because pytest's `-c` puts the copy's root on `sys.path`.
   - **Exclusive groups.** Web tasks form one group (D-222): one at a time, from `start` until their grading ends, because each serves its site on Web-Bench's default port while the model works. Kernel tasks form another (D-223): one at a time, because they share one GPU. A web task and a kernel task can run together, and other tasks keep running beside both.
   - **Waiting.** For `src` venvs and both groups, the pool starts the next task that doesn't wait on a busy one, and `--jobs` stays the upper bound.
   - **Grading** happens per task, right after its `run.finished`. Each grade line is appended to `<out>/grades.jsonl` with architecture §6.5's keys, `track` included. The work copy is removed afterwards unless `keep`.
   - **The cap** (D-193). A `CostCap` sums `usage.cost_usd` of every `call.end` on the session's bus, which is OpenRouter's billed cost when it reports one (D-121). Once the total passes `maxUsd`, no task starts and every running run is cancelled. Their lines get `infra_kind: "capped"`, and `eval.json` gets `capped: true`.
   - **Ctrl-C** works as in batch: the first cancels the running runs, the second quits. Exit 130.
   - **A missing tool or a failed install** (uv, node, pnpm, the browser, a kernel venv) before a task starts gives that task `infra_kind: "host_bug"` and its log path, and the eval goes on with the others.
7. [ ] **`estimate.ts`.**
   - **Reference tokens.** With `--tokens-from` run logs, it uses the mean `usage.root` and `usage.sub` (input, output and cache read) by `track/size` (D-225), matching records to the set's tasks by `tag`. A stratum with no records falls back to `REFERENCE` for its size.
   - **The profile's ceiling** (D-198). Each figure is capped at what the run's mode limits allow, from `engine.info`'s entry for `--profile` (read limits for read tasks, repo limits for repo tasks), with `harness_smoke.py`'s `ceiling_tokens` formula:
     - `per_turn = root_max_tokens + output_max_chars/3`;
     - root input `Σ_{t=1..max_turns} (4000 + (t-1)·per_turn)`, root output `max_turns · root_max_tokens`;
     - sub input `max_subcalls · subcall_max_chars/3`, sub output `max_subcalls · subcall_max_tokens`.

     The sub cap applies only when the profile's `agent_api` is off: a child run's root turns count as sub usage (D-160), so the sub ceiling would underprice `default`. This keeps `training-v4` (30 repo turns, 4,096 tokens) from being priced like `default` (150 turns).
   - **Price.** Root tokens at the root model's catalog price and sub tokens at the sub model's, with 80% of root input as cache reads when `price.cache_read > 0`.
   - **The cap.** The default `maxUsd` is twice the total.
   - **Unpriced models.** A model the catalog doesn't price (`costOf` gives 0) is printed as "unpriced", and `--go` then requires an explicit `--max-usd`.
   - **Downloads.** The estimate also lists what preparation would fetch, since that touches the network: venvs it would create (PyPI), node envs whose lockfile isn't in the store yet (the npm registry), the Chromium download when `<home>/eval/ms-playwright/.rlmh-<version>` is missing, and, for a kernel venv not yet made, the `nvidia-cuda-nvrtc-cu12` wheel (tens of MB; nothing for AMD, whose HIP SDK or ROCm must already be installed). It warns when the chosen backend is missing from the manifest's `kernel_validated_on`, and notes the kernel tasks `--gpu none` leaves out. It also prints the tracks and sizes it plans, as a small table.
8. [ ] **`report.ts`.**
   - **`readGrades(out)`** reads `<out>/grades.jsonl` and, when `<out>/rerun/grades.jsonl` exists, puts each rerun line in place of the original with the same id. `report`, `compare` and the tuner read grades only through it.
   - **`buildReport`** totals by `split`, `track`, `kind` and `size` (D-225), plus a total row: `n`, `passed`, `pass_rate`, `mean_score`, `mean_f2p_share` (repo only), `mean_turns`, `mean_subcalls`, `mean_compactions`, `cost_usd`, `mean_cost_usd`, `cache_hit` (cache reads over input), `mean_wall_s`, `infra`, `test_tamper` and `leak_suspect`. Infra runs count as not passed.
   - **`compare`** pairs the ids present in both outputs and prints how many were in one only, so step 5's all-split run compares with step 8's held-out run: `both`, `a_only`, `b_only`, `neither`; `mcnemarExact(a_only, b_only)`; the pass-rate difference; the mean `f2p_share` difference; and the cost ratio. It also gives the pass counts per track, and warns when the two outputs' `gpu_backend` differ, since then their kernel rows ran on different hardware.
   - **`mcnemarExact(b, c)`** is two-sided: `min(1, 2 · Σ_{k=0}^{min(b,c)} C(b+c, k) / 2^(b+c))`, and 1 when `b + c = 0`.
   - **Every rendered comparison** ends with D-170's line: one replicate per task, so a held-out difference of a few tasks is within noise.
9. [ ] **`ledger.ts`.** On every `--go`, after the last grade, even when capped or interrupted, `runEval` appends one JSON line to `<home>/eval/ledger.jsonl`: `{date, what: "eval", set, split, root, profile, runs, cost_usd, out}`. `readLedger` skips torn lines, like `RunLog.records`.
10. [ ] **`cli/eval.ts`.** The usage and output:
    ```
    rlmh eval SET [--split tune|heldout|all] [--only ID,...] [--sample K --seed S] [--root P/M] [--sub P/M]
                  [--profile NAME] [--call-format F] [--jobs N] [--out DIR] [--tokens-from RUNS.jsonl]...
                  [--gpu cuda|hip|none] [--go] [--max-usd X] [--keep] [--json] [--verbose]
    rlmh eval SET --rerun OUT [--jobs N] [--go] [--max-usd X] [--keep] [--json]
    rlmh eval report OUT
    rlmh eval compare OUT_A OUT_B
    rlmh eval ledger
    ```
    - **Defaults:** `--split all`, `--jobs 4`, `--out <home>/eval/out/<eval id>/`.
    - **Pre-flight.** Before an engine starts, check the flags, `loadSet`, the selection, the models through `modelFlags` and `buildRunParams`, and that `--out` doesn't exist or is empty. When the selection holds a web task, also check `findNodeTools` against the set's node envs. On macOS a selection with a task that `requires` `gpu` exits 2 here, since neither backend exists there. Elsewhere the GPU is probed during preparation (task 6), once the kernel venv exists.
    - **`--gpu`** (D-223). `cuda` or `hip` makes the probe check only that backend. `none` leaves every `requires: gpu` task out of the selection and prints a note naming them. Without the flag, the probe's own choice stands. With 0 devices, `rlmh eval` exits 2 before any run, naming the kernel tasks and `--gpu none`. Any problem returns 2, and a missing or wrong tool is named with its fix.
    - **Without `--go`:** print the estimate, write nothing, start no run, exit 0. The engine starts only for `engine.info`, whose profile limits the ceiling needs.
    - **With `--go`:** write `eval.json` first (architecture §6.5's keys, plus `call_format`, `jobs`, `gpu_backend` (`"cuda"`, `"hip"` or `null`, and nothing else about the GPU), and `harness_commit` when `git rev-parse HEAD` works in a source checkout), then run, then write `report.json` and `report.md`.
    - **`--rerun OUT`** (D-197) takes the split, models, profile, call format and `gpu_backend` from `OUT/eval.json`, and reruns once the tasks in `OUT/grades.jsonl` whose `infra_kind` is transient: `rate_limit`, `server`, `timeout`, `network`, `worker`, `runlog` or `other`. Never `auth`, `no_key`, `bad_request`, `context_window`, `unknown_model`, `cancelled`, `capped`, `workspace` or `host_bug`: those are setup errors or the run's own limits, and a rerun only spends again.
      - The output is `OUT/rerun/`, an ordinary output folder whose `eval.json` adds `rerun_of`. It ends by rewriting `OUT/report.json` and `OUT/report.md` through `readGrades`.
      - Exit 2 before anything runs when `OUT/rerun/` is not empty (one rerun only), when the set's hashes or the profile's `profile_hash` differ from `OUT/eval.json`, or when no task qualifies.
      - Without `--go` it estimates the rerun, like any eval, and every `--go` adds its own ledger line.
    - **Plain output.** Progress goes to stderr through `attachPlain`. stdout gets one line per graded task, `id  track/size  pass|fail|infra:<kind>  score  turns  $cost  seconds`, then a totals line.
    - **`--json` output.** stdout gets batch's lines (`run.*`, `gateway.call`), one `{"type":"eval.task", …grade line}` per task, and `{"type":"eval.finished", runs, passed, infra, cost_usd, capped, out}` last.
    - **Exit codes:** 0 when no run had an infra error and the cap wasn't hit, 1 otherwise, 2 for usage, 130 for Ctrl-C.
    - **`report OUT`** rebuilds `report.json` and `report.md` from `readGrades(OUT)`. **`compare A B`** prints `renderCompare`, and writes nothing. **`ledger`** prints each line and the total, as `$x of $30`. None of the three starts an engine.
11. [ ] **The fixture environments in CI.**
    - **Linux only.** `actions/setup-node` (Node 22) and `pnpm/action-setup` (the fixture's pnpm pin), both pinned by commit SHA; then `bash app/test/eval/prepare-web.sh`, which:
      - runs `pnpm fetch` on the web fixture's lockfile into `$RLMH_TEST_PNPM_STORE`;
      - installs it in a scratch copy and runs `pnpm exec playwright install --with-deps chromium` into `$PLAYWRIGHT_BROWSERS_PATH`.

      The job sets both variables under `$RUNNER_TEMP`. The web fixture tests run only when both point at filled folders and `node` and the pinned `pnpm` are on PATH. Elsewhere, macOS and Windows CI included, they skip with a printed reason.
    - **No GPU in CI.** GitHub's runners have none, so the kernel fixture's grading test skips there with a reason. CI still covers kernel tasks in set loading, `parseProbe`, `--gpu`, the no-GPU exit and the kernel group, through a stub `probeGpu`. It also runs the real `gpu.py --probe` with the engine's Python on all three OSes, which must print `backend=none devices=0`.
    - The new steps keep `zizmor` clean: no `${{ }}` in `run:`, `persist-credentials: false` where a step checks out, nothing cached across jobs.
    - Only test code reads `RLMH_TEST_PNPM_STORE` and `PLAYWRIGHT_BROWSERS_PATH`, and passes them as `deps.storeDir` and `deps.browsersDir`. The CLI never reads a test variable.
12. [ ] **Docs.**
    - CLAUDE.md's commands table gains `rlmh eval` (estimate, `--go`, `compare`), the one-test command for `test/eval`, and how to run the web fixture tests locally (`prepare-web.sh` with the two variables set).
    - architecture.md already lists `eval/runner.ts` and `eval/tar.ts` (§2), the five tracks, both runners, the node environments, `--tokens-from`, `--rerun`, the default `--out`, the `answer` grader with `text` and `pass_score`, and `eval.json`'s keys (§6), and the ceiling cap (§6.6). Check them against what you built and fix any drift, the NVRTC wheel, numpy and pnpm pins included. v0/architecture.md §7 gains the `engine.info` fields. Log each change in progress.md.

## Tests

Every test is offline. The fixture set is built into a temp folder by `buildFixtureSet`, and `RLMH_HOME` is a temp home. Tests that need Python let `ensureVenv` build the fixture's venvs with `UV_OFFLINE=1`, from uv's cache; they skip only when uv is missing, which never happens in CI. The kernel and web fixture tests skip, with a reason, under the conditions in task 11.

- **`app/test/eval/set.test.ts`**:
  - the fixture loads, all six tasks across the five tracks;
  - each of these is reported, all in one call: a changed byte (hash mismatch), a duplicate id, a task without a grade, a path with `..`, `pass_score: 0`, `kind: "repo"` with `size: "R"`, track `web` with kind `read`, a missing venv file, a web task without its `nodeenvs/<key>.json`, a `runner: "pytest"` on a web task, two node envs that pin different `playwright` versions, a kernel task without `requires`, and `requires: ["cuda"]`;
  - `text` grading with `aliases` loads;
  - `selectTasks` with `--split`, `--only`, and `--sample 3 --seed a` twice gives the same three ids, from three different `track/size` strata.
- **`app/test/eval/tar.test.ts`**:
  - a round trip with the test writer keeps bytes (CRLF, a NUL byte, UTF-8 names) and the executable bit (POSIX);
  - a 150-character name works through pax and through GNU `L`;
  - it refuses `../x`, `/etc/x`, `C:x`, a symlink entry, and two names that differ only in case;
  - a `.tar.gz` round trip works.
- **`app/test/eval/graders.test.ts`**:
  - every line of `reward-vectors.json` gives training's `score` and `exact` (to 4 places), `text` lines included;
  - `readPassed` passes a 0.8 list score with `pass_score: 0.8` and fails it without;
  - `junit-vectors.json` gives `pytestKey`;
  - `parseJunit` handles a pytest report with a failure, an error, a skip, and one test reported twice;
  - `playwrightKey` on a hand-written Playwright report: a pass, a failure, a skip, a `describe` block (` › `), and a classname written with `\`.
- **`app/test/eval/work.test.ts`**:
  - the work copy has one commit, `base`, whose hash is the same in two runs;
  - `git log --format=%an%ae%ad` is fixed, the files are byte-identical to the tar, and `.git/info/exclude` lists `node_modules/`;
  - `fillHint` writes `/` paths for `{python}` and `{pnpm}` and quotes a path with a space;
  - `ensureVenv` with a recording fake uv calls `venv` then `pip install` once, and reuses the folder the second time;
  - with fake `node` and `pnpm` scripts on a test `PATH`: `ensureNodeEnv` fetches once per lockfile hash and skips the second time, `installNodeModules` runs `install --offline --frozen-lockfile` with the store, `ensureBrowser` runs once per version, and a `node` 20 or a `pnpm` off the pin is refused with its fix;
  - `writeSrcPth` writes one line with `/` and escapes a non-ASCII path; `removeSrcPth` removes it and is quiet when it is gone.
- **`app/test/eval/grade.test.ts`**, real runners on the fixture's repo tasks:
  - **Python:**
    - the base fails f2p, so `resolved: false` and `f2p_share 0`; with the fix written, `resolved: true`;
    - a model edit to `tests/test_basic.py` that makes it pass trivially is reverted and gives `test_tamper: true`, and a new `conftest.py` is deleted and flagged;
    - a `pytest.py` in the copy doesn't replace the runner (PYTEST_BOOT);
    - a 1-second `timeout_s` on a sleeping test gives `grade_error`;
    - `fx-python-S-02` (the `src` layout) imports the copy's `calc` through the `.pth`, and after grading the file is gone;
    - a key-like variable set in the test's env is absent inside the test (the hidden test prints `os.environ` keys to a file).
  - **Kernel** (skips when the real probe finds no GPU): the stub fails `test_add`; with a real body written into `kernels.cu`, it compiles through `gpu.py` and the task resolves; an edited `kernels.py` or `gpu.py` is reverted and flagged.
  - **Web:** the base page fails `task-1.spec.js`; with `Hello` written, the task resolves; a new `test/mine.spec.js` is deleted and an edited `playwright.config.js` is restored, both flagged; grading uses its own port while another server holds 3211.
- **`app/test/eval/report.test.ts`**:
  - `mcnemarExact(0,5) = 0.0625`, `(1,6) = 0.125`, `(3,3) = 1`, `(0,0) = 1`;
  - `buildReport` totals on a hand-made `grades.jsonl`, with a row per track;
  - `compare` counts, its per-track counts, the D-170 line, and the warning when `gpu_backend` differs;
  - `renderReport` is stable (a snapshot);
  - `readGrades` puts a rerun line in place of the original.
- **`app/test/eval/estimate.test.ts`**:
  - `REFERENCE` pricing for the two S-43 models from the bundled catalog;
  - `--tokens-from` means replace the reference by `track/size` stratum, and a stratum without records falls back by size;
  - an unpriced model makes `--go` need `--max-usd`;
  - `ceilingFor` with `training-v4`'s repo limits equals a hand calculation and caps an M/L reference figure, and with `agent_api` on the sub figure is not capped;
  - the downloads list names a missing venv, an unfetched lockfile, a missing browser and a kernel venv's NVRTC wheel, and names nothing once all four exist.
- **`app/test/eval/cap.test.ts`**: `CostCap` on a bare `Bus`: `call.end` events summing past the cap call the cancel function for each running run exactly once and stop new starts.
- **`app/test/cli/eval.test.ts`**, the real engine with `fake/scripted` and `RLMH_FAKE_SCRIPT`:
  - **The script.** One root entry, a tool call whose code branches on the task: in `fx-python-S-01` it writes the fix; in `fx-python-S-02` it changes nothing; in read mode it submits `len(context.splitlines())`. Then it calls `submit('done')` or the count.
  - **`--go --json --jobs 2 --only fx-search-R-01,fx-research-R-01,fx-python-S-01,fx-python-S-02`:**
    - `eval.task` lines show S-01 resolved, S-02 not, `fx-search-R-01` passed (5) and `fx-research-R-01` not;
    - `eval.finished` is last;
    - `grades.jsonl` (with `track` on every line), `report.json`, `report.md`, `eval.json` and `runs.jsonl` exist;
    - the ledger has one line with `cost_usd: 0`;
    - no work copy is left;
    - exit 0.
  - **The engine's environment.** A read task whose cell submits `os.environ.get('PLAYWRIGHT_BROWSERS_PATH')`, `os.environ.get('IS_EVAL_PRODUCTION')` and whether a `FAKE_TEST_KEY` set in the test's env is present shows the first two and not the key. With a stub probe choosing `hip`, `RLMH_GPU_BACKEND` arrives as `hip`, and `eval.json` holds `gpu_backend: "hip"` and no other GPU field.
  - **Without `--go`:** the estimate prints, no `out` folder appears, exit 0.
  - **Exit 2** before any engine starts for: a bad set, `--out` not empty, `--sample` without `--seed`, a selection with `fx-web-S-01` while `PATH` holds no `pnpm`, and, on macOS only, a selection with `fx-kernel-S-01`.
  - **The GPU choice**, with a stub `probeGpu`: `backend=none devices=0` makes `--go` exit 2 before any run, naming `fx-kernel-S-01` and `--gpu none`; `--gpu none` leaves it out with a note and exits 0; `--gpu hip` passes `hip` to the probe; a probe line in any other shape is a probe error; and the estimate warns when the manifest's `kernel_validated_on` lacks the chosen backend.
  - **`gpu.py --probe`**, the real shim under the engine's Python, prints exactly `backend=none devices=0` on a machine without a GPU (every CI runner).
  - **`--jobs 2` with two `src`-layout tasks on one venv** never runs them at once, **`--jobs 4` with two web tasks** never overlaps them from `start` to the end of grading, the same holds for two kernel tasks, and one web task and one kernel task do overlap (a stub `start`, a stub grader and a stub `probeGpu` record it).
  - **`--rerun`.** After a `--go`, the test rewrites two lines of `OUT/grades.jsonl` to `infra_kind` `server` and `auth` (fake errors are counted per run, so they can't pick one task). `--rerun OUT --go` reruns only the `server` task into `OUT/rerun/`, `OUT/report.json` counts its rerun line, a second `--rerun` exits 2, and the ledger has two lines.
  - **`eval compare`** of two outputs prints the pair counts; **`eval ledger`** prints the total.
  - **The whole fixture**, when task 11's web conditions hold: `--go` on every task but `fx-kernel-S-01` grades the web task too (unresolved, since the script changes nothing there) and exits 0. The kernel task joins it only on a machine with a GPU (the hand check).

## Done when

- The full verify gate passes (`bash scripts/verify.sh` or `scripts\verify.ps1`), including the new `test/eval` and `test/cli/eval.test.ts`.
- CI is green on macOS, Windows and Linux, and its log shows the web fixture tests running on Linux and the kernel grading test skipped for want of a GPU. The tar, git and pytest tests are the Windows-sensitive ones.
- **GPU hand check, on Rishi's PC** (an AMD GPU, so the `hip` backend through the AMD HIP SDK; installing the SDK is a change outside this repo, so ask Rishi first): `rlmh eval <fixture> --only fx-kernel-S-01 --root fake/scripted --go` probes `backend=hip devices=<n>`, and grades the task (unresolved, since the script changes nothing); then `bun test test/eval/grade.test.ts` runs the kernel cases instead of skipping them. Record only the backend and the device count in the progress log, never a device name or driver version.
- On Rishi's PC, in `app/`: `..\.bun\bin\bun.exe test test/eval test/cli/eval.test.ts` passes. Once Node 22 and the pinned pnpm are installed (with his OK), and `prepare-web.sh` has filled the two folders from Git Bash, the web fixture tests pass there too. Playwright on Windows is the one runner CI doesn't cover.
- In a temp home, `rlmh eval <a fixture set built by buildFixtureSet> --root fake/scripted` prints an estimate of $0.00, its downloads list and its track table, and exits 0.
- The two vectors files carry the RLM commit they were produced from, and the progress log names the scratch script's command, never its outputs typed in. It also records the pnpm and Playwright pins.

## Out of scope

- Building the real set (step 1), and running it on a real model (step 5).
- Repeats per task, and runners other than pytest and Playwright.
- GPUs other than NVIDIA (CUDA) and AMD (HIP), so no Metal and no CPU fallback; and speed scoring: a kernel task passes on correctness alone (D-223).
- The tuner and `/tune` (steps 6 and 9), which call `runEval`, `loadSet`, `selectTasks` and `compare`.
- Any sandbox. `bypass` is not one (CLAUDE.md), so evals run only on a developer's machine, in throwaway copies.

## Hand-off

- **Steps 5, 7, 8 and 10 rely on** `rlmh eval SET --split … --profile … --root … --go --max-usd … --out …`, `--rerun OUT`, `eval compare` and `eval ledger`, and on the output layout of architecture §6.5, totalled by track.
- **Step 6 relies on** `runEval`, `loadSet`, `selectTasks` (`--sample/--seed` is its probe subset, stratified by track and size), `readGrades`, `compare`, `buildReport` and `CostCap`. **The tuner never reads `grades.jsonl` or `grade-logs/`**, apart from pass counts for acceptance (architecture §7.3).
- **Step 1 relies on** `loadSet`'s checks, which are the definition of a valid set; step 1's `check` covers the same ground in Python. It also needs from this step:
  - `gpu.py` and `gpu_compat.h` (copied byte for byte into every kernel task's base), the NVRTC wheel and numpy pins, and the probe's one-line shape, for its kernel venvs and validation;
  - the pnpm and Playwright pins, written into every `nodeenvs/<key>.json`;
  - `playwrightKey`'s rule, for its web tasks' `f2p` and `p2p` ids;
  - that every web project's `playwright.config.js` reads `EVAL_PROJECT_PORT` and `IS_EVAL_PRODUCTION`, as Web-Bench's do.

  The first `rlmh eval` on the real set is step 5's estimate.
- **progress.md row 2:** set `review`, with the date, the CI run, the three pins, and the commands that produced the two vectors files.

## If a decision goes the other way

- **D-172, allow only the test command instead of `bypass`.**
  - `permissions.py`: `Permissions.__init__` takes `allow_commands: list[str]`, and `decide()` returns `allow` for kind `shell` (and `subprocess`) when the detail, whitespace-collapsed, equals one of them, before the mode rules. The model can then run exactly the task's test command and nothing else (no `python -c`, no single test file).
  - The wire: `run.start` gains `allow_commands` (`protocol.ts`, `service.py`'s checks, `protocol/examples.json`, `RunSpec`), and `loop.py` passes it on.
  - Here: `runEval` sends `[filled test_hint]` with `accept-edits`, and the manifest's `permission_mode` must then be `accept-edits`.
  - The cost: the model can't run a narrower test, a quick script, a compile or a dev server, so long-running coding tasks, kernels and web builds get harder and measure the permission rule as much as the profile.
- **D-170, repeats.** `runEval` takes `repeats: n`; `tag` becomes `<id>#<k>`; grade lines carry `repeat`; `buildReport` averages per task before totalling, and `compare` uses the per-task majority. Each extra repeat costs one more full pass against S-44.
- **D-176, more languages.** `grades.jsonl`'s `runner` takes `go` or `jest`; `gradeRepo` grows a runner table like `RUNNER_CLASSES`, and each runner gets its own toolchain check, as `findNodeTools` does for Node. Nothing in the set or report format changes.
- **D-223, C kernels on the CPU instead.** Kernel venvs pin `ziglang` (the newest release with wheels for all three OSes; 0.16.0 on 2026-11-02) instead of the NVRTC wheel, `kernels.py` compiles with `python -m ziglang cc -shared` and loads the library with `ctypes`, and `gpu.py`, `requires`, `--gpu` and `gpu_backend` go away. Kernel tasks then run in parallel like Python tasks, and CI grades the kernel fixture on all three OSes.
- **D-222, Web-Bench run its own way.** If its projects can't be made standalone pnpm projects, step 1 ships one shared workspace per set instead: one lockfile, one `pnpm fetch`, and every web copy installs from it. `ensureNodeEnv` then keys on that one lockfile, and nothing else here changes.
