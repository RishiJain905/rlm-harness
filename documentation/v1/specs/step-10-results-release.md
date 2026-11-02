# Step 10. Experiment write-up and the 1.0.0 release

| | |
|---|---|
| **Type** | Spend, then release |
| **Cost** | At most $6 (D-179) of Rishi's OpenRouter key, spent only after his go on the estimate. Infra reruns come from the $3 reserve row. Never W&B credit |
| **Depends on** | 8, 9 |
| **Unblocks** | none: this ends v1 |
| **Parallel with** | none |
| **Decisions it uses** | S-41 (no LoRA arm), S-43 (Haiku 5.5 checks carry-over), S-44, S-45 (1.0.0), S-47; D-170 (one replicate, the significance note), D-173, D-179; step 5's D-182 (`v1-baseline`); step 2's D-197 (`--rerun`). From v0: D-46, D-121, D-126, D-130, D-149, D-151, D-166, D-167. New here: D-194, D-195 |

## Goal

Find out whether the tuned `default` carries over to a second model family, write the whole v1 experiment down as numbers, and ship v1 as 1.0.0.

Two held-out runs on `openrouter/anthropic/claude-haiku-5.5` measure the carry-over: `v1-baseline`, the profile step 5 measured, and the tuned `default` step 8 shipped. `rlmh eval compare` pairs them. `documentation/v1/results.md` then holds every v1 number (baseline, tuning, the two held-out checks, spend) with D-170's note next to each comparison. Finally the version becomes 1.0.0 everywhere, CI goes green, and the tag, the release and npm each go out on Rishi's own OK.

## Read first

Read these whole, before doing anything:

- [../README.md](../README.md), and [../architecture.md](../architecture.md) (§1, §6.5, §6.6, §7.1, §11).
- [../../v0/decisions.md](../../v0/decisions.md): S-41, S-43, S-44, S-45, S-47, D-121, D-126, D-130, D-149, D-151, D-166, D-167, D-170, D-173, D-179.
- [../../v0/progress.md](../../v0/progress.md), whole: the v1 table, the spend line, and the log lines of steps 5, 7, 8 and 9 (their commits, out folders and costs).
- v1 specs: [step-01-eval-sets.md](step-01-eval-sets.md) (the set), [step-02-rlmh-eval.md](step-02-rlmh-eval.md) (the commands, `--rerun` and the output folder), [step-05-baseline.md](step-05-baseline.md) (D-182, `v1-baseline`), [step-08-ship-tuned-default.md](step-08-ship-tuned-default.md), and the Hand-off sections of [step-04-follow-ups.md](step-04-follow-ups.md) and [step-09-user-tune.md](step-09-user-tune.md) (what the release notes must say).
- v0: [../../v0/specs/step-10-install.md](../../v0/specs/step-10-install.md) and [../../v0/npm-install.md](../../v0/npm-install.md) (how a release and an npm publish work, and the one-time npm setup).
- This repo, whole files:
  - `.github/workflows/release.yml`, `npm.yml`, `ci.yml`; `scripts/npm-pack.sh`; `npm/rlmh/package.json`, `npm/platform/package.json`.
  - `app/package.json`, `app/src/version.ts`, `engine/pyproject.toml`, `engine/rlm_engine/__init__.py`, `engine/tests/test_link.py`.
  - `engine/rlm_engine/profiles.py`: how a user profile loads, why it can't be named like a built-in, and what `profile_hash()` covers (the LF-normalised `profile.toml`, a NUL, the guidance file; not the name).
  - `app/src/cli/update.ts`, `install.sh`, `install.ps1`.
  - `README.md`, `CLAUDE.md`, `documentation/legacy/architecture.md` (§ Versions).
- RLM repo, read-only: `documentation/harness-eval-v1.md` (the set: ids, sizes, families) and `scripts/harness_parity.py`.
- Harness² ([arXiv 2610.14224](https://arxiv.org/abs/2610.14224), read through `hf://papers/2610.14224/paper.md` in a cloud container; code [google-research/harness2](https://github.com/google-research/harness2) at `6868817518876de8fd170c6a8354daca273b6191`): the evaluation section and Appendix C, for the method paragraph of `results.md`.

## Starting state

- Rows 1 to 9 of the v1 table are `done`. Step 5 made the user profile `<home>/profiles/v1-baseline/` and wrote its outputs to `<date>-baseline-default\{tune,heldout}\` and `<date>-baseline-training-v4\heldout\`. Step 8 shipped the tuned values in `engine/rlm_engine/profiles/default/`, kept `v1-tuned` (or `v1-tuned-gated`, when step 7 kept the gated arm, D-234), and wrote `<date>-heldout-tuned\`. Step 9 shipped `/tune` (on/off), `/tuned`, `tune.model` and the library.
- `<home>/eval/ledger.jsonl` (the home steps 5 to 8 used, where the OpenRouter key is saved) holds every v1 spend so far, and the progress.md spend line agrees with it.
- The version is still `0.2.0`. v0.2.0 is the latest release on GitHub.
- The eval set is `D:\RLM-data\harness-eval\harness-eval-v1\`. Eval outputs go to `F:\Personal\RLM\RLM\results\harness-eval\` (git-ignored, D-46).

## Deliverables

| Path | What |
|---|---|
| `results\harness-eval\<date>-heldout-haiku-baseline\`, `<date>-heldout-haiku-tuned\` (RLM repo, git-ignored) | The two `rlmh eval` output folders, with a `rerun\` folder inside when a run had transient infra errors, and `compare-haiku.txt`, `compare-deepseek.txt` |
| `documentation/v1/results.md` | The experiment write-up: numbers, task ids and sizes only (below) |
| `documentation/releases/v1.0.0.md` | Release notes: what 1.0.0 adds (D-195) |
| `.github/workflows/release.yml` | The Release step puts `documentation/releases/<tag>.md` above the fixed install text when the file exists |
| Version files | `1.0.0` (task 9) |
| `README.md`, `CLAUDE.md`, `documentation/legacy/architecture.md` | Status and roadmap (task 10) |
| `documentation/v0/progress.md` | Row 10, the spend line, a log line |

**`results.md`** holds, in this order:
1. **Setup.** The set (`harness-eval-v1`, `tasks_sha256`, `grades_sha256`, 48 tasks, 24 per split), the two models, every profile with its `profile_hash`, the harness commit of each run, one replicate per task.
2. **Method.** One paragraph: Harness² (the paper and the repo, linked as above) and how v1 maps it (architecture §7.1); the accept rule on the tune split (D-173); the held-out split touched only at steps 5, 8 and 10.
3. **What tuning changed.** Each changed `profile.toml` key with its old and new value, and the guidance's line and character counts before and after, linking step 8's commit for the text.
4. **Held-out, DeepSeek** (step 5's `v1-baseline` held-out output against step 8's) and **held-out, Haiku 5.5** (this step). For each: pass counts by track and size, pass rate, mean `f2p_share`, mean turns, sub-calls and compactions, cost per task, cache hit, both/A only/B only/neither, McNemar's exact p, and D-170's note.
5. **Tune split, in-sample.** Step 5's tune half and step 7's rounds, each with its pass count and cost, labelled in-sample.
6. **`training-v4`** on the held-out split from step 5, as context, not as a contender.
7. **Integrity.** Infra errors and reruns, `test_tamper` and `leak_suspect` counts per run.
8. **Spend.** Each step's estimate, cap and real cost, and the total against $30.
9. **Limits.** One replicate; 24 held-out tasks; Web-Bench has been public since 2025, so a model may have seen its projects (D-222); kernel tasks ran on the PC's AMD GPU through HIP, so a CUDA run of the same set may differ (D-223); the editor sessions ran on the tuning model (D-174).

## Tasks

1. [ ] **Start.** Check that rows 8 and 9 are `done`, then set row 10 to `in progress`. Read step 8's row: if it shipped no tuned default, follow D-194 below instead of tasks 3 to 8.
2. [ ] **Budget.** `rlmh eval ledger` must agree with the progress.md spend line; if not, stop and tell Rishi. The ceiling is min($6, $30 − spent). Using money earlier rows left over needs Rishi to say so on the estimate.
3. [ ] **The baseline profile** (D-182). `rlmh info` must list `v1-baseline` as a user profile whose `profile_hash` equals the one in step 5's `<date>-baseline-default\heldout\eval.json`.
   - If the folder is missing, recreate it from the commit step 5 ran (`eval.json`'s `harness_commit`, or row 5). In Git Bash, not PowerShell (5.1's `>` writes UTF-16), write `git show <commit>:engine/rlm_engine/profiles/default/profile.toml` and `…/guidance.md` into `<home>/profiles/v1-baseline/`, then check the hash again.
   - If the hash still differs, stop and tell Rishi: the comparison would not be the one step 8 made.
4. [ ] **The tuned profile.** `rlmh info` must list the built-in `default` with step 8's `profile_hash`. Note the current commit. If `engine/` or `app/src/gateway/` changed since step 8's commit (`git diff --stat <c> HEAD -- engine app/src/gateway`), list the changes in the estimate post.
5. [ ] **Estimate, $0.** From the same home, on the PC:
   ```
   rlmh eval D:\RLM-data\harness-eval\harness-eval-v1 --split heldout --root openrouter/anthropic/claude-haiku-5.5 --sub openrouter/anthropic/claude-haiku-5.5 --profile v1-baseline --tokens-from <step 5 heldout out>\runs.jsonl --tokens-from <step 8 out>\runs.jsonl
   ```
   and the same with `--profile default`.
   - The call format is `auto` (native for Haiku). `--jobs` matches step 5.
   - **Post both estimates to Rishi** in one message: runs, price per size, totals, each run's `--max-usd`, the ceiling, what remains of $30, and the manifest's `permission_mode` line. Each `--max-usd` is at most half the ceiling for the baseline, and the ceiling minus the baseline's real cost for the tuned run.
   - If the planned total is above the ceiling, propose `--sample 12 --seed haiku-v1` for both runs, estimate again, and say the sample loses half the held-out tasks.
   - **Wait for his go.** A go covers that estimate only; a change of model, profile, sample or cap means estimating and asking again.
6. [ ] **Run.** The baseline first, then the tuned profile, each with `--go --max-usd <x> --out F:\Personal\RLM\RLM\results\harness-eval\<date>-heldout-haiku-{baseline,tuned}`. Don't interrupt a run unless the cap or Rishi says so.
7. [ ] **Infra reruns** (D-197). For each output with a transient infra error, `rlmh eval <set> --rerun <out> --go --max-usd <what is left of the $3 reserve>` reruns those tasks once into `<out>\rerun\`. The estimate post names this rule, so its go covers it; a rerun above the reserve needs a new go. A setup error (`auth`, `no_key`, `unknown_model`, `workspace`, `host_bug`) is reported to Rishi, not rerun. A second failure stays an infra error, counted as not passed (D-170).
8. [ ] **Compare and record.**
   - `rlmh eval compare <haiku baseline> <haiku tuned>` into `compare-haiku.txt`, and `rlmh eval compare <date>-baseline-default\heldout <date>-heldout-tuned` into `compare-deepseek.txt`, both in the results folder. `compare` reads rerun lines first (`readGrades`).
   - `rlmh eval ledger` shows this step's lines. Write the real cost into row 10 and the spend line, and tell Rishi the result in one message: pass counts, p, cost.
9. [ ] **Version 1.0.0** (S-45). Change exactly these:
   - `app/package.json` `version`, `app/src/version.ts` `APP_VERSION`, `engine/pyproject.toml` `version`, `engine/rlm_engine/__init__.py` `__version__`;
   - `engine/uv.lock`, regenerated with `uv lock --project engine`, never by hand; its diff is the one `rlm-engine` version line;
   - the assertion in `engine/tests/test_link.py` (`info["version"]`) and the `Smoke --version` check in `.github/workflows/ci.yml` (`rlmh 1.0.0`).

   These stay: `npm/*/package.json` (`0.0.0`; `npm-pack.sh` stamps the version), the example `"version": "0.1.0"` in `protocol/examples.json`, and the `0.2.0` test inputs in `app/test/update.test.ts` and `app/test/setup.test.ts`. Afterwards `git grep -n "0\.2\.0" -- . ':!documentation'` shows only those test lines.
10. [ ] **Docs.**
    - **`results.md`**, as listed above. Its tables come from `report.json` and the compare files through a scratch script outside both repos, never typed, and are read against `report.md` afterwards.
    - **`documentation/releases/v1.0.0.md`**: the tuned `default` (one line of headline numbers and a link to `results.md`), `rlmh eval`, `rlmh tune`, `/tune` (an on/off switch, off by default), `/tuned`, the `tune.model` setting, skills and scripts in profiles (D-233), and the library, follow-ups and the `conversation.follow_ups` setting, compaction, and protocol 2 (an installed 0.x engine is not reused; `rlmh update` sets up the new one).
    - **`release.yml`**: in the Release step, write `documentation/releases/$GITHUB_REF_NAME.md` and a blank line into `notes.md` when that file exists, then append the fixed text (`cat >>`).
    - **`README.md`**: the status paragraph says 1.0.0, what v1 added, and links `results.md` and `documentation/v1/README.md`.
    - **`CLAUDE.md`**: `**Status: v1 built.**`, with one sentence per v1 step and its date, as v0's status has.
    - **`documentation/legacy/architecture.md` § Versions**: the v1 row says what shipped as 1.0.0 and what it was done when (this step). The LoRA arm leaves it for a row after v3 (S-41). v3 stops saying "for users this is version 1" (S-45), and "Only v0 has build steps so far" names v0 and v1.
11. [ ] **No task text leaked.** A scratch script outside both repos reads the set and fails if `results.md`, the release notes or any changed doc holds:
    - any 40-character run of a task's `question`;
    - a gold value longer than 3 characters;
    - an f2p or p2p test id;
    - the string `hidden/`, or the set's path.
12. [ ] **Parity, on the PC.** From the RLM repo, `.venv\Scripts\python.exe scripts\harness_parity.py --harness F:\Personal\RLM\rlm-harness`. The verdict must equal the last accepted run in the log: read episodes byte for byte, and no difference class beyond those accepted.
13. [ ] **Verify.** The full gate passes: `scripts\verify.ps1` on the PC, and `bash scripts/verify.sh` in a container when one is in use. actionlint on `release.yml` and `ci.yml` (a scratch venv, as CLAUDE.md says) reports nothing.
14. [ ] **Push and CI.** Ask Rishi to commit and push to `dev_rishi` (his OK). CI must be green on macOS, Windows and Linux, the `install` job included. Merging into `main` is Rishi's call.
15. [ ] **Release**, each part on its own OK.
    - **Tag.** `v1.0.0` on `main`'s commit, after CI passed on that exact commit (release.yml checks it). `release.yml` builds four binaries, publishes the release with `SHA256SUMS`, then calls `npm.yml`.
    - **npm.** Before tagging, check that `NPM_PUBLISH` is `1` and that `release.yml` is the trusted publisher of `rlm-harness` and the four `@rlmh/<platform>-<arch>` packages (npm-install.md § Setting up publishing). The `npm` environment's reviewer approves the publish. If the tag run didn't publish, a `workflow_dispatch` of `npm.yml` with `tag: v1.0.0, publish: true` is a separate OK.
16. [ ] **Release checks.**
    - A fresh install with `install.ps1` (PC) and `install.sh` (a container) prints `rlmh 1.0.0`, and the first start sets up `<home>/engine/1.0.0/`.
    - An installed 0.2.0's `rlmh update --check` reports 1.0.0, and `rlmh update --yes` installs it.
    - `npm i -g rlm-harness@1.0.0` and `bun add -g --trust rlm-harness@1.0.0` give `rlmh 1.0.0`, and `npm view rlm-harness dist-tags` shows `latest: 1.0.0`.
    - The release page shows the 1.0.0 notes above the install text.
17. [ ] **progress.md.** Row 10 is `done` only once the release and npm are published. Add a log line with the two out folders, the compare results, the cost, the parity verdict, the CI run, the release and npm versions.

## Tests

- No new test file. The version is carried by `test_link.py`'s assertion and `ci.yml`'s smoke check, and CI's `install` job installs the 1.0.0 build on three OSes.
- The `release.yml` change is checked by the gate's `workflows` stage (zizmor) and by actionlint.
- The rest are the hand checks of tasks 3, 4, 11, 12 and 16.

## Done when

- Rishi's go is in the chat after the estimate and before the first `--go`, and this step's cost in the ledger is at most its ceiling.
- Both Haiku output folders hold 24 graded lines each (12 with the sample), with every transient infra error rerun once.
- `results.md` holds every number listed above, D-170's note beside each comparison, and passes task 11's check.
- `git grep` shows 1.0.0 everywhere the version lives; parity's verdict is unchanged; the full verify gate passes.
- CI is green on three OSes on the tagged commit; the v1.0.0 release has four binaries, `install.sh`, `install.ps1` and `SHA256SUMS`; npm's `latest` is 1.0.0.
- `git -C F:\Personal\RLM\RLM status --short` shows nothing under `results/` or `private/`.

## Out of scope

- The LoRA experiment (S-41): it waits until the desktop app is out.
- Repeats per task (D-170), new tasks, other models.
- Code changes beyond the version and the `release.yml` lines. A bug found here is fixed in the file's own step, with a log line. If it changes `engine/` or `app/src/gateway/`, the Haiku runs repeat, on a new estimate and go.
- Code signing, and any change to the installers.

## Hand-off

- v1 is finished. The roadmap's next version (v2, TUI polish and a local web UI) gets its own kit.
- `results.md` is the reference for anyone who asks whether the tuned `default` helps. `rlmh eval` and the set stay usable for later profiles.
- progress.md: row 10 `done`, the log line, and the final spend line.

## If a decision goes the other way

- **S-45, stay on 0.x.** The version is `0.3.0` in task 9's files, the tag is `v0.3.0`, the notes are `documentation/releases/v0.3.0.md`, and v3 keeps "for users this is version 1".
- **S-43, another check model.** `--root` and `--sub` change, and the estimate with them. A model whose catalog entry has `tool_call: false` runs fenced through `auto`; `results.md` says so.
- **S-44 or D-179.** Only the ceiling changes.
- **D-170, repeats.** Not affordable within $6 for 24 tasks on two profiles; with more money, step 2's `repeats` applies and the cost scales with it.
- **D-182, v0.2.0's own bytes as the baseline.** The baseline becomes a profile from `git show v0.2.0:…`. It has no `[compaction]`, so the comparison then mixes tuning with compaction, and `results.md` must say so. Step 5's and step 8's runs would change with it.
- **D-194, step 8 shipped no tuned default.** Skip tasks 3 to 8 and spend nothing. `results.md` reports the negative result from steps 5, 7 and 8, and 1.0.0 still ships with `rlmh eval`, `rlmh tune`, `/tune`, follow-ups and compaction.
- **D-195, notes by hand.** `release.yml` stays as it is, and after the release, the body is replaced on GitHub with the notes and the install text, as part of the release's OK.
