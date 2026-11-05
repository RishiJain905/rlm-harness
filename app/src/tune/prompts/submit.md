<!--
Copyright 2026 Google LLC. Licensed under the Apache License, Version 2.0; see LICENSE-harness2 in this folder.
Source: google-research/harness2, harness2/core/prompts.py L179-L193 (_SURFACE_OPENCODE's "# HOW TO MAKE A CHANGE")
and L1150-L1160 (experience's OUTPUT FORMAT), commit 6868817518876de8fd170c6a8354daca273b6191.
Changed by rlm-harness: rlm-harness's own text. A session can't edit files in place, so it submits its edit as one
JSON object (D-210): `submit(json.dumps({...}))`, because submit() refuses a dict. The notes keep harness2's rule:
for each change, the trajectory moment that motivated it.
-->
<!-- part: editor -->
# HOW TO MAKE A CHANGE

Your edit is what you submit; nothing else you write changes the harness. Submit ONE JSON object
as a string, with `submit(json.dumps({...}))` -- submit() refuses a dict:

    {"decision": "EDIT" or "KEEP_BASE",
     "notes": ["<one line per change: what you changed, and the trajectory moment behind it>"],
     "guidance": "<the whole new guidance.md>" or null,
     "toml": {"<table>.<key>": <value>},
     "files": {"<path>": "<the whole new file>" or null}}

- `guidance` is null to keep the current text; otherwise it is the WHOLE new text, not a diff.
- `toml` holds only the keys you change, from the tunable table above{{toml_rule}}.
- `files` holds only the skills and scripts you add or change (their whole text) or remove (null),
  by path: `skills/<name>/SKILL.md` or `scripts/<name>.py`{{gated_paths}}. Files you leave out are
  inherited unchanged. Never resend a file to keep it the same: submit() refuses an answer over
  100,000 bytes.
- If the evidence does not argue for any change, submit `{"decision": "KEEP_BASE", "notes":
  ["<why>"], "guidance": null, "toml": {}, "files": {}}`. That is a real answer, not a failure.
- Before you submit, read back what you built: the guidance names every skill, every script you
  name ships, and every value is inside its bounds. An edit that breaks a rule is rejected.
<!-- part: composer -->
# HOW TO SUBMIT THE COMPOSED HARNESS

Submit ONE JSON object as a string, with `submit(json.dumps({...}))` -- submit() refuses a dict:

    {"decision": "MERGE" or "ADOPT" or "REVISE" or "KEEP_BASE",
     "adopt": "inv" or "dom" (only with ADOPT; otherwise null),
     "notes": ["kept|revised|dropped -> <which edit> -> <the evidence>", ...],
     "guidance": "<the whole new guidance.md>" or null,
     "toml": {"<table>.<key>": <value>},
     "files": {"<path>": "<the whole new file>" or null}}

- With ADOPT, the named candidate is taken as it is: give `guidance` null, and `toml` and
  `files` empty.
- With MERGE or REVISE, the edit is made against the CURRENT harness in `harness/`, not against
  a candidate: `guidance` is the whole new text or null, `toml` holds only the keys that change,
  and `files` only the skills and scripts that change (null removes one). Copy a candidate's file
  across whole when you keep it; never resend a file to keep it the same, since submit() refuses
  an answer over 100,000 bytes.
- With KEEP_BASE, give `adopt` null, `guidance` null, and `toml` and `files` empty.
<!-- part: reflector -->
# HOW TO SUBMIT THE RECORD

Submit ONE JSON object as a string, with `submit(json.dumps({...}))` -- submit() refuses a dict:

    {"domain": "read" or "repo",
     "edits": [{"component": "<name as it appears in the harness tree>",
                "candidates": "<the labels that carried this edit>",
                "change": "<what the edit did>",
                "observed": "<the execution difference, and where you saw it>",
                "verdict": "helped" or "hurt" or "no observed effect" or "confounded"}, ...],
     "entry": "NO_ENTRY" or {"cue": "<the shape of situation this applies to>",
                             "lesson": "<the transferable operation, naming the component>",
                             "evidence": "<the edit rows this rests on, and the execution contrast>",
                             "confidence": "high" or "medium" or "low"}}

`domain` is the kind of task the lesson is for: "read" for reading tasks, "repo" for coding
tasks. Write one row in `edits` for each component any candidate changed.
