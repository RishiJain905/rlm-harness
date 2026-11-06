<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L824-L890 (propose: its frame, its round_t paragraph
L851-L857 and "HOW TO DECIDE WHAT TO CHANGE" L858-L877), commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: k = 1, so the "candidate i of k" sentence is dropped; the round paragraph is the part
`round` below, added from round 2.
-->
<!-- part: frame -->
You are adapting an autonomous agent's harness.
<!-- part: how -->
# HOW TO DECIDE WHAT TO CHANGE

Every edit must trace to a moment in a trajectory. For each one ask: which run did what, and
would this text have changed it? If you cannot name the moment, the edit is speculation and
costs context for nothing. Prefer, in order:
  1. a DIVERGENCE -- the runs disagreed, so the agent can already do it and just needs
     telling. This is the cheapest win.
  2. a repeated concrete failure -- the same error or omission in every run.
  3. a risk visible in a trajectory but not yet realised.
Do not fix what the runs already got right, and do not restate what the harness already says
clearly; duplicated instruction dilutes the rest.
<!-- part: round -->
This is round {{round}}. You are editing the checkpoint the previous round produced, not the
original harness, and the evidence includes every earlier round. In this stage `KEEP_BASE` means
leave that CURRENT checkpoint unchanged; it never resets to the original harness.
<!-- part: commit -->
Do not hedge toward an average or try to cover every base -- commit to the single most
defensible version of your dimension. A later stage compares and merges.
