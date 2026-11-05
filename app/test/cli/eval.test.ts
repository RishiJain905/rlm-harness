// KV cache: none
// `rlmh eval` end to end: the real engine from source and the scripted fake provider, on the fixture set.
// Child processes for the CLI's own behaviour; in-process evalCommand and runEval, with stub probes,
// sessions and graders, for the GPU choice, the engine's env and the pool's exclusive groups.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../src/bus.ts";
import { evalCommand } from "../../src/cli/eval.ts";
import type { CliIO } from "../../src/cli/run.ts";
import type { RepoGrade } from "../../src/eval/graders.ts";
import { runEval, type EvalSession } from "../../src/eval/runner.ts";
import { loadSet, type RepoTask } from "../../src/eval/set.ts";
import { parseProbe, type Runner } from "../../src/eval/work.ts";
import type { AppEvents } from "../../src/gateway/gateway.ts";
import type { RunFinishedParams } from "../../src/protocol.ts";
import { buildFixtureSet, editSet, FIXTURE } from "../eval/fixture.ts";
import { jsonLines, REAL, rlmh, temp, type Temp } from "./helpers.ts";

const LONG = 300_000;
const FAKE = ["--root", "fake/scripted", "--sub", "fake/scripted"];
const OFFLINE = { UV_OFFLINE: "1" };
const FOUR = "fx-search-R-01,fx-research-R-01,fx-python-S-01,fx-python-S-02";
/** One root entry: in a repo copy it writes S-01's fix (S-02 has no calc/ at its root), in read mode it submits the line count. */
const SCRIPT = {
  root: [
    {
      text: "",
      tool_call: {
        code:
          "import pathlib\nif pathlib.Path('.git').is_dir():\n    p = pathlib.Path('calc/__init__.py')\n    if p.exists():\n" +
          "        p.write_text(p.read_text().replace('a - b', 'a + b'))\n    submit('done')\nelse:\n    submit(len(context.splitlines()))\n",
      },
    },
  ],
};
const ENV_SCRIPT = {
  root: [
    {
      text: "",
      tool_call: {
        code:
          "import os, json, pathlib\nif pathlib.Path('.git').is_dir():\n    submit('done')\nelse:\n    submit(json.dumps({k: os.environ.get(k) for k in " +
          "['PLAYWRIGHT_BROWSERS_PATH', 'IS_EVAL_PRODUCTION', 'RLMH_GPU_BACKEND', 'FAKE_TEST_KEY']}))\n",
      },
    },
  ],
};

let t: Temp;
let set: string;
let script: string;
beforeAll(() => {
  t = temp("rlmh-eval-");
  set = buildFixtureSet(t.dir);
  script = t.script(SCRIPT);
});
afterAll(() => t.cleanup());

const records = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

/** CliIO with captured output, for in-process calls. */
function captured(home: string): CliIO & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c) => void (out += c) },
    stderr: { write: (c) => void (err += c) },
    stdin: process.stdin,
    isTTY: false,
    home,
    out: () => out,
    err: () => err,
  };
}

/** A runner that plays uv (a venv folder and its site-packages) and pnpm (success). */
function fakeRunner(home: string): Runner {
  return async (argv) => {
    if (argv[1] === "venv") mkdirSync(argv[4]!, { recursive: true });
    if (argv.includes("-c")) {
      const site = join(home, "site", String(Math.random()).slice(2));
      mkdirSync(site, { recursive: true });
      return { code: 0, stdout: `${site}\n`, stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}
const READY = { ok: true as const, node: "node", pnpm: "pnpm", nodeVersion: "22.11.0", pnpmVersion: "10.34.7" };

describe("rlmh eval --go", () => {
  test(
    "--go --json --jobs 2 on two read and two Python tasks",
    async () => {
      const home = join(t.dir, "home-go");
      const out = join(t.dir, "out-go");
      const r = await rlmh(["eval", set, "--go", "--json", "--jobs", "2", "--only", FOUR, "--out", out, ...FAKE], { home, script, env: OFFLINE });
      expect(r.stderr).not.toMatch(/error|fail/i); // preparation lines only
      expect(r.code).toBe(0);
      const lines = jsonLines(r.stdout);
      const tasks = Object.fromEntries(lines.filter((l) => l.type === "eval.task").map((l) => [l.id, l]));
      expect(tasks["fx-python-S-01"]).toMatchObject({ pass: true, f2p_share: 1, track: "python" });
      expect(tasks["fx-python-S-02"]).toMatchObject({ pass: false, f2p_share: 0 });
      expect(tasks["fx-search-R-01"]).toMatchObject({ pass: true, score: 1 });
      expect(tasks["fx-research-R-01"]).toMatchObject({ pass: false });
      expect(lines[lines.length - 1]).toEqual({ type: "eval.finished", runs: 4, passed: 2, infra: 0, cost_usd: 0, capped: false, account_stop: null, out });
      expect(lines.some((l) => l.type === "run.started")).toBe(true);
      for (const f of ["grades.jsonl", "report.json", "report.md", "eval.json", "runs.jsonl"]) expect(existsSync(join(out, f))).toBe(true);
      expect(records(join(out, "grades.jsonl")).every((l) => typeof l.track === "string")).toBe(true);
      const ledger = records(join(home, "eval", "ledger.jsonl"));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ what: "eval", set: "harness-eval-fixture", runs: 4, cost_usd: 0, out });
      expect(readdirSync(join(home, "eval", "work"))).toEqual([]);
      const meta = JSON.parse(readFileSync(join(out, "eval.json"), "utf8"));
      expect(meta).toMatchObject({ set: "harness-eval-fixture", split: "all", profile: "default", jobs: 2, gpu_backend: null, capped: false });
      expect(meta.profile_hash).toMatch(/^[0-9a-f]{64}$/);

      // --rerun: a server error is rerun, an auth error is not
      const grades = records(join(out, "grades.jsonl")).map((l) =>
        l.id === "fx-search-R-01" ? { ...l, infra_kind: "server", pass: false } : l.id === "fx-python-S-01" ? { ...l, infra_kind: "auth", pass: false } : l,
      );
      writeFileSync(join(out, "grades.jsonl"), grades.map((l) => `${JSON.stringify(l)}\n`).join(""));
      const again = await rlmh(["eval", set, "--rerun", out, "--go", "--json"], { home, script, env: OFFLINE });
      expect(again.code).toBe(0);
      const rerun = jsonLines(again.stdout).filter((l) => l.type === "eval.task");
      expect(rerun.map((l) => l.id)).toEqual(["fx-search-R-01"]);
      expect(JSON.parse(readFileSync(join(out, "rerun", "eval.json"), "utf8")).rerun_of).toBe(out);
      const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
      expect(report.track.search).toMatchObject({ n: 1, passed: 1, infra: 0 });
      expect(report.total.infra).toBe(1); // the auth line stays
      const twice = await rlmh(["eval", set, "--rerun", out, "--go"], { home, script, env: OFFLINE });
      expect(twice.code).toBe(2);
      expect(twice.stderr).toContain("is not empty");
      expect(records(join(home, "eval", "ledger.jsonl"))).toHaveLength(2);

      // compare and ledger read folders only
      const cmp = await rlmh(["eval", "compare", out, join(out, "rerun")], { home });
      expect(cmp.code).toBe(0);
      expect(cmp.stdout).toContain("paired tasks: 1 (only in A: 3, only in B: 0)");
      expect(cmp.stdout).toContain("within noise");
      const led = await rlmh(["eval", "ledger"], { home });
      expect(led.stdout).toContain("total: $0.00 of $30");
      const rep = await rlmh(["eval", "report", out], { home });
      expect(rep.code).toBe(0);
      expect(rep.stdout).toContain("## By track");
    },
    LONG,
  );

  test(
    "out of credit (HTTP 402 → no_credit): no new task starts, eval.json says why, exit 1 (D-257)",
    async () => {
      const home = join(t.dir, "home-credit");
      const out = join(t.dir, "out-credit");
      const noCredit = t.script({ ...SCRIPT, errors: [{ role: "root", at: 1, kind: "no_credit", status: 402 }] });
      const r = await rlmh(["eval", set, "--go", "--json", "--jobs", "1", "--only", "fx-search-R-01,fx-research-R-01", "--out", out, ...FAKE], { home, script: noCredit });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("the provider says the account is out of credit (no_credit)");
      expect(r.stderr).toContain("Add credit, then run again.");
      const lines = jsonLines(r.stdout);
      const tasks = lines.filter((l) => l.type === "eval.task");
      expect(tasks.map((l) => l.infra_kind)).toEqual(["no_credit", "no_credit"]);
      expect(tasks.filter((l) => l.run_id !== null)).toHaveLength(1); // the second never started
      expect(lines[lines.length - 1]).toMatchObject({ type: "eval.finished", infra: 2, account_stop: "no_credit" });
      expect(JSON.parse(readFileSync(join(out, "eval.json"), "utf8"))).toMatchObject({ account_stop: "no_credit" });
      // an account kind is not transient: --rerun finds nothing to rerun
      const again = await rlmh(["eval", set, "--rerun", out, "--go"], { home, script });
      expect(again.code).toBe(2);
      expect(again.stderr).toContain("no task in");
    },
    REAL,
  );

  test(
    "without --go: the estimate, no out folder, exit 0",
    async () => {
      const home = join(t.dir, "home-est");
      const out = join(t.dir, "out-est");
      const r = await rlmh(["eval", set, "--only", "fx-search-R-01,fx-python-S-01", "--out", out, ...FAKE], { home, script });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("estimate: $0.00");
      expect(r.stdout).toContain("| python/S | 1 | reference |");
      expect(r.stdout).toContain("venv fx:");
      expect(r.stdout).toContain("permission mode bypass");
      expect(existsSync(out)).toBe(false);
      expect(existsSync(join(home, "eval", "ledger.jsonl"))).toBe(false);
    },
    REAL,
  );
});

describe("exit 2 before any engine starts", () => {
  const no = async (args: string[], want: string, env: Record<string, string> = {}) => {
    const r = await rlmh(["eval", ...args, ...FAKE], { home: join(t.dir, "home-usage"), env });
    expect(r.stderr).toContain(want);
    expect(r.code).toBe(2);
  };

  test("a bad set, a full --out, --sample without --seed", async () => {
    await no([join(t.dir, "no-such-set")], "manifest.json is missing");
    const full = join(t.dir, "full");
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, "x"), "");
    await no([set, "--only", "fx-search-R-01", "--out", full], "is not empty");
    await no([set, "--only", "fx-search-R-01", "--sample", "2"], "--sample needs --seed");
    await no([set, "--gpu", "metal"], "--gpu must be cuda, hip or none");
  });

  test("a web task while PATH has node but no pnpm", async () => {
    const bin = join(t.dir, "bin-node-only");
    mkdirSync(bin, { recursive: true });
    if (process.platform === "win32") writeFileSync(join(bin, "node.cmd"), "@echo off\r\necho v22.11.0\r\n");
    else writeFileSync(join(bin, "node"), "#!/bin/sh\necho v22.11.0\n", { mode: 0o755 });
    const keep = process.platform === "win32" ? [process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32"] : ["/usr/bin", "/bin"];
    await no([set, "--only", "fx-web-S-01"], "pnpm is not on PATH", { PATH: [bin, ...keep].join(process.platform === "win32" ? ";" : ":") });
  });

  test.skipIf(process.platform !== "darwin")("a kernel task on macOS", async () => {
    await no([set, "--only", "fx-kernel-S-01"], "macOS doesn't have");
  });
});

describe("the GPU choice and the engine's env (stub probe)", () => {
  const kernelDeps = (home: string, probe: (backend?: string) => { backend: "cuda" | "hip" | "none"; devices: number }, seen: (string | undefined)[] = []) => ({
    runEval: {
      uv: "uv-fake",
      run: fakeRunner(home),
      probeGpu: async (_v: unknown, _s: string, o: { backend?: string } = {}) => {
        seen.push(o.backend);
        return probe(o.backend);
      },
      gradeRepo: async (): Promise<RepoGrade> => ({ resolved: false, f2p_share: 0, test_tamper: false, reverted: [], grade_error: null, results: new Map() }),
    },
  });

  // macOS refuses kernel tasks before any of this (the test above)
  test.skipIf(process.platform === "darwin")(
    "no device: --go exits 2 naming the kernel task and --gpu none; --gpu none leaves it out; --gpu hip reaches the probe",
    async () => {
      const home = join(t.dir, "home-gpu");
      const io = captured(home);
      const code = await evalCommand([set, "--only", "fx-kernel-S-01", "--go", "--out", join(t.dir, "out-gpu0"), ...FAKE], io, kernelDeps(home, () => ({ backend: "none", devices: 0 })));
      expect(code).toBe(2);
      expect(io.err()).toContain("fx-kernel-S-01");
      expect(io.err()).toContain("--gpu none");
      expect(existsSync(join(t.dir, "out-gpu0", "eval.json"))).toBe(false);

      const none = captured(home);
      expect(await evalCommand([set, "--only", "fx-kernel-S-01,fx-search-R-01", "--gpu", "none", ...FAKE], none)).toBe(0);
      expect(none.out()).toContain("note: --gpu none leaves out 1 kernel task(s): fx-kernel-S-01");
      expect(none.out()).not.toContain("kernel/S");

      const seen: (string | undefined)[] = [];
      const bad = captured(home);
      const badCode = await evalCommand([set, "--only", "fx-kernel-S-01", "--gpu", "hip", "--go", "--out", join(t.dir, "out-gpu-bad"), ...FAKE], bad, kernelDeps(home, () => parseProbe("GeForce something\nbackend=cuda devices=1"), seen));
      expect(badCode).toBe(2);
      expect(seen).toEqual(["hip"]);
      expect(bad.err()).toContain("did not print one line");
      expect(bad.err()).not.toContain("GeForce");

      const warn = captured(home);
      expect(await evalCommand([set, "--only", "fx-kernel-S-01", "--gpu", "cuda", ...FAKE], warn)).toBe(0);
      expect(warn.out()).toContain("validated on hip, not cuda");
    },
    LONG,
  );

  test.skipIf(process.platform === "darwin")(
    "PLAYWRIGHT_BROWSERS_PATH, IS_EVAL_PRODUCTION and RLMH_GPU_BACKEND reach the worker, a key-like variable doesn't",
    async () => {
      const home = join(t.dir, "home-env");
      const out = join(t.dir, "out-env");
      const io = captured(home);
      const saved = { script: process.env.RLMH_FAKE_SCRIPT, key: process.env.FAKE_TEST_KEY };
      process.env.RLMH_FAKE_SCRIPT = t.file("env-script.json", JSON.stringify(ENV_SCRIPT));
      process.env.FAKE_TEST_KEY = "sk-FAKE-must-not-arrive";
      let code: number;
      try {
        code = await evalCommand([set, "--only", "fx-search-R-01,fx-kernel-S-01", "--go", "--out", out, ...FAKE], io, kernelDeps(home, () => ({ backend: "hip", devices: 1 })));
      } finally {
        process.env.RLMH_FAKE_SCRIPT = saved.script;
        if (saved.script === undefined) delete process.env.RLMH_FAKE_SCRIPT;
        if (saved.key === undefined) delete process.env.FAKE_TEST_KEY;
        else process.env.FAKE_TEST_KEY = saved.key;
      }
      expect(io.err()).not.toContain("error");
      expect(code).toBe(0);
      const answer = JSON.parse(records(join(out, "runs.jsonl")).find((r) => r.tag === "fx-search-R-01").answer);
      expect(answer).toEqual({ PLAYWRIGHT_BROWSERS_PATH: join(home, "eval", "ms-playwright"), IS_EVAL_PRODUCTION: "1", RLMH_GPU_BACKEND: "hip", FAKE_TEST_KEY: null });
      const meta = JSON.parse(readFileSync(join(out, "eval.json"), "utf8"));
      expect(meta.gpu_backend).toBe("hip");
      expect(Object.keys(meta).filter((k) => /gpu/i.test(k))).toEqual(["gpu_backend"]);
    },
    LONG,
  );

  test(
    "the real gpu.py --probe under the engine's Python prints one line (backend=none devices=0 on CI)",
    () => {
      const r = Bun.spawnSync(["uv", "run", "--project", join(import.meta.dir, "..", "..", "..", "engine"), "python", "-I", join(FIXTURE, "gpu", "gpu.py"), "--probe"], { stdout: "pipe", stderr: "pipe" });
      const text = r.stdout.toString();
      const probe = parseProbe(text);
      expect(r.exitCode).toBe(0);
      if (process.env.CI) expect(text.replace(/\r?\n$/, "")).toBe("backend=none devices=0");
      else expect(["none", "cuda", "hip"]).toContain(probe.backend);
    },
    REAL,
  );
});

describe("the pool's exclusive groups (stub session, grader and probe)", () => {
  test(
    "src tasks on one venv never overlap, nor do two web or two kernel tasks; a web and a kernel task do",
    async () => {
      const dir = buildFixtureSet(join(t.dir, "groups"));
      editSet(dir, (tasks, grades) => {
        const copy = (from: string, id: string) => {
          tasks.push({ ...tasks.find((x) => x.id === from), id });
          grades.push({ ...grades.find((x) => x.id === from), id });
        };
        copy("fx-web-S-01", "fx-web-S-02");
        copy("fx-kernel-S-01", "fx-kernel-S-02");
        copy("fx-python-S-02", "fx-python-S-03");
      });
      const s = loadSet(dir);
      const home = join(t.dir, "home-groups");
      const spans = new Map<string, { start: number; end: number }>();
      const bus = new Bus<AppEvents>();
      let n = 0;
      const tagOf = new Map<string, string>();
      const session: EvalSession = {
        bus,
        start: async (r) => {
          const id = `r_${n++}`;
          tagOf.set(id, r.tag!);
          spans.set(r.tag!, { start: performance.now(), end: 0 });
          setTimeout(() => {
            const f: RunFinishedParams = {
              run_id: id,
              tag: r.tag ?? null,
              answer: "done",
              submitted: true,
              answer_valid: true,
              turns: 1,
              subcalls: 0,
              usage: { root: zero(), sub: zero() },
              cost_usd: 0,
              infra_error: null,
              infra_kind: null,
              prompt_index: 0,
              open: false,
              wall_s: 0.05,
              log_path: "",
            };
            bus.emit("engine.event", { method: "run.finished", params: f });
          }, 40);
          return { run_id: id, log_path: "" };
        },
        cancel: async () => {},
        close: async () => {},
      };
      const ids = ["fx-python-S-02", "fx-kernel-S-01", "fx-web-S-01", "fx-web-S-02", "fx-kernel-S-02", "fx-python-S-03"];
      const result = await runEval(
        { home, set: s, tasks: s.tasks.filter((x) => ids.includes(x.id)), split: "all", root: { provider: "fake", model: "scripted", thinking: null }, profile: "default", jobs: 4, out: join(t.dir, "out-groups"), maxUsd: null, ledger: false },
        {
          session,
          uv: "uv-fake",
          run: fakeRunner(home),
          tools: READY,
          probeGpu: async () => ({ backend: "cuda", devices: 1 }),
          gradeRepo: async (task: RepoTask) => {
            await Bun.sleep(40);
            spans.get(task.id)!.end = performance.now();
            return { resolved: true, f2p_share: 1, test_tamper: false, reverted: [], grade_error: null, results: new Map() };
          },
          onInterrupt: () => () => {},
        },
      );
      expect(result.lines.map((l) => l.infra_kind)).toEqual(ids.map(() => null));
      const overlap = (a: string, b: string) => {
        const x = spans.get(a)!;
        const y = spans.get(b)!;
        return x.start < y.end && y.start < x.end;
      };
      expect(overlap("fx-web-S-01", "fx-web-S-02")).toBe(false);
      expect(overlap("fx-kernel-S-01", "fx-kernel-S-02")).toBe(false);
      expect(overlap("fx-python-S-02", "fx-python-S-03")).toBe(false);
      expect(overlap("fx-web-S-01", "fx-kernel-S-01")).toBe(true);
    },
    LONG,
  );
});

describe("the pool's stops (stub session)", () => {
  /** A session whose every run costs `usd` in one call.end, then finishes after 30 ms. */
  function costly(usd: number, started: string[]): EvalSession {
    const bus = new Bus<AppEvents>();
    let n = 0;
    return {
      bus,
      start: async (r) => {
        const id = `r_${n++}`;
        started.push(r.tag!);
        bus.emit("call.end", { call_id: `${id}-c`, run_id: id, usage: { ...zero(), cost_usd: usd }, finish_reason: "stop", seconds: 0 });
        setTimeout(() => {
          const f: RunFinishedParams = {
            run_id: id, tag: r.tag ?? null, answer: 5, submitted: true, answer_valid: true, turns: 1, subcalls: 0,
            usage: { root: zero(), sub: zero() }, cost_usd: usd, infra_error: null, infra_kind: null, wall_s: 0.03, log_path: "",
            prompt_index: 0, open: false,
          };
          bus.emit("engine.event", { method: "run.finished", params: f });
        }, 30);
        return { run_id: id, log_path: "" };
      },
      cancel: async () => {},
      close: async () => {},
    };
  }
  const base = (out: string, home: string, ids: string[], maxUsd: number | null) => {
    const s = loadSet(set);
    return { home, set: s, tasks: s.tasks.filter((x) => ids.includes(x.id)), split: "all" as const, root: { provider: "fake", model: "scripted", thinking: null }, profile: "default", jobs: 1, out, maxUsd };
  };

  test("once the cap trips no task starts, and the rest get capped lines", async () => {
    const home = join(t.dir, "home-cap");
    const started: string[] = [];
    const r = await runEval(base(join(t.dir, "out-cap"), home, ["fx-search-R-01", "fx-research-R-01"], 0.5), { session: costly(1, started), onInterrupt: () => () => {} });
    expect(started).toEqual(["fx-search-R-01"]);
    expect(r.capped).toBe(true);
    expect(r.lines.map((l) => [l.id, l.infra_kind])).toEqual([["fx-search-R-01", null], ["fx-research-R-01", "capped"]]);
    expect(JSON.parse(readFileSync(join(t.dir, "out-cap", "eval.json"), "utf8"))).toMatchObject({ capped: true, cost_usd: 1 });
    expect(records(join(home, "eval", "ledger.jsonl"))[0]).toMatchObject({ runs: 1, cost_usd: 1 });
  });

  test("an account kind (D-257) stops the pool: the running run is cancelled, the rest get its kind", async () => {
    const home = join(t.dir, "home-account");
    const out = join(t.dir, "out-account");
    const bus = new Bus<AppEvents>();
    const started: string[] = [];
    const cancelled: string[] = [];
    const finish = (id: string, tag: string | null, kind: string | null) =>
      bus.emit("engine.event", {
        method: "run.finished",
        params: {
          run_id: id, tag, answer: kind === null ? 5 : null, submitted: kind === null, answer_valid: kind === null, turns: 1, subcalls: 0,
          usage: { root: zero(), sub: zero() }, cost_usd: 0, infra_error: kind === null ? null : `${kind}: boom`, infra_kind: kind, wall_s: 0.01, log_path: "",
          prompt_index: 0, open: false,
        },
      });
    let n = 0;
    const session: EvalSession = {
      bus,
      start: async (r) => {
        const id = `r_${n++}`;
        started.push(r.tag!);
        if (id === "r_0") setTimeout(() => finish(id, r.tag ?? null, "no_credit"), 10); // the second waits to be cancelled
        return { run_id: id, log_path: "" };
      },
      cancel: async (id) => {
        cancelled.push(id);
        finish(id, null, "cancelled");
      },
      close: async () => {},
    };
    const ids = ["fx-search-R-01", "fx-research-R-01"];
    const r = await runEval({ ...base(out, home, ids, null), jobs: 2 }, { session, onInterrupt: () => () => {} });
    expect(r.account_stop).toBe("no_credit");
    expect(cancelled).toEqual(["r_1"]);
    expect(started).toHaveLength(2);
    expect(r.lines.map((l) => l.infra_kind)).toEqual(ids.map(() => "no_credit"));
    expect(JSON.parse(readFileSync(join(out, "eval.json"), "utf8"))).toMatchObject({ account_stop: "no_credit", finished: expect.any(String) });
  });

  test("a grader that throws stops that task only; the ledger, eval.json and the reports are still written", async () => {
    const home = join(t.dir, "home-throw");
    const out = join(t.dir, "out-throw");
    const r = await runEval(base(out, home, ["fx-python-S-01", "fx-search-R-01"], null), {
      session: costly(0, []),
      uv: "uv-fake",
      run: fakeRunner(home),
      gradeRepo: async () => {
        throw new Error("fatal: Unable to create '.git/index.lock'");
      },
      onInterrupt: () => () => {},
    });
    const py = r.lines.find((l) => l.id === "fx-python-S-01")!;
    expect(py).toMatchObject({ pass: false, infra_kind: null });
    expect(py.grade_error).toContain("index.lock");
    expect(r.lines.find((l) => l.id === "fx-search-R-01")).toMatchObject({ pass: true });
    expect(records(join(home, "eval", "ledger.jsonl"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(out, "eval.json"), "utf8")).finished).not.toBeNull();
    expect(existsSync(join(out, "report.md"))).toBe(true);
  });
});

function zero() {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };
}

// -- the whole fixture, where prepare-web.sh filled the store and the browsers --

const store = process.env.RLMH_TEST_PNPM_STORE;
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
const filled = (d: string | undefined) => d !== undefined && existsSync(d) && readdirSync(d).length > 0;

describe.skipIf(!filled(store) || !filled(browsers))("the whole fixture with the web task", () => {
  test(
    "--go on every task but the kernel one grades the web task too (unresolved) and exits 0",
    async () => {
      const home = join(t.dir, "home-all");
      const out = join(t.dir, "out-all");
      const io = captured(home);
      const saved = { script: process.env.RLMH_FAKE_SCRIPT, offline: process.env.UV_OFFLINE };
      process.env.RLMH_FAKE_SCRIPT = script;
      process.env.UV_OFFLINE = "1";
      let code: number;
      try {
        code = await evalCommand([set, "--gpu", "none", "--go", "--json", "--out", out, ...FAKE], io, { runEval: { storeDir: store!, browsersDir: browsers! } });
      } finally {
        if (saved.script === undefined) delete process.env.RLMH_FAKE_SCRIPT;
        else process.env.RLMH_FAKE_SCRIPT = saved.script;
        if (saved.offline === undefined) delete process.env.UV_OFFLINE;
        else process.env.UV_OFFLINE = saved.offline;
      }
      expect(code).toBe(0);
      const web = jsonLines(io.out()).find((l) => l.type === "eval.task" && l.id === "fx-web-S-01");
      expect(web).toMatchObject({ pass: false, infra_kind: null, grade_error: null, f2p_share: 0 });
    },
    LONG,
  );
});
