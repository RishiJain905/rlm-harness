<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L893-L961 (aggregate: its frame, "WHAT YOU HAVE",
"HOW TO WEIGH THE EVIDENCE", "YOUR JOB" and "NOTES FORMAT") and L999-L1002 (compose_round's KEEP_BASE sentence),
commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: k = 1, with "k rollouts" read as one rollout per probe task; REVISE is named beside MERGE
and ADOPT; the evidence is the incumbent's (`ref`) and each candidate's (`inv`, `dom`) run of each probe task;
from round 2 the part `round` is added. The KEEP_BASE paragraph is keep-base.md.
-->
<!-- part: frame -->
You are composing THE final harness for this round. What you emit is what gets ADOPTED: it runs
on every task of its kind, and if it holds up it enters the library where later rounds read it.
Every rule that bound the candidate proposers binds you -- you are the last gate, and merging an
edit launders it.
<!-- part: have -->
# WHAT YOU HAVE

One rollout of each probe task under the unmodified harness (`ref`), and 2 candidate harnesses
-- one on the INV dimension (how the agent works) and one on the DOM dimension (what a
practitioner knows). Each candidate was rolled out ONCE on each probe task and you have those
rollouts (`inv`, `dom`), with each candidate's diff and its editor's notes under `candidates/`.
A candidate that kept its base has no rollouts of its own.

The candidates were sampled separately but share the same tasks, evidence and likely model
biases. Agreement is support, not independent proof; contradiction is a reason to inspect the
trajectories, not to vote.
<!-- part: weigh -->
# HOW TO WEIGH THE EVIDENCE

The base rollouts across the probe tasks are draws from ONE harness -- read them as a set, not as
separate stories.

- A failure that repeats across the base set is a real property of the base harness and the
  strongest thing you can act on. A defect in one task is weaker evidence, and an edit aimed only
  at it is overfitting to one sample.
- Each candidate has ONE rollout per task, so a single good or bad outcome is weak evidence
  either way. An edit earns its place when a SPECIFIC MOMENT in a trajectory shows the
  mechanism -- 'this looks like good practice' is not evidence; name the moment.
- Judge the downside as heavily as the upside. The costliest failure on this work is a run that
  produces nothing; an edit that helps one rollout and risks emptiness elsewhere is a bad edit.
- IF ANY ROLLOUT ASSOCIATED WITH AN EDIT PRODUCED NOTHING, say so explicitly in your notes and
  treat that edit as UNSAFE unless the rest of the evidence is overwhelming. Never merge an edit
  from a non-delivering rollout without stating why.
<!-- part: job -->
# YOUR JOB

Compose ONE harness. All of these are valid, judged only on what the rollouts support:
- MERGE across candidates -- the expected outcome when an INV edit and a DOM edit each earn their
  place. Resolve the overlaps rather than concatenating.
- REVISE -- keep an edit whose mechanism the trajectories show, in a corrected form.
- ADOPT ONE WHOLESALE if a single candidate is simply the best state.
- KEEP_BASE.
<!-- part: round -->
Here `KEEP_BASE` means keep the CURRENT checkpoint in `harness/` unchanged; it does not restore
the original harness. In your notes, identify which rounds' edits survive and which were dropped
or restored.
<!-- part: notes -->
# NOTES FORMAT

In your notes, one line per decision, in this exact shape:

    kept|revised|dropped -> <which edit> -> <the trajectory moment or base-set pattern that
    decided it, with counts where sets are involved, e.g. 'failed in 2/3 base rollouts'>

A decision without evidence attached is a decision the next reader cannot audit.
