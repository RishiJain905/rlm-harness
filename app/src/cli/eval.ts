// KV cache: none
// `rlmh eval` (v1 architecture §6.5, D-192, D-193, D-197): an eval set run through rlmh and graded.
// Without --go it prints a priced estimate and spends nothing; with --go it runs runEval and writes the
// output folder. `report`, `compare` and `ledger` read output folders and start no engine.
// Exit 0 (no infra error, cap not hit), 1 (otherwise), 2 (usage), 130 (Ctrl-C).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stripKeys } from "../engine.ts";
import { Catalog } from "../gateway/catalog.ts";
import { LEDGER_CAP_USD, readLedger } from "../eval/ledger.ts";
import { compare, readOutput, renderCompare, type GradeLine } from "../eval/report.ts";
import { defaultOut, estimate, referenceFrom, renderEstimate, type Estimate } from "../eval/estimate.ts";
import { evalId, GpuMissing, runEval, writeReports, type EvalDeps, type EvalSession } from "../eval/runner.ts";
import { loadSet, needsGpu, SetError, selectTasks, type EvalSet, type EvalTask } from "../eval/set.ts";
import { findNodeTools, nodeToolsProblem, ProbeError, type Backend } from "../eval/work.ts";
import type { EngineInfo, ModelRef, ProfileInfo } from "../protocol.ts";
import { buildRunParams, Session, UsageError } from "../session.ts";
import { loadSettings, type Settings } from "../settings.ts";
import { attachJson, attachPlain, jsonLine } from "./print.ts";
import { message, modelFlags, openFailed, type CliIO } from "./run.ts";


const EVAL_OPTIONS = {
  split: { type: "string" },
  only: { type: "string" },
  sample: { type: "string" },
  seed: { type: "string" },
  root: { type: "string" },
  sub: { type: "string" },
  profile: { type: "string" },
  "call-format": { type: "string" },
  jobs: { type: "string" },
  out: { type: "string" },
  "tokens-from": { type: "string", multiple: true },
  gpu: { type: "string" },
  go: { type: "boolean" },
  "max-usd": { type: "string" },
  keep: { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  rerun: { type: "string" },
} as const;

export const EVAL_USAGE = `Usage: rlmh eval SET [--split tune|heldout|all] [--only ID,...] [--sample K --seed S] [--root P/M] [--sub P/M]
                 [--profile NAME] [--call-format F] [--jobs N] [--out DIR] [--tokens-from RUNS.jsonl]...
                 [--gpu cuda|hip|none] [--go] [--max-usd X] [--keep] [--json] [--verbose]
       rlmh eval SET --rerun OUT [--jobs N] [--go] [--max-usd X] [--keep] [--json]
       rlmh eval report OUT
       rlmh eval compare OUT_A OUT_B
       rlmh eval ledger
`;

/** D-197: the infra kinds a rerun retries; every other kind is a setup error or the run's own limit. */
export const TRANSIENT = ["rate_limit", "server", "timeout", "network", "worker", "runlog", "other"];

function usage(io: CliIO, text: string): number {
  io.stderr.write(`rlmh eval: ${text}\n${EVAL_USAGE}`);
  return 2;
}

const parseEval = (argv: string[]) => parseArgs({ args: argv, options: EVAL_OPTIONS, strict: true, allowPositionals: true });
type EvalValues = ReturnType<typeof parseEval>["values"];

function emptyOrMissing(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    return !existsSync(dir);
  }
}

interface Prepared {
  values: EvalValues;
  set: EvalSet;
  tasks: EvalTask[];
  split: "tune" | "heldout" | "all";
  root: ModelRef;
  sub: ModelRef;
  profile: string;
  callFormat: string;
  jobs: number;
  out: string;
  id: string;
  gpu: Backend | "none" | undefined;
  leftOut: string[];
  maxUsd: number | undefined;
  /** --rerun: the original output folder and its eval.json. */
  rerun?: { of: string; meta: Record<string, unknown> };
  settings: Settings;
}

/** Everything `rlmh eval SET` can check before an engine exists. Writes only errors. */
async function prepareEval(argv: string[], io: CliIO): Promise<Prepared | number> {
  let parsed;
  try {
    parsed = parseEval(argv);
  } catch (err) {
    return usage(io, message(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return usage(io, positionals.length === 0 ? "name an eval set folder" : "give exactly one eval set folder");
  const jobsText = values.jobs ?? "4";
  if (!/^\d+$/.test(jobsText) || Number(jobsText) < 1) return usage(io, `--jobs must be a whole number, 1 or more (got ${JSON.stringify(jobsText)})`);
  let maxUsd: number | undefined;
  if (values["max-usd"] !== undefined) {
    maxUsd = Number(values["max-usd"]);
    if (!Number.isFinite(maxUsd) || maxUsd < 0) return usage(io, `--max-usd must be a number, 0 or more (got ${JSON.stringify(values["max-usd"])})`);
  }
  const gpu = values.gpu;
  if (gpu !== undefined && !["cuda", "hip", "none"].includes(gpu)) return usage(io, `--gpu must be cuda, hip or none (got ${JSON.stringify(gpu)})`);
  let set: EvalSet;
  try {
    set = loadSet(positionals[0]!);
  } catch (err) {
    if (err instanceof SetError) {
      io.stderr.write(`rlmh eval: ${err.message}\n`);
      return 2;
    }
    return usage(io, message(err));
  }
  let settings: Settings;
  try {
    settings = loadSettings(io.home);
  } catch (err) {
    io.stderr.write(`rlmh: ${message(err)}\n`);
    return 1;
  }

  // --rerun takes everything that defines the eval from the first one's eval.json
  let rerun: Prepared["rerun"];
  let split = (values.split ?? "all") as Prepared["split"];
  let tasks: EvalTask[];
  let root: ModelRef | undefined;
  let sub: ModelRef | undefined;
  let profile = values.profile ?? settings.profile;
  let callFormat = values["call-format"] ?? settings.call_format;
  let gpuChoice = gpu as Backend | "none" | undefined;
  const leftOut: string[] = [];
  if (values.rerun !== undefined) {
    for (const flag of ["split", "only", "sample", "seed", "root", "sub", "profile", "call-format", "out", "gpu", "tokens-from"] as const) {
      if (values[flag] !== undefined) return usage(io, `--rerun takes --${flag} from the first eval; leave it out`);
    }
    const of = resolve(values.rerun);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(readFileSync(join(of, "eval.json"), "utf8"));
    } catch {
      return usage(io, `${of} has no readable eval.json`);
    }
    if (!emptyOrMissing(join(of, "rerun"))) return usage(io, `${join(of, "rerun")} is not empty: an output is rerun once`);
    if (meta.tasks_sha256 !== set.manifest.tasks_sha256 || meta.grades_sha256 !== set.manifest.grades_sha256) {
      return usage(io, `the set's hashes differ from ${join(of, "eval.json")}'s: this is not the set that eval ran`);
    }
    const transient = new Set<string>();
    for (const chunk of readFileSync(join(of, "grades.jsonl"), "utf8").split("\n")) {
      try {
        const l = JSON.parse(chunk) as GradeLine;
        if (l.infra_kind !== null && TRANSIENT.includes(l.infra_kind)) transient.add(l.id);
      } catch {
        // blank or torn
      }
    }
    tasks = set.tasks.filter((t) => transient.has(t.id));
    if (tasks.length === 0) return usage(io, `no task in ${of} ended with a transient infra error (${TRANSIENT.join(", ")})`);
    split = (meta.split as Prepared["split"]) ?? "all";
    root = meta.root as ModelRef;
    sub = (meta.sub as ModelRef | null) ?? undefined;
    profile = String(meta.profile);
    callFormat = (meta.call_format as string | null) ?? callFormat;
    gpuChoice = (meta.gpu_backend as Backend | null) ?? (tasks.some(needsGpu) ? undefined : "none");
    rerun = { of, meta };
  } else {
    if (!["tune", "heldout", "all"].includes(split)) return usage(io, `--split must be tune, heldout or all (got ${JSON.stringify(split)})`);
    let sample: number | undefined;
    if (values.sample !== undefined) {
      if (!/^\d+$/.test(values.sample) || Number(values.sample) < 1) return usage(io, `--sample must be a whole number, 1 or more`);
      if (values.seed === undefined) return usage(io, "--sample needs --seed");
      sample = Number(values.sample);
    } else if (values.seed !== undefined) {
      return usage(io, "--seed goes with --sample");
    }
    const only = values.only?.split(",").map((s) => s.trim()).filter((s) => s !== "");
    try {
      const all = selectTasks(set, { split, ...(only ? { only } : {}) });
      leftOut.push(...(gpuChoice === "none" ? all.filter(needsGpu).map((t) => t.id) : []));
      tasks = selectTasks(set, { split, ...(only ? { only } : {}), ...(sample ? { sample, seed: values.seed! } : {}), skipGpu: gpuChoice === "none" });
    } catch (err) {
      return usage(io, message(err));
    }
    if (tasks.length === 0) return usage(io, "the selection is empty");
    try {
      ({ root, sub } = modelFlags(values, settings));
    } catch (err) {
      if (err instanceof UsageError) return usage(io, err.message);
      throw err;
    }
  }

  // the models, profile and call format, as run.start would get them
  let params;
  try {
    params = buildRunParams(
      { mode: "read", ...(root ? { root } : {}), ...(sub ? { sub } : {}), profile, callFormat, interactive: false },
      { settings, resolveCallFormat: () => "fenced" },
    );
  } catch (err) {
    if (err instanceof UsageError) return usage(io, err.message);
    throw err;
  }

  if (tasks.some(needsGpu) && gpuChoice !== "none" && process.platform === "darwin") {
    return usage(io, `kernel tasks need an NVIDIA (CUDA) or AMD (HIP) GPU, which macOS doesn't have: ${tasks.filter(needsGpu).map((t) => t.id).join(", ")}; pass --gpu none`);
  }
  const webKeys = [...new Set(tasks.flatMap((t) => (t.kind === "repo" && t.node_env !== undefined ? [t.node_env] : [])))];
  if (webKeys.length > 0) {
    const tools = await findNodeTools(process.env);
    for (const key of webKeys) {
      const problem = nodeToolsProblem(tools, set.nodeEnvs.get(key)!);
      if (problem !== null) return usage(io, `the web tasks can't run: ${problem}`);
    }
  }

  const id = evalId(set, split);
  const out = rerun ? join(rerun.of, "rerun") : values.out !== undefined ? resolve(values.out) : defaultOut(io.home, id);
  if (!rerun && !emptyOrMissing(out)) return usage(io, `--out ${out} is not empty`);
  return {
    values,
    set,
    tasks,
    split,
    root: params.root,
    sub: params.sub,
    profile: params.profile,
    callFormat,
    jobs: Number(jobsText),
    out,
    id,
    gpu: gpuChoice,
    leftOut,
    maxUsd,
    ...(rerun ? { rerun } : {}),
    settings,
  };
}

/** `report`, `compare` or `ledger` when it is the first argument (--verbose aside), else null: `--out report` is a flag's value. */
export function evalSubcommand(argv: string[]): "report" | "compare" | "ledger" | null {
  const first = argv.filter((a) => a !== "--verbose")[0];
  return first === "report" || first === "compare" || first === "ledger" ? first : null;
}

/** The exit code when `rlmh eval` would be refused before it starts an engine, else null. Prints why. */
export async function preflightEval(argv: string[], io: CliIO): Promise<number | null> {
  if (evalSubcommand(argv) !== null) return null;
  const prepared = await prepareEval(argv, io);
  return typeof prepared === "number" ? prepared : null;
}

/** `git rev-parse HEAD` of a source checkout, else null. */
function harnessCommit(): string | null {
  const dir = import.meta.dir;
  if (dir.includes("$bunfs") || dir.includes("~BUN")) return null;
  try {
    const r = Bun.spawnSync(["git", "-C", resolve(dir, "..", "..", ".."), "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore", env: stripKeys(process.env) });
    const sha = r.stdout.toString().trim();
    return r.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function taskLine(l: GradeLine): string {
  const status = l.infra_kind !== null ? `infra:${l.infra_kind}` : l.pass ? "pass" : "fail";
  return `${l.id}  ${l.track}/${l.size}  ${status}  ${l.score.toFixed(3)}  ${l.turns}  $${l.cost_usd.toFixed(4)}  ${l.wall_s.toFixed(1)}\n`;
}

/** Extra seams for tests: runEval's deps, and the session used for engine.info. */
export interface EvalCommandDeps {
  runEval?: EvalDeps;
  info?: () => Promise<EngineInfo>;
}

export async function evalCommand(argv: string[], io: CliIO, deps: EvalCommandDeps = {}): Promise<number> {
  const sub = evalSubcommand(argv);
  if (sub !== null) return subcommand(sub, argv.filter((a) => a !== "--verbose").slice(1), io);
  const prepared = await prepareEval(argv, io);
  if (typeof prepared === "number") return prepared;
  const p = prepared;

  // engine.info, for the profile's limits (D-198)
  let info: EngineInfo;
  try {
    if (deps.info) info = await deps.info();
    else {
      const s = await Session.open({ home: io.home, ...(p.values.verbose ? { verbose: true } : {}), approvals: async () => ({ allow: false, remember_for_run: false }) });
      try {
        info = await s.info();
      } finally {
        await s.close();
      }
    }
  } catch (err) {
    return openFailed(io, err);
  }
  const profile = info.profiles.find((x) => x.name === p.profile);
  if (profile === undefined) return usage(io, `no profile named ${JSON.stringify(p.profile)} (have: ${info.profiles.map((x) => x.name).join(", ")})`);
  if (p.rerun && p.rerun.meta.profile_hash !== profile.profile_hash) {
    return usage(io, `profile ${p.profile} has changed since ${p.rerun.of} ran (its profile_hash differs)`);
  }
  let refs;
  try {
    refs = referenceFrom((p.values["tokens-from"] ?? []).map((f) => resolve(f)), p.set);
  } catch (err) {
    return usage(io, `--tokens-from: ${message(err)}`);
  }
  const est: Estimate = estimate(p.tasks, {
    root: p.root,
    sub: p.sub,
    catalog: new Catalog(io.home),
    refs,
    profile: profile as ProfileInfo,
    home: io.home,
    set: p.set,
    ...(p.gpu !== undefined ? { gpu: p.gpu } : {}),
    leftOut: p.leftOut,
    ...(deps.runEval?.storeDir !== undefined ? { storeDir: deps.runEval.storeDir } : {}),
    ...(deps.runEval?.browsersDir !== undefined ? { browsersDir: deps.runEval.browsersDir } : {}),
  });
  const cap = p.maxUsd ?? est.default_cap_usd;
  const shown = { permissionMode: p.set.manifest.permission_mode, profile: p.profile, root: p.root, sub: p.sub, cap };
  if (!p.values.go) {
    if (p.values.json) io.stdout.write(jsonLine("eval.estimate", { ...est, cap_usd: cap, permission_mode: p.set.manifest.permission_mode }));
    else io.stdout.write(renderEstimate(est, shown));
    return 0;
  }
  if (cap === null) return usage(io, `${est.unpriced.join(", ")} has no catalog price, so --go needs an explicit --max-usd`);
  if (!p.values.json) io.stderr.write(renderEstimate(est, shown).replace(/\nNothing was run[^\n]*\n$/, "\n"));

  let result;
  try {
    result = await runEval(
      {
        home: io.home,
        set: p.set,
        tasks: p.tasks,
        split: p.split,
        root: p.root,
        sub: p.sub,
        profile: p.profile,
        callFormat: p.callFormat,
        jobs: p.jobs,
        out: p.out,
        maxUsd: cap,
        ...(p.values.keep ? { keep: true } : {}),
        ...(p.gpu !== undefined ? { gpu: p.gpu } : {}),
        id: p.id,
        meta: {
          profile_hash: profile.profile_hash,
          prompt_hash: profile.prompt_hash,
          estimate: { total_usd: est.total_usd, runs: est.runs, rows: est.rows },
          harness_commit: harnessCommit(),
          rerun_of: p.rerun?.of ?? null,
        },
        ...(p.values.verbose ? { verbose: true } : {}),
        say: (line) => io.stderr.write(`rlmh eval: ${line}\n`),
        onSession: (s: EvalSession) => (p.values.json ? attachJson(s.bus, io.stdout) : attachPlain(s.bus, io.stderr)),
        onTask: (l) => io.stdout.write(p.values.json ? jsonLine("eval.task", l) : taskLine(l)),
      },
      deps.runEval,
    );
  } catch (err) {
    if (err instanceof GpuMissing || err instanceof ProbeError) {
      io.stderr.write(`rlmh eval: ${err.message}\n`);
      return 2;
    }
    io.stderr.write(`rlmh eval: ${message(err)}\n`);
    return 1;
  }
  if (p.rerun) writeReports(p.rerun.of);
  const infra = result.lines.filter((l) => l.infra_kind !== null).length;
  const passed = result.lines.filter((l) => l.pass && l.infra_kind === null).length;
  if (result.engineExit && result.lines.some((l) => l.grade_error?.includes("engine exited"))) {
    io.stderr.write(`rlmh: the engine exited (exit code ${result.engineExit.code})\n${result.engineExit.stderr.map((l) => `${l}\n`).join("")}`);
  }
  if (p.values.json) {
    io.stdout.write(jsonLine("eval.finished", { runs: result.lines.length, passed, infra, cost_usd: result.cost_usd, capped: result.capped, out: result.out }));
  } else {
    const seconds = result.lines.reduce((a, l) => a + l.wall_s, 0);
    io.stdout.write(
      `total  ${result.lines.length} tasks  ${passed} passed  ${infra} infra  $${result.cost_usd.toFixed(4)}  ${seconds.toFixed(1)}${result.capped ? "  capped" : ""}\n` +
        `out: ${result.out}\n`,
    );
  }
  if (result.interrupted) return 130;
  return infra > 0 || result.capped ? 1 : 0;
}

/** `report OUT`, `compare A B` and `ledger`: no engine. */
function subcommand(name: "report" | "compare" | "ledger", args: string[], io: CliIO): number {
  const want = name === "report" ? 1 : name === "compare" ? 2 : 0;
  if (args.some((a) => a.startsWith("-")) || args.length !== want) {
    return usage(io, name === "report" ? "eval report takes one output folder" : name === "compare" ? "eval compare takes two output folders" : "eval ledger takes no arguments");
  }
  if (name === "ledger") {
    const lines = readLedger(io.home);
    for (const l of lines) io.stdout.write(`${l.date}  ${l.what}  ${l.set}/${l.split}  ${l.root}  ${l.profile}  ${l.runs} runs  $${Number(l.cost_usd).toFixed(4)}  ${l.out}\n`);
    const total = lines.reduce((a, l) => a + (Number(l.cost_usd) || 0), 0);
    io.stdout.write(`total: $${total.toFixed(2)} of $${LEDGER_CAP_USD}\n`);
    return 0;
  }
  const dirs = args.map((a) => resolve(a));
  for (const d of dirs) if (!existsSync(join(d, "grades.jsonl"))) return usage(io, `${d} has no grades.jsonl`);
  if (name === "report") {
    writeReports(dirs[0]!);
    io.stdout.write(readFileSync(join(dirs[0]!, "report.md"), "utf8"));
    return 0;
  }
  io.stdout.write(renderCompare(compare(readOutput(dirs[0]!), readOutput(dirs[1]!)), { a: "A", b: "B" }));
  return 0;
}
