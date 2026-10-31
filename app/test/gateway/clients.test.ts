// KV cache: none
// The two clients against the fake server: golden request bodies, streaming, the mapping tables,
// Anthropic's thinking families, parameter fallback, retries (D-23), the in-flight cap and replay (D-33).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { anthropicFamily, buildAnthropicRequest, thinkingBudget } from "../../src/gateway/anthropic.ts";
import { RETRY } from "../../src/gateway/gateway.ts";
import { buildOpenAIRequest } from "../../src/gateway/openai.ts";
import { provider } from "../../src/gateway/providers.ts";
import type { Message, ModelCompleteParams, Thinking, ToolDef } from "../../src/protocol.ts";
import { anthropicStream, cutMidStream, httpError, openaiStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { caught, params, recordSleeps, ref, rig, type Rig } from "./helpers.ts";

const PYTHON_TOOL: ToolDef = {
  name: "python",
  description: "Run one cell of Python in the persistent REPL. Variables persist between calls. The result is what the cell printed, followed by your remaining turns and sub-calls.",
  parameters: { type: "object", properties: { code: { type: "string", description: "The Python code to run." } }, required: ["code"], additionalProperties: false },
};

const CONVERSATION: Message[] = [
  { role: "system", content: "S1" },
  { role: "system", content: "S2" },
  { role: "user", content: "U" },
  { role: "assistant", content: "A", tool_call: { id: "call_1", name: "python", arguments: { code: "print(1)" } } },
  { role: "tool", tool_call_id: "call_1", content: "T" },
  { role: "assistant", content: "" },
  { role: "user", content: "U2" },
];

const noReplay = () => undefined;

function p(provider: string, model: string, over: Partial<ModelCompleteParams> = {}): ModelCompleteParams {
  return params(ref(provider, model), { messages: CONVERSATION, tools: [PYTHON_TOOL], max_tokens: 1000, temperature: 0, run_id: "r_golden000001", ...over });
}

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

describe("golden bodies", () => {
  test("openai", () => {
    const body = buildOpenAIRequest(p("openai", "gpt-4.1"), { provider: provider("openai")!, dropped: new Set(), replay: noReplay });
    const expected = {
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "S1" },
        { role: "system", content: "S2" },
        { role: "user", content: "U" },
        { role: "assistant", content: "A", tool_calls: [{ id: "call_1", type: "function", function: { name: "python", arguments: '{"code":"print(1)"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "T" },
        { role: "assistant", content: "" },
        { role: "user", content: "U2" },
      ],
      tools: [{ type: "function", function: { name: "python", description: PYTHON_TOOL.description, parameters: PYTHON_TOOL.parameters } }],
      max_completion_tokens: 1000,
      temperature: 0,
      prompt_cache_key: "r_golden000001",
      stream: true,
      stream_options: { include_usage: true },
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
    const again = buildOpenAIRequest(p("openai", "gpt-4.1"), { provider: provider("openai")!, dropped: new Set(), replay: noReplay });
    expect(JSON.stringify(again)).toBe(JSON.stringify(body));
    const noTools = buildOpenAIRequest(p("deepseek", "x", { tools: [] }), { provider: provider("deepseek")!, dropped: new Set(), replay: noReplay });
    expect("tools" in noTools).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  test("anthropic", () => {
    const body = buildAnthropicRequest(p("anthropic", "claude-opus-4-5"), { dropped: new Set(), markers: true, replay: noReplay });
    const expected = {
      model: "claude-opus-4-5",
      max_tokens: 1000,
      system: [{ type: "text", text: "S1\n\nS2", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "python", description: PYTHON_TOOL.description, input_schema: PYTHON_TOOL.parameters }],
      messages: [
        { role: "user", content: [{ type: "text", text: "U" }] },
        { role: "assistant", content: [{ type: "text", text: "A" }, { type: "tool_use", id: "call_1", name: "python", input: { code: "print(1)" } }] },
        // the empty assistant message is dropped, and its neighbours merge
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "T" }, { type: "text", text: "U2", cache_control: { type: "ephemeral" } }] },
      ],
      temperature: 0,
      stream: true,
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
    const again = buildAnthropicRequest(p("anthropic", "claude-opus-4-5"), { dropped: new Set(), markers: true, replay: noReplay });
    expect(JSON.stringify(again)).toBe(JSON.stringify(body));
  });
});

describe("streaming", () => {
  test("openai text, reasoning and a split tool call give one ToolCall; a second call is dropped", async () => {
    r = await rig({ server, keys: ["deepseek"] });
    server.script(() => openaiStream({ text: "hello there", reasoning: "let me think", toolCall: { id: "call_x", arguments: { code: "print('hi')" } }, extraToolCalls: [{ name: "python", arguments: '{"code":"2"}' }], chunkChars: 3 }));
    const res = await r.gateway.complete(params(ref("deepseek", "deepseek-v4-pro"), { tools: [PYTHON_TOOL] }));
    expect(res.text).toBe("hello there");
    expect(res.reasoning).toBe("let me think");
    expect(res.tool_call).toEqual({ id: "call_x", name: "python", arguments: { code: "print('hi')" } });
    expect(res.finish_reason).toBe("tool_call");
    expect(res.served_model).toBe("served-model");
    const deltas = r.events.filter((e) => e.name === "call.delta").map((e) => e.payload);
    expect(deltas.map((d) => d.text ?? "").join("")).toBe("hello there");
    expect(deltas.map((d) => d.reasoning ?? "").join("")).toBe("let me think");
  });

  test("anthropic text, thinking and a split tool call", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "look", reasoning: "hmm", toolCall: { id: "toolu_9", arguments: { code: "x = 1" } } }));
    const res = await r.gateway.complete(params(ref("anthropic", "claude-sonnet-5"), { tools: [PYTHON_TOOL], thinking: "low" }));
    expect(res.text).toBe("look");
    expect(res.reasoning).toBe("hmm");
    expect(res.tool_call).toEqual({ id: "toolu_9", name: "python", arguments: { code: "x = 1" } });
    expect(res.finish_reason).toBe("tool_call");
  });

  test("a provider reply with no tool-call id gets call_<run_id>_<turn> (D-39)", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ toolCall: { id: null, arguments: { code: "1" } } }));
    const res = await r.gateway.complete(params(ref("openai", "gpt-4.1"), { tools: [PYTHON_TOOL], turn: 3 }));
    expect(res.tool_call?.id).toBe("call_r_0123456789ab_3");
  });

  test("length wins over tool_call; bad arguments give {}", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ toolCall: { arguments: '{"code": "unterminated' }, finish: "length" }));
    const res = await r.gateway.complete(params(ref("openai", "gpt-4.1"), { tools: [PYTHON_TOOL] }));
    expect(res.finish_reason).toBe("length");
    expect(res.tool_call?.arguments).toEqual({});
  });
});

describe("mapping tables", () => {
  const LEVELS: Thinking[] = ["off", "low", "medium", "high"];
  const ROWS: { id: string; model: string; path: string; host: string; maxField: string; temperature: boolean; cache: Record<string, unknown> }[] = [
    { id: "openai", model: "gpt-4.1", path: "/v1/chat/completions", host: "api.openai.com", maxField: "max_completion_tokens", temperature: true, cache: { prompt_cache_key: "r_0123456789ab" } },
    { id: "openai", model: "gpt-5", path: "/v1/chat/completions", host: "api.openai.com", maxField: "max_completion_tokens", temperature: false, cache: { prompt_cache_key: "r_0123456789ab" } },
    { id: "deepseek", model: "deepseek-v4-pro", path: "/chat/completions", host: "api.deepseek.com", maxField: "max_tokens", temperature: true, cache: {} },
    { id: "openrouter", model: "anthropic/claude-sonnet-5", path: "/api/v1/chat/completions", host: "openrouter.ai", maxField: "max_tokens", temperature: true, cache: { session_id: "r_0123456789ab" } },
    { id: "gemini", model: "gemini-3.5-flash", path: "/v1beta/openai/chat/completions", host: "generativelanguage.googleapis.com", maxField: "max_tokens", temperature: true, cache: {} },
    { id: "local", model: "qwen", path: "/v1/chat/completions", host: "localhost:8000", maxField: "max_tokens", temperature: true, cache: {} },
    { id: "custom", model: "m", path: "/v2/chat/completions", host: "custom.example:9000", maxField: "max_tokens", temperature: true, cache: {} },
  ];
  const thinkingFields = (id: string, level: Thinking): Record<string, unknown> => {
    const on = level !== "off";
    switch (id) {
      case "openai":
      case "custom":
        return on ? { reasoning_effort: level } : {};
      case "deepseek":
        return on ? { thinking: { type: "enabled" }, reasoning_effort: level } : { thinking: { type: "disabled" } };
      case "openrouter":
        return { reasoning: { effort: on ? level : "none" } };
      case "gemini":
        return { reasoning_effort: on ? level : "none" };
      case "local":
        return { chat_template_kwargs: on ? { enable_thinking: true, reasoning_effort: level } : { enable_thinking: false } };
    }
    return {};
  };

  for (const row of ROWS) {
    test(`${row.id} ${row.model}`, async () => {
      r = await rig({ server, keys: ["openai", "deepseek", "openrouter", "gemini"], settings: { "providers.custom.base_url": "http://custom.example:9000/v2" } });
      server.script(() => openaiStream({ text: "ok" }));
      for (const level of LEVELS) {
        await r.gateway.complete(params(ref(row.id, row.model), { thinking: level, max_tokens: 777, temperature: 0.3 }));
        const req = server.requests[server.requests.length - 1]!;
        expect(req.path).toBe(row.path);
        expect(req.headers["x-orig-host"]).toBe(row.host);
        const expected: Record<string, unknown> = { [row.maxField]: 777, ...(row.temperature ? { temperature: 0.3 } : {}), ...thinkingFields(row.id, level), ...row.cache, stream: true, stream_options: { include_usage: true } };
        const keys = Object.keys(req.body).filter((k) => k !== "model" && k !== "messages");
        expect(keys).toEqual(Object.keys(expected));
        for (const [k, v] of Object.entries(expected)) expect(req.body[k]).toEqual(v);
      }
    });
  }

  test("a provider with no key sends the placeholder, not a real key", async () => {
    r = await rig({ server });
    server.script(() => openaiStream({ text: "ok" }));
    await r.gateway.complete(params(ref("local", "qwen")));
    expect(server.requests[0]!.headers.authorization).toBe("Bearer none");
  });
});

describe("anthropic", () => {
  test("family table", () => {
    const cases: [string, Thinking, Record<string, unknown> | undefined, Record<string, unknown> | undefined, boolean][] = [
      // model, thinking, thinking field, output_config, temperature sent
      ["claude-opus-4-5", "off", undefined, undefined, true],
      ["claude-opus-4-5", "high", { type: "enabled", budget_tokens: 3072 }, undefined, false],
      ["claude-sonnet-4-5-20250929", "low", { type: "enabled", budget_tokens: 1024 }, undefined, false],
      ["claude-sonnet-4-6", "off", undefined, undefined, true],
      ["claude-sonnet-4-6", "medium", { type: "adaptive", display: "summarized" }, { effort: "medium" }, false],
      ["claude-opus-4-8", "off", undefined, undefined, false],
      ["claude-opus-4-7", "low", { type: "adaptive", display: "summarized" }, { effort: "low" }, false],
      ["claude-opus-5", "off", { type: "disabled" }, undefined, false],
      ["claude-sonnet-5", "off", { type: "disabled" }, undefined, false],
      ["claude-haiku-5-5", "off", { type: "disabled" }, undefined, false],
      ["claude-sonnet-5-5", "off", { type: "between_tools" }, undefined, false],
      ["claude-sonnet-5-5", "high", { type: "adaptive", display: "summarized" }, { effort: "high" }, false],
      ["claude-opus-5-5", "off", undefined, undefined, false],
      ["claude-fable-5-1", "off", undefined, undefined, false],
      ["claude-mythos-5", "low", { type: "adaptive", display: "summarized" }, { effort: "low" }, false],
      ["claude-future-9", "off", undefined, undefined, true],
      ["claude-future-9", "low", { type: "adaptive", display: "summarized" }, { effort: "low" }, false],
    ];
    for (const [model, thinking, field, config, temperature] of cases) {
      const body = buildAnthropicRequest(p("anthropic", model, { thinking, max_tokens: 4096 }), { dropped: new Set(), markers: false, replay: noReplay });
      expect([model, thinking, body.thinking]).toEqual([model, thinking, field]);
      expect(body.output_config).toEqual(config);
      expect([model, thinking, "temperature" in body]).toEqual([model, thinking, temperature]);
    }
    expect(anthropicFamily("claude-opus-4-1-20250805").on).toBe("budget");
    expect(anthropicFamily("claude-sonnet-4-latest").on).toBe("budget");
  });

  test("budget math", () => {
    expect(thinkingBudget(4096, "low")).toBe(1024);
    expect(thinkingBudget(4096, "medium")).toBe(2048);
    expect(thinkingBudget(4096, "high")).toBe(3072);
    expect(thinkingBudget(2000, "low")).toBe(1024); // at least 1024
    expect(thinkingBudget(10_001, "high")).toBe(7500);
    expect(thinkingBudget(1024, "high")).toBeNull();
    const body = buildAnthropicRequest(p("anthropic", "claude-opus-4-5", { thinking: "high", max_tokens: 1024 }), { dropped: new Set(), markers: false, replay: noReplay });
    expect("thinking" in body).toBe(false); // no budget fits, so no thinking, and temperature may go
    expect(body.temperature).toBe(0);
  });

  test("the wire is pinned: anthropic-version 2023-06-01, path /v1/messages", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok" }));
    await r.gateway.complete(params(ref("anthropic", "claude-sonnet-5")));
    expect(server.requests[0]!.path).toBe("/v1/messages");
    expect(server.requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(server.requests[0]!.headers["x-orig-host"]).toBe("api.anthropic.com");
  });

  test('"thinking.type.enabled" is not supported switches to adaptive once and is remembered', async () => {
    r = await rig({ server, keys: ["anthropic"] });
    const refused = httpError(400, { type: "error", error: { type: "invalid_request_error", message: '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.' } });
    server.script([() => refused, () => anthropicStream({ text: "ok" })]);
    const call = params(ref("anthropic", "claude-opus-4-5"), { thinking: "low" });
    expect((await r.gateway.complete(call)).text).toBe("ok");
    expect(server.requests.map((q) => q.body.thinking.type)).toEqual(["enabled", "adaptive"]);
    await r.gateway.complete(call);
    expect(server.requests.length).toBe(3);
    expect(server.requests[2]!.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(sleeps.delays).toEqual([]); // a fallback is not a retry
  });

  test("adaptive thinking is not supported switches to the budget shape", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script([() => httpError(400, { type: "error", error: { type: "invalid_request_error", message: "adaptive thinking is not supported on this model" } }), () => anthropicStream({ text: "ok" })]);
    await r.gateway.complete(params(ref("anthropic", "claude-future-9"), { thinking: "medium" }));
    expect(server.requests.map((q) => q.body.thinking)).toEqual([{ type: "adaptive", display: "summarized" }, { type: "enabled", budget_tokens: 2048 }]);
  });
});

describe("parameter fallback", () => {
  test("a 400 naming temperature resends without it, and remembers", async () => {
    r = await rig({ server, keys: ["deepseek"] });
    server.script([() => httpError(400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: "invalid_request_error" } }), () => openaiStream({ text: "ok" })]);
    const call = params(ref("deepseek", "deepseek-v4-pro"));
    expect((await r.gateway.complete(call)).text).toBe("ok");
    expect("temperature" in server.requests[0]!.body).toBe(true);
    expect("temperature" in server.requests[1]!.body).toBe(false);
    await r.gateway.complete(call);
    expect("temperature" in server.requests[2]!.body).toBe(false);
    expect(sleeps.delays).toEqual([]);
  });

  test("reasoning in a message does not drop reasoning_effort's neighbour; at most 2 fallbacks", async () => {
    r = await rig({ server, keys: ["openai"] });
    const say = (field: string) => () => httpError(422, { error: { message: `Unknown parameter: '${field}'.` } });
    server.script([say("reasoning_effort"), say("temperature"), say("stream_options")]);
    const err = await caught(r.gateway.complete(params(ref("openai", "gpt-4.1"), { thinking: "low" })));
    expect(err.data.kind).toBe("bad_request");
    expect(server.requests.length).toBe(3);
    expect("reasoning_effort" in server.requests[1]!.body).toBe(false);
    expect("temperature" in server.requests[2]!.body).toBe(false);
    expect("stream_options" in server.requests[2]!.body).toBe(true);
  });
});

describe("retries", () => {
  test("503 three times then 200 waits 2, 4, 8 s", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script([() => httpError(503), () => httpError(503), () => httpError(503), () => openaiStream({ text: "ok" })]);
    expect((await r.gateway.complete(params(ref("openai", "gpt-4.1")))).text).toBe("ok");
    expect(sleeps.delays).toEqual([2000, 4000, 8000]);
    expect(server.requests.length).toBe(4);
  });

  test("seven failures give server after exactly 7 requests (the SDK retries nothing)", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => httpError(500, { type: "error", error: { type: "api_error", message: "boom" } }));
    const err = await caught(r.gateway.complete(params(ref("anthropic", "claude-sonnet-5"))));
    expect(err.data.kind).toBe("server");
    expect(err.message).toBe("Anthropic failed with HTTP 500 after 7 tries: boom");
    expect(server.requests.length).toBe(7);
    expect(sleeps.delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
  });

  test("the random factor spans 0.5 to 1.5", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script([() => httpError(502), () => httpError(502), () => openaiStream({ text: "ok" })]);
    const values = [0, 1];
    RETRY.random = () => values.shift()!;
    await r.gateway.complete(params(ref("openai", "gpt-4.1")));
    expect(sleeps.delays).toEqual([1000, 6000]);
  });

  test("Retry-After raises the delay, capped at 60 s; retry-after-ms too", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script([() => httpError(429, undefined, { "retry-after": "5" }), () => httpError(429, undefined, { "retry-after": "500" }), () => httpError(503, undefined, { "retry-after-ms": "9000" }), () => openaiStream({ text: "ok" })]);
    await r.gateway.complete(params(ref("openai", "gpt-4.1")));
    expect(sleeps.delays).toEqual([5000, 60000, 9000]);
  });

  test("400 and a quota 429 are not retried", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => httpError(400, { error: { message: "bad thing" } }));
    expect((await caught(r.gateway.complete(params(ref("openai", "gpt-4.1"))))).data.kind).toBe("bad_request");
    server.script(() => httpError(429, { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }));
    const err = await caught(r.gateway.complete(params(ref("openai", "gpt-4.1"))));
    expect(err.data.kind).toBe("rate_limit");
    expect(err.message).toBe("OpenAI says the account is out of quota or credit (HTTP 429): You exceeded your current quota.");
    expect(server.requests.length).toBe(2);
    expect(sleeps.delays).toEqual([]);
  });

  test("a cut stream is retried whole and sends reset", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script([() => cutMidStream(), () => openaiStream({ text: "full answer" })]);
    const res = await r.gateway.complete(params(ref("openai", "gpt-4.1")));
    expect(res.text).toBe("full answer");
    const deltas = r.events.filter((e) => e.name === "call.delta").map((e) => e.payload);
    expect(deltas[0]).toMatchObject({ text: "partial " });
    expect(deltas[1]).toEqual({ call_id: deltas[0].call_id, reset: true });
    expect(deltas.slice(2).map((d) => d.text).join("")).toBe("full answer");
    expect(sleeps.delays).toEqual([2000]);
    expect(r.events.filter((e) => e.name === "call.end").length).toBe(1);
  });

  test("an error event inside the stream is retried", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    const overloaded = () => new Response(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    server.script([overloaded, () => anthropicStream({ text: "ok" })]);
    expect((await r.gateway.complete(params(ref("anthropic", "claude-sonnet-5")))).text).toBe("ok");
    expect(sleeps.delays).toEqual([2000]);
  });
});

describe("in-flight cap", () => {
  test("40 calls hold at most 16 at once", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok", holdFirstChunkMs: 30 }));
    await Promise.all(Array.from({ length: 40 }, () => r!.gateway.complete(params(ref("openai", "gpt-4.1")))));
    expect(server.maxInFlight).toBe(16);
    expect(server.requests.length).toBe(40);
  });

  test("providers.openai.max_in_flight = 4 holds 4, and another provider is not held up", async () => {
    r = await rig({ server, keys: ["openai", "deepseek"], settings: { "providers.openai.max_in_flight": 4 } });
    server.script(() => openaiStream({ text: "ok", holdFirstChunkMs: 30 }));
    const openaiCalls = Promise.all(Array.from({ length: 40 }, () => r!.gateway.complete(params(ref("openai", "gpt-4.1")))));
    await Bun.sleep(5);
    const started = Date.now();
    await r.gateway.complete(params(ref("deepseek", "deepseek-v4-pro")));
    expect(Date.now() - started).toBeLessThan(250); // the 40 openai calls need about 300 ms at 4 at a time
    await openaiCalls;
    expect(server.maxInFlight).toBeLessThanOrEqual(5); // 4 openai plus the one deepseek call
    expect(server.maxInFlight).toBeGreaterThanOrEqual(4);
  });

  test("a sleeping retry gives up its slot", async () => {
    r = await rig({ server, keys: ["openai"], settings: { "providers.openai.max_in_flight": 1 } });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    RETRY.sleep = () => gate;
    server.script([() => httpError(503), () => openaiStream({ text: "second" }), () => openaiStream({ text: "first, after its sleep" })]);
    const first = r.gateway.complete(params(ref("openai", "gpt-4.1")));
    await Bun.sleep(20);
    expect((await r.gateway.complete(params(ref("openai", "gpt-4.1")))).text).toBe("second"); // got the slot while the first slept
    release();
    expect((await first).text).toBe("first, after its sleep");
  });
});

describe("replay (D-33)", () => {
  const followUp = (res: { text: string; tool_call: any }, model: ReturnType<typeof ref>, tools: ToolDef[] = [PYTHON_TOOL]) =>
    params(model, {
      tools,
      turn: 2,
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        { role: "assistant", content: res.text, ...(res.tool_call ? { tool_call: res.tool_call } : {}) },
        { role: "tool", tool_call_id: res.tool_call.id, content: "out" },
      ],
    });

  test("anthropic thinking blocks, byte-identical, before tool_use; gone after run.finished", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    const thinking = [{ thinking: "first thought", signature: "SIG+/=1" }];
    server.script([() => anthropicStream({ thinking, redacted: ["REDACTED=="], text: "Let me look.", toolCall: { id: "toolu_1", arguments: { code: "print(1)" } } }), () => anthropicStream({ text: "done" })]);
    const model = ref("anthropic", "claude-sonnet-5");
    const res = await r.gateway.complete(params(model, { tools: [PYTHON_TOOL], thinking: "low" }));
    await r.gateway.complete(followUp(res, model));
    const assistant = server.requests[1]!.body.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(JSON.stringify(assistant.content.slice(0, 2))).toBe(JSON.stringify([{ type: "thinking", thinking: "first thought", signature: "SIG+/=1" }, { type: "redacted_thinking", data: "REDACTED==" }]));
    expect(assistant.content.map((b: any) => b.type)).toEqual(["thinking", "redacted_thinking", "text", "tool_use"]);
    await r.gateway.complete(followUp(res, model)); // still there on later requests of the run
    expect(server.requests[2]!.body.messages[1].content[0].type).toBe("thinking");
    r.bus.emit("engine.event", { method: "run.finished", params: { run_id: "r_0123456789ab" } });
    await r.gateway.complete(followUp(res, model));
    expect(server.requests[3]!.body.messages[1].content.map((b: any) => b.type)).toEqual(["text", "tool_use"]);
  });

  test("deepseek reasoning_content, only when the request has tools", async () => {
    r = await rig({ server, keys: ["deepseek"] });
    server.script([() => openaiStream({ reasoning: "deep thought", text: "", toolCall: { id: "call_d", arguments: { code: "1" } } }), () => openaiStream({ text: "ok" })]);
    const model = ref("deepseek", "deepseek-v4-pro");
    const res = await r.gateway.complete(params(model, { tools: [PYTHON_TOOL] }));
    await r.gateway.complete(followUp(res, model));
    expect(server.requests[1]!.body.messages[2]).toEqual({ role: "assistant", content: "", reasoning_content: "deep thought", tool_calls: [{ id: "call_d", type: "function", function: { name: "python", arguments: '{"code":"1"}' } }] });
    await r.gateway.complete(followUp(res, model, []));
    expect("reasoning_content" in server.requests[2]!.body.messages[2]).toBe(false);
  });

  test("gemini extra_content on the tool call, as received", async () => {
    r = await rig({ server, keys: ["gemini"] });
    const extra = { google: { thought_signature: "c2lnbmF0dXJl" } };
    server.script([() => openaiStream({ text: "x", toolCall: { id: "call_g", arguments: { code: "1" } }, extraContent: extra }), () => openaiStream({ text: "ok" })]);
    const model = ref("gemini", "gemini-3.5-flash");
    const res = await r.gateway.complete(params(model, { tools: [PYTHON_TOOL] }));
    await r.gateway.complete(followUp(res, model));
    expect(JSON.stringify(server.requests[1]!.body.messages[2].tool_calls[0].extra_content)).toBe(JSON.stringify(extra));
  });

  test("openrouter reasoning_details, as received", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    const details = [{ type: "reasoning.text", text: "step one", index: 0 }, { type: "reasoning.encrypted", data: "ZW5j", index: 1 }];
    server.script([() => openaiStream({ reasoningDetails: details, toolCall: { id: "call_o", arguments: { code: "1" } } }), () => openaiStream({ text: "ok" })]);
    const model = ref("openrouter", "anthropic/claude-sonnet-5");
    const res = await r.gateway.complete(params(model, { tools: [PYTHON_TOOL] }));
    expect(res.reasoning).toBe("step one");
    await r.gateway.complete(followUp(res, model));
    expect(JSON.stringify(server.requests[1]!.body.messages[2].reasoning_details)).toBe(JSON.stringify(details));
  });

  test("a reply whose text differs from the engine's message gets nothing", async () => {
    r = await rig({ server, keys: ["deepseek"] });
    server.script([() => openaiStream({ reasoning: "r", text: "t", toolCall: { id: "call_d", arguments: { code: "1" } } }), () => openaiStream({ text: "ok" })]);
    const model = ref("deepseek", "deepseek-v4-pro");
    const res = await r.gateway.complete(params(model, { tools: [PYTHON_TOOL] }));
    await r.gateway.complete(followUp({ ...res, text: "t (edited)" }, model));
    expect("reasoning_content" in server.requests[1]!.body.messages[2]).toBe(false);
  });
});
