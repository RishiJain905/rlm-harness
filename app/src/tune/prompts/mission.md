<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/context.py L521-L546 (mission), commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: "on disk, in `context/`" became "in your `context`, one part per file", with each part's
header and the layout of the folder; the renderer-truncation sentence names the evidence writer's own markers.
-->
# YOUR EVIDENCE

It is in your `context`, one part per file: each part starts with a line `=== <path> ===`, and
every path ends in one of the names below, relative to the evidence folder. Read it -- do not
answer from this message alone.

{{layout}}

Every trajectory EVENT is present: the trajectory was not clipped to fit this mission. An
individual output may carry the REPL's own cut, and a deliverable may end with "[cut at 60,000
characters by the evidence writer]"; those markers are ours, not behavior by the solver. Do not
diagnose them as a solver failure. A run shown as "(withheld by the evidence guard)" is not
evidence either way.

Read each `task.md` and the current harness first. Inventory every available rollout or
candidate and inspect each at least once before deciding. For a candidate, compare what changed
from its editing baseline, what behavior changed in its rollout, what improved, and what
regressed or remained unresolved. Then deep-read the evidence relevant to any edit. Cite the
specific trajectory moment behind every change; one you cannot trace to a moment is speculation.
