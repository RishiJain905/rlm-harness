// KV cache: none
// cache.ts: Anthropic breakpoints, the cache keys, sharedPrefix and planBatch, and the llm_batch
// rule (D-24) timed against the fake server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAnthropicRequest } from "../../src/gateway/anthropic.ts";
import { ANTHROPIC_SPLIT_PREFIX, anthropicBreakpoints, planBatch, sharedPrefix } from "../../src/gateway/cache.ts";
import type { ModelCompleteParams } from "../../src/protocol.ts";
import { anthropicStream, httpError, openaiStream, startFakeProvider, type FakeServer, type RecordedRequest } from "../fakes/http.ts";
import { caught, limits, params, recordSleeps, ref, rig, sub, type Rig } from "./helpers.ts";

let server: FakeServer;
let r: Rig | undefined;
let sleeps: ReturnType<typeof recordSleeps>;
beforeEach(() => {
  server = startFakeProvider();
  sleeps = recordSleeps();
});
afterEach(() => {
  sleeps.restore();
  server.stop();
  r?.cleanup();
  r = undefined;
});

const SHARED = "x".repeat(6000);
const prompts = (n: number, shared = SHARED) => Array.from({ length: n }, (_, i) => `${shared} part ${i}`);
const promptOf = (q: RecordedRequest) => q.body.messages[q.body.messages.length - 1].content as string | { text: string }[];
const indexOf = (q: RecordedRequest) => {
  const c = promptOf(q);
  const text = typeof c === "string" ? c : c.map((b) => b.text).join("");
  return Number(/part (\d+)$/.exec(text)?.[1] ?? -1);
};
const countMarkers = (v: unknown): number => (Array.isArray(v) ? v.reduce((n, x) => n + countMarkers(x), 0) : typeof v === "object" && v !== null ? Object.entries(v).reduce((n, [k, x]) => n + (k === "cache_control" ? 1 : countMarkers(x)), 0) : 0);

describe("anthropic breakpoints", () => {
  const conv: ModelCompleteParams["messages"] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ];

  test("root: the end of system and the last block of the last message, nothing else", () => {
    const body = buildAnthropicRequest(params(ref("anthropic", "claude-sonnet-5"), { messages: conv }), { dropped: new Set(), markers: true, replay: () => undefined }) as any;
    expect(body.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    const last = body.messages[body.messages.length - 1];
    expect(last.content[last.content.length - 1]).toEqual({ type: "text", text: "second", cache_control: { type: "ephemeral" } });
    expect(countMarkers(body)).toBe(2);
    // each message still has one text block with the engine's text
    expect(body.messages.map((m: any) => [m.role, m.content.length, m.content[0].text])).toEqual([
      ["user", 1, "first"],
      ["assistant", 1, "reply"],
      ["user", 1, "second"],
    ]);
  });

  test("a plain sub-call carries none", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok" }));
    await r.gateway.complete(sub(ref("anthropic", "claude-sonnet-5"), "Summarize this.", { id: "b1", index: 0, size: 1 }));
    expect(countMarkers(server.requests[0]!.body)).toBe(0);
  });

  test("splitting is off, and only the pure function can split", () => {
    expect(ANTHROPIC_SPLIT_PREFIX).toBe(false);
    const body: { messages: { role: string; content: Record<string, unknown>[] }[] } = { messages: [{ role: "user", content: [{ type: "text", text: "shared prefix|own part" }] }] };
    const split = anthropicBreakpoints(body, { splitAt: 14 });
    expect(split.messages[0]!.content).toEqual([
      { type: "text", text: "shared prefix|", cache_control: { type: "ephemeral" } },
      { type: "text", text: "own part" },
    ]);
    expect(body.messages[0]!.content.length).toBe(1); // the input is not changed
  });
});

describe("cache keys", () => {
  test("prompt_cache_key on OpenAI root and sub-calls, session_id on OpenRouter, neither elsewhere", async () => {
    r = await rig({ server, keys: ["openai", "openrouter", "deepseek", "gemini"] });
    server.script(() => openaiStream({ text: "ok" }));
    const one = { id: "b1", index: 0, size: 1 };
    for (const [provider, model] of [["openai", "gpt-4.1"], ["openrouter", "openai/gpt-5"], ["deepseek", "deepseek-v4-pro"], ["gemini", "gemini-3.5-flash"], ["local", "qwen"]] as const) {
      await r.gateway.complete(params(ref(provider, model)));
      await r.gateway.complete(sub(ref(provider, model), "Summarize.", one));
    }
    const keys = server.requests.map((q) => [q.headers["x-orig-host"], q.body.prompt_cache_key, q.body.session_id]);
    expect(keys).toEqual([
      ["api.openai.com", "r_0123456789ab", undefined],
      ["api.openai.com", "r_0123456789ab", undefined],
      ["openrouter.ai", undefined, "r_0123456789ab"],
      ["openrouter.ai", undefined, "r_0123456789ab"],
      ["api.deepseek.com", undefined, undefined],
      ["api.deepseek.com", undefined, undefined],
      ["generativelanguage.googleapis.com", undefined, undefined],
      ["generativelanguage.googleapis.com", undefined, undefined],
      ["localhost:8000", undefined, undefined],
      ["localhost:8000", undefined, undefined],
    ]);
  });
});

describe("sharedPrefix and planBatch", () => {
  test("sharedPrefix", () => {
    expect(sharedPrefix([])).toBe("");
    expect(sharedPrefix(["abc"])).toBe("abc");
    expect(sharedPrefix(["abcd", "abxy", "abz"])).toBe("ab");
    expect(sharedPrefix(["same", "same"])).toBe("same");
    expect(sharedPrefix(["", "abc"])).toBe("");
    // 😀 is 😀 and 😁 is 😁: the pair differs in its second half, so the prefix stops before it
    expect(sharedPrefix(["a😀", "a😁"])).toBe("a");
    expect(sharedPrefix(["a😀x", "a😀y"])).toBe("a😀");
  });

  test("planBatch", () => {
    const p4 = prompts(4);
    expect(planBatch(p4, { caching: "openai", cacheMinTokens: 1024 })).toEqual({ apply: true, prefixChars: 6006, marker: false, split: false });
    expect(planBatch(p4, { caching: "openai", cacheMinTokens: 2048 }).apply).toBe(false); // 1502 tokens < 2048
    // null gives 1024; the shared prefix is the y's plus " part " (6 characters)
    expect(planBatch(prompts(2, "y".repeat(4087)), { caching: "auto", cacheMinTokens: null }).apply).toBe(true); // ceil(4093 / 4) = 1024
    expect(planBatch(prompts(2, "y".repeat(4086)), { caching: "auto", cacheMinTokens: null }).apply).toBe(false); // ceil(4092 / 4) = 1023
    expect(planBatch(prompts(1), { caching: "openai", cacheMinTokens: 1024 }).apply).toBe(false); // size 1
    expect(planBatch(p4, { caching: "none", cacheMinTokens: 1024 }).apply).toBe(false);
    expect(planBatch(p4, { caching: "anthropic", cacheMinTokens: 1024 }).apply).toBe(false); // not identical
    expect(planBatch([SHARED, SHARED], { caching: "anthropic", cacheMinTokens: 1024 })).toEqual({ apply: true, prefixChars: 6000, marker: true, split: false });
    expect(planBatch(p4, { caching: "anthropic", cacheMinTokens: 1024, split: true })).toEqual({ apply: true, prefixChars: 6006, marker: true, split: true });
  });
});

describe("the batch rule", () => {
  const model = ref("openai", "gpt-4.1");
  const send = (rr: Rig, list: string[], over: Partial<ModelCompleteParams> = {}) =>
    list.map((prompt, index) => rr.gateway.complete(sub(over.model ?? model, prompt, { id: "b1", index, size: list.length }, over)));

  test("4 prompts sharing 6,000 characters: one first, the rest after its first chunk", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script((q) => openaiStream({ text: "ok", holdFirstChunkMs: indexOf(q) === 0 ? 300 : 0 }));
    await Promise.all(send(r, prompts(4)));
    expect(server.requests.length).toBe(4);
    const [leader, ...rest] = server.requests;
    expect(indexOf(leader!)).toBe(0);
    for (const q of rest) expect(q.arrivedAt - leader!.arrivedAt).toBeGreaterThanOrEqual(280);
  });

  test("a shared prefix below the minimum sends all 4 at once", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok", holdFirstChunkMs: 100 }));
    await Promise.all(send(r, prompts(4, "short shared start")));
    const times = server.requests.map((q) => q.arrivedAt);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(50);
  });

  test("a late member waits for the leader's first token", async () => {
    const restore = limits({ BATCH_COLLECT_MS: 50 });
    try {
      r = await rig({ server, keys: ["openai"] });
      server.script((q) => openaiStream({ text: "ok", holdFirstChunkMs: indexOf(q) === 0 ? 400 : 0 }));
      const list = prompts(4);
      const early = list.slice(0, 3).map((prompt, index) => r!.gateway.complete(sub(model, prompt, { id: "b1", index, size: 4 })));
      await Bun.sleep(150); // after the collect window: the plan is made without it
      const late = r.gateway.complete(sub(model, list[3]!, { id: "b1", index: 3, size: 4 }));
      await Promise.all([...early, late]);
      const leader = server.requests.find((q) => indexOf(q) === 0)!;
      const lateReq = server.requests.find((q) => indexOf(q) === 3)!;
      expect(lateReq.arrivedAt - leader.arrivedAt).toBeGreaterThanOrEqual(380);
    } finally {
      restore();
    }
  });

  test("a leader that fails before any token still releases the rest", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script((q) => (indexOf(q) === 0 ? httpError(400, { error: { message: "nope" } }) : openaiStream({ text: "ok" })));
    const results = await Promise.allSettled(send(r, prompts(4)));
    expect(results.map((x) => x.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled"]);
    expect(server.requests.length).toBe(4);
  });

  test("cancel during the wait cancels all", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok", holdFirstChunkMs: 2000 }));
    const calls = send(r, prompts(4));
    await Bun.sleep(100);
    expect(server.requests.length).toBe(1); // only the leader went
    r.gateway.cancelRun("r_0123456789ab");
    const errors = await Promise.all(calls.map((c) => caught(c)));
    expect(errors.map((e) => e.data.kind)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(server.requests.length).toBe(1);
  });

  test("a batch of one never waits", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok" }));
    const started = Date.now();
    await r.gateway.complete(sub(model, SHARED, { id: "b9", index: 0, size: 1 }));
    expect(Date.now() - started).toBeLessThan(90); // under the 100 ms collect window
  });

  test("anthropic with 4 identical prompts: a marker on each, the same ordering", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    const same = Array.from({ length: 4 }, () => SHARED);
    server.script((q) => anthropicStream({ text: "ok", holdFirstChunkMs: server.requests.indexOf(q) === 0 ? 300 : 0 }));
    await Promise.all(send(r, same, { model: ref("anthropic", "claude-sonnet-5") }));
    expect(server.requests.length).toBe(4);
    for (const q of server.requests) {
      expect(q.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: SHARED, cache_control: { type: "ephemeral" } }] }]);
    }
    const [leader, ...rest] = server.requests;
    for (const q of rest) expect(q.arrivedAt - leader!.arrivedAt).toBeGreaterThanOrEqual(280);
  });

  test("anthropic with different prompts: no marker, all at once", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok", holdFirstChunkMs: 100 }));
    await Promise.all(send(r, prompts(4), { model: ref("anthropic", "claude-sonnet-5") }));
    for (const q of server.requests) expect(countMarkers(q.body)).toBe(0);
    const times = server.requests.map((q) => q.arrivedAt);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(50);
  });
});
