# Step 7. Tuning round

| | |
|---|---|
| **Type** | Spend |
| **Cost** | At most $9 (D-179) of Rishi's OpenRouter key. `rlmh tune` prints its estimate first, and it is spent only after his "go" in chat. Never W&B credit |
| **Depends on** | 5, 6 |
| **Unblocks** | 8 |
| **Parallel with** | 9 |
| **Decisions it uses** | S-43, S-44, S-46; D-170, D-173, D-174, D-175, D-179; step 5's `v1-baseline`; step 6's D-204 to D-212. New here: D-213 |

## Goal

Run `rlmh tune` once, for real:
- **Set:** `harness-eval-v1`'s tune split (24 tasks).
- **Model:** DeepSeek V4.1 Flash 1017 for every run and every session (S-43).
- **Base:** `--base v1-baseline`, step 5's user profile. Round 1's reference is the tune half of step 5's output, `results/harness-eval/<date>-baseline-default/tune/`.
- **Rounds:** at most 2, with a probe of 10. Round 1 always runs, and round 2 runs only if its fresh estimate fits under what is left of the $9 (D-212).
- **Output:** the RLM repo's git-ignored `results/harness-eval/<date>-tune/`.

Then write a numbers-only summary, including which edits survived, and hand step 8 the `final/` folder and `tune.json`. This step changes no code. If no round is accepted, it says so and offers a third round, paid from what step 7 didn't spend; more than that needs Rishi to move money between rows (D-179).

## Read first

Read these whole:

- **The paper.** Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", [arXiv 2610.14224](https://arxiv.org/abs/2610.14224), also on [Hugging Face](https://huggingface.co/papers/2610.14224) (`hf://papers/2610.14224/paper.md` in a cloud container). Read:
  - §2.2, one improvement round;
  - Appendix C, the Meta-Harness acceptance this step's numbers report;
  - Appendix D.2, rollouts and sessions as the cost units.
- **The code.** [google-research/harness2](https://github.com/google-research/harness2) at `6868817518876de8fd170c6a8354daca273b6191`, Apache-2.0:
  - `harness2/core/ledger.py`, whole file (R and P, which the summary reports);
  - `harness2/core/recursion.py`, `run_sequential` L463;
  - `harness2/core/prompts.py`, `aggregate` L893 (the notes format whose lines the summary counts) and `experience` L1105 (the four verdicts).
- [../architecture.md](../architecture.md): §6.5, §6.6, §7.5, §7.7 and §11.
- [../../v0/decisions.md](../../v0/decisions.md): S-43, S-44, D-170, D-173 to D-175, D-179.
- [step-05-baseline.md](step-05-baseline.md) (how `v1-baseline` is made and where its output goes), [step-06-tuner.md](step-06-tuner.md) (Tasks 9 and 10, and Hand-off) and [step-08-ship-tuned-default.md](step-08-ship-tuned-default.md) (Read first and Starting state: what it needs from here).
- [../../v0/specs/step-09-smoke-run.md](../../v0/specs/step-09-smoke-run.md): the model for a spend step (estimate, go, cap, numbers-only summary).
- RLM repo, read-only until Rishi says otherwise: `documentation/harness-eval-v1.md` (steps 1 and 5's sections) and `.gitignore` (`results/harness-*/`, D-46).
- This repo: `app/src/cli/tune.ts` and `app/src/tune/offline.ts`, as step 6 built them.

## Starting state

- **Steps 5 and 6 are `done`** in progress.md. Step 5's log line names its output folders, the machine it ran on, `RLMH_HOME` and its real cost.
- **`v1-baseline`** is installed in `<home>/profiles/`, a byte copy of the built-in `default` after step 3 (step 5). Its `profile_hash` equals the one in step 5's `v1-baseline` `eval.json`; step 6's pre-flight checks that.
- **The set** is the same `D:\RLM-data\harness-eval\harness-eval-v1\` step 5 used, unchanged (`tasks_sha256` and `grades_sha256` match).
- **`rlmh`** is built from the commit that finished step 6, from source or compiled.
- **The OpenRouter key** is saved in `rlmh` or in `OPENROUTER_API_KEY`. Nothing here reads or prints it.
- **No profile** in `<home>/profiles/` starts with `v1-tuned`.

## Deliverables

| Path | What it is |
|---|---|
| `results/harness-eval/<date>-tune/` (RLM repo, git-ignored) | The tune's output: `tune.json`, `rounds/`, `library/`, `final/`. `<date>` is `YYYY-MM-DD` |
| `results/harness-eval/<date>-tune.estimate.txt`, `<date>-tune.log` | The printed estimate, and the `--go` run's stdout and stderr |
| `documentation/harness-eval-v1.md` (RLM repo) | A "Step 7: tuning" section, numbers only. It is committed only with Rishi's OK |
| `documentation/v0/progress.md` (this repo) | Row 7, the v1 spend line and a log line |
| `<home>/profiles/v1-tuned/` | Installed by the tune only if a round was accepted |
| `<home>/eval/ledger.jsonl` | The tune's one `tune` line |

**The command** (in `app/` from source, use `bun run src/main.ts` for `rlmh`). Use step 5's `--sub`, which is the same model unless its `eval.json` says otherwise:

```
rlmh tune D:\RLM-data\harness-eval\harness-eval-v1 ^
  --root openrouter/deepseek/deepseek-v4.1-flash-1017 --sub openrouter/deepseek/deepseek-v4.1-flash-1017 ^
  --base v1-baseline --name v1-tuned --from <RLM>\results\harness-eval\<date5>-baseline-default\tune ^
  --rounds 2 --probe 10 --seed 0 --jobs 4 ^
  --tokens-from <RLM>\results\harness-eval\<date5>-baseline-default\tune\runs.jsonl ^
  --tokens-from <RLM>\results\harness-eval\<date5>-baseline-default\heldout\runs.jsonl ^
  --out F:\Personal\RLM\RLM\results\harness-eval\<date>-tune
```

`<RLM>` is `F:\Personal\RLM\RLM`, and `<date5>` is step 5's date. The held-out run log adds token figures only; no held-out task enters the tune. Run it on the machine step 5 ran on, with the same `RLMH_HOME`. In a cloud container, use `\` → `/` paths and the set folder step 5 used there.

## Tasks

1. [ ] **Check the inputs** ($0).
   - `rlmh eval report <date5>-baseline-default/tune`: note its pass count, mean `f2p_share` and infra count. The report reads through `readGrades`, so step 5's `rerun/` lines already count.
   - **More than 6 infra errors left** (a quarter) would make every round end as `infra` (D-209). If they are transient and step 5 has not used `--rerun` on that folder, ask Rishi whether to run `rlmh eval SET --rerun <date5>-baseline-default/tune` first, from the reserve row. Otherwise, stop and ask.
   - `rlmh eval ledger`: note the total so far.
2. [ ] **Estimate** ($0). Run the command without `--go`, saving its output to `<date>-tune.estimate.txt`. It lists, per round:
   - the probe and accept rollouts;
   - the four sessions;
   - the total, the cap and the ledger total.

   Expect about $7 for round 1 at §6.6's priors:
   - two probes of 10 tasks, about $1.5 each;
   - the composed run on all 24, about $3.75;
   - sessions, about $0.5.

   The real figure comes from step 5's tokens.
3. [ ] **Fit the ceiling** (D-213).
   - **The cap.** `--max-usd 9` is the ceiling, unless Rishi gives a higher number from step 5's leftover (D-179 carries unspent money forward). Also check that the ledger total plus the cap leaves steps 8 and 10 and the reserve their rows; if not, ask.
   - **If round 1's estimate alone is over the cap,** estimate again with `--probe 6`. If it is still over, stop and ask.
   - **Round 2's line in the estimate** says whether it fits under the cap after round 1. The tuner decides again before round 2 with real tokens, so no flag is needed.
4. [ ] **Ask for the go.** Post in chat:
   - the per-round table, the total and the cap;
   - the ledger total, with the $30 left after this cap;
   - the models, `v1-baseline`'s `profile_hash`, and the probe size and seed;
   - the exact `--go` command.

   Wait for Rishi's "go". Without one, nothing runs.
5. [ ] **Run** with `--go --max-usd <cap>`, stdout and stderr to `<date>-tune.log`. Don't interrupt it unless Rishi asks.
   - **Exit 1, `stopped: "max_usd"`:** report what finished. Nothing reruns without a new go.
   - **Exit 1 for any other reason** (engine exit, error): report the stage, the error and the cost. `--continue` can't resume a stopped tune, so ask.
   - **`budget_stop: 2`:** round 2 didn't fit. This is a normal end, and it goes in the summary.
6. [ ] **Check the output** ($0).
   - `tune.json` has every stage, and `final/` exists.
   - `rlmh eval report` on each `rounds/<r>/evals/*`: note pass counts, `infra`, `test_tamper` and `leak_suspect`. Any `leak_suspect` goes in the summary, with its task id.
   - **`final/guidance.md` holds nothing task-specific.** Check it for every tune task's id and package name, and every hidden test path. Step 8 ships this text into a public repo, so report any hit and don't ship it silently.
   - The real cost is at most the cap, and the ledger has one new `tune` line.
7. [ ] **If no round was accepted**, report it with the accept numbers. Then offer a third round:
   - **The run:** `rlmh tune … --continue <out> --rounds 3 --max-usd <X>`, where X is step 7's unspent money, or more only if Rishi moves it from another row (D-179);
   - **First:** its estimate (the same command without `--go`);
   - **Then:** only on Rishi's go.
8. [ ] **The summary** in `documentation/harness-eval-v1.md`, "Step 7: tuning". It holds numbers and ids only: never task text, answers, gold, guidance text, notes text or trajectories.
   - **Setup:**
     - the set's name and hashes;
     - the `rlmh` version and commit;
     - the models;
     - `v1-baseline`'s `profile_hash`;
     - the probe (size, seed, task ids);
     - rounds run and `budget_stop`;
     - the estimate against the real cost.
   - **Per round:**
     - for each stage, its decision, attempts, `fell_back` and cost;
     - the probe pass counts per candidate against the reference on the same ids (from `eval report`, for people only; no session saw them);
     - accept: tasks compared and excluded, passed, mean `f2p_share` and mean cost on both sides, and accepted with its reason.
   - **Edits kept** (final against `v1-baseline`):
     - each TOML key, old → new;
     - guidance characters before and after, and lines added and removed;
     - per round, the composer's kept, revised and dropped counts, and the reflector's entry or NO_ENTRY, domain, confidence and verdict counts.
   - **Totals:**
     - rollouts R and sessions P, with costs;
     - library entries per domain;
     - D-170's line: one replicate, and tune-split numbers are what the tuner optimised, so step 8's held-out check is the real test.
9. [ ] **progress.md** (re-read it just before editing). Row 7 goes to `review` with the real cost, and the v1 spend line is updated. The log line holds:
   - the out folder's name, the estimate and the cost;
   - rounds run, which were accepted, and `budget_stop`;
   - `final/`'s `profile_hash`;
   - any D-213 shrink.

## Tests

This step writes no code. Before the go, `bash scripts/verify.sh` (or `scripts\verify.ps1`) passes on the `rlmh` commit used, so the tuner that spends is the one step 6 tested.

## Done when

- The tune ended with `stopped: null`, or Rishi has decided what to do about a stop.
- The real cost is at most the `--max-usd` used, which is at most $9 unless Rishi named more.
- `tune.json`, `final/`, the estimate file and the log exist, and the ledger has the tune's line.
- The summary section is written, and committed in the RLM repo only after Rishi's OK.
- progress.md is updated.
- Rishi has the hand-off below, and if no round was accepted, the third-round offer.

## Out of scope

- The held-out split and shipping the profile (step 8). The Haiku comparison (step 10). `/tune` (step 9).
- Changing the tuner. A bug found here goes back to step 6 as a fix, then this step reruns its estimate.
- Repeats per task (D-170), and a stronger editor model (step 6's alternative to D-174).

## Hand-off

- **Step 8 gets:**
  - `<out>/final/` (`profile.toml`, `guidance.md`);
  - `<out>/tune.json` (final `profile_hash`, accepted rounds);
  - the installed `v1-tuned` profile;
  - step 5's `<date5>-baseline-default/` (its `heldout/` half is step 8's comparator).

  Step 8 runs `v1-tuned` on the held-out split and ships it only if it beats the step 5 baseline `v1-baseline` there (D-173).
- **If no round was accepted** and Rishi declined a third round: `final/` equals `v1-baseline`, no `v1-tuned` is installed, step 8 spends nothing and sets row 8 to `blocked: waiting on Rishi` with its options, and step 10 reports it.
- **progress.md row 7:** `review`, with the cost and the out folder.

## If a decision goes the other way

- **D-179, more money for tuning:** a higher `--max-usd`, only with Rishi's number. More of it lets round 2 fit, and nothing else changes.
- **D-213, shrink differently:** drop round 2 by `--rounds 1` before lowering `--probe`. The probe is then less noisy, but there is one composition fewer.
- **S-43, another tuning model:** `--root`/`--sub` change. Step 5's reference is then for another model and must be re-run, because `--from` must match the models.
- **D-170, two replicates:** about twice the rollouts. One round would need about $14, over S-44's split.
