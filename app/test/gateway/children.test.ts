// KV cache: none
// rlm() child turns through the gateway (D-160): role "sub" calls that carry `child`, a growing conversation like the
// root's. They get the root's cache markers, a routing key and OpenRouter pin of their own, count as sub usage, never
// wait at the batch gate, and the scripted fake serves them from the script's `children` lists (§7.5).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeKey } from "../../src/gateway/cache.ts";
import type { ChildTurn, Message, ModelCompleteParams, ModelRef } from "../../src/protocol.ts";
import { anthropicStream, openaiStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { caught, params, recordSleeps, ref, rig, sub, type Rig } from "./helpers.ts";

const RUN = "r_0123456789ab";
const DS = "deepseek/deepseek-v4.1-flash-1017";
const one = { id: "b1", index: 0, size: 1 };
const countMarkers = (v: unknown): number => (Array.isArray(v) ? v.reduce((n, x) => n + countMarkers(x), 0) : typeof v === "object" && v !== null ? Object.entries(v).reduce((n, [k, x]) => n + (k === "cache_control" ? 1 : countMarkers(x)), 0) : 0);

const CONV: Message[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "Task: find the config loader." },
  { role: "assistant", content: "Looking.", tool_call: { id: "call_1", name: "python", arguments: { code: "print(1)" } } },
  { role: "tool", tool_call_id: "call_1", content: "1" },
];

/** A child's root turn as the engine sends it: role "sub", the root's model, the python tool, batch rlm<n> of one. */
function childTurn(model: ModelRef, child: Partial<ChildTurn> = {}, over: Partial<ModelCompleteParams> = {}): ModelCompleteParams {
  const c: ChildTurn = { id: 1, turn: 2, max_turns: 30, depth: 1, ...child };
  return params(model, {
    role: "sub",
    messages: CONV,
    subcall_id: 5,
    origin: { turn: 1, line: 3 },
    batch: { id: `rlm${c.id}`, index: 0, size: 1 },
    turn: c.turn,
    child: c,
    ...over,
  });
}

describe("a child's turns against providers", () => {
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

  test("Anthropic: the root's two breakpoints (system and the last block); a plain sub-call still none", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok" }));
    await r.gateway.complete(childTurn(ref("anthropic", "claude-sonnet-5")));
    await r.gateway.complete(sub(ref("anthropic", "claude-sonnet-5"), "Summarize.", one));
    const body = server.requests[0]!.body;
    expect(body.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    const last = body.messages[body.messages.length - 1];
    expect(last.content[last.content.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect(server.requests.map((q) => countMarkers(q.body))).toEqual([2, 0]);
  });

  test("routing keys: <run>-child-<id> on OpenAI and OpenRouter, apart from the root's and the sub-calls'", async () => {
    r = await rig({ server, keys: ["openai", "openrouter"] });
    server.script(() => openaiStream({ text: "ok" }));
    await r.gateway.complete(childTurn(ref("openai", "gpt-4.1"), { id: 3 }));
    await r.gateway.complete(childTurn(ref("openrouter", "openai/gpt-5"), { id: 3 }));
    await r.gateway.complete(childTurn(ref("openrouter", "openai/gpt-5"), { id: 4 }));
    expect(server.requests.map((q) => q.body.prompt_cache_key ?? q.body.session_id)).toEqual([`${RUN}-child-3`, `${RUN}-child-3`, `${RUN}-child-4`]);
  });

  test("OpenRouter's Anthropic models: top-level cache_control and the system breakpoint, as on a root call", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script(() => openaiStream({ text: "ok" }));
    await r.gateway.complete(childTurn(ref("openrouter", "anthropic/claude-haiku-5.5")));
    await r.gateway.complete(childTurn(ref("openrouter", DS)));
    expect(server.requests.map((q) => q.body.cache_control ?? null)).toEqual([{ type: "ephemeral" }, null]);
    expect(server.requests[0]!.body.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }] });
  });

  test("OpenRouter pins: each child pins its own conversation, apart from the root's and the sub-calls'; the run's end drops them", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    const served = ["DeepInfra", "Novita", "Parasail", "Chutes"];
    server.script((_q, n) => openaiStream({ text: "ok", provider: served[n] ?? "Other" }));
    const pinOf = (i: number) => server.requests[i]!.body.provider?.order?.[0] ?? null;
    await r.gateway.complete(params(ref("openrouter", DS))); // root: DeepInfra
    await r.gateway.complete(sub(ref("openrouter", DS), "Summarize.", one)); // sub-calls: Novita
    await r.gateway.complete(childTurn(ref("openrouter", DS), { id: 1, turn: 1 })); // rlm1: Parasail
    await r.gateway.complete(childTurn(ref("openrouter", DS), { id: 2, turn: 1 })); // rlm2: Chutes
    await r.gateway.complete(childTurn(ref("openrouter", DS), { id: 1, turn: 2 }));
    await r.gateway.complete(childTurn(ref("openrouter", DS), { id: 2, turn: 2 }));
    await r.gateway.complete(params(ref("openrouter", DS), { turn: 2 }));
    await r.gateway.complete(sub(ref("openrouter", DS), "Again.", one));
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(pinOf)).toEqual([null, null, null, null, "parasail", "chutes", "deepinfra", "novita"]);
    r.gateway.cancelRun(RUN);
    await r.gateway.complete(childTurn(ref("openrouter", DS), { id: 1, turn: 3 }));
    expect(pinOf(8)).toBeNull();
  });

  test("call.start carries the child; usage counts as sub; a missing tool-call id names the child", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "", toolCall: { id: null, name: "python", arguments: '{"code":"print(2)"}' }, usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    const res = await r.gateway.complete(childTurn(ref("openai", "gpt-4.1"), { id: 7, turn: 4 }));
    const start = r.events.find((e) => e.name === "call.start")!.payload;
    expect(start.role).toBe("sub");
    expect(start.child).toEqual({ id: 7, turn: 4, max_turns: 30, depth: 1 });
    expect(start.subcall_id).toBe(5);
    expect(start.batch).toEqual({ id: "rlm7", index: 0, size: 1 });
    const totals = r.gateway.totals(RUN);
    expect(totals.sub.input_tokens).toBe(100);
    expect(totals.root.input_tokens).toBe(0);
    expect(r.gateway.lastRootRequest(RUN)).toBeUndefined(); // /context shows the root's conversation only
    expect(res.tool_call?.id).toBe(`call_${RUN}_c7_4`); // never the root's call_<run>_4
  });

  test("a child's turn too large for the window fails before it is sent, as a root call would", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok" }));
    const window = r.catalog.get("openai", "gpt-4.1")!.context_window;
    const huge: Message[] = [{ role: "system", content: "SYS" }, { role: "user", content: "x".repeat(window * 3) }];
    const err = await caught(r.gateway.complete(childTurn(ref("openai", "gpt-4.1"), {}, { messages: huge })));
    expect(err.kind).toBe("context_window");
    expect(server.requests).toHaveLength(0);
  });
});

describe("routeKey", () => {
  test("a child's turns route by run and child id, whatever else the call carries", () => {
    const child = { id: 2, turn: 1, max_turns: 30, depth: 1 };
    expect(routeKey({ run_id: "r_1", role: "sub", child })).toBe("r_1-child-2");
    expect(routeKey({ run_id: "r_1", role: "sub", child, prefix: { chars: 3, key: "k" } })).toBe("r_1-child-2");
    expect(routeKey({ run_id: "r_1", role: "sub" })).toBe("r_1-sub");
    expect(routeKey({ run_id: "r_1", role: "root" })).toBe("r_1");
  });
});

describe("the scripted fake's `children`", () => {
  let dir: string;
  let rigs: Rig[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rlmh-fake-"));
    rigs = [];
  });
  afterEach(() => {
    for (const x of rigs) x.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  async function fakeRig(script: unknown): Promise<Rig> {
    const file = join(dir, "script.json");
    writeFileSync(file, JSON.stringify(script));
    const x = await rig({ env: { RLMH_FAKE_SCRIPT: file } });
    rigs.push(x);
    return x;
  }

  const FAKE = ref("fake", "scripted");
  const turnOf = (id: number, turn: number) => childTurn(FAKE, { id, turn });

  test("a child's turn k is entry k - 1 of its own list, else of '*'; sub-calls and the root are untouched", async () => {
    const r = await fakeRig({
      root: [{ text: "root one" }],
      sub: [{ text: "sub answer" }],
      children: {
        "1": [{ text: "Looking.", tool_call: { code: "print(1)" } }, { text: "", tool_call: { code: "submit('a')" } }],
        "*": [{ text: "", tool_call: { code: "print('any')" } }, { text: "", tool_call: { code: "submit('any')" } }],
      },
    });
    const a2 = await r.gateway.complete(turnOf(1, 2)); // by turn number, not by order of arrival
    const a1 = await r.gateway.complete(turnOf(1, 1));
    const b1 = await r.gateway.complete(turnOf(2, 1));
    const s = await r.gateway.complete(sub(FAKE, "Summarize.", one));
    const c2 = await r.gateway.complete(turnOf(3, 2));
    const root = await r.gateway.complete(params(FAKE));
    expect(a1).toMatchObject({ text: "Looking.", tool_call: { id: "call_c1_1", name: "python", arguments: { code: "print(1)" } }, finish_reason: "tool_call" });
    expect(a2.tool_call).toEqual({ id: "call_c1_2", name: "python", arguments: { code: "submit('a')" } });
    expect(b1.tool_call).toEqual({ id: "call_c2_1", name: "python", arguments: { code: "print('any')" } });
    expect(c2.tool_call?.arguments).toEqual({ code: "submit('any')" });
    expect(s.text).toBe("sub answer");
    expect(root.text).toBe("root one");
  });

  test("past the end of a child's list, or with no list at all, the call fails as an exhausted root script", async () => {
    const r = await fakeRig({ sub: [{ text: "sub answer" }], children: { "1": [{ text: "only" }] } });
    await r.gateway.complete(turnOf(1, 1));
    for (const call of [turnOf(1, 2), turnOf(2, 1)]) {
      const err = await caught(r.gateway.complete(call));
      expect(err.kind).toBe("other");
      expect(err.message).toBe("fake script exhausted");
    }
    const none = await fakeRig({ sub: [{ text: "sub answer" }] });
    expect((await caught(none.gateway.complete(turnOf(1, 1)))).message).toBe("fake script exhausted");
  });

  test("child turns move neither the root nor the sub count, so errors[] never matches them", async () => {
    const r = await fakeRig({
      root: [{ text: "root one" }],
      sub: [{ text: "sub answer" }],
      children: { "*": [{ text: "a" }, { text: "b" }] },
      errors: [{ role: "sub", at: 1, kind: "server", status: 500 }, { role: "root", at: 2, kind: "auth", status: 401 }],
    });
    expect((await r.gateway.complete(turnOf(1, 1))).text).toBe("a");
    expect((await r.gateway.complete(turnOf(1, 2))).text).toBe("b");
    expect((await caught(r.gateway.complete(sub(FAKE, "Summarize.", one)))).kind).toBe("server"); // still the first sub call
    expect((await r.gateway.complete(params(FAKE))).text).toBe("root one");
  });
});
