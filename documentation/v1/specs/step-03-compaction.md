# Step 3. Compaction inside a run

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | none (v0 is done) |
| **Unblocks** | 4, 5 (the baseline runs with compaction on) |
| **Parallel with** | 1, 2 |
| **Decisions it uses** | S-42 (follow-ups and compaction in v1), S-14 (prompt v4 frozen), S-21 (cache notes); D-25 (the gateway's window check), D-121, D-160, D-163 (child turns), D-171 (DeepSeek Harness's rules on W' = min(W, the profile's window)), D-177 (protocol 2, record format 2), D-200 (a failed summary call) |

## Goal

A long run no longer dies when its conversation outgrows the window, and it no longer drags 150 turns of history into every request. Before each root call, and before each `rlm()` child turn, the loop estimates the next request. When the estimate passes the trigger, the loop replaces the middle of the conversation with a summary the model writes itself. The system prompt, the first message and the newest turns are kept verbatim. The REPL keeps every variable, so nothing the model computed is lost.

Only profiles with a `[compaction]` table compact. `default` gets one; `training-v4` never does, so parity holds. This step also moves the wire to protocol 2 and the run log to format 2, because step 4 builds on both.

## Read first

- [../architecture.md](../architecture.md) §3 (all of it), §4 (all of it; §4.1 and §4.2 are this step), §12. [../../v0/architecture.md](../../v0/architecture.md) §3 (error codes), §5.2 to §5.4, §7.2 (AppPort), §7.6 (profiles), §7.8 (RunSpec, record, Session), §11, §12.
- [../../v0/decisions.md](../../v0/decisions.md): S-14, S-21, S-42, D-25, D-121, D-160, D-163, D-171, D-177.
- DeepSeek Harness's compaction, for the rule we copy: the trigger min(0.8W, W − output − 65,536), the newest 16% of (W − output) kept, and the summarizer replaying the prefix byte for byte ([../../legacy/architecture.md](../../legacy/architecture.md) line 188, and line 193 for Claude Code's "fork with the same prefix plus an instruction at the end").
- Engine code, whole files:
  - `engine/rlm_engine/loop.py`: you change it; read every line, because its cache note changes too.
  - `engine/rlm_engine/child.py`: `_play` and `_turns`, the second turn loop.
  - `engine/rlm_engine/profiles.py`: `_TOP_KEYS` (line 26), `_load`, `_table`, `_rlm` (the model for a new table) and `Profile`.
  - `engine/rlm_engine/profiles/default/profile.toml`, `profiles/training-v4/profile.toml`.
  - `engine/rlm_engine/service.py`: `_run_start` and `_run_spec` (validation order).
  - `engine/rlm_engine/runlog.py`: `FORMAT_VERSION`, `RECORD_KEYS`.
  - `engine/rlm_engine/contract.py`: `Limits`, `OBS_*`.
  - `engine/rlm_engine/callformat.py`: `assistant_message`, `observation_message`, `tools_for`.
  - `engine/rlm_engine/appport.py`, `engine/rlm_engine/errors.py`, `engine/rlm_engine/__init__.py`.
- Engine tests: `engine/tests/fakeapp.py` (the script format), `engine/tests/test_loop.py` (`EVENT_KEYS`, `test_event_shapes_and_order`), `engine/tests/test_runlog.py` (`RECORD_KEYS`), `engine/tests/test_profiles.py`, `engine/tests/test_protocol.py` (reads `protocol/examples.json`).
- App code, whole files:
  - `app/src/version.ts`, `app/src/protocol.ts` (`RunStartParams`, `ModelCompleteParams`, `RunStartedParams`, event types).
  - `app/src/session.ts` (`buildRunParams`, `Session.open`).
  - `app/src/gateway/gateway.ts` (`windowCheck` at about line 595, `complete`), `app/src/gateway/anthropic.ts` (message conversion; lines 68 to 80 merge neighbouring same-role messages), `app/src/gateway/openai.ts`, `app/src/gateway/catalog.ts` (`ModelInfo`, `Catalog.get`), `app/src/gateway/fake.ts` (the `RLMH_FAKE_SCRIPT` format).
  - `app/src/cli/print.ts` (`attachPlain`).
  - `app/src/interface/store.ts` (the event switch, `Entry`, `viewFromRecord`), `app/src/interface/runs.ts`, `app/src/interface/commands/runs.tsx`.
- `protocol/examples.json`, which both suites check (D-02).

## Starting state

- v0 is done at `9f0cedd` or later. `uv run --project engine pytest engine/tests -q` and `bun test` in `app/` pass. `PROTOCOL_VERSION = 1`, `FORMAT_VERSION = 1`.
- `loop.run` and `child.Children._turns` append to their message lists and never shorten them. The engine has no idea of the model's window. Only the gateway knows it, from the catalog, and uses it to refuse an oversized request (`windowCheck`, D-25).

## Deliverables

**Engine.**

- `engine/rlm_engine/compaction.py`. *KV cache: rewrites the message list only at a compaction. The head (system prompt and first message) stays byte for byte, and everything after it changes once, so the provider's cache rebuilds from the head. The summary call itself replays the whole current list, a cache hit.* Standard library only.
  - `@dataclass(frozen=True) class Plan: window: int; trigger: int; keep: int`, plus `as_event() -> dict` giving `{window, trigger, keep}`.
  - `plan(settings: CompactionSettings, window: dict, out: int) -> Plan`: §4.1 exactly. `W' = min(window["context_window"] or ∞, settings.window)`, `trigger = max(min(int(0.8 * W'), W' - out - settings.reserve), W' // 2)`, `keep = int(settings.keep_ratio * (W' - out))`.
  - `estimate(messages, last_usage: dict | None, chars_since: int) -> int`: `last_usage["input_tokens"] + last_usage["output_tokens"] + ceil(chars_since / 3)`, or `ceil(total_chars(messages) / 3)` when `last_usage` is `None` or its input is 0. `total_chars` counts every `content` string and every tool call's `arguments` JSON.
  - `@dataclass class Compacted: messages: list[dict]; dropped: int; kept: int; turns: int; summary: str`.
  - `async def compact(messages, *, keep_tokens: int, summarize) -> Compacted | None`: §4.2 steps 1 to 5. `summarize(request_messages) -> str` is a coroutine supplied by the caller. A turn is an assistant message plus the one `user` or `tool` message after it. `turns` counts the assistant messages dropped.
  - `fallback_summary(dropped: list[dict]) -> str`: one line per dropped assistant message, `Turn {n}: {first non-empty line of its code, or of its text, cut to 200 characters}`, where `n` counts from 1 over the dropped turns.
  - The two texts, pinned here and tested byte for byte:

```python
COMPACT_REQUEST = (
    "Stop work on the task for this one reply. The conversation is about to be shortened: every turn after the "
    "first message will be replaced by a summary you write now, and only the newest turns will stay as they are. "
    "The REPL keeps running, so every variable you have made stays as it is.\n\n"
    "Write the summary as plain text. Do not write code and do not call a tool. Include:\n"
    "- what the task is, and what is already done;\n"
    "- what you found, with the exact numbers, names and file paths that matter;\n"
    "- every REPL variable that holds state you still need, and what it holds;\n"
    "- what you were about to do next.\n\n"
    "Keep it under {max_words:,} words."
)
COMPACTED = (
    "[{turns} earlier turns were compacted to save context. Your summary of them follows.]\n\n"
    "{summary}\n\n"
    "[The newest turns follow as they were. The REPL still holds every variable.]"
)
```

    `max_words = summary_max_tokens // 5`. Both texts belong to the profile layer, not prompt v4: no hash covers them, and `training-v4` never sends them.
- `engine/rlm_engine/profiles.py`:
  - `@dataclass(frozen=True) class CompactionSettings: window: int; keep_ratio: float; reserve: int; summary_max_tokens: int`, and `Profile.compaction: CompactionSettings | None = None`.
  - `"compaction"` goes into `_TOP_KEYS`. `_compaction(name, data)` reads the table: all four keys are required, and an unknown key is a `ProfileError`.
  - Checks: `window` an integer from 4,096 to 4,194,304; `keep_ratio` a float above 0 and at most 0.5; `reserve` an integer of at least 0; `summary_max_tokens` an integer from 256 to 32,768. In both modes, `root_max_tokens` must be below `window`. Any failure is a `ProfileError` (-32011).
- `engine/rlm_engine/profiles/default/profile.toml` gains §4.1's table verbatim (`window = 262144`, `keep_ratio = 0.16`, `reserve = 65536`, `summary_max_tokens = 8192`). `training-v4/profile.toml` does not change by one byte.
- `engine/rlm_engine/loop.py`:
  - `RunSpec` gains `window: dict = field(default_factory=lambda: {"context_window": 0, "max_output": 0})`.
  - The compaction check runs at the top of each turn (task 3).
  - `run.started` gains `window` and `compaction`.
  - The record gains the four keys.
  - The cache note is rewritten: "appends to one message list and edits it only at a compaction (compaction.py), which keeps the system prompt and first message byte for byte; the tool list is fixed for the run."
- `engine/rlm_engine/child.py`: `_turns` gets the same check, with `role: "sub"`, the child's `child` field, `purpose: "compact"`, and its `run.compacted` carrying `child_id`.
- `engine/rlm_engine/runlog.py`: `FORMAT_VERSION = 2`. `RECORD_KEYS` appends `window`, `compactions`, `prompt_index`, `conversation`, in that order.
- `engine/rlm_engine/__init__.py`: `PROTOCOL_VERSION = 2`.
- `engine/rlm_engine/service.py`: `_run_spec` reads `window` as optional. When present, it must be an object with exactly `context_window` and `max_output`, both non-negative integers; otherwise -32602, checked with the other types. When absent, it is zeros.
- `engine/tests/fakeapp.py`: the script gains an optional `"compact": [{"text": ...}, ...]`. A `complete` call with `purpose == "compact"` takes the next entry. When the list is missing or used up, it answers `{"text": "summary"}` with usage ⌈chars/4⌉. Such calls never take a root entry. They are recorded in `requests` like every other call.

**App.**

- `app/src/version.ts`: `PROTOCOL_VERSION = 2`.
- `app/src/protocol.ts`:
  - `RunStartParams.window?: { context_window: number; max_output: number }`
  - `ModelCompleteParams.purpose?: "compact"`
  - `RunStartedParams.window` and `.compaction: { window: number; trigger: number; keep: number } | null`
  - `RunCompactedParams` (§3.3), added to the event union
- `app/src/session.ts`: `buildRunParams`'s deps gain `windowOf?: (ref: ModelRef) => { context_window: number; max_output: number }`. `p.window = deps.windowOf?.(root) ?? {context_window: 0, max_output: 0}`. `Session.start` passes `(ref) => { const m = this.catalog.get(ref.provider, ref.model); return { context_window: m?.context_window ?? 0, max_output: m?.max_output ?? 0 }; }`.
- `app/src/gateway/gateway.ts`: `purpose` passes through untouched, as described in §3.2: the same routing key, cache markers and accounting as the role it carries. `call.start` carries `purpose`, so the interface can label the call.
- `app/src/gateway/fake.ts`: the same optional `compact` list as `FakeApp`, with the same default.
- `app/src/cli/print.ts`: `attachPlain` prints `turn N: compacted <dropped> messages, ~<before>k to ~<after>k tokens, <seconds> s` (with `child <id> ` before `turn` inside a child). `attachJson` needs nothing, because it prints every event.
- `app/src/interface/store.ts`:
  - `run.compacted` adds a `note` entry, `Compacted <dropped_messages> messages to save context: ~<before>k to ~<after>k tokens.`, with tone `info`.
  - A root `call.start` with `purpose: "compact"` shows the live tail as "compacting…" instead of a reply.
  - `viewFromRecord` adds the same note for each item in a record's `compactions`, before the turn it preceded.
- `app/src/interface/runs.ts`, `commands/runs.tsx`: the store reads format 1 and format 2 (`READABLE_FORMATS = [1, 2]`), and the "written by another format version" message is kept for any other number. A format 1 record gets `window: null, compactions: [], prompt_index: 0, conversation: false`.
- `protocol/examples.json`: `"protocol": 2`, with examples added for `run.start` with `window`, a `model.complete` with `purpose`, `run.started` with `window` and `compaction`, and `run.compacted`.

## Tasks

1. [ ] **Profiles first.** Write `CompactionSettings` and `_compaction`, add the table to `default`, and write the profile tests. `training-v4`'s bytes and `prompt_hash` must not move. `default`'s `prompt_hash` doesn't move either, because the table isn't in the prompt; its `profile_hash` does move, so update any test that pins it.
2. [ ] **`compaction.py`**, with its unit tests (below), and no model involved: `summarize` is a stub.
3. [ ] **The loop.** In `loop.run`, after `limits` are known:
   - `plan = compaction.plan(profile.compaction, spec.window, limits.root_max_tokens) if profile.compaction else None`.
   - Keep `last_usage` (the latest reply's usage) and `chars_since`. `chars_since` is reset when a reply arrives, and grows by the `content` length of each observation message the loop appends.
   - At the top of every turn after the first, when `plan` and `compaction.estimate(...) > plan.trigger`, call `compaction.compact(messages, keep_tokens=plan.keep, summarize=...)`.
   - `summarize` sends `app.complete({run_id, role: "root", purpose: "compact", model: spec.root, messages: request, tools: callformat.tools_for(spec.call_format), max_tokens: profile.compaction.summary_max_tokens, temperature: profile.root_temperature, thinking: "off", turn})`, where `request` is the messages plus one user message with `COMPACT_REQUEST`.
   - Its usage is added to `root_usage`, and it is not a turn.
   - A `ModelError` of kind `bad_request` or `context_window` gives `fallback_summary` instead. Any other `ModelError` stops the run, as a root call's does.
   - When `compact` returns a result, replace `messages` in place (`messages[:] = result.messages`), set `last_usage = None` and `chars_since = 0`, append the `run.compacted` body (without `run_id`) to the record's `compactions`, and emit the event. `before_tokens` is the estimate that triggered the compaction, and `after_tokens` is `compaction.estimate(new, None, 0)`.
   - After a compaction whose `after_tokens` is above 80% of its `before_tokens`, no more compactions in this prompt (§4.2 step 6).
4. [ ] **Children.** The same in `child.Children._turns`, with the child's limits and the run's `spec.window`, carried on `Children` as a new `window` argument. A child's summary call is role `sub` with `subcall_id`, `origin`, `batch` and `child` as its turns send them, plus `purpose`. Its usage goes to `child.usage`, so it lands in `usage.sub` through `finish_child`.
5. [ ] **`run.started` and the record.**
   - `run.started` gains `window` (as received) and `compaction` (`plan.as_event()` or `None`).
   - The record gains `window`, `compactions`, `prompt_index: 0` and `conversation: False`; `_record` writes them in `RECORD_KEYS` order.
   - `_finished_event` is unchanged in this step.
6. [ ] **Protocol 2 on both sides.** Bump both versions and `examples.json`. Make sure the app still refuses a mismatch (D-36): the existing test now expects 2.
7. [ ] **Two user messages in a row.** After a compaction, the summary message follows the first user message. Check both clients:
   - `anthropic.ts` already merges neighbouring same-role messages into one message's blocks (lines 69 to 71). Add a test that two user messages become one user message with two text blocks, in order, and that cache markers still land on whole blocks.
   - `openai.ts` sends them as two messages. Add a test that it does.
   - If either test fails, fix that client. Never reorder or rewrite text.
8. [ ] **The app side**: `buildRunParams`, `fake.ts`, `print.ts`, the store and `/runs`, as listed above.
9. [ ] Run the full gate (`bash scripts/verify.sh`, or `verify.ps1` on the PC) and fix what fails. Update progress.md (see Hand-off).

## Tests

All offline. Engine tests use `FakeApp(script=…)` and a temp home. The compaction profile for tests is a user profile in the temp home: a copy of `default/profile.toml` with `[read] root_max_tokens = 256`, `max_turns = 12` and `[compaction] window = 4096, keep_ratio = 0.16, reserve = 0, summary_max_tokens = 512`. That gives W' = 4,096, trigger = min(3,276, 3,840) = 3,276, keep = 614.

**`engine/tests/test_compaction.py`**
- `test_plan_numbers`: DeepSeek's catalog numbers (W = 1,048,576) and `default`'s table give W' 262,144, trigger 180,224, keep 39,321. W = 0 gives the same numbers. W = 128,000 with `reserve` 65,536 and out 16,384 gives trigger 64,000, which is `W' // 2`, since 128,000 − 16,384 − 65,536 = 46,080 is smaller.
- `test_estimate`: uses usage plus `ceil(chars / 3)`. With `None`, or input 0, it counts the whole list, tool call arguments included.
- `test_head_and_tail`: the head is `messages[:2]`, identical objects with identical text. The tail starts with an assistant message and fits in `keep_tokens`, except when the newest turn alone is larger, in which case it is exactly that turn. A native assistant message with a tool call is never split from its tool message.
- `test_texts_pinned`: `COMPACT_REQUEST.format(max_words=1638)` and `COMPACTED.format(turns=3, summary="S")` equal the literals in this spec.
- `test_nothing_to_drop`: a list of head plus one turn gives `None`, and `summarize` is never called.
- `test_fallback_summary`: three dropped turns give three `Turn n:` lines, cut at 200 characters.

**`engine/tests/test_loop.py`** (add)
- `test_compacts_when_over`: the test profile, and a script whose cells print 3,000 characters a turn.
  - Exactly one `run.compacted` arrives before the root call it preceded.
  - The next root request's `messages[:2]` equal the first request's byte for byte, `messages[2]` is a `user` message starting `[`, followed by `COMPACTED`'s text with the scripted summary, and the rest is the kept tail.
  - The compaction request in `FakeApp.requests` has `purpose == "compact"` and ends with `COMPACT_REQUEST`.
  - The record's `compactions` has one item with the event's fields, and `usage.root` includes the summary's usage.
- `test_compact_fallback`: the compact entry raises `ModelError` `context_window`. The summary is `fallback_summary`'s text, and the run goes on.
- `test_compact_server_error_stops`: the compact entry raises `server`, so `infra_kind == "server"`.
- `test_no_loop`: a tail too large to shrink gives one compaction, then none.
- `test_training_v4_never_compacts`: the same script under `training-v4` gives no `run.compacted`, `run.started.compaction is None`, and every request equals what v0's loop sent (compare against the requests recorded before this step's change, kept as a fixture).
- `test_event_shapes_and_order`: update `EVENT_KEYS` for `run.started` and add `run.compacted`.

**`engine/tests/test_agentapi.py`** (where `rlm()` children are tested today): a child with the test profile compacts. Its `run.compacted` has `child_id`, the summary request is role `sub` with `child` and `purpose`, and the child's usage includes it.

**`engine/tests/test_profiles.py`**: the table is parsed; a missing key, an unknown key, `keep_ratio = 0`, `window = 1000` and `root_max_tokens >= window` are each a `ProfileError`; `training-v4` has `compaction is None`; and `default`'s `prompt_hash` is unchanged.

**`engine/tests/test_runlog.py`**: `RECORD_KEYS` ends with the four new keys; `FORMAT_VERSION == 2`.

**`engine/tests/test_service.py`**: `window` of the wrong shape gives -32602; a missing `window` gives zeros; `run.started.window` echoes what was sent.

**App** (`bun test`):
- `test/session.test.ts`: `buildRunParams` fills `window` from `windowOf`, gives zeros without it, and gives zeros for a model the catalog doesn't know.
- `test/gateway/anthropic.test.ts` and `openai.test.ts`: task 7's two-user-messages cases. A `purpose: "compact"` call routes and caches like a root call (same `session_id` and markers as the run's root calls).
- `test/cli/print.test.ts` (or `run.test.ts`): the plain line for `run.compacted`.
- `test/interface/compaction.test.ts`: `createFakeApp` with a compacting run shows the "Compacted …" note. `/runs` on a format 1 line and on a format 2 line with `compactions` lists both and opens both.
- The `protocol/examples.json` tests pass with protocol 2.

## Done when

- The full gate prints `VERIFY: PASS`, and CI is green on macOS, Windows and Linux.
- **The hand check, on the fake provider** (in `app/`). Write a test profile as in Tests into `<tmp>/profiles/compact-test/`, then run `RLMH_HOME=<tmp> RLMH_FAKE_SCRIPT=<a script whose cells print 3,000 characters for 10 turns, then submit> bun run src/main.ts run --question Q --input <file> --root fake/scripted --profile compact-test`. Stderr shows a `compacted` line, the run exits 0, and the last line of `<tmp>/runs/cli/runs.jsonl` has `format 2` and one item in `compactions`.
- **Parity, on Rishi's PC**, because `loop.py` changed (CLAUDE.md). From the RLM repo, run `.venv\Scripts\python.exe scripts\harness_parity.py --harness F:\Personal\RLM\rlm-harness` and get the same verdict as the 2026-11-01 run (D-150): the read episodes match byte for byte, and no new difference class appears.
- `engine.info` lists `default` with an unchanged `prompt_hash`, and `training-v4` with an unchanged `prompt_hash` and `profile_hash`.

## Out of scope

- Follow-ups, `run.say`, `run.close` and `conversation` (step 4). This step only writes `prompt_index: 0` and `conversation: false`.
- Tuning `compaction.window` or `keep_ratio` (step 6 may; architecture §7.2 bounds them).
- Showing a context ring with the trigger line in `/context`. That would be nice, but nothing needs it yet.
- Compaction for `training-v4`, ever.

## Hand-off

- **Step 4 relies on:** `compaction.plan`, `estimate` and `compact`; the loop's `last_usage` and `chars_since` bookkeeping; `PROTOCOL_VERSION = 2`; and record format 2 with `prompt_index` and `conversation` already in place.
- **Step 5 relies on:** `default` compacting at 180,224 tokens, and `compactions` in each record, which `rlmh eval` counts (architecture §6.5).
- **progress.md:** set row 3 to `review`, with the date, the parity verdict on the PC (or "parity not yet run on the PC"), and the plan numbers seen in a real `run.started` for DeepSeek, if any were run.

## If a decision goes the other way

- **D-171, no profile window cap** (pure DeepSeek Harness on the model's W): `default`'s table drops `window`, and `plan` uses W alone. On both v1 models a coding run then never compacts below about 838,000 tokens, so step 5's numbers would show no compactions.
- **Compaction also for `training-v4`:** nothing here changes the loop. The profile file would gain the table, which changes its `profile_hash` and breaks D-150's parity rule for long runs. Not recommended.
- **A different summarizer model** (for example the sub model, to save money): `summarize` uses `spec.sub` and role `sub`. The prefix would then miss the root's cache, so the call costs more, not less, on DeepSeek.
