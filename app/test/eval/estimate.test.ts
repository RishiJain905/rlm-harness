// KV cache: none
// estimate.ts: REFERENCE pricing for the two S-43 models from the bundled catalog, --tokens-from means by
// stratum, unpriced models, the profile ceiling (D-198), and the downloads list.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../../src/gateway/catalog.ts";
import { ceilingFor, estimate, REFERENCE, referenceFrom, type EstimateOpts } from "../../src/eval/estimate.ts";
import { loadSet, selectTasks, type EvalSet } from "../../src/eval/set.ts";
import { nodeLock } from "../../src/eval/work.ts";
import type { ProfileInfo, ProfileLimits } from "../../src/protocol.ts";
import { buildFixtureSet } from "./fixture.ts";

let tmp: string;
let set: EvalSet;
let catalog: Catalog;

const limits = (max_turns: number, root_max_tokens: number): ProfileLimits => ({
  max_turns,
  max_subcalls: 80,
  root_max_tokens,
  output_max_chars: 8000,
  cell_timeout_s: 300,
  cpus: 2,
  memory_mb: 4096,
  pids: 256,
  grader_timeout_s: 600,
  subcall_max_chars: 60000,
  subcall_max_tokens: root_max_tokens,
  subcall_thinking: "low",
  subcall_oversize: "error",
});
const DEFAULT: Pick<ProfileInfo, "name" | "agent_api" | "limits"> = { name: "default", agent_api: true, limits: { read: limits(50, 16384), repo: limits(150, 16384) } };
const TRAINING: Pick<ProfileInfo, "name" | "agent_api" | "limits"> = { name: "training-v4", agent_api: false, limits: { read: limits(20, 4096), repo: limits(30, 4096) } };
const DEEPSEEK = { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017", thinking: null };
const HAIKU = { provider: "openrouter", model: "anthropic/claude-haiku-5.5", thinking: null };

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rlmh-estimate-"));
  set = loadSet(buildFixtureSet(tmp));
  catalog = new Catalog(join(tmp, "home"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const opts = (over: Partial<EstimateOpts> = {}): EstimateOpts => ({ root: DEEPSEEK, sub: DEEPSEEK, catalog, refs: new Map(), profile: DEFAULT, home: join(tmp, "home"), set, ...over });
/** role_cost by hand: uncached input, cache reads and output, per 1M tokens. */
const cost = (inp: number, out: number, reads: number, p: { input: number; output: number; cache_read: number }) => ((inp - reads) * p.input + reads * p.cache_read + out * p.output) / 1e6;

describe("estimate", () => {
  test("REFERENCE pricing for the two S-43 models", () => {
    const tasks = selectTasks(set, { only: ["fx-python-S-01", "fx-search-R-01"] });
    for (const model of [DEEPSEEK, HAIKU]) {
      const p = catalog.get(model.provider, model.model)!.price;
      const e = estimate(tasks, opts({ root: model, sub: model }));
      const s = REFERENCE.S;
      const r = REFERENCE.R;
      const want = cost(s.root_in, s.root_out, 0.8 * s.root_in, p) + cost(s.sub_in, s.sub_out, 0, p) + cost(r.root_in, r.root_out, 0.8 * r.root_in, p) + cost(r.sub_in, r.sub_out, 0, p);
      expect(e.total_usd!).toBeCloseTo(want, 10);
      expect(e.default_cap_usd!).toBeCloseTo(2 * want, 10);
      expect(e.rows.map((x) => [x.stratum, x.source])).toEqual([["python/S", "reference"], ["search/R", "reference"]]);
    }
  });

  test("--tokens-from means replace the reference by stratum; a stratum without records falls back by size", () => {
    const log = join(tmp, "runs.jsonl");
    const usage = (i: number) => ({ root: { input_tokens: i, output_tokens: 100, cache_read_tokens: 0 }, sub: { input_tokens: 10, output_tokens: 1, cache_read_tokens: 0 } });
    writeFileSync(
      log,
      [{ tag: "fx-python-S-01", usage: usage(1000) }, { tag: "fx-python-S-02", usage: usage(3000) }, { tag: "not-in-the-set", usage: usage(9) }].map((r) => JSON.stringify(r)).join("\n") + "\n{torn",
    );
    const refs = referenceFrom([log], set);
    expect([...refs.keys()]).toEqual(["python/S"]);
    expect(refs.get("python/S")!.root_in).toBe(2000);
    const e = estimate(selectTasks(set, { only: ["fx-python-S-01", "fx-kernel-S-01"] }), opts({ refs }));
    expect(e.rows.map((x) => [x.stratum, x.source, x.tokens.root_in])).toEqual([
      ["kernel/S", "reference", REFERENCE.S.root_in],
      ["python/S", "runs", 2000],
    ]);
  });

  test("an unpriced model is named, and leaves no total and no default cap", () => {
    const e = estimate(selectTasks(set, { only: ["fx-search-R-01"] }), opts({ sub: { provider: "openrouter", model: "nobody/unknown-model", thinking: null } }));
    expect(e.unpriced).toEqual(["openrouter/nobody/unknown-model"]);
    expect(e.total_usd).toBeNull();
    expect(e.default_cap_usd).toBeNull();
    const fake = estimate(selectTasks(set, { only: ["fx-search-R-01"] }), opts({ root: { provider: "fake", model: "scripted", thinking: null }, sub: { provider: "fake", model: "scripted", thinking: null } }));
    expect(fake.total_usd).toBe(0);
    expect(fake.unpriced).toEqual([]);
  });
});

describe("ceilingFor", () => {
  test("training-v4's repo limits: a hand calculation, which caps an L reference figure", () => {
    const c = ceilingFor(TRAINING.limits.repo, false);
    const perTurn = 4096 + 8000 / 3;
    expect(c.root_in).toBeCloseTo(30 * 4000 + perTurn * ((29 * 30) / 2), 6);
    expect(c.root_out).toBe(30 * 4096);
    expect(c.sub_in).toBe((80 * 60000) / 3);
    expect(c.sub_out).toBe(80 * 4096);
    expect(REFERENCE.L.root_in).toBeGreaterThan(c.root_in);
    const lTask = { ...set.tasks.find((t) => t.id === "fx-python-S-01")!, size: "L" as const };
    const e = estimate([lTask], opts({ profile: TRAINING }));
    expect(e.rows[0]!.tokens.root_in).toBeCloseTo(c.root_in, 6);
    expect(e.rows[0]!.tokens.root_out).toBe(REFERENCE.L.root_out); // under its ceiling
  });

  test("with agent_api on, the sub figures are not capped", () => {
    const tiny = { ...limits(150, 16384), max_subcalls: 1, subcall_max_chars: 300, subcall_max_tokens: 10 };
    expect(ceilingFor(tiny, true)).toMatchObject({ sub_in: null, sub_out: null });
    const task = set.tasks.find((t) => t.id === "fx-python-S-01")!;
    const on = estimate([task], opts({ profile: { name: "x", agent_api: true, limits: { read: tiny, repo: tiny } } }));
    const off = estimate([task], opts({ profile: { name: "x", agent_api: false, limits: { read: tiny, repo: tiny } } }));
    expect(on.rows[0]!.tokens.sub_in).toBe(REFERENCE.S.sub_in);
    expect(off.rows[0]!.tokens.sub_in).toBe(100);
  });
});

describe("downloads", () => {
  test("a missing venv, an unfetched lockfile, a missing browser and the kernel venv's NVRTC wheel; nothing once all exist", () => {
    const home = join(tmp, "home-dl");
    const store = join(tmp, "store");
    const browsers = join(tmp, "browsers");
    const tasks = selectTasks(set, { only: ["fx-python-S-01", "fx-kernel-S-01", "fx-web-S-01"] });
    const o = opts({ home, storeDir: store, browsersDir: browsers });
    const before = estimate(tasks, o).downloads.join("\n");
    expect(before).toContain("venv fx:");
    expect(before).toContain("node env fx-web");
    expect(before).toContain("Chromium for Playwright 1.57.0");
    if (process.platform !== "darwin") expect(before).toContain("nvidia-cuda-nvrtc-cu12 wheel");
    for (const key of ["fx", "fx-kernel"]) {
      mkdirSync(join(home, "eval", "venvs", key), { recursive: true });
      writeFileSync(join(home, "eval", "venvs", key, ".rlmh-venv.json"), JSON.stringify({ sha256: require("node:crypto").createHash("sha256").update(set.venvBytes.get(key)!).digest("hex"), purelib: "x" }));
    }
    mkdirSync(join(store, ".rlmh-fetched"), { recursive: true });
    writeFileSync(join(store, ".rlmh-fetched", nodeLock(set, "fx-web").sha), "");
    mkdirSync(browsers, { recursive: true });
    writeFileSync(join(browsers, ".rlmh-1.57.0"), "");
    expect(estimate(tasks, o).downloads).toEqual([]);
  });

  test("it warns when the chosen backend didn't validate the kernels, and notes what --gpu none leaves out", () => {
    const kernel = selectTasks(set, { only: ["fx-kernel-S-01"] });
    expect(estimate(kernel, opts({ gpu: "cuda" })).warnings[0]).toContain("validated on hip, not cuda");
    expect(estimate(kernel, opts({ gpu: "hip" })).warnings).toEqual([]);
    expect(estimate([], opts({ gpu: "none", leftOut: ["fx-kernel-S-01"] })).notes[0]).toContain("--gpu none leaves out 1 kernel task(s): fx-kernel-S-01");
  });
});
