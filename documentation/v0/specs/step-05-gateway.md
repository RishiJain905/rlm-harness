# Step 5. Model gateway: providers, keys, catalog, clients, caching, cost

| | |
|---|---|
| **Type** | PC |
| **Cost** | $0: every test uses a fake HTTP server or the scripted fake provider |
| **Depends on** | 2 |
| **Unblocks** | 6 (with 4), 7 |
| **Parallel with** | 3, 4 |
| **Decisions it uses** | 5a all seven providers; 5b `Bun.secrets` with the owner-only file fallback; 5c a subset of OMP's catalog; 6b `auto` gives native for API models whose entry has `tool_call`. S-06, S-08; D-04, D-05, D-08, D-20 to D-25, D-33, D-38, D-39 |

## Goal

When this step is done, `Gateway.complete` takes a `model.complete` request, makes a streamed call to any provider in 5a, and returns the text, at most one tool call, usage and cost, or a `ModelError` with a plain message. Keys, the bundled catalog, cache markers, retries, per-provider caps and the scripted fake provider are in place, and every test runs offline. Steps 6 and 7 use it through `session.ts` and the bus and never see an SDK. The gateway only delivers: it never changes what the model reads.

## Read first

- [../architecture.md §4](../architecture.md#4-shared-types), [§5.2](../architecture.md#52-engine--app), [§5.4](../architecture.md#54-one-run-in-order), [§7.3](../architecture.md#73-step-5--6-7-the-gateway-and-the-bus), [§7.4](../architecture.md#74-call-format-resolution-d-07), [§7.5](../architecture.md#75-the-fake-provider-gatewayfakets), [§8](../architecture.md#8-settings-schema-settingsts), [§9](../architecture.md#9-folders-at-run-time-pathsts-decision-2b), [§11](../architecture.md#11-tests-and-who-writes-them).
- [../decisions.md](../decisions.md): S-06, S-08, D-04 to D-06, D-08, D-20 to D-25, D-33, D-38, D-39.
- [../../legacy/v0-design.md § Model gateway](../../legacy/v0-design.md#model-gateway), [../../legacy/architecture.md § Keys and providers and § Caching](../../legacy/architecture.md#keys-and-providers), [../../legacy/v0-build-plan.md § Step 5](../../legacy/v0-build-plan.md#step-5-model-gateway-providers-keys-catalog-clients-caching-cost).
- Training, for the retry and cap behaviour only: `git -C F:\Personal\RLM\RLM show 0b9af69:rlm_rl/client.py`. Read `RetryPolicy.delay`, `ModelClient._request` (408, 409, 429 and 5xx retry; `SUBCALL_REJECT_STATUSES` 400, 413, 422), `Limiter.slot` (a request gives up its slot while it sleeps), `reasoning_text` (reads `reasoning` and `reasoning_content`), `Usage.cost_usd`, and how `subcaller` builds `chat_template_kwargs`. v0 differs: D-23 says 6 retries from 2 s, not 12 from 4 s.
- Facts checked on 2026-10-28 (re-check each one marked "verify at build"): Bun secrets docs (bun.com/docs/runtime/secrets); Anthropic prompt caching, extended thinking, thinking-troubleshooting and effort pages (platform.claude.com/docs/en/build-with-claude/); OpenRouter prompt caching and reasoning-tokens pages; DeepSeek thinking-mode and KV-cache guides (api-docs.deepseek.com); Gemini OpenAI compatibility (ai.google.dev/gemini-api/docs/openai); OpenAI reasoning guide; OMP's `packages/catalog` (`README.md`, `src/types.ts`, `LICENSE`).

## Starting state

- Step 2 is done: `link.ts` (`Link`, `RpcError`), `bus.ts`, `settings.ts` (schema, `getSetting`), `paths.ts` (`home()`), `protocol.ts` (§4 types; `ModelCompleteParams` and `ModelCompleteResult` are the §5.2 shapes, so add them there if step 2 left them out and say so in progress.md), and CI running `bun test` on three OSes.
- Nothing exists in `app/src/gateway/`, `app/catalog/` or `app/test/gateway/`. Bun 1.4.4 is at `F:\Personal\RLM\rlm-harness\.bun\bin\bun.exe`.
- Steps 3 and 4 run at the same time: touch nothing under `engine/`. No real key is needed or allowed anywhere in this step.

## Deliverables

Every module opens with a cache note (§12). `openai.ts`, `anthropic.ts`, `cache.ts` and `gateway.ts` write request bytes, so their note says: same input, same bytes, no clock, no randomness, fixed key order. The rest say `KV cache: none`. Paths are under `app/`.

| File | Responsibility and interface |
|---|---|
| `src/gateway/providers.ts` | `PROVIDERS`, `parseModelRef` (§7.3), `providerName(id)`, and `LOCAL_PRESETS` (vLLM `http://localhost:8000/v1`, Ollama `:11434/v1`, LM Studio `:1234/v1`, llama.cpp `llama-server` `:8080/v1`; verify at build) for step 7's screen. The table below is the content. Imports nothing else from the gateway |
| `src/gateway/keys.ts` | `SecretsLike`, `KeyInfo`, `checkFormat`, `KeyStore` (§7.3), and `KEY_HOOKS` (tests swap the file-lock step). Makes no network call and imports no SDK |
| `src/gateway/catalog.ts` | `ModelInfo`, `Catalog` (§7.3) |
| `src/gateway/usage.ts` | `toUsage(raw, info?)`, `addUsage`, `emptyUsage`, `RunTotals` (D-22) |
| `src/gateway/cache.ts` | `anthropicBreakpoints`, `sharedPrefix`, `planBatch`, `BatchGate` (D-24) |
| `src/gateway/openai.ts` | `buildOpenAIRequest(p, ctx)` (pure) and `streamOpenAI(client, req, hooks)` for every OpenAI-compatible provider, through the `openai` SDK |
| `src/gateway/anthropic.ts` | `buildAnthropicRequest(p, ctx)` (pure) and `streamAnthropic(client, req, hooks)` through `@anthropic-ai/sdk` |
| `src/gateway/fake.ts` | `FakeProvider`, exactly §7.5 (below) |
| `src/gateway/gateway.ts` | `Gateway` (§7.3), `ModelError extends RpcError` (calls `super(-32001, message, data)`; `data` is a ModelErrorData), `LIMITS`, `RETRY` (tests replace `RETRY.sleep` and `RETRY.random`) |
| `src/settings.ts` (+5) | Step 2 already has the defaults (`max_in_flight` 16, `local` base URL) and the provider-id pattern. Add only: `<id>` must be a `PROVIDERS` id; `providers.<id>.base_url` is accepted only for `local` and `custom` and must parse as an http(s) URL (or be empty); `max_in_flight` is an integer 1 to 256; the provider part of `root.model` and `sub.model` must be a known id (`fake/scripted` is allowed). `settings.ts` imports only the id list from `providers.ts` |
| `catalog/models.json`, `catalog/ATTRIBUTION.md`, `scripts/build-catalog.ts` | below |
| `test/fakes/http.ts` | `startFakeProvider()` on `Bun.serve`, port 0, bound to `127.0.0.1` (not `localhost`, which can resolve to `::1` on Windows). Returns `{url, requests: {path, headers, body, rawBody, arrivedAt}[], inFlight, maxInFlight, redirectFetch, script(handler), stop()}`. `redirectFetch(real)` rewrites any URL to this server, keeping path and query, and adds `x-orig-host`. Builders: `openaiStream`, `anthropicStream` (text, reasoning, tool call, usage, `chunkDelayMs`, `holdFirstChunkMs`), `httpError(status, body, headers)`, `cutMidStream()`. Steps 6 and 7 may reuse it |

**Providers (`PROVIDERS`).** "Key optional" means a saved key is sent if there is one.

| id | name | client | base URL | env var | key | api | caching |
|---|---|---|---|---|---|---|---|
| anthropic | Anthropic | anthropic | https://api.anthropic.com | ANTHROPIC_API_KEY | needed | yes | anthropic |
| openai | OpenAI | openai | https://api.openai.com/v1 | OPENAI_API_KEY | needed | yes | openai |
| deepseek | DeepSeek | openai | https://api.deepseek.com | DEEPSEEK_API_KEY | needed | yes | auto |
| openrouter | OpenRouter | openai | https://openrouter.ai/api/v1 | OPENROUTER_API_KEY | needed | yes | openrouter |
| gemini | Google Gemini | openai | https://generativelanguage.googleapis.com/v1beta/openai/ | GEMINI_API_KEY, then GOOGLE_API_KEY | needed | yes | auto |
| local | Local server | openai | setting, default `http://localhost:8000/v1` | none | optional | no | auto |
| custom | Custom endpoint | openai | setting, no default | RLMH_CUSTOM_API_KEY | optional | no | none |
| fake | Fake (hidden) | fake | none | none | none | yes | none |

The SDK needs a non-empty key, so a provider with no key gets the placeholder `"none"` and no real header value. Base URLs verified 2026-10-28 for DeepSeek and Gemini; check the others at build.

**`Gateway.complete`, in order.**
1. Emit `call.start` (`call_id` `c<n>`, `prompt` = the last message's content, `started_at` = `Date.now()`). Unknown provider: kind `other`.
2. Key: `keys.resolve`, unless the provider needs none. A needed key that is missing gives `no_key`. A store read failure gives `other`.
3. Window check (D-25), root calls only, only when the catalog knows a window above 0: `ceil(chars / 3) + max_tokens` against `context_window`, where `chars` is every message's content, each tool call's `JSON.stringify(arguments)` and `JSON.stringify(tools)`. Over the window gives `context_window`.
4. Batch gate (sub-calls with `batch.size > 1`): wait per the batch rule below.
5. Take a slot from the provider's semaphore (`providers.<id>.max_in_flight`, read at call time, first come first served).
6. Attempt loop: 1 try plus 6 retries. Retry statuses are 408, 409, 429 (not quota) and every 5xx, plus idle timeouts, dropped connections and `error` events inside a stream. A stream that breaks is retried whole: if text was already sent, the gateway first emits `call.delta {call_id, reset: true}`. `reset?: true` is a new optional field on `call.delta`: add it to the `AppEvents` type and to architecture.md §7.3, and say so in the progress.md log. The slot is released while sleeping. Delay is `[2, 4, 8, 16, 32, 60]` s times `0.5 + RETRY.random()`; a `Retry-After` (or `retry-after-ms`) header raises it to `min(value, 60 s)`.
7. Parameter fallback (not a retry, no sleep, at most 2 per call): a 400 or 422 whose message names `temperature`, `top_p`, `reasoning_effort`, `reasoning`, `chat_template_kwargs` or `stream_options` is resent once without that field. The drop is remembered per provider, model and field for the process. Anthropic only: a 400 containing `"thinking.type.enabled" is not supported` is resent with the adaptive shape, and one containing `adaptive thinking is not supported` with the budget shape, also remembered.
8. On success: `toUsage`, add to the run's totals, emit `call.end` once, return the result. `seconds` is wall time since `call.start`, queueing and retries included. `served_model` is the model name the provider echoed, else the requested id. `tool_call` is the first call only (D-04). `finish_reason` is `tool_call` whenever a tool call came back, unless the provider said `length`.
9. On failure: emit `call.end` with `error`, throw `ModelError`.

Other rules. `cancelRun` and the request `signal` abort queued, waiting, sleeping and in-flight calls (kind `cancelled`). Each attempt also has an idle timeout (no stream event for 180 s; 600 s for `local` and `custom`) and a 900 s total. Per-run state keeps totals, the last root request and a replay map; the gateway keeps the 20 newest runs and drops a run's replay map on the bus event `engine.event` with `method: "run.finished"`. `LIMITS` holds `BATCH_COLLECT_MS` 100, `BATCH_LEADER_WAIT_MS` 60000, `SECRETS_TIMEOUT_MS` 15000, the idle and total timeouts and the run count, so tests can shorten them. The default fetch is `(u, i) => (opts.fetch ?? globalThis.fetch)(u, i)`, looked up per call. Both SDKs get `maxRetries: 0`, that fetch, a `timeout` of 900000, and for Anthropic `defaultHeaders: {"anthropic-version": "2023-06-01"}` so an SDK upgrade can't change the wire. Clients are cached per provider, base URL and key.

**Errors.** `{P}` is the provider name, `{M}` the model id, `{L}` the key's label, `{E}` its last 4 characters, `{detail}` the provider's own message cut to 300 characters with the key and any `Bearer` or `sk-` token replaced by `[key]`. "7 tries" is 1 plus 6 retries.

| kind | When | Message |
|---|---|---|
| `no_key` | key needed, none found | `No API key for {P}. Add one in /providers.` |
| `auth` | HTTP 401 or 403 | `{P} rejected the key "{L}" (ends in {E}). Re-enter or delete it in /providers.` From an environment variable, `{L}` is `$ANTHROPIC_API_KEY` and so on, and the tail is `Fix that variable, or save a key in /providers.` With no key at all: `{P} rejected the request (HTTP {status}) and no key is saved. Add one in /providers.` |
| `bad_request` | 400, 413, 422 after parameter fallback | `{P} refused the request (HTTP {status}): {detail}` |
| `unknown_model` | 404 | `{P} has no model "{M}" (HTTP 404). Pick another in /model, or use Refresh models in /providers.` |
| `rate_limit` | 429 after 7 tries; or a quota 429 (`insufficient_quota`, no retries) | `{P} is rate limiting requests (HTTP 429) after 7 tries: {detail}`; quota: `{P} says the account is out of quota or credit (HTTP 429): {detail}` |
| `server` | 5xx after 7 tries | `{P} failed with HTTP {status} after 7 tries: {detail}` |
| `timeout` | idle timeout or 408 after 7 tries | `{P} did not answer in time after 7 tries.` |
| `network` | refused, DNS, reset after 7 tries | `Could not reach {P} at {host} after 7 tries: {cause}` For `local` add ` Is the server running? If it is, try http://127.0.0.1:<port>/v1 in /settings.` |
| `context_window` | window check | `This request would not fit in {M}'s context window: about {est} tokens (prompt about {p} plus up to {max_tokens} for the reply) against {window}. Choose a model with a larger window in /model, or lower the limits in the profile.` |
| `cancelled` | abort | `The call was cancelled.` |
| `other` | 402, other 4xx, bad stream, key read failure, `custom` with no base URL | `{P} returned HTTP {status}: {detail}`; key read failure: `Could not read the key for {P} from the OS key store ({cause}). Re-enter it in /providers.`; no URL: `No base URL for the custom provider. Set providers.custom.base_url in /settings.` |

**Request mapping, OpenAI-compatible (`openai.ts`).** Body key order is fixed: `model, messages, tools, <max tokens>, temperature, <thinking fields>, <cache field>, stream, stream_options`. `tools` is left out when empty, `stream_options` is `{include_usage: true}`, and `tool_choice` is never sent. Messages: `system` and `user` as is; an assistant message is `{role, content, tool_calls: [{id, type: "function", function: {name, arguments: JSON.stringify(arguments)}}]}` with `content: ""` when empty; a tool message is `{role: "tool", tool_call_id, content}`. A provider reply with no tool-call id gets `call_<run_id>_<turn>` (D-39).

| Provider | Max tokens | `temperature` | Thinking off (D-08) | Thinking low, medium, high | Cache field |
|---|---|---|---|---|---|
| openai | `max_completion_tokens` | left out when the catalog says `reasoning` | no `reasoning_effort` | `reasoning_effort: <level>` | `prompt_cache_key: run_id` |
| deepseek | `max_tokens` | sent | `thinking: {type: "disabled"}` | `thinking: {type: "enabled"}`, `reasoning_effort: <level>` | none (automatic) |
| openrouter | `max_tokens` | sent | `reasoning: {effort: "none"}` | `reasoning: {effort: <level>}` | `session_id: run_id` in the body (a header `x-session-id` also works; the body wins) |
| gemini | `max_tokens` | sent | `reasoning_effort: "none"` | `reasoning_effort: <level>` | none |
| local | `max_tokens` | sent | `chat_template_kwargs: {enable_thinking: false}` | `chat_template_kwargs: {enable_thinking: true, reasoning_effort: <level>}` | none |
| custom | `max_tokens` | sent | nothing | `reasoning_effort: <level>` | none |

Reasoning text is read from `delta.reasoning_content`, `delta.reasoning` or OpenRouter's `delta.reasoning_details` (verify at build) and goes to `call.delta` and the result's `reasoning`, never into messages. Usage: see below. Models the OpenAI guide lists without function calling in Chat Completions get `tool_call: false` in the catalog, so `auto` picks fenced (verify at build).

**Request mapping, Anthropic (`anthropic.ts`).** `system` messages are joined with `"\n\n"` into the top-level `system`. A user message is one `text` block; a tool message is a `tool_result` block in a user message; an assistant message is its replayed thinking blocks, then a `text` block when content is not empty, then a `tool_use` block with `input = arguments`. An assistant message with no content and no tool call is dropped and its neighbours merge into one user message. `tools` are `{name, description, input_schema: parameters}`. Key order: `model, max_tokens, system, tools, messages, temperature, thinking, output_config, stream`. The stream is read as raw events (`message_start`, `content_block_*`, `message_delta`, `error`), not through the SDK's message helper, so thinking blocks and signatures are kept as received. `temperature` goes out only when the table says so (training's 1.0 and 0.3 cannot be honoured elsewhere; the drop is silent).

| Model id after `claude-` | Thinking low, medium, high | Thinking off | `temperature` |
|---|---|---|---|
| `opus-4`, `opus-4-1`, `sonnet-4`, `sonnet-4-5`, `opus-4-5`, `haiku-4-5`, `sonnet-3-7` | `{type: "enabled", budget_tokens: B}` | no `thinking` | only with thinking off |
| `opus-4-6`, `sonnet-4-6` | `{type: "adaptive", display: "summarized"}` and `output_config: {effort: <level>}` | no `thinking` | only with thinking off |
| `opus-4-7`, `opus-4-8` | as above | no `thinking` (default off) | never |
| `opus-5`, `sonnet-5` | as above | `{type: "disabled"}` | never |
| `sonnet-5-5` | as above | `{type: "between_tools"}` | never |
| `haiku-5-5` | as above | `{type: "disabled"}` | never |
| `opus-5-5`, `fable-*`, `mythos-*` | as above | no `thinking` (it can't be turned off; `reasoning_tokens` shows it) | never |
| anything else | as above | no `thinking` | only with thinking off |

`B = floor(max_tokens * 0.25 | 0.5 | 0.75)` for low, medium, high, at least 1024; at `max_tokens` 1024 or less, no `thinking` is sent. Source: the Anthropic thinking-troubleshooting table, 2026-10-28 (verify at build). Thinking tokens count inside `max_tokens`.

**Cache markers (`cache.ts`).**
- Anthropic root calls: `system` is one text block with `cache_control: {type: "ephemeral"}`, and the last block of the last message has the same. That is 2 of the 4 allowed breakpoints. Only whole blocks carry a marker; no text is ever split, so the model reads the same bytes with or without a marker. Sub-calls carry no marker unless the batch rule below applies, because a lone write costs 1.25 times for no read. Default TTL (5 minutes).
- Minimum cacheable length comes from the catalog's `cache_min_tokens`, filled by hand for Anthropic from Anthropic's table (below). Shorter prompts are simply not cached; no error.
- **Batch rule (D-24).** A sub-call with `batch.size > 1` waits in a `BatchGate` keyed by run and batch id until `size` calls arrived or 100 ms passed. `planBatch` then takes the longest common prefix of the prompts (by characters, never inside a surrogate pair). The rule applies when the provider's `caching` is not `none`, at least 2 calls are in the group, and `ceil(prefix chars / 4) >= cache_min_tokens` (1024 when the catalog gives null). Then the call with the lowest `batch.index` is sent alone, the gate waits for its first stream content (any text, reasoning or tool-call delta, or `content_block_start`) or its end, at most 60 s, and then sends the rest. Calls arriving after the release also wait for that first token. Otherwise everything is sent at once. A batch of one never waits.
- On Anthropic the rule applies only when all the prompts are identical, so the shared prefix is one whole block, and every call in the group carries the marker on it. A prefix inside one string would need a split into two text blocks, and nothing here proves that the model sees identical bytes. `cache.ts` has the split path behind `ANTHROPIC_SPLIT_PREFIX = false`. Switch it on only after a developer has run `/v1/messages/count_tokens` with their own key on both shapes and the counts match.

**Keys (`keys.ts`).**
- Store: `Bun.secrets` with `{service: "rlm-harness", name: "<provider>:<id>"}` (verified on 1.4.4: `get` gives `null` when missing, `delete` gives `false`, there is no list, and `persist` is Windows-only, so pass `persist: "local"` to stop it roaming). Each call races `SECRETS_TIMEOUT_MS`. Any throw or timeout on `set` falls back to `<home>/keys.json`, `store: "file"`. Setting `RLMH_KEY_STORE=file` forces the file (CI and headless Linux).
- `add`: `checkFormat`, trim, id `k_` plus 8 hex, label defaults to `key <n>`, the first key of a provider is active. It returns a `KeyInfo`, never the key. `remove` deletes from whichever store the index names (a missing entry is fine), and the newest remaining key becomes active.
- `key-index.json` is `{"version": 1, "keys": [KeyInfo…]}` and `keys.json` is `{"version": 1, "keys": {"<provider>:<id>": "<key>"}}`. Both are written to a temp file and renamed over (retry 3 times, 50 ms apart, on `EPERM` or `EBUSY`; antivirus on Windows). Writes go through one in-process queue; two app processes at once are not handled. An unreadable index is renamed to `key-index.json.bad` and treated as empty.
- **Owner-only file.** POSIX: create the temp file with mode `0o600`, `chmod` it again after writing (umask), and on read tighten any group or other bits. Windows: `whoami /user /fo csv /nh` gives the SID, then `%SystemRoot%\System32\icacls.exe <tmp> /inheritance:r /grant:r *<SID>:F` runs on the empty temp file before the key is written. Fail closed on both: if locking fails, `add` throws `Could not restrict keys.json to your account, so the key was not saved: <cause>` and nothing is written.
- `resolve`: the provider's variable (and `GOOGLE_API_KEY` for Gemini), non-empty after trimming, then the active saved key, else `null`. Environment keys are not listed by `list`.
- `checkFormat` (format only): empty gives `Paste a key first.`; whitespace or non-ASCII gives `That key has spaces or odd characters in it. Copy it again without the surrounding text.`; over 2048 characters gives `That key is too long to be an API key.`; then `anthropic` must start `sk-ant-`, `openai` and `deepseek` `sk-`, `openrouter` `sk-or-` (message `That does not look like {P} key: they start with "<prefix>".`), `gemini` needs 20 or more characters, others anything. If a provider changes its prefix, loosen the rule here (verify at build).

**Catalog and refresh.**
- `Catalog(home)` loads the bundled `catalog/models.json` (imported, so `bun build --compile` embeds it), then overlays `<home>/models-refreshed.json` (`{"version": 1, "providers": {"<id>": ModelInfo[]}}`; missing or corrupt is ignored), plus a built-in `fake/scripted` entry (§7.5 numbers) that `models()` hides. `context_window: 0` means unknown and skips the window check. An id the catalog doesn't know is still called: cost 0, no window check, `tool_call` unknown so `auto` gives fenced.
- `merge` replaces entries by `id`, keeps the rest, and writes the refreshed file atomically.
- `refreshModels(provider)` is the only non-model request: one `GET` per page with the key, 30 s, no retries, never called by `complete`. OpenRouter `/models` (public) gives `context_length`, `pricing` strings per token (times 1e6), `top_provider.max_completion_tokens` and `supported_parameters` (`tools`, `reasoning`). Anthropic `/v1/models` pages with `after_id`, at most 5 pages. Gemini ids lose the `models/` prefix. Others give ids only. Every fetched id starts from the bundled entry when there is one; a new id gets zeros, `tool_call: false`, `reasoning: false`, `cache_min_tokens: null`. Verify each response shape at build.

**`catalog/models.json`.** `{"version": 1, "source": {"repo": "can1357/oh-my-pi", "path": "packages/catalog/src/models.json", "commit": "<40 hex>", "license": "MIT"}, "models": [{provider, id, name, context_window, max_output, price: {input, output, cache_read, cache_write}, tool_call, reasoning, cache_min_tokens}]}`. Sorted by provider then id, 2-space indent, `\n` ends, no timestamp, so one commit always gives the same bytes.

**`scripts/build-catalog.ts`** (run by hand; the only code here that may touch the network, and only when a developer runs it). `bun run scripts/build-catalog.ts --commit <sha>` downloads the raw OMP file at that commit (over 10 MB), or `--file <path>` reads a local copy. It exports a pure `buildCatalog(src, opts)` and runs only under `import.meta.main`.
- Input shape: `{ [provider]: { [modelId]: entry } }` with `id, name, api, reasoning, input, cost {input, output, cacheRead, cacheWrite} (USD per 1M tokens), contextWindow, maxTokens, supportsTools?`. Provider map: anthropic, openai, deepseek, openrouter, and `gemini` from OMP's `google` (verify at build).
- Keep an entry when `input` includes `"text"`, `contextWindow` is above 0 and `cost` exists. OpenRouter keeps only ids whose first segment is one of anthropic, openai, google, deepseek, qwen, meta-llama, mistralai, x-ai, moonshotai, z-ai, at most 300, sorted.
- `tool_call = supportsTools !== false`, and for `openai` also `api` must be the Chat Completions kind. `max_output = maxTokens ?? 0`. OMP's `longContext` and `timeBased` price tiers are ignored (cost is undercounted above a long-context threshold).
- `cache_min_tokens`: OpenAI 1024 (verify at build); Anthropic from this hand table, matched with `^claude-<name>(-\d{8})?(-latest)?$`, and an unlisted Anthropic id stops the script with `add a cache_min_tokens row for <id>`; everything else null. Table (Anthropic docs, 2026-10-28; verify at build): **512** opus-5-5, opus-5, sonnet-5-5, sonnet-5, haiku-5-5, fable-5-1, fable-5, mythos-5-1, mythos-5. **1024** opus-4-8, sonnet-4-6, sonnet-4-5, sonnet-4, opus-4-1, opus-4. **2048** opus-4-7, mythos-preview, haiku-3-5. **4096** opus-4-6, opus-4-5, haiku-4-5.

**`catalog/ATTRIBUTION.md`.** Names OMP and its URL; says the file is a subset of `packages/catalog/src/models.json` at the commit in `models.json`; lists what we changed (kept providers and fields, renamed fields, `cache_min_tokens` added by hand); carries the MIT text with the copyright lines from OMP's `packages/catalog/LICENSE` (Can Bölük 2025-2026; Stencil Labs, Inc. 2026; copy the repo-root LICENSE too); notes OMP builds its data from third-party sources (stencil.so, provider discovery, OpenCode docs), so check their terms before the first release (1a: MIT, S-22).

**Usage (`usage.ts`).** `output_tokens` is the provider's total output, so `reasoning_tokens` is a subset of it. Cost (D-22) is `((input - read - write) * price.input + read * price.cache_read + write * price.cache_write + output * price.output) / 1e6`, and 0 for a model with no catalog entry. Hit rate is reads over input. With no usage in a stream, `input_tokens` and `output_tokens` are `ceil(chars / 4)`.

| Provider | `input_tokens` | `cache_read_tokens` | `cache_write_tokens` | `reasoning_tokens` |
|---|---|---|---|---|
| Anthropic | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (Anthropic's `input_tokens` excludes cached tokens) | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens_details.thinking_tokens`, else 0 (verify at build) |
| OpenAI-compatible | `prompt_tokens` | `prompt_tokens_details.cached_tokens`, or DeepSeek's `prompt_cache_hit_tokens` | `prompt_tokens_details.cache_write_tokens` (OpenRouter), else 0 | `completion_tokens_details.reasoning_tokens`, else 0 |

**Replay (D-33, extended).** Some providers reject a tool-call turn unless the reasoning that came with it is sent back. The gateway keeps it per run, keyed by `sha256(text + "\0" + tool_call id)` of the reply, and attaches it to the assistant message whose content and tool-call id match, on the next request only. The engine's messages stay reasoning-free.

| Provider | What is kept and re-attached |
|---|---|
| Anthropic | the `thinking` and `redacted_thinking` blocks (with `signature`), unmodified and in order, before the `tool_use` block |
| DeepSeek | `reasoning_content` on the assistant message, only when the request has `tools` (otherwise a 400) |
| OpenRouter | `reasoning_details` as received (verify at build) |
| Gemini | the tool call's `extra_content` (holds `google.thought_signature`), as received |

**`FakeProvider` (§7.5, exactly).** It needs no key and the catalog entry has zero prices, window 1,000,000 and `tool_call: true`. It reads the JSON file at `RLMH_FAKE_SCRIPT` at a run's first call (missing variable: kind `other`, `RLMH_FAKE_SCRIPT is not set`; unreadable: `fake script unreadable: <cause>`).
- Root replies are served in order, restarting at index 0 for each run; past the end: kind `other`, message `fake script exhausted`. A reply's `tool_call: {code}` becomes `{id: "call_<n>", name: "python", arguments: {code}}`, where `n` counts the root replies served in the run from 1. `finish_reason` is `tool_call` or `stop`.
- Sub-calls take the first rule whose `match` regex (`new RegExp(match)`, searched anywhere in the prompt) finds the prompt; if none does, the first rule with no `match`; if there is none, kind `other`, `fake script has no sub-call rule for this prompt`.
- `errors[]` fails the `at`-th call (from 1, counted per run and role, successful calls included) with that `kind` and `status` (default null). It is raised at once with no retries, so engine tests stay fast.
- The text is streamed through `call.delta` in pieces of `chunk_chars` (default 16) with `delay_ms` (default 0, abortable) between them. Tokens are `ceil(chars / 4)` with chars as in `usage.ts`; `served_model` is `scripted`. It still goes through the window check, the in-flight cap, usage and the bus.

## Tasks

1. [ ] From `app/`, pin exact versions: `..\.bun\bin\bun.exe add --exact openai@7.45.1 @anthropic-ai/sdk@1.3.0` (latest on npm on 2026-10-28; if newer exist, pin those, with no `^`). Record both in progress.md.
2. [ ] Re-check every item marked "verify at build" against the provider pages. Where one differs, follow the page and list it in the progress.md log.
3. [ ] `providers.ts`, the `settings.ts` additions, and `gateway/settings.test.ts`.
4. [ ] `usage.ts` and `catalog.ts` (with the built-in fake entry), then `build-catalog.ts` and its fixture test.
5. [ ] Run `..\.bun\bin\bun.exe run scripts/build-catalog.ts --commit <current OMP main sha>` once, by hand. Run it twice and compare sha256 of `catalog/models.json`. Write `ATTRIBUTION.md`.
6. [ ] `keys.ts` with an in-memory `SecretsLike` first, then the file store, then the Windows lock. Run `keys.test.ts` before `secrets.test.ts`.
7. [ ] `fake.ts`, then `test/fakes/http.ts`.
8. [ ] `cache.ts`, `openai.ts` and `anthropic.ts`: the pure `build*Request` functions first with golden tests, then the streaming readers against the fake server.
9. [ ] `gateway.ts`: the `complete` order above, caps, retries, parameter fallback, replay, totals, `cancelRun`, `lastRootRequest`, `resolveCallFormat` (§7.4), `refreshModels`.
10. [ ] Write the remaining tests. Set `RETRY.sleep` to a recorder in every test that retries, so none waits.
11. [ ] Run `..\.bun\bin\bun.exe run typecheck` and `..\.bun\bin\bun.exe test test/gateway` from `app/`. Then `Select-String -Path src\gateway\*.ts -Pattern "globalThis.fetch"` must show only the default-fetch wrapper in `gateway.ts`.
12. [ ] Push nothing and commit nothing; set the progress.md row to `review` with the log line (versions, catalog commit, which `secrets.test.ts` path ran on each OS once CI has run).

## Tests

All under `app/test/gateway/` unless noted. Every client test uses `startFakeProvider` and `redirectFetch`, so request counts and headers are exact.

| File | Cases |
|---|---|
| `nonetwork.test.ts` | Replace `globalThis.fetch`, `node:net` `Socket.prototype.connect`, `http.request`, `https.request`, `dns.lookup` and `WebSocket` with counters that fail the test, and pass a counting `fetch` to the Gateway. Then `add` (two keys), `remove`, `setActive`, `list`, `resolve`, `checkFormat` and `new Gateway(...)`, `catalog.models()`, `totals()`: every counter is 0. **Positive controls** in the same file: one `complete` through the fake server moves the Gateway counter to 1, and one `refreshModels` makes exactly 1 request; so the counters work |
| `keys.test.ts` | add, list, setActive, remove, resolve round trip; first key active; removing the active one promotes the newest; `key-index.json` holds label, last4, store and never the key (read the file and search); env beats saved keys; Gemini alias; blank env ignored; every `checkFormat` message; `set` throwing or hanging falls back to the file (short `SECRETS_TIMEOUT_MS`); 10 parallel `add` calls give 10 valid entries; a corrupt index is renamed to `.bad` |
| `secrets.test.ts` | Real `Bun.secrets` through an adapter that renames the service to `rlm-harness-test`, raced at 8 s: prints `secrets: os-store` or `secrets: file-fallback (<cause>)`, and passes on either. On the OS store: `set`, `get`, `delete` true, `get` null, `delete` false; `KeyStore.add/resolve/remove` leave no entry behind (`finally` cleans up). Fallback file: POSIX mode is `0o600`; Windows (`skipIf` not `win32`): `icacls` on `keys.json` lists exactly one ACE, `(F)`, for the current user, and none for Everyone, Users or Authenticated Users; swapping `KEY_HOOKS.restrict` for a thrower makes `add` throw the exact message and leaves no `keys.json` and no key on disk |
| `catalog.test.ts` | The committed `models.json`: version 1, sorted, no duplicates, prices at least 0, every provider is a real non-fake id, `source.commit` is 40 hex, every Anthropic entry has a `cache_min_tokens` in {512, 1024, 2048, 4096}, every OpenAI entry 1024; `ATTRIBUTION.md` names the licence and holders. `buildCatalog` on a small OMP-shaped fixture: filters, mapping, OpenRouter cap, a null window dropped, an `api` that isn't Chat Completions gives `tool_call: false`, same bytes twice, an unlisted Anthropic id throws. `Catalog`: overlay order, `merge` persists, a corrupt overlay is ignored, `fake` hidden from `models()`. `refreshModels` for OpenRouter, Anthropic (2 pages), Gemini and an ids-only provider; no key gives `no_key` |
| `clients.test.ts` | Golden bodies for both converters (system, user, assistant with tool call, tool; empty assistant dropped); the same input twice gives equal strings; streamed text, reasoning and split tool-call arguments give one `ToolCall`, a second call dropped; generated id when the provider sends none; the mapping tables row by row (path, `x-orig-host`, fields) at off, low, medium and high; Anthropic family table, budget math, `temperature` rules, the `thinking.type.enabled` error switching shape once and remembering; parameter fallback for `temperature`; **retries**: 503 three times then 200 gives delays `[2, 4, 8]` s with `RETRY.random = () => 0.5`; seven failures give kind `server` after exactly 7 requests (proves `maxRetries: 0`); `Retry-After: 5` waits 5 s and `500` waits 60 s; 400 and quota 429 are not retried; a cut stream is retried whole and sends `reset`; **in-flight cap**: 40 concurrent calls give `maxInFlight` at most 16, and at most 4 with `providers.openai.max_in_flight` set to 4, and another provider isn't held up; **replay** of thinking blocks, `reasoning_content` and `extra_content`, byte-identical, and gone after `run.finished` |
| `cache.test.ts` | Anthropic root body: `system` is one block with `cache_control`, the last block of the last message has it, nothing else does, 2 markers, and each message still has one text block with the engine's text; a plain sub-call has none; `prompt_cache_key` equals the run id on OpenAI root and sub-calls, `session_id` on OpenRouter, neither on the others; `sharedPrefix` and `planBatch` units (threshold from the catalog, null gives 1024, size 1, `caching: none`, surrogate pairs, Anthropic non-identical gives no rule, `split: true` gives two text blocks on the pure function only); **batch rule** on the OpenAI fake: 4 prompts sharing 6,000 characters give one request first, and the other 3 arrive only after the server sent its first chunk (held 300 ms); a shared prefix below the minimum sends all 4 within 50 ms; a late member waits for the first token; a leader that fails before any token still releases the rest; cancel during the wait cancels all. Anthropic with 4 identical prompts: marker on each and the same ordering |
| `usage.test.ts` | Each provider's raw usage gives the right `Usage` (the table above); cost for three catalog models equals hand-computed constants (cache reads and writes included); hit rate; `totals` by role; missing usage gives `ceil(chars / 4)`; an unknown model costs 0; 21 runs evict the oldest; `totals` of an unknown run is zeros and `null` |
| `fake.test.ts` | Every bullet of §7.5 as written above, `call_<n>` ids, `chunk_chars` and `delay_ms`, an abort during `delay_ms`, an empty `KeyStore` works, a 400,000-character request passes the window check, `resolveCallFormat` gives native |
| `errors.test.ts` | One case per row of the errors table with the exact message (auth for saved key, env key and no key); a server that echoes the `Authorization` header in its error body leaves the key out of the thrown error, the bus events and the run state; the window check (root only, exact fit passes, unknown window skipped); `cancelRun` and `signal` abort a queued, a sleeping and an in-flight call; `resolveCallFormat` for `auto`, `fenced` and `native` over every provider with `tool_call` true and false; `ModelError.code` is -32001 |
| `wire.test.ts` | Two `Link`s joined by in-memory streams. The app side has the two lines of §7.3's wiring (`handle("model.complete", …)` and `onNotification("model.cancel", …)`) with a Gateway on the fake provider. The other side sends 5 concurrent `model.complete` requests and gets all 5 answers; a scripted error comes back as an `RpcError` with code -32001 and `data.kind`; a `model.cancel` notification makes a slow call fail with kind `cancelled` |
| `settings.test.ts` | The settings additions: `base_url` accepted for `local` and `custom` only and checked as a URL; `max_in_flight` bounds and default; `root.model` with an unknown provider refused, `fake/scripted` accepted; defaults round-trip through `loadSettings` and `saveSettings` |

## Done when

- `..\.bun\bin\bun.exe run typecheck` and `..\.bun\bin\bun.exe test test/gateway` pass in `app/` on Rishi's PC, and the same step is green on macOS, Windows and Linux in CI.
- `test/gateway/nonetwork.test.ts` passes: zero requests during `add`, `remove`, `setActive` and `list`, with the positive controls.
- Against the fake server, `clients.test.ts`, `usage.test.ts` and `cache.test.ts` show: retries happen with the D-23 delays; the in-flight cap holds; cost sums equal the catalog prices; Anthropic breakpoints sit on the end of `system` and the latest message; the batch rule sends one call, waits for its first chunk, then sends the rest; `prompt_cache_key` and `session_id` are set.
- `errors.test.ts` shows a 401 for a key labelled `work` that ends in `3f9a` become exactly `Anthropic rejected the key "work" (ends in 3f9a). Re-enter or delete it in /providers.`, and the other messages in the table.
- `secrets.test.ts` prints `secrets: os-store` or `secrets: file-fallback` on every OS in CI and passes; the Windows ACL case passes on the Windows runner and on Rishi's PC.
- `wire.test.ts` passes: a `model.complete` sent over a `Link` is answered by the gateway.
- Running `build-catalog.ts` twice on one commit gives the same sha256 for `catalog/models.json`, and `catalog.test.ts` passes on the committed file.

## Out of scope

- Wiring in `session.ts` and starting an engine: step 6. This step tests the same two lines in `wire.test.ts` only.
- The `/providers`, `/model`, `/settings` screens, the sub-call panel and the status line: step 7. This step supplies `KeyStore`, `refreshModels`, `LOCAL_PRESETS`, `totals` and the bus events.
- The engine's retries of `ModelError`, D-06's `SubcallError` mapping and the run log: step 6.
- OpenAI's Responses API, subscription or OAuth logins (S-07), key validation calls or pings (S-06), Anthropic's batch API, an OS sandbox, compaction (v1) and response caching of our own.

## Hand-off

- Steps 6 and 7 can rely on: `Gateway`, `KeyStore`, `Catalog`, `PROVIDERS`, `parseModelRef`, `LOCAL_PRESETS` and `AppEvents` as in §7.3; `fake/scripted` working with no key and no network; `test/fakes/http.ts`; a thrown `ModelError` that `Link` answers as -32001 with `data` (checked by `wire.test.ts`).
- Step 6 must keep `callformat.assistant_message`'s `content` equal to the reply's `text`, byte for byte, because the replay map is keyed on it, and must wire `session.ts` exactly as §7.3 says. Step 7 must handle `call.delta` with `reset: true` by clearing that call's streamed text and reasoning.
- progress.md log line: the exact `openai` and `@anthropic-ai/sdk` versions, the OMP commit in `models.json`, which `secrets.test.ts` path ran per OS, the "verify at build" facts that turned out different, and the `call.delta` `reset` field added to architecture.md §7.3.

## If a decision goes the other way

Every decision below was settled at step 1 (2026-10-30; [decisions.md](../decisions.md) S-22 to S-34). Each line names the pick and says what would change if Rishi reversed it. Picks that went the alternative way are already written into this spec.

- **5a, fewer providers (Anthropic, OpenAI, local)** (settled: all seven, S-28): delete the `deepseek`, `openrouter` and `gemini` rows, their mapping rows, replay rows, `build-catalog.ts` entries and test cases; `custom` can stay as a free extra. About a third of `clients.test.ts` goes.
- **5b, file only** (settled: `Bun.secrets` with the file fallback, S-06; this is what the alternative would remove): drop `SecretsLike`, the `Bun.secrets` calls, the timeout and the real-store case in `secrets.test.ts`; `store` is always `"file"`. Everything else stays, and the Windows ACL and 0600 steps become the only protection, so their fail-closed rule is the part to keep. It also removes the macOS Keychain prompt and the Linux libsecret risk in CI.
- **5c, models.dev or hand-written** (settled: a subset of OMP's catalog, S-29): models.dev means a new input reader and field map in `build-catalog.ts`, a licence check before committing anything, and a new `ATTRIBUTION.md`; the `models.json` shape and everything downstream stay. Hand-written means deleting `build-catalog.ts`, writing the same file by hand, and adding a `source.checked` date that `catalog.test.ts` warns on when older than 90 days.
- **6b, fenced text everywhere** (settled: native for API models, S-30): `resolveCallFormat` returns `"fenced"` for `auto`. The native path (tool conversion, tool-call streaming, `tool_result` blocks, replay) stays reachable through `call_format = native`; if native is dropped, delete it and the replay table, about a third of both converters, and the `tool_call` flag handling in `build-catalog.ts`.
