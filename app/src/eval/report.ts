// KV cache: none
// Reports and comparisons over an eval output folder (v1 architecture §6.5, D-170, D-197, D-225):
// grades are read only through readGrades, so a rerun line always stands in for its original.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Size, Split, Track } from "./set.ts";

/** One line of `<out>/grades.jsonl` (architecture §6.5's keys, plus what the report totals). */
export interface GradeLine {
  id: string;
  track: Track;
  kind: "read" | "repo";
  size: Size;
  split: Split;
  run_id: string | null;
  submitted: boolean;
  infra_kind: string | null;
  pass: boolean;
  score: number;
  /** Repo tasks only; null for read tasks and for runs that weren't graded. */
  f2p_share: number | null;
  test_tamper: boolean;
  leak_suspect: boolean;
  turns: number;
  subcalls: number;
  compactions: number;
  cost_usd: number;
  /** Cache reads over input, root and sub together; null with no input. */
  cache_hit: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  wall_s: number;
  /** Why grading failed (a report that didn't parse, a timeout), or null. */
  grade_error: string | null;
  /** The env log of a host_bug, or null. */
  env_log: string | null;
}

/** The lines of one `grades.jsonl`; torn lines are skipped. */
function gradeFile(path: string): GradeLine[] {
  if (!existsSync(path)) return [];
  const out: GradeLine[] = [];
  for (const chunk of readFileSync(path, "utf8").split("\n")) {
    if (chunk.trim() === "") continue;
    try {
      const v = JSON.parse(chunk);
      if (typeof v === "object" && v !== null && typeof v.id === "string") out.push(v as GradeLine);
    } catch {
      // torn
    }
  }
  return out;
}

/** `<out>/grades.jsonl`, with each `<out>/rerun/grades.jsonl` line in place of the original of the same id (D-197). */
export function readGrades(out: string): GradeLine[] {
  const lines = gradeFile(join(out, "grades.jsonl"));
  const rerun = new Map(gradeFile(join(out, "rerun", "grades.jsonl")).map((l) => [l.id, l]));
  return lines.map((l) => rerun.get(l.id) ?? l);
}

export interface Row {
  n: number;
  passed: number;
  pass_rate: number;
  mean_score: number;
  mean_f2p_share: number | null;
  mean_turns: number;
  mean_subcalls: number;
  mean_compactions: number;
  cost_usd: number;
  mean_cost_usd: number;
  cache_hit: number | null;
  mean_wall_s: number;
  infra: number;
  test_tamper: number;
  leak_suspect: number;
}

export interface Report {
  total: Row;
  split: Record<string, Row>;
  track: Record<string, Row>;
  kind: Record<string, Row>;
  size: Record<string, Row>;
}

const round = (x: number, places = 6) => Math.round(x * 10 ** places) / 10 ** places;
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function row(lines: GradeLine[]): Row {
  const f2p = lines.filter((l) => l.kind === "repo").map((l) => l.f2p_share ?? 0);
  const input = lines.reduce((a, l) => a + (l.input_tokens ?? 0), 0);
  const reads = lines.reduce((a, l) => a + (l.cache_read_tokens ?? 0), 0);
  const cost = lines.reduce((a, l) => a + l.cost_usd, 0);
  const passed = lines.filter((l) => l.pass && l.infra_kind === null).length;
  return {
    n: lines.length,
    passed,
    pass_rate: lines.length === 0 ? 0 : round(passed / lines.length),
    mean_score: round(mean(lines.map((l) => (l.infra_kind === null ? l.score : 0)))),
    mean_f2p_share: f2p.length === 0 ? null : round(mean(f2p)),
    mean_turns: round(mean(lines.map((l) => l.turns))),
    mean_subcalls: round(mean(lines.map((l) => l.subcalls))),
    mean_compactions: round(mean(lines.map((l) => l.compactions ?? 0))),
    cost_usd: round(cost),
    mean_cost_usd: round(lines.length === 0 ? 0 : cost / lines.length),
    cache_hit: input > 0 ? round(reads / input) : null,
    mean_wall_s: round(mean(lines.map((l) => l.wall_s)), 3),
    infra: lines.filter((l) => l.infra_kind !== null).length,
    test_tamper: lines.filter((l) => l.test_tamper).length,
    leak_suspect: lines.filter((l) => l.leak_suspect).length,
  };
}

function by(lines: GradeLine[], key: "split" | "track" | "kind" | "size"): Record<string, Row> {
  const groups = new Map<string, GradeLine[]>();
  for (const l of lines) groups.set(String(l[key]), [...(groups.get(String(l[key])) ?? []), l]);
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, row(groups.get(k)!)]));
}

/** Totals by split, track, kind and size, plus a total row. Infra runs count as not passed. */
export function buildReport(lines: GradeLine[]): Report {
  return { total: row(lines), split: by(lines, "split"), track: by(lines, "track"), kind: by(lines, "kind"), size: by(lines, "size") };
}

/** D-170, under every comparison and report. */
export const REPLICATE_NOTE = "One replicate per task, so a held-out difference of a few tasks is within noise (D-170).";

const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, d = 2) => (x === null ? "-" : x.toFixed(d));

function table(title: string, rows: [string, Row][]): string {
  const head = "| | n | passed | pass rate | mean score | mean f2p share | turns | sub-calls | compactions | cost | cost/run | cache hit | wall s | infra | tamper | leak? |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map(
    ([name, r]) =>
      `| ${name} | ${r.n} | ${r.passed} | ${pct(r.pass_rate)} | ${num(r.mean_score, 3)} | ${num(r.mean_f2p_share, 3)} | ${num(r.mean_turns, 1)} | ${num(r.mean_subcalls, 1)} | ` +
      `${num(r.mean_compactions, 1)} | $${r.cost_usd.toFixed(4)} | $${r.mean_cost_usd.toFixed(4)} | ${pct(r.cache_hit)} | ${num(r.mean_wall_s, 1)} | ${r.infra} | ${r.test_tamper} | ${r.leak_suspect} |`,
  );
  return [`## ${title}`, "", head, sep, ...body, ""].join("\n");
}

/** report.md: one table per grouping, totals first. */
export function renderReport(report: Report, title = "Eval report"): string {
  return [
    `# ${title}`,
    "",
    table("Total", [["total", report.total]]),
    table("By split", Object.entries(report.split)),
    table("By track", Object.entries(report.track)),
    table("By kind", Object.entries(report.kind)),
    table("By size", Object.entries(report.size)),
    REPLICATE_NOTE,
    "",
  ].join("\n");
}

/** Two-sided exact McNemar: min(1, 2 · Σ_{k=0}^{min(b,c)} C(b+c, k) / 2^(b+c)), and 1 when b + c = 0. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let term = 1; // C(n, 0)
  let sum = 0;
  for (let k = 0; k <= Math.min(b, c); k++) {
    sum += term;
    term = (term * (n - k)) / (k + 1);
  }
  return Math.min(1, (2 * sum) / 2 ** n);
}

/** One output to compare: its grades (through readGrades) and its eval.json's gpu_backend. */
export interface Output {
  grades: GradeLine[];
  gpu_backend: string | null;
}

export function readOutput(out: string): Output {
  let gpu: string | null = null;
  try {
    gpu = JSON.parse(readFileSync(join(out, "eval.json"), "utf8")).gpu_backend ?? null;
  } catch {
    // no eval.json: a hand-made folder
  }
  return { grades: readGrades(out), gpu_backend: gpu };
}

export interface Comparison {
  paired: number;
  only_in_a: number;
  only_in_b: number;
  both: number;
  a_only: number;
  b_only: number;
  neither: number;
  p_value: number;
  /** B's pass rate minus A's, over the paired ids. */
  pass_rate_diff: number;
  /** B's mean f2p_share minus A's, over the paired repo ids; null with none. */
  f2p_share_diff: number | null;
  /** B's mean cost over A's, over the paired ids; null when A cost nothing. */
  cost_ratio: number | null;
  tracks: Record<string, { n: number; a: number; b: number }>;
  warnings: string[];
}

const passed = (l: GradeLine) => l.pass && l.infra_kind === null;

/** Pairs the ids present in both outputs. */
export function compare(a: Output, b: Output): Comparison {
  const bById = new Map(b.grades.map((l) => [l.id, l]));
  const aIds = new Set(a.grades.map((l) => l.id));
  const pairs = a.grades.filter((l) => bById.has(l.id)).map((l) => [l, bById.get(l.id)!] as const);
  const count = (fa: boolean, fb: boolean) => pairs.filter(([x, y]) => passed(x) === fa && passed(y) === fb).length;
  const repo = pairs.filter(([x]) => x.kind === "repo");
  const costA = mean(pairs.map(([x]) => x.cost_usd));
  const costB = mean(pairs.map(([, y]) => y.cost_usd));
  const tracks: Comparison["tracks"] = {};
  for (const [x, y] of pairs) {
    const t = (tracks[x.track] ??= { n: 0, a: 0, b: 0 });
    t.n += 1;
    t.a += passed(x) ? 1 : 0;
    t.b += passed(y) ? 1 : 0;
  }
  const aOnly = count(true, false);
  const bOnly = count(false, true);
  const warnings: string[] = [];
  if ((a.gpu_backend ?? null) !== (b.gpu_backend ?? null)) {
    warnings.push(`the outputs ran kernels on different GPU backends (${a.gpu_backend ?? "none"} and ${b.gpu_backend ?? "none"}), so their kernel rows ran on different hardware`);
  }
  return {
    paired: pairs.length,
    only_in_a: a.grades.filter((l) => !bById.has(l.id)).length,
    only_in_b: b.grades.filter((l) => !aIds.has(l.id)).length,
    both: count(true, true),
    a_only: aOnly,
    b_only: bOnly,
    neither: count(false, false),
    p_value: round(mcnemarExact(aOnly, bOnly)),
    pass_rate_diff: pairs.length === 0 ? 0 : round((count(true, true) + bOnly - (count(true, true) + aOnly)) / pairs.length),
    f2p_share_diff: repo.length === 0 ? null : round(mean(repo.map(([, y]) => y.f2p_share ?? 0)) - mean(repo.map(([x]) => x.f2p_share ?? 0))),
    cost_ratio: costA > 0 ? round(costB / costA, 4) : null,
    tracks: Object.fromEntries(Object.keys(tracks).sort().map((k) => [k, tracks[k]!])),
    warnings,
  };
}

/** What `rlmh eval compare` prints; it always ends with the D-170 line. */
export function renderCompare(c: Comparison, names: { a: string; b: string } = { a: "A", b: "B" }): string {
  const lines = [
    `paired tasks: ${c.paired} (only in ${names.a}: ${c.only_in_a}, only in ${names.b}: ${c.only_in_b})`,
    `both pass: ${c.both}  ${names.a} only: ${c.a_only}  ${names.b} only: ${c.b_only}  neither: ${c.neither}`,
    `McNemar exact p: ${c.p_value.toFixed(4)}`,
    `pass rate difference (${names.b} - ${names.a}): ${(c.pass_rate_diff * 100).toFixed(1)} points`,
    `mean f2p_share difference: ${c.f2p_share_diff === null ? "-" : c.f2p_share_diff.toFixed(3)}`,
    `cost ratio (${names.b} / ${names.a}): ${c.cost_ratio === null ? "-" : c.cost_ratio.toFixed(2)}`,
    "passes per track:",
    ...Object.entries(c.tracks).map(([t, x]) => `  ${t}: ${names.a} ${x.a}/${x.n}, ${names.b} ${x.b}/${x.n}`),
    ...c.warnings.map((w) => `warning: ${w}`),
    REPLICATE_NOTE,
  ];
  return `${lines.join("\n")}\n`;
}
