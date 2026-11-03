// KV cache: none; a test.
// attachPlain's lines for rlm() children (D-160): one line when a child starts and one when it ends; its turns stay quiet.
// And its compaction line (v1 step 3), for the root and inside a child.

import { describe, expect, test } from "bun:test";
import { Bus } from "../../src/bus.ts";
import { attachPlain } from "../../src/cli/print.ts";
import type { AppEvents } from "../../src/gateway/gateway.ts";
import type { RunChildParams, RunCompactedParams } from "../../src/protocol.ts";

function child(over: Partial<RunChildParams>): RunChildParams {
  return {
    run_id: "r_0123456789ab",
    child_id: 2,
    subcall_id: 7,
    depth: 1,
    status: "started",
    task: "Find the config loader.\nThen name it.",
    tools: "read",
    turn: 0,
    max_turns: 30,
    code: null,
    output: null,
    error: null,
    answer: null,
    seconds: null,
    ...over,
  };
}

describe("attachPlain", () => {
  test("run.child: started, done and error lines; turns print nothing", () => {
    const bus = new Bus<AppEvents>();
    let out = "";
    const off = attachPlain(bus, { write: (chunk) => (out += chunk) });
    for (const p of [
      child({}),
      child({ status: "turn", turn: 1, code: "print(1)", output: "1\n" }),
      child({ status: "done", turn: 3, answer: "load_config", seconds: 4.25 }),
      child({ child_id: 3, status: "error", turn: 1, error: "no turns left" }),
    ]) {
      bus.emit("engine.event", { method: "run.child", params: p });
    }
    off();
    expect(out).toBe(
      "rlm2 started (depth 1, tools read, up to 30 turns): Find the config loader.\n" + "rlm2 done after 3 turns, 4.3 s\n" + "rlm3 error: no turns left\n",
    );
  });

  test("run.compacted: one line, with child <id> before turn inside a child", () => {
    const bus = new Bus<AppEvents>();
    let out = "";
    const off = attachPlain(bus, { write: (chunk) => (out += chunk) });
    const body: RunCompactedParams = {
      run_id: "r_0123456789ab",
      turn: 9,
      prompt_index: 0,
      child_id: null,
      before_tokens: 131_022,
      after_tokens: 33_870,
      dropped_messages: 12,
      kept_messages: 4,
      summary_chars: 2310,
      seconds: 14.2,
    };
    bus.emit("engine.event", { method: "run.compacted", params: body });
    bus.emit("engine.event", { method: "run.compacted", params: { ...body, child_id: 2, turn: 4, before_tokens: 3_300, after_tokens: 412, dropped_messages: 6, seconds: 0.25 } });
    off();
    expect(out).toBe("turn 9: compacted 12 messages, ~131k to ~33.9k tokens, 14.2 s\n" + "child 2 turn 4: compacted 6 messages, ~3.3k to ~0.4k tokens, 0.3 s\n");
  });
});
