// KV cache: none
// openai.ts after a compaction (v1 step 3): the summary message follows the first user message, and Chat Completions
// takes two user messages in a row as they are, so both go out as two messages, unchanged. A compaction's summary call
// (`purpose: "compact"`) routes like the conversation it summarizes: the run id for the root's, `<run>-child-<id>` for
// an rlm() child's, with the same markers on OpenRouter's Anthropic models.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildTurn, Message } from "../../src/protocol.ts";
import { openaiStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { params, recordSleeps, ref, rig, sub, type Rig } from "./helpers.ts";

const RUN = "r_0123456789ab";
const SUMMARY = "[3 earlier turns were compacted to save context. Your summary of them follows.]\n\nS\n\n[The newest turns follow as they were. The REPL still holds every variable.]";
const REQUEST = "Stop work on the task for this one reply.";
const CALL = { id: "call_4", name: "python", arguments: { code: "print(total)" } };
const TOOL = { name: "python", description: "Run one cell.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };
const COMPACTED: Message[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "Question?\n\nThe input is in `context`." },
  { role: "user", content: SUMMARY },
  { role: "assistant", content: "Adding it up.", tool_call: CALL },
  { role: "tool", tool_call_id: "call_4", content: "42" },
];
const HISTORY: Message[] = [...COMPACTED.slice(0, 2), ...COMPACTED.slice(3)];
const countMarkers = (v: unknown): number => (Array.isArray(v) ? v.reduce((n, x) => n + countMarkers(x), 0) : typeof v === "object" && v !== null ? Object.entries(v).reduce((n, [k, x]) => n + (k === "cache_control" ? 1 : countMarkers(x)), 0) : 0);

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

describe("two user messages in a row", () => {
  test("go out as two user messages, in order, with their text unchanged, on every OpenAI-compatible provider", async () => {
    r = await rig({ server, keys: ["openai", "openrouter", "deepseek"] });
    server.script(() => openaiStream({ text: "ok" }));
    for (const [provider, model] of [["openai", "gpt-4.1"], ["openrouter", "deepseek/deepseek-v4.1-flash-1017"], ["deepseek", "deepseek-v4-pro"], ["local", "qwen"]] as const) {
      await r.gateway.complete(params(ref(provider, model), { messages: COMPACTED, tools: [TOOL] }));
    }
    for (const q of server.requests) {
      const msgs = q.body.messages;
      expect(msgs.map((m: any) => m.role)).toEqual(["system", "user", "user", "assistant", "tool"]);
      expect([msgs[1].content, msgs[2].content]).toEqual([COMPACTED[1]!.content, SUMMARY]);
    }
  });
});

describe("purpose: compact", () => {
  test("routes like the run's root calls: prompt_cache_key on OpenAI, session_id on OpenRouter", async () => {
    r = await rig({ server, keys: ["openai", "openrouter"] });
    server.script(() => openaiStream({ text: "ok" }));
    const request: Message[] = [...HISTORY, { role: "user", content: REQUEST }];
    for (const [provider, model] of [["openai", "gpt-4.1"], ["openrouter", "openai/gpt-5"]] as const) {
      const m = ref(provider, model);
      await r.gateway.complete(params(m, { messages: HISTORY, tools: [TOOL], turn: 5 }));
      await r.gateway.complete(params(m, { messages: request, tools: [TOOL], turn: 6, purpose: "compact", max_tokens: 512 }));
      await r.gateway.complete(sub(m, "Summarize.", { id: "b1", index: 0, size: 1 }));
    }
    expect(server.requests.map((q) => [q.body.prompt_cache_key, q.body.session_id])).toEqual([
      [RUN, undefined],
      [RUN, undefined], // the summary call: the root's key, so it lands on the root's warm backend
      [`${RUN}-sub`, undefined],
      [undefined, RUN],
      [undefined, RUN],
      [undefined, `${RUN}-sub`],
    ]);
    // the summary request replays the root's bytes, then adds the request at the end; `purpose` itself never goes out
    const [root, compact] = server.requests.map((q) => q.body);
    expect(compact.messages.slice(0, -1)).toEqual(root.messages);
    expect(compact.messages.at(-1)).toEqual({ role: "user", content: REQUEST });
    expect(JSON.stringify(server.requests.map((q) => q.body))).not.toContain("purpose");
  });

  test("an rlm() child's summary call routes by the child, and OpenRouter's Anthropic models mark it as they mark the child's turns", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script(() => openaiStream({ text: "ok" }));
    const m = ref("openrouter", "anthropic/claude-haiku-5.5");
    const child: ChildTurn = { id: 2, turn: 3, max_turns: 30, depth: 1 };
    const turn = { role: "sub" as const, tools: [TOOL], subcall_id: 5, origin: { turn: 1, line: 3 }, batch: { id: "rlm2", index: 0, size: 1 }, turn: 3, child };
    await r.gateway.complete(params(m, { ...turn, messages: HISTORY }));
    await r.gateway.complete(params(m, { ...turn, messages: [...HISTORY, { role: "user", content: REQUEST }], purpose: "compact" }));
    await r.gateway.complete(params(m, { messages: HISTORY, tools: [TOOL], purpose: "compact" }));
    expect(server.requests.map((q) => q.body.session_id)).toEqual([`${RUN}-child-2`, `${RUN}-child-2`, RUN]);
    expect(server.requests.map((q) => q.body.cache_control ?? null)).toEqual([{ type: "ephemeral" }, { type: "ephemeral" }, { type: "ephemeral" }]);
    expect(server.requests.map((q) => countMarkers(q.body))).toEqual([2, 2, 2]);
    // a child's summary call is sub usage, as its turns are; the root's is root usage
    const totals = r.gateway.totals(RUN);
    const ends = r.events.filter((e) => e.name === "call.end").map((e) => e.payload.usage.input_tokens);
    expect(totals.sub.input_tokens).toBe(ends[0]! + ends[1]!);
    expect(totals.root.input_tokens).toBe(ends[2]!);
    expect(r.events.filter((e) => e.name === "call.start").map((e) => e.payload.purpose ?? null)).toEqual([null, "compact", "compact"]);
  });
});
