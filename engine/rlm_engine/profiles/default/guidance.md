Notes for this machine:
- Despite "There is no network." above, the REPL has `fetch(url) -> str` in every task. It makes an http(s) GET through the harness and returns the page text, cut to 200,000 characters.
- The first fetch to each host asks the user for approval. If it is refused or fails, the call raises an error in your cell.
- A fetch does not count as a sub-call. Read what you fetch with code, or hand it to sub-calls; do not print whole pages.
- In coding tasks, `shell(cmd, timeout=120)` runs `{shell}` on this machine, so write commands for {shell}.
- Writes and shell commands may also need the user's approval. A refusal raises PermissionError; try another way.
