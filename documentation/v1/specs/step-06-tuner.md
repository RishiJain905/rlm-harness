# Step 6. Harness² tuner, developer side: `rlmh tune`

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0. Every test runs offline against `fake/scripted`, `FakeApp` and step 2's fixture set |
| **Depends on** | 2 |
| **Unblocks** | 7, and with 4, step 9 |
| **Parallel with** | 3, 4, 5 |
| **Decisions it uses** | S-09, S-14, S-43, S-44, S-47; D-34, D-121, D-144, D-170, D-173, D-174, D-175, D-179; step 2's D-192 and D-193. New here: D-204 to D-212 |

## Goal

`rlmh tune SET` improves a profile on an eval set's tune split the way Harness² improves a harness:
- an INV editor and a DOM editor each propose one edit to `guidance.md` and the tunable TOML keys;
- each candidate is probed on a fixed subset of the tune tasks;
- a composer merges what the trajectories support;
- a reflector writes at most one lesson to an experience library.

Unlike the paper's online loop, a composed profile becomes the incumbent only when it passes D-173's labelled check on the whole tune split, as the paper's Meta-Harness baseline accepts only above a margin (Appendix C). Every session is an `rlmh` read run on the tuning model over an evidence folder that never holds a grade (D-174). The command prints a priced estimate of every stage and spends only with `--go`. Round 1 always runs, and each later round runs only if its fresh estimate fits under what is left of `--max-usd`, which covers the whole tune. Step 7 runs it for real.

## Read first

Read these whole, before writing code:

- **The paper.** Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", [arXiv 2610.14224](https://arxiv.org/abs/2610.14224), also on [Hugging Face](https://huggingface.co/papers/2610.14224). In a cloud container arxiv.org answers 403, so read `hf://papers/2610.14224/paper.md` through the Hugging Face connector. The parts this step builds on:
  - §2.2.1, the contrastive improvement step: INV, DOM, probe, compose;
  - §2.2.2, parallel and sequential recursion;
  - §2.3, harnessing-level recursion, which is the library;
  - §4, Figure 8, the executor model as its own editor;
  - Appendix C, the Meta-Harness baseline: offline search, acceptance margin, lessons file;
  - Appendices D.2 and H, the cost accounting and the prompts.
- **The code.** [google-research/harness2](https://github.com/google-research/harness2) at `6868817518876de8fd170c6a8354daca273b6191`, Apache-2.0. Clone it with `git clone --depth 1` outside both repos and read these files whole:
  - `harness2/core/prompts.py`:
    - `_tidy` L33, `ANSWER_FREE` L38, `EVIDENCE_BOUNDARY` L56, `_SURFACE_OPENCODE` L95
    - `GENERALIZE` L295, `_KEEP_BASE` L333, `_INV_TEMPLATE` L347, `_DOM_TEMPLATE` L372
    - `propose` L824, `aggregate` L893, `compose_round` L964, `select` L1040, `experience` L1105
  - `harness2/core/recursion.py`: `STAGE_ATTEMPTS` L36, `_accept_tree` L114, `_run_stage` L141 (its retry text is at L190), `run_sequential` L463.
  - `harness2/core/context.py`: `build` L105, `_write_rollout` L219, `_WITHHELD_NOTE` L351, `assert_no_leak_paths` L399, `GRADER_VERDICT_MARKERS` L419, `assert_no_grader_verdicts` L454, `assert_tree_has_no_grader_verdicts` L493, `mission` L521.
  - `harness2/core/library.py`: `Library.add` L106, `rebuild_index` L154.
  - `harness2/core/selection.py`: `reflect_adoption` L402, `_distil` L454.
  - `harness2/core/ledger.py`: `expected_rollouts` L26, `expected_sessions` L31, `Ledger` L50.
  - `harness2/core/tree.py`: `validate` L336, `diff_summary` L393.
  - `harness2/core/schedule.py`: `stream_order` L130.
  - `scripts/split_tasks.py`: L29 to L50, the seeded shuffle within each stratum.
- [../architecture.md](../architecture.md): §1, §2, §3.1, §6.4 to §6.6, §7 (all of it), §9, §11, §12.
- [../../v0/architecture.md](../../v0/architecture.md): §7.5 (the fake provider), §7.8 (`Session` and the run-log record), §9.
- [../../v0/decisions.md](../../v0/decisions.md): S-09, S-14, S-43, S-44, S-47, D-34, D-121, D-144, D-170, D-173 to D-175, D-179.
- [step-02-rlmh-eval.md](step-02-rlmh-eval.md): Deliverables, task 6 (`runEval`) and Hand-off.
- This repo, whole files:
  - `engine/rlm_engine/profiles.py`, `profiles/default/profile.toml` and `profiles/default/guidance.md`;
  - `engine/rlm_engine/service.py` and `link.py` (`RpcError`);
  - `engine/rlm_engine/contract.py` (`valid_answer`, `SUBMIT_MAX_BYTES`) and `worker/worker.py` (`normalize_answer` L242, `submit` L255);
  - `engine/rlm_engine/runlog.py` (`RECORD_KEYS`), `bridge.py` (`SubcallRecord`) and `loop.py` (the turn entry);
  - `engine/tests/fakeapp.py` and `protocol/examples.json`;
  - `app/src/session.ts`, `protocol.ts`, `main.ts`, `paths.ts`, `cli/run.ts`, `cli/batch.ts` and `gateway/fake.ts`;
  - step 2's `app/src/eval/{runner,set,estimate,report,ledger}.ts`, `app/test/eval/fixture.ts`, `app/test/cli/eval.test.ts` and `app/test/cli/helpers.ts`.

## Starting state

- **Step 2 is `done`.** `runEval`, `loadSet`, `selectTasks`, `estimate`, `buildReport`, `CostCap`, `appendLedger` and `buildFixtureSet` exist, and `rlmh eval` runs the fixture set on `fake/scripted`.
- **Step 3 may not be done yet.** If it isn't, `Profile` has no `compaction`. The two `compaction.*` rows of `TUNABLE` exist anyway, and `effective()` reads them with `getattr(profile, "compaction", None)`. Their bounds test is skipped until step 3 lands, with the reason `step 3`, and the log says so. Step 7 needs step 3 (through step 5), so the gap closes before any spend.
- **What doesn't exist yet:** `app/src/tune/`, `cli/tune.ts` and `profile.check`.

## Deliverables

Every module opens with its cache note (`KV cache: none` for all of them).

| Path | What it holds |
|---|---|
| `engine/rlm_engine/profiles.py` + | `TUNABLE` (architecture §7.2's table; the only copy in code), `FROZEN`, `effective(profile) -> dict[str, object]` (every dotted key, defaults filled), `check_tunable(base, candidate) -> list[str]` |
| `engine/rlm_engine/service.py` + | the `profile.check` method; each profile in `contract_info` gains `path`, next to step 2's `agent_api` and `limits` (D-208) |
| `protocol/examples.json` + | a `profile.check` request and result, and `path` on `engine.info`'s profiles |
| `app/src/protocol.ts`, `session.ts` + | `ProfileCheckParams`, `ProfileCheckResult` and `ProfileInfo.path`; `Session.checkProfile(path, base)` |
| `app/src/eval/runner.ts` + | the `runEval` option `ledger?: boolean`, `true` by default (D-211) |
| `app/src/tune/candidate.ts` | `editToml`, `writeCandidate`, `diffProfiles`, `installProfile`, `uninstallProfiles` |
| `app/src/tune/evidence.ts` | `GRADE_MARKERS`, `trajectoryText`, `writeEvidence`, `scanTree`, `EvidenceLeak` |
| `app/src/tune/prompts/*.md`, `prompts.ts`, `prompts/LICENSE-harness2` | the stage prompts (task 6), `stagePrompt(stage, round)`, and harness2's Apache-2.0 text |
| `app/src/tune/sessions.ts` | `parseSubmission`, `runSession` |
| `app/src/tune/library.ts` | `addEntry`, `rebuildIndex`, `copyLibrary` |
| `app/src/tune/offline.ts` | `runTune`, `accept`, `tuneEstimate` |
| `app/src/cli/tune.ts`, `main.ts`, `paths.ts` + | `tuneCommand` and `preflightTune`; `tune` in the dispatch and `--help`; `tuneDir(h) = <h>/tune` |
| `engine/tests/test_profile_check.py`, `app/test/tune/*.test.ts`, `app/test/cli/tune.test.ts`, `app/test/fixtures/tune/*.json` | below |

## Tasks

1. [ ] **`TUNABLE` and `check_tunable`** (D-207). `TUNABLE` maps each dotted key of architecture §7.2 to its bound: an int or float range, a bool, or an enum tuple. `FROZEN` lists §7.2's frozen keys. `check_tunable` compares `effective(base)` and `effective(candidate)` and returns one line per problem:
   - a key outside `TUNABLE` whose value differs: `<key> is frozen`;
   - a tunable value out of bounds: `<key> = <value>: must be <lo> to <hi>`;
   - guidance over 12,000 characters, or holding a CR or a NUL;
   - a base named `training-v4`.

   `{shell}` stays the only text `system_prompt` substitutes; nothing new is substituted.
2. [ ] **`profile.check`** in `service.py`, as architecture §3.1 pins it.
   - A `path` that isn't an absolute string, or a `base` that is neither a string nor null, gives -32602.
   - The folder loads with `profiles._load(folder.name, folder, "user")`, so the name rule applies. A `ProfileError` gives `ok: false` with that error, null hashes and `changed: []`. An unknown `base` does the same.
   - `changed` is the sorted dotted keys whose effective values differ, then `"guidance"` when the text differs. `errors` is `check_tunable`.
   - Profile content never raises.
   - `contract_info` adds `path` (the profile's absolute folder) to each profile, beside step 2's `agent_api` and `limits`, so the tuner can read a built-in base's files.
3. [ ] **Wiring.**
   - `Session.checkProfile` sends `profile.check` on the engine link.
   - `runEval({ledger: false})` skips its ledger line, so a tune writes one line of its own (D-211).
4. [ ] **`candidate.ts`** (D-207, D-208).
   - **`editToml(text, edits)`** edits the base's `profile.toml` text a line at a time. For `<table>.<key>`:
     - an existing `key = …` line inside `[table]` gets its value replaced, and a trailing `# comment` is kept;
     - a missing key goes after the table's last key line;
     - a missing table is appended.

     Values are written as TOML: bools, integers, floats with a `.`, and strings JSON-quoted. Comments and key order are otherwise untouched.
   - **`writeCandidate(dir, base, edit)`** writes `profile.toml` and `guidance.md` as LF UTF-8 bytes with no BOM. `guidance: null` means the base's text.
   - **`diffProfiles(a, b)`** returns `git diff --no-index --no-color --no-ext-diff` of the two folders' files, run through `stripKeys`; exit 1 means "differs".
   - **Where candidates live.** Each is written under `<out>/rounds/<r>/profiles/<name>/`. `installProfile` copies it to `<home>/profiles/<name>/` only while runs need it, refusing an existing folder. `uninstallProfiles` removes only the folders this tune installed.
5. [ ] **`evidence.ts`** (D-204, D-205). `writeEvidence(dir, spec)` writes architecture §7.3's layout, plus `stage.md` and `harness/system_prompt.md`.
   - **`stage.md`** holds `stage: inv|dom|compose|reflect`, `round: <r>` and `attempt: <n>`.
   - **`harness/system_prompt.md`** is prompt v4, read-only.
   - **`tasks/<id>/task.md`** holds the task text. A read task's input file names and sizes are listed, never their contents. For a repo task: `test_hint` with `{python}` left as is, and the file count.
   - **`tasks/<id>/<label>/`** holds one folder per run, labelled `ref`, `inv`, `dom` or `composed`:
     - `trajectory.md` is `trajectoryText(record)`: a header (turns, sub-calls, submitted, infra kind), then per turn the reply, code, output as recorded and error. Each sub-call is one line under the turn its `origin` names: id, prompt characters, `ok` or the error, and the first 200 characters of its answer. Children and `compactions` follow. Reasoning is left out.
     - `deliverable.md` is the record's `diff` (repo) or the JSON answer (read), cut at 60,000 characters with a marker.
   - **`candidates/<label>/`** holds `diff.md` and `notes.md`. `history.md` holds earlier rounds' composer notes, nothing else. `library/<domain>/` comes from `copyLibrary`.
   - **What each stage sees** (D-204):
     - **Editors:** the incumbent's reference run of every tune task.
     - **Composer:** the probe tasks' `ref`, `inv` and `dom` runs, and both candidates.
     - **Reflector:** all of that, plus the composed profile's tune-split runs.

     No session ever sees a held-out task, a grade or an acceptance result. Records come only from each eval's `runs.jsonl`, with `rerun/runs.jsonl` records in place of their originals, as `readGrades` does, filtered to the tune split.
   - **The guard, modelled on `context.py`:**
     - **It throws `EvidenceLeak`** for a read of `grades.jsonl`, `grade-logs/` or the set's `hidden/`, and for a record carrying `gold`, `f2p`, `p2p`, `grading`, `pass` or `f2p_share`.
     - **After writing, `scanTree` throws** if any file name or content holds a `GRADE_MARKERS` string: `"f2p_share"`, `"test_tamper"`, `"leak_suspect"`, `"grade_error"` or `<testsuites`.
     - **It withholds a run** whose own text holds the set folder's path (either separator, case-folded on Windows and macOS), a hidden tar member's path, an f2p or p2p id, or a marker. Its two files become one line: `(withheld by the evidence guard)`, as `_WITHHELD_NOTE` withholds.
     - **If every run of the stage is withheld, it throws,** like `build` at L177.
6. [ ] **Prompts** (D-206). `app/src/tune/prompts/` holds one file per part.
   - **The notice.** Each file opens with an HTML comment carrying harness2's copyright and Apache-2.0 notice, its source (`harness2/core/prompts.py` or `context.py`, the line range, commit `6868817…`) and a line saying what rlm-harness changed. `LICENSE-harness2` is harness2's `LICENSE`, copied.
   - **Loading.** `prompts.ts` imports each file as text (`with { type: "text" }`, so the binary carries it), strips the comment, and joins a stage's parts in harness2's order with `_tidy`'s rule.
   - **Kept nearly verbatim:**
     - `answer-free.md` (ANSWER_FREE) and `evidence-boundary.md` (EVIDENCE_BOUNDARY, with "files under `context/`" becoming "your input files");
     - `keep-base.md` (`_KEEP_BASE`);
     - `propose.md` (propose's frame and its "HOW TO DECIDE WHAT TO CHANGE"; from round 2, its `round_t` paragraph);
     - `compose.md` (aggregate's "WHAT YOU HAVE", "HOW TO WEIGH THE EVIDENCE", "YOUR JOB" and "NOTES FORMAT", with "k rollouts" read as "one rollout per probe task"; from round 2, compose_round's "KEEP_BASE means keep the CURRENT checkpoint");
     - `reflect.md` (experience, all sections);
     - `mission.md` (`mission`'s evidence pointer, with "on disk, in `context/`" becoming "in your `context`, one part per file").
   - **Changed:**
     - `inv.md` and `dom.md` keep the dimension, the scope split and the rules. Scripts, skills, hooks and subagents become what our harness has: always-on `guidance.md` text, short REPL recipes written in it, and (INV only) the TOML levers.
     - `generalize.md` keeps "procedure for the domain" and the library paragraph. It drops "write the workspace fact itself", because an offline profile serves every task, so a fact from one tune task is overfitting; step 9's online prompt keeps it.
     - `work.md` is our THE WORK and DOMAIN AND TASK LENS: `rlmh`, repo tasks with tests (Python packages, websites under Playwright, CUDA kernels for an LLM engine), and long-input research and search tasks.
   - **Ours:** `surface.md` (WHAT YOU CAN CHANGE: the §7.2 table and the frozen list, replacing `_SURFACE_OPENCODE`) and `submit.md` (task 7's shapes).
   - **Dropped:** `select()` and its `*_SELECT` blocks, because offline acceptance uses labels (D-173); the `_tts_*` pack (JobBench); and `_SURFACE_CODEX`.
7. [ ] **`sessions.ts`** (D-210). `runSession(stage, …)` starts one read run through the tune's `Session`:
   - question `stagePrompt(stage, round)`; `inputs` the evidence files, sorted;
   - profile `default`, the tuning `root` and `sub`, `accept-edits`, `interactive: false`;
   - `tag` and `logDir` are arguments: `rlmh tune` passes `tune:<tune id>:r<r>-<stage>` and `<out>/rounds/<r>/sessions/`, and `/tune` (step 9) passes its own.

   Sessions submit one JSON object as a string, `submit(json.dumps({...}))`, because `valid_answer` refuses a dict and `normalize_answer` turns one into its `str()`. `parseSubmission` takes the `answer` string, `JSON.parse`s it and checks the shape:
   - **Editors:** `{decision: "EDIT"|"KEEP_BASE", notes: [str], guidance: str|null, toml: {}}`. DOM's `toml` must be empty.
   - **Composer:** `{decision: "MERGE"|"ADOPT"|"REVISE"|"KEEP_BASE", adopt: "inv"|"dom"|null, notes, guidance, toml}`. `adopt` is set exactly when the decision is ADOPT.
   - **Reflector:** `{domain: "read"|"repo", entry: "NO_ENTRY"|{cue, lesson, evidence, confidence: "high"|"medium"|"low"}, edits: [{component, candidates, change, observed, verdict}]}`, where the verdict is `helped`, `hurt`, `no observed effect` or `confounded`.

   Any `GRADE_MARKERS` string is an error, as `assert_tree_has_no_grader_verdicts` refuses one.
   - **Checking an edit.** An EDIT, MERGE or REVISE is written by `writeCandidate` and checked with `checkProfile(path, incumbent)`; an edit that changes nothing counts as KEEP_BASE (`_accept_tree`).
   - **An infra error, a shape error or `ok: false`** gets one retry. The retry has `attempt: 2` in `stage.md`, and the question gains `# YOUR PREVIOUS ATTEMPT WAS REJECTED` followed by the errors (L190).
   - **A second failure keeps the base,** with `fell_back: true` (`_run_stage`).
   - **The result.** Each stage returns `{decision, value, attempts, fell_back, errors, run_ids, cost_usd}`.
8. [ ] **`library.ts`** (D-175, architecture §7.7). `addEntry(root, domain, id, entry, edits, harness)`:
   - writes `entries/<id>/EXPERIENCE.md` (cue, lesson, evidence, confidence, then the edits as a table) and `entries/<id>/harness/` (the composed `profile.toml` and `guidance.md`);
   - then runs `rebuildIndex`, which rebuilds `INDEX.md` from the folders on disk: one `- <cue> -> entries/<id>/EXPERIENCE.md` line per entry, sorted by id.

   NO_ENTRY writes nothing; the edit rows still go to `rounds/<r>/reflect.json`. A marker anywhere makes it throw (`Library.add`). The entry id is `<tune id>-r<r>`. `copyLibrary` copies both domains into the evidence.
9. [ ] **`offline.ts`**: `runTune(opts, deps)` runs architecture §7.5, one `Session` for the whole tune. Rounds are budget-driven (D-212), with `--rounds` as the maximum:
   - round 1 always runs;
   - before each later round, `tuneEstimate` prices that round again, with tokens from `--tokens-from`, `--from`'s `runs.jsonl` and every `runs.jsonl` this tune has written;
   - the round runs only when that estimate fits under `cap − spent`. Otherwise the tune ends normally, with `budget_stop: <r>` in `tune.json` and exit 0.

   For each round *r*:
   1. **Reference.** The incumbent's latest tune-split eval: `--from` in round 1, then the last accepted composition's accept eval. It is never re-run.
   2. **Edit.** Evidence, then the INV and DOM sessions. With no valid EDIT the round ends as `no_candidates`.
   3. **Probe.** For each candidate, `installProfile`, then `runEval` on the probe ids into `rounds/<r>/evals/<label>/`, with `ledger: false`. The probe ids are `selectTasks(set, {split: "tune", sample: probe, seed})`, fixed for the tune.
   4. **Compose.** On KEEP_BASE the round skips the accept step. ADOPT copies the candidate as `<NAME>-r<r>`.
   5. **Accept.** `runEval` of `<NAME>-r<r>` on the whole tune split. Tasks with a transient `infra_kind` (`rate_limit`, `server`, `timeout`, `network`, `worker`, `runlog`, `other`) are rerun once into `<eval out>/rerun/`, as `rlmh eval --rerun` does. Then `accept(readGrades(ref), readGrades(new))` (D-173, D-209):
      - it leaves out only tasks whose `infra_kind`, after the rerun, is transient or a setup kind (`auth`, `no_key`, `unknown_model`, `workspace`, `host_bug`) on either side. `context_window`, `bad_request` and `capped` count as fails, as in step 5, because they are how the profile behaved. The reference's own reruns, such as step 5's, count through `readGrades`;
      - it accepts when the pass count is at least the incumbent's + 1, the mean `f2p_share` over repo tasks is not lower, and the mean `cost_usd` is at most 1.5× the incumbent's;
      - with more than a quarter of the tune split left out, the incumbent stays, with reason `infra`.

      `offline.ts` is the only tune module that reads grades, always through step 2's `readGrades`, and only these fields.
   6. **Reflect.** The reflector session, then `addEntry`.

   **The budget.** Every `runEval` gets `maxUsd = cap − spent`. A `CostCap` on the session bus cancels a session that crosses the cap. `spent` adds each eval's grade-line `cost_usd` and each session's `cost_usd`. A capped eval or a cancelled session stops the tune with `stopped: "max_usd"`, and the incumbent stays.

   **However the tune ends**, `finally` uninstalls the candidates and writes `tune.json`:
   - `set` hashes, `base`, `name`, the models, `probe` (k, seed, ids), `from`, the harness version and commit, the estimate, the cap, the times and `stopped`;
   - per round, the incumbent and its `profile_hash`, and each stage's decision, attempts, `fell_back`, errors, `profile_hash`, run ids and cost;
   - the eval folders, `accept` (compared, excluded ids, both sides' passed, mean `f2p_share` and mean cost, `accepted`, reason) and the round cost;
   - `final`, and `counts: {rollouts, sessions}` with costs (`ledger.py`'s R and P).

   It also copies the final incumbent to `final/`, installs it as `<NAME>` only if a round was accepted, and appends one ledger line, `what: "tune"`, with the whole cost (D-211).
10. [ ] **`cli/tune.ts`.**
    ```
    rlmh tune SET --root P/M [--sub P/M] --base PROFILE --name NAME (--from EVAL_OUT | --continue OUT)
                  [--rounds 2] [--probe 10] [--seed 0] [--jobs 4] [--tokens-from RUNS.jsonl]... [--out DIR]
                  [--go] [--max-usd X] [--json]
    ```
    - **`--from` is required unless `--continue`**, because the tuner never runs the base itself; make it with `rlmh eval SET --split tune|all --profile BASE --go`.
    - **`--continue OUT`** resumes a finished tune (`stopped: null`): its incumbent, reference, probe ids, history and library. The rounds go on up to the new `--rounds` total, into the same `OUT`.
    - **`--out`** defaults to `<home>/tune/<NAME>-<YYYYMMDD-HHMMSS>/`.
    - **Pre-flight before the engine** returns 2 for:
      - a missing flag, a bad set, or a `--probe` larger than the tune split;
      - a NAME that breaks the profile name rule or is longer than 56 characters;
      - an `--out` that isn't empty;
      - an existing `<home>/profiles/<NAME>*`;
      - a `--from` without `eval.json`, `runs.jsonl` or `grades.jsonl`, with other set hashes, or missing a tune task.
    - **Checks after `engine.info`, still before any spend,** also return 2: NAME is a built-in's name; the base is unknown or `training-v4`; `--from`'s `profile_hash` or models differ from the base's and the flags'.
    - **`--rounds`** is a maximum, 2 by default; budget decides how many run (task 9).
    - **Without `--go`**, `tuneEstimate` prints every round's stages, marking the rounds that fit under the cap after round 1:
      - rollouts priced by step 2's `estimate()`: 2 × probe plus the tune split per round, with tokens from `--tokens-from`, defaulting to `--from`'s `runs.jsonl`;
      - 4 sessions per round, each at root 0.3M in and 20K out, sub out 30K, and sub in of the stage's evidence characters ÷ 3. The evidence is measured with `trajectoryText` over `--from`: E for each editor, 3E × probe ÷ tune for the composer, 2E for the reflector;
      - then the total, the cap (default 2× the estimate), and the ledger total against $30.

      It exits 0 and writes nothing.
    - **Output.** Plain mode prints one stdout line per stage and per accept, then a final line. `--json` prints `tune.stage`, `tune.round` and `tune.finished` lines.
    - **Exit codes:** 0 when every round ran, accepted or not; 1 when stopped; 2 for usage; 130 for Ctrl-C (the first cancels and stops, as in batch).
11. [ ] **Docs.** CLAUDE.md's command table gains `rlmh tune` (estimate, `--go`) and `bun test test/tune`. architecture.md gets the edits D-204 to D-212 imply (§2, §3.1, §7.3 to §7.5, §12), named in the progress log.

## Tests

All offline. Engine tests use the link as `test_service` does. App tests use `buildFixtureSet`, a temp `RLMH_HOME`, the real engine on `fake/scripted`, and the fixture venvs `ensureVenv` builds with `UV_OFFLINE=1`, as step 2's tests do. `app/test/fixtures/tune/stage-script.json` is one root tool call whose code branches on `context`:
- `stage: inv` submits an EDIT that adds one guidance line and `read.max_turns = 60`;
- `stage: dom` submits KEEP_BASE;
- `stage: compose` submits ADOPT `inv`;
- `stage: reflect` submits one entry;
- with no `stage:`, it acts as step 2's eval script: a fix in `fx-repo-S-01`, the line count in read mode.

`fail-script.json` is the same script without the fixes. Test files:

- **`engine/tests/test_profile_check.py`:**
  - `default` against itself is ok with `changed: []`;
  - every `TUNABLE` key at its bounds is ok, and just past them is an error;
  - every `FROZEN` key changed is an error naming it;
  - guidance of 12,001 characters, or with a CR, is an error;
  - a `training-v4` base and broken TOML give `ok: false`;
  - a relative path gives -32602;
  - `engine.info`'s profiles carry `path`;
  - **drift:** the bounds table in `app/src/tune/prompts/surface.md` equals `TUNABLE` and `FROZEN`.
- **`candidate.test.ts`:**
  - `editToml` keeps comments and order, replaces a value, inserts a missing key into its table and appends a missing table;
  - the result passes `checkProfile`;
  - the bytes are LF;
  - `diffProfiles` shows the change;
  - uninstall leaves a folder the tune didn't make.
- **`evidence.test.ts`:**
  - each stage's layout;
  - a `trajectoryText` snapshot from a hand-made record;
  - planted leaks: reading `grades.jsonl`, `grade-logs/x` or `hidden/x.tar.gz` throws; a record with `gold` throws; a marker in a file name throws from `scanTree`;
  - a run naming a hidden test path, or the set path written with `\`, is withheld while the others stay; all withheld throws;
  - with an `all`-split `--from`, no held-out id appears anywhere.
- **`prompts.test.ts`:**
  - each stage renders, with ANSWER_FREE and EVIDENCE_BOUNDARY, no comment, no markers and no `{{`;
  - round 2 adds the two round paragraphs;
  - every file's notice names `prompts.py` (or `context.py`) and `6868817`;
  - a snapshot per stage.
- **`sessions.test.ts`:**
  - `parseSubmission` accepts each shape and rejects: a Python dict `str()` (its error suggests `json.dumps`), DOM `toml`, ADOPT without `adopt`, a bad verdict and a marker;
  - with the real engine: a frozen-key edit then a valid one gives `attempts: 2` and a question with the rejection header; two bad attempts give `fell_back`.
- **`library.test.ts`:**
  - NO_ENTRY writes nothing;
  - an entry writes its files and its INDEX line;
  - deleting an entry folder and rebuilding drops the line;
  - a marker throws.
- **`offline.test.ts`:**
  - `accept()` on a table: +1 accepted; equal rejected; lower `f2p_share` rejected; 1.6× cost rejected; infra excluded; a rerun line replaces its original; more than a quarter excluded gives `infra`;
  - a composed-side `server` infra task is rerun once into `rerun/`, and an `auth` one is not;
  - with a capped fake `runEval` dep: `stopped: "max_usd"`, no later stage, `tune.json` and one ledger line written, nothing left installed;
  - when round 2's re-estimate exceeds `cap − spent`, round 2 doesn't start, `tune.json` has `budget_stop: 2`, and the exit is 0.
- **`estimate.test.ts`:** every stage is listed, priced for S-43's models from the bundled catalog; the default cap is 2×; `--from` supplies the tokens.
- **`cli/tune.test.ts`:**
  - **Accepted round.** `--from` comes from `rlmh eval fixture --split tune --go` under `fail-script.json`; then `tune --probe 1 --rounds 1 --go --json` under `stage-script.json`:
    - the round is accepted, and `final/` equals the INV candidate;
    - `<home>/profiles/<NAME>` exists, and nothing named `-r1-*` is left;
    - one library entry, one `tune` ledger line;
    - no evidence tree holds a marker or a held-out id;
    - exit 0.
  - **Rejected round.** The same run from a passing `--from` is rejected, with `final/` equal to the base and no `<NAME>` installed.
  - **Continue.** `--continue` adds round 2.
  - **Without `--go`:** the estimate prints, nothing is written, $0.
  - **Exit 2** for: `--base training-v4`, `--name default`, another set's `--from`, a `--from` with another `profile_hash`, and a non-empty `--out`.

## Done when

- The full verify gate passes, including `test_profile_check.py`, `test/tune` and `test/cli/tune.test.ts`.
- CI is green on macOS, Windows and Linux. The `git diff --no-index`, profile install and path-folding tests are the Windows-sensitive ones.
- In a temp home, the cli test's rehearsal (`rlmh tune <fixture> --root fake/scripted … --go`) costs $0.00 and exits 0.
- Parity is unaffected: `training-v4` and its files are unchanged, and `test_contract` passes.

## Out of scope

- The real run (step 7), the held-out check and shipping (step 8), and `/tune`, `online.ts` and user domains (step 9).
- Injecting the library into ordinary runs (D-175).
- Repeats per task (D-170).
- Prompt v4, the call format and the `python` tool, which are frozen (S-09, S-14).

## Hand-off

- **Step 7 relies on:**
  - the command line above, with `--base` a user profile (step 5's `v1-baseline`, a byte copy of the built-in `default`);
  - budget-driven rounds;
  - the estimate's stage table;
  - `--max-usd` across the whole tune;
  - `tune.json`, `final/` and the one ledger line;
  - `--continue` for a third round.
- **Step 9 relies on:**
  - `evidence.ts`, `sessions.ts`, `library.ts`, `candidate.ts` and `prompts.ts`;
  - `stagePrompt` gains an online variant whose `generalize.md` keeps the workspace-fact paragraph;
  - `profile.check`.
- **progress.md row 6:** `review`, with the CI run and the D-numbers given to D-204 to D-212.

## If a decision goes the other way

- **D-173, a different margin:** only `accept()`'s constants and its test table change.
- **D-174, a stronger editor model** (the paper used Claude Opus 4.8):
  - add `--editor-root`/`--editor-sub`, passed only to `runSession`;
  - the estimate prices sessions at that model;
  - nothing else changes.
- **D-209, no reruns:** drop the composed-side rerun, so `accept()` simply excludes every infra task. That is cheaper, but one rate-limit burst can then fail a round.
- **D-205, fail the stage instead of withholding** (harness2's behaviour): `writeEvidence` throws where it now withholds, and the stage keeps its base.
- **D-212, fixed rounds:** drop the re-estimate check, and `--rounds` runs exactly, with the cap as the only stop.
- **D-210:** if the contract ever accepts dict answers, `parseSubmission` takes either form, and `submit.md` keeps `json.dumps`, so prompt bytes don't change.
