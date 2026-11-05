// KV cache: none
// offline.ts: accept() on a table (D-173, D-209); with stub sessions and a stub runEval, a capped eval stops
// the tune (tune.json and one ledger line written, nothing left installed), a composed-side server error is
// rerun once and an auth one is not, and a round 2 whose estimate exceeds what is left doesn't start.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../src/bus.ts";
import type { EvalResult } from "../../src/eval/runner.ts";
import type { GradeLine } from "../../src/eval/report.ts";
import { loadSet, type EvalSet, type EvalTask } from "../../src/eval/set.ts";
import type { AppEvents } from "../../src/gateway/gateway.ts";
import type { ProfileInfo, RunFinishedParams } from "../../src/protocol.ts";
import type { StartRun } from "../../src/session.ts";
import { accept, runTune, tuneEstimate, type TuneDeps, type TuneOptions } from "../../src/tune/offline.ts";
import { temp } from "../cli/helpers.ts";
import { buildFixtureSet } from "../eval/fixture.ts";

const t = temp("rlmh-off-");
let set: EvalSet;
let base: ProfileInfo;
beforeAll(() => {
  set = loadSet(buildFixtureSet(t.dir));
  const dir = join(t.dir, "base-profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.toml"), "[read]\nmax_turns = 50\n");
  writeFileSync(join(dir, "guidance.md"), "Be careful.\n");
  base = { name: "mine", source: "user", prompt_hash: "p".repeat(64), profile_hash: "h".repeat(64), agent_api: true, limits: limits(), path: dir };
});
afterAll(() => t.cleanup());

function limits(): ProfileInfo["limits"] {
  const m = { max_turns: 50, max_subcalls: 100, root_max_tokens: 16384, output_max_chars: 8000, subcall_max_chars: 500000, subcall_max_tokens: 16384, cell_timeout_s: 300, root_temperature: null, sub_temperature: null, subcall_thinking: null, subcall_oversize: "error" } as unknown as ProfileInfo["limits"]["read"];
  return { read: m, repo: m };
}

const line = (id: string, o: Partial<GradeLine> = {}): GradeLine => ({
  id, track: "python", kind: "repo", size: "S", split: "tune", run_id: "r", submitted: true, infra_kind: null, pass: false, score: 0, f2p_share: 0,
  test_tamper: false, leak_suspect: false, turns: 1, subcalls: 0, compactions: 0, cost_usd: 1, cache_hit: null, input_tokens: 0,
  cache_read_tokens: 0, wall_s: 1, grade_error: null, env_log: null, ...o,
});

describe("accept()", () => {
  const ref = [line("a", { pass: true, f2p_share: 1 }), line("b"), line("c"), line("d")];
  test("one more pass is accepted; equal is not", () => {
    expect(accept(ref, [line("a", { pass: true, f2p_share: 1 }), line("b", { pass: true, f2p_share: 1 }), line("c"), line("d")])).toMatchObject({ accepted: true, reason: "accepted", compared: 4 });
    expect(accept(ref, ref).accepted).toBe(false);
    expect(accept(ref, ref).reason).toBe("passes");
  });
  test("a lower mean f2p_share is rejected, and so is 1.6x the cost", () => {
    const lower = [line("a", { pass: true, f2p_share: 1 }), line("b", { pass: true, f2p_share: 1 }), line("c", { f2p_share: 0 }), line("d")];
    const refShare = [line("a", { pass: true, f2p_share: 1 }), line("b", { f2p_share: 0.9 }), line("c", { f2p_share: 0.9 }), line("d", { f2p_share: 0.9 })];
    expect(accept(refShare, lower).reason).toBe("f2p_share");
    const pricey = [line("a", { pass: true, f2p_share: 1, cost_usd: 1.6 }), line("b", { pass: true, f2p_share: 1, cost_usd: 1.6 }), line("c", { cost_usd: 1.6 }), line("d", { cost_usd: 1.6 })];
    expect(accept(ref, pricey).reason).toBe("cost");
  });
  test("infra is left out on either side; more than a quarter left out keeps the incumbent", () => {
    const five = [...ref, line("e")];
    const one = accept(five, [line("a", { pass: true, f2p_share: 1 }), line("b", { pass: true, f2p_share: 1 }), line("c", { infra_kind: "rate_limit" }), line("d"), line("e")]);
    expect(one).toMatchObject({ excluded: ["c"], compared: 4, accepted: true });
    const capped = accept(five, [line("a", { pass: true, f2p_share: 1 }), line("b", { infra_kind: "capped" }), line("c"), line("d"), line("e")]);
    expect(capped.excluded).toEqual([]); // capped counts as a fail
    const two = accept(ref, [line("a", { infra_kind: "server" }), line("b", { infra_kind: "auth", pass: true }), line("c"), line("d")]);
    expect(two).toMatchObject({ accepted: false, reason: "infra" });
  });
});

// -- runTune with stubs --

interface Stub {
  session: TuneDeps["session"];
  started: StartRun[];
}

/** Sessions that read their stage.md and submit the scripted answer; each costs `usd`. */
function stubSession(answers: Record<string, unknown>, usd = 0): Stub {
  const bus = new Bus<AppEvents>();
  const started: StartRun[] = [];
  let n = 0;
  return {
    started,
    session: {
      bus,
      start: async (r: StartRun) => {
        const id = `s_${n++}`;
        started.push(r);
        const stageFile = r.inputs!.find((f) => f.replace(/\\/g, "/").endsWith("/stage.md"))!;
        const stage = /stage: (\w+)/.exec(readFileSync(stageFile, "utf8"))![1]!;
        setTimeout(() => {
          bus.emit("call.end", { call_id: `${id}-c`, run_id: id, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: usd }, finish_reason: "stop", seconds: 0 });
          const f: RunFinishedParams = {
            run_id: id, tag: r.tag ?? null, answer: JSON.stringify(answers[stage]), submitted: true, answer_valid: true, turns: 1, subcalls: 0,
            usage: { root: zero(), sub: zero() }, cost_usd: usd, infra_error: null, infra_kind: null, wall_s: 0, log_path: "", prompt_index: 0, open: false,
          };
          bus.emit("engine.event", { method: "run.finished", params: f });
        }, 5);
        return { run_id: id, log_path: "" };
      },
      cancel: async () => {},
      close: async () => {},
      checkProfile: async () => ({ ok: true, errors: [], prompt_hash: "q".repeat(64), profile_hash: "c".repeat(64), changed: ["guidance"] }),
    },
  };
}
function zero() {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };
}

const EDIT = { decision: "EDIT", notes: ["n"], guidance: "Be more careful.\n", toml: {}, files: {} };
const KEEP = { decision: "KEEP_BASE", notes: [], guidance: null, toml: {}, files: {} };
const ANSWERS = { inv: EDIT, dom: KEEP, compose: { ...KEEP, decision: "ADOPT", adopt: "inv" }, reflect: { domain: "repo", entry: "NO_ENTRY", edits: [] } };

/** A reference eval output: every tune task once, fails, at $1 each. */
function writeRef(dir: string, tasks: EvalTask[], o: Partial<GradeLine> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "grades.jsonl"), tasks.map((x) => `${JSON.stringify(line(x.id, { kind: x.kind, track: x.track, f2p_share: x.kind === "repo" ? 0 : null, ...o }))}\n`).join(""));
  writeFileSync(join(dir, "runs.jsonl"), tasks.map((x) => `${JSON.stringify({ run_id: `r_${x.id}`, tag: x.id, mode: x.kind, submitted: true, answer: 1, turns: [{ turn: 1, code: "print(1)", stdout: "1\n" }], subcalls: [], messages: [{ role: "system", content: "SYS" }] })}\n`).join(""));
  writeFileSync(join(dir, "eval.json"), JSON.stringify({ tasks: tasks.map((x) => x.id) }));
  return dir;
}

/** A runEval stub: writes the output folder with the lines `make` gives. */
function stubEval(make: (tasks: EvalTask[], profile: string, out: string) => { lines: GradeLine[]; capped?: boolean }, calls: string[] = []) {
  return async (o: { tasks: EvalTask[]; profile: string; out: string }): Promise<EvalResult> => {
    calls.push(`${o.profile} ${o.out.replace(/\\/g, "/").split("/").slice(-2).join("/")}`);
    const { lines, capped } = make(o.tasks, o.profile, o.out);
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, "grades.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    writeFileSync(join(o.out, "runs.jsonl"), lines.map((l) => `${JSON.stringify({ run_id: `r_${l.id}`, tag: l.id, mode: l.kind, submitted: true, answer: 1, turns: [], subcalls: [] })}\n`).join(""));
    writeFileSync(join(o.out, "eval.json"), "{}");
    return { id: "e", out: o.out, lines, capped: capped ?? false, interrupted: false, aborted: false, cost_usd: lines.reduce((a, l) => a + l.cost_usd, 0), gpu_backend: null, engineExit: undefined };
  };
}

function options(home: string, out: string, from: string, over: Partial<TuneOptions> = {}): TuneOptions {
  const tune = set.tasks.filter((x) => x.split === "tune" && x.track !== "kernel");
  return {
    home, set, base, name: "tuned", root: { provider: "fake", model: "scripted", thinking: null }, sub: { provider: "fake", model: "scripted", thinking: null },
    from, rounds: 1, probe: 1, seed: "0", jobs: 1, out, maxUsd: 100, gated: false, gpu: "none", tokensFrom: [],
    estimate: { rounds: [], total_usd: 0, default_cap_usd: 0, evidence_chars: 0, unpriced: [] }, harnessCommit: null, catalog: { get: () => undefined },
    ...over,
    ...(tune ? {} : {}),
  };
}

const tuneTasks = () => set.tasks.filter((x) => x.split === "tune" && x.track !== "kernel");
const ledger = (home: string) => readFileSync(join(home, "eval", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("runTune (stubs)", () => {
  test("an accepted round: probe, compose (ADOPT inv), accept, final installed, one tune ledger line", async () => {
    const home = join(t.dir, "home-ok");
    const out = join(t.dir, "out-ok");
    const from = writeRef(join(t.dir, "ref-ok"), tuneTasks());
    const calls: string[] = [];
    const s = stubSession(ANSWERS);
    const r = await runTune(options(home, out, from), { session: s.session, runEval: stubEval((tasks) => ({ lines: tasks.map((x) => line(x.id, { kind: x.kind, track: x.track, pass: true, f2p_share: x.kind === "repo" ? 1 : null })) }), calls) as never, onInterrupt: () => () => {} });
    expect(r.stopped).toBeNull();
    expect(r.accepted_rounds).toEqual([1]);
    expect(calls).toEqual(["tuned-r1-inv evals/inv", "tuned-r1 evals/composed"]);
    expect(readFileSync(join(out, "final", "guidance.md"), "utf8")).toBe("Be more careful.\n");
    expect(readdirSync(join(home, "profiles"))).toEqual(["tuned"]);
    const j = JSON.parse(readFileSync(join(out, "tune.json"), "utf8"));
    expect(j.rounds[0]).toMatchObject({ result: "accepted", stages: { inv: { decision: "EDIT" }, dom: { decision: "KEEP_BASE" }, compose: { decision: "ADOPT", adopt: "inv" } } });
    expect(j.counts.sessions).toBe(4);
    expect(ledger(home)).toHaveLength(1);
    expect(ledger(home)[0]).toMatchObject({ what: "tune", profile: "tuned" });
    expect(s.started.every((x) => x.profile === "default" && x.mode === "read" && x.permissionMode === "accept-edits")).toBe(true);
    expect(s.started[0]!.tag).toMatch(/^tune:tuned-.*:r1-(inv|dom)$/);
  });

  test("a capped eval stops the tune: no later stage, tune.json and one ledger line, nothing installed", async () => {
    const home = join(t.dir, "home-cap");
    const out = join(t.dir, "out-cap");
    const from = writeRef(join(t.dir, "ref-cap"), tuneTasks());
    const s = stubSession(ANSWERS);
    const r = await runTune(options(home, out, from), { session: s.session, runEval: stubEval((tasks) => ({ lines: tasks.map((x) => line(x.id, { infra_kind: "capped" })), capped: true })) as never, onInterrupt: () => () => {} });
    expect(r.stopped).toBe("max_usd");
    expect(s.started.filter((x) => x.tag!.endsWith("compose"))).toEqual([]);
    expect(existsSync(join(out, "tune.json"))).toBe(true);
    expect(ledger(home)).toHaveLength(1);
    expect(existsSync(join(home, "profiles")) ? readdirSync(join(home, "profiles")) : []).toEqual([]);
    expect(readFileSync(join(out, "final", "guidance.md"), "utf8")).toBe("Be careful.\n");
  });

  test("a composed-side server error is rerun once; an auth one is not", async () => {
    const home = join(t.dir, "home-rerun");
    const out = join(t.dir, "out-rerun");
    const tasks = tuneTasks();
    const from = writeRef(join(t.dir, "ref-rerun"), tasks);
    const calls: string[] = [];
    const reruns: string[][] = [];
    await runTune(options(home, out, from), {
      session: stubSession(ANSWERS).session,
      runEval: stubEval((ts, _p, o) => {
        if (o.replace(/\\/g, "/").endsWith("composed/rerun")) reruns.push(ts.map((x) => x.id));
        if (o.replace(/\\/g, "/").endsWith("evals/composed")) return { lines: ts.map((x, i) => line(x.id, { infra_kind: i === 0 ? "server" : i === 1 ? "auth" : null })) };
        return { lines: ts.map((x) => line(x.id)) };
      }, calls) as never,
      onInterrupt: () => () => {},
    });
    expect(reruns).toEqual([[tasks[0]!.id]]);
  });

  test("round 2 whose estimate exceeds what is left doesn't start: budget_stop 2, exit-worthy null stop", async () => {
    const home = join(t.dir, "home-budget");
    const out = join(t.dir, "out-budget");
    const from = writeRef(join(t.dir, "ref-budget"), tuneTasks());
    const priced = { get: () => ({ price: { input: 1, output: 1, cache_read: 0, cache_write: 0 } }) } as never;
    const r = await runTune(options(home, out, from, { rounds: 2, maxUsd: 3, root: { provider: "openrouter", model: "x/y", thinking: null }, sub: { provider: "openrouter", model: "x/y", thinking: null }, catalog: priced }), {
      session: stubSession(ANSWERS, 0.1).session,
      runEval: stubEval((ts) => ({ lines: ts.map((x) => line(x.id, { cost_usd: 0.1 })) })) as never,
      onInterrupt: () => () => {},
    });
    expect(r.stopped).toBeNull();
    expect(r.budget_stop).toBe(2);
    const j = JSON.parse(readFileSync(join(out, "tune.json"), "utf8"));
    expect(j.budget_stop).toBe(2);
    expect(j.rounds).toHaveLength(1);
  });
});

describe("tuneEstimate", () => {
  test("every stage is listed and priced from the bundled catalog for S-43's model; the default cap is 2x; --from supplies the tokens", async () => {
    const { Catalog } = await import("../../src/gateway/catalog.ts");
    const catalog = new Catalog(join(t.dir, "home-est"));
    const ds = { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017", thinking: null };
    const tune = tuneTasks();
    const from = writeRef(join(t.dir, "ref-est"), tune);
    const e = tuneEstimate({ set, tune, probe: tune.slice(0, 1), root: ds, sub: ds, catalog, profile: base, home: join(t.dir, "home-est"), runLogs: [join(from, "runs.jsonl")], from, rounds: 2 });
    expect(e.rounds.map((r) => r.stages.map((s) => s.stage))).toEqual([0, 1].map(() => ["inv session", "dom session", "probe inv", "probe dom", "compose session", "accept (tune split)", "reflect session"]));
    expect(e.unpriced).toEqual([]);
    expect(e.total_usd).toBeGreaterThan(0);
    expect(e.default_cap_usd).toBeCloseTo(2 * e.total_usd!, 9);
    expect(e.evidence_chars).toBeGreaterThan(0);
    expect(e.rounds[0]!.fits).toBe(true);
  });
});
