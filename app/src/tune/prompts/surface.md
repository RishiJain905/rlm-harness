<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L95-L177 (_SURFACE_OPENCODE's "# WHAT YOU CAN CHANGE"),
commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: (D-256) system.md is a tunable file of rlmh-1 harnesses. Also: rlm-harness's own surface, replacing _SURFACE_OPENCODE: the components are rlmh's
(guidance.md, profile.toml's tunable keys, skills/ and scripts/; v1 architecture §7.2, D-233), the tables are
`profiles.TUNABLE`, `FROZEN` and the skill and script bounds (a test keeps them equal), subagents and plugins are
left out (subagents are surface-gated.md's, plugins don't exist here), and the Jinja rule is dropped. harness2's
reasons for preferring on-demand components, its three discard rules and its deliverable-shape paragraph are kept.
-->
# WHAT YOU CAN CHANGE

The harness is a folder of components. Each has a different runtime cost and a different reach:

| path | what it is | when it is in context |
|---|---|---|
| `system.md` | the system prompt: role, the turn protocol, what the REPL holds, the standing rules | ALWAYS ON -- every token is in every turn, competing with the agent's own output budget |
| `guidance.md` | working practice and durable facts, appended to the system prompt | ALWAYS ON -- same cost |
| `profile.toml` | the run's limits | never in context: it shapes the run |
| `skills/<name>/SKILL.md` | a reusable workflow | loaded ON DEMAND, only when the agent calls `skill("<name>")` in the REPL |
| `scripts/<name>.py` | a deterministic helper, standard library only | imported ON DEMAND in the REPL with `import <name>` |

The two that are easy to get wrong:

`skills/` -- the file starts with front matter: a `---` line, `name: <name>` matching the folder,
`description: <one line>`, and a closing `---` line; then the text. Without it the profile does
not load. The rules below decide whether it survives validation at all: it must be named in
`guidance.md`, and any script it imports must ship with it.

`scripts/` -- a Python module the agent imports in its REPL, run inside the same sandboxed worker
as the agent's own code. Standard library only; it must compile; its name is a lowercase Python
identifier that is neither a standard-library module nor a REPL name (`llm`, `scan`, `submit`,
`context` and the rest). Make it deterministic, with clear inputs, outputs and failure behavior.

Change only what a trajectory shows needs changing -- but WHERE you change something, the FORM
matters as much as the content, and the cheap form is not the obvious one.

ALWAYS-ON PROSE IS THE EXPENSIVE OPTION. Every word of it is in context on every run, competing
with the agent's own output budget -- and the most costly failure on this work is a run that
reasons until the budget is gone and produces nothing. Adding prose makes that MORE likely, not
less. An on-demand component costs nothing until the moment it is invoked.

So prefer, in this order:
  - a SKILL for anything with a recognisable trigger -- a procedure for a kind of repository, a
    kind of question, a recurring situation. This is the default form for new instruction.
  - a SCRIPT for a deterministic operation the runs hand-rolled and got wrong, or did slowly.
  - a LIMIT in `profile.toml` when a trajectory shows the budget itself was the obstacle.
  - ALWAYS-ON TEXT last, and only for a short rule that genuinely applies to every run. If you
    add always-on text, cut something else to pay for it.

## The tunable keys of profile.toml

Only these keys may change, each within its bounds:

| key | bounds |
|---|---|
| `read.max_turns` | 10 to 200 |
| `repo.max_turns` | 10 to 200 |
| `read.max_subcalls` | 10 to 200 |
| `repo.max_subcalls` | 10 to 200 |
| `read.submit_check` | 0.0 to 1.0 |
| `repo.subcall_thinking` | `off`, `low`, `medium`, `high` |
| `repo.pace_nudge` | `true`, `false` |
| `root.temperature` | 0.0 to 1.0 |
| `sub.temperature` | 0.0 to 1.0 |
| `rlm.max_runs` | 0 to 24 |
| `rlm.max_turns` | 5 to 60 |
| `rlm.max_parallel` | 1 to 8 |
| `compaction.window` | 65536 to 1048576 |
| `compaction.keep_ratio` | 0.08 to 0.32 |

Frozen: `contract`, `cache_api`, `agent_api`, every `*_max_tokens`, `output_max_chars`, `cell_timeout_s`, `subcall_max_chars`, `subcall_oversize`, `rlm.max_depth`, `compaction.reserve`, `compaction.summary_max_tokens`. A candidate that changes a frozen key is thrown away.

## Bounds on the files

| file | bound |
|---|---|
| `system.md` | at most 16000 characters |
| `guidance.md` | at most 12000 characters |
| skills | at most 16 |
| each `SKILL.md` | at most 8000 characters |
| scripts | at most 16 |
| each script | at most 16000 characters |

Every file is UTF-8 with LF line ends, and the folder holds nothing else. A skill name matches
`[a-z0-9][a-z0-9-]{0,47}`. `{shell}` in `system.md` and `guidance.md` is replaced with the
machine's shell; no other placeholder exists. A harness without `system.md` runs prompt v4,
training's frozen system prompt: it never gains one.

`system.md` is the most expensive file here and the easiest to break: every run reads all of it,
and it names the REPL's helpers. Change it only for a rule that genuinely applies to every task,
or to correct what it says about the REPL; keep every helper name exactly as the REPL has it.

THREE RULES THAT DISCARD THE WHOLE PROPOSAL. Validation runs before any rollout, and a harness
that fails it is thrown away entire.

1. EVERY SKILL NEEDS A TRIGGER LINE -- the most violated rule here by a wide margin. If you
   create or keep `skills/<name>/SKILL.md`, its name must appear VERBATIM in `guidance.md` or
   `system.md`, in the SAME edit:

       When <the situation this skill handles>, call skill("<name>").

   An unnamed skill is never opened anyway: the line is what makes it exist.

2. EVERY SCRIPT YOU NAME MUST EXIST. A `scripts/<name>.py` named in a SKILL.md or in
   `guidance.md` or `system.md` must ship in the same proposal, at `scripts/<name>.py`; scripts live in that
   one folder, never inside a skill's.

3. EVERY SCRIPT IMPORTS ONLY THE STANDARD LIBRARY AND COMPILES. A script that imports anything
   else, or doesn't compile, is refused.

THE DELIVERABLE'S SHAPE BELONGS TO THE REQUEST, NOT TO YOU. A harness changes HOW the agent
works; it must never change WHAT SHAPE it delivers. Where the task names an answer format, a
file, a function signature or an order, that shape is part of what was asked for. A component
that tells the agent to add explanation to an answer, restate a derivation inside it, or change
a requested interface is CHANGING THE DELIVERABLE -- and the reader keys on exact names and
positions. Guidance that makes the agent's reasoning visible belongs in its REPL output, never
in the deliverable. A value the task asks for must be delivered AS A VALUE.
