// KV cache: none
// anthropic.ts after a compaction (v1 step 3): the summary message follows the first user message, so the conversation
// has two user messages in a row. The Messages API wants alternating roles, so they become one user message with two
// text blocks, in order and unchanged, and the cache markers still land on whole blocks. A compaction's summary call
// (`purpose: "compact"`) is marked like the root call it is.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAnthropicRequest } from "../../src/gateway/anthropic.ts";
import type { Message } from "../../src/protocol.ts";
import { anthropicStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { params, recordSleeps, ref, rig, type Rig } from "./helpers.ts";

const MODEL = ref("anthropic", "claude-sonnet-5");
const SUMMARY = "[3 earlier turns were compacted to save context. Your summary of them follows.]\n\nS\n\n[The newest turns follow as they were. The REPL still holds every variable.]";
const CALL = { id: "call_4", name: "python", arguments: { code: "print(total)" } };

/** A compacted conversation: head, the summary message, then the kept tail. */
const COMPACTED: Message[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "Question?\n\nThe input is in `context`." },
  { role: "user", content: SUMMARY },
  { role: "assistant", content: "Adding it up.", tool_call: CALL },
  { role: "tool", tool_call_id: "call_4", content: "42" },
];
const countMarkers = (v: unknown): number => (Array.isArray(v) ? v.reduce((n, x) => n + countMarkers(x), 0) : typeof v === "object" && v !== null ? Object.entries(v).reduce((n, [k, x]) => n + (k === "cache_control" ? 1 : countMarkers(x)), 0) : 0);
/** Every block of a body, with its cache_control taken off, so a marker can't hide a changed text. */
const unmarked = (body: any) => body.messages.map((m: any) => ({ role: m.role, content: m.content.map(({ cache_control: _, ...b }: any) => b) }));

describe("two user messages in a row", () => {
  test("become one user message with two text blocks, in order, with their text unchanged", () => {
    const body = buildAnthropicRequest(params(MODEL, { messages: COMPACTED }), { dropped: new Set(), markers: true, replay: () => undefined }) as any;
    expect(unmarked(body)).toEqual([
      { role: "user", content: [{ type: "text", text: COMPACTED[1]!.content }, { type: "text", text: SUMMARY }] },
      { role: "assistant", content: [{ type: "text", text: "Adding it up." }, { type: "tool_use", id: "call_4", name: "python", input: CALL.arguments }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_4", content: "42" }] },
    ]);
    expect(body.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  });

  test("cache markers land on whole blocks: the system prompt and the last block, and neither user text is split", () => {
    // the summary message last, as on the first root call after a compaction whose tail ends at a reply
    const endsWithSummary: Message[] = COMPACTED.slice(0, 3);
    const body = buildAnthropicRequest(params(MODEL, { messages: endsWithSummary }), { dropped: new Set(), markers: true, replay: () => undefined }) as any;
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: endsWithSummary[1]!.content },
          { type: "text", text: SUMMARY, cache_control: { type: "ephemeral" } },
        ],
      },
    ]);
    expect(countMarkers(body)).toBe(2);
    const full = buildAnthropicRequest(params(MODEL, { messages: COMPACTED }), { dropped: new Set(), markers: true, replay: () => undefined }) as any;
    expect(full.messages[0].content.some((b: any) => "cache_control" in b)).toBe(false);
    expect(full.messages.at(-1).content.at(-1)).toEqual({ type: "tool_result", tool_use_id: "call_4", content: "42", cache_control: { type: "ephemeral" } });
    expect(countMarkers(full)).toBe(2);
  });
});

describe("purpose: compact through the gateway", () => {
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

  test("the summary call is marked like the run's root calls, counts as root and is labelled on call.start", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok" }));
    const history: Message[] = [...COMPACTED.slice(0, 2), ...COMPACTED.slice(3)];
    const request: Message[] = [...history, { role: "user", content: "Stop work on the task for this one reply." }];
    await r.gateway.complete(params(MODEL, { messages: history, turn: 5 }));
    await r.gateway.complete(params(MODEL, { messages: request, turn: 6, purpose: "compact", max_tokens: 512 }));
    await r.gateway.complete(params(MODEL, { messages: COMPACTED, turn: 6 }));
    const [root, compact, after] = server.requests.map((q) => q.body);
    // the same prefix bytes as the root call before it, and the same two breakpoints: system and the last block
    expect(compact.system).toEqual(root.system);
    expect(compact.messages.slice(0, -1)).toEqual(root.messages.slice(0, -1));
    // the request follows the tool result, so it joins that user message as a block of its own, which takes the marker
    expect(unmarked(compact).at(-1)).toEqual({ role: "user", content: [...unmarked(root).at(-1).content, { type: "text", text: "Stop work on the task for this one reply." }] });
    expect(compact.messages.at(-1).content.at(-1)).toEqual({ type: "text", text: "Stop work on the task for this one reply.", cache_control: { type: "ephemeral" } });
    expect(server.requests.map((q) => countMarkers(q.body))).toEqual([2, 2, 2]);
    expect(after.messages[0].content.map((b: any) => b.text)).toEqual([COMPACTED[1]!.content, SUMMARY]);
    // labelled, counted as root, and /context keeps the conversation rather than the summary request
    const starts = r.events.filter((e) => e.name === "call.start").map((e) => e.payload);
    expect(starts.map((s) => [s.role, s.purpose])).toEqual([["root", undefined], ["root", "compact"], ["root", undefined]]);
    const ends = r.events.filter((e) => e.name === "call.end").map((e) => e.payload.usage.output_tokens);
    expect(r.gateway.totals("r_0123456789ab").root.output_tokens).toBe(ends.reduce((a, b) => a + b, 0));
    expect(r.gateway.lastRootRequest("r_0123456789ab")?.messages).toEqual(COMPACTED);
  });
});
