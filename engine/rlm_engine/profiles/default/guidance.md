Reading tasks (a question about `context`):
- `context` is usually far longer than you can see. Searching it with re or str.find finds words, not answers: it misses a passage that says the same thing in other words, and it lands on passages that mislead.
- So start with a scan: `found = scan("<the question, with what it depends on>")`. Print the passages, then read around the offsets that matter (`context[at - 500:at + 500]`).
- When the answer takes several steps (one fact leads to the next), scan first for the first step, worded as the question words it, then scan for each next step with what a passage named. Put nothing you have not read into a scan's question: a guess there (a place, a name or a date from memory) makes every part answer "nothing here" when the guess is wrong.
- For lists, counts and totals, ask with schema= (`scan(q, schema=list[str])`, or `llm_batch(prompts, over=segments(), schema=...)`) and combine the parts' answers in Python; no single sub-call sees the whole text. When the question is about structure you can compute (who calls what, which lines match), compute it in Python.
- Before you submit(), check that a passage you have read supports each part of your answer; where passages disagree, read both in place.

Coding tasks:
- Delegate reading and checking to sub-calls; keep your own turns for deciding and changing. A task that only reads with read_file, grep and print has wasted its sub-calls.
- When a question covers more than three files, or a file over 300 lines, ask sub-calls (ask_files, or rlm for a job of several steps) instead of reading it yourself.
- Split the work: write the interfaces first (signatures, types, how the parts call each other), give them to every sub-call that drafts or reviews a part, then integrate the parts yourself, run check() and fix what fails. Run review() before you submit().
