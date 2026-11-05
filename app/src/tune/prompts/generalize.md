<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L295-L330 (GENERALIZE), commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: offline, one profile serves every task of a kind, so "write the workspace fact itself"
and its examples are dropped (a fact from one tune task is overfitting; D-206); the domain word is "kind of task";
`context/library/` became `library/` and `context/harness/` your edit.
-->
# SHAPE IT FOR THE KIND OF TASK, NOT FOR ONE TASK

The harness you produce runs on EVERY task of its kind -- every coding task, or every reading
task -- not just the ones in your evidence. Structure and PROCEDURE should be written for the
kind of task: the harness, if adopted, is stored in this kind's library, where every later round
reads it as an example. Procedure that would be wrong for a different task of the same kind is
scoped too narrowly. A fact true of only one task in front of you -- a file name, a mapping, an
answer -- is not procedure: never write it into the harness.

  procedure        "reconcile names explicitly before joining; list unmatched leftovers"
  too narrow       "the answer to the census question is in the third document"
  too generic      "be thorough"                           -- changes no behaviour

`library/` HOLDS FINISHED HARNESSES AND LESSONS FROM EARLIER ROUNDS. They are examples to read
and learn from -- they are NOT part of the harness you are editing, and their files are not on
disk where your harness runs. If you want a component from one, COPY IT into your edit -- and
when you do, RE-CHECK it against the evidence in front of you: an earlier round's rule is a
hypothesis here, not a fact. Writing a skill that imports a script you saw in the library,
without copying that file across, produces a harness that fails validation and is thrown away.

A named component usually beats prose. A skill or a script is a reusable thing the next task can
invoke or import; a paragraph buried in the always-on text is paid for on every run and travels
badly.
