// KV cache: none
// The errors table of step 5, message by message, against the fake server; keys kept out of errors,
// events and run state; the window check; cancelling queued, sleeping and in-flight calls;
// resolveCallFormat over every provider; ModelError's code. Every retrying test records sleeps.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Bus } from "../../src/bus.ts";
import { Catalog, type ModelInfo } from "../../src/gateway/catalog.ts";
import { Gateway, ModelError, RETRY, type AppEvents } from "../../src/gateway/gateway.ts";
import { KeyStore, type SecretsLike } from "../../src/gateway/keys.ts";
import { PROVIDERS } from "../../src/gateway/providers.ts";
import { RpcError } from "../../src/link.ts";
import type { ModelCompleteParams, ToolDef } from "../../src/protocol.ts";
import { defaultSettings } from "../../src/settings.ts";
import { anthropicStream, httpError, openaiStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { caught, KEYS, limits, memorySecrets, params, recordSleeps, ref, rig, sub, type Rig } from "./helpers.ts";

const ANTHROPIC = ref("anthropic", "claude-haiku-4-5");
const OPENAI = ref("openai", "gpt-4.1");

let server: FakeServer;
let sleeps: ReturnType<typeof recordSleeps>;
const rigs: Rig[] = [];
const restores: (() => void)[] = [];

beforeAll(() => {
  server = startFakeProvider();
});
afterAll(() => {
  server.stop();
});
beforeEach(() => {
  server.requests.length = 0;
  sleeps = recordSleeps();
});
afterEach(() => {
  sleeps.restore();
  for (const restore of restores.splice(0)) restore();
  for (const r of rigs.splice(0)) r.cleanup();
});

async function make(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig({ server, ...opts });
  rigs.push(r);
  return r;
}

async function fails(r: Rig, p: ModelCompleteParams, signal?: AbortSignal): Promise<ModelError> {
  const err = await caught(r.gateway.complete(p, signal));
  expect(err).toBeInstanceOf(ModelError);
  return err as ModelError;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(2);
  }
}

describe("errors table", () => {
  test("no_key", async () => {
    const r = await make();
    const err = await fails(r, params(ANTHROPIC));
    expect(err.data).toEqual({ kind: "no_key", provider: "anthropic", model: "claude-haiku-4-5", status: null, message: "No API key for Anthropic. Add one in /providers." });
    expect(server.requests).toHaveLength(0);
  });

  test("auth: a saved key", async () => {
    const r = await make({ keys: ["anthropic"] });
    server.script(() => httpError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    const err = await fails(r, params(ANTHROPIC));
    expect(err.message).toBe('Anthropic rejected the key "work" (ends in 3f9a). Re-enter or delete it in /providers.');
    expect(err.data).toMatchObject({ kind: "auth", status: 401 });
    expect(server.requests).toHaveLength(1);
    expect(sleeps.delays).toEqual([]);

    server.script(() => httpError(403));
    const err403 = await fails(r, params(ANTHROPIC));
    expect(err403.message).toBe('Anthropic rejected the key "work" (ends in 3f9a). Re-enter or delete it in /providers.');
    expect(err403.data.status).toBe(403);
  });

  test("auth: an environment key", async () => {
    const r = await make({ env: { ANTHROPIC_API_KEY: KEYS.anthropic! } });
    server.script(() => httpError(401));
    const err = await fails(r, params(ANTHROPIC));
    expect(err.message).toBe('Anthropic rejected the key "$ANTHROPIC_API_KEY" (ends in 3f9a). Fix that variable, or save a key in /providers.');
    expect(err.data).toMatchObject({ kind: "auth", status: 401 });

    const g = await make({ env: { GOOGLE_API_KEY: KEYS.gemini! } });
    const gerr = await fails(g, params(ref("gemini", "gemini-2.5-flash")));
    expect(gerr.message).toBe(`Google Gemini rejected the key "$GOOGLE_API_KEY" (ends in ${KEYS.gemini!.slice(-4)}). Fix that variable, or save a key in /providers.`);
  });

  test("auth: no key at all", async () => {
    server.script(() => httpError(401));
    const local = await make();
    const err = await fails(local, params(ref("local", "qwen")));
    expect(err.message).toBe("Local server rejected the request (HTTP 401) and no key is saved. Add one in /providers.");
    expect(err.data).toMatchObject({ kind: "auth", status: 401 });

    const custom = await make({ settings: { "providers.custom.base_url": "http://127.0.0.1:9/v1" } });
    server.script(() => httpError(403));
    const cerr = await fails(custom, params(ref("custom", "anything")));
    expect(cerr.message).toBe("Custom endpoint rejected the request (HTTP 403) and no key is saved. Add one in /providers.");
  });

  test("bad_request: 400, 413 and 422", async () => {
    const r = await make({ keys: ["openai"] });
    for (const status of [400, 413, 422]) {
      server.requests.length = 0;
      server.script(() => httpError(status, { error: { message: `messages[1] is malformed (${status})`, type: "invalid_request_error" } }));
      const err = await fails(r, params(OPENAI));
      expect(err.message).toBe(`OpenAI refused the request (HTTP ${status}): messages[1] is malformed (${status})`);
      expect(err.data).toMatchObject({ kind: "bad_request", status });
      expect(server.requests).toHaveLength(1);
    }
    expect(sleeps.delays).toEqual([]);
  });

  test("bad_request after the parameter fallback", async () => {
    const r = await make({ keys: ["deepseek"] });
    server.script(() => httpError(400, { error: { message: "temperature is not supported here" } }));
    const err = await fails(r, params(ref("deepseek", "deepseek-v4-pro")));
    expect(err.message).toBe("DeepSeek refused the request (HTTP 400): temperature is not supported here");
    expect(server.requests).toHaveLength(2);
    expect("temperature" in server.requests[0]!.body).toBe(true);
    expect("temperature" in server.requests[1]!.body).toBe(false);
    expect(sleeps.delays).toEqual([]);
  });

  test("unknown_model", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => httpError(404, { error: { message: "The model does not exist", code: "model_not_found" } }));
    const err = await fails(r, params(ref("openai", "gpt-nope")));
    expect(err.message).toBe('OpenAI has no model "gpt-nope" (HTTP 404). Pick another in /model, or use Refresh models in /providers.');
    expect(err.data).toMatchObject({ kind: "unknown_model", status: 404, model: "gpt-nope" });
    expect(server.requests).toHaveLength(1);
  });

  test("rate_limit after 7 tries", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => httpError(429, { error: { message: "Rate limit reached", type: "requests" } }));
    const err = await fails(r, params(OPENAI));
    expect(err.message).toBe("OpenAI is rate limiting requests (HTTP 429) after 7 tries: Rate limit reached");
    expect(err.data).toMatchObject({ kind: "rate_limit", status: 429 });
    expect(server.requests).toHaveLength(7);
    expect(sleeps.delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
  });

  test("rate_limit: quota, with no retries", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => httpError(429, { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }));
    const err = await fails(r, params(OPENAI));
    expect(err.message).toBe("OpenAI says the account is out of quota or credit (HTTP 429): You exceeded your current quota.");
    expect(err.data).toMatchObject({ kind: "rate_limit", status: 429 });
    expect(server.requests).toHaveLength(1);
    expect(sleeps.delays).toEqual([]);
  });

  test("server after 7 tries", async () => {
    const r = await make({ keys: ["anthropic"] });
    server.script(() => httpError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    const err = await fails(r, params(ANTHROPIC));
    expect(err.message).toBe("Anthropic failed with HTTP 529 after 7 tries: Overloaded");
    expect(err.data).toMatchObject({ kind: "server", status: 529 });
    expect(server.requests).toHaveLength(7);
    expect(sleeps.delays).toHaveLength(6);
  });

  test("timeout: 408 after 7 tries", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => httpError(408, { error: { message: "Request timeout" } }));
    const err = await fails(r, params(OPENAI));
    expect(err.message).toBe("OpenAI did not answer in time after 7 tries.");
    expect(err.data).toMatchObject({ kind: "timeout", status: 408 });
    expect(server.requests).toHaveLength(7);
  });

  test("timeout: idle after 7 tries", async () => {
    restores.push(limits({ IDLE_TIMEOUT_MS: 40 }));
    const r = await make({ keys: ["openai"] });
    server.script(() => openaiStream({ text: "late", holdFirstChunkMs: 1000 }));
    const t0 = Date.now();
    const err = await fails(r, params(OPENAI));
    expect(err.message).toBe("OpenAI did not answer in time after 7 tries.");
    expect(err.data).toMatchObject({ kind: "timeout", status: null });
    expect(server.requests).toHaveLength(7);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("network: a server that is gone, after 7 tries", async () => {
    const gone = startFakeProvider();
    gone.stop();
    let tries = 0;
    const real = gone.redirectFetch(globalThis.fetch);
    const fetchFn = ((u: Parameters<typeof fetch>[0], i?: Parameters<typeof fetch>[1]) => {
      tries += 1;
      return real(u, i);
    }) as typeof fetch;
    const r = await make({ keys: ["openai"], fetch: fetchFn });
    const err = await fails(r, params(OPENAI));
    expect(err.message).toMatch(/^Could not reach OpenAI at api\.openai\.com after 7 tries: \S.*$/);
    expect(err.data).toMatchObject({ kind: "network", status: null });
    expect(tries).toBe(7);
    expect(sleeps.delays).toHaveLength(6);

    const local = await make({ fetch: fetchFn });
    const lerr = await fails(local, params(ref("local", "qwen")));
    expect(lerr.message).toMatch(/^Could not reach Local server at localhost:8000 after 7 tries: \S.*/);
    expect(lerr.message.endsWith(" Is the server running? If it is, try http://127.0.0.1:8000/v1 in /settings.")).toBe(true);
  });

  test("other: 402 and another 4xx, not retried", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => httpError(402, { error: { message: "Payment required" } }));
    const err = await fails(r, params(OPENAI));
    expect(err.message).toBe("OpenAI returned HTTP 402: Payment required");
    expect(err.data).toMatchObject({ kind: "other", status: 402 });
    server.script(() => httpError(418, { error: { message: "I'm a teapot" } }));
    expect((await fails(r, params(OPENAI))).message).toBe("OpenAI returned HTTP 418: I'm a teapot");
    expect(server.requests).toHaveLength(2);
    expect(sleeps.delays).toEqual([]);
  });

  test("other: the key store can't be read", async () => {
    const mem = memorySecrets();
    const secrets: SecretsLike = {
      get: async () => {
        throw new Error("FAKE keychain is locked");
      },
      set: mem.set,
      delete: mem.delete,
    };
    const home = (await make()).home;
    const keys = new KeyStore({ home, secrets, env: {} });
    await keys.add("anthropic", KEYS.anthropic!, "work");
    const gateway = new Gateway({ keys, catalog: new Catalog(home), settings: defaultSettings(), bus: new Bus<AppEvents>(), fetch: server.redirectFetch(), env: {} });
    const err = await caught(gateway.complete(params(ANTHROPIC)));
    expect(err).toBeInstanceOf(ModelError);
    expect(err.message).toBe("Could not read the key for Anthropic from the OS key store (FAKE keychain is locked). Re-enter it in /providers.");
    expect(err.data).toMatchObject({ kind: "other", status: null });
    expect(server.requests).toHaveLength(0);
  });

  test("other: custom with no base URL, and an unknown provider", async () => {
    const r = await make();
    const err = await fails(r, params(ref("custom", "anything")));
    expect(err.message).toBe("No base URL for the custom provider. Set providers.custom.base_url in /settings.");
    expect(err.data).toMatchObject({ kind: "other", status: null });
    const unknown = await fails(r, params(ref("nope", "x")));
    expect(unknown.data.kind).toBe("other");
    expect(server.requests).toHaveLength(0);
  });

  test("every failure emits call.end with the error once", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => httpError(404));
    const err = await fails(r, params(OPENAI));
    const ends = r.events.filter((e) => e.name === "call.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.payload.error).toEqual(err.data);
  });
});

describe("keys stay out of errors, events and run state", () => {
  const echo = (status: number) => (req: { headers: Record<string, string> }) =>
    httpError(status, { error: { message: `bad credentials: authorization=${req.headers.authorization ?? ""} x-api-key=${req.headers["x-api-key"] ?? ""} x-goog-api-key=${req.headers["x-goog-api-key"] ?? ""}` } });

  const cases: [string, string, number][] = [
    ["openai", "gpt-4.1", 400],
    ["openai", "gpt-4.1", 500],
    ["anthropic", "claude-haiku-4-5", 400],
    ["anthropic", "claude-haiku-4-5", 503],
    ["gemini", "gemini-2.5-flash", 400],
    ["openrouter", "anthropic/claude-sonnet-4.5", 401],
  ];
  for (const [providerId, model, status] of cases) {
    test(`${providerId} ${status}`, async () => {
      const r = await make({ keys: [providerId] });
      const key = KEYS[providerId]!;
      server.script(echo(status));
      const err = await fails(r, params(ref(providerId, model)));
      // The server did see the key, so the echo really carried it.
      expect(server.requests.at(-1)!.rawBody).not.toContain(key);
      expect(JSON.stringify(server.requests.at(-1)!.headers)).toContain(key);
      expect(err.message).not.toContain(key);
      expect(JSON.stringify(err.data)).not.toContain(key);
      expect(String(err.stack ?? "")).not.toContain(key);
      expect(JSON.stringify(r.events)).not.toContain(key);
      expect(JSON.stringify(r.gateway.totals("r_0123456789ab"))).not.toContain(key);
      expect(JSON.stringify(r.gateway.lastRootRequest("r_0123456789ab"))).not.toContain(key);
      if (status === 400 || status === 500 || status === 503) expect(err.message).toContain("[key]");
    });
  }
});

describe("the window check", () => {
  const tools: ToolDef[] = [{ name: "python", description: "Run code.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }];
  const base = params(ref("openai", "gpt-4"), { tools });
  // Every message's content plus JSON.stringify(tools), by the spec's rule.
  const chars = base.messages.reduce((n, m) => n + m.content.length, 0) + JSON.stringify(tools).length;
  const prompt = Math.ceil(chars / 3);

  test("an exact fit passes, one more token fails, on root calls only", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => openaiStream({ text: "fits" }));
    expect((await r.gateway.complete({ ...base, max_tokens: 8192 - prompt })).text).toBe("fits");
    expect(server.requests).toHaveLength(1);

    const over = 8192 - prompt + 1;
    const err = await fails(r, { ...base, max_tokens: over });
    expect(err.message).toBe(
      `This request would not fit in gpt-4's context window: about 8193 tokens (prompt about ${prompt} plus up to ${over} for the reply) against 8192. Choose a model with a larger window in /model, or lower the limits in the profile.`,
    );
    expect(err.data).toMatchObject({ kind: "context_window", status: null, model: "gpt-4" });
    expect(server.requests).toHaveLength(1);

    const subCall = sub(ref("openai", "gpt-4"), "Question?", { id: "b1", index: 0, size: 1 }, { max_tokens: 100_000 });
    expect((await r.gateway.complete(subCall)).text).toBe("fits");
  });

  test("an unknown window is skipped", async () => {
    const r = await make({ keys: ["openai"] });
    const zero: ModelInfo = { provider: "openai", id: "zero-window-FAKE", name: "zero", context_window: 0, max_output: 0, price: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, tool_call: true, reasoning: false, cache_min_tokens: null };
    r.catalog.merge("openai", [zero]);
    server.script(() => openaiStream({ text: "ok" }));
    expect((await r.gateway.complete(params(ref("openai", "zero-window-FAKE"), { max_tokens: 10_000_000 }))).text).toBe("ok");
    expect((await r.gateway.complete(params(ref("openai", "not-in-the-catalog"), { max_tokens: 10_000_000 }))).text).toBe("ok");
    expect(server.requests).toHaveLength(2);
  });
});

describe("cancelling", () => {
  const ways = ["cancelRun", "signal"] as const;

  function canceller(r: Rig, runId: string): { signal: AbortSignal; cancel(way: (typeof ways)[number]): void } {
    const ac = new AbortController();
    return { signal: ac.signal, cancel: (way) => (way === "cancelRun" ? r.gateway.cancelRun(runId) : ac.abort()) };
  }

  for (const way of ways) {
    test(`${way}: a queued call`, async () => {
      const r = await make({ keys: ["openai"], settings: { "providers.openai.max_in_flight": 1 } });
      server.script([() => openaiStream({ text: "first", holdFirstChunkMs: 300 }), () => openaiStream({ text: "never" })]);
      const first = r.gateway.complete(params(OPENAI, { run_id: "r_first" }));
      await until(() => server.requests.length === 1);
      const c = canceller(r, "r_queued");
      const queued = r.gateway.complete(params(OPENAI, { run_id: "r_queued" }), c.signal);
      await Bun.sleep(20);
      c.cancel(way);
      const err = await caught(queued);
      expect(err).toBeInstanceOf(ModelError);
      expect(err.data).toMatchObject({ kind: "cancelled", status: null, message: "The call was cancelled." });
      expect((await first).text).toBe("first");
      expect(server.requests).toHaveLength(1);
      const end = r.events.find((e) => e.name === "call.end" && e.payload.run_id === "r_queued");
      expect(end?.payload.error.kind).toBe("cancelled");
    });

    test(`${way}: a sleeping call`, async () => {
      let slept = 0;
      RETRY.sleep = (_ms, signal) =>
        new Promise((_, reject) => {
          slept += 1;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      const r = await make({ keys: ["openai"] });
      server.script(() => httpError(503));
      const c = canceller(r, "r_sleep");
      const call = r.gateway.complete(params(OPENAI, { run_id: "r_sleep" }), c.signal);
      await until(() => slept === 1);
      c.cancel(way);
      const err = await caught(call);
      expect(err).toBeInstanceOf(ModelError);
      expect(err.data.kind).toBe("cancelled");
      expect(err.message).toBe("The call was cancelled.");
      expect(server.requests).toHaveLength(1);
    });

    test(`${way}: an in-flight call`, async () => {
      const r = await make({ keys: ["anthropic"] });
      server.script(() => anthropicStream({ text: "slow", holdFirstChunkMs: 5000 }));
      const c = canceller(r, "r_flight");
      const call = r.gateway.complete(params(ANTHROPIC, { run_id: "r_flight" }), c.signal);
      await until(() => server.requests.length === 1);
      const t0 = Date.now();
      c.cancel(way);
      const err = await caught(call);
      expect(err).toBeInstanceOf(ModelError);
      expect(err.data.kind).toBe("cancelled");
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(server.requests).toHaveLength(1);
      expect(sleeps.delays).toEqual([]);
    });
  }

  test("cancelRun leaves other runs alone", async () => {
    const r = await make({ keys: ["openai"] });
    server.script(() => openaiStream({ text: "kept", holdFirstChunkMs: 100 }));
    const kept = r.gateway.complete(params(OPENAI, { run_id: "r_kept" }));
    const gone = r.gateway.complete(params(OPENAI, { run_id: "r_gone" }));
    await until(() => server.requests.length === 2);
    r.gateway.cancelRun("r_gone");
    expect((await caught(gone)).data.kind).toBe("cancelled");
    expect((await kept).text).toBe("kept");
  });
});

describe("resolveCallFormat", () => {
  test("auto, fenced and native over every provider", async () => {
    const r = await make();
    const entry = (provider: string, id: string, tool_call: boolean): ModelInfo => ({
      provider,
      id,
      name: id,
      context_window: 1000,
      max_output: 100,
      price: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      tool_call,
      reasoning: false,
      cache_min_tokens: null,
    });
    for (const def of PROVIDERS) {
      if (def.id === "fake") continue; // built in, can't be merged; checked below
      r.catalog.merge(def.id, [entry(def.id, "tools-yes-FAKE", true), entry(def.id, "tools-no-FAKE", false)]);
    }
    for (const def of PROVIDERS) {
      const yes = def.id === "fake" ? ref("fake", "scripted") : ref(def.id, "tools-yes-FAKE");
      const no = ref(def.id, def.id === "fake" ? "not-scripted" : "tools-no-FAKE");
      expect([def.id, r.gateway.resolveCallFormat(yes, "auto")]).toEqual([def.id, def.api ? "native" : "fenced"]);
      expect([def.id, r.gateway.resolveCallFormat(no, "auto")]).toEqual([def.id, "fenced"]);
      expect([def.id, r.gateway.resolveCallFormat(ref(def.id, "unknown-model-FAKE"), "auto")]).toEqual([def.id, "fenced"]);
      for (const m of [yes, no]) {
        expect(r.gateway.resolveCallFormat(m, "fenced")).toBe("fenced");
        expect(r.gateway.resolveCallFormat(m, "native")).toBe("native");
      }
    }
    // Real ids from the bundled catalog.
    expect(r.gateway.resolveCallFormat(ref("anthropic", "claude-haiku-4-5"), "auto")).toBe("native");
    expect(r.gateway.resolveCallFormat(ref("local", "qwen"), "auto")).toBe("fenced");
  });
});

test("ModelError is an RpcError with code -32001", async () => {
  const r = await make();
  const err = await fails(r, params(ANTHROPIC));
  expect(err).toBeInstanceOf(RpcError);
  expect(err.code).toBe(-32001);
  expect(err.kind).toBe("no_key");
  expect(Object.keys(err.data).sort()).toEqual(["kind", "message", "model", "provider", "status"]);
});
