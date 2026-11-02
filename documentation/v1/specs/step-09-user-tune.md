# Step 9. Harness² for users: `/tune` and the experience library

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0. There is one optional live check, at most $1 from the reserve row, and only after Rishi's go |
| **Depends on** | 4 (follow-ups and their setting) and 6 (the tuner modules and `profile.check`); 2 through 6 |
| **Unblocks** | 10 |
| **Parallel with** | 5, 7, 8 |
| **Decisions it uses** | S-09 (one `python` tool), S-14, S-44, S-47 (follow the paper and the code); D-15, D-28 (batch task shape), D-62 and D-133 (env stripping), D-138 and D-165 (safe git), D-144 (user profiles), D-174 (sessions), D-175 (the library), D-178 (follow-ups). New here: D-215 to D-221 |

## Goal

A user types `/tune` in the interactive app and gives it one to five of their own tasks. `rlmh` runs Harness²'s online loop on each task in turn, at k = 1, as the paper and `schedule.py` do. For each task:
- a reference run;
- an INV editor and a DOM editor;
- a probe run of each candidate;
- a composer;
- a run of the composed harness;
- a reflector, which writes at most one lesson to the user's experience library.

The result is a user profile, `tuned-<YYYYMMDD-HHMM>`, which `/tune` offers to switch to.

Three rules hold throughout:
- **Nothing runs before the user has seen a cost estimate and said yes.**
- **The user's folder is never touched.** Repo tasks run in throwaway worktrees at `HEAD`, or in copies.
- **`tune.max_usd` is a hard stop.**

## Read first

- [../README.md](../README.md) and [../architecture.md](../architecture.md), whole files. §7 is the design, and §7.6, §7.7, §8 and §9 are this step.
- [../../v0/architecture.md](../../v0/architecture.md) §7.6 to §7.8 (profiles, sessions, the record). [../../v0/decisions.md](../../v0/decisions.md), whole file.
- Specs, whole files: [step-02-rlmh-eval.md](step-02-rlmh-eval.md), [step-04-follow-ups.md](step-04-follow-ups.md) and [step-06-tuner.md](step-06-tuner.md).
- **The paper.** Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", [arXiv 2610.14224](https://arxiv.org/abs/2610.14224) ([Hugging Face](https://huggingface.co/papers/2610.14224)). In a cloud container, read it as `hf://papers/2610.14224/paper.md`. Read:
  - §2.2.1, the contrastive step: Propose, Probe and Compose;
  - §2.2.2, "At k = 1, both forms reduce to the basic contrastive step and bypass selection";
  - §2.3, the reflector and the library, and that the next task starts from H0;
  - Appendix D.2: retry an invalid session once, then inherit; one library per domain;
  - Appendix E.2 and E.6: what the library carries, and how runs regress;
  - Appendix H: the prompts.
- **The code**, [google-research/harness2](https://github.com/google-research/harness2) at `6868817518876de8fd170c6a8354daca273b6191` (Apache-2.0). Read these line ranges:
  - `schedule.py`:
    - [`run_task` L619–735](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/schedule.py#L619-L735): reference rollouts, then a mode, then selection; and a task whose base runs all fail.
    - [`run_domain` L737–801](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/schedule.py#L737-L801): tasks in order, with `lib.retain` threading the library forward.
    - [`_run_one_mode` L523–617](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/schedule.py#L523-L617): `trivial_selection` at k = 1, the reflector only after an ok selection, then `Library.add`.
  - `recursion.py`:
    - [`STAGE_ATTEMPTS` L36](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/recursion.py#L36)
    - [`_accept_tree` L114](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/recursion.py#L114)
    - [`_run_stage` L141–262](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/recursion.py#L141-L262): one retry, then fall back to the base tree.
    - [`_roll` L271](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/recursion.py#L271)
    - [`run_parallel` L354–460](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/recursion.py#L354-L460): at k = 1, `inv1` and `dom1`, both probed, then `agg1`, which is rolled out.
  - `selection.py`: [`trivial_selection` L360–399](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/selection.py#L360-L399), [`reflect_adoption` L402–451](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/selection.py#L402-L451) and [`_distil` L454–505](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/selection.py#L454-L505).
  - `library.py`: [`retain` L101](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/library.py#L101), [`add` L106–152](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/library.py#L106-L152) (nothing is written without an experience) and [`rebuild_index` L154](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/library.py#L154).
  - `context.py`: [`build` L105](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/context.py#L105), [`assert_no_leak_paths` L399](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/context.py#L399) and [`assert_no_grader_verdicts` L454](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/context.py#L454).
  - `prompts.py`: `GENERALIZE` L295, `_INV_TEMPLATE` L347, `_DOM_TEMPLATE` L372, `propose()` L824, `aggregate()` L893 and [`experience()` L1105](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/prompts.py#L1105).
- App code, whole files:
  - `app/src/tune/` (every file step 6 wrote, `prompts/` included) and `app/src/eval/runner.ts` (`runEval`, the shared entry point, and `CostCap`);
  - `app/src/eval/estimate.ts`, `app/src/eval/work.ts`, `app/src/session.ts`, `app/src/settings.ts`, `app/src/paths.ts`, and `app/src/engine.ts` (`stripKeys`, `splitCommand`);
  - `app/src/interface/App.tsx`, `store.ts` (`applySetting`), `runs.ts` (`listRuns`), `approvals.ts`, and `commands/{index.ts, settings.tsx, runs.tsx, common.tsx}`.
- Engine: `engine/rlm_engine/workspace.py`, for `GIT_ARGS` (L41) and `no_filters` (L186). The worktree code here mirrors both.
- Tests: `app/test/fakes/engine.ts`, `app/test/interface/helpers.ts` and `app/test/interface/commands.test.tsx`, whole files.

## Starting state

- Steps 2, 4 and 6 are `done`:
  - `runEval`, `CostCap` and `estimate.ts` exist (step 2);
  - follow-ups exist, and a profile or mode change closes the open conversation (step 4);
  - `tune/evidence.ts`, `sessions.ts`, `candidate.ts`, `library.ts`, `prompts/` and `profile.check` exist (step 6).
- There are 7 screen commands plus `/clear` and `/quit`, and `MENU_MAX = 9`. `SettingType` is `string | enum | int | bool`.

## Deliverables

| File | What |
|---|---|
| `app/src/tune/online.ts` | `planTune(input, deps): TunePlan`, `estimateTune(plan, deps): TuneEstimate` and `runTune(plan, deps, onEvent): Promise<TuneResult>`, the per-task loop below. *KV cache: none* |
| `app/src/tune/worktree.ts` | `workCopy(folder, dest): Promise<WorkCopy>` (`{path, kind: "worktree" \| "copy", remove()}`), `pruneStale(home)`, `runTest(cmd, cwd): Promise<{exit, timedOut, seconds}>` |
| `app/src/tune/library.ts` (+) | `userDomain(task)`: `read`, or `repo-<slug of the folder's name>`. The root is `libraryDir(home)` |
| `app/src/interface/commands/tune.tsx` | `TuneScreen`, with the states entry → estimate → running → result |
| `app/src/interface/commands/index.ts`, `App.tsx` (+) | `tune` in `COMMANDS`; `MENU_MAX = 10`; a question typed while a `/tune` runs is refused, with a note |
| `app/src/settings.ts` (+) | `SettingType` gains `number`; adds `tune.max_usd` (number, `1.00`) and `tune.library` (bool, `true`), after step 4's key |
| `app/src/paths.ts` (+) | `libraryDir(h)`; `tuneDir(h)` is step 6's |
| `app/test/fakes/engine.ts` (+) | `createFakeApp({tune})` and a `profile.check` handler (see Tests) |
| Tests | `app/test/tune/online.test.ts`, `app/test/tune/worktree.test.ts`, `app/test/interface/tune.test.tsx`, and additions to `app/test/settings.test.ts` |
| Docs | architecture.md §2, §7.6 and §8 as listed in Hand-off; decisions.md D-215 to D-221; CLAUDE.md gains one line on `/tune` |

## Tasks

1. [ ] **Settings and paths.**
   - `number` parses a finite value above 0, is written to TOML as a float, and is edited in `/settings` like `int`.
   - `rlmh config set tune.max_usd 2.5` works, and `0`, `-1` and `abc` are refused (D-220).
2. [ ] **`worktree.ts`** (D-219).
   - **A git folder.** Run `git <GIT_ARGS> -C <top> worktree add --detach <dest> HEAD`.
     - `GIT_ARGS` is the same as `workspace.GIT_ARGS`, so `core.hooksPath` is the null device.
     - The env comes from `stripKeys(process.env)`, with every filter driver blanked as `no_filters` does.
     - A folder below the top maps to the same subfolder inside `dest`.
     - A repo with no commit is refused, with a reason.
     - `remove()` runs `git worktree remove --force`, then `git worktree prune`.
   - **Any other folder** is copied without following links, skipping `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`, `dist`, `build` and `target`. Above 20,000 files or 1 GB it is refused, and the size is counted before the estimate.
   - **Leftovers.** Each work copy has a `work.json` (`{folder, kind}`). `pruneStale` removes any copy an earlier `/tune` left, after the next yes.
   - **`runTest`.**
     - Splits the command with `splitCommand`, with no shell; `.cmd` and `.bat` go through `cmd /c` on Windows, as in `findEngine`.
     - Runs it in the work copy with `stripKeys(process.env)` and a 600 s limit.
     - Writes its output to `<tune dir>/tests/t<i>-<stage>.log`, and returns only the exit code.
3. [ ] **`planTune` and `estimateTune`** (D-218, D-221).
   - **Input.** Either typed tasks or a `tasks.jsonl` file:
     - Typed tasks are parsed as questions are: `@` mentions make a read task with those inputs, and no mention makes a repo task in the app's folder. One optional test command applies to typed repo tasks.
     - A file uses D-28's shape plus an optional `test` per repo task, with paths relative to the file. More than five tasks, a `gold` field, or a missing path is refused with the line number.
   - **Base.** The base is the `profile` setting. `training-v4` is refused.
   - **The estimate, per task:**
     - 4 × *m*, where *m* is the median `costUsd` of the last 20 records under `runsDir(home)` with the same mode and root model, leaving out `tune-*` batches and infra runs. With no such run, *m* comes from §6.6's row priced through `estimate.ts`: R for read, M for repo.
     - Plus *n* × *s*, where *n* is 4 sessions (3 when `tune.library` is false) and *s* is the median cost of earlier `/tune` session runs on that model: records under `runsDir(home)/tune-*/` whose tag ends in `-inv`, `-dom`, `-compose` or `-reflect`. With none, *s* is §6.6's R row.
   - The plan lists, per task, its mode, its folder and `HEAD`'s short hash (or "copy"), and its test command.
4. [ ] **`runTune`**, task by task, with incumbent H = the base (D-215, D-216, D-217, D-218). Stages run one at a time, in the order below. harness2 runs the two editors and the two probes in parallel; running them one by one keeps approvals one at a time and the order fixed, for the same cost.
   - **Every run:**
     - goes through step 2's `runEval` with this task alone, `out` = `<tune dir>/t<i>/<stage>/`, `logDir` = `runsDir(home)/tune-<id>/` and no grading, so `/runs` lists it;
     - uses `conversation: false`, `batch: tune-<id>` and `tag: tune:<id>:t<i>-<stage>`;
     - uses the user's root and sub models, and the user's next-run permission mode with `interactive: true`, so approvals show as usual;
     - in repo mode, gets a fresh `workCopy`, removed after the run (and after its test, if any).

     If `runEval` lacks an option this needs (an in-memory task, a work-copy hook, mode and `interactive` overrides, no grading), add it in `runner.ts` with a test, and log the change.
   - **`ref`.** Run H. If it ends with an infra error or delivers nothing (no submit in read mode), the task is `skipped`, as in `run_task`, H stays, and no session runs.
   - **`inv` and `dom`.**
     - Write evidence over `ref` with `evidence.ts`, and add `library/` only when `tune.library` is on.
     - Run the two editor sessions (D-174) on the user's root model, with the built-in `default` profile, through step 6's `runSession` with `tag` `tune:<id>:t<i>-<stage>` and the same `logDir`. The composer and reflector sessions below do the same.
     - Write each `EDIT` result as `<home>/profiles/<id>-t<i>-inv` (or `-dom`) through `candidate.ts`, and check it with `profile.check {base: H}`.
     - An invalid result gets one retry with the errors appended, then becomes `KEEP_BASE`, as `_run_stage` does.
   - **`probe-inv`, `probe-dom`.** Run each candidate that differs from H. A candidate equal to H is not run, and the composer is told that its probe is `ref` (D-216).
   - **`compose`.** The composer session gets `ref`, the probes, the diffs and the notes. It writes `<id>-t<i>-composed`, or keeps H.
   - **`composed`.** Run it, unless it equals H.
   - **Delivery** (D-218). The composed harness becomes the new H, except in these cases, where H stays:
     - its run had an infra error or delivered nothing;
     - the task has a test command, `ref`'s exit code is 0, and `composed`'s is not.

     Test results never enter evidence or the library.
   - **`reflect`.** Only when `tune.library` is on and the composed run delivered. The reflector writes through `library.ts` to `libraryDir(home)/<userDomain>/`. `NO_ENTRY` writes nothing.
   - **The cap.** One `CostCap` at `tune.max_usd` covers every run and session. When it trips, the running runs are cancelled and nothing new starts. The current task's stages are dropped, and the result is H as the last finished task left it. The user's stop (Esc, then `y`) does the same.
   - **The end.**
     - If H differs from the base, copy it to `<home>/profiles/tuned-<YYYYMMDD-HHMM>/` (with `-2`, `-3` and so on when the name is taken).
     - Remove the `<id>-t<i>-*` profiles.
     - Write `<tune dir>/tune.json`: per stage, its profile hash, decision, cost, exit code and run id.
     - `<tune dir>` is `tuneDir(home)/<id>`, and the id is `t_<YYYYMMDD-HHMMSS>`.
5. [ ] **`tune.tsx`.**
   - **Entry.** A task field and a test-command field; Tab switches between them. Enter adds a task. Enter on an empty task field goes on. A task line of `@<file>.jsonl` loads that file.
   - **Estimate.**
     - Shows the per-task lines, the total, `tune.max_usd`, and "tunes on your last commit; uncommitted changes are not included".
     - Says that runs ask for approvals as your runs do.
     - `y` starts the tune. `n` or Esc goes back.
     - When the total is over the limit, there is no `y`; the screen says how to raise `tune.max_usd` in `/settings`.
   - **Running.**
     - One row per task: ✓ for a finished stage, ✱ for the running one, ○ for one not started.
     - The cost so far against the cap.
     - Approvals draw over the screen, as now.
   - **Result.**
     - Each task's outcome: composed kept, base kept and why, or skipped.
     - The changed keys and the cost.
     - `s` sets `profile` to the new profile with `applySetting`; this closes any open conversation (D-178). Esc closes the screen.
6. [ ] **Wire it in.** `tune` goes into `COMMANDS` with the summary "Improve your profile on your own tasks (Harness²)". `MENU_MAX` becomes 10, with its comment updated. `/help` lists it.
7. [ ] **Docs.** The architecture edits listed in Hand-off, the D-lines, a progress log line, and a CLAUDE.md line on `/tune`.
8. [ ] **Run the full gate.** Then do the hand checks under Done when.
9. [ ] **The optional live check**, on the PC, only after Rishi's go on its estimate.
   - `/tune` on one repo task in a scratch git repo outside both repos, with a test command, DeepSeek as root, and `tune.max_usd = 1`.
   - Record the cost in progress.md and the ledger (`appendLedger`, `what: "tune"`).

## Tests

Everything here is offline. The fake provider is `fake/scripted`, and no real key is used.

**Fakes.** `createFakeApp({tune: {stages: {"<stage>": {answer, costUsd, exit?}}}})`:
- finishes a run whose tag is `tune:*` with that stage's `answer`, and a `call.end` that carries `costUsd`;
- accepts any profile under `<home>/profiles/`;
- answers `profile.check` with `ok: false` when the guidance contains `INVALID`, and otherwise `ok: true` with `changed`.

Test commands are tiny scripts that exit 0 or 1.

**`app/test/tune/online.test.ts`**
- **The estimate.**
  - The medians skip `tune-*` batches, infra runs, and other modes and models.
  - With no history, the figures come from §6.6.
  - With the library off, there are 3 sessions.
  - Above the limit, `runTune` refuses.
- **Nothing before yes.** `planTune` plus `estimateTune` make no `run.start` and no gateway call, create no `<home>/tune`, and leave `git worktree list` unchanged.
- **A read task:**
  - the order is `ref`, then `inv` and `dom`, then the probes, then `compose`, `composed` and `reflect`;
  - every run has `conversation: false`, the batch and the tag;
  - `tuned-*` is written, and the `t_*` profiles are gone;
  - an entry's cue appears in `INDEX.md`, and `NO_ENTRY` adds nothing.
- **Keeping the base.** An editor's `KEEP_BASE` skips its probe. A composer's `KEEP_BASE` skips `composed`, and no `tuned-*` is written.
- **An invalid session** is retried once with the errors, then becomes `KEEP_BASE`.
- **Carrying forward.** Task 2's `ref` runs task 1's composed profile.
- **Tests decide delivery.**
  - With `ref` at exit 0 and `composed` at exit 1, the base stays. With both at 1, the composed harness is kept.
  - No evidence or library file contains the test log's text.
- **The cap.** The cap trips in task 2: a `run.cancel` is sent, there is no later `run.start`, and the result is task 1's harness.
- **Library off.** There is no `reflect` run, no `library/` in evidence, and `<home>/library` doesn't exist.
- **Refusals.** A `training-v4` base, six tasks, and a `gold` field are each refused.

**`app/test/tune/worktree.test.ts`** (needs git)
- The worktree is at `HEAD`: a file left uncommitted is absent from it.
- `remove()` leaves `git worktree list` as it was.
- A `post-checkout` hook and a `smudge` filter that each write a marker never run.
- A non-git folder is copied without the skip list, and is refused above a lowered limit.
- `pruneStale` removes a leftover copy.
- `runTest` returns the exit code, honours the timeout, and gets no `*_KEY` variable.

**`app/test/interface/tune.test.tsx`** (`mount` with `createFakeApp`)
- `/` lists ten commands, all visible.
- Typing two tasks shows the estimate. `n` goes back, and the fake engine saw no `run.start`.
- `y` shows the running rows. An approval stage draws its prompt, and `y` answers it.
- The result screen lists the outcomes, and `s` writes `profile = "tuned-…"` to `settings.toml`.
- Over the limit, there is no `y` and the screen shows the hint.
- Esc then `y` while running stops the tune.
- A question typed while it runs is refused.

**`app/test/settings.test.ts`**: the `number` type, and the two keys in `config list`.

## Done when

- The full gate prints `VERIFY: PASS`, and CI is green on all three OSes after Rishi's OK to push.
- **The hand check, on the fake provider.**
  - In a cloud container, run the pty and `pyte` check (CLAUDE.md) against the source app and engine on `fake/scripted`. Use a new `app/test/fakes/tune-demo-script.json`, whose root replies submit, in stage order, the shape each stage expects.
  - Then, on the PC, in Windows Terminal, in a git folder: `/tune` shows the estimate first. After `y`, `git worktree list` shows a worktree during each repo run and none after.
  - `<home>/profiles/tuned-*` exists, and `s` switches the profile.
- The live check is either done, with its cost logged, or marked "not run" in progress.md.

## Out of scope

- k > 1, the selector, and sequential mode (harness2's `seq`).
- Reading the library in ordinary runs (D-175).
- Applying a `/tune` run's diff to the user's folder. The diffs stay in the run records, where `/runs` shows them.
- A CLI form of `/tune`. `rlmh tune` stays offline (step 6).
- Gold answers, grading user tasks, and tuning frozen keys or `training-v4`.

## Hand-off

- **Step 10 relies on:** `/tune`, the two settings, and `tuned-*` profiles, for the release notes and the README.
- **progress.md:** row 9 is `review`, with the date, the gate verdict, the Windows Terminal check, and the live check's cost or "not run".
- **Architecture changes**, logged in progress.md:
  - §2 gains `tune/worktree.ts` and `test/tune/worktree.test.ts`, and the interface test becomes `.tsx`.
  - §7.6 is changed for the task file shape, the delivery rule, carrying forward, skipped probes, and the copy for folders outside git.
  - §8 gains the `number` type.

## If a decision goes the other way

- **D-215, reset to H0 for every task** (the paper's own rule):
  - every task starts from the base, and only the library carries forward;
  - `/tune` then writes one `tuned-<stamp>-t<i>` per task, and the result screen asks which one to use.
- **D-216, probe every candidate** (as harness2 does): this costs one or two more runs on each task where an editor keeps the base. The estimate already counts four runs, so it doesn't change.
- **D-217, `bypass` for `/tune` runs** (as D-172 does for eval): there would be no approvals during `/tune`. But these are the user's own tools on their own code, and bypass is not a sandbox. That is Rishi's call.
- **D-218, counting tests instead of exit codes**: `runTest` would parse pytest's or JUnit's output. That only works for runners we can parse.
- **`tune.library` off by default**: the reflector never runs, and each task costs one session less.
