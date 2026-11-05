<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L117-L124 and L138-L144 (_SURFACE_OPENCODE's
`sub_agents/` and `plugin/` paragraphs), commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: rlm-harness's own text for D-234's gated components, added only under `rlmh tune --gated`:
named subagents (`agents/`) used through `llm(..., agent=)` and `rlm(..., agent=)`, and declarative nudges
(`nudges.toml`) in place of code plugins; the table is `profiles.TUNABLE_GATED` (a test keeps them equal).
-->
# TWO MORE COMPONENTS, FOR THIS TUNE ONLY

| path | what it is | when it is in context |
|---|---|---|
| `agents/<name>/AGENT.md` | a named subagent: a system prompt | in its OWN context, only when the agent calls `llm(prompt, agent="<name>")` or `rlm(task, agent="<name>")` |
| `nudges.toml` | declarative rules that append a hint to the REPL output | never in context until a rule fires, at most once per rule per question |

`agents/` -- front matter `name` (matching the folder) and `description`, then the system
prompt. It sees only its own file and the call, never the main conversation, and it returns
text. So it is worth it for exactly one shape of problem: a bounded sub-task whose INPUT is large
and whose ANSWER is small. It is a bad trade when the output is as big as the input. Its name
must appear verbatim in `guidance.md`, as a skill's does.

`nudges.toml` -- data only, never code: `[[nudge]]` tables, each with `when` and `hint`:

    [[nudge]]
    when = "error"          # a cell's output or error contains `pattern`, a plain substring
    pattern = "<text>"
    hint = "<what to do instead>"

    [[nudge]]
    when = "no_submit"      # `turns` turns have passed with no submit()
    turns = 30
    hint = "<...>"

    [[nudge]]
    when = "long_output"    # a cell printed more than `chars` characters
    chars = 20000
    hint = "<...>"

It is the cheap way to carry knowledge that prose would repeat: a targeted hint after an error
signature that keeps recurring, or a reminder at the moment a run starts to drift. It cannot
block or change anything; it only adds a line to what the agent reads.

| what | bound |
|---|---|
| agents | at most 8 |
| each `AGENT.md` | at most 4000 characters |
| nudge rules | at most 8 |
| `pattern` | at most 200 characters |
| `turns` | 1 to 200 |
| `chars` | 1000 to 1000000 |
| `hint` | at most 400 characters |
