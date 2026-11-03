"""KV cache: only appends messages after the last one; it never edits an earlier message.

Follow-ups (v1 step 4, architecture §5). In a conversation, `run.say` starts the next prompt on the same REPL and the
same message list. The previous prompt is closed with a note first (D-201): `SUBMITTED_NOTE` when it submitted, else
`UNANSWERED_NOTE`, as the tool result of a native tool call (every call needs exactly one result, D-04), otherwise at
the start of the user message. Then `FOLLOW_UP` carries the user's text, the mode's `WHERE` phrase and the new
prompt's budgets. These texts belong to the profile layer, not prompt v4: no hash covers them, and a one-shot run
never sends them.
"""

from __future__ import annotations

SUBMITTED_NOTE = "Your answer was submitted, and the user has seen it."
UNANSWERED_NOTE = "That question ended without a submitted answer."
FOLLOW_UP = (
    "Follow-up from the user. The REPL still holds every variable from before{where}.\n\n"
    "{text}\n\n"
    "({turns_left} turns left, {subcalls_left} sub-calls left) Answer this with submit(), as before."
)
WHERE = {"read": ", and `context` is unchanged", "repo": ", and the repository keeps your edits"}


def follow_up_messages(last: dict, *, submitted: bool, text: str, mode: str, turns_left: int,
                       subcalls_left: int) -> list[dict]:
    """The messages that start a follow-up prompt after `last`, the conversation's last message."""
    note = SUBMITTED_NOTE if submitted else UNANSWERED_NOTE
    follow = FOLLOW_UP.format(where=WHERE[mode], text=text, turns_left=turns_left, subcalls_left=subcalls_left)
    call = last.get("tool_call") if last.get("role") == "assistant" else None
    if call:
        return [{"role": "tool", "tool_call_id": call["id"], "content": note}, {"role": "user", "content": follow}]
    return [{"role": "user", "content": note + "\n\n" + follow}]
