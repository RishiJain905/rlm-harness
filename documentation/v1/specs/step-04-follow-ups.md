# Step 4. Follow-ups: one conversation across questions

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 3 |
| **Unblocks** | 9 |
| **Parallel with** | 5, 6 |
| **Decisions it uses** | S-11 (one-shot runs, now only for scripts), S-42 (follow-ups in v1), S-31 and D-156 (how a question picks its mode), D-15, D-35, D-147 (`/clear`), D-159 (async calls), D-160 (children), D-177 (protocol 2, one record per prompt), D-178 (follow-ups only in the interactive app, and the same-mode rule), D-199 (per-prompt turns and budgets, conversation-wide ids), D-201 (closing the previous prompt), D-202 (what keeps a conversation open), D-203 (nothing cancelled between prompts) |

## Goal

In the interactive app, a second question goes to the same REPL, the same workspace and the same conversation. The model keeps its variables, its `context` or its edits, and what it said. A question that doesn't fit the open conversation (another mode, other files, another model) starts a fresh one, as do `/clear` and quitting. `rlmh run`, `rlmh batch`, `rlmh eval` and the tuner never open a conversation, so every script stays one-shot (S-11 holds there).

On the wire, a run started with `conversation: true` doesn't end at its answer. It writes that prompt's record, sends `run.finished {open: true}`, and waits for `run.say` (the next question) or `run.close`. Compaction from step 3 covers the whole conversation.

## Read first

- [../architecture.md](../architecture.md) §3 (all of it), §5 (all of it; this is the step), §8 (`conversation.follow_ups`). [../../v0/architecture.md](../../v0/architecture.md) §3, §5.1 to §5.4 (the order of one run; `run.say` keeps that order), §7.7 (worker, bridge), §7.8 (RunSpec, record, Session), §8, §11.
- [../../v0/decisions.md](../../v0/decisions.md): S-11, S-31, S-42, D-15, D-35, D-84 (the gate and the order on the wire), D-147, D-156, D-159, D-160, D-177, D-178.
- [step-03-compaction.md](step-03-compaction.md): the loop's `last_usage` and `chars_since` bookkeeping, and the record format 2 keys this step fills.
- Engine code, whole files:
  - `engine/rlm_engine/loop.py`: you restructure `run`, so read all of it.
  - `engine/rlm_engine/service.py`: `_Run`, `_Gate`, `_run_start`, `_run_cancel`, `_live_run`, `_cancel_all`.
  - `engine/rlm_engine/bridge.py`: `__init__`, `subcalls_left`, the budget checks in `_llm` (about line 126) and `reserve_child` (about line 208), `records`, `fetches`.
  - `engine/rlm_engine/child.py`: `Children.started`, `run`, `records`.
  - `engine/rlm_engine/link.py` (error codes at lines 37 to 40), `engine/rlm_engine/errors.py`.
  - `engine/rlm_engine/permissions.py` (`log`).
  - `engine/rlm_engine/callformat.py` (`assistant_message`, `observation_message`).
  - `engine/rlm_engine/contract.py` (`OBS_COUNTERS`).
  - `engine/rlm_engine/worker/manager.py` (`Worker`, `timeouts`, `crashes`, `restarts`, the per-cell wall cap at about line 319).
  - `engine/rlm_engine/worker/worker.py`: `run_cell` (line 398) resets `_state["submitted"]` at the start of every cell, so `submit()` already works again in a later prompt, and this file doesn't change. Read it to confirm.
  - `engine/rlm_engine/worker/tools.py`, read only.
- Engine tests: `engine/tests/fakeapp.py`, `engine/tests/test_loop.py`, `engine/tests/test_service.py` (`test_order_on_the_wire` is the pattern for `run.say`'s order).
- App code, whole files:
  - `app/src/protocol.ts`, `app/src/session.ts`, `app/src/settings.ts` (`SCHEMA`), `app/src/link.ts`.
  - `app/src/interface/App.tsx` (`start`, `clear`, `submit`, `quit`, `onCtrlC`), `app/src/interface/store.ts` (`RunStore`, the event switch, `statusModel`, `viewFromRecord`), `app/src/interface/mentions.ts` (`parseQuestion`), `app/src/interface/runs.ts`, `app/src/interface/commands/{index.ts,runs.tsx,context.tsx}`.
- App tests: `app/test/fakes/engine.ts` (`createFakeApp`), `app/test/interface/helpers.ts` (`mount`), `app/test/session.test.ts`.
- `protocol/examples.json`.

## Starting state

- Step 3 is `done`: protocol 2, record format 2 with `prompt_index: 0` and `conversation: false` written, compaction in `loop.py` and `child.py`.
- A run ends at submit, at its turn limit or at an infra error. Then the worker closes and the scratch folder goes. The interactive app starts a fresh run for every question (`App.tsx`, S-11).

## Deliverables

**Engine.**

- `engine/rlm_engine/followup.py`. *KV cache: only appends messages after the last one; it never edits an earlier message.* The texts below are pinned and tested byte for byte. They belong to the profile layer, not prompt v4.

```python
SUBMITTED_NOTE = "Your answer was submitted, and the user has seen it."
UNANSWERED_NOTE = "That question ended without a submitted answer."
FOLLOW_UP = (
    "Follow-up from the user. The REPL still holds every variable from before{where}.\n\n"
    "{text}\n\n"
    "({turns_left} turns left, {subcalls_left} sub-calls left) Answer this with submit(), as before."
)
WHERE = {"read": ", and `context` is unchanged", "repo": ", and the repository keeps your edits"}
```

  - `follow_up_messages(last: dict, *, submitted: bool, text: str, mode: str, turns_left: int, subcalls_left: int) -> list[dict]`. The note is `SUBMITTED_NOTE` if the prompt submitted, else `UNANSWERED_NOTE`.
    - When `last` is an assistant message with a native tool call, it returns `[{role: "tool", tool_call_id: <its id>, content: note}, {role: "user", content: FOLLOW_UP...}]`.
    - Otherwise (fenced, or no tool call) it returns one user message, `note + "\n\n" + FOLLOW_UP...`.
- `engine/rlm_engine/loop.py`:
  - `RunSpec` gains `conversation: bool = False`.
  - `class Inbox` holds `prompt_index: int = 0` and `waiting: bool = False`, with `put(text) -> int`, `close()` and `async next() -> str | None`. `put` sets `waiting = False`, increments `prompt_index` and returns it. `close` puts `None`.
  - `run(spec, app, *, home, worker_factory=Worker, inbox: Inbox | None = None)`. Task 2 gives the new structure.
- `engine/rlm_engine/bridge.py`:
  - `start_prompt()` sets `self.prompt_base = self.subcalls_used` and `self.fetch_base = len(self.fetches)`.
  - `subcalls_left()` and the two budget checks count `subcalls_used - prompt_base`. Ids keep counting across prompts, so `subcall_id` stays unique within the run.
  - `prompt_records()` returns the records with `subcall_id > prompt_base`.
- `engine/rlm_engine/child.py`: `Children.start_prompt()` sets `self.prompt_base = self.started`. The `max_runs` check counts `started - prompt_base`, and `records()` returns this prompt's children only (`child_id > prompt_base`).
- `engine/rlm_engine/link.py`: `RUN_BUSY = -32013`, next to the others. The app mirrors it in `protocol.ts`.
- `engine/rlm_engine/service.py`:
  - `_Run` gains `inbox: Inbox | None`.
  - `run.start` reads `conversation`: a bool, default false, -32602 for any other type. With `true` it creates an `Inbox` and passes it to `loop.run`.
  - `run.say {run_id, text}`:
    - -32010 when the run is unknown, finished, or has no inbox;
    - -32602 when `text` is not a non-empty string;
    - -32013 when `inbox.waiting` is false (a prompt is running);
    - otherwise it returns `{prompt_index: inbox.put(text)}`, and `put` is the handler's last statement, with no `await` after it. That way the result goes out before the prompt's first `model.complete`, as `run.start`'s result does (§5.4, D-84).
  - `run.close {run_id}`: -32010 as above, and -32013 while a prompt runs (use `run.cancel` for that). Otherwise it calls `inbox.close()`, waits up to `CANCEL_WAIT_S` for the task to end, and returns `{}`, so `run.closed` has been sent by then.
  - `register` adds both methods.
- `engine/tests/fakeapp.py`: nothing new beyond step 3. Root replies keep being served in order across prompts.

**App.**

- `app/src/protocol.ts`:
  - `RunStartParams.conversation?: boolean`
  - `RunSayParams {run_id, text}`, `RunSayResult {prompt_index}`, `RunCloseParams {run_id}`
  - `RunStartedParams.conversation`
  - `RunFinishedParams.prompt_index` and `.open`
  - `RunClosedParams {run_id, prompts}`, in the event union
  - `RUN_BUSY`
- `app/src/session.ts`:
  - `StartRun.conversation?: boolean`, and `buildRunParams` sets `conversation: r.conversation ?? false`.
  - `say(runId, text): Promise<RunSayResult>` passes RPC errors through.
  - `closeRun(runId): Promise<void>` swallows -32010.
- `app/src/settings.ts`: `conversation.follow_ups`, bool, default `true`, with the doc "A question in the interactive app continues the open conversation (same REPL and workspace). Off: every question starts fresh." It goes after v0's keys (architecture §8). Update v0/architecture.md's §8 table too (D-178 is the reason).
- `app/src/interface/conversation.ts` (new, plain TypeScript, no Ink):
  - `interface Conversation { runId; mode: "read" | "repo"; files: string[]; folder: string; root: string; sub: string; profile: string; permissionMode: string; promptIndex: number; open: boolean }`
  - `continues(conv, q: {mentions: string[]; choice: "auto" | "repo" | "read"}, now: {root; sub; profile; permissionMode}) -> boolean`, the rules below.
- `app/src/interface/mentions.ts`: export `mentionPaths(text, cwd): {ok: true; paths: string[]} | {ok: false; error: string}`. It applies the same regex and checks as `parseQuestion`, which now uses it.
- `app/src/interface/store.ts`:
  - The view gains `conversation: Conversation | null`.
  - `run.started` with `conversation: true` sets it.
  - `run.finished` sets `promptIndex` and `open` from the event.
  - `run.closed` sets `open = false`.
  - New `beginFollowUp(question)`: keeps the run id, entries and panel rows, adds the question entry with detail `follow-up <k>`, and sets phase `starting`. Also new `followUpResolved(promptIndex)` and `followUpFailed(message)`.
  - `statusModel`'s state segment:
    - while a conversation is open and no prompt runs: `ready for a follow-up`;
    - while a follow-up runs: `running 0:12 · follow-up <k>`;
    - everything else as in v0.
- `app/src/interface/App.tsx`: the submit rules below. `/clear` and `/quit` close an open conversation. `/context`'s variables table also works while a conversation is open, and its "Variables exist only while a run is active" text becomes "…while a run or a conversation is open."
- `app/src/interface/commands/runs.tsx`: a record with `prompt_index > 0` shows `follow-up <k>: ` before its question. `viewFromRecord` shows the record's prompt only. Its `messages` hold the whole conversation, but the replay is built from `turns`, as in v0.
- `app/test/fakes/engine.ts`: `createFakeApp` answers `run.say` and `run.close` on the real engine. If it fakes the engine side instead, add a `conversation` scenario that does: `run.finished {open: true}`, then a second prompt, then `run.closed`.
- `protocol/examples.json`: `run.say` (request, result, the -32013 error), `run.close`, `run.closed`, `run.start` with `conversation`, and `run.finished` with `prompt_index` and `open`.

**`continues` rules (D-178).** All must hold:
1. `root`, `sub`, `profile` and `permissionMode` equal the conversation's. The permission mode is the one the next run would use (`nextMode`).
2. `conv.open` is true, and `conversation.follow_ups` is on (App checks the setting).
3. With choice `auto`: no mentions continues any conversation; mentions continue only a read conversation, and only when they name exactly `conv.files` (as sets).
4. With choice `repo`: only a repo conversation, in the same `folder` (`deps.cwd`).
5. With choice `read`: only a read conversation, with no mentions or exactly `conv.files`.

**Submit flow in `App.tsx`.**
- When `continues(...)`: the text sent is `parseQuestion(...).run.question` (mentions stripped) if there were mentions, else the typed text. The app calls `store.beginFollowUp`, then `session.say(runId, text)`.
  - A -32010 means the engine already closed it. The app adds the note "That conversation had ended, so this starts a new one." and falls through to a fresh start.
  - Any other error is `store.followUpFailed`.
- Otherwise, if a conversation is open, the app calls `await session.closeRun(conv.runId)` first. Then it runs v0's start flow with `conversation: settings.conversation.follow_ups`.
- Esc and Ctrl-C during a follow-up cancel the whole conversation (`run.cancel`).

## Tasks

1. [ ] **`followup.py`** and its tests. Then `Bridge.start_prompt`, `Children.start_prompt` and the per-prompt counting, with tests that ids keep counting while budgets start over.
2. [ ] **Restructure `loop.run`.** Setup (scratch, snapshot, worker, bridge, children, the compaction plan, `run.started`) happens once. Then, for `k = 0, 1, …`:
   - **Per-prompt state.**
     - `turns = []`, `root_usage = zero`, `submitted = False`.
     - `started_at` and `clock` reset; `bridge.start_prompt()`; `children.start_prompt()`.
     - `perm_base = len(perms.log)`.
     - Worker counter bases for `timeouts`, `crashes` and `restarts`, so the record holds deltas.
     - For `k > 0`, `messages.extend(followup.follow_up_messages(messages[-1], submitted=<previous prompt's>, text=…, mode=…, turns_left=limits.max_turns, subcalls_left=bridge.subcalls_left()))`, with `chars_since` grown by their length.
   - **The turn loop** is v0's (and step 3's), with turns numbered from 1 in every prompt.
   - **At the prompt's end:**
     - take the diff in repo mode;
     - build the record from this prompt's slices (`bridge.prompt_records()`, `fetches[fetch_base:]`, `children.records()`, `perms.log[perm_base:]`, the counter deltas), with the whole `messages`, `prompt_index = k`, `conversation = spec.conversation`, and `question` or `task` set to this prompt's text;
     - append it to the run log;
     - emit `run.finished` with `prompt_index = k` and `open`.
   - **`open`** is `spec.conversation and inbox is not None and infra_error is None`.
   - **When `open`:** set `inbox.waiting = True` and `await inbox.next()`. `None` ends the loop. Nothing is cancelled between prompts: an `llm_async` future still running carries on into the next prompt, as it would between two cells (D-159).
   - **The `finally`**, once:
     - close the worker, `app.cancel_calls`, remove the scratch folder;
     - if a prompt was in flight when the run stopped (a cancel or an exception), write that prompt's record and `run.finished {open: false}` first, exactly as v0 does;
     - for a conversation, emit `run.closed {prompts: k + 1}` last.

   A one-shot run (`conversation: false`) must give exactly the events, record and order it gave in step 3. Its `run.finished` gains only `prompt_index: 0` and `open: false`.
3. [ ] **`service.py`**: `conversation` on `run.start`, `run.say`, `run.close` and `RUN_BUSY`, as listed. `run.cancel` during the wait gives `run.closed` and no new record or `run.finished`. `_cancel_all` covers open conversations too, so closing stdin leaves no worker behind.
4. [ ] **Protocol and examples** on both sides, plus `protocol.ts`'s types.
5. [ ] **App:** `session.ts`, `settings.ts`, `conversation.ts`, `mentions.ts`, `store.ts`, `App.tsx`, `runs.tsx`, the fake engine, as listed.
6. [ ] Run the full gate, then the hand checks under Done when. Update progress.md.

## Tests

**`engine/tests/test_followup.py`**
- The texts are pinned byte for byte.
- Native: an assistant message with a tool call gives a tool message (its `tool_call_id`, the right note), then a user message.
- Fenced: one user message that starts with the note, then `\n\n`, then the follow-up.
- The `WHERE` text is chosen by mode.

**`engine/tests/test_conversation.py`** (`FakeApp(script=…)`, real `Worker`, profile `default` with `[read] max_turns = 6, max_subcalls = 5` as a user profile)
- `test_two_prompts_native`:
  - Prompt 0 submits `1`, which gives `run.finished {prompt_index: 0, open: true}` and one log line.
  - `run.say {text: "Q2"}` returns `{prompt_index: 1}`.
  - The next root request's messages are the earlier list, plus a tool message `SUBMITTED_NOTE`, plus the user message `FOLLOW_UP` with `(6 turns left, 5 sub-calls left)`.
  - Prompt 1 submits `2`, which gives a second log line with the same `run_id`, `prompt_index: 1`, `turns` numbered from 1, `answer: 2`, and `messages` holding the whole conversation.
  - `run.close` gives `run.closed {prompts: 2}`. The worker is gone, and so is the scratch folder.
- `test_two_prompts_fenced`: the same with fenced replies. The follow-up is one user message.
- `test_variables_survive`: prompt 0 sets `x = 41`; `run.vars` lists `x` while waiting; prompt 1 prints `x + 1` and sees `42`.
- `test_budgets_start_over`: prompt 0 uses 3 sub-calls. Prompt 1 can still use 5, with ids 4 to 8; its record lists only its own 5 sub-calls; the run's total sub-calls are 8.
- `test_turns_out_then_follow_up`: prompt 0 runs out of turns. The follow-up note is `UNANSWERED_NOTE`, and the conversation stays open.
- `test_infra_closes`: prompt 0 ends with a `server` error. That gives `run.finished {open: false}`, then `run.closed`, and a later `run.say` gives -32010.
- `test_say_errors`: `run.say` on a one-shot run (-32010); while prompt 1 runs (-32013); after `run.close` (-32010); with empty text (-32602). `run.close` while a prompt runs gives -32013.
- `test_cancel_while_waiting`: `run.cancel` gives `run.closed`, and no new record or `run.finished`.
- `test_cancel_mid_prompt`: prompt 1's record has `infra_kind: "cancelled"`. The events are `run.finished {open: false}` and then `run.closed`.
- `test_repo_conversation`: git repo, `accept-edits`. Prompt 0 writes `a.txt` and prompt 1 writes `b.txt`. Prompt 1's `diff` holds both files, and both records have the same `base_tree`.
- `test_compaction_spans_prompts`: step 3's compaction test profile, with conversation on. A compaction in prompt 1 keeps prompt 0's system and first message byte for byte.
- `test_order_on_the_wire_say`: on a real `Link` pair, as `test_service.py` does it. The `run.say` result is written before the prompt's first `model.complete`.
- `test_one_shot_unchanged`: `conversation: false` gives the same event list as step 3's test, plus `prompt_index: 0, open: false` on `run.finished`, and no `run.closed`.
- `test_stdin_close_with_open_conversation`: closing the link gives `run.closed` and leaves no worker process.
- `test_training_v4_follow_up`: a follow-up works under `training-v4`, and its prompt 0 requests equal a one-shot run's.

**App** (`bun test`)
- `test/session.test.ts`: `buildRunParams` sends `conversation: false` by default. With the real engine on `fake/scripted`: start with `conversation: true`, `say`, then `closeRun`. That gives two `run.finished` events and one `run.closed`. `closeRun` on a closed run resolves.
- `test/interface/conversation.test.ts` (`mount` + `createFakeApp`):
  - A no-mention question, then a second one: one `run.start`, one `run.say`, and the transcript shows `follow-up 1`. The status line reads `ready for a follow-up` between them and `· follow-up 1` while the second runs.
  - `@a.txt` then a question with no mention: a follow-up in read mode.
  - `@a.txt` then `@b.txt`: `run.close`, then a new `run.start`.
  - A Shift+Tab choice of `repo` after a read conversation: a new conversation.
  - A changed `root.model` (through `/model`): a new conversation.
  - `/clear` with an open conversation: `run.close`, then "New session."
  - `conversation.follow_ups = false`: every question is a `run.start` with `conversation: false`.
  - A -32010 on `say`: the note, then a fresh start.
  - Esc during a follow-up: `run.cancel`.
- `test/interface/conversation-rules.test.ts`: a table test of `continues` for rules 1 to 5.
- `test/interface/runs.test.ts`: `/runs` lists a conversation's two records, the second with `follow-up 1: `.
- `protocol/examples.json` passes on both sides.

## Done when

- The full gate prints `VERIFY: PASS`, and CI is green on macOS, Windows and Linux.
- **Hand check on the fake provider** (in `app/`):
  1. `RLMH_HOME=<tmp> bun run src/main.ts config set root.model fake/scripted`.
  2. `RLMH_HOME=<tmp> RLMH_FAKE_SCRIPT=<a script with two submits> bun run src/main.ts`.
  3. Ask `@a.txt what is in it?`, then `and how long is it?`. The second runs as `follow-up 1` in the same run, and `/runs` shows both.
- **Windows Terminal hand check on Rishi's PC**, against a real model the same way. The terminal check stays a PC check, as in v0 step 7: two questions in one conversation, then `/clear`, then a third question that starts fresh.
- **Parity on the PC**, because `loop.py` changed: `harness_parity.py` gives the same verdict as after step 3.
- `rlmh run --json` and `rlmh batch --json` on the fake provider print no `run.closed` and the same lines as before this step, apart from `prompt_index` and `open` on `run.finished`.

## Out of scope

- Follow-ups in `rlmh run` or `rlmh batch` (`--continue`). The engine exits when a script's session closes, so there is nothing to continue (D-178).
- Adding files to a read conversation: new mentions start a new one. Changing `context` in place would need a new worker op.
- Branching or resuming an old conversation from `/runs` (OMP's `/resume`, `/fork`).
- Per-prompt permission modes: the mode is fixed for the conversation (rule 1).

## Hand-off

- **Step 9 relies on:** `run.say` and `run.closed`, and `continues()`, so `/tune` can close an open conversation before it runs, and its own runs never use one (`conversation: false`).
- **Step 10's release notes** describe follow-ups and the `conversation.follow_ups` setting.
- **progress.md:** set row 4 to `review`, with the date, the Windows Terminal check's result (or "not yet run on the PC"), and the parity verdict.

## If a decision goes the other way

- **D-178, follow-ups in scripts too:** `rlmh run --continue <run_id>` would need the engine to outlive one command (a daemon) or to rebuild the REPL from the log, which can't restore live objects. Not recommended for v1.
- **New mentions add files to a read conversation:** the worker would need a `extend_context` op that appends to `context` with `=== path ===` headers (`inputs.read_context`'s format), and `FOLLOW_UP` would name the new files. That is additive, but it touches the worker init that parity checks.
- **Turns numbered across the whole conversation** (not from 1 per prompt): records stay per prompt, the bridge's `turns_left` counts from the prompt's first turn, and the store keys transcript turns by `(prompt_index, turn)`. Nothing on the wire changes.
