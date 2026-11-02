# Step 8. Ship the tuned default

| | |
|---|---|
| **Type** | Spend (on Rishi's PC: the eval set, step 5's and step 7's outputs, and parity are there) |
| **Cost** | ≤ $3 (architecture §11). An infra-error rerun comes from the $3 reserve row, with its own go |
| **Depends on** | 7 (and through it 5) |
| **Unblocks** | 10 |
| **Parallel with** | 9 |
| **Decisions it uses** | S-14 (prompt v4 frozen), S-43 (DeepSeek tunes, Haiku checks), S-44 ($30 cap), S-19 (data stays out of this repo); D-144 (user profiles), D-150 (parity verdict), D-152 (`default`'s limits), D-162 (guidance text test), D-170 (one replicate), D-172 (`bypass` in eval), D-173 (acceptance), D-179 (spend split). New here: D-214 |

## Goal

Step 7 produced a tuned profile from the tune split. This step checks it on the 24 held-out tasks it has never seen, against step 5's held-out runs of `v1-baseline`, on the same model. `v1-baseline` is the user profile step 5 made: a byte copy of the built-in `default` after step 3, which is v0.2.0's profile plus the `[compaction]` table, not v0.2.0's raw bytes. It is identified by its `profile_hash`. The tuned profile ships only when it beats `v1-baseline` on held-out, as D-173 requires:
- it passes strictly more held-out tasks than the baseline;
- its mean cost per task is at most 1.5 times the baseline's.

Shipping means the built-in `default` takes the tuned `guidance.md` and the tuned TUNABLE values, and every frozen key stays byte for byte. When the rule fails, nothing ships. Rishi gets the numbers and two options, and the step waits for him. Nothing ships silently in either direction.

## Read first

- [../README.md](../README.md) and [../architecture.md](../architecture.md), whole files. This step leans on §6.4 to §6.6 (running a set, compare, the estimate), §7.2 (TUNABLE and the frozen keys), §7.5 (step 7's output) and §11.
- [../../v0/decisions.md](../../v0/decisions.md), whole file. The lines that matter most are S-14, S-43, S-44, D-150, D-152, D-162, D-170, D-173 and D-179.
- [../../v0/progress.md](../../v0/progress.md), whole file: the v1 table, the spend so far, and the log lines of steps 5 and 7.
- Specs, whole files: [step-02-rlmh-eval.md](step-02-rlmh-eval.md), [step-05-baseline.md](step-05-baseline.md), [step-06-tuner.md](step-06-tuner.md) and [step-07-tuning-round.md](step-07-tuning-round.md).
- Engine, whole files:
  - `engine/rlm_engine/profiles.py`, for `TUNABLE`, `check_tunable`, `load_profile` (a built-in wins over a user profile with the same name) and `file_hash`.
  - `engine/rlm_engine/profiles/default/profile.toml`, `profiles/default/guidance.md` and `profiles/training-v4/profile.toml`.
  - `engine/rlm_engine/service.py`, for `profile.check`.
- Engine tests, whole files: `engine/tests/test_profiles.py`, `test_profile_check.py`, `test_contract.py`, `test_compaction.py` and `test_agentapi.py`. Each pins something about `default`.
- App, whole files: `app/src/cli/eval.ts`, `app/src/eval/runner.ts` (`runEval`), `app/src/eval/report.ts` (`compare`) and `app/src/eval/estimate.ts`.
- `CLAUDE.md`, whole file. Line 53 states `default`'s numbers, and line 57 gives the parity command.
- Harness² paper ([arXiv 2610.14224](https://arxiv.org/abs/2610.14224), [Hugging Face](https://huggingface.co/papers/2610.14224)), Appendix C: Meta-Harness accepts only above the frontier by a margin. D-173 comes from it.
- Outputs, read in full (they hold numbers and ids, never task text):
  - step 5's `default` folder (`eval.json`, `report.md`, `grades.jsonl`);
  - step 7's folder (`tune.json`, `final/`).

## Starting state

- Rows 5 and 7 of progress.md's v1 table are `done`. `<baseline out>` below means step 5's held-out output for `v1-baseline`, `F:\Personal\RLM\RLM\results\harness-eval\<date>-baseline-default\heldout\`, as step 5's log line names it (step 5 writes the tune and held-out halves as two folders). Step 7's output is `…\results\harness-eval\<date>-tune\`, with `tune.json` and `final/`.
- `<home>\profiles\v1-baseline\` exists (step 5). Its `profile_hash` is the one in `<baseline out>\eval.json`, and the built-in `default` still has the same bytes.
- `rlmh eval`, `eval compare`, `eval ledger` and `profile.check` work as steps 2 and 6 built them. Step 5 reran its infra errors once into `<out>\rerun\`, and `report` and `compare` prefer the rerun's grade by id.
- `rlmh eval ledger` shows what v1 has spent. Money that rows 5 and 7 didn't spend carries over (D-179). This step still takes $3 unless Rishi says otherwise.

## Deliverables

**Outside this repo** (on the PC, never committed):
- `<home>\profiles\v1-tuned\`: byte-equal to step 7's `final/`. Step 6 installs it when a round is accepted; this step copies it only if it is absent.
- `…\results\harness-eval\<date>-heldout-tuned\`: the eval output (architecture §6.5), plus `rerun\` if a rerun happened.
- A step 8 section in the RLM repo's `documentation/harness-eval-v1.md`. It holds numbers only, and it is written with Rishi's OK for the RLM repo, as steps 5 and 7 were.

**In this repo, only when the rule holds:**
- `engine/rlm_engine/profiles/default/guidance.md`: step 7's tuned text, byte for byte.
- `engine/rlm_engine/profiles/default/profile.toml`: the TUNABLE values that differ, edited in place. Comments and every frozen key stay byte for byte.
- `engine/tests/test_profiles.py`: the assertions that pin `default`'s values, plus a new frozen-keys test (see Tests).
- Any other test that pins a value the tuned profile changed. Only the expected value changes, never what the test checks.
- `CLAUDE.md` line 53, if a number it states changed.
- `documentation/v0/decisions.md`: the next D-number, recording what shipped (the changed keys, both hashes, the held-out numbers).
- `documentation/v0/progress.md`: row 8 and a log line.

## Tasks

1. [ ] **Check that there is something to test.**
   - Read `tune.json`. If no round was accepted, `final/` is the base, and a held-out run would only repeat step 5.
   - In that case, spend nothing. Write the numbers-only summary, set row 8 to `blocked: waiting on Rishi`, and give him the options in task 8.
2. [ ] **Install the tuned profile, and check both.** Run this from `app/`; `rlmh` below means `..\.bun\bin\bun.exe run src\main.ts`, with the home where Rishi's key is saved.
   - If `<home>\profiles\v1-tuned\` exists (step 6 installs `--name` on acceptance), check that it is byte-equal to `<tune out>\final\`, and stop and report if it isn't. If it is absent, copy `final\` there.
   - `rlmh info` lists both. Check three hashes:
     - `v1-baseline`'s `profile_hash` equals `<baseline out>\eval.json`'s;
     - the built-in `default`'s equals it too;
     - `v1-tuned`'s equals `tune.json`'s final hash.

     If any of the three differs, stop and tell Rishi: the comparison would not be between the profiles that were measured and tuned.
   - Call `profile.check {path: "<home>/profiles/v1-tuned", base: "v1-baseline"}` by hand (CLAUDE.md, "Engine by hand", with the same `RLMH_HOME`). It must return `ok: true`, and `changed` must lie within `TUNABLE` plus `"guidance"`. Keep its `changed` list, because the summary and the D-line name it.
3. [ ] **The guidance still names the tools.**
   - The tuned `guidance.md` must still contain `{shell}`, `fetch(url) -> str`, `200,000` and the eight helper names that `test_default_guidance_text` checks.
   - If one is missing, the tuned default would hide a tool from the model. Report which names are missing, and ask Rishi before going on.
4. [ ] **The estimate ($0).** Use the same models, call format and `--jobs` as step 5's `eval.json`:

   ```
   rlmh eval D:\RLM-data\harness-eval\harness-eval-v1 --split heldout --profile v1-tuned
       --root openrouter/deepseek/deepseek-v4.1-flash-1017 --sub openrouter/deepseek/deepseek-v4.1-flash-1017
       --call-format <step 5's> --jobs <step 5's>
       --tokens-from <baseline out>\runs.jsonl
       --out F:\Personal\RLM\RLM\results\harness-eval\<date>-heldout-tuned
   ```

   Send Rishi the estimate, the cap you'll use (`min(3, what the ledger leaves)`), the permission mode (`bypass`, D-172) and the ledger total. Then wait for his go. If the estimate is over $3, say so and wait. Never trim the task list to fit.
5. [ ] **The run.** After the go, run the same command with `--go --max-usd <cap>`. When it ends, run `rlmh eval ledger` and note the real cost.
6. [ ] **Reruns.**
   - A held-out task with an infra error of a rerunnable kind (as in step 5) gets one rerun, the way step 5 did, into `<out>\rerun\`. That needs a separate estimate and go, from the reserve row.
   - A task that still has a transient or setup infra error on either side is left out of both counts, and listed in the summary. `context_window`, `bad_request` and `capped` count as fails, as in step 5.
7. [ ] **The verdict.**
   - Run `rlmh eval compare <baseline out> …\<date>-heldout-tuned`. It pairs the 24 held-out ids, the only ids both outputs have, so it compares the tuned run with `v1-baseline`'s held-out lines.
   - Over the ids not left out in task 6, compute:
     - P_b and P_t, the passes for the baseline and the tuned profile;
     - C_b and C_t, the mean `cost_usd` per task.
   - **Ship** when P_t ≥ P_b + 1 and C_t ≤ 1.5 × C_b. Otherwise, don't ship.
   - Report as well the mean `f2p_share`, the counts by track and size, McNemar's p, `test_tamper` and `leak_suspect`. These are context: they never turn a "don't ship" into a ship.
8. [ ] **If it doesn't ship.**
   - Write the summary (task 10) and set row 8 to `blocked: waiting on Rishi`.
   - Send him the numbers and two options, in one line each, with the recommendation marked:
     - (a) one more tuning round from `final/`, paid from what earlier rows left unspent; more than that needs Rishi to move money between rows (D-179). Any later held-out check reuses the same 24 tasks, so the write-up must say that the held-out split was looked at twice;
     - (b) ship v1 without a tuned default, so step 10 skips the Haiku comparison and the write-up reports the negative result.
   - Change nothing in this repo.
9. [ ] **If it ships**, in this repo (D-214):
   - Copy the bytes of `v1-tuned\guidance.md` over `profiles\default\guidance.md`.
   - In `profiles\default\profile.toml`, change only the values that `changed` lists, on their own lines, keeping the comments.
   - Check the result with two `profile.check` calls on the built-in folder:
     - `{base: "v1-tuned"}` gives `ok: true` and `changed: []`, and the same `prompt_hash` as `v1-tuned`;
     - `{base: "v1-baseline"}` gives the same `changed` list as task 2.
   - `engine.info` still shows `training-v4`'s `prompt_hash` equal to `TRAINING_HASH`.
   - Update the tests (see Tests) and CLAUDE.md line 53.
   - Add the D-line, run the full gate (`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1`), and fix what fails.
   - Re-run parity from the RLM repo: `.venv\Scripts\python.exe scripts\harness_parity.py --harness F:\Personal\RLM\rlm-harness`. The verdict must match D-150's: read episodes match byte for byte, and no new difference class appears.
10. [ ] **The summary**, numbers only, in the RLM repo's `documentation/harness-eval-v1.md`, under "Step 8":
    - the date, the models, `rlmh --version`, and both profiles' names and hashes;
    - the `changed` list;
    - the held-out n, P_b and P_t, the pass-rate difference and McNemar's p;
    - mean `f2p_share`, C_b, C_t and their ratio;
    - by track and size;
    - infra errors and reruns, the excluded ids, and the estimate against the actual cost;
    - the verdict.

    Add D-170's line: one replicate on 24 tasks can't show significance. Never include task text, answers or transcripts.
11. [ ] **progress.md.** Re-read it just before editing, then:
    - set row 8 to `review` (shipped) or `blocked: waiting on Rishi` (not shipped);
    - add the real spend to the v1 spend line;
    - add a log line with the verdict, the cost, the parity verdict and the D-number.

    Then ask Rishi for the OK to commit and push. Each is its own OK.

## Tests

Engine tests only change when the profile ships. All are offline.

- **`test_profiles.py::test_default_differs_by_guidance_and_limits`**
  - Change the expected `max_turns`, `max_subcalls`, `pace_nudge` and temperatures to the shipped values, typed as literals. These are now our values, not training's. Where a value still equals training's, keep the comparison against `training`.
  - The `system_prompt` and `prompt_hash` assertions stay as they are.
- **`test_profiles.py::test_default_guidance_text`**
  - The D-162 line-count bound becomes the TUNABLE bound, `len(text) <= 12000`.
  - The LF, BOM, `{shell}`, `fetch(url) -> str`, `200,000` and helper-name checks stay. Task 3 makes sure the shipped text passes them.
- **New `test_profiles.py::test_default_frozen_keys`**
  - Loads the built-in `default` and asserts every frozen key of architecture §7.2 against its literal value:
    - `contract`, `cache_api` and `agent_api`;
    - `root_max_tokens` and `subcall_max_tokens` (16,384), `output_max_chars` (8,000), `cell_timeout_s` (120 read, 300 repo), `subcall_max_chars` (60,000) and `subcall_oversize`;
    - `rlm.max_depth` (1);
    - `compaction.reserve` and `compaction.summary_max_tokens`, as step 3 set them.
  - It guards this step and every later edit.
- **`test_compaction.py::test_plan_numbers`**: if `compaction.window` or `keep_ratio` changed, recompute the expected trigger and keep with `compaction.plan` from a scratch copy, never by hand.
- **Any app test** that pins `default`'s `prompt_hash` or a changed value: find it with `rg` over `app/test` and update only the expected value.
- **`test_contract.py`** is untouched and must still pass: `training-v4` hashes to `TRAINING_HASH`.

## Done when

- The verdict is in the summary, in progress.md, and in a reply to Rishi, with the real cost and the ledger total.
- **Shipped:**
  - The full gate prints `VERIFY: PASS` on the PC.
  - Parity matches D-150's verdict.
  - Both `profile.check` results in task 9 hold.
  - CI is green on all three OSes after Rishi's OK to push.
- **Not shipped:** row 8 says `blocked: waiting on Rishi`, the summary is written, and this repo is unchanged.

## Out of scope

- The Haiku comparison, `results.md` and version 1.0.0 (step 10).
- Changing a frozen key or prompt v4's text, even when a tuned candidate wants to (S-14, architecture §7.2).
- Re-running step 5's baseline, or a second replicate (D-170).
- Another tuning round, unless Rishi picks option (a).
- Changing, deleting or moving what steps 5 and 7 wrote: their output folders, `v1-baseline` and step 7's candidate profiles. Making another baseline profile is also out of scope. `v1-tuned` stays as well, because step 10 reads all of them.

## Hand-off

- **Step 10 relies on:**
  - the shipped built-in `default`, and `v1-baseline` and step 5's outputs left as step 5 wrote them. That lets step 10 run `v1-baseline` against the shipped `default` on Haiku;
  - the D-number;
  - the step 8 summary's numbers.

  If row 8 ends unshipped and Rishi picks (b), step 10 skips the Haiku runs.
- **progress.md:** row 8 records the date, verdict, P_b and P_t, C_t / C_b, the estimate against the actual cost, any reruns, the parity verdict and the output path.

## If a decision goes the other way

- **D-173 counts a tie as a win** (P_t ≥ P_b with a higher mean `f2p_share`): task 7's rule changes to match. This spec changes nothing else. With 24 tasks, a tie says nothing about which profile is better, so this is not recommended.
- **Rishi ships a tuned default that didn't beat the baseline:** run task 9 as written, and say it plainly in the D-line, the summary and step 10's write-up.
- **Two replicates (D-170):** run task 5 twice into `-r1` and `-r2`, and compare per-task majorities, as step 2's repeat option describes. That costs about another $3, and it must come from the reserve row.
- **Ship only the guidance, not the TOML values:** task 9 skips the TOML edit, and `profile.check {base: "v1-tuned"}` is expected to list the TUNABLE keys. The held-out result then no longer describes what shipped, so the profile would need a new held-out run.
