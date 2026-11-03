"""KV cache: none

followup.py (v1 step 4): the pinned texts byte for byte, and the messages that open a follow-up after a native tool
call (a tool result, then a user message) and otherwise (one user message that starts with the note).
"""

from __future__ import annotations

import hashlib

from rlm_engine import followup
from rlm_engine.followup import FOLLOW_UP, SUBMITTED_NOTE, UNANSWERED_NOTE, WHERE, follow_up_messages


def test_texts_pinned() -> None:
    assert SUBMITTED_NOTE == "Your answer was submitted, and the user has seen it."
    assert UNANSWERED_NOTE == "That question ended without a submitted answer."
    assert FOLLOW_UP == (
        "Follow-up from the user. The REPL still holds every variable from before{where}.\n\n"
        "{text}\n\n"
        "({turns_left} turns left, {subcalls_left} sub-calls left) Answer this with submit(), as before."
    )
    assert WHERE == {"read": ", and `context` is unchanged", "repo": ", and the repository keeps your edits"}
    joined = "\0".join([SUBMITTED_NOTE, UNANSWERED_NOTE, FOLLOW_UP, WHERE["read"], WHERE["repo"]])
    assert hashlib.sha256(joined.encode("utf-8")).hexdigest() == (
        "9604227ff15e3c717f2428821e7fb0e4ab7292cc2e723dc1a92341dc410f3a27")


def test_native_tool_result_then_user() -> None:
    last = {"role": "assistant", "content": "",
            "tool_call": {"id": "call_7", "name": "python", "arguments": {"code": "submit('1')"}}}
    got = follow_up_messages(last, submitted=True, text="Q2", mode="read", turns_left=6, subcalls_left=5)
    assert got == [
        {"role": "tool", "tool_call_id": "call_7", "content": SUBMITTED_NOTE},
        {"role": "user", "content": "Follow-up from the user. The REPL still holds every variable from before, and "
                                    "`context` is unchanged.\n\nQ2\n\n(6 turns left, 5 sub-calls left) Answer this "
                                    "with submit(), as before."},
    ]
    got = follow_up_messages(last, submitted=False, text="Q2", mode="read", turns_left=6, subcalls_left=5)
    assert got[0] == {"role": "tool", "tool_call_id": "call_7", "content": UNANSWERED_NOTE}


def test_fenced_one_user_message() -> None:
    last = {"role": "assistant", "content": "Done.\n```python\nsubmit('1')\n```"}
    (got,) = follow_up_messages(last, submitted=True, text="and how long?", mode="repo", turns_left=150,
                                subcalls_left=80)
    assert got["role"] == "user"
    assert got["content"] == (SUBMITTED_NOTE + "\n\n" + "Follow-up from the user. The REPL still holds every variable "
                              "from before, and the repository keeps your edits.\n\nand how long?\n\n(150 turns left, "
                              "80 sub-calls left) Answer this with submit(), as before.")
    (got,) = follow_up_messages(last, submitted=False, text="x", mode="read", turns_left=1, subcalls_left=0)
    assert got["content"].startswith(UNANSWERED_NOTE + "\n\nFollow-up from the user.")


def test_where_by_mode() -> None:
    last = {"role": "assistant", "content": "no code"}  # a native reply without a tool call: one user message
    for mode, where in WHERE.items():
        (got,) = follow_up_messages(last, submitted=True, text="t", mode=mode, turns_left=1, subcalls_left=1)
        assert f"from before{where}.\n\n" in got["content"]
    assert followup.WHERE["read"] != followup.WHERE["repo"]
