// KV cache: none
// `rlmh tune` (v1 architecture §7.5, step 6): Harness²'s rounds over an eval set's tune split. Without --go it
// prints every stage's price and spends nothing; with --go it runs runTune on one Session. --gated turns on
// D-234's gate for this tune's engine. Exit 0 (every round ran, or the budget ended them), 1 (stopped by the
// cap or an error), 2 (usage), 130 (Ctrl-C).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stripKeys } from "../engine.ts";
import { Catalog } from "../gateway/catalog.ts";
import { LEDGER_CAP_USD, readLedger } from "../eval/ledger.ts";
import { evalEngineEnv } from "../eval/runner.ts";
import { loadSet, SetError, selectTasks, type EvalSet, type EvalTask } from "../eval/set.ts";
import type { Backend } from "../eval/work.ts";
import { tuneDir } from "../paths.ts";
import type { EngineInfo, ModelRef, ProfileInfo } from "../protocol.ts";
import { buildRunParams, Session, UsageError } from "../session.ts";
import { loadSettings, type Settings } from "../settings.ts";
import { renderTuneEstimate, runTune, tuneEstimate, type TuneDeps, type TuneEstimate } from "../tune/offline.ts";
import { attachJson, jsonLine } from "./print.ts";
import { message, modelFlags, openFailed, type CliIO } from "./run.ts";

const TUNE_OPTIONS = {
  root: { type: "string" },
  sub: { type: "string" },
  base: { type: "string" },
  name: { type: "string" },
  from: { type: "string" },
  continue: { type: "string" },
  rounds: { type: "string" },
  probe: { type: "string" },
  seed: { type: "string" },
  jobs: { type: "string" },
  "tokens-from": { type: "string", multiple: true },
  out: { type: "string" },
  gpu: { type: "string" },
  go: { type: "boolean" },
  "max-usd": { type: "string" },
  gated: { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
} as const;

export const TUNE_USAGE = `Usage: rlmh tune SET --root P/M [--sub P/M] --base PROFILE --name NAME (--from EVAL_OUT | --continue OUT)
                 [--rounds 2] [--probe 10] [--seed 0] [--jobs 4] [--tokens-from RUNS.jsonl]... [--out DIR]
                 [--gpu cuda|hip|none] [--go] [--max-usd X] [--gated] [--json] [--verbose]
`;

/** The engine's profile name rule (profiles._NAME_RE), with room for `-r<r>-inv` (56 characters at most). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,55}$/;
const BUILTINS = ["default", "training-v4"];

function usage(io: CliIO, text: string): number {
  io.stderr.write(`rlmh tune: ${text}\n${TUNE_USAGE}`);
  return 2;
}

const parseTune = (argv: string[]) => parseArgs({ args: argv, options: TUNE_OPTIONS, strict: true, allowPositionals: true });
type TuneValues = ReturnType<typeof parseTune>["values"];

function emptyOrMissing(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    return !existsSync(dir);
  }
}

const whole = (text: string | undefined, fallback: number, min: number): number | null => {
  const t = text ?? String(fallback);
  return /^\d+$/.test(t) && Number(t) >= min ? Number(t) : null;
};

interface Prepared {
  values: TuneValues;
  set: EvalSet;
  tune: EvalTask[];
  probe: EvalTask[];
  root: ModelRef;
  sub: ModelRef;
  base: string;
  name: string;
  from: string;
  rounds: number;
  probeK: number;
  seed: string;
  jobs: number;
  out: string;
  maxUsd: number | undefined;
  gpu: Backend | "none" | undefined;
  gated: boolean;
  /** --continue: the tune.json continued. */
  resume?: Record<string, unknown>;
  fromMeta: Record<string, unknown>;
  settings: Settings;
}

/** Everything `rlmh tune` can check before an engine exists (task 10's pre-flight). Writes only errors. */
async function prepareTune(argv: string[], io: CliIO): Promise<Prepared | number> {
  let parsed;
  try {
    parsed = parseTune(argv);
  } catch (err) {
    return usage(io, message(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return usage(io, positionals.length === 0 ? "name an eval set folder" : "give exactly one eval set folder");
  for (const flag of ["root", "base", "name"] as const) if (values[flag] === undefined) return usage(io, `--${flag} is required`);
  if ((values.from === undefined) === (values.continue === undefined)) return usage(io, "give --from EVAL_OUT (an `rlmh eval SET --split tune --profile BASE --go` output) or --continue OUT, not both");
  const name = values.name!;
  if (!NAME_RE.test(name)) return usage(io, `--name ${JSON.stringify(name)}: letters, digits, '.', '_' and '-', starting with a letter or digit, at most 56 characters`);
  const rounds = whole(values.rounds, 2, 1);
  if (rounds === null) return usage(io, "--rounds must be a whole number, 1 or more");
  const probeK = whole(values.probe, 10, 1);
  if (probeK === null) return usage(io, "--probe must be a whole number, 1 or more");
  const jobs = whole(values.jobs, 4, 1);
  if (jobs === null) return usage(io, "--jobs must be a whole number, 1 or more");
  let maxUsd: number | undefined;
  if (values["max-usd"] !== undefined) {
    maxUsd = Number(values["max-usd"]);
    if (!Number.isFinite(maxUsd) || maxUsd < 0) return usage(io, `--max-usd must be a number, 0 or more (got ${JSON.stringify(values["max-usd"])})`);
  }
  const gpu = values.gpu as Backend | "none" | undefined;
  if (gpu !== undefined && !["cuda", "hip", "none"].includes(gpu)) return usage(io, `--gpu must be cuda, hip or none (got ${JSON.stringify(gpu)})`);
  let set: EvalSet;
  try {
    set = loadSet(positionals[0]!);
  } catch (err) {
    if (err instanceof SetError) {
      io.stderr.write(`rlmh tune: ${err.message}\n`);
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
  const tune = selectTasks(set, { split: "tune", skipGpu: gpu === "none" });
  if (tune.length === 0) return usage(io, "the set has no tune tasks");
  if (values.continue === undefined && probeK > tune.length) return usage(io, `--probe ${probeK} is more than the ${tune.length} tune tasks`);

  let resume: Record<string, unknown> | undefined;
  let from: string;
  let out: string;
  let gated = values.gated ?? false;
  if (values.continue !== undefined) {
    out = resolve(values.continue);
    try {
      resume = JSON.parse(readFileSync(join(out, "tune.json"), "utf8"));
    } catch {
      return usage(io, `${out} has no readable tune.json`);
    }
    if (resume!.stopped !== null) return usage(io, `${out} stopped (${String(resume!.stopped)}): only a finished tune can be continued`);
    if (resume!.name !== name || resume!.base !== values.base) return usage(io, `${out} tuned ${String(resume!.base)} into ${String(resume!.name)}; give the same --base and --name`);
    if (values.gated !== undefined && values.gated !== resume!.gated) return usage(io, `${out} ran with --gated ${resume!.gated ? "on" : "off"}; --continue keeps it`);
    gated = resume!.gated === true;
    if (resume!.tasks_sha256 !== set.manifest.tasks_sha256 || resume!.grades_sha256 !== set.manifest.grades_sha256) return usage(io, `the set's hashes differ from ${join(out, "tune.json")}'s`);
    const done = Array.isArray(resume!.rounds) ? (resume!.rounds as unknown[]).length : 0;
    if (values.probe !== undefined) return usage(io, "--continue keeps the first run's --probe and --seed; leave them out");
    if (rounds <= done) return usage(io, `${out} has run ${done} round(s): --rounds is the total, so give more than ${done}`);
    from = String(resume!.from);
  } else {
    from = resolve(values.from!);
    out = values.out !== undefined ? resolve(values.out) : join(tuneDir(io.home), `${name}-${stampNow()}`);
    if (!emptyOrMissing(out)) return usage(io, `--out ${out} is not empty`);
    for (const existing of existsSync(join(io.home, "profiles")) ? readdirSync(join(io.home, "profiles")) : []) {
      if (existing === name || existing.startsWith(`${name}-r`)) return usage(io, `${join(io.home, "profiles", existing)} already exists: pick another --name`);
    }
  }
  let fromMeta: Record<string, unknown>;
  for (const f of ["eval.json", "runs.jsonl", "grades.jsonl"]) if (!existsSync(join(from, f))) return usage(io, `--from ${from} has no ${f}`);
  try {
    fromMeta = JSON.parse(readFileSync(join(from, "eval.json"), "utf8"));
  } catch {
    return usage(io, `--from ${from}: eval.json doesn't parse`);
  }
  if (fromMeta.tasks_sha256 !== set.manifest.tasks_sha256 || fromMeta.grades_sha256 !== set.manifest.grades_sha256) return usage(io, `--from ${from} ran another set (its hashes differ)`);
  const ran = new Set(Array.isArray(fromMeta.tasks) ? (fromMeta.tasks as string[]) : []);
  const missing = tune.filter((t) => !ran.has(t.id)).map((t) => t.id);
  if (missing.length > 0) return usage(io, `--from ${from} is missing tune task(s): ${missing.join(", ")}`);
  let root: ModelRef | undefined;
  let sub: ModelRef | undefined;
  try {
    ({ root, sub } = modelFlags(values, settings));
    const params = buildRunParams({ mode: "read", ...(root ? { root } : {}), ...(sub ? { sub } : {}), profile: values.base!, interactive: false }, { settings, resolveCallFormat: () => "fenced" });
    root = params.root;
    sub = params.sub;
  } catch (err) {
    if (err instanceof UsageError) return usage(io, err.message);
    throw err;
  }
  const seed = values.seed ?? (resume?.probe as { seed?: string } | undefined)?.seed ?? "0";
  const probe = resume
    ? tune.filter((t) => ((resume!.probe as { ids?: string[] }).ids ?? []).includes(t.id))
    : selectTasks(set, { split: "tune", sample: probeK, seed, skipGpu: gpu === "none" });
  return { values, set, tune, probe, root: root!, sub: sub!, base: values.base!, name, from, rounds, probeK, seed, jobs, out, maxUsd, gpu, gated, ...(resume ? { resume } : {}), fromMeta, settings };
}

const two = (n: number) => String(n).padStart(2, "0");
function stampNow(d = new Date()): string {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** The exit code when `rlmh tune` would be refused before it starts an engine, else null. Prints why. */
export async function preflightTune(argv: string[], io: CliIO): Promise<number | null> {
  const prepared = await prepareTune(argv, io);
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

const sameRef = (a: unknown, b: ModelRef) => {
  const x = a as ModelRef | null | undefined;
  return x !== null && x !== undefined && x.provider === b.provider && x.model === b.model;
};

/** Extra seams for tests. */
export interface TuneCommandDeps {
  tune?: Partial<TuneDeps>;
}

export async function tuneCommand(argv: string[], io: CliIO, deps: TuneCommandDeps = {}): Promise<number> {
  const prepared = await prepareTune(argv, io);
  if (typeof prepared === "number") return prepared;
  const p = prepared;
  const backend = (p.fromMeta.gpu_backend as Backend | null | undefined) ?? null;
  let session: Session;
  try {
    session = await Session.open({
      home: io.home,
      ...(p.values.verbose ? { verbose: true } : {}),
      approvals: async () => ({ allow: false, remember_for_run: false }),
      env: { ...evalEngineEnv(io.home, { backend }), ...(p.gated ? { RLMH_TUNE_GATED: "1" } : {}) },
    });
  } catch (err) {
    return openFailed(io, err);
  }
  try {
    let info: EngineInfo;
    try {
      info = await session.info();
    } catch (err) {
      return openFailed(io, err);
    }
    // the checks that need engine.info, still before any spend
    if (BUILTINS.includes(p.name) || info.profiles.some((x) => x.name === p.name && x.source === "builtin")) return usage(io, `--name ${p.name} is a built-in profile's name`);
    const base = info.profiles.find((x) => x.name === p.base);
    if (base === undefined) return usage(io, `no profile named ${JSON.stringify(p.base)} (have: ${info.profiles.map((x) => x.name).join(", ")})`);
    if (base.name === "training-v4") return usage(io, "training-v4 is never a tuning base: it is training's contract, byte for byte");
    if (!base.agent_api) return usage(io, `${base.name} has no agent_api, so it can't take skills or scripts; tune a default-based profile`);
    if (p.fromMeta.profile_hash !== base.profile_hash) return usage(io, `--from ran a profile whose profile_hash differs from ${base.name}'s: run \`rlmh eval SET --split tune --profile ${base.name} --go\` first`);
    if (!sameRef(p.fromMeta.root, p.root) || !sameRef(p.fromMeta.sub ?? p.fromMeta.root, p.sub)) return usage(io, `--from ran other models than --root ${p.root.provider}/${p.root.model} --sub ${p.sub.provider}/${p.sub.model}`);

    const catalog = new Catalog(io.home);
    const ledgerTotal = readLedger(io.home).reduce((a, l) => a + (Number(l.cost_usd) || 0), 0);
    const tokens = [...(p.values["tokens-from"] ?? []).map((f) => resolve(f)), join(p.from, "runs.jsonl")];
    let est: TuneEstimate;
    try {
      est = tuneEstimate({ set: p.set, tune: p.tune, probe: p.probe, root: p.root, sub: p.sub, catalog, profile: base as ProfileInfo, home: io.home, runLogs: tokens, from: p.from, rounds: p.rounds, ...(p.maxUsd !== undefined ? { cap: p.maxUsd } : {}) });
    } catch (err) {
      return usage(io, `the estimate failed: ${message(err)}`);
    }
    const cap = p.maxUsd ?? est.default_cap_usd;
    const shown = { base: p.base, name: p.name, root: p.root, sub: p.sub, probe: p.probe.length, tune: p.tune.length, cap, ledgerTotal, ledgerCap: LEDGER_CAP_USD };
    if (!p.values.go) {
      if (p.values.json) io.stdout.write(jsonLine("tune.estimate", { ...est, cap_usd: cap }));
      else io.stdout.write(renderTuneEstimate(est, shown));
      return 0;
    }
    if (cap === null) return usage(io, `${est.unpriced.join(", ")} has no catalog price, so --go needs an explicit --max-usd`);
    if (!p.values.json) io.stderr.write(renderTuneEstimate(est, shown).replace(/\nNothing was run[^\n]*\n$/, "\n"));
    const detach = p.values.json ? attachJson(session.bus, io.stdout) : () => {};
    let result;
    try {
      result = await runTune(
        {
          home: io.home,
          set: p.set,
          base,
          name: p.name,
          root: p.root,
          sub: p.sub,
          from: p.from,
          rounds: p.rounds,
          probe: p.probe.length,
          seed: p.seed,
          jobs: p.jobs,
          out: p.out,
          maxUsd: cap,
          gated: p.gated,
          ...(p.gpu !== undefined ? { gpu: p.gpu } : {}),
          tokensFrom: tokens,
          estimate: est,
          harnessCommit: harnessCommit(),
          ...(p.resume ? { resume: p.resume } : {}),
          catalog,
          say: (line) => io.stderr.write(`rlmh tune: ${line}\n`),
          onStage: (e) => io.stdout.write(p.values.json ? jsonLine("tune.stage", e) : `round ${e.round}  ${e.stage}  ${e.decision}  attempts ${e.attempts}${e.fell_back ? "  fell back" : ""}  $${e.cost_usd.toFixed(4)}\n`),
          onRound: (r) => {
            const a = r.accept as { ref: { passed: number }; new: { passed: number }; reason: string } | undefined;
            io.stdout.write(
              p.values.json
                ? jsonLine("tune.round", r)
                : `round ${String(r.round)}  ${String(r.result)}${a ? `  passed ${a.new.passed} vs ${a.ref.passed} (${a.reason})` : ""}  $${Number(r.cost_usd ?? 0).toFixed(4)}\n`,
            );
          },
        },
        { session, ...deps.tune },
      );
    } finally {
      detach();
    }
    const j = result.tuneJson;
    if (p.values.json) io.stdout.write(jsonLine("tune.finished", { stopped: result.stopped, budget_stop: result.budget_stop, accepted_rounds: result.accepted_rounds, final: j.final, cost_usd: result.cost_usd, out: p.out }));
    else io.stdout.write(`tune ${result.stopped === null ? "finished" : `stopped (${result.stopped})`}  accepted rounds: ${result.accepted_rounds.join(", ") || "none"}  $${result.cost_usd.toFixed(4)}\nout: ${p.out}\n`);
    if (result.stopped === "interrupted") return 130;
    return result.stopped === null ? 0 : 1;
  } finally {
    await session.close();
  }
}
