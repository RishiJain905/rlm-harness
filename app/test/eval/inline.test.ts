// KV cache: none
// runEval's inline form (v1 step 9, `/tune`): in-memory tasks on a stub session, never graded. Each request carries
// the given profile, models, permission mode, batch, tag and logDir, with `interactive: false` and
// `conversation: false`; a repo task's work copy is made before run.start, `after` sees the finished run and
// `remove` always runs; `track` sees each run; with `sharedBus` only this eval's runs are counted; its cap cancels
// and names the run "capped"; an account kind stops the later tasks; the record is read from logDir; out holds
// eval.json and no grades.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../src/bus.ts";
import { runEval, type InlineTask } from "../../src/eval/runner.ts";
import type { AppEvents } from "../../src/gateway/gateway.ts";
import type { RunFinishedParams } from "../../src/protocol.ts";
import type { StartRun } from "../../src/session.ts";
import { temp } from "../cli/helpers.ts";

const t = temp("rlmh-inline-");
afterAll(() => t.cleanup());

const zero = () => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 });
const ref = { provider: "fake", model: "scripted", thinking: null };

/** A session whose runs cost `usd` (one call.end), write a record to their logDir, and end as `kind[tag]` says. */
function stub(o: { usd?: number; kind?: Record<string, string>; hold?: boolean } = {}) {
  const bus = new Bus<AppEvents>();
  const started: StartRun[] = [];
  const cancelled: string[] = [];
  const live = new Map<string, () => void>();
  let n = 0;
  const finish = (id: string, r: StartRun, infra: string | null) => {
    live.delete(id);
    const f: RunFinishedParams = {
      run_id: id, tag: r.tag ?? null, answer: infra ? null : "42", submitted: infra === null, answer_valid: true, turns: 1, subcalls: 0,
      usage: { root: zero(), sub: zero() }, cost_usd: o.usd ?? 0, infra_error: infra ? `${infra}: stub` : null, infra_kind: infra, wall_s: 0, log_path: "", prompt_index: 0, open: false,
    };
    mkdirSync(r.logDir!, { recursive: true });
    appendFileSync(join(r.logDir!, "runs.jsonl"), `${JSON.stringify({ run_id: id, tag: r.tag, batch: r.batch, mode: r.mode, diff: "", submitted: f.submitted })}\n`);
    bus.emit("engine.event", { method: "run.finished", params: f });
  };
  return {
    bus,
    started,
    cancelled,
    session: {
      bus,
      start: async (r: StartRun) => {
        const id = `r_${++n}`;
        started.push(r);
        live.set(id, () => finish(id, r, "cancelled"));
        setTimeout(() => {
          bus.emit("call.end", { call_id: `${id}-c`, run_id: id, usage: { ...zero(), cost_usd: o.usd ?? 0 }, finish_reason: "stop", seconds: 0 });
          if (o.hold) return;
          setTimeout(() => live.has(id) && finish(id, r, o.kind?.[r.tag ?? ""] ?? null), 5);
        }, 5);
        return { run_id: id, log_path: "" };
      },
      cancel: async (id: string) => {
        cancelled.push(id);
        live.get(id)?.();
      },
      close: async () => {},
    },
  };
}

const read = (tag: string): InlineTask => ({ tag, mode: "read", question: "Q?", inputs: [t.file(`${tag.replace(/\W/g, "_")}.txt`, "x\n")] });

describe("runEval inline", () => {
  test("a read task: the request, the record, eval.json and no grades", async () => {
    const s = stub({ usd: 0.01 });
    const out = join(t.dir, "out-read");
    const logDir = join(t.dir, "runs", "tune-t1");
    const tracked: string[] = [];
    const r = await runEval(
      { home: t.home, inline: [read("tune:t1:probe-inv")], root: ref, sub: ref, profile: "t1-inv", out, logDir, maxUsd: null, batch: "tune-t1", permissionMode: "default", track: (id) => (tracked.push(id), () => {}) },
      { session: s.session },
    );
    expect(s.started).toHaveLength(1);
    expect(s.started[0]).toMatchObject({ mode: "read", question: "Q?", profile: "t1-inv", root: ref, sub: ref, permissionMode: "default", interactive: false, conversation: false, batch: "tune-t1", tag: "tune:t1:probe-inv" });
    expect(s.started[0]!.logDir).toBe(logDir);
    expect(tracked).toEqual(["r_1"]);
    expect(r.runs[0]).toMatchObject({ tag: "tune:t1:probe-inv", run_id: "r_1", infra_kind: null, submitted: true, cost_usd: 0.01, error: null });
    expect(r.runs[0]!.record).toMatchObject({ run_id: "r_1", batch: "tune-t1" });
    expect(r.cost_usd).toBeCloseTo(0.01, 9);
    expect(JSON.parse(readFileSync(join(out, "eval.json"), "utf8"))).toMatchObject({ inline: true, batch: "tune-t1", profile: "t1-inv", interactive: false, permission_mode: "default" });
    expect(existsSync(join(out, "grades.jsonl"))).toBe(false);
  });

  test("a repo task: the work copy is made before run.start, after sees the run, remove always runs", async () => {
    const s = stub();
    const order: string[] = [];
    const task: InlineTask = {
      tag: "tune:t2:composed",
      mode: "repo",
      task: "Fix it",
      workCopy: async () => {
        order.push("copy");
        return { repoPath: t.dir, after: async (f) => void order.push(`after ${f?.submitted}`), remove: async () => void order.push("remove") };
      },
    };
    const r = await runEval({ home: t.home, inline: [task], root: ref, profile: "x", out: join(t.dir, "out-repo"), maxUsd: null, permissionMode: "accept-edits" }, { session: s.session });
    expect(order).toEqual(["copy", "after true", "remove"]);
    expect(s.started[0]).toMatchObject({ mode: "repo", task: "Fix it", repoPath: t.dir, interactive: false, conversation: false });
    expect(r.runs[0]!.infra_kind).toBeNull();
  });

  test("a work copy that fails is host_bug and no run starts; interactive can be set", async () => {
    const s = stub();
    const bad: InlineTask = { tag: "x", mode: "repo", task: "T", workCopy: async () => Promise.reject(new Error("no git")) };
    const r = await runEval({ home: t.home, inline: [bad, read("y")], root: ref, profile: "x", out: join(t.dir, "out-bad"), maxUsd: null, permissionMode: "default", interactive: true }, { session: s.session });
    expect(r.runs[0]).toMatchObject({ infra_kind: "host_bug", run_id: null });
    expect(r.runs[0]!.error).toContain("no git");
    expect(s.started).toHaveLength(1);
    expect(s.started[0]!.interactive).toBe(true);
  });

  test("sharedBus counts only this eval's runs; the eval's own cap cancels and says capped", async () => {
    const s = stub({ usd: 0.3, hold: true });
    s.bus.emit("call.end", { call_id: "u", run_id: "user_run", usage: { ...zero(), cost_usd: 9 }, finish_reason: "stop", seconds: 0 });
    const r = await runEval({ home: t.home, inline: [read("a"), read("b")], root: ref, profile: "x", out: join(t.dir, "out-cap"), maxUsd: 0.2, permissionMode: "default", sharedBus: true }, { session: s.session });
    expect(r.cost_usd).toBeCloseTo(0.3, 9);
    expect(r.capped).toBe(true);
    expect(s.cancelled).toEqual(["r_1"]);
    expect(r.runs.map((x) => x.infra_kind)).toEqual(["capped", "capped"]);
    expect(s.started).toHaveLength(1);
  });

  test("an account kind (D-257) stops the later tasks", async () => {
    const s = stub({ kind: { a: "no_credit" } });
    const r = await runEval({ home: t.home, inline: [read("a"), read("b")], root: ref, profile: "x", out: join(t.dir, "out-acct"), maxUsd: null, permissionMode: "default" }, { session: s.session });
    expect(r.account_stop).toBe("no_credit");
    expect(r.runs.map((x) => x.infra_kind)).toEqual(["no_credit", "no_credit"]);
    expect(r.runs[1]!.run_id).toBeNull();
    expect(s.started).toHaveLength(1);
  });
});
