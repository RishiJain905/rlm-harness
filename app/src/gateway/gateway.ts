// KV cache: sends the bytes openai.ts, anthropic.ts and cache.ts build and never changes the engine's text; same input, same bytes, no clock, no randomness, fixed key order; replay and fallbacks depend only on what the provider sent earlier, so a run's prefix stays stable.
//
// Gateway.complete answers model.complete (architecture §5.2, §7.3): key, window check, batch gate,
// in-flight slot, then 1 try plus 6 retries (D-23), with call.* events on the bus throughout.

import { Anthropic } from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { OpenAI } from "openai";
import type { Bus } from "../bus.ts";
import { RpcError } from "../link.ts";
import {
  ErrorCode,
  type Batch,
  type Message,
  type ModelCompleteParams,
  type ModelCompleteResult,
  type ModelErrorData,
  type ModelErrorKind,
  type ModelRef,
  type Origin,
  type ToolCall,
  type Usage,
} from "../protocol.ts";
import { getSetting, type Settings } from "../settings.ts";
import { buildAnthropicRequest, streamAnthropic, type ThinkingShape } from "./anthropic.ts";
import { ANTHROPIC_SPLIT_PREFIX, BatchGate, prefixWorthMarking, routeKey, type BatchTicket } from "./cache.ts";
import type { Catalog, ModelInfo } from "./catalog.ts";
import { FakeError, FakeProvider, newFakeRunState, type FakeRunState } from "./fake.ts";
import { KeyReadError, last4Of, type KeyStore, type ResolvedKey } from "./keys.ts";
import { buildOpenAIRequest, DROPPABLE_FIELDS, streamOpenAI } from "./openai.ts";
import { openRouterEndpoint, provider, providerName, type ProviderDef } from "./providers.ts";
import { AttemptError, causeText, formatBytes, type Failure, type Replay, type StreamHooks, type StreamResult } from "./stream.ts";
import { billedCost, emptyUsage, replyChars, requestChars, RunTotals, toUsage } from "./usage.ts";

export type AppEvents = {
  "call.start": { call_id: string; run_id: string; role: "root" | "sub"; subcall_id?: number; batch?: Batch; origin?: Origin; model: ModelRef; prompt: string; started_at: number };
  /** reset: a broken stream is retried whole; drop this call's text and reasoning so far. */
  "call.delta": { call_id: string; text?: string; reasoning?: string; reset?: true };
  "call.end": { call_id: string; run_id: string; usage: Usage; finish_reason: string; seconds: number; error?: ModelErrorData;
                /** OpenRouter: the endpoint that served the call, so a pinned conversation can be checked (D-120). */
                endpoint?: string | null };
  /** Every run.* notification, as received. */
  "engine.event": { method: string; params: any };
  "engine.exit": { code: number; stderr: string[] };
};

/** Timeouts and sizes; tests shorten them. The secrets timeout is KEY_LIMITS in keys.ts, which gateway.ts imports (D-73). */
export const LIMITS = {
  BATCH_COLLECT_MS: 100,
  BATCH_LEADER_WAIT_MS: 60_000,
  IDLE_TIMEOUT_MS: 180_000,
  /** local and custom servers can sit silent through a long prefill. */
  IDLE_TIMEOUT_LOCAL_MS: 600_000,
  TOTAL_TIMEOUT_MS: 900_000,
  REFRESH_TIMEOUT_MS: 30_000,
  REFRESH_MAX_PAGES: 5,
  /** Finished runs whose totals and last root request stay readable; a run that has not finished is never dropped. */
  RUNS_KEPT: 20,
  DETAIL_CHARS: 300,
  /**
   * Most bytes of text, reasoning and tool-call arguments one attempt may gather before it is cut off with an error.
   * A reply of a million tokens is about 4 MB of English (reasoning counts inside max_tokens), so 16 MiB is a wide margin
   * for a real model, and half the 32 MiB line of the link to the engine, which has to carry the reply back.
   */
  MAX_RESPONSE_BYTES: 16 * 1024 * 1024,
  /** Most bytes of model-list bodies one "Refresh models" may read, all pages together. The bundled catalog of 391 models is 149 KB; a live list has more fields per model, and is still far under this. */
  MAX_MODEL_LIST_BYTES: 16 * 1024 * 1024,
};

/** D-23. Tests replace `sleep` with a recorder and `random` with a constant. */
export const RETRY = {
  DELAYS_S: [2, 4, 8, 16, 32, 60] as readonly number[],
  RETRY_AFTER_MAX_S: 60,
  /** Parameter fallbacks per call (not retries: no sleep). */
  MAX_FALLBACKS: 2,
  sleep: (ms: number, signal: AbortSignal): Promise<void> => abortableSleep(ms, signal),
  random: (): number => Math.random(),
};

export class ModelError extends RpcError {
  declare readonly data: ModelErrorData;

  constructor(data: ModelErrorData) {
    super(ErrorCode.MODEL_ERROR, data.message, data);
    this.name = "ModelError";
  }

  get kind(): ModelErrorKind {
    return this.data.kind;
  }
}

const TRIES = 1 + RETRY.DELAYS_S.length;
const ANTHROPIC_VERSION = "2023-06-01";
const SDK_TIMEOUT_MS = 900_000;
const RETRY_STATUSES = new Set([408, 409, 429]);
const ENABLED_UNSUPPORTED = '"thinking.type.enabled" is not supported';
const ADAPTIVE_UNSUPPORTED = "adaptive thinking is not supported";

interface RunState {
  totals: RunTotals;
  lastRoot?: ModelCompleteParams;
  /** D-33: what came with a tool-call reply, by sha256(text + "\0" + tool call id). */
  replay: Map<string, Replay>;
  fake: FakeRunState;
  calls: Set<AbortController>;
  /** The engine said run.finished (or exited): only a finished run with no call left may be dropped from the history. */
  finished: boolean;
}

/** What one call needs once its provider is known. */
interface Call {
  p: ModelCompleteParams;
  def: ProviderDef;
  run: RunState;
  callId: string;
  signal: AbortSignal;
  info?: ModelInfo;
  key: ResolvedKey | null;
  baseUrl: string;
}

/** Most OpenRouter pins kept; the oldest go first. Prefix pins outlive their run, so the map is bounded. */
const PIN_CAP = 2000;

/** OpenRouter's `provider` field as an endpoint slug for `provider.order` (D-120): a slug passes through, a display
 *  name ("DeepInfra", "Amazon Bedrock") becomes its base slug ("deepinfra", "amazon-bedrock"). */
export function endpointSlug(provider: string): string {
  return /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/.test(provider) ? provider : provider.trim().toLowerCase().replace(/\s+/g, "-");
}

export class Gateway {
  /** Read at call time, so a caller may replace it after a settings change. */
  settings: Settings;
  private readonly keys: KeyStore;
  private readonly catalog: Catalog;
  private readonly bus: Bus<AppEvents>;
  private readonly fetchFn: typeof fetch;
  private readonly fake: FakeProvider;
  private readonly runs = new Map<string, RunState>();
  private readonly slots = new Map<string, Slots>();
  private readonly clients = new Map<string, OpenAI | Anthropic>();
  /** Parameter fallback, remembered for the process: `<provider>\0<model>` -> dropped fields. */
  private readonly dropped = new Map<string, Set<string>>();
  private readonly shapes = new Map<string, ThinkingShape>();
  /** OpenRouter: `<model>\0<routing key>` -> the endpoint slug that conversation is pinned to (D-120). */
  private readonly pins = new Map<string, string>();
  /** `<model>\0<slug>` OpenRouter refused to route to (400 or 404): never pinned again. */
  private readonly badPins = new Set<string>();
  private readonly gate: BatchGate;
  private nextCall = 0;

  constructor(opts: { keys: KeyStore; catalog: Catalog; settings: Settings; bus: Bus<AppEvents>; fetch?: typeof fetch; env?: Record<string, string | undefined> }) {
    this.keys = opts.keys;
    this.catalog = opts.catalog;
    this.settings = opts.settings;
    this.bus = opts.bus;
    this.fetchFn = ((u: Parameters<typeof fetch>[0], i?: Parameters<typeof fetch>[1]) => (opts.fetch ?? globalThis.fetch)(u, i)) as typeof fetch;
    this.fake = new FakeProvider(opts.env ?? process.env);
    this.gate = new BatchGate(LIMITS);
    this.bus.on("engine.event", (e) => {
      if (e.method !== "run.finished" || typeof e.params?.run_id !== "string") return;
      this.finishRun(this.runs.get(e.params.run_id));
      this.gate.dropRun(e.params.run_id);
      this.prune();
    });
    // an engine that exited took every run with it
    this.bus.on("engine.exit", () => {
      for (const run of this.runs.values()) this.finishRun(run);
      this.prune();
    });
  }

  async complete(p: ModelCompleteParams, signal?: AbortSignal): Promise<ModelCompleteResult> {
    const callId = `c${++this.nextCall}`;
    const startedAt = Date.now();
    this.bus.emit("call.start", {
      call_id: callId,
      run_id: p.run_id,
      role: p.role,
      ...(p.subcall_id !== undefined ? { subcall_id: p.subcall_id } : {}),
      ...(p.batch !== undefined ? { batch: p.batch } : {}),
      ...(p.origin !== undefined ? { origin: p.origin } : {}),
      model: p.model,
      prompt: p.messages[p.messages.length - 1]?.content ?? "",
      started_at: startedAt,
    });
    const run = this.run(p.run_id);
    if (p.role === "root") run.lastRoot = p;
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal?.reason);
    if (signal?.aborted) ac.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    run.calls.add(ac);
    const seconds = () => Math.round(Date.now() - startedAt) / 1000;
    try {
      const { result, usage, endpoint } = await this.call(p, run, callId, ac.signal);
      run.totals.add(p.role, usage);
      const done: ModelCompleteResult = { ...result, usage, seconds: seconds() };
      this.bus.emit("call.end", { call_id: callId, run_id: p.run_id, usage, finish_reason: done.finish_reason, seconds: done.seconds, endpoint: endpoint ?? null });
      return done;
    } catch (err) {
      const error = ac.signal.aborted ? this.error("cancelled", p, null, "The call was cancelled.") : this.asModelError(err, p);
      this.bus.emit("call.end", { call_id: callId, run_id: p.run_id, usage: emptyUsage(), finish_reason: "other", seconds: seconds(), error: error.data });
      throw error;
    } finally {
      run.calls.delete(ac);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Aborts every queued, waiting, sleeping and in-flight call of the run (model.cancel). */
  cancelRun(runId: string): void {
    const run = this.runs.get(runId);
    if (run) for (const ac of [...run.calls]) ac.abort(new Error("cancelled"));
    this.gate.dropRun(runId);
    // the run's own conversations are over; prefix pins (rlmh-<key>) outlive it, for the next run on the same input
    for (const key of [...this.pins.keys()]) {
      const route = key.slice(key.indexOf("\0") + 1);
      if (route === runId || route === `${runId}-sub`) this.pins.delete(key);
    }
  }

  totals(runId: string): { root: Usage; sub: Usage; cost_usd: number; cache_hit_rate: number | null } {
    return (this.runs.get(runId)?.totals ?? new RunTotals()).summary();
  }

  /** For /context. */
  lastRootRequest(runId: string): ModelCompleteParams | undefined {
    return this.runs.get(runId)?.lastRoot;
  }

  /** §7.4: auto is native only for an API provider whose catalog entry says tool_call. */
  resolveCallFormat(ref: ModelRef, setting: "auto" | "fenced" | "native"): "fenced" | "native" {
    if (setting !== "auto") return setting;
    return provider(ref.provider)?.api && this.catalog.get(ref.provider, ref.model)?.tool_call === true ? "native" : "fenced";
  }

  /** The only non-model request, made on click only: one GET per page, 30 s each, no retries. */
  async refreshModels(providerId: string): Promise<ModelInfo[]> {
    const def = provider(providerId);
    const ref: ModelCompleteParams = { run_id: "", role: "root", model: { provider: providerId, model: "", thinking: null }, messages: [], tools: [], max_tokens: 0, temperature: 0, thinking: "off", turn: 0 };
    if (!def || def.client === "fake") throw this.error("other", ref, null, `${providerName(providerId)} has no model list to refresh.`);
    const key = await this.resolveKey(def, ref);
    const baseUrl = this.baseUrl(def, ref);
    const headers: Record<string, string> = {};
    if (def.client === "anthropic") {
      headers["x-api-key"] = key?.key ?? "";
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    } else if (key) {
      headers.authorization = `Bearer ${key.key}`;
    }
    let bytesLeft = LIMITS.MAX_MODEL_LIST_BYTES; // all pages of one refresh share it
    const get = async (url: string): Promise<Record<string, any>> => {
      let res: Response;
      let body: { text: string; bytes: number } | null;
      try {
        res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(LIMITS.REFRESH_TIMEOUT_MS) });
        body = await readBounded(res, bytesLeft); // the same signal covers the body, so a trickle ends at the timeout
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw this.failureError({ kind: timedOut ? "timeout" : "network", status: null, detail: causeText(err) }, def, ref, key, baseUrl, 1);
      }
      if (body === null) {
        throw this.failureError({ kind: "bad_stream", status: res.status, detail: `the model list is larger than ${formatBytes(LIMITS.MAX_MODEL_LIST_BYTES)}, so it was not read` }, def, ref, key, baseUrl, 1);
      }
      bytesLeft -= body.bytes;
      const text = body.text;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (!res.ok) {
        const body = data as { error?: { message?: unknown }; message?: unknown } | null;
        const detail = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : text;
        throw this.failureError({ kind: "http", status: res.status, detail, headers: res.headers }, def, ref, key, baseUrl, 1);
      }
      if (typeof data !== "object" || data === null || !Array.isArray((data as { data?: unknown }).data)) {
        throw this.failureError({ kind: "bad_stream", status: res.status, detail: "the model list has no data array" }, def, ref, key, baseUrl, 1);
      }
      return data as Record<string, any>;
    };

    const rows: Record<string, any>[] = [];
    const root = baseUrl.replace(/\/+$/, "");
    if (def.client === "anthropic") {
      let after: string | null = null;
      for (let page = 0; page < LIMITS.REFRESH_MAX_PAGES; page++) {
        const data = await get(`${root}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`);
        rows.push(...data.data);
        if (data.has_more !== true || typeof data.last_id !== "string") break;
        after = data.last_id;
      }
    } else {
      rows.push(...(await get(`${root}/models`)).data);
    }
    const models: ModelInfo[] = [];
    for (const row of rows) {
      if (typeof row?.id !== "string" || row.id === "") continue;
      const id = def.id === "gemini" ? row.id.replace(/^models\//, "") : row.id;
      models.push(fetchedModel(def.id, id, row, this.catalog.get(def.id, id)));
    }
    this.catalog.merge(def.id, models);
    return models;
  }

  // -- one call --

  private async call(p: ModelCompleteParams, run: RunState, callId: string, signal: AbortSignal): Promise<{ result: Omit<ModelCompleteResult, "usage" | "seconds">; usage: Usage; endpoint?: string | null }> {
    const def = provider(p.model.provider);
    if (!def) throw this.error("other", p, null, `Unknown provider "${p.model.provider}" in ${p.model.provider}/${p.model.model}.`);
    const info = this.catalog.get(def.id, p.model.model);
    const key = def.client === "fake" ? null : await this.resolveKey(def, p);
    const baseUrl = def.client === "fake" ? "" : this.baseUrl(def, p);
    this.windowCheck(p, info);
    const c: Call = { p, def, run, callId, signal, info, key, baseUrl };
    if (def.client === "fake") return this.fakeCall(c);

    let ticket: BatchTicket | null = null;
    if (p.role === "sub" && p.batch && p.batch.size > 1 && def.caching !== "none") {
      const member = { index: p.batch.index, size: p.batch.size, prompt: p.messages[p.messages.length - 1]?.content ?? "" };
      // with a stable prefix the call marks its own block, so Anthropic needs only the leader-first order (D-119)
      const caching = p.prefix && def.caching === "anthropic" ? "auto" : def.caching;
      const opts = { caching, cacheMinTokens: info?.cache_min_tokens ?? null, split: ANTHROPIC_SPLIT_PREFIX };
      ticket = await this.gate.enter(`${p.run_id}\0${p.batch.id}`, member, opts, signal);
    }
    try {
      return await this.attempts(c, ticket);
    } finally {
      ticket?.end();
    }
  }

  private async attempts(c: Call, ticket: BatchTicket | null): Promise<{ result: Omit<ModelCompleteResult, "usage" | "seconds">; usage: Usage; endpoint?: string | null }> {
    const { p, def, signal } = c;
    const slots = this.slotsFor(def.id);
    let held = false; // the slot is given back while sleeping, so the final give must know
    const take = async () => {
      await slots.take(signal);
      held = true;
    };
    const give = () => {
      if (held) slots.give();
      held = false;
    };
    let sent = false;
    let fallbacks = 0;
    let unpinned = false;
    const hooks: StreamHooks = {
      maxBytes: LIMITS.MAX_RESPONSE_BYTES,
      onEvent: () => {},
      onContent: () => ticket?.content(),
      onText: (text) => {
        sent = true;
        this.bus.emit("call.delta", { call_id: c.callId, text });
      },
      onReasoning: (reasoning) => {
        sent = true;
        this.bus.emit("call.delta", { call_id: c.callId, reasoning });
      },
    };
    await take();
    try {
      for (let attempt = 0; ; ) {
        let out: StreamResult;
        try {
          out = await this.attempt(c, this.buildBody(c, ticket), hooks);
        } catch (err) {
          if (signal.aborted) throw err;
          const f = err instanceof AttemptError ? err.failure : { kind: "network" as const, status: null, detail: causeText(err) };
          if (sent) {
            this.bus.emit("call.delta", { call_id: c.callId, reset: true });
            sent = false;
          }
          if (fallbacks < RETRY.MAX_FALLBACKS && this.fallback(c, f)) {
            fallbacks += 1; // not a retry: no sleep, and the try count stays
            continue;
          }
          if (!unpinned && this.unpin(c, f)) {
            unpinned = true; // the pinned endpoint failed: try once more wherever OpenRouter routes, and pin there (D-120)
            continue;
          }
          if (!retryable(f) || attempt + 1 >= TRIES) throw this.failureError(f, def, p, c.key, c.baseUrl, attempt + 1);
          give();
          await RETRY.sleep(this.delayMs(attempt, f.headers), signal);
          if (signal.aborted) throw signal.reason;
          await take();
          attempt += 1;
          continue;
        }
        this.pin(c, out);
        return this.finish(c, out);
      }
    } finally {
      give();
    }
  }

  // -- OpenRouter endpoint pins (D-120) --

  private pinKey(c: Call): string {
    return `${openRouterEndpoint(c.p.model.model).model}\0${routeKey(c.p)}`;
  }

  /** The endpoint this call must use: the one chosen in the model ref, else the one its conversation is pinned to. */
  private endpointFor(c: Call): string | null {
    if (c.def.id !== "openrouter") return null;
    return openRouterEndpoint(c.p.model.model).endpoint ?? this.pins.get(this.pinKey(c)) ?? null;
  }

  /** After a success: the first endpoint that served a conversation becomes its pin. */
  private pin(c: Call, out: StreamResult): void {
    if (c.def.id !== "openrouter" || !out.provider || openRouterEndpoint(c.p.model.model).endpoint) return;
    const key = this.pinKey(c);
    const slug = endpointSlug(out.provider);
    if (this.pins.has(key) || this.badPins.has(`${openRouterEndpoint(c.p.model.model).model}\0${slug}`)) return;
    this.pins.set(key, slug);
    while (this.pins.size > PIN_CAP) this.pins.delete(this.pins.keys().next().value!);
  }

  /** A pinned call failed: drop the gateway's pin (never the user's choice). A 400 or 404 means OpenRouter can't route
   *  to that endpoint at all, so it is never pinned again for this model. True when there was a pin to drop. */
  private unpin(c: Call, f: Failure): boolean {
    if (c.def.id !== "openrouter" || openRouterEndpoint(c.p.model.model).endpoint) return false;
    const key = this.pinKey(c);
    const slug = this.pins.get(key);
    if (slug === undefined) return false;
    this.pins.delete(key);
    if (f.kind === "http" && (f.status === 400 || f.status === 404)) this.badPins.add(`${openRouterEndpoint(c.p.model.model).model}\0${slug}`);
    return true;
  }

  private buildBody(c: Call, ticket: BatchTicket | null): Record<string, unknown> {
    const { p, def, run } = c;
    const modelKey = `${def.id}\0${p.model.model}`;
    const dropped = this.dropped.get(modelKey) ?? new Set<string>();
    const replay = (m: Extract<Message, { role: "assistant" }>) => (m.tool_call ? run.replay.get(replayKey(m.content, m.tool_call.id)) : undefined);
    const markers = p.role === "root" || (ticket?.marker ?? false);
    const prefixMark = prefixWorthMarking(p, c.info?.cache_min_tokens ?? null);
    if (def.client === "anthropic") return buildAnthropicRequest(p, { shape: this.shapes.get(modelKey), dropped, markers, prefixMark, replay });
    return buildOpenAIRequest(p, { provider: def, info: c.info, dropped, replay, markers, prefixMark, endpoint: this.endpointFor(c) });
  }

  /** One streamed attempt with its idle and total timeouts. */
  private async attempt(c: Call, body: Record<string, unknown>, hooks: StreamHooks): Promise<StreamResult> {
    const ac = new AbortController();
    let timedOut = false;
    const fire = () => {
      timedOut = true;
      ac.abort(new Error("timeout"));
    };
    const onOuter = () => ac.abort(c.signal.reason);
    c.signal.addEventListener("abort", onOuter, { once: true });
    const idleMs = c.def.id === "local" || c.def.id === "custom" ? LIMITS.IDLE_TIMEOUT_LOCAL_MS : LIMITS.IDLE_TIMEOUT_MS;
    let idle = setTimeout(fire, idleMs);
    const total = setTimeout(fire, LIMITS.TOTAL_TIMEOUT_MS);
    const timed: StreamHooks = {
      ...hooks,
      onEvent: () => {
        clearTimeout(idle);
        idle = setTimeout(fire, idleMs);
      },
      maxBytes: LIMITS.MAX_RESPONSE_BYTES,
    };
    try {
      const out = c.def.client === "anthropic" ? await streamAnthropic(this.client(c) as Anthropic, body, timed, ac.signal) : await streamOpenAI(this.client(c) as OpenAI, body, timed, ac.signal);
      // The SDKs end iteration quietly when the signal aborts, so a result proves nothing about how the stream ended:
      // an idle or total timeout, or a cancel after content began, must not pass as an answer.
      if (ac.signal.aborted) throw new AttemptError({ kind: "aborted", status: null, detail: "aborted" });
      return out;
    } catch (err) {
      if (timedOut && !c.signal.aborted) throw new AttemptError({ kind: "timeout", status: null, detail: "no answer in time" });
      throw err;
    } finally {
      clearTimeout(idle);
      clearTimeout(total);
      c.signal.removeEventListener("abort", onOuter);
    }
  }

  /** Step 7 of the spec: drop a field a 400/422 named, or switch Anthropic's thinking shape. Remembered for the process. */
  private fallback(c: Call, f: Failure): boolean {
    if (f.kind !== "http" || (f.status !== 400 && f.status !== 422)) return false;
    const modelKey = `${c.def.id}\0${c.p.model.model}`;
    if (c.def.client === "anthropic" && f.status === 400) {
      const shape = f.detail.includes(ENABLED_UNSUPPORTED) ? "adaptive" : f.detail.includes(ADAPTIVE_UNSUPPORTED) ? "budget" : null;
      if (shape && this.shapes.get(modelKey) !== shape) {
        this.shapes.set(modelKey, shape);
        return true;
      }
    }
    const body = this.buildBody(c, null);
    for (const field of DROPPABLE_FIELDS) {
      if (!(field in body) || !new RegExp(`(?<![a-z_])${field}(?![a-z_])`).test(f.detail)) continue;
      const set = this.dropped.get(modelKey) ?? new Set<string>();
      set.add(field);
      this.dropped.set(modelKey, set);
      return true;
    }
    return false;
  }

  private delayMs(attempt: number, headers?: Headers): number {
    let ms = RETRY.DELAYS_S[attempt]! * 1000 * (0.5 + RETRY.random());
    const after = retryAfterMs(headers);
    if (after !== null) ms = Math.max(ms, Math.min(after, RETRY.RETRY_AFTER_MAX_S * 1000));
    return ms;
  }

  private finish(c: Call, out: StreamResult): { result: Omit<ModelCompleteResult, "usage" | "seconds">; usage: Usage; endpoint?: string | null } {
    const { p, def, run } = c;
    let toolCall: ToolCall | null = null;
    if (out.toolCall) {
      toolCall = { id: out.toolCall.id ?? `call_${p.run_id}_${p.turn}`, name: out.toolCall.name, arguments: parseArguments(out.toolCall.arguments) };
    }
    const finish = toolCall && out.finish !== "length" ? "tool_call" : (out.finish ?? "stop");
    if (toolCall) {
      const replay = pickReplay(def.id, out.replay);
      if (replay) run.replay.set(replayKey(out.text, toolCall.id), replay);
    }
    const usage = toUsage(out.usage, c.info, { input: requestChars(p), output: replyChars(out.text, toolCall) });
    const billed = def.id === "openrouter" ? billedCost(out.usage) : null;
    if (billed !== null) usage.cost_usd = billed; // what OpenRouter charged, whichever endpoint served it (D-121)
    return {
      result: { text: out.text, tool_call: toolCall, reasoning: out.reasoning === "" ? null : out.reasoning, finish_reason: finish, served_model: out.served ?? p.model.model },
      usage,
      endpoint: out.provider,
    };
  }

  private async fakeCall(c: Call): Promise<{ result: Omit<ModelCompleteResult, "usage" | "seconds">; usage: Usage; endpoint?: string | null }> {
    const slots = this.slotsFor(c.def.id);
    await slots.take(c.signal);
    try {
      const reply = await this.fake.complete(c.p, c.run.fake, (text) => this.bus.emit("call.delta", { call_id: c.callId, text }), c.signal);
      const usage = toUsage(null, c.info, { input: requestChars(c.p), output: replyChars(reply.text, reply.tool_call) });
      return { result: { text: reply.text, tool_call: reply.tool_call, reasoning: null, finish_reason: reply.finish_reason, served_model: "scripted" }, usage };
    } catch (err) {
      if (err instanceof FakeError) throw this.error(err.kind, c.p, err.status, err.message);
      throw err;
    } finally {
      slots.give();
    }
  }

  // -- keys, URLs, clients, limits --

  private async resolveKey(def: ProviderDef, p: ModelCompleteParams): Promise<ResolvedKey | null> {
    let key: ResolvedKey | null;
    try {
      key = await this.keys.resolve(def.id);
    } catch (err) {
      const cause = err instanceof KeyReadError || err instanceof Error ? err.message : String(err);
      throw this.error("other", p, null, `Could not read the key for ${def.name} from the OS key store (${cause}). Re-enter it in /providers.`);
    }
    if (!key && def.needsKey) throw this.error("no_key", p, null, `No API key for ${def.name}. Add one in /providers.`);
    return key;
  }

  private baseUrl(def: ProviderDef, p: ModelCompleteParams): string {
    if (def.baseUrl) return def.baseUrl;
    const url = String(getSetting(this.settings, `providers.${def.id}.base_url`));
    if (url === "") throw this.error("other", p, null, `No base URL for the ${def.id} provider. Set providers.${def.id}.base_url in /settings.`);
    return url;
  }

  /** D-25, root calls only: ceil(chars / 3) + max_tokens against a known window. */
  private windowCheck(p: ModelCompleteParams, info?: ModelInfo): void {
    if (p.role !== "root" || !info || info.context_window <= 0) return;
    const prompt = Math.ceil(requestChars(p) / 3);
    const est = prompt + p.max_tokens;
    if (est <= info.context_window) return;
    throw this.error(
      "context_window",
      p,
      null,
      `This request would not fit in ${p.model.model}'s context window: about ${est} tokens (prompt about ${prompt} plus up to ${p.max_tokens} for the reply) against ${info.context_window}. Choose a model with a larger window in /model, or lower the limits in the profile.`,
    );
  }

  /** Cached per provider, base URL and key. Both SDKs: no retries of their own, our fetch, a pinned wire, and no ambient headers. */
  private client(c: Call): OpenAI | Anthropic {
    const apiKey = c.key?.key ?? "none"; // the SDKs need a non-empty key
    const id = `${c.def.id}\0${c.baseUrl}\0${apiKey}`;
    let client = this.clients.get(id);
    if (!client) {
      const common = { apiKey, baseURL: c.baseUrl, maxRetries: 0, timeout: SDK_TIMEOUT_MS, fetch: this.fetchFn, logLevel: "off" as const };
      client = withoutAmbientHeaders(() =>
        c.def.client === "anthropic"
          ? new Anthropic({ ...common, defaultHeaders: { "anthropic-version": ANTHROPIC_VERSION } })
          : new OpenAI({ ...common, organization: null, project: null }), // never send OPENAI_ORG_ID to another provider
      );
      this.clients.set(id, client);
    }
    return client;
  }

  private slotsFor(id: string): Slots {
    let s = this.slots.get(id);
    if (!s) {
      s = new Slots(() => Number(getSetting(this.settings, `providers.${id}.max_in_flight`)));
      this.slots.set(id, s);
    }
    return s;
  }

  /** The run's state, made the newest. A run lives from its first call until run.finished, however many overlap: its
   *  cancel handles, replay table, scripted position and totals are needed to the end. Only finished runs are history. */
  private run(runId: string): RunState {
    let run = this.runs.get(runId);
    if (run) this.runs.delete(runId);
    else run = { totals: new RunTotals(), replay: new Map(), fake: newFakeRunState(), calls: new Set(), finished: false };
    this.runs.set(runId, run);
    this.prune();
    return run;
  }

  private finishRun(run: RunState | undefined): void {
    if (!run) return;
    run.finished = true;
    run.replay.clear();
  }

  /** The oldest finished runs go once more than LIMITS.RUNS_KEPT are kept; an unfinished run, or one with a call still
   *  open, is never dropped. `runs` is in order of last use, oldest first. */
  private prune(): void {
    let excess = -LIMITS.RUNS_KEPT;
    for (const run of this.runs.values()) if (run.finished) excess += 1;
    for (const [id, run] of this.runs) {
      if (excess <= 0) break;
      if (!run.finished || run.calls.size > 0) continue;
      this.runs.delete(id);
      excess -= 1;
    }
  }

  // -- errors --

  private error(kind: ModelErrorKind, p: ModelCompleteParams, status: number | null, message: string): ModelError {
    return new ModelError({ kind, provider: p.model.provider, model: p.model.model, status, message });
  }

  private asModelError(err: unknown, p: ModelCompleteParams): ModelError {
    if (err instanceof ModelError) return err;
    return this.error("other", p, null, `internal error: ${redact(err instanceof Error ? err.message : String(err))}`);
  }

  /** The errors table. `tries` is how many tries were made; " after N tries" shows only after retries. */
  private failureError(f: Failure, def: ProviderDef, p: ModelCompleteParams, key: ResolvedKey | null, baseUrl: string, tries: number): ModelError {
    const P = def.name;
    const after = tries > 1 ? ` after ${tries} tries` : "";
    const detail = redact(f.detail, key?.key);
    const s = f.status;
    switch (f.kind) {
      case "aborted":
        return this.error("cancelled", p, null, "The call was cancelled.");
      case "timeout":
        return this.error("timeout", p, null, `${P} did not answer in time${after}.`);
      case "network": {
        let message = `Could not reach ${P} at ${hostOf(baseUrl)}${after}: ${detail}`;
        if (def.id === "local") message += ` Is the server running? If it is, try http://127.0.0.1:${portOf(baseUrl)}/v1 in /settings.`;
        return this.error("network", p, null, message);
      }
      case "stream":
        return this.error("server", p, null, `${P} failed with an error inside the stream${after}: ${detail}`);
      case "bad_stream":
        return this.error("other", p, s, `${P} returned a stream that could not be read: ${detail}`);
      case "http":
        break;
    }
    if (s === 401 || s === 403) {
      if (!key) return this.error("auth", p, s, `${P} rejected the request (HTTP ${s}) and no key is saved. Add one in /providers.`);
      const last4 = last4Of(key.key); // "" for a short key, which shows no part of itself
      const tail = last4 === "" ? "" : ` (ends in ${last4})`;
      if (key.source === "env") return this.error("auth", p, s, `${P} rejected the key "$${key.envVar ?? def.envVar}"${tail}. Fix that variable, or save a key in /providers.`);
      return this.error("auth", p, s, `${P} rejected the key "${key.info?.label ?? "?"}"${tail}. Re-enter or delete it in /providers.`);
    }
    if (s === 400 || s === 413 || s === 422) return this.error("bad_request", p, s, `${P} refused the request (HTTP ${s}): ${detail}`);
    if (s === 404) return this.error("unknown_model", p, s, `${P} has no model "${p.model.model}" (HTTP 404). Pick another in /model, or use Refresh models in /providers.`);
    if (s === 429 && isQuota(f)) return this.error("rate_limit", p, s, `${P} says the account is out of quota or credit (HTTP 429): ${detail}`);
    if (s === 429) return this.error("rate_limit", p, s, `${P} is rate limiting requests (HTTP 429)${after}: ${detail}`);
    if (s === 408) return this.error("timeout", p, s, `${P} did not answer in time${after}.`);
    if (s !== null && s >= 500) return this.error("server", p, s, `${P} failed with HTTP ${s}${after}: ${detail}`);
    return this.error("other", p, s, `${P} returned HTTP ${s}: ${detail}`);
  }
}

/**
 * The variables both SDKs merge into the headers of every request they send (`OPENAI_CUSTOM_HEADERS`,
 * `ANTHROPIC_CUSTOM_HEADERS`: "Name: value" lines, read once in the constructor; no constructor option switches that
 * off). They often carry a corporate gateway's credential, which would go to whichever provider the next call names,
 * so a client is built with them removed from the environment, and they are put back after (D-76).
 */
const AMBIENT_HEADER_VARS = ["OPENAI_CUSTOM_HEADERS", "ANTHROPIC_CUSTOM_HEADERS"] as const;

function withoutAmbientHeaders<T>(build: () => T): T {
  const saved = AMBIENT_HEADER_VARS.map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];
  try {
    return build(); // synchronous: nothing else runs while the variables are away
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
}

/** First come, first served; the limit is read each time a slot is taken or freed. */
class Slots {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly limit: () => number;

  constructor(limit: () => number) {
    this.limit = limit;
  }

  take(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.queue.length === 0 && this.active < this.limit()) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal.reason);
      };
      this.queue.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  give(): void {
    this.active -= 1;
    while (this.queue.length > 0 && this.active < this.limit()) this.queue.shift()!();
  }
}

// -- helpers --

function retryable(f: Failure): boolean {
  if (f.kind === "stream" || f.kind === "network" || f.kind === "timeout") return true;
  if (f.kind !== "http" || f.status === null) return false;
  if (f.status === 429) return !isQuota(f);
  return RETRY_STATUSES.has(f.status) || f.status >= 500;
}

function isQuota(f: Failure): boolean {
  return f.code === "insufficient_quota" || f.detail.includes("insufficient_quota");
}

/** `retry-after-ms`, else `Retry-After` in seconds or as an HTTP date. */
function retryAfterMs(headers?: Headers): number | null {
  if (!headers) return null;
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const s = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(s) && s >= 0) return s * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** The provider's message with the key and any Bearer or sk- token taken out, cut to 300 characters. */
function redact(detail: string, key?: string): string {
  let text = detail;
  if (key && key !== "none") text = text.split(key).join("[key]");
  text = text.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [key]").replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+/g, "[key]");
  return text.length > LIMITS.DETAIL_CHARS ? text.slice(0, LIMITS.DETAIL_CHARS) : text;
}

/** The body as text, read in chunks and given up on as soon as it passes `limit` bytes (the rest is never read): null then. */
async function readBounded(res: Response, limit: number): Promise<{ text: string; bytes: number } | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), bytes };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function portOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return "8000";
  }
}

function replayKey(text: string, toolCallId: string): string {
  return createHash("sha256").update(`${text}\0${toolCallId}`).digest("hex");
}

/** The replay table (D-33): what each provider needs back. */
function pickReplay(providerId: string, r: Replay): Replay | null {
  if (providerId === "anthropic" && r.thinking_blocks) return { thinking_blocks: r.thinking_blocks };
  if (providerId === "deepseek" && r.reasoning_content !== undefined) return { reasoning_content: r.reasoning_content };
  if (providerId === "openrouter" && r.reasoning_details) return { reasoning_details: r.reasoning_details };
  if (providerId === "gemini" && r.extra_content !== undefined) return { extra_content: r.extra_content };
  return null;
}

/** Streamed arguments as an object; anything that isn't a JSON object gives {} (D-74). */
function parseArguments(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json === "" ? "{}" : json);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** A refreshed model: the catalog's entry when there is one, else zeros; OpenRouter fills its own fields. */
function fetchedModel(providerId: string, id: string, row: Record<string, any>, known?: ModelInfo): ModelInfo {
  const m: ModelInfo = known
    ? { ...known, price: { ...known.price } }
    : { provider: providerId, id, name: id, context_window: 0, max_output: 0, price: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, tool_call: false, reasoning: false, cache_min_tokens: null };
  if (typeof row.display_name === "string" && !known) m.name = row.display_name;
  if (providerId !== "openrouter") return m;
  if (typeof row.name === "string") m.name = row.name;
  if (typeof row.context_length === "number") m.context_window = row.context_length;
  const maxOut = row.top_provider?.max_completion_tokens;
  if (typeof maxOut === "number") m.max_output = maxOut;
  // per token to per 1M, rounded to 9 decimals as build-catalog.ts does; a negative price (a variable-price router) keeps the fallback
  const perM = (v: unknown, fallback: number) => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e9) / 1e9 : fallback;
  };
  const pr = row.pricing ?? {};
  m.price = { input: perM(pr.prompt, m.price.input), output: perM(pr.completion, m.price.output), cache_read: perM(pr.input_cache_read, m.price.cache_read), cache_write: perM(pr.input_cache_write, m.price.cache_write) };
  if (Array.isArray(row.supported_parameters)) {
    m.tool_call = row.supported_parameters.includes("tools");
    m.reasoning = row.supported_parameters.includes("reasoning");
  }
  return m;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
