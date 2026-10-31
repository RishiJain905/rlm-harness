# Step 7. Interactive view: screens, status line, sub-call panel

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 6 (and through it 2 to 5) |
| **Unblocks** | 9 |
| **Parallel with** | 8 |
| **Decisions it uses** | 2a: Ink. 4b: default mode is `accept-edits` (S-27). 5a: every provider in `PROVIDERS` is listed. 6c: `@path` means read mode, no mention means repo mode. S-06, S-10, S-11; D-14, D-17, D-21, D-22, D-24, D-26, D-38 |

## Goal

Bare `rlmh` opens the real app: a prompt box, the transcript of the current run above it, a status line below, a sub-call panel that shows each `llm_batch` fan-out as it streams, an approval prompt answered from the keyboard, and the seven slash commands. A person can start, watch, approve, cancel and later replay a run. The step reads only what steps 5 and 6 hand over, so no engine, gateway or protocol code changes.

## Read first

- [../../legacy/v0-design.md § Interface](../../legacy/v0-design.md#interface), [§ Permissions](../../legacy/v0-design.md#permissions) (the round trip) and [§ Failures](../../legacy/v0-design.md#failures).
- [../../legacy/v0-build-plan.md § Step 7](../../legacy/v0-build-plan.md#step-7-interactive-view-screens-status-line-sub-call-panel).
- [../architecture.md](../architecture.md): §2 (files), §4 (types), §5.2 (`approval.request`), §5.3 (events), §5.4 (one run in order), [§7.3](../architecture.md#73-step-5--6-7-the-gateway-and-the-bus) (Gateway, `AppEvents`, KeyStore, Catalog, `ProviderDef`), §7.5 (fake provider), [§7.8](../architecture.md#78-step-6--7-8-9-runs-run-log-commands) (Session, run-log record), §8 (settings), §9 (folders), §11 (tests), §12 (conventions).
- [../decisions.md](../decisions.md): D-14, D-21, D-22, D-24 and S-23 (2a), S-27 (4b), S-28 (5a) and S-31 (6c).
- [../../legacy/architecture.md § What we borrow](../../legacy/architecture.md#what-we-borrow): OMP's status-line segments and `/context` grid, DeepSeek Harness's context ring and cache-hit pill. Ideas only; no code is copied.
- `step-05-gateway.md` and `step-06-loop-runlog-cli.md` for the exact exports, then the code they built (`session.ts`, `gateway/*.ts`, `settings.ts`, `paths.ts`, `bus.ts`).
- No training files: the interface reads no training code.

## Starting state

- Steps 2 to 6 are `done`. `bun test` and `uv run --project engine pytest engine/tests` pass. `rlmh run --json` completes a run on `fake/scripted`.
- `interface/App.tsx` is step 2's empty Ink screen, and bare `rlmh` in `main.ts` renders it. `package.json` already pins Ink and React.
- `Session`, `Bus<AppEvents>`, `Gateway` (`totals`, `lastRootRequest`, `refreshModels`), `KeyStore`, `Catalog`, `settings.ts`, `paths.ts` and `gateway/fake.ts` exist as in architecture.md §7.

## Deliverables

**One rule shapes the layout of the code: only `.tsx` files import Ink.** The view model, formatting, parsing and file reading are plain TypeScript, so a switch to OpenTUI (2a) rewrites only the `.tsx` files and the test helper. Every module starts with `// KV cache: none` and a clause saying the interface never touches the bytes sent to the model (architecture.md §12, S-21).

| Path | Responsibility and public interface |
|---|---|
| `app/src/interface/store.ts` ◆ private | `AppDeps = { session: SessionLike; keys: KeyStore; catalog: Catalog; approvals: ApprovalQueue; home: string; cwd: string; size?: {columns: number; rows: number}; env?: Record<string, string \| undefined> }`, with `SessionLike = Pick<Session, "bus"\|"gateway"\|"settings"\|"info"\|"start"\|"cancel"\|"vars"\|"close">`. `class RunStore { constructor(deps); beginRun(); snapshot(): RunView; subscribe(fn): () => void; dispose() }`, the selectors `statusModel(view, deps)` and `contextBreakdown(request)`, and `viewFromRecord(record): RunView` (a run-log record becomes the same view, for `/runs`). Event rules below |
| `app/src/interface/format.ts` ◆ private | Pure helpers: `formatTokens` (`12.3k`), `formatCost` (under $1: four decimals; else two), `formatDuration` (`3.2s`, `1m05s`), `unicodeSupported(env, platform)`, `glyphs(unicode)`, `windowLines(items, selected, height)`, `layoutHeights(rows, parts)`, `layoutStatus(segments, columns)`, `contextTone(pct)`, `cacheTone(rate)` |
| `app/src/interface/mentions.ts` ◆ private | `parseQuestion(text, cwd, fs?): {ok: true; run: StartRun} \| {ok: false; error: string}` (6c rules below) and `completePath(prefix, cwd)` |
| `app/src/interface/approvals.ts` ◆ private | `class ApprovalQueue { ask(p: ApprovalParams): Promise<ApprovalResult>; head(); answer(r: ApprovalResult); denyAll(); subscribe(fn) }`. First in, first out. `main.ts` passes `ask` to `Session.open` |
| `app/src/interface/runs.ts` ◆ private | `listRuns(runsDir): Promise<RunSummary[]>` and `readRun(summary): Promise<object>`. Streams every `<runsDir>/*/runs.jsonl`, keeps a summary and a byte range per line, skips a torn last line, returns the newest 200 |
| `app/src/interface/commands/index.ts` ◆ private | `interface SlashCommand { name: string; summary: string; Screen: (p: ScreenProps) => JSX.Element }`, `ScreenProps = { deps; store; close(): void; permissionMode: string; setPermissionMode(m: string): void }`, and `COMMANDS` (the seven below) |
| `app/src/interface/App.tsx` | `App(props: {deps: AppDeps})`. Owns focus, screens, the prompt-submit flow and `Esc`. Replaces step 2's empty screen |
| `app/src/interface/PromptBox.tsx` | Single-line input with a cursor, history, the slash menu and `@path` completion. Props: `value`, `onSubmit`, `disabled`, `hint` |
| `app/src/interface/Transcript.tsx` | The bounded transcript window (entries below) |
| `app/src/interface/StatusLine.tsx` | Draws `statusModel` through `layoutStatus` |
| `app/src/interface/SubcallPanel.tsx`, `SubcallView.tsx` | The block list, and the full view of one row |
| `app/src/interface/Approval.tsx` | The inline prompt for the head of the queue |
| `app/src/interface/commands/{providers,model,settings,permissions,context,runs,help}.tsx` | One screen each. `/quit` is handled in `App.tsx`. `help.tsx` lists `COMMANDS` and the key table |
| `app/src/main.ts` (edit) | Bare `rlmh` branch below |
| `app/test/fakes/engine.ts` | The fake engine (decision below), `scriptedBus()` and `runRecord(over?)` |
| `app/test/fakes/demo-script.json` | A `RLMH_FAKE_SCRIPT` file for the manual check: a 20-way `llm_batch`, then `shell("ls")` (asks), then `submit`; contents under Tasks |
| `app/test/interface/helpers.ts` | `mount(deps)` → `{screen(), frames, press(key), type(text), waitFor(fn, ms)}`; `KEYS` (`enter "\r"`, `esc "\u001B"`, arrows, `tab`, `backspace "\u007F"`, `ctrlC`); strips ANSI. Every `press` waits 30 ms for Ink to read it |

**Event rules (`store.ts`).**
- It listens to `engine.event`, `call.start`, `call.delta`, `call.end` and `engine.exit`, and drops events for other run ids. `beginRun()` runs before `session.start()`. The first `run.started` while starting fixes the run id, because it can arrive before `start()` resolves (same pipe, §5.4).
- **A sub-call row is keyed by `subcall_id`** and made by whichever comes first: `run.subcall` or `call.start` (role `sub`). Status: `queued` (sent, no `call.start` yet: the gateway holds a batch up to 100 ms, D-24), `streaming`, `done`, `error` (`call.end.error`, else the `run.subcall` error), `rejected` (a lone `rejected` event: no model call happened). Prompt, text, reasoning, usage and seconds come from the gateway events. Blocks group by `batch.id`; a single `llm()` is a block of one.
- A root `call.start` shows a live tail of the reply until `run.reply` arrives.
- `call.delta` with `reset: true` (step 5: a broken stream is retried whole) clears that call's streamed text and reasoning before the next delta.
- **Context used** is the latest `run.reply` `usage.input_tokens + output_tokens`; before the first reply it is `~` characters ÷ 4 of `gateway.lastRootRequest(runId)`. **Window** is `catalog.get(root.provider, root.model)?.context_window`, else `?`.
- **Cost and cache** come from `gateway.totals(runId)` at each flush: `$total (root $r + sub $s)` and `hit_rate` (`--` when null). **Budget** is the latest `run.budget` against `run.started.limits`.
- Store changes reach React at most every 50 ms (`FLUSH_MS`), so 20 streams don't repaint per chunk. One 100 ms tick runs only while a row streams or a root call is open.
- `engine.exit` marks the run failed, shows the last 12 stderr lines, and blocks new runs ("The engine stopped (exit N). Restart rlmh.").

**Screen.** Frame height is at most `rows - 1` (Ink repaints the whole screen when a frame is as tall as the terminal, which flickers on Windows). From the top: transcript, sub-call panel (when the run has sub-calls), approval prompt (when pending), slash menu (while typing `/`), the 3-line prompt box, the 1-line status line. `layoutHeights` gives the panel half of the free rows (at least 4) and the transcript the rest (at least 3). Slash screens and the sub-call view replace the transcript and panel area. Below 50 columns or 12 rows it shows "Terminal too small (need 50x12)". The idle banner shows `rlmh <APP_VERSION>`, the engine version from one `session.info()` call (ignored if it fails), the folder, the root and sub models, and "Each question is a new run."
- **Transcript** has no `<Static>`: it is a tail window with PageUp/PageDown, so every frame is a whole screen that tests can read. Entries: the question with its mode (`read: 2 files` or `repo: <folder>`); a `run.started` line; per turn the reply (6 lines, reasoning dimmed to 2), the code (8 lines), the output (8 lines, error in red, `restarted`/`crash`/`repo_changed` notes); denied or asked `run.permission` lines; the answer block or the `infra_error`. `Ctrl+O` shows entries in full. Long entries end with `… +N lines`.
- **Sub-call panel.** A running block shows a header (`batch b1 · 20 calls · 7/20 done · turn 1 line 3`) and rows `#07 streaming  ~1.2k in ~340 out  3.2s  <prompt start>`. Token counts are `~` estimates (chars ÷ 4) until `call.end` gives exact usage. Finished blocks collapse to one line (`Enter` expands). Rows window around the selection with `^ N more` / `v N more` lines.
- **Sub-call view** (`Enter` on a row; `Esc` or `q` closes; Up/Down/PageUp/PageDown scroll; Left/Right step to the previous or next row): title with status; model; `Issued by turn T, line L` plus the text of that cell line once known (`run.cell.code`, or `tool_call.arguments.code` of `run.reply`); tokens (in, cached, out, reasoning), cost, time; then Prompt, Reasoning (only if non-empty, dim), Answer (follows the stream until the user scrolls). `line: null` reads "line unknown".
- **Status line**, in drop order from first dropped: permission mode, sub model, cache, root model, cost, context, budget; the state (`idle`, `running 0:12`, `waiting for approval`, `cancelling`, `finished`, `cancelled`, `failed: <kind>`) is always kept. Example: `running 0:12 | root deepseek/deepseek-chat | sub same | ctx 12.3k/64k 19% | $0.0123 (root $0.0100 + sub $0.0023) | cache 87% | turns left 14/20, sub-calls left 61/80`. `contextTone` is ok under 60%, warn under 85%, then high; `cacheTone` is ok from 60%, warn from 20%.
- **Characters.** Use only box-drawing, block elements, the braille spinner and `●` `○`; never emoji or ambiguous-width symbols, which Windows Terminal measures differently from Ink. Statuses always carry a word (`run`, `done`, `err`, `rej`, `queued`), so colour is never the only signal. Colours are the basic named ones, and `NO_COLOR` is honoured.

| | Unicode | ASCII fallback |
|---|---|---|
| border | `borderStyle: "round"` | `"classic"` |
| spinner | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | `\|/-\` |
| bar | `█` `░` | `#` `.` |
| status dot | `●` `○` | `*` `.` |
| more | `…` | `...` |

`unicodeSupported`: on win32 true when `WT_SESSION`, `TERM_PROGRAM=vscode`, `ConEmuANSI=ON`, or `TERM` is `xterm-256color` or `alacritty`; elsewhere true unless `TERM=linux`. `RLMH_ASCII=1` forces the fallback. A legacy PowerShell console window therefore gets ASCII, and Windows Terminal gets Unicode.

**Keys.**

| Key | Does |
|---|---|
| Enter | submit the prompt; choose in a list |
| Esc | in this order: deny the head approval; close the open screen or sub-call view; cancel the active run; clear the prompt |
| Ctrl+C | cancel an active run; idle: press twice within 2 s to quit. `exitOnCtrlC` is off |
| Tab | complete `/command` or `@path`; on an empty prompt, move focus to the panel |
| Up / Down | prompt history (this session only, 100 entries, never written to disk); in the panel, move the selection |
| PageUp / PageDown, End | scroll the transcript; End follows the tail |
| y / a / n | approval: allow, allow for this run, deny |
| Backspace | deletes left. Ink reports Windows backspace as `delete`, so both flags are handled; there is no forward delete |

**Starting a run (6c).** `parseQuestion` finds mentions with `(^|\s)@("[^"]+"|\S+)`, so `a@b.com` is not one. Paths resolve against `cwd` and accept `\` and `/` and a drive letter. Each must exist and be a file; otherwise nothing starts and the line says which `@token` failed. Mentions are deduplicated in order, and the `@` is dropped from `question` with the path written with `/` (D-17). One or more mentions give `{mode: "read", question, inputs}`. None gives `{mode: "repo", task: text, repoPath: cwd}`. Both send `interactive: true`, the session's permission mode, and no model refs (`Session.start` fills them from settings). Before `start()` the app checks locally, with no network call:
- `root.model` is empty → "No model picked. Use /model." and `/model` opens.
- The root provider needs a key and `keys.resolve` finds none → "No key for <provider>. Use /providers."
- Repo mode with no `.git` in `cwd` or its parents → a warning line ("diff() will be unavailable"), and the run goes on.
- `cwd` is the user's home folder or a drive root → "This folder is very large. Run on it anyway? y/N".
- A run is active → the text stays in the box: "A run is active. Esc cancels it."
- `start()` rejects (-32011, -32012) → the error message in the transcript, state back to idle.

**Approvals (`Approval.tsx`).** Shows `<kind>` in colour, the full `detail` (up to 600 characters, then `(+N chars)`), `turn N`, and "outside the workspace" when `inside_workspace` is false. Choices: `y` Allow once, `a` Allow for this run, `n` Deny. Up/Down moves the highlight and Enter confirms it. The highlight starts on Deny, so Enter denies, as in step 6's terminal prompt. `a` says what it covers (D-14): for `write`, "every later write inside the workspace in this run" (or "outside"); for `shell`, "every later shell command in this run"; for `network`, "this host, for the rest of this run". Results: `{allow: true, remember_for_run: false}`, `{allow: true, remember_for_run: true}`, `{allow: false, remember_for_run: false}`. With several pending, the head shows `+N waiting`. While one is pending, other keys don't reach the prompt box. `run.finished`, `engine.exit` and quit call `denyAll()`.

**Slash commands.**

| Command | Behaviour |
|---|---|
| `/providers` | Rows from `PROVIDERS` without the hidden `fake`, each with its key count, the active key (`last4`, label), and `key from <ENVVAR>` when `keys.resolve` says `env` (the value is never shown). A provider with `needsKey: false` shows its base URL. Inside a provider: `a` add, `d` delete (then `y`), `s` set active, `r` refresh models. **Add** is a masked field, then an optional label. Control characters are ignored (Ctrl+V arrives as `\x16`); pasted text is taken whole with CR, LF and spaces stripped. `checkFormat` runs first and its message shows inline. Then `keys.add`, and "Saved. Nothing was sent anywhere." The key lives only in that field's state, cleared right after `add`; it is never put in the store, history or any message. `r` shows "sends one request to <host> with the active key" beside the hint, calls `gateway.refreshModels(provider)` once, then `catalog.merge`, and shows the count or the error. No other code path in the screen calls the gateway or `fetch` |
| `/model` | Rows `root` and `sub`. Enter opens: provider (the `fake` provider only when `RLMH_FAKE_SCRIPT` is set) → model (the catalog's models with window and prices; typing filters, and Enter on a typed id not in the list takes it as free text, for local, custom and OpenRouter) → thinking (`default off low medium high`). `sub` also offers "same as root" (`sub.model = ""`). Saves with `applySetting` (private to `store.ts`: `setSetting` then `saveSettings(home, settings)`) and notes "applies to the next run" if a run is active. An id the catalog lacks is accepted with "window and prices unknown" |
| `/settings` | Rows from `settings.ts`'s `SCHEMA` (key, type, `choices`, default, `doc`; architecture.md §7.1) plus one `providers.<id>.base_url` and `max_in_flight` pair per listed provider. Enum: Left/Right cycles. Bool: Space toggles. String and int: type, Enter. `d` resets to the default. A validation error from `setSetting` shows under the row and nothing is saved. Each change is saved at once. `profile` offers the names from `session.info().profiles` |
| `/permissions` | Mode picker (`default`, `accept-edits`, `bypass`) with the v0-design table text, starting on the mode the next run would use (`accept-edits` unless `/settings` changed it, S-27); `bypass` shows a red warning. The choice is held in `App` state for the next run and is **not** saved (a persistent default is `/settings` → `permissions.mode`), so `bypass` can't stick by accident. Below it, this run's `run.permission` events as `turn N  <kind> <detail> allowed\|denied (asked\|remembered\|automatic)`; "first 200 shown" at the engine's cap |
| `/context` | From `gateway.lastRootRequest(runId)`: a bar of 40 cells over the window with `system` (messages[0]), `first message` (messages[1]), `turns (N)` (the rest), `tool def`, `output reserve` (`max_tokens`) and free, each with `~` tokens (chars ÷ 4) and the provider's reported figure from the last reply. Then `session.vars(runId)` as a table (`name type len chars`), refreshed with `r`. After the run ends the worker is gone, so the table says "Variables exist only while a run is active." No run yet: "No root request yet." |
| `/runs` | `listRuns(runsDir())`, newest first: `date  mode  root model  cost  turns  question or task start  ok\|failed:<kind>`. Enter calls `readRun`, then `viewFromRecord`, and shows the same `Transcript`, `SubcallPanel` and `SubcallView` read-only (no cancel, no approvals, `Esc` returns to the list). `format` other than `FORMAT_VERSION` shows "written by another format version". A record without `reasoning` for a sub-call simply has no reasoning section |
| `/help`, `/quit` | `/help`: commands from `COMMANDS` and the key table. `/quit`: deny approvals, cancel an active run, `session.close()`, exit |

**`main.ts`, bare `rlmh`.**
1. No TTY on stdin or stdout → stderr "rlmh needs an interactive terminal; use `rlmh run` for scripts." and exit 1 (D-50; step 2's CI smoke test checks it). On Windows, Git Bash's default window (mintty) is not a console, so the message adds "Use Windows Terminal or PowerShell, or `winpty rlmh`."
2. `queue = new ApprovalQueue()`; `Session.open({home: home(), verbose: false, approvals: p => queue.ask(p)})`. `verbose` stays false because engine stderr lines would be written over the screen; the stderr tail appears in the engine-exit panel. `EngineNotFound` and a protocol mismatch print their message and exit 1.
3. `render(<App deps/>, {exitOnCtrlC: false})`, `await waitUntilExit()`, `await session.close()`, print `Last run: <run_id>  <log_path>` if a run happened, and exit 0.
4. `keys` and `catalog` in `AppDeps` are `session.keys` and `session.catalog` (§7.8), the same instances the gateway uses, so a refresh merged into the catalog is seen by the next call.

**The fake engine (`app/test/fakes/engine.ts`): it speaks the real link and drives the real gateway on the fake provider.** Why: the panel's data is made by the gateway (`call.*`, `totals`, `lastRootRequest`) and by the order in which gateway events and engine events arrive. Scripted bus events would test our guess about both. Through the real gateway the 20-way fan-out also meets the real in-flight cap and batch rule and streams real chunks. It costs little, because `Link`, `Gateway`, `Bus` and the fake provider exist. `scriptedBus()` stays for what the fake provider can't produce: reasoning text, an error of a chosen kind at a chosen moment, a flood of deltas, and non-zero cost (fake prices are zero).
- `createFakeApp({scenario?, script?, cwd?})` builds a temp `home`, an in-memory `SecretsLike` (so no OS credential store is touched), `KeyStore`, `Catalog`, settings with `root.model = fake/scripted`, a `Bus`, a real `Gateway` whose `fetch` counts calls, and two `Link`s over in-memory streams (the engine side uses `idPrefix: "e"`). It wires what `session.ts` wires (§7.3): `model.complete` → `gateway.complete`, `model.cancel` → `cancelRun`, `approval.request` → `queue.ask`, every notification → `bus.emit("engine.event")`. It returns `{session, deps, engine, bus, startCalls: StartRun[], fetchCalls, dispose()}`. `dispose` removes the temp folder with retries (Windows holds handles) and restores `process.env`. It sets `RLMH_FAKE_SCRIPT` to a file it writes from the scenario.
- `engine` answers `engine.info`, `run.start` (`{run_id: "r_000000000001", log_path}`, then `run.started`), `run.cancel` and `run.vars`, and plays the scenario with the events and ordering of §5.4. Replies come from the fake provider script derived from the scenario, never from the fake engine. `engine.calls` logs every request it receives, `engine.emit(method, params)` sends a notification, `engine.crash(code, stderr)` closes the link and emits `engine.exit`.

| Scenario | Plays |
|---|---|
| `simpleRead` | turn 1: one `llm` (a block of one); turn 2: `submit('42')` |
| `fanOut20` | turn 1: `llm_batch` of 20 prompts, one batch id, origin line 3, answers of 3 or more chunks; turn 2: submit |
| `approvalShell` | turn 1: `approval.request` kind `shell`, detail `ls -la`; allowed → output `ok`, denied → `PermissionError`; emits `run.permission`; turn 2: submit |
| `twoApprovals` | two concurrent requests, a `write` outside the workspace and a `network` host |
| `slow` | root reply at 50 ms per chunk so Esc lands mid-call; `run.cancel` → `model.cancel`, then `run.finished` with `infra_kind: "cancelled"` |
| `rootError` | the script's `errors` fails root call 1 with kind `auth` → `run.finished` with `infra_error` |

## Tasks

1. [x] Set row 7 to `in progress` in progress.md. Read the step 5 and 6 specs and code. `setSetting` is pure and returns a new `Settings` (§7.1); `applySetting` saves that result and swaps it in.
2. [x] In `app/`: `bun add --exact --dev ink-testing-library @types/react`. Use the Ink and React versions step 2 pinned. If no `ink-testing-library` release accepts that Ink, write `mount` in `helpers.ts` over Ink's `render` with fake `stdin` and `stdout` streams instead. Record the versions in progress.md. Add no other UI dependency.
3. [x] Write `format.ts` and its cases first; they are pure. Then `store.ts` (`RunStore`, `viewFromRecord`), `mentions.ts`, `approvals.ts`, `runs.ts`.
4. [x] Write `app/test/fakes/engine.ts` and `helpers.ts`, then `app.test.tsx` against a stub `App` that renders the status line. Grow the screens against the tests.
5. [x] Build `StatusLine`, `Transcript`, `PromptBox`, `Approval`, `SubcallPanel`, `SubcallView`, then `App.tsx` (focus, `Esc` order, submit flow).
6. [x] Build the commands in this order: `help`, `permissions`, `model`, `settings`, `providers`, `context`, `runs`.
7. [x] Edit `main.ts` as above.
8. [x] Run `..\.bun\bin\bun.exe test test/interface` from `app/` until green, then the whole `bun test`.
9. [x] Check the compiled binary: run step 2's build script, then `dist\rlmh.exe --version` and launch it. Do not change step 2's Ink bundling setup.
10. [x] Write `demo-script.json` (it uses the real engine and the fake provider; `delay_ms` makes the streaming visible):
    ```json
    {"root": [{"text": "Fan out.", "tool_call": {"code": "outs = llm_batch([f'Summarize part {i}' for i in range(20)])\nprint(len(outs))"}},
              {"text": "Check the folder.", "tool_call": {"code": "print(shell('ls'))"}},
              {"text": "", "tool_call": {"code": "submit('demo done')"}}],
     "sub": [{"text": "Part summary: nothing unusual."}], "chunk_chars": 6, "delay_ms": 40}
    ```
11. [ ] *(Not run: PC only. The cloud container has no Windows. In its place the compiled Linux binary was driven in a real pseudo-terminal against the real engine and this demo at 100x30 and 80x24, Unicode and `RLMH_ASCII=1`: 20 rows streamed and collapsed, a repo-mode `shell('ls')` asked and `y` allowed it, Esc cancelled a run mid-stream, `/context` and `/runs` opened, and Ctrl+C twice exited 0. In read mode the demo's `shell('ls')` is a `NameError`, so the approval needs a question with no `@` mention (D-106).)* Manual check on Rishi's PC, in Windows Terminal and again in a Windows PowerShell console window. Set `RLMH_HOME` to a temp folder, run `rlmh config set root.model fake/scripted`, set `RLMH_FAKE_SCRIPT` to `app\test\fakes\demo-script.json`, start `rlmh` and type `Summarize @<any text file>`. Walk through the checklist under Done when and show Rishi.
12. [x] Update row 7 and the log in progress.md: versions and the private files. Do not commit.

## Tests

All under `app/test/interface/`, offline, using `createFakeApp`. Assert on `screen()` text and on `startCalls` and `engine.calls`, never on colours. Use `waitFor`, not fixed sleeps. Give the fan-out tests a 15 s timeout.

- **`app.test.tsx`**: (1) idle screen shows the banner, folder, prompt and status `idle`. (2) A question with `@a.txt` calls `start` with `mode: "read"`, the absolute path in `inputs`, `interactive: true`, and the transcript fills with reply, cell and answer `42`; status `finished`. (3) A question with no mention gives `mode: "repo"`, `repoPath` equal to `cwd`, `task` equal to the text. (4) A missing `@file` starts nothing and names the token; `a@b.com` is not a mention. (5) Empty `root.model` → hint and `/model` opens. (6) No key for a `needsKey` root → hint. (7) No `.git` → warning line, run still starts. (8) `cwd` = home → asks `y/N`; `n` starts nothing. (9) Enter during a run keeps the text and says a run is active. (10) `slow` + Esc → engine saw `run.cancel`, status ends `cancelled`, the transcript says "Run cancelled.", the prompt is usable again. (11) `engine.crash(1, [...])` → stderr lines shown, new questions refused. (12) `/quit` closes the session; Ctrl+C idle twice quits. (13) `unicodeSupported` table: win32 with `WT_SESSION` true; win32 bare false; `TERM=linux` false; `RLMH_ASCII=1` false; the ASCII frame contains none of `●╭─█`. (14) With `size` 50x14 and 100x30, no line exceeds `columns` wide and no frame exceeds `rows - 1` lines.
- **`promptbox.test.tsx`**: typing, Left/Right, backspace (both `\u007F` and `\b`), Ctrl+U, history with Up/Down, a pasted chunk with a newline does not submit; `/` opens the menu filtered as you type, Tab completes; `@` plus Tab completes a path in a temp folder; `parseQuestion` cases (quoted path with spaces, two files, duplicate, `\` and `/`); on win32 only (`test.skipIf`): `@C:\temp\a.txt` and `@"C:\Program Files\a.txt"`.
- **`statusline.test.tsx`**: (1) `statusModel` from a hand-built `RunView` and a stub `totals`: `$0.0123 (root $0.0100 + sub $0.0023)`, `cache 87%`, `turns left 14/20`, `ctx 12.3k/64k 19%`. (2) Unknown window → `?`; null hit rate → `--`; no run → models from settings. (3) `formatTokens`, `formatCost`, `formatDuration` tables. (4) `layoutStatus` at 60, 80 and 120 columns drops segments in the stated order and always keeps the state. (5) `contextTone` and `cacheTone` thresholds. (6) With the real gateway, `ctx` after the first reply equals that reply's `input_tokens + output_tokens`.
- **`subcalls.test.tsx`**: (1) `fanOut20`: one block, header "20 calls", reaches "20/20 done"; at some frame at least one row shows `streaming` with partial text; every row ends `done` with non-zero tokens. (2) At 80x24 the panel plus everything else fits `rows - 1`; `^ N more` / `v N more` appear; moving the selection to row 20 brings it into view. (3) Tab, Down to a row, Enter: the view shows the full prompt, the streamed answer, `turn 1, line 3`, tokens and time; Esc closes it and the run keeps going. (4) `scriptedBus`: reasoning deltas show a Reasoning section; none shows no section. (5) A `rejected` `run.subcall` → `rej` row, reason in the view, no tokens. (6) `call.end` with `error.kind = "rate_limit"` → `err` row and the message in the view. (7) `simpleRead`: "1 call" block. (8) Finished blocks collapse to one line, Enter expands. (9) 2,000 `call.delta` events emitted in one tick cause fewer than 100 frames. (10) The cell line text appears in the view once `run.cell` arrives.
- **`approval.test.tsx`**: (1) `approvalShell`: the prompt shows `shell`, `ls -la`, the three choices and sits above the prompt box. (2) `y` → engine got `{allow: true, remember_for_run: false}`, output `ok`. (3) `a` → `remember_for_run: true`. (4) `n`, Enter on the default highlight, and Esc each → `allow: false`, output has `PermissionError`; Esc does not cancel the run, a second Esc does. (5) Down then Enter picks the highlighted choice. (6) `twoApprovals` → head shows `+1 waiting`, answered in order. (7) Typing `y` with no approval pending goes into the prompt box; with one pending it doesn't. (8) A 700-character command shows 600 characters and `(+100 chars)`; `inside_workspace: false` shows "outside the workspace". (9) `engine.emit("run.finished", …)` with an approval pending clears it and resolves it as deny. (10) The `run.permission` event appears in `/permissions`.
- **`commands.test.tsx`**: (1) Each name in `COMMANDS` opens, Esc closes, and `/help` lists every name. (2) `/model`: pick root `fake/scripted` with thinking `low`; `settings.toml` in the temp home has the values; free-text id accepted; "same as root" writes `sub.model = ""`. (3) `/settings`: row count equals the schema plus the provider pairs; cycle an enum, toggle a bool, a bad int shows the error and writes nothing; `d` resets. (4) `/permissions`: choose `default` (not the `accept-edits` default, S-27, so the test proves the choice is carried); the next `start` carries it; `settings.toml` is unchanged; `bypass` shows the warning; events listed after `approvalShell`. (5) `/context` after a fake run: segment sizes add up to the estimate of `lastRootRequest`; mid-run vars table from the fake engine; after the run, the "only while a run is active" line. (6) `/runs` with a temp `runs/interactive/runs.jsonl` of three `runRecord()` lines plus a torn last line: three rows, newest first; Enter replays turns and a sub-call block; `engine.calls` has no `run.start`; a record with `format: 99` shows the version message. (7) `viewFromRecord(runRecord())` gives the same rows and turn count as the record.
- **`providers-nonetwork.test.tsx`**: replaces `globalThis.fetch` with a counter that throws, and also counts the gateway's injected `fetch`. (1) Open `/providers`, pick the first `needsKey` provider in `PROVIDERS` that isn't `fake`, `a`, type a key that `checkFormat` accepts (the test builds a sample per provider and checks it with `checkFormat`), Enter, label Enter: "Saved" shows, `keys.list` has it, both counters are 0, no `call.start` was emitted, `engine.calls` is empty. (2) No frame in `frames` contains the key, and no file under the temp home does. (3) A key `checkFormat` rejects shows its message, saves nothing, 0 requests. (4) Set active and delete (with `y`) make no request. (5) With `spyOn(gateway, "refreshModels")`: 0 calls until `r`, then exactly 1 call with that provider id. (6) With the provider's env var set, the row says `key from <ENVVAR>` and no frame contains the value. (7) The list equals `PROVIDERS` minus `fake`.

## Done when

- [ ] From `app/`: `..\.bun\bin\bun.exe test test/interface` passes on Rishi's PC, and `bun test` passes on macOS, Windows and Linux in CI. The `subcalls.test.tsx` fan-out and `approval.test.tsx` keyboard cases are in the run.
- [x] `providers-nonetwork.test.tsx` passes: saving a key through the screen makes 0 requests.
- [ ] CI's compiled-binary job (step 2) still builds on all three OSes, and `rlmh --version` still prints.
- [ ] On Rishi's PC, in Windows Terminal, the demo run (task 11) shows: 20 rows streaming, then collapsing to one line; an approval answered with `y`; Esc cancelling a repeat of the same question while it streams; at 80x24 and 120x30 no flicker, no clipped line and no broken border; `/providers` paste with Ctrl+Shift+V never shows the key; `/context` and `/runs` open. In a Windows PowerShell console window it shows the ASCII fallback with no missing-glyph boxes. Rishi says he is happy with it.
- [ ] progress.md row 7 is `review` (`done` after Rishi's yes).

## Out of scope

- Follow-up questions inside a run and compaction (S-11; v1). Each question is a fresh run.
- Nested `rlm()` sub-agent views (v1). Web UI, themes, mouse support and multi-line input (v2).
- Showing engine stderr while the app runs. Showing a run's raw `messages` in `/runs`.
- Any change to the engine, gateway, protocol or `rlmh run` (steps 2 to 6). The installer and first-run setup (step 10).

## Hand-off

- Step 9 can watch a run on screen while `rlmh batch` is the thing it measures. Step 10's compiled binary must open this app; its smoke run can reuse `demo-script.json`.
- The private files (`store.ts`, `format.ts`, `mentions.ts`, `approvals.ts`, `runs.ts`, `commands/index.ts`) are not shared interfaces; nothing outside `interface/` and `main.ts` imports them.
- Write in progress.md: the Ink, React and `ink-testing-library` versions.

## If a decision goes the other way

Every decision below was settled at step 1 (2026-10-30; [decisions.md](../decisions.md) S-22 to S-34). Each line names the pick and says what would change if Rishi reversed it. Picks that went the alternative way are already written into this spec.

- **2a, OpenTUI** (settled: Ink, S-23). Rewrite the `.tsx` files and `helpers.ts` (use OpenTUI's React binding and test renderer); `store.ts`, `format.ts`, `mentions.ts`, `approvals.ts`, `runs.ts`, the fake engine and the test cases stay as they are. Task 2 changes to OpenTUI's dependencies, and task 9 adds a check that its native library is bundled by `bun build --compile` on each OS. Re-check Windows Terminal and the key table (Esc and backspace handling differ).
- **5a, fewer providers** (settled: all seven, S-28). No code change: `/providers` and the nonetwork test follow `PROVIDERS`. `/model` offers only the remaining providers.
- **6c, always ask which mode** (settled: `@path` means read mode, S-31). Submit opens a two-choice chooser ("read these files" / "work on this folder") before every run. `@path` mentions only pre-select the first choice; read mode with no mention asks for a file. `parseQuestion` keeps its mention handling but no longer decides the mode. Rewrite `app.test.tsx` cases 2 to 4 and add chooser cases.
