# Step 3. Contract: prompt v4, hash test, both call formats

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0 |
| **Depends on** | 2 |
| **Unblocks** | 4, and through it 6 and 8 |
| **Parallel with** | 5 |
| **Decisions it uses** | 3a: keep `/work/repo` in the text (default). 6b: native for API models, fenced for the LoRA and local models (default). 4a: Git Bash, else PowerShell (only as the `{shell}` word in the guidance). S-13, S-14, D-04, D-08, D-09, D-16, D-31, D-32, D-34 |

## Goal

The engine holds an exact copy of training's prompt v4 and a test that proves it: `sha256` of the v4 texts equals `a71401e2…8b1d6` (S-14). It can turn a model reply into code and the observation into the next message, in fenced and native format alike. It loads the two built-in profiles, and `training-v4` hashes to the training value. Steps 4, 6 and 8 are written against these exact strings.

## Read first

- [../architecture.md §7.6](../architecture.md#76-step-3--4-6-8-contract-call-format-profiles) (the signatures), [§6.2](../architecture.md#62-the-python-tool-callformatpython_tool) (the tool and where the observation goes), [§5.1](../architecture.md#51-app--engine) (`engine.info`), [§12](../architecture.md#12-conventions) (copy and cache-note rules).
- [../decisions.md](../decisions.md): D-04, D-08, D-09, D-16, D-31, D-32, D-34, and open decisions 3a and 6b.
- [../../v0-design.md](../../v0-design.md#the-frozen-contract-contractpy) § The frozen contract, § Call formats, § Profiles, and [../../v0-build-plan.md](../../v0-build-plan.md#step-3-contract-prompt-v4-hash-test-both-call-formats) § Step 3.
- Training: `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/bridge.py` (read all of it; the copy map below names the parts) and `0b9af69:rlm_rl/env.py` (`_CODE_RE`, `_TOOL_CALL_CODE_RE`, `extract_code`). Samples: `0b9af69:tests/test_env.py` (`test_extract_code_shapes`), `tests/test_bridge.py` (`test_observation`, `test_first_user_message`, `test_edit_first_message`, `test_cell_messages_quote_the_limit`, `test_truncate_prompt`, `test_valid_answer`), `tests/test_edit_env.py` (`test_pace_message`). All are synthetic one-liners with no task data.

## Starting state

Step 2 is `done`: `uv run --project engine pytest engine/tests` passes on all three OSes. `engine/rlm_engine/` has `__init__.py`, `__main__.py`, `errors.py`, `link.py`, `appport.py` and `service.py`, whose `engine.info` returns `contract: null`, `contract_hash: null`, `training_hash: null` and `profiles: []`. `engine/tests/` holds `test_link.py`, `test_protocol.py` and `fakeapp.py`. `engine/pyproject.toml` requires Python 3.12 with pytest as the dev group. `contract.py`, `callformat.py`, `profiles.py` and `profiles/` do not exist.

## Deliverables

### `engine/rlm_engine/contract.py`

The only place the model's bytes are defined. Docstring: source file and commit `0b9af69`, then the cache note `KV cache: defines every byte of the system prompt, first message, observations and errors; all are pure functions of their arguments, so a run's prefix never changes.` Standard library only. Public names are the §7.6 list plus these copied helpers: `API_NAMES`, `EDIT_REPO_PATH`, `OUTPUT_MAX_CHARS`, `TRACEBACK_LINES`, `SUBMIT_MAX_BYTES`, `SUBCALL_MAX_CHARS`, `SUBCALL_TRUNCATION_MARK`, `truncate_prompt`, `PACE_TEST_AT`, `OBS_PACE_EDIT`, `OBS_PACE_TEST`, and the `OBS_*`, `NO_CODE_BLOCK_ERROR_V3` and cell-message constants. No v1 to v3 text and no `system_prompt()` or `initial_messages()`.

Copy map (lines of `git show 0b9af69:rlm_rl/bridge.py`). Copy the text character for character, comments included where they explain a number:

| Lines | Copy | Change |
|---|---|---|
| 39, 44-46, 51, 53-54, 57 | `API_NAMES`, `MAX_TURNS`, `MAX_SUBCALLS`, `ROOT_MAX_TOKENS`, `OUTPUT_MAX_CHARS`, `TRACEBACK_LINES`, `CELL_TIMEOUT_S`, `EDIT_REPO_PATH` | none |
| 60-90, 92-98 | `Limits` (all 13 fields in order, with defaults: `cpus`, `memory_mb`, `pids`, `grader_timeout_s` and the four `subcall_*` fields included; `as_dict()`), `READ_LIMITS`, `EDIT_LIMITS`, `READ_LIMITS_V4`, `EDIT_LIMITS_V4` (`subcall_thinking="low"`) | none. Skip `EDIT_MAX_TURNS_V3` |
| 118-119, 126 | `SUBCALL_MAX_CHARS`, `SUBCALL_TRUNCATION_MARK`, `SUBMIT_MAX_BYTES` | none |
| 130-153 | `SYSTEM_PROMPT` (the v2 text) | renamed `_SYSTEM_PROMPT_V2`, the one rename, so the loop cannot pick the wrong prompt |
| 155-167 | `FIRST_USER_TEMPLATE`, `EDIT_FIRST_USER_TEMPLATE` | none |
| 169-174, 177-179, 183-192 | `OBS_OUTPUT` … `OBS_LAST_TURN`, `NO_CODE_BLOCK_ERROR_V3`, `CELL_TIMEOUT_TEMPLATE`, `CELL_CRASH_TEMPLATE` (keep the doubled `{{reason}}`), `EDIT_FILES_UNCHANGED`, `CELL_NOT_RUN` | leave out `NO_CODE_BLOCK_ERROR` (line 175) |
| 224-248 | `SYSTEM_PROMPT_V4`: the `.replace` chain and the `assert` | built on `_SYSTEM_PROMPT_V2`; verbatim |
| 250-251, 264-268 | `_OBSERVATION` and `PROMPTS["v4"]` | `_OBSERVATION` holds `NO_CODE_BLOCK_ERROR_V3` in 7th place, so no swap is needed; the result is `PROMPTS_V4`. Keep the key order system, first_user, observation, code, limits |
| 270 | the hash line | `prompt_hash(texts)` = `hashlib.sha256(json.dumps(texts, sort_keys=True).encode()).hexdigest()`; no other options (`ensure_ascii` stays default) |
| 285-301, 319-340 | `first_user_message`, `edit_first_message`, `CellMessages`, `cell_messages`, `no_code_error` | v4 only: no `version` argument; `limits` required; `no_code_error()` returns `NO_CODE_BLOCK_ERROR_V3`; `cell_messages(limits, edit)` returns `CellMessages(CELL_TIMEOUT_TEMPLATE.format(cell_timeout_s=…) + tail, CELL_CRASH_TEMPLATE.format() + tail)`, so `crash` still holds `{reason}` for the worker manager to fill |
| 343-377 | `OBS_PACE_EDIT`, `OBS_PACE_TEST`, `PACE_TEST_AT`, `pace_message`, `observation` | `max_chars` required |
| 380-408 | `truncate_prompt`, `oversize_message`, `budget_exhausted_message`, `clean_text`, `valid_answer` | `budget_exhausted_message(max_subcalls)` has no default |
| `env.py` 43-65 | `_CODE_RE`, `_TOOL_CALL_CODE_RE`, `extract_code` | `tool_calls` defaults to `True` (training's default was `False`; prompt v4 always passed `True`) |

Add `CONTRACT_VERSION = "v4"` and `TRAINING_HASH` (the S-14 value, written out). Leave out the socket bridge, `InfraError`, `SubcallError` (step 2's `errors.py` has them), `limits()`, `is_edit()`, `PROMPT_HASHES` and everything else for v1 to v3. The temperatures (`SUBCALL_TEMPERATURE`) move to `profile.toml`.

### `engine/rlm_engine/callformat.py`

Cache note: `KV cache: none; it only picks which fields of a reply become code and message, and never edits text.` Imports `contract`.

| Name | Behaviour |
|---|---|
| `FENCED`, `NATIVE`, `PYTHON_TOOL` | `PYTHON_TOOL` is the §6.2 dict with the same key order. Its compact JSON (`separators=(",", ":")`) is the one line in the test below |
| `tools_for(fmt)` | `[]` for fenced, `[copy.deepcopy(PYTHON_TOOL)]` for native. Anything else raises `ValueError("unknown call format 'x'")` |
| `code_from_reply(fmt, result)` | Native: if `result["tool_call"]` is a dict named `python` whose `arguments` is a dict with a string `code`, return that string (even `""`). Otherwise, and always in fenced, return `contract.extract_code(result.get("text"), tool_calls=True)`. A fenced reply that carries a `tool_call` anyway has it ignored. `arguments` given as a JSON string counts as unusable (the gateway parses it) |
| `assistant_message(fmt, result)` | `{"role": "assistant", "content": result.get("text") or ""}`, plus `"tool_call": {"id", "name", "arguments"}` (a copy of those three keys) when the format is native and the reply has a tool call, whatever its name. Never reads `reasoning` and never cleans the text (training stored the reply as is). `content` must stay byte-equal to `result["text"]`: the gateway keys its reasoning replay (D-33) on it |
| `observation_message(assistant, text)` | `{"role": "tool", "tool_call_id": assistant["tool_call"]["id"], "content": text}` when the assistant message has a tool call, else `{"role": "user", "content": text}` |

### `engine/rlm_engine/profiles.py`

Cache note: `KV cache: builds the system prompt and limits from files; a profile is read once per run and its text is fixed from then on.` Standard library (`tomllib`, `hashlib`, `dataclasses`, `re`, `sys`, `pathlib`). The classes, fields and signatures are the §7.6 ones, plus `class ProfileError(ValueError)` and `class UnknownProfile(ProfileError)`.

- **Where.** Built-ins are `Path(__file__).resolve().parent / "profiles" / <name>`, user profiles `<home>/profiles/<name>`. A name must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; any other name raises `UnknownProfile` before any file is touched.
- **Reading files.** Read bytes, replace `\r\n` with `\n`, then decode UTF-8, so a Windows checkout with CRLF hashes and prompts the same as Linux. Never `read_text()` without `encoding`.
- **`profile.toml`** keys (anything else is a `ProfileError` naming the profile and the key): `contract` (required, must be `"v4"`), `guidance` (a file name inside the profile folder, or `""`; no absolute path, no `..`; the file must exist), `[root] temperature` (default 1.0), `[sub] temperature` (default 0.3), and `[read]` and `[repo]` tables. A mode table may hold any `Limits` field name, plus `pace_nudge` in `[repo]` only (default false). It starts from `READ_LIMITS_V4` or `EDIT_LIMITS_V4` and replaces only the keys it lists, via `dataclasses.replace` (D-09). Types: integer fields must be real ints (not bool or float), at least 1 (`max_subcalls` may be 0); `cpus` takes an int or float and is stored as `float`; `subcall_thinking` is `off`, `low`, `medium` or `high` (`off` is TOML's way to say none); `subcall_oversize` is `truncate` or `error`; temperatures are numbers from 0 to 2.
- **`guidance`** is the file text with leading and trailing whitespace stripped; empty means none.
- **`system_prompt(shell_name="sh")`** is `SYSTEM_PROMPT_V4`, then if there is guidance `"\n\n"` and the guidance with every `{shell}` replaced by `shell_name` (`str.replace`, so other braces stay as they are).
- **`prompt_hash()`** is `contract.prompt_hash` over `dict(PROMPTS_V4)` with `system` set to the system prompt with `{shell}` left unfilled and `limits` set to `json.dumps({"read": read.limits.as_dict(), "edit": repo.limits.as_dict()}, sort_keys=True)`. Leaving `{shell}` unfilled makes the hash the same on every machine; the run log's `messages` holds the filled text.
- **`profile_hash()`** is `sha256(toml_bytes + b"\x00" + guidance_bytes)` over the normalised bytes (`b""` when there is no guidance). It re-reads the files from `path` on each call.
- **`list_profiles(home)`** returns built-ins sorted by name, then user profiles sorted by name. A user profile named like a built-in is dropped. A user profile that fails to load is skipped. Both cases print one warning per process to **stderr** (stdout carries only the protocol; D-34).
- **`load_profile(name, home)`** returns the built-in if there is one (with the same warning when a user folder shadows it), else the user profile, else raises `UnknownProfile`. A profile that fails to parse raises `ProfileError`.

### `engine/rlm_engine/profiles/training-v4/profile.toml`

```toml
contract = "v4"
guidance = ""                 # empty keeps the prompt identical to training

[root]
temperature = 1.0
[sub]
temperature = 0.3

[read]                        # = contract.READ_LIMITS_V4
max_turns = 20
max_subcalls = 80
root_max_tokens = 4096
output_max_chars = 8000
cell_timeout_s = 120
subcall_max_chars = 60000
subcall_max_tokens = 4096
subcall_oversize = "error"

[repo]                        # = contract.EDIT_LIMITS_V4
max_turns = 30
max_subcalls = 80
root_max_tokens = 4096
output_max_chars = 8000
cell_timeout_s = 300
subcall_max_chars = 60000
subcall_max_tokens = 4096
subcall_thinking = "low"
subcall_oversize = "error"
pace_nudge = true             # training's prod-v2 runs and evaluations used the pacing line
```

### `engine/rlm_engine/profiles/default/profile.toml` and `guidance.md`

`profile.toml` is the file above with line 2 changed to `guidance = "guidance.md"`; nothing else differs. `guidance.md` (UTF-8, no BOM, ends with a newline). `fetch` is in the REPL in both modes, and `shell` only in coding tasks (D-16), so the bullets say which applies where:

```
Notes for this machine:
- Despite "There is no network." above, the REPL has `fetch(url) -> str` in every task. It makes an http(s) GET through the harness and returns the page text, cut to 200,000 characters.
- The first fetch to each host asks the user for approval. If it is refused or fails, the call raises an error in your cell.
- A fetch does not count as a sub-call. Read what you fetch with code, or hand it to sub-calls; do not print whole pages.
- In coding tasks, `shell(cmd, timeout=120)` runs `{shell}` on this machine, so write commands for {shell}.
- Writes and shell commands may also need the user's approval. A refusal raises PermissionError; try another way.
```

### `engine/rlm_engine/service.py` (edit)

Add the private `contract_info(home: Path) -> dict` returning `{"contract": CONTRACT_VERSION, "contract_hash": contract.prompt_hash(contract.PROMPTS_V4), "training_hash": contract.TRAINING_HASH, "profiles": [{"name", "source", "prompt_hash", "profile_hash"} for each list_profiles(home)]}`, and merge it into the `engine.info` result. `home` is step 2's `Engine.home` (architecture.md §7.1, D-49).

### Tests: `engine/tests/test_contract.py`, `test_callformat.py`, `test_profiles.py`, `engine/tests/fixtures/extract_cases.json`

Described under Tests.

## Tasks

1. [ ] Set row 3 in progress.md to `in progress`. Check step 2 is `done` and `uv run --project engine pytest engine/tests` passes. Grep step 2's tests (`app/test/engine.test.ts`, `engine/tests/test_protocol.py`) for assertions that `contract` is null or `profiles` is `[]`, and change them to the new values.
2. [ ] Save the training sources outside the repo, in a scratch folder: `git -C F:\Personal\RLM\RLM cat-file blob 0b9af69:rlm_rl/bridge.py > <scratch>\bridge_ref.py`, the same for `env.py`. Run this in Git Bash: Windows PowerShell 5.1's `>` writes UTF-16 and breaks the file. Never write into `F:\Personal\RLM\RLM`.
3. [ ] Write `contract.py` from the copy map. Check at once: `uv run --project engine python -c "from rlm_engine import contract as c; print(c.prompt_hash(c.PROMPTS_V4) == c.TRAINING_HASH)"` prints `True`. A CRLF source file is harmless (Python reads string literals with `\n`); a changed character is not, and the hash catches it.
4. [ ] Write `fixtures/extract_cases.json` and `test_contract.py`. Produce each expected string by running the training function from the scratch copy (import it with `importlib.util.spec_from_file_location`, registering it in `sys.modules` first or `@dataclass` fails), then paste the literal into the test. Do not type expected strings by hand.
5. [ ] Write `callformat.py` and `test_callformat.py`.
6. [ ] Write `profiles.py`, the two `profile.toml` files, `guidance.md`, `test_profiles.py`.
7. [ ] Edit `service.py` for `engine.info`. Run `uv run --project engine python -c "import json, pathlib; from rlm_engine import service; print(json.dumps(service.contract_info(pathlib.Path('tmp-home')), indent=1))"`; it shows two profiles and equal hashes.
8. [ ] Run `uv run --project engine pytest engine/tests -q`, then again with `RLM_TRAINING_REPO` set (PowerShell: `$env:RLM_TRAINING_REPO = 'F:\Personal\RLM\RLM'`), and `uv run --project engine python -I -c "import rlm_engine.contract, rlm_engine.callformat, rlm_engine.profiles"` (no third-party import).
9. [ ] Update progress.md (see Hand-off). Do not commit.

## Tests

### `test_contract.py`

| Case | Asserts |
|---|---|
| `test_hash_matches_training` | `prompt_hash(PROMPTS_V4) == TRAINING_HASH == "a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6"` (the literal is written in the test, so editing the constant alone fails) |
| `test_prompts_v4_shape` | keys in order `system, first_user, observation, code, limits`; `code == "```python blocks, and <function=python> tool-call blocks"`; `limits` equals `json.dumps({"read": …, "edit": …}, sort_keys=True)` |
| `test_hash_covers_every_text` | appending a space to any one value changes the hash |
| `test_limits` | `Limits` field names in order are `max_turns, max_subcalls, root_max_tokens, output_max_chars, cell_timeout_s, cpus, memory_mb, pids, grader_timeout_s, subcall_max_chars, subcall_max_tokens, subcall_thinking, subcall_oversize`; `json.dumps(READ_LIMITS_V4.as_dict(), sort_keys=True)` and the `EDIT` one equal the two literals produced from training; `cpus` is `1.0` and `2.0`, floats |
| `test_system_prompt_v4` | length 3,076; ends `There is no network.`; `orchestrator` once; contains `interfaces first`, `60,000`; every `API_NAMES` entry appears as `` `name ``; no `llm_query`; `_SYSTEM_PROMPT_V2` is not equal to it |
| `test_messages` | literals from training for: `first_user_message("How many?", "a,b\nline 2\nline 3\nline 4", READ_LIMITS_V4)` (ends `You have at most 20 turns and 80 sub-calls.`); `edit_first_message("Fix the parser.", language="go", n_files=41, test_hint="go test ./...", limits=EDIT_LIMITS_V4)` (contains `/work/repo (go, 41 files)`, `30 turns and 80 sub-calls`, `300 seconds`); `cell_messages` read and edit (edit texts end `Your files in /work/repo are unchanged.`, read texts never mention `/work/repo`, `crash.format(reason="exit code 1")` fills the field, `not_run == " This cell was not run."`); `no_code_error()`; `oversize_message(72000, 60000)`; `budget_exhausted_message(80) == "sub-call budget exhausted (80 total)"` |
| `test_observation` | `("", 0, None, 5, 30, 8000)` gives `REPL output: (nothing printed)\n(5 turns left, 30 sub-calls left)`; `("hi\n", 3, "NameError: x", 1, 2, 8000)` gives the error block then the counters then the last-turn line; `("x"*10, 25, None, 3, 30, 8000)` has `[... 15 more characters truncated]`; with `max_chars=2000` and 9,000 printed, `[... 7000 more characters truncated]`; a `pace` line appears when `turns_left > 1` and is dropped at 1 |
| `test_pace_message` | `(16,30,False)` None; `(15,30,False)` is `OBS_PACE_EDIT`; `(15,30,True)` None; `(5,30,True)` is `"5 turns left: run the tests, fix what fails, and call submit()."`; `(4,30,True)` None |
| `test_small_helpers` | `truncate_prompt("x"*24001)` is 24,000 x's plus `"\n[prompt truncated]"`, and 24,000 is untouched; `clean_text("a\ud800b") == "a?b"`; `valid_answer` true for `3, 2.5, "host-7", [], [1, "a", 2.0]` and false for `None, True, {"a": 1}, [[1]], [None], [False]` |
| `test_extract_code_matches_training` | every case in `fixtures/extract_cases.json` (below) |
| `test_against_training_source` | skipped unless `RLM_TRAINING_REPO` is set. It reads `bridge.py` and `env.py` with `git -C $RLM_TRAINING_REPO show 0b9af69:rlm_rl/<file>` (decode as UTF-8 explicitly), loads `bridge` with `importlib`, and pulls the two regexes and `extract_code` out of `env.py` with `ast` (env.py itself needs `openai`). Then `PROMPTS_V4 == bridge.PROMPTS["v4"]`, the hash equals `bridge.PROMPT_HASHES["v4"]`, both limits match, and every fixture case and the observation samples agree |

`extract_cases.json` is a list of `{"name", "text", "tool_calls", "expected"}` (`expected` null for none). Cases marked † are copied from `test_extract_code_shapes`; the rest are written for this step. The strings contain no task data.

```
fenced            "Look first.\n```python\nprint(len(context))\n```"                      -> "print(len(context))\n"
fenced_py         "```py\nz = 1\n```"                                                     -> "z = 1\n"
fenced_bare       "```\nplain = 1\n```"                                                   -> "plain = 1\n"
fenced_empty      "```python\n```"                                                        -> ""
fenced_first      "```python\nx = 1\n```\n```python\ny = 2\n```"                           -> "x = 1\n"
fenced_unclosed   "```python\nprint('a')"                                                 -> null
fenced_python3    "```python3\nx\n```"                                                    -> null
fenced_crlf       "Plan.\n```python\r\nprint(1)\r\n```"                                   -> "print(1)\r\n"
tool_call †       "<tool_call>\n<function=python>\nprint(1)\n</function>\n</tool_call>"    -> "print(1)\n"  (tool_calls=false -> null)
tool_parameter †  "<function=python>\n<parameter=code>\nx = 2\n</parameter>\n</function>"  -> "x = 2\n"
tool_unclosed †   "<tool_call>\n<function=python>\nprint(3)\n"                             -> "print(3)\n"
tool_other †      "<tool_call>\nfunction\n</function>\n</tool_call>"                       -> null
tool_blank †      "<tool_call>\n<function=python>\n   \n</function>"                       -> null
fence_beats_tool † "```python\na = 1\n```\n<function=python>\nb = 2\n"                     -> "a = 1\n"
no_code           "I will look at it next."  ;  ""  ;  null (as the text)                 -> null
```

### `test_callformat.py`

| Case | Asserts |
|---|---|
| `test_python_tool_byte_for_byte` | `json.dumps(PYTHON_TOOL, separators=(",", ":"))` equals `{"name":"python","description":"Run one cell of Python in the persistent REPL. Variables persist between calls. The result is what the cell printed, followed by your remaining turns and sub-calls.","parameters":{"type":"object","properties":{"code":{"type":"string","description":"The Python code to run."}},"required":["code"],"additionalProperties":false}}`, and its sha256 is `3d3c2513de47f59b70b24fae749af49f15543e61aa2f80d01f048286e09a84ab` |
| `test_tools_for` | `[]` for fenced; for native one tool equal to `PYTHON_TOOL` but not the same object (editing it leaves `PYTHON_TOOL` alone); `ValueError` for `"x"` |
| `test_three_formats_same_code` | the fenced reply, the `<function=python>` reply in plain text (fenced format), and a native result with `tool_call` `python` and `{"code": …}` all give `"print(len(context))\n"` |
| `test_function_tag_in_native_text` | native format, `tool_call: None`, text holds `<function=python>`: same code (D-31) |
| `test_native_call_wins_over_text` | a result with both a `python` call and a fenced block returns the call's code |
| `test_native_falls_back` | call named `bash`; `arguments` without `code`; `code: 5`; `arguments` a string: each falls back to the text, and gives `None` when the text has no code |
| `test_fenced_ignores_tool_call` | fenced format, result carries a `tool_call`: the code comes from the text, and `assistant_message` has only `role` and `content` |
| `test_observation_message` | assistant with `tool_call` id `call_1` gives `{"role": "tool", "tool_call_id": "call_1", "content": …}`, even when that call carried no usable code; assistant without one gives the user message |
| `test_assistant_message` | keys are `role, content` or `role, content, tool_call` (with `id, name, arguments`); a result with `reasoning: "SECRET-THOUGHT"` leaves it out of `json.dumps(message)`; `text: None` gives `""`; the tool call is a copy (changing the message's `arguments` leaves the result alone) |
| `test_conversation_shape` | two turns in each format with `contract.observation(...)` as the text: roles run `system, user, assistant, user, assistant` in fenced, and `system, user, assistant, tool, assistant` in native |

### `test_profiles.py`

All use `tmp_path` as `home`.

| Case | Asserts |
|---|---|
| `test_builtins_listed` | `list_profiles` gives `default`, then `training-v4`, source `builtin`, 64-hex hashes (sorted by name, so `default` first) |
| `test_training_v4_is_training` | `prompt_hash() == contract.TRAINING_HASH`; `read.limits == READ_LIMITS_V4`; `repo.limits == EDIT_LIMITS_V4` (so `subcall_thinking == "low"`); `repo.pace_nudge` true, `read.pace_nudge` false; temperatures 1.0 and 0.3; `guidance == ""`; `system_prompt() == SYSTEM_PROMPT_V4` |
| `test_default_differs_only_by_guidance` | same `read`, `repo`, temperatures as `training-v4`; `system_prompt("sh") == training.system_prompt("sh") + "\n\n" + guidance.replace("{shell}", "sh")`; `prompt_hash` differs; `contract.prompt_hash` over `PROMPTS_V4` with the default's own `limits` JSON gives `TRAINING_HASH`; `system_prompt("Git Bash")` contains `Git Bash` and no `{shell}`; the hash is the same whatever shell name was used earlier |
| `test_default_guidance_text` | at most 12 lines; contains `fetch(url) -> str`, `200,000` and `{shell}`; no CRLF |
| `test_profile_hash` | stable across calls; changes with one byte of `profile.toml` or of `guidance.md`; the same profile written with CRLF line endings has the same `profile_hash` and `system_prompt` |
| `test_user_profile` | `<home>/profiles/mine/profile.toml` with `contract = "v4"` and `[read] max_turns = 7`: source `user`, `read.limits.max_turns == 7`, `memory_mb == 512`, `pids == 64`; `cpus = 2` is stored as `2.0`; `prompt_hash` differs from `TRAINING_HASH` |
| `test_toml_errors` | each raises `ProfileError` whose text names the profile and the key: unknown top-level key; unknown key in `[read]`; `max_turns = "20"`, `true`, `20.0`, `0`; `contract = "v3"` or missing; `pace_nudge` in `[read]`; `subcall_oversize = "cut"`; `guidance = "../x"`, an absolute path, a missing file; invalid TOML; guidance that is not UTF-8 |
| `test_builtin_wins` | a user folder `training-v4` with other limits is ignored: `load_profile` returns the built-in, `list_profiles` has one `training-v4`, stderr (`capsys`) holds one warning |
| `test_unknown_and_unsafe_names` | `UnknownProfile` for `nope`, `""`, `../x`, `a/b`, `a\b`, `.hidden`; nothing outside `home` is opened |
| `test_broken_user_profile` | `list_profiles` skips it with a stderr warning and still lists the others; `load_profile` raises `ProfileError`, not `UnknownProfile` |
| `test_mode` | `mode("read")` and `mode("repo")` return `read` and `repo`; `mode("x")` raises `ValueError` |
| `test_contract_info` | `service.contract_info(tmp_path)`: `contract == "v4"`, `contract_hash == training_hash == TRAINING_HASH`; each profile entry has exactly `name, source, prompt_hash, profile_hash`; the `training-v4` entry's `prompt_hash` equals `training_hash` |

## Done when

- [ ] `uv run --project engine pytest engine/tests/test_contract.py -q` passes, including `test_hash_matches_training` and `test_extract_code_matches_training`.
- [ ] With `RLM_TRAINING_REPO=F:\Personal\RLM\RLM`, `test_against_training_source` runs and passes on Rishi's PC (it is skipped elsewhere).
- [ ] `uv run --project engine pytest engine/tests/test_callformat.py -q` passes: fenced, `<function=python>` and native give the same code, and the observation goes back as a tool message after a tool call and as a user message otherwise.
- [ ] `uv run --project engine pytest engine/tests/test_profiles.py -q` passes: `training-v4` hashes to `TRAINING_HASH`, and `test_default_differs_only_by_guidance` shows the default prompt is training's plus its guidance block and nothing else.
- [ ] `service.contract_info(...)` (task 7) prints `contract` `v4`, equal `contract_hash` and `training_hash`, and both built-in profiles. `rlmh info` shows the same fields (step 2's command).
- [ ] `uv run --project engine pytest engine/tests -q` passes on Windows 11 on Rishi's PC, and in CI on macOS, Windows and Linux once Rishi pushes.
- [ ] `git status --short` in `rlm-harness` lists only the Deliverables paths, the step 2 tests edited in task 1 and progress.md; nothing outside `rlm-harness/` changed.

## Out of scope

- The loop, the `run.started` event and sampling settings: step 6. The loop also copies `env._cap_output` (stdout cut to the cap, error to twice the cap), which lives in `env.py`, not `bridge.py`.
- `inputs.py` (context, language, test-hint detection): step 6. The worker, the tools, `fetch` itself, `ShellSpec` and the `/work/repo` mapping: step 4. Training's `ToolsInPromptTest` (the prompt's tool signatures against the real tools) goes in step 4's `test_tools.py`.
- Choosing `fenced` or `native` per model: step 5 (`resolveCallFormat`) and step 6.
- The parity replay: step 8. Prompt text for v1 to v3: never.

## Hand-off

- **Step 4** imports `contract.Limits`, `CellMessages`, `cell_messages`, `truncate_prompt`, `OUTPUT_MAX_CHARS`, `TRACEBACK_LINES`, `SUBMIT_MAX_BYTES`, `SUBCALL_TRUNCATION_MARK`, `API_NAMES`, `EDIT_REPO_PATH`. `CellMessages.crash` still contains `{reason}`; the manager calls `.format(reason=…)`.
- **Step 6** builds messages as `[system, user]` with `profile.system_prompt(shell.name)` and `contract.first_user_message` or `edit_first_message`. It takes limits from `profile.mode(mode).limits` and passes `max_chars=limits.output_max_chars`. The pacing line is `contract.pace_message(...)` only in repo mode with `profile.repo.pace_nudge`. It resolves sub-call thinking as D-08 says, from `profile.mode(mode).limits.subcall_thinking` (`low` in `training-v4` repo mode, none in read mode, so `off`). It uses `callformat` for tools, code and messages, and maps `UnknownProfile` to -32011.
- **Step 8** checks `training-v4`'s `prompt_hash()` equals `TRAINING_HASH` and compares messages against recorded episodes.
- **progress.md:** row 3 `done`, the date, and one log line: hash matched `a71401e2…`; profile hash covers LF-normalised `profile.toml`, a NUL byte and `guidance.md`; `prompt_hash` leaves `{shell}` unfilled; any `Engine.home` change; any step 2 test edited.

## If a decision goes the other way

- **3a (show the real path):** the repo-mode texts take the real workspace path, so `EDIT_FIRST_USER_TEMPLATE`, `EDIT_FILES_UNCHANGED` and with them `PROMPTS_V4` change for such runs and `training-v4` no longer hashes to `TRAINING_HASH`. Keep the frozen texts in `contract.py` and `test_hash_matches_training` on them. Add a `repo_path` argument to `edit_first_message` and `cell_messages`. Move the profile-level hash assertion (`test_training_v4_is_training`) to a separate profile that still renders `/work/repo`, which parity and the RLM evaluations use. The default profile then differs from that profile by more than its guidance, so `test_default_differs_only_by_guidance` compares only the system prompt.
- **6b (fenced everywhere):** nothing changes here. `callformat` keeps the native path and its tests; only step 5's `resolveCallFormat` stops selecting it.
- **4a (always PowerShell, or require Git Bash):** nothing changes here. `{shell}` is filled from step 4's `ShellSpec.name`, so the guidance reads the same.
