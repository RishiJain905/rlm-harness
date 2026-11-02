# Step 5. Baseline

| | |
|---|---|
| **Type** | Spend (a Remote Control session on Rishi's PC, because the set lives on `D:` and his OpenRouter key is saved there) |
| **Cost** | At most $9 (D-179 as updated: baseline $9, tuning $9, held-out check $3, Haiku $6, reserve $3), on Rishi's OpenRouter key, spent only after his go on the printed estimate. Infra reruns come from the $3 reserve row. Never W&B credit |
| **Depends on** | 1, 2, 3 |
| **Unblocks** | 7, 8, 10 |
| **Parallel with** | 4, 6 |
| **Decisions it uses** | S-43, S-44, D-121, D-170, D-172, D-173, D-176, D-179; step 2's D-193 (the cost cap). New here: D-182 (the `v1-baseline` profile), D-186 (`v1-baseline` on all 48 first, `training-v4` on held-out only), D-187 (which infra errors are rerun) |

## Goal

Measure where v1 starts. `rlmh eval` runs all 48 tasks of `harness-eval-v1` with the `default` profile as it stands after step 3 (v0.2.0's `default` plus `[compaction]`), frozen as the user profile `v1-baseline`. It then runs `training-v4` on the held-out half only, as the reference row for step 10's write-up. Both use `openrouter/deepseek/deepseek-v4.1-flash-1017` as root and sub model (S-43).

The outputs are the comparator for everything after this. Step 7 tunes from the `v1-baseline` tune half, and step 8 must beat its held-out half (D-173). Step 10 writes up all of it. This step writes no code.

## Read first

- [../README.md](../README.md) and [../architecture.md](../architecture.md), whole. §6 (the set, `rlmh eval`, its output, the estimate) and §11 (spending) are what this step runs; §4 says what a compaction is, which the report counts.
- [../../v0/decisions.md](../../v0/decisions.md): S-40 to S-48, D-168 to D-179 and D-222 to D-225. D-121 (OpenRouter's billed cost), D-144 (a profile's hash is its bytes) and D-15 (non-interactive runs deny anything that asks).
- [../../v0/progress.md](../../v0/progress.md): the v1 table, the "v1 spend so far" line, and the log.
- [../../v0/specs/step-09-smoke-run.md](../../v0/specs/step-09-smoke-run.md), whole: how v0 asked for a go, capped spend and reported numbers without task text.
- [step-01-eval-sets.md](step-01-eval-sets.md), [step-02-rlmh-eval.md](step-02-rlmh-eval.md) and [step-03-compaction.md](step-03-compaction.md), whole. Their hand-offs are this step's starting state.
- rlm-harness, read whole:
  - `app/src/cli/eval.ts` and every file in `app/src/eval/` (`set.ts`, `work.ts`, `runner.ts`, `estimate.ts`, `report.ts`, `ledger.ts`): the flags, the estimate, the cap, the exit codes, and the grade-line keys.
  - `engine/rlm_engine/profiles.py`: `_load` and `file_hash`, which is why a byte copy of a profile keeps its hash.
  - `engine/rlm_engine/profiles/default/profile.toml` and `guidance.md`, and `engine/rlm_engine/profiles/training-v4/profile.toml`.
  - `app/catalog/models.json`: the `openrouter` entry for `deepseek/deepseek-v4.1-flash-1017`.
- RLM repo (`F:\Personal\RLM\RLM`), read whole: `scripts/harness_evalset.py` (`check`, `summary`), `documentation/harness-eval-v1.md` and `.gitignore` (`results/harness-*/`).

## Starting state

- Steps 1, 2 and 3 are `done` in progress.md, or `review` with Rishi's word that step 5 may start.
- The rlm-harness checkout on the PC (`F:\Personal\RLM\rlm-harness`) is at a commit that holds steps 2 and 3, with no local changes (`git status --short` is empty). `rlmh` runs from source: in `app\`, `..\.bun\bin\bun.exe run src/main.ts …`, so `eval.json` records `harness_commit`.
- The real home (`~\.rlm-harness\`, no `RLMH_HOME`) has an `openrouter` entry in `key-index.json`. Read only the index, never the key store, and never print a key.
- `D:\RLM-data\harness-eval\harness-eval-v1\` exists, `uv` is on PATH, and so are `node` 22 or later and the `pnpm` version the set's `nodeenvs/` pin (the web track, D-222). `nvidia-smi` shows the GPU the kernel track needs (D-223).
- `rlmh eval ledger` in the real home shows $0.00 of $30, or only earlier v1 lines that progress.md accounts for.

## Deliverables

Nothing is committed in either repo. Rishi decides about commits afterwards.

| Where | What |
|---|---|
| `~\.rlm-harness\profiles\v1-baseline\` | `profile.toml` and `guidance.md`, byte copies of the built-in `default` at this commit (D-182) |
| RLM repo `results/harness-eval/<date>-baseline-default/tune/` and `heldout/` | Two `rlmh eval` outputs (architecture §6.5's layout), 24 tasks each. Git-ignored |
| RLM repo `results/harness-eval/<date>-baseline-training-v4/heldout/` | The same for `training-v4`, held-out only (D-186) |
| RLM repo `results/harness-eval/<date>-baseline-*/<split>/rerun/` | Only when a run had a transient infra error (D-187) |
| RLM repo `documentation/harness-eval-v1.md` | A new section, "Baseline (step 5)", numbers only |
| `documentation/v0/progress.md` | Row 5, the "v1 spend so far" line, and a log line |

Each split gets its own output folder. The tuner reads its `--from` folder as evidence, and it must never see a held-out trace.

## Tasks

`$SET` is `D:\RLM-data\harness-eval\harness-eval-v1`, `$M` is `openrouter/deepseek/deepseek-v4.1-flash-1017` and `$R` is `F:\Personal\RLM\RLM\results\harness-eval\<date>`, where `<date>` is the day the paid runs start (`YYYY-MM-DD`). Every `rlmh eval` below also takes `--root $M --sub $M`, and none of them passes `--call-format`, so `auto` picks native for both profiles.

1. [ ] Set row 5 of the v1 table to `in progress`, with this thread's name.
2. [ ] **The set.** Run `.venv\Scripts\python.exe scripts\harness_evalset.py check` from the RLM repo. It must exit 0. Note the manifest's two hashes.
3. [ ] **The baseline profile (D-182).** Copy `engine\rlm_engine\profiles\default\profile.toml` and `guidance.md` into `~\.rlm-harness\profiles\v1-baseline\` as bytes (`Copy-Item`, nothing that rewrites line ends). Then check in `rlmh info` (it prints JSON; read `engine.profiles`) that `v1-baseline` is listed with `source: "user"`, and that its `profile_hash` equals the built-in `default`'s. Record the hash. If the folder already exists with a different hash, stop and ask.
4. [ ] **Ignored outputs.** `git -C F:\Personal\RLM\RLM check-ignore -v results/harness-eval/x/tune/runs.jsonl` must print the `results/harness-*/` rule.
5. [ ] **Rehearsal, $0.** Use a temp home: `$env:RLMH_HOME` set to a new folder under `%TEMP%`, with `v1-baseline` copied into its `profiles\` too. Write a fake script outside both repos: `{"root": [{"text": "", "tool_call": {"code": "submit('rehearsal')"}}]}`. With `RLMH_FAKE_SCRIPT` set to it:
   - `rlmh eval $SET --profile v1-baseline --root fake/scripted --sub fake/scripted --go --out <temp>\rehearsal-default`;
   - `rlmh eval $SET --split heldout --profile training-v4 --root fake/scripted --sub fake/scripted --sample 4 --seed 1 --go --out <temp>\rehearsal-training-v4`.

   Expect 48 and 4 grade lines, no passes (a base snapshot fails its f2p tests, and `'rehearsal'` is no read gold), no infra error, no `test_tamper`, no `leak_suspect` and $0. A pass here means a broken task: stop and tell Rishi which id. The first command also builds every venv and Node environment once, and Playwright's Chromium, which checks PyPI, the npm registry and Playwright's download from this machine. Then delete the temp home and clear the two env vars.
6. [ ] **The estimate, $0.** In the real home, run without `--go`:
   - `rlmh eval $SET --split tune --profile v1-baseline` and `--split heldout`;
   - `rlmh eval $SET --split heldout --profile training-v4`.

   From §6.6's reference tokens and the catalog's price ($0.15 per M input, $0.60 per M output, $0.003 per M cache read), `v1-baseline` on all 48 comes to about $6.84: R $0.085, S $0.043, M $0.132 and L $0.42 a run, so the eight L tasks are about half. `training-v4`'s own ceiling (D-198: 30 repo turns at 4,096 tokens) caps its L figure at about $0.33 a run, so it prints about $3.04 on held-out, and the total, about $9.89, is over $9. Both are probably high: they are v0's `default` means, v0's 10 smoke runs cost $0.23, and `training-v4` has fewer turns and no `agent_api`. The caps in tasks 8 to 10 are what hold the $9.
7. [ ] **Ask for the go.** Post one reply with:
   - the three estimates and the venvs they would create;
   - the plan: `v1-baseline` on both halves, capped at $7 together, then `training-v4` on held-out, capped at what is left of $9 (at least $2);
   - the rerun rule (D-187), paid from the $3 reserve.

   If the `v1-baseline` estimate alone is above $9, use an `ask_decision` card instead, and run nothing until Rishi answers. The options are moving money from a later row (a D-179 change), or `v1-baseline` without its L tasks (a D-176 change). Either way, wait for Rishi's go in chat. Ask him to keep the PC awake while it runs.
8. [ ] **`v1-baseline`, tune half.** `rlmh eval $SET --split tune --profile v1-baseline --go --max-usd 7 --out $R-baseline-default\tune`. $7 is its estimate rounded up, and the last $2 are kept for task 10. Runs take hours, so start each `--go` in the background and come back when it ends; never sleep-poll. Read the exit code, `eval.json`'s `capped`, and the totals line.
9. [ ] **`v1-baseline`, held-out half.** The same with `--split heldout`, `--max-usd` set to 7 minus the tune half's billed cost, and `--out $R-baseline-default\heldout`. If either half ends `capped`, stop: a capped baseline is incomplete. Report what ran and what it cost, and ask.
10. [ ] **`training-v4`, held-out half** (D-186). `rlmh eval $SET --split heldout --profile training-v4 --go --max-usd <9 minus the v1-baseline total> --out $R-baseline-training-v4\heldout`. It is step 10's reference row, so it never runs on the tune half. If it ends `capped`, keep it, report it as capped, and don't rerun it.
11. [ ] **Infra errors** (D-187). For each output, list the grade lines with an `infra_kind`:
    - **Transient:** `rate_limit`, `server`, `timeout`, `network`, `worker`, `runlog` or `other`. Rerun once with `rlmh eval $SET --rerun <out> --go --max-usd <reserve left>`, which writes `<out>\rerun\`. `report` and `compare` then take the rerun's line for those ids. A second failure stays a failure.
    - **Setup:** `auth`, `no_key`, `unknown_model`, `workspace` or `host_bug`. Stop and tell Rishi. These are not the profile's fault, and rerunning them wastes money.
    - **Not infra for this purpose:** `context_window`, `bad_request` and `capped`. They count as failures, because they are how the profile behaved. List them under Found.
12. [ ] **Compare.** `rlmh eval compare $R-baseline-default\heldout $R-baseline-training-v4\heldout`. Also `rlmh eval report` on every output that has a `rerun\` folder.
13. [ ] **Summary.** Ask Rishi before editing `documentation/harness-eval-v1.md` in the RLM repo (CLAUDE.md, "The RLM repo is outside this repo"). Then add "Baseline (step 5)":
    - the date, `harness_commit`, the set's two hashes and the model id;
    - the `profile_hash` of the built-in `default` at this commit, which is `v1-baseline`'s, and `training-v4`'s;
    - for each output: n, passed, pass rate, mean `f2p_share`, and pass rate by track (`python`, `web`, `kernel`, `research`, `search`) and by size (R, S, M, L);
    - mean turns, sub-calls and compactions, cost, cache hit rate and wall time;
    - infra errors by kind, reruns, `test_tamper` and `leak_suspect` counts;
    - the compare numbers, with D-170's line that one replicate on 24 tasks can't show significance.

    No task text, answers, test names or per-task transcripts. Ids are allowed, since they reveal nothing.
14. [ ] **Ledger and progress.** Run `rlmh eval ledger` and check that its step 5 lines add up to the billed costs above. Set row 5 to `review`, with the date, the cost by output, the pass rates by profile and split, the `v1-baseline` hash, and the output folders. Set "v1 spend so far". Add a log line. Commit nothing.
15. [ ] **Clean up.** `~\.rlm-harness\eval\work\` is empty. No `python`, `pytest`, `node`, Chromium or engine process from this step is still running (`Get-Process`). Both repos' `git status --short` show only the summary doc (RLM) and progress.md (rlm-harness).

## Tests

None new: this step writes no code. Its checks are:
- the rehearsal (task 5), which runs every task through `rlmh eval` at $0, including the grading, the venvs and the Node environments;
- `harness_evalset.py check`;
- the profile-hash match (task 3);
- the ledger matching the billed costs (task 14).

If a check fails because of a bug in `rlmh eval`, stop and report it with the failing output. Fixing it belongs to step 2's code, through Rishi.

## Done when

- The rehearsal passed at $0, and Rishi's go is in the chat.
- `v1-baseline` holds the built-in `default`'s bytes, and its hash is in progress.md.
- `$R-baseline-default\tune\` and `heldout\` each have `eval.json`, 24 grade lines, `report.json` and `report.md`, and neither is `capped`.
- `$R-baseline-training-v4\heldout\` has `eval.json`, 24 grade lines, `report.json` and `report.md`, or the reply says it was capped.
- Every transient infra error was rerun once, and every setup error was reported.
- Step 5's ledger lines total at most $9, and reruns at most what is left of the $3 reserve row.
- The summary section exists and holds only numbers. Row 5, the spend line and the log are updated.
- Nothing from `results\` shows in `git status`. No process is left running, and `eval\work\` is empty.

## Out of scope

- Any code change in either repo, including fixes to `rlmh eval`, the set or the profiles.
- Tuning (step 7), the Haiku comparison (step 10), and the LoRA (S-41).
- Repeats. Each task runs once (D-170).
- Editing the set, or dropping a task from it. A task that looks broken goes under Found, and step 1's owner fixes the set.

## Hand-off

- **Step 7** tunes from `$R-baseline-default\tune\` (`rlmh tune … --from`), starting from the profile `v1-baseline`. Its `runs.jsonl` is the `--tokens-from` for step 7's estimate.
- **Step 8** compares the tuned profile's held-out output with `$R-baseline-default\heldout\`, using `rlmh eval compare`. That is D-173's bar.
- **Step 10** compares `v1-baseline` (the `default` at this step's commit, `[compaction]` included) with the tuned profile on Haiku. It gets the profile from `~\.rlm-harness\profiles\v1-baseline\` and checks its `profile_hash` against row 5 and the summary. If the folder is gone, step 10 rebuilds it from `engine/rlm_engine/profiles/default/` at the `harness_commit` row 5 names. Its write-up reports these baseline numbers, with `training-v4`'s held-out output as the reference row, and its estimate can pass this step's run logs as `--tokens-from`.
- **The comparator never changes:** steps 7, 8 and 10 name `--profile v1-baseline` and check its hash against row 5 before spending.
- **Found** lists anything later steps need: tasks that never pass in any run, L tasks that hit the turn limit, how often compaction fired, cost per size, and any `test_tamper` or `leak_suspect` id.

## If a decision goes the other way

- **D-182, the built-in `default` as comparator.** Pass `--profile default` and record its hash. Steps 7, 8 and 10 must then check that the built-in still has that hash, and step 8 breaks it the moment it ships the tuned profile. The baseline then has to live in a git ref, not a profile name.
- **D-186, `training-v4` on all 48.** Its tune half adds about $3.04 at the priors, so Rishi moves money from a later row into step 5 (a D-179 change). Task 10 then also runs `--split tune` into `$R-baseline-training-v4\tune`, and task 12 compares both halves.
- **No `training-v4` at all.** Skip task 10 and the compare. Step 10's write-up then has no reference row; nothing else downstream needs one.
- **D-187, no rerun flag.** If step 2 shipped without `--rerun`, rerun the ids with `--only <ids> --out <out>-rerun` and list both results. Comparisons still count those tasks as failures, so ask Rishi whether step 2 should add `--rerun` before step 7.
- **D-172, a narrower permission mode.** Only the manifest changes. The estimate prints the mode, and nothing in this step changes.
- **S-43, another tuning model.** Change `$M`. The estimate and the plan in task 7 follow from it.
