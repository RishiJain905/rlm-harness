# v1 results

The experiment behind rlmh 1.0.0, as numbers and task ids only: no task text, answers or test names. Every table here comes from the `rlmh eval` and `rlmh tune` output folders (`report.json`, `grades.jsonl`, `tune.json`) through a script; the folders themselves stay on Rishi's PC, under the RLM repo's git-ignored `results/harness-eval/`.

**In short.** The Harness² tuner accepted no change: its one round was rejected because the account ran out of credit mid-accept, and step 7 stopped there (D-258). What 1.0.0 ships as `default` is the hand-made rlmh-1 profile (D-251, D-256), not a tuned one. On the held-out split it tied the step 5 baseline on passes (17 and 17 on 23 compared tasks) at 1.86 times the cost, so it fails the accept rule D-173 sets; it shipped anyway, by Rishi's decision (D-260). The carry-over check on a second model family was not run (D-194, D-262). One replicate per task, so none of these differences is significant (D-170).

## 1. Setup

- **Set:** `harness-eval-v1`, 48 tasks, 24 per split (tune, held-out); `tasks_sha256` `2e3e600f56cb15531359540d318df6935d92a95309aea4728c0bd5fd7a3949fc`, `grades_sha256` `347f53ba43b2f1e1409d9c543b58a0632b7ec001615af12c1414eac987ecd82c`. Per split: R 6 (research 4, search 2), S 7, M 7, L 4 across python, web and kernel. Built by the RLM repo (`documentation/harness-eval-v1.md` there).
- **Model:** `openrouter/deepseek/deepseek-v4.1-flash-1017` as root and sub-call model in every run, root thinking `high`, call format `auto` (native). Kernel tasks ran on the PC's AMD GPU through HIP (`gpu_backend: "hip"`). Repo tasks ran in `bypass` in throwaway copies (D-172).
- **One replicate per task** in every run (D-170).

| profile | contract | `profile_hash` | runs |
|---|---|---|---|
| `v1-baseline` | v4 | `83f0257bcf41091b34bc796f3a2f8771dc043c6653ef46888ef324aa887f83ac` | step 5 (`f5e23f2`), the D-251 A/B (`db58a8c`) |
| `default` (rlmh-1, shipped) | rlmh-1 | `fcfb93777a14b4d5131e53763fbe1fdd7bcdf7f1fce97f0234931969633b443c` | step 7 reference (`26ae4e2`), step 8 (`2825ad1`) |
| `v1-tuned-r1` (composed, rejected) | rlmh-1 | `796b1f4d1f6092ba59393ea0c2ff0afd059fcfb98d0cbcae0e9fa56080e8c595` | step 7 round 1 (`26ae4e2`) |

`v1-baseline` is the built-in `default` as it stood at `f5e23f2` (D-182): prompt v4 with compaction. Every run reported `harness_version` 0.2.0; 1.0.0 changes no code these runs used.

## 2. Method

v1 follows Harness² ([arXiv 2610.14224](https://arxiv.org/abs/2610.14224); code [google-research/harness2](https://github.com/google-research/harness2) at `6868817`): a model edits the harness itself (its system prompt, guidance, skills and scripts) from the evidence of earlier runs, in two editor sessions (an investigator and a domain editor), whose candidates are probed on a sample of tasks, merged by a composer, and accepted only if the merged profile beats the incumbent on the whole tune split; a reflector then writes what it learned to an experience library. In rlmh this is `rlmh tune` (offline, step 6) and `/tune` (online, step 9); architecture §7.1 maps each stage. The accept rule (D-173) needs at least one more pass than the incumbent and at most 1.5 times its cost per task. The held-out split was run only at step 5 (the baseline) and step 8 (the shipped profile).

## 3. What changed in `default`

The tuner changed nothing: no round was accepted (section 5), so `final/` is `default` itself. Between step 5's baseline and 1.0.0, `default` was changed by hand, in two commits: D-251 (`13af87a`: `scan()`, a reading recipe in the guidance, and `[read] submit_check`) and D-256 (`26ae4e2`: rlmh's own contract, rlmh-1, with its own `system.md`, first messages and observations). `training-v4` is unchanged, byte for byte.

| `profile.toml` key | `v1-baseline` (`f5e23f2`) | `default` (1.0.0) |
|---|---|---|
| `contract` | `"v4"` | `"rlmh-1"` |
| `read.submit_check` | absent | `0.5` |
| `system` | absent | `"system.md"` |

- `guidance.md`: 20 lines, 4302 characters before, 11 lines, 1868 characters after.
- `system.md`: absent before (prompt v4's system prompt), 29 lines, 4927 characters after.

## 4. Held-out split

### DeepSeek V4.1 Flash: `v1-baseline` (step 5) against `default` (step 8)

`v1-baseline`, step 5 (`2026-11-02-baseline-default/heldout`):

| | n | passed | pass rate | mean f2p share | mean turns | mean sub-calls | mean compactions | cost | cache hit | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| total | 24 | 17 | 70.8% | 0.941 | 24.1 | 2.6 | 0.00 | $0.7156 | 85.9% | 263 |
| kernel | 5 | 4 | 80.0% | 0.800 | 26.6 | 6.6 | 0.00 | $0.2771 | 92.2% | 656 |
| python | 8 | 7 | 87.5% | 0.993 | 25.0 | 0.5 | 0.00 | $0.1213 | 76.9% | 101 |
| research | 4 | 1 | 25.0% | - | 6.8 | 2.2 | 0.00 | $0.0338 | 36.6% | 15 |
| search | 2 | 0 | 0.0% | - | 18.5 | 0.5 | 0.00 | $0.0096 | 89.7% | 62 |
| web | 5 | 5 | 100.0% | 1.000 | 36.4 | 3.2 | 0.00 | $0.2739 | 86.8% | 408 |
| L | 4 | 3 | 75.0% | 0.750 | 27.8 | 0.2 | 0.00 | $0.1159 | 81.0% | 340 |
| M | 7 | 6 | 85.7% | 0.992 | 30.0 | 4.9 | 0.00 | $0.2923 | 89.1% | 339 |
| R | 6 | 1 | 16.7% | - | 10.7 | 1.7 | 0.00 | $0.0434 | 68.8% | 31 |
| S | 7 | 7 | 100.0% | 1.000 | 27.7 | 2.6 | 0.00 | $0.2640 | 87.8% | 342 |

`default`, step 8 (`2026-11-05-heldout-default`):

| | n | passed | pass rate | mean f2p share | mean turns | mean sub-calls | mean compactions | cost | cache hit | mean wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| total | 24 | 18 | 75.0% | 0.991 | 27.5 | 12.9 | 0.00 | $1.4854 | 82.7% | 258 |
| kernel | 5 | 5 | 100.0% | 1.000 | 37.8 | 14.6 | 0.00 | $0.5769 | 93.3% | 570 |
| python | 8 | 7 | 87.5% | 0.993 | 25.8 | 1.9 | 0.00 | $0.2467 | 91.4% | 94 |
| research | 4 | 2 | 50.0% | - | 9.8 | 28.2 | 0.00 | $0.0971 | 48.7% | 35 |
| search | 2 | 0 | 0.0% | - | 19.0 | 20.5 | 0.00 | $0.0752 | 71.7% | 65 |
| web | 5 | 4 | 80.0% | 0.978 | 37.6 | 13.6 | 0.00 | $0.4896 | 73.2% | 463 |
| L | 4 | 3 | 75.0% | 0.972 | 36.5 | 11.2 | 0.00 | $0.4102 | 72.0% | 494 |
| M | 7 | 6 | 85.7% | 0.992 | 33.3 | 8.4 | 0.00 | $0.5354 | 90.5% | 286 |
| R | 6 | 2 | 33.3% | - | 12.8 | 25.7 | 0.00 | $0.1723 | 57.4% | 45 |
| S | 7 | 7 | 100.0% | 1.000 | 29.1 | 7.4 | 0.00 | $0.3676 | 93.4% | 277 |

**Paired, on the 23 ids where neither run had an infra error** (excluded: `kernel-L-02`, `v1-baseline`'s one infra line; `default` passed it):

- passed: `v1-baseline` 17, `default` 17
- both 16, `v1-baseline` only 1 (`web-L-02`), `default` only 1 (`research-R-05`), neither 5; McNemar's exact p 1.00
- mean `f2p_share` (repo tasks): 0.997 against 0.990
- cost per task: $0.0311 against $0.0579, ratio 1.86
- **D-173: not met.** It needs at least 18 passes and a ratio of at most 1.50 (D-259). `default` shipped by Rishi's decision (D-260).

On all 24 ids, the infra line counted as a fail (`rlmh eval compare`, `compare-deepseek.txt`): both 16, `v1-baseline` only 1, `default` only 2, neither 5; McNemar's exact p 1.0000; cost ratio 2.08.

| track | n | `v1-baseline` passed | `default` passed | `v1-baseline` cost | `default` cost | `v1-baseline` sub-calls | `default` sub-calls |
|---|---|---|---|---|---|---|---|
| kernel | 4 | 4 | 4 | $0.2771 | $0.4238 | 33 | 53 |
| python | 8 | 7 | 7 | $0.1213 | $0.2467 | 4 | 15 |
| research | 4 | 1 | 2 | $0.0338 | $0.0971 | 9 | 113 |
| search | 2 | 0 | 0 | $0.0096 | $0.0752 | 1 | 41 |
| web | 5 | 5 | 4 | $0.2739 | $0.4896 | 16 | 68 |

| size | n | `v1-baseline` passed | `default` passed |
|---|---|---|---|
| R | 6 | 1 | 2 |
| S | 7 | 7 | 7 |
| M | 7 | 6 | 6 |
| L | 3 | 3 | 2 |

The extra cost is sub-calls: 310 against 63 over the split, up in every track, while turns rose from 24.1 to 27.5 a run. Neither run compacted.

**D-170:** one replicate on 24 held-out tasks can't show a significant difference; a gain or loss of one or two tasks is within noise.

### Claude Haiku 5.5: not run

The spec's carry-over check (two held-out runs on `openrouter/anthropic/claude-haiku-5.5`, S-43) measures whether a tuned profile helps on a second model family. No tuned profile was shipped, so it was skipped and spent nothing (D-194, D-262). Every v1 number here comes from one model.

## 5. Tune split (in-sample)

These runs chose and checked changes on the tune split, so they are in-sample and say little about other tasks.

| run | profile | n | passed | infra | cost |
|---|---|---|---|---|---|
| step 5 baseline (`2026-11-02-baseline-default/tune`) | `v1-baseline` | 23 | 18 | 0 | $1.8721 |
| step 7 reference (`2026-11-05-baseline-rlmh1/tune`) | `default` | 24 | 21 | 0 | $1.9413 |

Step 5's tune half has 23 graded lines: `kernel-L-01` was cut off by a power cut and not run again. On the 23 ids both ran, `v1-baseline` passed 18 and `default` 20 (both 18, `v1-baseline` only 0, `default` only 2, neither 3; McNemar's exact p 0.50), at $0.0814 against $0.0721 a task (ratio 0.89).

**The D-251 A/B** (2026-11-04, `db58a8c`, the 6 reading tasks of the tune split, two replicates each, $0.9239), which chose D-251's parts:

| run | `profile_hash` | n | passed | mean sub-calls | cost |
|---|---|---|---|---|---|
| `v1-baseline-1` | `83f0257b` | 6 | 3 | 1.3 | $0.0810 |
| `v1-baseline-2` | `83f0257b` | 6 | 3 | 3.0 | $0.0960 |
| `d251-recipe-1` | `ec87c14b` | 6 | 2 | 13.3 | $0.1548 |
| `d251-recipe-2` | `ec87c14b` | 6 | 2 | 17.5 | $0.0813 |
| `d251-v2-1` | `46df1b52` | 6 | 3 | 19.3 | $0.1103 |
| `d251-v2-2` | `46df1b52` | 6 | 2 | 12.8 | $0.0776 |
| `d251-full-1` | `4ea0bba1` | 6 | 2 | 13.7 | $0.1774 |
| `d251-full-2` | `4ea0bba1` | 6 | 3 | 12.2 | $0.1455 |

**Step 7, round 1** (`2026-11-05-tune`, base `default`, arm A, not gated; $1.8499 against an estimate of $2.1992 and a cap of $4.25). The probe sample was 10 ids: `research-R-01`, `research-R-03`, `search-R-01`, `python-S-01`, `python-M-01`, `python-L-01`, `web-S-02`, `web-M-02`, `kernel-S-01`, `kernel-M-02`; the reference passed 8 of them.

| stage | decision | `profile_hash` | changed | cost |
|---|---|---|---|---|
| inv session | EDIT | `b3c6ecc1` | `guidance`, `scripts/ctx_index.py`, `skills/read-pass/SKILL.md` | $0.0421 |
| dom session | EDIT | `3ac765f6` | `guidance`, `system`, `scripts/docindex.py`, `skills/codesearch/SKILL.md`, `skills/read-answer/SKILL.md` | $0.1522 |
| compose session | MERGE | `796b1f4d` | `guidance`, `system`, `scripts/ctxmap.py`, `skills/codesearch/SKILL.md`, `skills/read-corpus/SKILL.md` | $0.0965 |
| reflect session | KEEP_BASE (fell back) | - | - | $0.0000 |

| run | n | passed | infra | cost |
|---|---|---|---|---|
| inv | 10 | 7 | 0 | $1.1009 |
| dom | 10 | 3 | 4 | $0.3340 |
| composed | 24 | 1 | 23 | $0.1241 |

The composed profile's accept run lost 23 of 24 tasks to OpenRouter's HTTP 402 (the account was out of credit; recorded as `infra:other`, since D-257's `no_credit` kind came later), and their rerun failed the same way, so the round was rejected with reason `infra` on 1 compared task. The domain probe lost 4 tasks to the same 402s. The reflector fell back and wrote nothing. After this, eval and tune stop at once on `no_credit`, `auth` and `no_key` (D-257), and Rishi stopped tuning after one round, with arm B, round 2 and the gated arm not run (D-258).

## 6. `training-v4`

Not run in v1 (D-249). It is the LoRA's profile, frozen on prompt v4, and the LoRA arm left v1 (S-41).

## 7. Integrity

`test_tamper` counts runs whose edits to the task's tests (or a new `conftest.py`) were undone before grading, so every grade is on the original tests. `leak_suspect` counts runs whose messages named the set's path, its hidden-test folder, or an f2p test's function name or title; it never changes a grade, and this write-up did not read the flagged runs by hand.

| run | n | passed | infra | `test_tamper` | `leak_suspect` |
|---|---|---|---|---|---|
| step 5 tune, `v1-baseline` | 23 | 18 | 0 | 3 | 12 |
| step 5 held-out, `v1-baseline` | 24 | 17 | 1 | 4 | 9 |
| D-251 A/B `v1-baseline-1` | 6 | 3 | 0 | 0 | 0 |
| D-251 A/B `v1-baseline-2` | 6 | 3 | 0 | 0 | 0 |
| D-251 A/B `d251-recipe-1` | 6 | 2 | 0 | 0 | 0 |
| D-251 A/B `d251-recipe-2` | 6 | 2 | 0 | 0 | 0 |
| D-251 A/B `d251-v2-1` | 6 | 3 | 0 | 0 | 0 |
| D-251 A/B `d251-v2-2` | 6 | 2 | 0 | 0 | 0 |
| D-251 A/B `d251-full-1` | 6 | 2 | 0 | 0 | 0 |
| D-251 A/B `d251-full-2` | 6 | 3 | 0 | 0 | 0 |
| step 7 reference, `default` | 24 | 21 | 0 | 5 | 11 |
| step 7 probe inv | 10 | 7 | 0 | 2 | 5 |
| step 7 probe dom | 10 | 3 | 4 | 0 | 2 |
| step 7 composed (accept) | 24 | 1 | 23 | 0 | 1 |
| step 7 composed, infra rerun | 23 | 0 | 23 | 0 | 0 |
| step 8 held-out, `default` | 24 | 18 | 0 | 6 | 7 |

Infra reruns: only the composed accept run's (23 tasks, all failed again on the 402). Step 5's held-out `kernel-L-02` (`infra:other`, the PC paused) was not rerun, by Rishi's choice.

## 8. Spend

All on Rishi's OpenRouter key; the v1 ceiling was $30 (S-44).

| step | run | estimate | cap | cost |
|---|---|---|---|---|
| 5 | tune split | $1.5673 | $7.00 | $1.8721, plus about $0.4 not in any file (the cut-off `kernel-L-01`) |
| 5 | held-out | $1.5673 | $4.50 | $0.8298 |
| D-251 | A/B, 8 runs of 6 tasks | $0.2328 each | $0.47 each | $0.9239 |
| 7 | reference | $0.9576 | $2.50 | $1.9413 |
| 7 | tune, round 1 | $2.1992 | $4.25 | $1.8499 |
| 8 | held-out | $0.8978 | $3.00 | $1.4854 |
| 10 | Haiku check | not run | | $0 |
| | **total** | | | **$8.9024**, about $9.30 with the unrecorded part, of $30 |

Real costs ran from 0.53 to 2.03 times their estimates; no run hit its cap.

## 9. Limits

- One replicate per task, and 24 held-out tasks: no difference here is significant (D-170).
- One model family: the Haiku 5.5 check was not run (D-262).
- `default` changed by hand between step 5 and step 8, after its tune-split runs were seen; the held-out split was looked at twice.
- Web-Bench has been public since 2025, so a model may have seen its projects (D-222).
- Kernel tasks ran on an AMD GPU through HIP; a CUDA run of the same set may differ (D-223).
- The tuner's editor sessions ran on the tuning model, DeepSeek V4.1 Flash (D-174), and only one round ran, cut short by the 402s.
