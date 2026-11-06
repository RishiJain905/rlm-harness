# Step 7. Tuning round

| | |
|---|---|
| **Type** | Spend |
| **Cost** | At most $9 (D-179) of Rishi's OpenRouter key. `rlmh tune` prints its estimate first, and it is spent only after his "go" in chat. D-234's comparison runs round 1 twice, about $14 at the priors, so the step asks Rishi before going over $9 (task 3). Never W&B credit |
| **Depends on** | 5, 6 |
| **Unblocks** | 8 |
| **Parallel with** | 9 |
| **Decisions it uses** | S-43, S-44, S-46; D-170, D-173, D-174, D-175, D-179; step 5's `v1-baseline`; step 6's D-204 to D-212; D-233 (skills and scripts are tunable) and D-234 (this step decides on subagents and nudges). New here: D-213, and the D-number that records D-234's result |

## Goal

Run `rlmh tune` for real:
- **Set:** `harness-eval-v1`'s tune split (24 tasks).
- **Model:** DeepSeek V4.1 Flash 1017 for every run and every session (S-43).
- **Base:** `--base v1-baseline`, step 5's user profile. Round 1's reference is the tune half of step 5's output, `results/harness-eval/<date>-baseline-default/tune/`.
- **Two arms, round 1 each** (D-234), with the same probe of 10 and seed:
  - **arm A**, without the gate: `--name v1-tuned`, into `<date>-tune/`;
  - **arm B**, with `--gated`, so the editors may also write `agents/` and `nudges.toml`: `--name v1-tuned-gated`, into `<date>-tune-gated/`.
- **The decision.** C5 and C8 stay only if arm B adopted a candidate that uses them and arm B's result passes more tune tasks than arm A's at no more mean cost per task (D-234). The arm that wins is the kept arm.
- **Round 2,** on the kept arm only, with `--continue`, and only if its fresh estimate fits under what is left of the step's cap (D-212).
- **Output:** the RLM repo's git-ignored `results/harness-eval/<date>-tune/` and `<date>-tune-gated/`.

Then write a numbers-only summary, including which edits survived and the D-234 result, and hand step 8 the kept arm's `final/` folder and `tune.json`. The only code this step may change is D-234's switch: when C5 and C8 stay, `TUNABLE_GATED` joins `TUNABLE` and the gate turns on by default (task 7). If no round is accepted, it says so and offers a third round, paid from what step 7 didn't spend; more than that needs Rishi to move money between rows (D-179).

## Read first

Read these whole:

- **The paper.** Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", [arXiv 2610.14224](https://arxiv.org/abs/2610.14224), also on [Hugging Face](https://huggingface.co/papers/2610.14224) (`hf://papers/2610.14224/paper.md` in a cloud container). Read:
  - §2.2, one improvement round;
  - Appendix C, the Meta-Harness acceptance this step's numbers report;
  - Appendix D.2, rollouts and sessions as the cost units;
  - Appendix E.1 and Figure 19, what the paper shows and doesn't show about subagents and nudges (D-234).
- **The code.** [google-research/harness2](https://github.com/google-research/harness2) at `6868817518876de8fd170c6a8354daca273b6191`, Apache-2.0:
  - `harness2/core/ledger.py`, whole file (R and P, which the summary reports);
  - `harness2/core/recursion.py`, `run_sequential` L463;
  - `harness2/core/prompts.py`, `aggregate` L893 (the notes format whose lines the summary counts) and `experience` L1105 (the four verdicts).
- [../architecture.md](../architecture.md): §6.5, §6.6, §7.5, §7.7 and §11.
- [../../v0/decisions.md](../../v0/decisions.md): S-43, S-44, D-170, D-173 to D-175, D-179, D-233, D-234.
- [step-05-baseline.md](step-05-baseline.md) (how `v1-baseline` is made and where its output goes), [step-06-tuner.md](step-06-tuner.md) (Tasks 9 to 12, and Hand-off) and [step-08-ship-tuned-default.md](step-08-ship-tuned-default.md) (Read first and Starting state: what it needs from here).
- [../../v0/specs/step-09-smoke-run.md](../../v0/specs/step-09-smoke-run.md): the model for a spend step (estimate, go, cap, numbers-only summary).
- RLM repo, read-only until Rishi says otherwise: `documentation/harness-eval-v1.md` (steps 1 and 5's sections) and `.gitignore` (`results/harness-*/`, D-46).
- This repo: `app/src/cli/tune.ts` and `app/src/tune/offline.ts`, as step 6 built them, and `engine/rlm_engine/profiles.py` (`GATED`, `TUNABLE`, `TUNABLE_GATED`) with `engine/tests/test_gated.py` and `test_profile_check.py`, which task 7 changes if C5 and C8 stay.

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
| `results/harness-eval/<date>-tune/`, `<date>-tune-gated/` (RLM repo, git-ignored) | Each arm's output: `tune.json`, `rounds/`, `library/`, `final/`. `<date>` is `YYYY-MM-DD` |
| `results/harness-eval/<date>-tune{,-gated}.estimate.txt`, `<date>-tune{,-gated}.log` | Each arm's printed estimate, and its `--go` runs' stdout and stderr (round 2's `--continue` appends to the kept arm's log) |
| `documentation/harness-eval-v1.md` (RLM repo) | A "Step 7: tuning" section, numbers only. It is committed only with Rishi's OK |
| `documentation/v0/progress.md` (this repo) | Row 7, the v1 spend line and a log line |
| `documentation/v0/decisions.md` (this repo) | The next D-number: D-234's result, with both arms' numbers |
| `engine/rlm_engine/profiles.py`, its tests, `app/src/tune/prompts/surface*.md`, architecture §7.2 (this repo) | Only when C5 and C8 stay (task 7) |
| `<home>/profiles/v1-tuned/`, `v1-tuned-gated/` | Each installed by its arm only if a round was accepted |
| `<home>/eval/ledger.jsonl` | One `tune` line per `--go` |

**The commands** (in `app/` from source, use `bun run src/main.ts` for `rlmh`). Use step 5's `--sub`, which is the same model unless its `eval.json` says otherwise. Arm A:

```
rlmh tune D:\RLM-data\harness-eval\harness-eval-v1 ^
  --root openrouter/deepseek/deepseek-v4.1-flash-1017 --sub openrouter/deepseek/deepseek-v4.1-flash-1017 ^
  --base v1-baseline --name v1-tuned --from <RLM>\results\harness-eval\<date5>-baseline-default\tune ^
  --rounds 1 --probe 10 --seed 0 --jobs 4 ^
  --tokens-from <RLM>\results\harness-eval\<date5>-baseline-default\tune\runs.jsonl ^
  --tokens-from <RLM>\results\harness-eval\<date5>-baseline-default\heldout\runs.jsonl ^
  --out F:\Personal\RLM\RLM\results\harness-eval\<date>-tune
```

Arm B is the same command with `--name v1-tuned-gated`, `--gated` and `--out …\<date>-tune-gated`. Round 2 on the kept arm is `rlmh tune … --continue <kept out> --rounds 2`, with the same `--tokens-from` flags and that arm's `--gated` or not.

`<RLM>` is `F:\Personal\RLM\RLM`, and `<date5>` is step 5's date. The held-out run log adds token figures only; no held-out task enters the tune. Run it on the machine step 5 ran on, with the same `RLMH_HOME`. In a cloud container, use `\` → `/` paths and the set folder step 5 used there.

## Tasks

1. [ ] **Check the inputs** ($0).
   - `rlmh eval report <date5>-baseline-default/tune`: note its pass count, mean `f2p_share` and infra count. The report reads through `readGrades`, so step 5's `rerun/` lines already count.
   - **More than 6 infra errors left** (a quarter) would make every round end as `infra` (D-209). If they are transient and step 5 has not used `--rerun` on that folder, ask Rishi whether to run `rlmh eval SET --rerun <date5>-baseline-default/tune` first, from the reserve row. Otherwise, stop and ask.
   - `rlmh eval ledger`: note the total so far.
2. [ ] **Estimate** ($0). Run both arms' commands without `--go`, saving their output to `<date>-tune.estimate.txt` and `<date>-tune-gated.estimate.txt`, and estimate round 2 with `--rounds 2` on arm A's command. Each lists, per round:
   - the probe and accept rollouts;
   - the four sessions;
   - the total, the cap and the ledger total.

   Expect about $7 for each arm's round 1 at §6.6's priors, so about $14 for both:
   - two probes of 10 tasks, about $1.5 each;
   - the composed run on all 24, about $3.75;
   - sessions, about $0.5.

   Round 2 on the kept arm is about $7 more. The real figures come from step 5's tokens. D-234's comparison is what doubles round 1, and the estimate says so.
3. [ ] **Fit the ceiling** (D-213, D-234).
   - **The cap.** $9 is the step's ceiling, unless Rishi gives a higher number from step 5's leftover (D-179 carries unspent money forward). Also check that the ledger total plus the cap leaves steps 8 and 10 and the reserve their rows; if not, ask.
   - **If both arms' round 1 is over the cap,** estimate both again with `--probe 6`; both arms always use the same probe and seed, so the comparison stays fair. If they are still over (about $12 at the priors), ask Rishi for the difference from step 5's leftover or the reserve row. If he declines, run arm A alone with the old plan (`--rounds 2`); C5 and C8 then stay out, untested, and the D-number says so.
   - **Splitting the cap.** Arm A runs with `--max-usd` at half the cap, and arm B with what arm A left. Round 2 gets only what is left after both. The tuner decides again before round 2 with real tokens (D-212).
4. [ ] **Ask for the go.** Post in chat:
   - the per-arm and per-round table, the total and the cap, and how the cap is split;
   - D-234's decision rule, in one line;
   - the ledger total, with the $30 left after this cap;
   - the models, `v1-baseline`'s `profile_hash`, and the probe size and seed;
   - the exact `--go` commands, round 2's `--continue` included.

   Wait for Rishi's "go". Without one, nothing runs. The go covers round 2 on the kept arm within the same cap.
5. [ ] **Run** arm A, then arm B, each with `--go --max-usd <its share>`, stdout and stderr to its log. Don't interrupt either unless Rishi asks.
   - **Exit 1, `stopped: "max_usd"`:** report what finished. Nothing reruns without a new go. A stopped arm B leaves C5 and C8 out, and the D-number says why.
   - **Exit 1 for any other reason** (engine exit, error): report the stage, the error and the cost. `--continue` can't resume a stopped tune, so ask.
6. [ ] **Check the output** ($0), for each arm.
   - `tune.json` has every stage, and `final/` exists. Arm B's `tune.json` has `gated: true`.
   - `rlmh eval report` on each `rounds/<r>/evals/*`: note pass counts, `infra`, `test_tamper` and `leak_suspect`. Any `leak_suspect` goes in the summary, with its task id.
   - **`final/guidance.md` holds nothing task-specific.** Check it for every tune task's id, package, Web-Bench project or kernel function name, and every hidden test path. Step 8 ships this text into a public repo, so report any hit and don't ship it silently.
   - **`final/`'s skills and scripts hold nothing task-specific either**, by the same check, and `profile.check {path: final, base: "v1-baseline"}` (with `gated: true` for arm B) is ok.
   - The real cost is at most the cap, and the ledger has one new `tune` line per `--go`.
7. [ ] **Decide C5 and C8** (D-234, $0). Each arm's result is its `final/`: the accepted composition, or `v1-baseline` when round 1 wasn't accepted. Its tune-split numbers come from that composition's accept eval, or from step 5's reference. Compare on the tune ids that neither side left out:
   - **Adopted:** arm B's round 1 was accepted, and `profile.check {path: <arm B>/final, base: "v1-baseline", gated: true}` lists `agents/…` or `nudges.toml` in `changed`.
   - **More passes:** arm B's pass count is strictly higher than arm A's.
   - **No more cost:** arm B's mean `cost_usd` per task is at most arm A's.

   **All three hold:** C5 and C8 stay, and arm B is the kept arm. Ask Rishi's OK for the code change, then:
   - set `profiles.GATED = True` and move `TUNABLE_GATED`'s rows into `TUNABLE`;
   - fold `surface-gated.md` into `surface.md`, so the drift test still holds and every tune offers them;
   - change only the expectations in `test_gated.py` and `test_profile_check.py` that assumed the gate was off;
   - update architecture §7.2 and §7.5;
   - run the full gate.

   **Otherwise:** C5 and C8 stay out of `TUNABLE`, their code stays off, and arm A is the kept arm. Nothing in this repo changes but the D-line.

   **Either way,** add the next D-number to decisions.md: both arms' passes, mean `f2p_share` and mean cost on the compared ids, whether arm B adopted C5 or C8 (and which files), and the result.
8. [ ] **Round 2 on the kept arm,** if its fresh estimate fits under what is left of the cap: `rlmh tune … --continue <kept out> --rounds 2 --max-usd <left>`, with the kept arm's `--gated` or not, output appended to its log. **`budget_stop: 2`** means round 2 didn't fit. This is a normal end, and it goes in the summary.
9. [ ] **If no round of the kept arm was accepted**, report it with the accept numbers. Then offer a third round:
   - **The run:** `rlmh tune … --continue <kept out> --rounds 3 --max-usd <X>`, where X is step 7's unspent money, or more only if Rishi moves it from another row (D-179);
   - **First:** its estimate (the same command without `--go`);
   - **Then:** only on Rishi's go.
10. [ ] **The summary** in `documentation/harness-eval-v1.md`, "Step 7: tuning". It holds numbers and ids only: never task text, answers, gold, guidance text, skill or script text, notes text or trajectories.
    - **Setup:**
      - the set's name and hashes;
      - the `rlmh` version and commit;
      - the models;
      - `v1-baseline`'s `profile_hash`;
      - the probe (size, seed, task ids);
      - rounds run per arm and `budget_stop`;
      - the estimate against the real cost, per arm.
    - **D-234's comparison:** both arms' round-1 results on the compared ids (passes, mean `f2p_share`, mean cost), whether arm B adopted C5 or C8, the result and its D-number.
    - **Per round, per arm:**
      - for each stage, its decision, attempts, `fell_back` and cost;
      - the probe pass counts per candidate against the reference on the same ids (from `eval report`, for people only; no session saw them);
      - accept: tasks compared and excluded, passed, mean `f2p_share` and mean cost on both sides, and accepted with its reason.
    - **Edits kept** (final against `v1-baseline`):
      - each TOML key, old → new;
      - guidance characters before and after, and lines added and removed;
      - skills and scripts (and, on arm B, agents and nudge rules) added, changed and removed, by count and file name, with their character counts;
      - per round, the composer's kept, revised and dropped counts, and the reflector's entry or NO_ENTRY, domain, confidence and verdict counts.
    - **Totals:**
      - rollouts R and sessions P, with costs;
      - library entries per domain, per arm;
      - D-170's line: one replicate, and tune-split numbers are what the tuner optimised, so step 8's held-out check is the real test.
11. [ ] **progress.md** (re-read it just before editing). Row 7 goes to `review` with the real cost, and the v1 spend line is updated. The log line holds:
    - both out folders' names, the estimates and the costs;
    - rounds run per arm, which were accepted, and `budget_stop`;
    - the D-234 result and its D-number, and the kept arm;
    - the kept `final/`'s `profile_hash`;
    - any D-213 shrink, and any code change task 7 made.

## Tests

This step writes no code, except task 7's when C5 and C8 stay. Before the go, `bash scripts/verify.sh` (or `scripts\verify.ps1`) passes on the `rlmh` commit used, so the tuner that spends is the one step 6 tested. After task 7's change, the full gate passes again before round 2, and round 2 runs on that commit.

## Done when

- Both arms ended with `stopped: null`, or Rishi has decided what to do about a stop.
- The real cost is at most the caps used, which add up to at most $9 unless Rishi named more.
- Each arm's `tune.json`, `final/`, estimate file and log exist, and the ledger has a line per `--go`.
- D-234's result is a D-number in decisions.md; if C5 and C8 stayed, the gate is on in the code and the full gate passes.
- The summary section is written, and committed in the RLM repo only after Rishi's OK.
- progress.md is updated.
- Rishi has the hand-off below, and if no round was accepted, the third-round offer.

## Out of scope

- The held-out split and shipping the profile (step 8). The Haiku comparison (step 10). `/tune` (step 9).
- Changing the tuner, except task 7's switch. A bug found here goes back to step 6 as a fix, then this step reruns its estimate.
- Repeats per task (D-170), and a stronger editor model (step 6's alternative to D-174).

## Hand-off

- **Step 8 gets** the kept arm's output (`<date>-tune/` and `v1-tuned`, or `<date>-tune-gated/` and `v1-tuned-gated` when C5 and C8 stayed):
  - `<out>/final/` (`profile.toml`, `guidance.md`, and any `skills/`, `scripts/`, `agents/` and `nudges.toml`);
  - `<out>/tune.json` (final `profile_hash`, accepted rounds);
  - the installed tuned profile;
  - the D-234 D-number;
  - step 5's `<date5>-baseline-default/` (its `heldout/` half is step 8's comparator).

  Step 8 runs `v1-tuned` on the held-out split and ships it only if it beats the step 5 baseline `v1-baseline` there (D-173).
- **If no round was accepted** and Rishi declined a third round: `final/` equals `v1-baseline`, no `v1-tuned` is installed, step 8 spends nothing and sets row 8 to `blocked: waiting on Rishi` with its options, and step 10 reports it.
- **Step 9 gets** the D-234 result: when C5 and C8 stayed, `/tune`'s candidates may hold `agents/` and `nudges.toml` too, since they are in `TUNABLE`.
- **progress.md row 7:** `review`, with the cost, both out folders and the kept arm.

## If a decision goes the other way

- **D-179, more money for tuning:** a higher `--max-usd`, only with Rishi's number. More of it lets round 2 fit, and nothing else changes.
- **D-213, shrink differently:** skip round 2 on the kept arm before lowering `--probe`. The probe is then less noisy, but there is one composition fewer.
- **S-43, another tuning model:** `--root`/`--sub` change. Step 5's reference is then for another model and must be re-run, because `--from` must match the models.
- **D-170, two replicates:** about twice the rollouts. One round would need about $14, over S-44's split.
- **D-234, no comparison:** run arm A alone with `--rounds 2`, as before D-234. C5 and C8 then never enter `TUNABLE`, and about $7 is saved.
- **D-234, judged on the probes instead of the accept evals:** cheaper, since arm B could stop before its accept eval, but the probe subset is too small to show a difference of one task.
