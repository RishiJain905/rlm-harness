// KV cache: none
// usage.ts against the step 5 spec (D-22, the usage table): each provider's raw usage as a Usage,
// cost from the bundled catalog prices, hit rate, totals by role through the gateway, and the
// ceil(chars / 4) fallback. Offline: the fake provider server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, type ModelInfo } from "../../src/gateway/catalog.ts";
import { LIMITS } from "../../src/gateway/gateway.ts";
import { RunTotals, addUsage, costOf, emptyUsage, hitRate, replyChars, requestChars, toUsage } from "../../src/gateway/usage.ts";
import type { Message, ToolDef, Usage } from "../../src/protocol.ts";
import { anthropicStream, httpError, openaiStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { caught, params, ref, rig, sub, type Rig } from "./helpers.ts";

function usage(over: Partial<Usage>): Usage {
  return { ...emptyUsage(), ...over };
}

/** Cost has float noise from the prices; everything else must match exactly. */
function expectUsage(got: Usage, want: Usage): void {
  const { cost_usd: gotCost, ...gotRest } = got;
  const { cost_usd: wantCost, ...wantRest } = want;
  expect(gotRest).toEqual(wantRest);
  expect(gotCost).toBeCloseTo(wantCost, 12);
}

let catalogHome: string;
let catalog: Catalog;
beforeEach(() => {
  catalogHome = mkdtempSync(join(tmpdir(), "rlmh-usage-"));
  catalog = new Catalog(catalogHome);
});
afterEach(() => {
  rmSync(catalogHome, { recursive: true, force: true });
});

/** A bundled entry, with its prices pinned: the hand-computed costs below are built from these. */
function priced(provider: string, id: string, price: ModelInfo["price"]): ModelInfo {
  const info = catalog.get(provider, id);
  if (!info) throw new Error(`${provider}/${id} is no longer in catalog/models.json; pick another model and redo the arithmetic`);
  expect(info.price, `the catalog price of ${provider}/${id} changed; redo the arithmetic in this file`).toEqual(price);
  return info;
}

describe("toUsage: Anthropic", () => {
  test("input_tokens counts cached tokens too, and cache reads, writes and thinking tokens are kept", () => {
    const u = toUsage({
      input_tokens: 1000,
      cache_read_input_tokens: 20000,
      cache_creation_input_tokens: 4000,
      output_tokens: 500,
      output_tokens_details: { thinking_tokens: 120 },
    });
    expect(u).toEqual({ input_tokens: 25000, output_tokens: 500, cache_read_tokens: 20000, cache_write_tokens: 4000, reasoning_tokens: 120, cost_usd: 0 });
  });

  test("no cache fields and no thinking details give zeros", () => {
    expect(toUsage({ input_tokens: 10, output_tokens: 5 })).toEqual(usage({ input_tokens: 10, output_tokens: 5 }));
    expect(toUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null, output_tokens_details: null })).toEqual(
      usage({ input_tokens: 10, output_tokens: 5 }),
    );
    expect(toUsage({ input_tokens: 10, output_tokens: 5, output_tokens_details: {} }).reasoning_tokens).toBe(0);
  });

  test("a read only or a write only", () => {
    expect(toUsage({ input_tokens: 5, cache_read_input_tokens: 95, output_tokens: 1 })).toEqual(usage({ input_tokens: 100, cache_read_tokens: 95, output_tokens: 1 }));
    expect(toUsage({ input_tokens: 5, cache_creation_input_tokens: 95, output_tokens: 1 })).toEqual(usage({ input_tokens: 100, cache_write_tokens: 95, output_tokens: 1 }));
  });
});

describe("toUsage: OpenAI-compatible", () => {
  test("prompt_tokens is the input, cached_tokens the read, reasoning_tokens a subset of the output", () => {
    const u = toUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 600 },
      completion_tokens_details: { reasoning_tokens: 50 },
    });
    expect(u).toEqual({ input_tokens: 1000, output_tokens: 200, cache_read_tokens: 600, cache_write_tokens: 0, reasoning_tokens: 50, cost_usd: 0 });
  });

  test("DeepSeek reports the cache read as prompt_cache_hit_tokens", () => {
    const u = toUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 });
    expect(u).toEqual(usage({ input_tokens: 1000, output_tokens: 200, cache_read_tokens: 700 }));
  });

  test("OpenRouter reports cache writes as prompt_tokens_details.cache_write_tokens", () => {
    const u = toUsage({ prompt_tokens: 3000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 500 } });
    expect(u).toEqual(usage({ input_tokens: 3000, output_tokens: 100, cache_read_tokens: 1000, cache_write_tokens: 500 }));
  });

  test("no details, or null details, give zeros", () => {
    expect(toUsage({ prompt_tokens: 7, completion_tokens: 3 })).toEqual(usage({ input_tokens: 7, output_tokens: 3 }));
    expect(toUsage({ prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: null, completion_tokens_details: null })).toEqual(usage({ input_tokens: 7, output_tokens: 3 }));
    expect(toUsage({ prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: null } })).toEqual(usage({ input_tokens: 7, output_tokens: 3 }));
  });

  test("a DeepSeek hit count is used when cached_tokens is 0 or absent", () => {
    expect(toUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 4 }).cache_read_tokens).toBe(4);
  });
});

describe("toUsage: no usage in the stream", () => {
  test("input and output tokens are ceil(chars / 4)", () => {
    expect(toUsage(null, undefined, { input: 24, output: 11 })).toEqual(usage({ input_tokens: 6, output_tokens: 3 }));
    expect(toUsage(undefined, undefined, { input: 25, output: 1 })).toEqual(usage({ input_tokens: 7, output_tokens: 1 }));
    expect(toUsage(null, undefined, { input: 0, output: 0 })).toEqual(usage({}));
    expect(toUsage(null, undefined, { input: 400_000, output: 3 })).toEqual(usage({ input_tokens: 100_000, output_tokens: 1 }));
  });

  test("the guess is priced from the catalog like a real count", () => {
    const info = priced("openai", "gpt-5", { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 });
    // 6 input at 1.25 and 3 output at 10: 37.5 / 1e6.
    expect(toUsage(null, info, { input: 24, output: 11 }).cost_usd).toBeCloseTo(0.0000375, 12);
  });

  test("with no usage and no character counts there is nothing to count", () => {
    expect(toUsage(null)).toEqual(emptyUsage());
  });

  test("a real usage object wins over the character counts", () => {
    expect(toUsage({ prompt_tokens: 5, completion_tokens: 2 }, undefined, { input: 4000, output: 4000 })).toEqual(usage({ input_tokens: 5, output_tokens: 2 }));
  });
});

describe("characters", () => {
  const tools: ToolDef[] = [{ name: "python", description: "Run code.", parameters: { type: "object", properties: { code: { type: "string" } } } }];

  test("requestChars: every message, each assistant tool call's arguments, and JSON.stringify(tools), which is \"[]\" (2) for none", () => {
    const messages: Message[] = [
      { role: "system", content: "abcde" }, // 5
      { role: "user", content: "fgh" }, // 3
      { role: "assistant", content: "ij", tool_call: { id: "call_1", name: "python", arguments: { code: "x" } } }, // 2 + {"code":"x"} = 2 + 12
      { role: "tool", tool_call_id: "call_1", content: "klmn" }, // 4
    ];
    expect(requestChars({ messages, tools: [] })).toBe(5 + 3 + 2 + 12 + 4 + 2);
    expect(requestChars({ messages, tools })).toBe(5 + 3 + 2 + 12 + 4 + JSON.stringify(tools).length);
    expect(requestChars({ messages: [], tools: [] })).toBe(2);
  });

  test("replyChars: the text and the tool call's arguments", () => {
    expect(replyChars("hello", null)).toBe(5);
    expect(replyChars("", { id: "c", name: "python", arguments: { code: "print(1)" } })).toBe(19); // {"code":"print(1)"}
    expect(replyChars("ab", { id: "c", name: "python", arguments: {} })).toBe(2 + 2);
  });
});

describe("cost (D-22)", () => {
  test("Anthropic claude-sonnet-5-5: uncached input, cache reads and writes, and output, each at its own price", () => {
    const info = priced("anthropic", "claude-sonnet-5-5", { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 });
    const u = toUsage(
      {
        input_tokens: 1000,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 4000,
        output_tokens: 500,
        output_tokens_details: { thinking_tokens: 120 },
      },
      info,
    );
    // uncached 25000 - 20000 - 4000 = 1000; (1000*2 + 20000*0.1 + 4000*2.5 + 500*10) / 1e6 = 19000 / 1e6.
    expect(u.input_tokens).toBe(25000);
    expect(u.cost_usd).toBeCloseTo(0.019, 12);
  });

  test("OpenAI gpt-5: reasoning tokens are part of the output and not charged twice", () => {
    const info = priced("openai", "gpt-5", { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 });
    const u = toUsage(
      { prompt_tokens: 10000, completion_tokens: 700, prompt_tokens_details: { cached_tokens: 8000 }, completion_tokens_details: { reasoning_tokens: 300 } },
      info,
    );
    // uncached 2000; (2000*1.25 + 8000*0.125 + 700*10) / 1e6 = (2500 + 1000 + 7000) / 1e6.
    expect(u.reasoning_tokens).toBe(300);
    expect(u.cost_usd).toBeCloseTo(0.0105, 12);
  });

  test("DeepSeek deepseek-v4-flash: a hit count prices as a cache read", () => {
    const info = priced("deepseek", "deepseek-v4-flash", { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 });
    const u = toUsage({ prompt_tokens: 5000, completion_tokens: 200, prompt_cache_hit_tokens: 4000 }, info);
    // uncached 1000; (1000*0.3 + 4000*0.006 + 200*1.2) / 1e6 = (300 + 24 + 240) / 1e6.
    expect(u.cost_usd).toBeCloseTo(0.000564, 12);
  });

  test("OpenRouter anthropic/claude-sonnet-5: cache writes are priced at cache_write", () => {
    const info = priced("openrouter", "anthropic/claude-sonnet-5", { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 });
    const u = toUsage({ prompt_tokens: 12000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 6000, cache_write_tokens: 2000 } }, info);
    // uncached 4000; (4000*2 + 6000*0.2 + 2000*2.5 + 400*10) / 1e6 = (8000 + 1200 + 5000 + 4000) / 1e6.
    expect(u.cost_usd).toBeCloseTo(0.0182, 12);
  });

  test("costOf follows the formula on a Usage, with no rounding of its own", () => {
    const info: ModelInfo = { ...priced("openai", "gpt-5", { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 }), price: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } };
    const u = usage({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 400_000, cache_write_tokens: 100_000 });
    // 500k*3 + 400k*0.3 + 100k*3.75 + 1M*15 = 1.5M + 120k + 375k + 15M, over 1e6 = 16.995.
    expect(costOf(u, info)).toBeCloseTo(16.995, 9);
    expect(costOf(usage({ input_tokens: 1_000_000 }), info)).toBeCloseTo(3, 12);
    expect(costOf(usage({ output_tokens: 1_000_000 }), info)).toBeCloseTo(15, 12);
  });

  test("a model with no catalog entry costs 0, but its tokens are still counted", () => {
    const u = toUsage({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } }, catalog.get("openai", "gpt-not-in-the-catalog"));
    expect(u).toEqual(usage({ input_tokens: 1000, output_tokens: 200, cache_read_tokens: 600, cost_usd: 0 }));
    expect(costOf(usage({ input_tokens: 5, output_tokens: 5 }), undefined)).toBe(0);
  });

  test("the fake model is free", () => {
    const u = toUsage(null, catalog.get("fake", "scripted"), { input: 4000, output: 400 });
    expect(u).toEqual(usage({ input_tokens: 1000, output_tokens: 100 }));
  });
});

describe("hit rate and totals, without the gateway", () => {
  test("hitRate is cache reads over input, and null with no input", () => {
    expect(hitRate(usage({ input_tokens: 25000, cache_read_tokens: 20000 }))).toBe(0.8);
    expect(hitRate(usage({ input_tokens: 100 }))).toBe(0);
    expect(hitRate(usage({ input_tokens: 100, cache_read_tokens: 100 }))).toBe(1);
    expect(hitRate(emptyUsage())).toBeNull();
    expect(hitRate(usage({ output_tokens: 50 }))).toBeNull();
  });

  test("addUsage sums every field", () => {
    const a = usage({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, reasoning_tokens: 5, cost_usd: 0.5 });
    const b = usage({ input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, reasoning_tokens: 50, cost_usd: 0.25 });
    expect(addUsage(a, b)).toEqual({ input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_write_tokens: 44, reasoning_tokens: 55, cost_usd: 0.75 });
  });

  test("RunTotals keeps the roles apart, and the hit rate and cost cover both", () => {
    const t = new RunTotals();
    expect(t.summary()).toEqual({ root: emptyUsage(), sub: emptyUsage(), cost_usd: 0, cache_hit_rate: null });
    t.add("root", usage({ input_tokens: 1000, cache_read_tokens: 600, cost_usd: 0.25 }));
    t.add("sub", usage({ input_tokens: 600, cache_read_tokens: 150, cost_usd: 0.125 }));
    t.add("sub", usage({ input_tokens: 400, cache_read_tokens: 0, cost_usd: 0.0625 }));
    const s = t.summary();
    expect(s.root).toEqual(usage({ input_tokens: 1000, cache_read_tokens: 600, cost_usd: 0.25 }));
    expect(s.sub).toEqual(usage({ input_tokens: 1000, cache_read_tokens: 150, cost_usd: 0.1875 }));
    expect(s.cost_usd).toBe(0.4375);
    expect(s.cache_hit_rate).toBe(750 / 2000);
  });
});

describe("through the gateway", () => {
  let server: FakeServer;
  let r: Rig | undefined;
  beforeEach(() => {
    server = startFakeProvider();
    r = undefined;
  });
  afterEach(() => {
    r?.cleanup();
    server.stop();
  });

  const RUN = "r_0123456789ab";

  test("Anthropic: the result's usage follows the table, with the cost from the catalog", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    priced("anthropic", "claude-sonnet-5-5", { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 });
    // The stream helper's message_delta always ends the output at 10 tokens.
    server.script(() =>
      anthropicStream({
        text: "ok",
        usage: { input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 4000, output_tokens: 1, output_tokens_details: { thinking_tokens: 120 } },
      }),
    );
    const res = await r.gateway.complete(params(ref("anthropic", "claude-sonnet-5-5")));
    // (1000*2 + 20000*0.1 + 4000*2.5 + 10*10) / 1e6 = 14100 / 1e6.
    expectUsage(res.usage, usage({ input_tokens: 25000, output_tokens: 10, cache_read_tokens: 20000, cache_write_tokens: 4000, reasoning_tokens: 120, cost_usd: 0.0141 }));
    expect(r.events.find((e) => e.name === "call.end")!.payload.usage).toEqual(res.usage);
  });

  test("DeepSeek: prompt_cache_hit_tokens is the cache read", async () => {
    r = await rig({ server, keys: ["deepseek"] });
    priced("deepseek", "deepseek-v4-flash", { input: 0.3, output: 1.2, cache_read: 0.006, cache_write: 0 });
    server.script(() => openaiStream({ text: "ok", usage: { prompt_tokens: 5000, completion_tokens: 200, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 1000 } }));
    const res = await r.gateway.complete(params(ref("deepseek", "deepseek-v4-flash")));
    expectUsage(res.usage, usage({ input_tokens: 5000, output_tokens: 200, cache_read_tokens: 4000, cost_usd: 0.000564 }));
  });

  test("OpenRouter: cache_write_tokens is the cache write", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    priced("openrouter", "anthropic/claude-sonnet-5", { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 });
    server.script(() =>
      openaiStream({
        text: "ok",
        usage: {
          prompt_tokens: 12000,
          completion_tokens: 400,
          prompt_tokens_details: { cached_tokens: 6000, cache_write_tokens: 2000 },
          completion_tokens_details: { reasoning_tokens: 90 },
        },
      }),
    );
    const res = await r.gateway.complete(params(ref("openrouter", "anthropic/claude-sonnet-5")));
    expectUsage(res.usage, usage({ input_tokens: 12000, output_tokens: 400, cache_read_tokens: 6000, cache_write_tokens: 2000, reasoning_tokens: 90, cost_usd: 0.0182 }));
  });

  test("totals by role: root and sub calls add up apart, the cost and the hit rate cover both", async () => {
    r = await rig({ server, keys: ["openai"] });
    priced("openai", "gpt-5", { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 });
    const gpt5 = ref("openai", "gpt-5");
    server.script([
      () => openaiStream({ text: "root", usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 40 } } }),
      () => openaiStream({ text: "sub one", usage: { prompt_tokens: 400, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } } }),
      () => openaiStream({ text: "sub two", usage: { prompt_tokens: 200, completion_tokens: 30 } }),
    ]);
    const root = await r.gateway.complete(params(gpt5, { run_id: RUN }));
    const sub1 = await r.gateway.complete(sub(gpt5, "first", { id: "b1", index: 0, size: 1 }, { run_id: RUN }));
    const sub2 = await r.gateway.complete(sub(gpt5, "second", { id: "b2", index: 0, size: 1 }, { run_id: RUN }));

    // root: (400*1.25 + 600*0.125 + 100*10) / 1e6 = 1575 / 1e6
    expectUsage(root.usage, usage({ input_tokens: 1000, output_tokens: 100, cache_read_tokens: 600, reasoning_tokens: 40, cost_usd: 0.001575 }));
    // sub one: (300*1.25 + 100*0.125 + 50*10) / 1e6 = 887.5 / 1e6
    expectUsage(sub1.usage, usage({ input_tokens: 400, output_tokens: 50, cache_read_tokens: 100, cost_usd: 0.0008875 }));
    // sub two: (200*1.25 + 30*10) / 1e6 = 550 / 1e6
    expectUsage(sub2.usage, usage({ input_tokens: 200, output_tokens: 30, cost_usd: 0.00055 }));

    const totals = r.gateway.totals(RUN);
    expectUsage(totals.root, root.usage);
    expectUsage(totals.sub, usage({ input_tokens: 600, output_tokens: 80, cache_read_tokens: 100, cost_usd: 0.0014375 }));
    expect(totals.cost_usd).toBeCloseTo(0.0030125, 12);
    expect(totals.cache_hit_rate).toBe(700 / 1600);
  });

  test("runs are counted apart, and a call that fails adds nothing", async () => {
    r = await rig({ server, keys: ["openai"] });
    const gpt5 = ref("openai", "gpt-5");
    server.script([
      () => openaiStream({ text: "a", usage: { prompt_tokens: 100, completion_tokens: 10 } }),
      () => openaiStream({ text: "b", usage: { prompt_tokens: 300, completion_tokens: 30 } }),
      () => httpError(400),
    ]);
    await r.gateway.complete(params(gpt5, { run_id: "r_aaaaaaaaaaaa" }));
    await r.gateway.complete(params(gpt5, { run_id: "r_bbbbbbbbbbbb" }));
    const err = await caught(r.gateway.complete(params(gpt5, { run_id: "r_aaaaaaaaaaaa" })));
    expect(err.data.kind).toBe("bad_request");
    expect(r.gateway.totals("r_aaaaaaaaaaaa").root.input_tokens).toBe(100);
    expect(r.gateway.totals("r_aaaaaaaaaaaa").root.output_tokens).toBe(10);
    expect(r.gateway.totals("r_bbbbbbbbbbbb").root.input_tokens).toBe(300);
    expect(r.gateway.totals("r_aaaaaaaaaaaa").sub).toEqual(emptyUsage());
    // The failed call's call.end event carries empty usage and the error.
    const end = r.events.filter((e) => e.name === "call.end").at(-1)!.payload;
    expect(end.usage).toEqual(emptyUsage());
    expect(end.error.kind).toBe("bad_request");
  });

  test("OpenAI-compatible stream without usage: tokens are ceil(chars / 4), priced from the catalog", async () => {
    r = await rig({ server, keys: ["openai"] });
    priced("openai", "gpt-5", { input: 1.25, output: 10, cache_read: 0.125, cache_write: 0 });
    server.script([
      () => openaiStream({ text: "hello world", usage: null }),
      () => openaiStream({ text: "", toolCall: { name: "python", arguments: { code: "print(1)" } }, usage: null }),
    ]);
    // "You are a test." (15) + "Question?" (9) + "[]" for no tools (2) = 26 chars: 7 tokens. The reply has 11 chars: 3 tokens.
    const text = await r.gateway.complete(params(ref("openai", "gpt-5"), { run_id: RUN }));
    // (7*1.25 + 3*10) / 1e6 = 38.75 / 1e6
    expectUsage(text.usage, usage({ input_tokens: 7, output_tokens: 3, cost_usd: 0.00003875 }));
    // A tool call's arguments count as reply characters: {"code":"print(1)"} is 19 chars: 5 tokens.
    const call = await r.gateway.complete(params(ref("openai", "gpt-5"), { run_id: RUN }));
    expect(call.tool_call?.arguments).toEqual({ code: "print(1)" });
    expect(call.usage.input_tokens).toBe(7);
    expect(call.usage.output_tokens).toBe(5);
    const totals = r.gateway.totals(RUN);
    expect(totals.root.input_tokens).toBe(14);
    expect(totals.root.output_tokens).toBe(8);
    expect(totals.cache_hit_rate).toBe(0);
  });

  test("a request with tools counts the tools' characters", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok", usage: null }));
    const tools: ToolDef[] = [{ name: "python", description: "Run code.", parameters: { type: "object" } }];
    const res = await r.gateway.complete(params(ref("openai", "gpt-5"), { tools }));
    expect(res.usage.input_tokens).toBe(Math.ceil((24 + JSON.stringify(tools).length) / 4)); // no extra "[]": the tools are the array
  });

  test("Anthropic stream without usage: tokens are ceil(chars / 4)", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    const events: [string, unknown][] = [
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abcdefgh" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }],
      ["message_stop", { type: "message_stop" }],
    ];
    server.script(() => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const res = await r.gateway.complete(params(ref("anthropic", "claude-sonnet-5-5")));
    // 26 chars in (24 of messages and "[]"): 7 tokens at 2; 8 chars out: 2 tokens at 10; 34 / 1e6.
    expectUsage(res.usage, usage({ input_tokens: 7, output_tokens: 2, cost_usd: 0.000034 }));
  });

  test("a model the catalog doesn't know costs 0, though its tokens are counted", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok", usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 250 } } }));
    const res = await r.gateway.complete(params(ref("openai", "gpt-not-in-the-catalog"), { run_id: RUN }));
    expect(res.usage).toEqual(usage({ input_tokens: 1000, output_tokens: 200, cache_read_tokens: 250, cost_usd: 0 }));
    const totals = r.gateway.totals(RUN);
    expect(totals.cost_usd).toBe(0);
    expect(totals.cache_hit_rate).toBe(0.25);
  });

  test("totals of a run the gateway has not seen are zeros and a null hit rate", async () => {
    r = await rig({ server });
    expect(r.gateway.totals("r_neverseen000")).toEqual({ root: emptyUsage(), sub: emptyUsage(), cost_usd: 0, cache_hit_rate: null });
    expect(r.gateway.lastRootRequest("r_neverseen000")).toBeUndefined();
  });

  test("the gateway keeps 20 runs: the 21st evicts the oldest", async () => {
    expect(LIMITS.RUNS_KEPT).toBe(20);
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok", usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    const runId = (n: number): string => `r_${String(n).padStart(12, "0")}`;
    for (let n = 1; n <= 20; n++) await r.gateway.complete(params(ref("openai", "gpt-5"), { run_id: runId(n) }));
    for (let n = 1; n <= 20; n++) expect(r.gateway.totals(runId(n)).root.input_tokens, `run ${n} with 20 runs`).toBe(100);

    await r.gateway.complete(params(ref("openai", "gpt-5"), { run_id: runId(21) }));
    expect(r.gateway.totals(runId(1))).toEqual({ root: emptyUsage(), sub: emptyUsage(), cost_usd: 0, cache_hit_rate: null });
    expect(r.gateway.lastRootRequest(runId(1))).toBeUndefined();
    for (let n = 2; n <= 21; n++) expect(r.gateway.totals(runId(n)).root.input_tokens, `run ${n} after 21 runs`).toBe(100);
    expect(r.gateway.lastRootRequest(runId(21))).toBeDefined();
  });
});
