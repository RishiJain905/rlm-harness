// KV cache: none
// report.ts: McNemar, the totals, compare (with its per-track counts, the D-170 line and the GPU warning),
// the rendered report, and readGrades putting rerun lines in place of the originals.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, compare, mcnemarExact, readGrades, renderCompare, renderReport, REPLICATE_NOTE, type GradeLine } from "../../src/eval/report.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rlmh-report-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function line(id: string, over: Partial<GradeLine> = {}): GradeLine {
  const [, track, size] = /^fx-([a-z]+)-([RSML])-/.exec(id)!;
  const kind = track === "research" || track === "search" ? "read" : "repo";
  return {
    id,
    track: track as GradeLine["track"],
    kind,
    size: size as GradeLine["size"],
    split: "tune",
    run_id: `r-${id}`,
    submitted: true,
    infra_kind: null,
    pass: false,
    score: 0,
    f2p_share: kind === "repo" ? 0 : null,
    test_tamper: false,
    leak_suspect: false,
    turns: 4,
    subcalls: 2,
    compactions: 0,
    cost_usd: 0.01,
    cache_hit: 0.5,
    input_tokens: 1000,
    cache_read_tokens: 500,
    wall_s: 10,
    grade_error: null,
    env_log: null,
    ...over,
  };
}

const writeGrades = (dir: string, lines: GradeLine[], gpu: string | null = null) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "grades.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  writeFileSync(join(dir, "eval.json"), JSON.stringify({ gpu_backend: gpu }));
};

test("mcnemarExact", () => {
  expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625, 10);
  expect(mcnemarExact(1, 6)).toBeCloseTo(0.125, 10);
  expect(mcnemarExact(3, 3)).toBe(1);
  expect(mcnemarExact(0, 0)).toBe(1);
  expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10);
});

const LINES: GradeLine[] = [
  line("fx-search-R-01", { pass: true, score: 1 }),
  line("fx-research-R-01", { split: "heldout", score: 0.4 }),
  line("fx-python-S-01", { pass: true, score: 1, f2p_share: 1, test_tamper: true }),
  line("fx-python-S-02", { split: "heldout", f2p_share: 0.5, leak_suspect: true }),
  line("fx-web-S-01", { split: "heldout", infra_kind: "server", pass: true, cost_usd: 0.03, input_tokens: 0, cache_read_tokens: 0 }),
];

describe("buildReport", () => {
  test("totals, with a row per track; infra runs count as not passed", () => {
    const r = buildReport(LINES);
    expect(r.total).toMatchObject({ n: 5, passed: 2, pass_rate: 0.4, infra: 1, test_tamper: 1, leak_suspect: 1, cost_usd: 0.07, mean_cost_usd: 0.014 });
    expect(r.total.mean_score).toBeCloseTo((1 + 0.4 + 1 + 0) / 5, 6);
    expect(r.total.mean_f2p_share).toBeCloseTo((1 + 0.5 + 0) / 3, 6);
    expect(r.total.cache_hit).toBe(0.5);
    expect(Object.keys(r.track)).toEqual(["python", "research", "search", "web"]);
    expect(r.track.python).toMatchObject({ n: 2, passed: 1 });
    expect(r.split).toMatchObject({ tune: { n: 2, passed: 2 }, heldout: { n: 3, passed: 0 } });
    expect(r.kind.read!.mean_f2p_share).toBeNull();
    expect(Object.keys(r.size)).toEqual(["R", "S"]);
  });

  test("renderReport is stable", () => {
    expect(renderReport(buildReport(LINES))).toMatchSnapshot();
    expect(renderReport(buildReport(LINES))).toContain(REPLICATE_NOTE);
  });
});

describe("compare", () => {
  test("pair counts, per-track counts, the D-170 line and the GPU warning", () => {
    const a = [line("fx-search-R-01", { pass: true }), line("fx-python-S-01"), line("fx-python-S-02", { pass: true, f2p_share: 1 }), line("fx-web-S-01")];
    const b = [
      line("fx-search-R-01", { pass: true, cost_usd: 0.02 }),
      line("fx-python-S-01", { pass: true, f2p_share: 1, cost_usd: 0.02 }),
      line("fx-python-S-02", { f2p_share: 0.5, cost_usd: 0.02 }),
      line("fx-research-R-01", { pass: true }),
    ];
    const c = compare({ grades: a, gpu_backend: "hip" }, { grades: b, gpu_backend: "cuda" });
    expect(c).toMatchObject({ paired: 3, only_in_a: 1, only_in_b: 1, both: 1, a_only: 1, b_only: 1, neither: 0, p_value: 1, pass_rate_diff: 0 });
    expect(c.f2p_share_diff).toBeCloseTo(0.25, 6);
    expect(c.cost_ratio).toBe(2);
    expect(c.tracks).toEqual({ python: { n: 2, a: 1, b: 1 }, search: { n: 1, a: 1, b: 1 } });
    expect(c.warnings[0]).toContain("different GPU backends (hip and cuda)");
    const text = renderCompare(c);
    expect(text).toContain("paired tasks: 3 (only in A: 1, only in B: 1)");
    expect(text.trimEnd().endsWith(REPLICATE_NOTE)).toBe(true);
    expect(compare({ grades: a, gpu_backend: "hip" }, { grades: b, gpu_backend: "hip" }).warnings).toEqual([]);
  });
});

test("readGrades puts a rerun line in place of the original", () => {
  const out = join(tmp, "out");
  writeGrades(out, [line("fx-search-R-01"), line("fx-python-S-01", { infra_kind: "server" })]);
  writeGrades(join(out, "rerun"), [line("fx-python-S-01", { pass: true, run_id: "r-again" })]);
  const lines = readGrades(out);
  expect(lines.map((l) => [l.id, l.run_id, l.pass, l.infra_kind])).toEqual([
    ["fx-search-R-01", "r-fx-search-R-01", false, null],
    ["fx-python-S-01", "r-again", true, null],
  ]);
});
