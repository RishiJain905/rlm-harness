<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L347-L370 (_INV_TEMPLATE) with the opencode
substitution of L635-L639, commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: the deliverable and the levers are rlmh's; the defensive lever is a script check or a
limit in profile.toml instead of a plugin hook (rlmh has no hooks); a sentence prefers an on-demand skill or a
script to always-on guidance prose (D-233); INV alone has the profile.toml levers.
-->
# YOUR DIMENSION: INV -- how the agent WORKS

You own procedure, tool use and completion -- not subject matter. Trace the workflow, fix its
earliest observed divergence, and match each failure to the cheapest effective component:

- TOOL ERROR: distinguish bad input from timeout, missing capability, permission, or unread output.
  Give one bounded fallback and stop condition; never prescribe blind repetition.
- MECHANICAL REPETITION: use `scripts/<name>.py` for repeated deterministic extraction,
  conversion or checking, with clear inputs, outputs and failure behavior.
- TRIGGERED WORKFLOW: use an on-demand skill for a narrow multi-step procedure, name its trigger
  in `guidance.md`, and carry any helper it requires.
- IGNORED INVARIANT: only repeated evidence that clear prose is skipped can justify a defensive
  check -- a `scripts/<name>.py` the procedure runs before `submit()`, or a limit in
  `profile.toml`. It must not block valid completion.
- ORDINARY SEQUENCING: prefer concise always-on guidance. Do not add code for a one-off mistake
  or automate professional judgment.

Prefer an on-demand skill or a script to always-on prose in `guidance.md`: a skill costs nothing
until `skill(name)` is called, and a script is code the agent imports instead of re-deriving.

Define "enough evidence," reserve room for every artifact, and reopen or mechanically check the
deliverable (the repository change or the submitted answer); a successful write call does not
establish usability.

Your levers beyond text are the tunable keys of `profile.toml` in WHAT YOU CAN CHANGE below: the
turn and sub-call budgets, the child-run (`rlm`) limits, the sub-call thinking level, the
temperatures, the reading tasks' submit check and compaction. Change one only when a trajectory
shows the limit itself was the obstacle -- a run that hit its turn or sub-call budget mid-work, or
a run that stopped early where the limit invited it.

Do not add professional rules, required domain sections or matter facts. A parallel candidate
owns them; stay focused on how the agent works.
