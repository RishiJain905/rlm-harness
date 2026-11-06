<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L1105-L1163 (experience: all sections),
commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: offline there is no blind selection, so "which output was finally submitted" became the
composed harness and its runs on every tune task, and the adoption section says the composer chose by reading
trajectories; `context/base_harness/` became `harness/`; the OUTPUT FORMAT is submit.md's reflector shape (JSON).
-->
<!-- part: frame -->
You are reading the complete record of one improvement round: a base harness, the edits proposed
against it, the executions those edited harnesses produced, the harness the composer made from
them, and that composed harness's executions on every task. Write two things for a library that
future rounds read before they make their own edits.
<!-- part: body -->
# THE ADOPTED CANDIDATE IS NOT THE ONLY EVIDENCE

The composer chose what to keep by reading these same trajectories, so its choice says which
edits looked supported -- not which edit worked. Treat every candidate as evidence. An edit that
appeared only in a dropped candidate may still be the one that changed behavior for the better,
and an edit inside the composed harness may have contributed nothing. Read the trajectories,
not the verdict.

# WHAT EACH EDIT DID

Diff every candidate harness against `harness/` (each candidate's `candidates/<label>/diff.md`).
For each component any candidate changed, write one row: the component, what the edit actually
changed, the observed difference in execution it produced, and a verdict.

Verdicts are `helped`, `hurt`, `no observed effect` and `confounded`. Use `confounded` -- and
prefer it -- whenever a candidate changed several components at once and no execution isolates
one of them, or when a single rollout is all that stands behind the difference. A confounded row
is a useful record; an invented attribution poisons the library for every later task. Cite the
run and the point in the trajectory where behavior diverges. If two candidates changed the same
component in different ways, say which forms were tried and what each produced.

# THE ONE LESSON THAT TRANSFERS

Now write at most one durable entry, and only if the edit rows support it.

The `cue` describes the SHAPE OF SITUATION the lesson applies to, so it can fire on a different
matter. Not this task's facts -- the pattern. The `lesson` is the operation to perform on a
harness, stated so it can be applied and checked, and it must name the component it concerns.

Too generic is useless ('be thorough'); too specific never fires again ('the fee rose to 250 on
Jan 1'). Aim between: 'when an instrument performs several sequential acts and one of them
terminates the actor's own authority, order them so the terminating act comes last'.

The `evidence` field cites the edit rows the lesson rests on. A lesson resting only on
`confounded` rows is a guess: narrow it to what the record does show, or decline. Adoption alone
never establishes that an edit helped or will transfer. If the record shows no concrete, reusable
execution contrast, give NO_ENTRY in place of the entry -- the edit rows are still worth writing.
