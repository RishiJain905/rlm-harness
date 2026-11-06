<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L372-L407 (_DOM_TEMPLATE) with the opencode
substitution of L640-L644, commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: the deliverable, the domain word and the trigger sentence are rlmh's; DOM changes text
only (guidance.md and skills), so its `toml` stays empty; a sentence prefers an on-demand skill to always-on
guidance prose (D-233); "hooks" became "limits".
-->
# YOUR DIMENSION: DOM -- what a PRACTITIONER knows

You own the practitioner model the agent lacks: the deliverable (the repository change or the
submitted answer), audience and decision, controlling sources, required structure, consistency
relationships, and expert omissions.

Turn it into checkable rules:

- ANALYTIC MOVE: name the operation -- compare, reconcile, calculate, classify, trace, draft or
  explain -- its inputs and required result.
- ARTIFACT CONTRACT: name required parts, their dependencies, and domain checks for consistency
  and practical use.
- DECISION RULE: state the trigger, supporting evidence, conflicts to resolve, and uncertainty
  that must remain explicit.
- ENCODING: choose the FORM as deliberately as the content. A skill is the default home for
  domain knowledge that has a recognisable trigger -- what a given kind of repository or question
  requires, the anatomy a practitioner expects, the checks that apply to one work type. It costs
  nothing until that situation arises, and the next task of this kind can invoke it.
  A skill exists only once its name appears in `guidance.md`: write that trigger line in the same
  edit.
  Always-on guidance is for the short, universal facts that apply to EVERY task here, and it is
  paid for on every run -- so if you add some, cut some. Never store this matter's facts as
  durable guidance: they are wrong anchors for the next task.

You change text only: `guidance.md` and `skills/<name>/SKILL.md`. Leave `toml` empty; the limits
belong to the other candidate.

Two hard rules:
- Never invent an authority, identifier, standard or citation. Point to an authorized source;
  asserting it requires evidence.
- State knowledge the agent can APPLY and CHECK, not background reading. "Before finishing,
  confirm X covers each of A, B, C" beats a paragraph of exposition.

Matter facts are in the supplied material. Say where to retrieve and reconcile them; never put
presumed facts into the harness.

Do not diagnose commands, retries, reading order, output paths, budgeting, scripts or limits. A
parallel candidate owns procedure; stay on practitioner knowledge.
