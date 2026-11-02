// KV cache: none
// The priced estimate `rlmh eval` prints before anything is spent (v1 architecture §6.6, D-193, D-198):
// reference tokens per run, by track/size from `--tokens-from` run logs or by size from REFERENCE, each
// capped at the profile's own ceiling (scripts/harness_smoke.py's `ceiling_tokens`, RLM dev_rishi), then
// priced from the catalog. It also lists what preparation would download.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog, ModelInfo } from "../gateway/catalog.ts";
import type { ModelRef, ProfileInfo, ProfileLimits } from "../protocol.ts";
import { stratum, type EvalSet, type EvalTask, type Size } from "./set.ts";
import { browserReady, builtVenv, nodeEnvFetched, type Backend } from "./work.ts";

/** Tokens for one run, by role. */
export interface Tokens {
  root_in: number;
  root_out: number;
  root_cache: number;
  sub_in: number;
  sub_out: number;
  sub_cache: number;
}

const M = 1_000_000;
const K = 1_000;

/** Architecture §6.6's table, from v0's recorded runs (D-152, D-157). Cache reads are left to the price rule. */
export const REFERENCE: Record<Size, Tokens> = {
  R: { root_in: 0.3 * M, root_out: 20 * K, root_cache: 0, sub_in: 0.3 * M, sub_out: 30 * K, sub_cache: 0 },
  S: { root_in: 0.3 * M, root_out: 20 * K, root_cache: 0, sub_in: 0.1 * M, sub_out: 10 * K, sub_cache: 0 },
  M: { root_in: 1.2 * M, root_out: 50 * K, root_cache: 0, sub_in: 0.3 * M, sub_out: 30 * K, sub_cache: 0 },
  L: { root_in: 6.0 * M, root_out: 120 * K, root_cache: 0, sub_in: 0.8 * M, sub_out: 60 * K, sub_cache: 0 },
};

/** harness_smoke.py's FIRST_MESSAGE_TOKENS and CHARS_PER_TOKEN. */
const FIRST_MESSAGE_TOKENS = 4000;
const CHARS_PER_TOKEN = 3;
/** Root input assumed read from cache when the model's price has a cache read (as v0 measured on DeepSeek). */
export const CACHE_SHARE = 0.8;

/**
 * One run with every limit used (harness_smoke.py's `ceiling_tokens`). The sub figures are null when the
 * profile has the agent API: a child run's root turns count as sub usage (D-160), so they have no ceiling here.
 */
export function ceilingFor(limits: Pick<ProfileLimits, "max_turns" | "max_subcalls" | "root_max_tokens" | "output_max_chars" | "subcall_max_chars" | "subcall_max_tokens">, agentApi: boolean) {
  const perTurn = limits.root_max_tokens + limits.output_max_chars / CHARS_PER_TOKEN;
  let rootIn = 0;
  for (let t = 1; t <= limits.max_turns; t++) rootIn += FIRST_MESSAGE_TOKENS + (t - 1) * perTurn;
  return {
    root_in: rootIn,
    root_out: limits.max_turns * limits.root_max_tokens,
    sub_in: agentApi ? null : (limits.max_subcalls * limits.subcall_max_chars) / CHARS_PER_TOKEN,
    sub_out: agentApi ? null : limits.max_subcalls * limits.subcall_max_tokens,
  };
}

interface RunRecord {
  tag?: unknown;
  usage?: { root?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number }; sub?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number } };
}

/** Mean tokens per run by track/size, from run logs whose `tag` is one of the set's task ids. */
export function referenceFrom(runLogs: string[], set: EvalSet): Map<string, Tokens> {
  const byId = new Map(set.tasks.map((t) => [t.id, t]));
  const sums = new Map<string, { n: number; t: Tokens }>();
  for (const file of runLogs) {
    for (const chunk of readFileSync(file, "utf8").split("\n")) {
      if (chunk.trim() === "") continue;
      let r: RunRecord;
      try {
        r = JSON.parse(chunk);
      } catch {
        continue; // a torn line
      }
      const task = typeof r.tag === "string" ? byId.get(r.tag) : undefined;
      if (task === undefined || r.usage === undefined) continue;
      const key = stratum(task);
      const s = sums.get(key) ?? { n: 0, t: { root_in: 0, root_out: 0, root_cache: 0, sub_in: 0, sub_out: 0, sub_cache: 0 } };
      s.n += 1;
      s.t.root_in += r.usage.root?.input_tokens ?? 0;
      s.t.root_out += r.usage.root?.output_tokens ?? 0;
      s.t.root_cache += r.usage.root?.cache_read_tokens ?? 0;
      s.t.sub_in += r.usage.sub?.input_tokens ?? 0;
      s.t.sub_out += r.usage.sub?.output_tokens ?? 0;
      s.t.sub_cache += r.usage.sub?.cache_read_tokens ?? 0;
      sums.set(key, s);
    }
  }
  const out = new Map<string, Tokens>();
  for (const [key, { n, t }] of sums) {
    out.set(key, {
      root_in: t.root_in / n,
      root_out: t.root_out / n,
      root_cache: t.root_cache / n,
      sub_in: t.sub_in / n,
      sub_out: t.sub_out / n,
      sub_cache: t.sub_cache / n,
    });
  }
  return out;
}

/** A model's price, or null when the catalog doesn't price it. The fake provider is priced at $0. */
export function priceOf(catalog: Pick<Catalog, "get">, ref: ModelRef): ModelInfo["price"] | null {
  if (ref.provider === "fake") return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const info = catalog.get(ref.provider, ref.model.split("@")[0]!);
  if (info === undefined || (info.price.input === 0 && info.price.output === 0)) return null;
  return info.price;
}

/** harness_smoke.py's `role_cost`; cache reads count only when the model has a cache-read price. */
function roleCost(tokensIn: number, tokensOut: number, cacheRead: number, price: ModelInfo["price"]): number {
  const reads = price.cache_read > 0 ? Math.min(cacheRead, tokensIn) : 0;
  return ((tokensIn - reads) * price.input + reads * price.cache_read + tokensOut * price.output) / 1e6;
}

export interface EstimateRow {
  stratum: string;
  runs: number;
  source: "runs" | "reference";
  tokens: Tokens;
  /** Per run; null when a model is unpriced. */
  run_usd: number | null;
  usd: number | null;
}

export interface Estimate {
  rows: EstimateRow[];
  runs: number;
  /** null when a model is unpriced. */
  total_usd: number | null;
  /** The default cap: twice the total; null when unpriced. */
  default_cap_usd: number | null;
  unpriced: string[];
  downloads: string[];
  notes: string[];
  warnings: string[];
}

export interface EstimateOpts {
  root: ModelRef;
  sub: ModelRef;
  catalog: Pick<Catalog, "get">;
  /** referenceFrom's means; empty means REFERENCE throughout. */
  refs: Map<string, Tokens>;
  profile: Pick<ProfileInfo, "name" | "agent_api" | "limits">;
  home: string;
  set: EvalSet;
  /** The --gpu choice, when given. */
  gpu?: Backend | "none";
  /** Kernel tasks `--gpu none` left out, for the note. */
  leftOut?: string[];
  storeDir?: string;
  browsersDir?: string;
}

/** Prices every planned run and lists the downloads. */
export function estimate(tasks: EvalTask[], o: EstimateOpts): Estimate {
  const rootPrice = priceOf(o.catalog, o.root);
  const subPrice = priceOf(o.catalog, o.sub);
  const unpriced = [...new Set([...(rootPrice === null ? [`${o.root.provider}/${o.root.model}`] : []), ...(subPrice === null ? [`${o.sub.provider}/${o.sub.model}`] : [])])];
  const groups = new Map<string, EvalTask[]>();
  for (const t of tasks) groups.set(stratum(t), [...(groups.get(stratum(t)) ?? []), t]);
  const rows: EstimateRow[] = [];
  for (const key of [...groups.keys()].sort()) {
    const first = groups.get(key)![0]!;
    const measured = o.refs.get(key);
    const base = measured ?? REFERENCE[first.size];
    const lim = first.kind === "read" ? o.profile.limits.read : o.profile.limits.repo;
    const ceil = ceilingFor(lim, o.profile.agent_api);
    const capped = (x: number, c: number | null) => (c === null ? x : Math.min(x, c));
    const rootIn = capped(base.root_in, ceil.root_in);
    const subIn = capped(base.sub_in, ceil.sub_in);
    const tokens: Tokens = {
      root_in: rootIn,
      root_out: capped(base.root_out, ceil.root_out),
      // measured cache reads scale with a capped input; the reference assumes CACHE_SHARE of root input
      root_cache: measured ? (base.root_in > 0 ? (base.root_cache * rootIn) / base.root_in : 0) : CACHE_SHARE * rootIn,
      sub_in: subIn,
      sub_out: capped(base.sub_out, ceil.sub_out),
      sub_cache: measured ? (base.sub_in > 0 ? (base.sub_cache * subIn) / base.sub_in : 0) : 0,
    };
    const runUsd =
      rootPrice === null || subPrice === null
        ? null
        : roleCost(tokens.root_in, tokens.root_out, tokens.root_cache, rootPrice) + roleCost(tokens.sub_in, tokens.sub_out, tokens.sub_cache, subPrice);
    const runs = groups.get(key)!.length;
    rows.push({ stratum: key, runs, source: measured ? "runs" : "reference", tokens, run_usd: runUsd, usd: runUsd === null ? null : runUsd * runs });
  }
  const total = unpriced.length > 0 ? null : rows.reduce((a, r) => a + (r.usd ?? 0), 0);

  const downloads: string[] = [];
  const venvKeys = [...new Set(tasks.flatMap((t) => (t.kind === "repo" && t.venv !== undefined ? [t.venv] : [])))].sort();
  for (const key of venvKeys) {
    if (builtVenv(o.set, key, o.home) !== null) continue;
    const spec = o.set.venvs.get(key)!;
    const kernel = tasks.some((t) => t.kind === "repo" && t.venv === key && t.track === "kernel");
    downloads.push(
      `venv ${key}: Python ${spec.python} and ${spec.requirements.length} packages from PyPI` +
        (kernel && spec.requirements.some((r) => r.startsWith("nvidia-cuda-nvrtc")) && process.platform !== "darwin"
          ? " (the nvidia-cuda-nvrtc-cu12 wheel is tens of MB; nothing for AMD, whose HIP SDK or ROCm must already be installed)"
          : ""),
    );
  }
  const nodeKeys = [...new Set(tasks.flatMap((t) => (t.kind === "repo" && t.node_env !== undefined ? [t.node_env] : [])))].sort();
  for (const key of nodeKeys) {
    if (!nodeEnvFetched(o.set, key, { home: o.home, ...(o.storeDir !== undefined ? { storeDir: o.storeDir } : {}) })) {
      downloads.push(`node env ${key}: its lockfile's packages from the npm registry, into the shared pnpm store`);
    }
  }
  const playwright = nodeKeys.length > 0 ? o.set.nodeEnvs.get(nodeKeys[0]!)!.playwright : null;
  if (playwright !== null && !browserReady(playwright, { home: o.home, ...(o.browsersDir !== undefined ? { browsersDir: o.browsersDir } : {}) })) {
    downloads.push(`Chromium for Playwright ${playwright}, from Playwright's download host`);
  }

  const notes: string[] = [];
  const warnings: string[] = [];
  if ((o.leftOut ?? []).length > 0) notes.push(`--gpu none leaves out ${o.leftOut!.length} kernel task(s): ${o.leftOut!.join(", ")}`);
  const kernels = tasks.filter((t) => t.track === "kernel");
  if (kernels.length > 0 && o.gpu !== undefined && o.gpu !== "none" && !o.set.manifest.kernel_validated_on.includes(o.gpu)) {
    warnings.push(`the set's kernel tasks were validated on ${o.set.manifest.kernel_validated_on.join(", ") || "no backend"}, not ${o.gpu}`);
  }
  return {
    rows,
    runs: tasks.length,
    total_usd: total,
    default_cap_usd: total === null ? null : 2 * total,
    unpriced,
    downloads,
    notes,
    warnings,
  };
}

const money = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(2)}`);
const mtok = (x: number) => `${(x / M).toFixed(2)}M`;

/** The estimate as `rlmh eval` prints it without `--go`. */
export function renderEstimate(e: Estimate, o: { permissionMode: string; profile: string; root: ModelRef; sub: ModelRef; cap: number | null }): string {
  const lines = [
    `plan: ${e.runs} runs, profile ${o.profile}, root ${o.root.provider}/${o.root.model}, sub ${o.sub.provider}/${o.sub.model}`,
    `repo tasks run with permission mode ${o.permissionMode}, in throwaway copies under <home>/eval/work/ (D-172)`,
    "",
    "| track/size | runs | tokens from | root in | root out | sub in | sub out | per run | total |",
    "|---|---|---|---|---|---|---|---|---|",
    ...e.rows.map(
      (r) =>
        `| ${r.stratum} | ${r.runs} | ${r.source} | ${mtok(r.tokens.root_in)} | ${mtok(r.tokens.root_out)} | ${mtok(r.tokens.sub_in)} | ${mtok(r.tokens.sub_out)} | ${money(r.run_usd)} | ${money(r.usd)} |`,
    ),
    "",
    `estimate: ${money(e.total_usd)}`,
    `cap: ${o.cap === null ? "none yet (an unpriced model needs --max-usd before --go)" : `$${o.cap.toFixed(2)}`}`,
    ...(e.unpriced.length > 0 ? [`unpriced: ${e.unpriced.join(", ")} (the catalog has no price; --go needs an explicit --max-usd)`] : []),
    "",
    e.downloads.length === 0 ? "downloads: none (every environment is ready)" : "downloads before the first run:",
    ...e.downloads.map((d) => `  ${d}`),
    ...e.notes.map((n) => `note: ${n}`),
    ...e.warnings.map((w) => `warning: ${w}`),
    "",
    "Nothing was run and nothing was spent. Add --go to run.",
  ];
  return `${lines.join("\n")}\n`;
}

/** `<home>/eval/out/<eval id>` (D-192). */
export const defaultOut = (home: string, evalId: string): string => join(home, "eval", "out", evalId);
