# Step 1. Freeze the v0 spec

| | |
|---|---|
| **Type** | Design: doc work, no code |
| **Cost** | $0 |
| **Depends on** | none |
| **Unblocks** | 2, and through it every other step |
| **Parallel with** | none |
| **Decisions it uses** | all open decisions 1a to 10a; the D-calls in [../decisions.md](../decisions.md); D-41 (9a may wait for step 9) |

## Goal

Rishi reads the v0 spec and these build docs, and answers the open decisions or accepts their defaults. The thread records each answer, fixes the specs an answer changes, and marks the spec frozen. From then on, every later step codes against a fixed link, contract and layout. The contract is what the LoRA learned, so it has to be pinned before any code copies it.

## Read first

- [../README.md](../README.md), [../architecture.md](../architecture.md), [../decisions.md](../decisions.md) and [../progress.md](../progress.md).
- [../../legacy/v0-build-plan.md § Step 1](../../legacy/v0-build-plan.md#step-1-freeze-the-v0-spec), and every "Decisions for this step" block in that file.
- [../../legacy/v0-design.md](../../legacy/v0-design.md), in full.
- [../../legacy/architecture.md](../../legacy/architecture.md) § The three parts, § Why the model makes sub-calls, § Keys and providers, and § Safety without Docker.
- No training files: step 3 reads them.

## Starting state

- **rlm-harness** is at `e3ae151` plus the uncommitted `documentation/v0/` folder. Nothing is built.
- **Bun 1.4.4** is in `.bun/` (git-excluded), and uv is on Rishi's PC.
- **Every open decision** is marked "open: specs assume the default" in decisions.md. 9a has no default.
- **The D-calls (D-01 to D-51)** were made while writing these docs and haven't been reviewed by Rishi.

## Deliverables

| Path | Change |
|---|---|
| `documentation/v0/decisions.md` | Each open decision either becomes a settled S-line (the date, the pick and Rishi's reason) or stays open with a note. Any D-call Rishi overturns is rewritten, keeping its number |
| `documentation/v0/specs/step-*.md` | Each spec whose decision went the alternative way: apply that spec's "If a decision goes the other way" line, rewrite the affected sections, and delete the line |
| `documentation/v0/architecture.md` | Only where an answer changes a shared name, path or message (likely only 2a, 2b or 3a) |
| `documentation/legacy/v0-design.md` | The header becomes "Frozen <date> as the v0 spec". Each "(decision Nx)" mark that now has an answer gets the pick in brackets, e.g. "(4a: Git Bash, else PowerShell)" |
| `documentation/legacy/v0-build-plan.md` | The status table row for step 1 becomes "Done <date>". The "current 1.3 release" Bun default gets "superseded by S-15 (1.4.4)" |
| `documentation/v0/progress.md` | Row 1 is `done` with the date, and a log line lists the answers |

No code, no new files.

## Tasks

1. [x] Set row 1 in progress.md to `in progress`, with this thread's name.
2. [x] Send Rishi one message listing the open decisions as in [../decisions.md § Open decisions](../decisions.md#open-decisions): the default, the alternative, and the steps each affects. Ask for answers in the build plan's form, e.g. "2a Ink, 4a yes". Say that silence on a decision means its default.
3. [x] In the same message, list the D-calls most worth his eyes, because they change behaviour the model or the user will notice:
   - D-01 (how the worker starts)
   - D-08 and D-09 (thinking levels and limits taken from training's v4 limits)
   - D-11 (the repo-mode `context` text and test-hint detection)
   - D-13 to D-15 (what asks for approval, "allow for this run", and denial outside the app)
   - D-16 (fetch)
   - D-33 (reasoning re-attached on the wire for providers that demand it)
   - D-42 (UTF-8 mode for the engine and worker) and D-44 (binaries never load a `.env` from the folder they run in)
   - D-46 (one `results/harness-*/` line in the RLM repo's `.gitignore`)
   Ask whether any should change.
4. [x] Also list the gaps in the parent docs that these docs had to fill, so he can check the fills. Use [../decisions.md](../decisions.md): each D-line names the gap it fills.
5. [x] Wait for the answers. Ask follow-up questions only where an answer is ambiguous.
6. [x] For each answer, edit decisions.md as in Deliverables. A pick that matches the default becomes "S-n (<date>) <decision>, the default. Why: <his reason, or 'accepted default'>".
7. [x] For each alternative picked, apply the "If a decision goes the other way" line in every spec listed under "Used by". Then re-read each changed spec against architecture.md, checking paths, method names, test names and dependencies.
8. [x] If 2b goes the other way, rewrite architecture.md §9, the `home()` definition and every `~/.rlm-harness` mention in the specs. If 3a goes the other way, apply step 3's 3a line: the frozen texts and `test_hash_matches_training` stay, and the profile-level hash check moves to a separate profile that still renders `/work/repo`. Note it in architecture.md §7.6.
9. [x] Leave 9a open if Rishi hasn't picked yet, with the note "asked again at step 9 before the estimate" (D-41).
10. [x] Update v0-design.md and v0-build-plan.md as in Deliverables.
11. [x] Run the checks below, and fix anything they find.
12. [x] Set row 1 to `done`, and add a log line: `<date> step 1 (<thread>): frozen; answers: 1a …, 2a …, …`.
13. [x] Tell Rishi what changed, file by file, and that the docs are ready to commit when he says so. Don't commit.

## Tests

There is no code, so these are document checks, run from `F:\Personal\RLM\rlm-harness`:

| Check | Passes when |
|---|---|
| `grep -n "open: specs assume" documentation/v0/decisions.md` | only the 9a row matches, or none once 9a is answered |
| `grep -rn "If a decision goes the other way" documentation/v0/specs` | the section remains in each spec; lines for decisions already settled say "settled: <pick>" or are removed |
| `grep -rnE "TODO\|TBD\|\?\?\?" documentation/v0 --exclude=step-01-freeze-spec.md` | no matches |
| Relative links | every `](../…)` and `](specs/…)` target in documentation/v0 exists, checked with a short script or by hand |
| Cross-check | every file path named in a spec appears in architecture.md §2, and every test file named in a spec appears in architecture.md §11 |

## Done when

- [x] Rishi has answered 1a, 2a, 2b, 3a, 4a, 4b, 5a, 5c, 6b, 6c and 10a, or said to take the defaults. 5b and 6a are already settled, and 9a may wait for step 9 (D-41).
- [x] decisions.md shows each of those as settled, with a date.
- [x] Every spec affected by an alternative pick has been rewritten, and the checks above pass.
- [x] v0-design.md's header says "Frozen" with the date.
- [x] progress.md row 1 is `done`.

## Out of scope

- Any code, `package.json` or CI file: that is step 2.
- Picking the smoke-run models: 9a is asked at step 9, unless Rishi answers it now.
- Plans for v1 and later versions, which wait until v0 is done (S-12).
- Committing or pushing: only on Rishi's say-so.

## Hand-off

- **Step 2** can start, against a frozen architecture.md and decisions.md.
- **Later edits** to v0-design.md or architecture.md need a log line in progress.md and Rishi's agreement, because parallel threads rely on them.
- **In progress.md**, write row 1 as `done`, with the date and the list of answers.

## If a decision goes the other way

This step is where decisions are made, so it has no alternative path. For each open decision, the one-line consequence sits in the specs that use it, under this same heading.
