"""KV cache: only adds a line at the end of one turn's observation; it never edits an earlier message.

The submit check (D-251), a reading task's `[read] submit_check` share. In the step 5 baseline, read runs submitted
after 4 to 12 of their 50 turns, having printed under 7% of `context` and sent none of it to sub-calls in 9 of 12.
So the first `submit()` of a prompt whose answer rests on less than that share of `context` (what the REPL printed
plus what sub-calls were sent, over the whole run) is held once: the turn goes on as if the cell had not submitted,
and its observation ends with `HELD`, which names scan(). The next submit() ends the prompt whatever its share, and
a prompt that runs out of turns after a hold ends with the held answer, so a hold never loses an answer.
The text belongs to the profile layer, not prompt v4: no hash covers it, and training-v4 never sends it.
"""

from __future__ import annotations

import math

MIN_CONTEXT_CHARS = 20_000  # a context this short is read in a few prints: no check
HELD = ("The harness held this submit() once: your answer rests on about {share}% of `context` ({seen:,} characters "
        "printed and {sent:,} sent to sub-calls, of {total:,}). Check it against the rest before you answer: "
        "scan(\"<the question as asked>\") asks a sub-call about every segment at once (about {parts} sub-calls) and "
        "returns the passages that bear on it, with their offsets. If the answer takes several steps, check each step "
        "against a passage, not memory. Then submit() again; the next submit() is final.")


def should_hold(threshold: float, *, total: int, seen: int, sent: int, turns_left: int, subcalls_left: int,
                segment_chars: int) -> bool:
    """Whether a reading prompt's first submit() is held: the check is on, `context` is long, there are turns left to
    scan and submit again, sub-calls enough for a scan, and the answer rests on less than `threshold` of `context`."""
    if not threshold or total <= MIN_CONTEXT_CHARS or turns_left < 2:
        return False
    if subcalls_left < _parts(total, segment_chars):
        return False
    return share(total=total, seen=seen, sent=sent) < threshold


def share(*, total: int, seen: int, sent: int) -> float:
    """How much of `context` the answer can rest on: characters printed plus characters sent to sub-calls, at most 1."""
    return 1.0 if total <= 0 else min(1.0, (seen + sent) / total)


def note(*, total: int, seen: int, sent: int, segment_chars: int) -> str:
    pct = 100 * share(total=total, seen=seen, sent=sent)
    return HELD.format(share=f"{pct:.1f}" if pct < 10 else f"{pct:.0f}", seen=seen, sent=sent, total=total,
                       parts=_parts(total, segment_chars))


def _parts(total: int, segment_chars: int) -> int:
    return max(1, math.ceil(total / max(1, segment_chars)))
