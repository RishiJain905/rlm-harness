# Step 9. Harness² for users: `/tune`, `/tuned` and the experience library

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0. There is one optional live check, at most $1 from the reserve row, and only after Rishi's go |
| **Depends on** | 4 (follow-ups and their setting) and 6 (the tuner modules and `profile.check`); 2 through 6 |
| **Unblocks** | 10 |
| **Parallel with** | 5, 7, 8 |
| **Decisions it uses** | S-09 (one `python` tool), S-14, S-44, S-47 (follow the paper and the code); D-15 (non-interactive runs deny what would ask), D-28 (task shape), D-62 and D-133 (env stripping), D-138 and D-165 (safe git), D-144 (user profiles), D-174 (sessions), D-175 (the library), D-178 and D-202 (follow-ups, and what closes a conversation); D-215, D-216, D-218 to D-221 (written for the earlier design; D-221's estimate now counts 3 runs); D-231 (the on/off switch and `/tuned`; it replaces D-217), D-232 (the tuning model), D-233 (skills and scripts in candidates) and D-234 (step 7's result on subagents and nudges) |

## Goal

`/tune` turns Harness² on or off in the interactive app, and `/tuned` picks which harness is active (D-231). They are separate: a user can stay on a tuned profile with tuning off, and spend nothing on it.

While tuning is on, each task the user finishes is tuned in the background, one at a time, at k = 1, as the paper and `schedule.py` run a domain's tasks in order. For each task:
- the user's own run is the reference;
- an INV editor and a DOM editor;
- a probe run of each candidate;
- a composer;
- a run of the composed harness;
- a reflector, which writes at most one lesson to the user's experience library.

A kept harness is written as the user profile `tuned-<YYYYMMDD-HHMM>` and becomes the active profile, at once or when the open conversation ends. The sessions run on the tuning model the user picks in `/model`, and the runs on the user's own root and sub models (D-232). Architecture §7.6 pins the design.

Three rules hold throughout:
- **Nothing spends before the user has seen a cost estimate and said yes.** That happens at `/tune on`, and `tune.enabled` is never set to `true` any other way.
- **The user's folder is never touched.** Snapshots go through a temporary index or a copy, and every tune run works in a throwaway worktree or copy.
- **`tune.max_usd` is a hard stop.** It counts everything since `/tune on`, and when it trips, tuning turns itself off.

## Read first

- [../README.md](../README.md) and [../architecture.md](../architecture.md), whole files. §7 is the design, and §7.2 (skills and scripts), §7.6, §7.7, §8, §9 and §10 are this step.
- [../../v0/architecture.md](../../v0/architecture.md) §7.6 to §7.8 (profiles, sessions, the record). [../../v0/decisions.md](../../v0/decisions.md), whole file; D-231 and D-232 are this step's design.
- Specs, whole files: [step-02-rlmh-eval.md](step-02-rlmh-eval.md), [step-04-follow-ups.md](step-04-follow-ups.md) and [step-06-tuner.md](step-06-tuner.md).
- **The paper.** Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", [arXiv 2610.14224](https://arxiv.org/abs/2610.14224) ([Hugging Face](https://huggingface.co/papers/2610.14224)). In a cloud container, read it as `hf://papers/2610.14224/paper.md`. Read:
  - §2.2.1, the contrastive step: Propose, Probe and Compose;
  - §2.2.2, "At k = 1, both forms reduce to the basic contrastive step and bypass selection";
  - §2.3, the reflector and the library, and that the next task starts from H0;
  - §4, Figure 8: the executor model as its own editor, which is why `tune.model` may be the root model (D-232);
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
  - `app/src/eval/estimate.ts`, `app/src/eval/work.ts`, `app/src/session.ts`, `app/src/settings.ts`, `app/src/paths.ts`, `app/src/cli/config.ts`, and `app/src/engine.ts` (`stripKeys`, `splitCommand`);
  - `app/src/interface/App.tsx` (`submit`, `clear`, `quit`), `store.ts` (`applySetting`, `statusModel`), `StatusLine.tsx`, `conversation.ts`, `runs.ts` (`listRuns`), `approvals.ts`, and `commands/{index.ts, model.tsx, settings.tsx, runs.tsx, common.tsx}`.
- Engine: `engine/rlm_engine/workspace.py`, for `GIT_ARGS` (L41), `no_filters` (L186) and how a run's `base_tree` is made. The snapshot and worktree code here mirrors them.
- Tests: `app/test/fakes/engine.ts`, `app/test/interface/helpers.ts` and `app/test/interface/commands.test.tsx`, whole files.

## Starting state

- Steps 2, 4 and 6 are `done`:
  - `runEval`, `CostCap` and `estimate.ts` exist (step 2);
  - follow-ups exist, and a profile or mode change closes the open conversation (step 4, D-202);
  - `tune/evidence.ts`, `sessions.ts`, `candidate.ts` (skills and scripts included), `library.ts`, `prompts/` and `profile.check` exist (step 6).
- There are 7 screen commands plus `/clear` and `/quit`, and `MENU_MAX = 9`. Step 4 adds none. `SettingType` is `string | enum | int | bool`. `/model` has a root row and a sub row.
- `submit` in `App.tsx` takes the word after `/` as the command name and ignores the rest of the line.
- Step 7 may not be done. If it is, and it kept C5 and C8 (D-234), they are in `TUNABLE`, so `/tune`'s candidates may hold `agents/` and `nudges.toml`; nothing here changes for that.

## Deliverables

| File | What |
|---|---|
| `app/src/tune/online.ts` | `estimateOnline(deps): OnlineEstimate`, `TuneQueue` (`offer(task)`, `cancel(reason)`, `state()`) and `tuneTask(task, deps, onEvent): Promise<TaskResult>`, the per-task loop below. *KV cache: none* |
| `app/src/tune/worktree.ts` | `snapshot(folder, dest): Promise<Snapshot \| {refused: string}>` (`{kind: "commit" \| "copy", commit?, path?, sub, remove()}`), `workCopy(snap, dest, diff?): Promise<WorkCopy>` (`{path, kind: "worktree" \| "copy", applied, remove()}`), `pruneStale(home)`, `runTest(cmd, cwd): Promise<{exit, timedOut, seconds}>` |
| `app/src/tune/library.ts` (+) | `userDomain(task)`: `read`, or `repo-<slug of the folder's name>`. The root is `libraryDir(home)` |
| `app/src/interface/commands/tune.tsx` | `TuneScreen`, with the states status → estimate → on, and off |
| `app/src/interface/commands/tuned.tsx` | `TunedScreen`, the picker |
| `app/src/interface/commands/model.tsx` (+) | a third row, `tuning`, for `tune.model` |
| `app/src/interface/commands/index.ts`, `App.tsx`, `store.ts` (+) | `tune` and `tuned` in `COMMANDS`; `MENU_MAX = 11`; the argument after a command's name; the snapshot before a tuned task's run; the queue, fed from `run.finished`; the deferred profile switch; the status line's tune segment |
| `app/src/settings.ts` (+) | `SettingType` gains `number`; adds `tune.enabled` (bool, `false`), `tune.model` (string, empty), `tune.max_usd` (number, `1.00`), `tune.library` (bool, `true`) and `tune.test` (string, empty), after step 4's key |
| `app/src/cli/config.ts` (+) | `config set tune.enabled true` is refused, with a hint |
| `app/src/paths.ts` (+) | `libraryDir(h)`; `tuneDir(h)` is step 6's |
| `app/test/fakes/engine.ts` (+) | `createFakeApp({tune})` and a `profile.check` handler (see Tests) |
| Tests | `app/test/tune/online.test.ts`, `app/test/tune/worktree.test.ts`, `app/test/interface/tune.test.tsx`, `app/test/interface/tuned.test.tsx`, and additions to `app/test/settings.test.ts`, the `/model` tests and the `config` CLI tests |
| Docs | CLAUDE.md gains a line on `/tune` and `/tuned`; decisions.md for any new call; progress.md |

## Tasks

1. [ ] **Settings and paths.**
   - `number` parses a finite value above 0, is written to TOML as a float, and is edited in `/settings` like `int`. `rlmh config set tune.max_usd 2.5` works, and `0`, `-1` and `abc` are refused (D-220).
   - **`tune.enabled`** is set to `true` only by `/tune on`. `/settings` refuses `true` with "Use /tune on, which shows the cost first", and `rlmh config set tune.enabled true` exits 2 with the same hint. `false` is accepted anywhere.
   - **`tune.model`** is checked like `root.model` when it isn't empty.
   - **`tune.test`** is any string; it is split with `splitCommand` when it runs.
2. [ ] **`/model`'s tuning row** (D-232).
   - Rows: root, sub, tuning. The tuning row shows `tune.model`, or "same as root" when it is empty.
   - Enter on it picks a provider, then a model, as the sub row does, with "same as root" first, which writes an empty `tune.model`.
3. [ ] **`worktree.ts`** (D-219, D-231).
   - **`snapshot`, in a git folder.** Every git call is `git <GIT_ARGS> -C <top>`, with the env from `stripKeys(process.env)`, every filter driver blanked as `no_filters` does, and `GIT_INDEX_FILE` set to a temporary file under `tuneDir(home)/work/`:
     - `read-tree HEAD` (`read-tree --empty` in a repo with no commit);
     - `add -A` at the top, so untracked files are included and ignored ones aren't;
     - `write-tree`, then `commit-tree <tree> [-p HEAD] -m "rlmh /tune snapshot"`, with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to `rlmh <rlmh@localhost>` and a fixed date, so the user's identity is never needed;
     - the temporary index is deleted.

     No ref is made, and nothing is checked out: the user's index, `HEAD`, branches and files stay as they were. The commit is unreferenced, so git's gc can prune it after its grace period, which is far longer than a tune. A folder below the top keeps its subfolder (`sub`).
   - **`snapshot`, any other folder.** A copy into `tuneDir(home)/snapshots/<id>/`, without following links, skipping `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`, `dist`, `build` and `target`. Above 20,000 files or 1 GB it returns `{refused}`, counted before copying.
   - **`workCopy(snap, dest, diff?)`.** For a commit, `git worktree add --detach <dest> <commit>` with the same env; for a copy, a copy of the copy. With `diff`, it applies the diff with `git apply` (which also works outside a repository) and sets `applied`. `remove()` runs `git worktree remove --force`, then `git worktree prune`, or deletes the copy.
   - **Leftovers.** Each work copy and snapshot has a `work.json` (`{folder, kind}`). `pruneStale` removes what an earlier session left, at start-up when `tune.enabled` is true, and at `/tune on`.
   - **`runTest`.**
     - Splits the command with `splitCommand`, with no shell; `.cmd` and `.bat` go through `cmd /c` on Windows, as in `findEngine`.
     - Runs it in the work copy with `stripKeys(process.env)` and a 600 s limit.
     - Writes its output to `<tune dir>/tests/<stage>.log`, and returns only the exit code.
4. [ ] **`estimateOnline`** (D-221, D-231, D-232). One line for read tasks and one for repo tasks:
   - 3 × *m*, where *m* is the median `costUsd` of the last 20 records under `runsDir(home)` with that mode and the root model, leaving out `tune-*` batches and infra runs. With no such run, *m* is §6.6's row (R for read, M for repo) priced at the root model through `estimate.ts`.
   - Plus *n* × *s*, where *n* is 4 sessions (3 when `tune.library` is false) and *s* is the median cost of earlier `/tune` sessions on the tuning model: records under `runsDir(home)/tune-*/` whose tag ends in `:inv`, `:dom`, `:compose` or `:reflect`. With none, *s* is §6.6's R row priced at the tuning model.
   - It reports the runs' and the sessions' shares, the cap, and how many tasks of each mode the cap covers.
5. [ ] **The queue and `tuneTask`** (D-215, D-216, D-218, D-231, D-232, D-233).
   - **The snapshot.** When `tune.enabled` is true and a question starts a new conversation in repo mode, `App` takes a snapshot before `run.start`. If it is refused or fails, the run goes ahead untuned, with a dim note saying why.
   - **The offer.** At `run.finished` for `prompt_index` 0, the task goes to `TuneQueue.offer` when it submitted, had no infra error, and ran under a profile other than `training-v4`. Otherwise its snapshot is removed. Follow-up prompts, and `rlmh run`, `batch` and `eval` runs, are never offered.
   - **The queue.** One task is tuned at a time. A task offered while one runs waits; at most one waits, and a later one is skipped with the note "Tuning is busy; this task was skipped." When the running task ends, the waiting one starts only if the profile its run used is still active; otherwise it is skipped with a note.
   - **The stages,** one at a time, with incumbent H = the profile the user's run used:
     - **`ref`** is the user's own record, read from its run log; no run is made. Write evidence over it with `evidence.ts`, adding `library/` only when `tune.library` is on.
     - **`inv` and `dom`.** The two editor sessions (D-174) run through step 6's `runSession` on `tune.model` as root and sub (the root model when empty), with the built-in `default` profile, tag `tune:<id>:<stage>` and `logDir` `runsDir(home)/tune-<id>/`. The composer and reflector do the same. Each `EDIT` is written as `<home>/profiles/<id>-inv` (or `-dom`) through `candidate.ts`, skills and scripts included (D-233), and checked with `profile.check {base: H}`. An invalid result gets one retry with the errors appended, then becomes `KEEP_BASE`, as `_run_stage` does.
     - **`probe-inv`, `probe-dom`.** Run each candidate that differs from H. A candidate equal to H is not run, and the composer is told that its probe is `ref` (D-216).
     - **`compose`.** The composer gets `ref`, the probes, the diffs and the notes. It writes `<id>-composed`, or keeps H.
     - **`composed`.** Run it, unless it equals H.
     - **`reflect`.** Only when `tune.library` is on and the composed run delivered. The reflector writes through `library.ts` to `libraryDir(home)/<userDomain>/`. `NO_ENTRY` writes nothing.
   - **Every run:**
     - goes through step 2's `runEval` with this task alone, `out` = `<tune dir>/<stage>/`, the same `logDir` and no grading, so `/runs` lists it;
     - uses `conversation: false`, `interactive: false`, `batch: tune-<id>` and `tag: tune:<id>:<stage>`;
     - uses the user's root and sub models and the user's next-run permission mode; being non-interactive, anything that would ask is denied (D-15, D-231);
     - in repo mode, gets a fresh `workCopy(snapshot)` under `tuneDir(home)/work/<id>/`, removed after the run (and after its test, if any); in read mode, it reads the user's run's input paths, and a missing one skips the task.

     If `runEval` lacks an option this needs (an in-memory task, a work-copy hook, mode and `interactive` overrides, no grading), add it in `runner.ts` with a test, and log the change.
   - **Delivery** (D-218, D-231). The composed harness is kept, except in these cases:
     - its run had an infra error or delivered nothing;
     - `tune.test` is set, the reference's test exits 0 and the composed run's doesn't. The reference's test runs in `workCopy(snapshot, ref.diff)`; when the diff doesn't apply, the test rule is skipped and `tune.json` says so. The composed run's test runs in its own work copy before removal.

     Test results never enter evidence or the library.
   - **A kept harness** is copied to `<home>/profiles/tuned-<YYYYMMDD-HHMM>/` (with `-2`, `-3` and so on when the name is taken), and `tuneDir(home)/tuned.jsonl` gains `{name, base, base_hash, profile_hash, run_id, changed, at}`. It becomes the active profile through `applySetting`: at once when no conversation is open, otherwise when the open one ends (`run.closed`, `/clear`, a question that starts a new conversation, or quit), so tuning never closes a conversation under the user (D-178). If `profile` changed in the meantime, the pending switch is dropped with a note; the profile is still in `/tuned`.
   - **The end of a task.** Remove the `<id>-*` profiles, the work copies and the snapshot, and write `<tune dir>/tune.json`: per stage, its profile hash, decision, cost, exit code and run id. `<tune dir>` is `tuneDir(home)/<id>`, and the id is `t_<YYYYMMDD-HHMMSS>`.
   - **The cap.** `/tune on` writes `tuneDir(home)/online.json` with `on_since`. The spend is every `/tune` run and session since then, summed from the `tune-*` run logs at start-up and kept as it grows; the user's own runs don't count. One `CostCap` at `tune.max_usd` minus that spend covers the task in flight. When it trips, the running runs and sessions are cancelled, the waiting task is dropped, the task's result is dropped (H stays), `tune.enabled` is set to `false`, and the transcript says "Tuning turned off: the $X cap was reached." `/tune off` and quitting cancel and drop the same way, without the cap note.
6. [ ] **`tune.tsx`.**
   - **Arguments.** `submit` passes the word after a command's name to its screen. `/tune on` opens on the estimate. `/tune off` turns tuning off at once, notes what it cancelled, and opens no screen. Other commands ignore the word, as now.
   - **Status** (plain `/tune`). On or off; the spend since `/tune on` against the cap; the task in flight and its stage, and the task waiting; the tuning model, `tune.test` and the library setting. `o` turns tuning on (through the estimate) or off. Esc closes the screen.
   - **Estimate.**
     - Shows the read and repo lines, the cap, and how many tasks of each the cap covers.
     - Says that the user's own run is the reference, so a task costs up to 3 runs on the root model plus 4 sessions (3 with the library off) on the tuning model, and that the runs are most of it.
     - Says that tuning runs in the background after each new conversation's first answer; that its runs never ask, so anything that would ask is denied; and that a snapshot of the folder, uncommitted and untracked files included, is taken before each such question, without changing the folder.
     - `y` sets `tune.enabled = true`, writes `online.json`, runs `pruneStale`, and closes the screen with a note. `n` or Esc goes back.
     - There is no `y` when the profile is `training-v4`, when no root model is picked, or when both lines are over the cap; the screen says how to change the profile or raise `tune.max_usd` in `/settings`. When only one line is over the cap, it warns that such a task will trip the cap.
7. [ ] **`tuned.tsx`** (D-231).
   - Lists the built-in `default` first, then every `tuned-*` profile from `engine.info`, newest first, each with its date, base and number of changes from `tuned.jsonl` ("—" when it has no line). The active profile is marked; when it is neither, a line above the list names it.
   - Enter sets `profile` with `applySetting`. When a conversation is open, a line says that switching closes it (D-202). A pending switch from a tune is dropped.
   - It never spends, and starts no run.
8. [ ] **The status line.** `statusModel` gains a `tune on $0.12/$1.00` segment while tuning is on, with ` · tuning` while a task is tuned and ` · 1 waiting` while one waits. It is among the first segments dropped when the line is narrow.
9. [ ] **Wire it in.** `tune` and `tuned` go into `COMMANDS`, in that order, so `/tune` with the menu open picks `/tune`. Their summaries are "Turn Harness² tuning on or off; the cost comes first" and "Pick the active harness: default or a tuned one". `MENU_MAX` becomes 11, with its comment updated. `/help` lists both.
10. [ ] **Docs.** A CLAUDE.md line on `/tune` and `/tuned`, the D-lines for any new call, and a progress log line. Architecture §2, §7.6, §8, §9 and §10 already describe this design; log any change made to them.
11. [ ] **Run the full gate.** Then do the hand checks under Done when.
12. [ ] **The optional live check**, on the PC, only after Rishi's go on its estimate.
    - `/tune on` in a scratch git repo outside both repos, with DeepSeek as root and tuning model, `tune.test` set and `tune.max_usd = 1`; then one repo question.
    - Record the cost in progress.md and the ledger (`appendLedger`, `what: "tune"`).

## Tests

Everything here is offline. The fake provider is `fake/scripted`, and no real key is used.

**Fakes.** `createFakeApp({tune: {stages: {"<stage>": {answer, costUsd, exit?}}}})`:
- finishes a run whose tag is `tune:*:<stage>` with that stage's `answer`, and a `call.end` that carries `costUsd`;
- accepts any profile under `<home>/profiles/`;
- answers `profile.check` with `ok: false` when the guidance contains `INVALID`, and otherwise `ok: true` with `changed`.

Test commands are tiny scripts that exit 0 or 1.

**`app/test/tune/online.test.ts`**
- **The estimate.**
  - The medians skip `tune-*` batches, infra runs, and other modes and models.
  - Runs are priced at the root model and sessions at `tune.model`, each with its own fake price; an empty `tune.model` prices sessions at the root model.
  - With no history, the figures come from §6.6. With the library off, there are 3 sessions.
- **Nothing before yes.** `estimateOnline` makes no `run.start` and no gateway call, creates no `<home>/tune`, and leaves `git worktree list` unchanged.
- **A read task:**
  - no `ref` run is made; the order is `inv` and `dom`, then the probes, then `compose`, `composed` and `reflect`;
  - every run has `conversation: false`, `interactive: false`, the batch and the tag, and the user's root and sub models; every session has `tune.model`;
  - `tuned-*` is written with its `tuned.jsonl` line, and the `<id>-*` profiles are gone;
  - an entry's cue appears in `INDEX.md`, and `NO_ENTRY` adds nothing.
- **Skills and scripts.** An INV edit with `files` gives a `tuned-*` holding that skill and script (D-233).
- **Keeping the base.** An editor's `KEEP_BASE` skips its probe. A composer's `KEEP_BASE` skips `composed`, and no `tuned-*` is written.
- **An invalid session** is retried once with the errors, then becomes `KEEP_BASE`.
- **Carrying forward.** Task 2, run under task 1's tuned profile, uses it as H.
- **The queue.** Three tasks offered during one tune: the second waits and the third is skipped with the note. A waiting task whose profile is no longer active is skipped.
- **Offers.** A follow-up prompt, a run with an infra error, a run with no submit, and a `training-v4` run are not offered.
- **Tests decide delivery.**
  - With `tune.test` set, `ref` at exit 0 and `composed` at exit 1, the base stays. With both at 1, the composed harness is kept.
  - A reference diff that doesn't apply skips the rule, and `tune.json` says so.
  - No evidence or library file contains the test log's text.
- **No approvals.** A probe whose cell would ask is denied, and no `approval.request` reaches the interface.
- **The cap.** The cap trips in task 2: a `run.cancel` is sent, there is no later `run.start`, H is task 1's harness, `settings.toml` has `tune.enabled = false`, and the note is shown. After a restart, the spend since `on_since` is summed again from the run logs.
- **Library off.** There is no `reflect` run, no `library/` in evidence, and `<home>/library` doesn't exist.

**`app/test/tune/worktree.test.ts`** (needs git)
- The snapshot holds an uncommitted change and an untracked file, and not an ignored file.
- After it, `git status --porcelain`, the index file's bytes, `HEAD`, `git for-each-ref` and the reflog are unchanged.
- A repo with no commit gives a snapshot with no parent.
- A worktree from the snapshot has the uncommitted change; `remove()` leaves `git worktree list` as it was.
- A `post-checkout` hook and `clean` and `smudge` filters that each write a marker never run.
- `workCopy` with a diff applies it; a diff that doesn't apply gives `applied: false`.
- A non-git folder is copied without the skip list, and is refused above a lowered limit.
- `pruneStale` removes a leftover worktree and a leftover copy.
- `runTest` returns the exit code, honours the timeout, and gets no `*_KEY` variable.

**`app/test/interface/tune.test.tsx`** (`mount` with `createFakeApp`)
- `/` lists eleven commands, all visible, and `/tune` with the menu open picks `/tune`.
- `/tune` shows "off". `/tune on` shows the estimate; `n` goes back, the fake engine saw no `run.start`, and `tune.enabled` is still `false`.
- `y` writes `tune.enabled = true`, and the status line shows `tune on $0.00/$1.00`.
- After a question's first answer, the tune runs in the background: the prompt box stays usable, a follow-up runs during the tune, and no approval prompt appears.
- A kept harness with a conversation open leaves `profile` unchanged until `/clear`, then sets it to `tuned-…`. With no conversation open, it is set at once.
- Over the limit, or under `training-v4`, there is no `y` and the screen shows the hint.
- When the cap trips, tuning turns off, the note is shown, and the status segment goes.
- `/tune off` during a tune sends `run.cancel`.
- `/settings` refuses `tune.enabled = true` with the hint.

**`app/test/interface/tuned.test.tsx`**
- It lists `default` first, then `tuned-*` newest first, with the active one marked.
- Enter writes `profile` to `settings.toml`, with no `run.start` and no gateway call. With a conversation open, the closing line shows, and Enter closes it.
- A pending switch from a tune is dropped after a pick.

**The `/model` tests**: the tuning row, "same as root" writing an empty `tune.model`, and a picked model writing `tune.model`.

**`app/test/settings.test.ts` and the `config` CLI tests**: the `number` type; the five keys in `config list`; `config set tune.enabled true` exits 2 with the hint, and `false` is accepted.

## Done when

- The full gate prints `VERIFY: PASS`, and CI is green on all three OSes after Rishi's OK to push.
- **The hand check, on the fake provider.**
  - In a cloud container, run the pty and `pyte` check (CLAUDE.md) against the source app and engine on `fake/scripted`. Use a new `app/test/fakes/tune-demo-script.json`, whose root replies answer the user's question, then submit, in stage order, the shape each stage expects.
  - Then, on the PC, in Windows Terminal, in a git folder with an uncommitted change: `/tune on` shows the estimate first. After `y` and one question, `git worktree list` shows a worktree during each tune run and none after, and `git status` is as it was.
  - `<home>/profiles/tuned-*` exists, becomes active after `/clear`, and `/tuned` switches back to `default`.
- The live check is either done, with its cost logged, or marked "not run" in progress.md.

## Out of scope

- k > 1, the selector, and sequential mode (harness2's `seq`).
- Reading the library in ordinary runs (D-175).
- Applying a `/tune` run's diff to the user's folder. The diffs stay in the run records, where `/runs` shows them.
- A CLI form of `/tune`, and tuning `rlmh run`, `rlmh batch` or `rlmh eval` runs. `rlmh tune` stays offline (step 6).
- Tuning follow-up prompts: they rely on REPL state a fresh run doesn't have.
- A test command per folder. `tune.test` is one setting.
- Approval prompts in background runs (D-231).
- Deleting or renaming tuned profiles from the app.
- Gold answers, grading user tasks, and tuning frozen keys or `training-v4`.

## Hand-off

- **Step 10 relies on:** `/tune`, `/tuned`, the five settings and `tuned-*` profiles, for the release notes and the README.
- **progress.md:** row 9 is `review`, with the date, the gate verdict, the Windows Terminal check, and the live check's cost or "not run".
- **Architecture:** §2, §7.6, §8, §9 and §10 were rewritten for D-231 and D-232 before this step. Log any change this step makes to them, such as a new `runEval` option or the `tuned.jsonl` fields.

## If a decision goes the other way

- **D-231, approvals in background runs:** background runs would be `interactive: true`, and their approvals would draw over whatever the user is doing, or wait in a queue that holds the tune's worktree and the next task. Not recommended.
- **D-231, switch the profile immediately:** `applySetting` at once, which closes the open conversation (D-202). Simpler, but tuning would end a conversation under the user.
- **D-231, queue more than one task:** the waiting slot becomes a list with a length limit. The per-task estimate doesn't change, but the cap is reached sooner, and more waiting tasks are skipped because their profile is no longer active.
- **D-231, tune whole conversations instead of first prompts:** the probes would replay every question of the conversation in order, with `conversation: true`. A follow-up was written against the user's run's answers, so replaying it against a probe's answers says little. Not recommended.
- **D-232, sessions always on the root model:** drop `tune.model` and the `/model` row; the estimate prices sessions at the root model.
- **D-215, reset to H0 for every task** (the paper's own rule): every task starts from the profile active at `/tune on`, only the library carries forward, and each kept harness is its own `tuned-<stamp>` for `/tuned` to list.
- **D-216, probe every candidate** (as harness2 does): this costs one or two more runs on each task where an editor keeps the base. The estimate already counts three runs, so it doesn't change.
- **D-218, counting tests instead of exit codes**: `runTest` would parse pytest's or JUnit's output. That only works for runners we can parse.
- **`tune.library` off by default**: the reflector never runs, and each task costs one session less.
