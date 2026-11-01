// KV cache: none
// OpenRouter endpoint pins (D-120), cache-shaped sub-call prefixes (D-119) and OpenRouter's billed cost (D-121),
// against the fake server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { routeKey, splitPrefix } from "../../src/gateway/cache.ts";
import { endpointSlug } from "../../src/gateway/gateway.ts";
import { openRouterEndpoint } from "../../src/gateway/providers.ts";
import { anthropicStream, httpError, openaiStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { params, recordSleeps, ref, rig, sub, type Rig } from "./helpers.ts";

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

const DS = "deepseek/deepseek-v4.1-flash-1017";
const one = { id: "b1", index: 0, size: 1 };
const pinOf = (i: number) => server.requests[i]!.body.provider ?? null;

describe("OpenRouter endpoint pins (D-120)", () => {
  test("the first endpoint that serves a conversation is pinned for the rest of it; sub-calls keep their own pin", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script((_q, n) => openaiStream({ text: "ok", provider: n < 2 ? "DeepInfra" : "Novita" }));
    await r.gateway.complete(params(ref("openrouter", DS))); // served by DeepInfra: becomes the root's pin
    await r.gateway.complete(sub(ref("openrouter", DS), "Summarize.", one)); // served by DeepInfra too, but sub-calls pin on their own
    await r.gateway.complete(params(ref("openrouter", DS), { turn: 2 })); // Novita would answer, but the pin sends it to DeepInfra
    await r.gateway.complete(sub(ref("openrouter", DS), "Again.", one));
    expect([0, 1, 2, 3].map(pinOf)).toEqual([
      null,
      null,
      { order: ["deepinfra"], allow_fallbacks: false },
      { order: ["deepinfra"], allow_fallbacks: false },
    ]);
    expect(server.requests.map((q) => q.body.session_id)).toEqual(["r_0123456789ab", "r_0123456789ab-sub", "r_0123456789ab", "r_0123456789ab-sub"]);
    // call.end (and so --json's gateway.call) says which endpoint served each call
    expect(r.events.filter((e) => e.name === "call.end").map((e) => (e.payload as { endpoint?: string | null }).endpoint)).toEqual(["DeepInfra", "DeepInfra", "Novita", "Novita"]);
  });

  test("an endpoint chosen in the model ref is used from the first call, and the catalog still prices the model", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script(() => openaiStream({ text: "ok", provider: "SomethingElse", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
    const res = await r.gateway.complete(params(ref("openrouter", `${DS}@deepinfra/fp8`)));
    await r.gateway.complete(params(ref("openrouter", `${DS}@deepinfra/fp8`), { turn: 2 }));
    expect(server.requests.map((q) => [q.body.model, q.body.provider])).toEqual([
      [DS, { order: ["deepinfra/fp8"], allow_fallbacks: false }],
      [DS, { order: ["deepinfra/fp8"], allow_fallbacks: false }], // the user's choice never moves to what served
    ]);
    expect(res.usage.cost_usd).toBeCloseTo(r.catalog.get("openrouter", DS)!.price.input, 9); // 1M input tokens at the catalog's price
  });

  test("a pinned endpoint that fails is dropped at once, the call goes wherever OpenRouter routes, and that endpoint is pinned", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script([
      () => openaiStream({ text: "ok", provider: "DeepInfra" }),
      () => httpError(503, { error: { message: "No endpoints available", type: "error" } }),
      () => openaiStream({ text: "ok", provider: "Novita" }),
      () => openaiStream({ text: "ok", provider: "Novita" }),
    ]);
    await r.gateway.complete(params(ref("openrouter", DS)));
    await r.gateway.complete(params(ref("openrouter", DS), { turn: 2 }));
    await r.gateway.complete(params(ref("openrouter", DS), { turn: 3 }));
    expect([0, 1, 2, 3].map(pinOf)).toEqual([null, { order: ["deepinfra"], allow_fallbacks: false }, null, { order: ["novita"], allow_fallbacks: false }]);
    expect(sleeps.delays).toEqual([]); // dropping the pin is not a retry: no wait
  });

  test("two calls pinned together that both fail each try once more unpinned, though the first already dropped the pin", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    let pinned = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((res) => (release = res));
    server.script(async (q, n) => {
      if (n === 0) return openaiStream({ text: "ok", provider: "DeepInfra" });
      if (q.body.provider) {
        // both pinned calls fail together, as when OpenRouter can't reach the pinned endpoint for a moment
        if (++pinned === 2) release();
        await bothArrived;
        return httpError(404, { error: { message: "No allowed providers are available for the selected model", type: "error" } });
      }
      await Bun.sleep(100); // the retries answer late, so the second failure is handled while no pin is set
      return openaiStream({ text: "ok", provider: "Novita" });
    });
    await r.gateway.complete(sub(ref("openrouter", DS), "First.", one)); // pins the sub-calls to DeepInfra
    const [a, b] = await Promise.all([
      r.gateway.complete(sub(ref("openrouter", DS), "A", { id: "b2", index: 0, size: 1 })),
      r.gateway.complete(sub(ref("openrouter", DS), "B", { id: "b3", index: 0, size: 1 })),
    ]);
    expect([a.text, b.text]).toEqual(["ok", "ok"]);
    expect(server.requests.slice(1, 3).map((q) => q.body.provider)).toEqual([
      { order: ["deepinfra"], allow_fallbacks: false },
      { order: ["deepinfra"], allow_fallbacks: false },
    ]);
    expect(server.requests.slice(3).map((q) => q.body.provider ?? null)).toEqual([null, null]);
    expect(sleeps.delays).toEqual([]);
  });

  test("a call whose pin failed stays unpinned, though a call beside it pinned the conversation elsewhere meanwhile", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    const prompt = (q: { body: Record<string, any> }) => q.body.messages[q.body.messages.length - 1].content as string;
    server.script(async (q, n) => {
      if (n === 0) return openaiStream({ text: "ok", provider: "DeepInfra" });
      const order = q.body.provider?.order?.[0];
      if (order === "deepinfra") {
        if (prompt(q) === "B") await Bun.sleep(150); // B's failure lands after A has recovered on Novita and pinned it
        return httpError(404, { error: { message: "No allowed providers are available for the selected model", type: "error" } });
      }
      if (order === "novita") return httpError(404, { error: { message: "No allowed providers are available for the selected model", type: "error" } });
      return openaiStream({ text: "ok", provider: "Novita" });
    });
    await r.gateway.complete(sub(ref("openrouter", DS), "First.", one)); // pins the sub-calls to DeepInfra
    const [a, b] = await Promise.all([
      r.gateway.complete(sub(ref("openrouter", DS), "A", { id: "b2", index: 0, size: 1 })),
      r.gateway.complete(sub(ref("openrouter", DS), "B", { id: "b3", index: 0, size: 1 })),
    ]);
    expect([a.text, b.text]).toEqual(["ok", "ok"]);
    // B's second try went unpinned, not to the Novita pin A had just set
    const bTries = server.requests.filter((q) => prompt(q) === "B").map((q) => q.body.provider ?? null);
    expect(bTries).toEqual([{ order: ["deepinfra"], allow_fallbacks: false }, null]);
  });

  test("an endpoint OpenRouter refuses (400) is never pinned again for that model", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script([
      () => openaiStream({ text: "ok", provider: "Display Name" }),
      () => httpError(400, { error: { message: "No allowed providers are available for the selected model", type: "error" } }),
      () => openaiStream({ text: "ok", provider: "Display Name" }),
      () => openaiStream({ text: "ok", provider: "Display Name" }),
    ]);
    await r.gateway.complete(params(ref("openrouter", DS)));
    await r.gateway.complete(params(ref("openrouter", DS), { turn: 2 }));
    await r.gateway.complete(params(ref("openrouter", DS), { turn: 3 }));
    expect([0, 1, 2, 3].map(pinOf)).toEqual([null, { order: ["display-name"], allow_fallbacks: false }, null, null]);
  });

  test("a run's end drops its own pins and keeps prefix pins for the next run on the same input", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script(() => openaiStream({ text: "ok", provider: "DeepInfra" }));
    const prefix = { chars: 10, key: "k1" };
    await r.gateway.complete(params(ref("openrouter", DS)));
    await r.gateway.complete(sub(ref("openrouter", DS), "SEGMENT-01 question", one, { prefix }));
    r.gateway.cancelRun("r_0123456789ab");
    await r.gateway.complete(params(ref("openrouter", DS)));
    await r.gateway.complete(sub(ref("openrouter", DS), "SEGMENT-01 other question", one, { run_id: "r_ffffffffffff", prefix }));
    expect(pinOf(2)).toBeNull();
    expect(pinOf(3)).toEqual({ order: ["deepinfra"], allow_fallbacks: false });
    expect(server.requests[3]!.body.session_id).toBe("rlmh-k1"); // a prefix's key is the same in every run
  });

  test("other providers get no pin", async () => {
    r = await rig({ server, keys: ["deepseek", "openai"] });
    server.script(() => openaiStream({ text: "ok", provider: "DeepInfra" }));
    for (const [p, m] of [["deepseek", "deepseek-v4-pro"], ["openai", "gpt-4.1"]] as const) {
      await r.gateway.complete(params(ref(p, m)));
      await r.gateway.complete(params(ref(p, m), { turn: 2 }));
    }
    expect(server.requests.map((q) => q.body.provider ?? null)).toEqual([null, null, null, null]);
  });

  test("endpointSlug and openRouterEndpoint", () => {
    expect(endpointSlug("deepinfra/fp8")).toBe("deepinfra/fp8");
    expect(endpointSlug("DeepInfra")).toBe("deepinfra");
    expect(endpointSlug("Amazon Bedrock")).toBe("amazon-bedrock");
    expect(openRouterEndpoint("deepseek/x@deepinfra/fp8")).toEqual({ model: "deepseek/x", endpoint: "deepinfra/fp8" });
    expect(openRouterEndpoint("deepseek/x")).toEqual({ model: "deepseek/x", endpoint: null });
    expect(openRouterEndpoint("deepseek/x@")).toEqual({ model: "deepseek/x@", endpoint: null });
  });
});

describe("cache-shaped sub-call prefixes (D-119)", () => {
  const SEG = "S".repeat(6000); // 1,500 tokens by chars / 4: over the 1,024 default minimum
  const text = `${SEG}\n\nHow many lines mention travel?`;
  const prefix = { chars: SEG.length + 2, key: "seg-abc" };

  test("Anthropic: the prefix is its own marked block, the rest follows, and the text is unchanged", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok" }));
    await r.gateway.complete(sub(ref("anthropic", "claude-sonnet-5"), text, one, { prefix }));
    await r.gateway.complete(sub(ref("anthropic", "claude-sonnet-5"), text, one, { prefix: { chars: 40, key: "short" } })); // under the minimum
    await r.gateway.complete(sub(ref("anthropic", "claude-sonnet-5"), text, one));
    const content = (i: number) => server.requests[i]!.body.messages[0].content;
    expect(content(0)).toEqual([
      { type: "text", text: `${SEG}\n\n`, cache_control: { type: "ephemeral" } },
      { type: "text", text: "How many lines mention travel?" },
    ]);
    expect(content(1)).toEqual([{ type: "text", text }]);
    expect(content(2)).toEqual([{ type: "text", text }]);
  });

  test("OpenRouter: Anthropic models get the marked part; others get the plain string; both route by the prefix's key", async () => {
    r = await rig({ server, keys: ["openrouter", "openai"] });
    server.script(() => openaiStream({ text: "ok" }));
    await r.gateway.complete(sub(ref("openrouter", "anthropic/claude-haiku-5.5"), text, one, { prefix }));
    await r.gateway.complete(sub(ref("openrouter", DS), text, one, { prefix }));
    await r.gateway.complete(sub(ref("openai", "gpt-4.1"), text, one, { prefix }));
    const [a, b, c] = server.requests;
    expect(a!.body.messages[0].content).toEqual([
      { type: "text", text: `${SEG}\n\n`, cache_control: { type: "ephemeral" } },
      { type: "text", text: "How many lines mention travel?" },
    ]);
    expect(a!.body.cache_control).toBeUndefined(); // a plain sub-call: only its prefix is marked
    expect(b!.body.messages[0].content).toBe(text); // DeepSeek caches matching prefixes on its own
    expect([a!.body.session_id, b!.body.session_id, c!.body.prompt_cache_key]).toEqual(["rlmh-seg-abc", "rlmh-seg-abc", "rlmh-seg-abc"]);
  });

  test("a batch sharing one prefix sends its first call before the rest, also on Anthropic", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    const order: number[] = [];
    server.script((q) => {
      const last = q.body.messages[0].content.at(-1).text as string;
      order.push(Number(/q(\d)$/.exec(last)?.[1]));
      return anthropicStream({ text: "ok" });
    });
    const calls = [0, 1, 2].map((i) => r!.gateway.complete(sub(ref("anthropic", "claude-sonnet-5"), `${SEG}\n\nq${i}`, { id: "b1", index: i, size: 3 }, { prefix })));
    await Promise.all(calls);
    expect(order[0]).toBe(0);
  });

  test("routeKey and splitPrefix", () => {
    expect(routeKey({ run_id: "r_1", role: "root" })).toBe("r_1");
    expect(routeKey({ run_id: "r_1", role: "sub" })).toBe("r_1-sub");
    expect(routeKey({ run_id: "r_1", role: "sub", prefix: { chars: 3, key: "k" } })).toBe("rlmh-k");
    expect(splitPrefix("abcdef", 3)).toEqual(["abc", "def"]);
    expect(splitPrefix("abc", 3)).toBeNull(); // nothing after the prefix
    expect(splitPrefix("abc", 0)).toBeNull();
    expect(splitPrefix("a😀b", 2)).toEqual(["a", "😀b"]); // 2 is inside the pair: the boundary moves back to the pair's start
  });
});

describe("OpenRouter's billed cost (D-121)", () => {
  test("a call costs what OpenRouter's usage says it charged; without it, the catalog's price", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script([
      () => openaiStream({ text: "ok", usage: { prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0.0123 } }),
      () => openaiStream({ text: "ok", usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }),
    ]);
    const billed = await r.gateway.complete(params(ref("openrouter", DS)));
    const priced = await r.gateway.complete(params(ref("openrouter", DS), { turn: 2 }));
    expect(billed.usage.cost_usd).toBe(0.0123);
    expect(priced.usage.cost_usd).toBeCloseTo(r.catalog.get("openrouter", DS)!.price.input, 9);
  });
});
