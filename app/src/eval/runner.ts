// KV cache: none
// runEval (D-192): the one entry point that runs and grades an eval, for `rlmh eval`, `rlmh tune`
// (step 6) and `/tune` (step 9). It prepares every environment before the first run, probes the GPU
// only when a selected task needs one (D-223), then runs a pool on one Session as `rlmh batch` does:
// nobody is asked anything, and every grade line is written as soon as its run is graded. A CostCap
// stops it at `maxUsd` of billed cost (D-193). Its inline form (v1 step 9) runs in-memory tasks for `/tune`:
// no set, no grading, no ledger line, each repo run in a work copy the caller makes.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Bus } from "../bus.ts";
import { message, onInterrupt as defaultOnInterrupt, RunWatcher } from "../cli/run.ts";
import { findUv } from "../cli/setup.ts";
import type { AppEvents } from "../gateway/gateway.ts";
import { evalDir } from "../paths.ts";
import type { ModelRef, RunFinishedParams, RunStartResult } from "../protocol.ts";
import { Session, type StartRun } from "../session.ts";
import { APP_VERSION } from "../version.ts";
import { gradeRepo as defaultGradeRepo, leakSuspect, readPassed, scoreAnswer } from "./graders.ts";
import { appendLedger } from "./ledger.ts";
import { buildReport, readGrades, renderReport, type GradeLine } from "./report.ts";
import { needsGpu, type AnswerGrade, type EvalSet, type EvalTask, type RepoTask, type TestsGrade } from "./set.ts";
import {
  browserReady,
  browsersDirOf,
  ensureBrowser,
  ensureNodeEnv,
  ensureVenv,
  EnvError,
  extractShim,
  fillHint,
  findNodeTools,
  installNodeModules,
  killChildren,
  makeWorkCopy,
  nodeToolsProblem,
  probeGpu as defaultProbeGpu,
  removeQuietly,
  removeSrcPth,
  writeSrcPth,
  type Backend,
  type NodeTools,
  type Runner,
  type Venv,
} from "./work.ts";

/** What runEval needs of a Session; tests pass a stub. */
export interface EvalSession {
  bus: Bus<AppEvents>;
  start(r: StartRun): Promise<RunStartResult>;
  cancel(runId: string): Promise<void>;
  close(): Promise<void>;
}

/** No GPU for the selected kernel tasks: nothing has been spent yet. */
export class GpuMissing extends Error {
  readonly tasks: string[];

  constructor(tasks: string[], backend: string) {
    super(
      `no GPU found (probe: backend=${backend} devices=0), so these tasks can't run: ${tasks.join(", ")}. ` +
        "Pass --gpu none to leave them out, or --gpu cuda|hip to pick a backend.",
    );
    this.name = "GpuMissing";
    this.tasks = tasks;
  }
}

/**
 * Sums the billed cost of every `call.end` on the bus (D-121, D-193). Once the total passes `maxUsd`, every
 * tracked run is cancelled exactly once, and so is any run tracked later; `capped` then stays true.
 */
export interface CostCapOptions {
  /**
   * Count only the call.ends of runs this cap has tracked (v1 step 9): the interactive app's bus also carries the
   * user's own runs, which `/tune`'s cap must not count. A call.end that comes before its run is tracked is held
   * and counted when it is.
   */
  trackedOnly?: boolean;
  /** Called with the new total after each counted call.end. */
  onCost?: (total: number) => void;
}

export class CostCap {
  total = 0;
  capped = false;
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly held = new Map<string, number>();
  private readonly off: () => void;

  constructor(
    bus: Bus<AppEvents>,
    private readonly maxUsd: number | null,
    private readonly cancel: (runId: string) => void,
    /** Called once when the cap trips, before the cancels: the pool stops starting tasks. */
    private readonly onCap: () => void = () => {},
    private readonly opts: CostCapOptions = {},
  ) {
    this.off = bus.on("call.end", (c) => {
      if (this.opts.trackedOnly && !this.seen.has(c.run_id)) {
        this.held.set(c.run_id, (this.held.get(c.run_id) ?? 0) + c.usage.cost_usd);
        return;
      }
      this.add(c.usage.cost_usd);
    });
  }

  private add(usd: number): void {
    this.total += usd;
    this.opts.onCost?.(this.total);
    if (!this.capped && this.maxUsd !== null && this.total > this.maxUsd) {
      this.capped = true;
      this.onCap();
      for (const id of this.running) this.cancelOnce(id);
    }
  }

  track(runId: string): void {
    this.running.add(runId);
    if (this.opts.trackedOnly && !this.seen.has(runId)) {
      this.seen.add(runId);
      const held = this.held.get(runId);
      if (held !== undefined) {
        this.held.delete(runId);
        this.add(held);
      }
    }
    if (this.capped) this.cancelOnce(runId);
  }

  untrack(runId: string): void {
    this.running.delete(runId);
  }

  private cancelOnce(runId: string): void {
    if (this.cancelled.has(runId)) return;
    this.cancelled.add(runId);
    this.cancel(runId);
  }

  dispose(): void {
    this.off();
  }
}

/** The engine's extra env during an eval: the model's own Playwright runs find the browser and use Web-Bench's grading timeouts, and the GPU backend reaches the worker. None of the names is key-like (D-29, D-133). */
export function evalEngineEnv(home: string, o: { backend?: Backend | null; browsersDir?: string } = {}): Record<string, string> {
  return {
    PLAYWRIGHT_BROWSERS_PATH: browsersDirOf({ home, ...(o.browsersDir !== undefined ? { browsersDir: o.browsersDir } : {}) }),
    IS_EVAL_PRODUCTION: "1",
    ...(o.backend ? { RLMH_GPU_BACKEND: o.backend } : {}),
  };
}

const two = (n: number) => String(n).padStart(2, "0");
/** `YYYYMMDD-HHMMSS` in local time. */
const stampOf = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;

/** `<manifest.name>-<split>-<YYYYMMDD-HHMMSS>`, in local time (D-192). It is also the batch name and the work folder. */
export function evalId(set: EvalSet, split: string, now: Date = new Date()): string {
  return `${set.manifest.name.replace(/[^A-Za-z0-9._-]/g, "_")}-${split}-${stampOf(now)}`;
}

export interface EvalOptions {
  home: string;
  set: EvalSet;
  tasks: EvalTask[];
  split: "tune" | "heldout" | "all";
  root: ModelRef;
  sub?: ModelRef;
  profile: string;
  callFormat?: string;
  jobs: number;
  out: string;
  /** null: no cap. */
  maxUsd: number | null;
  keep?: boolean;
  /** Where the runs' runs.jsonl goes; default `out`. */
  logDir?: string;
  /** The --gpu choice; "none" means the caller left the kernel tasks out already. */
  gpu?: Backend | "none";
  /** Default: evalId(set, split, now). */
  id?: string;
  /** False inside a tune, which writes one ledger line of its own (D-211). */
  ledger?: boolean;
  /** Extra eval.json keys: profile_hash, estimate, harness_commit, rerun_of. */
  meta?: Record<string, unknown>;
  verbose?: boolean;
  /** Each grade line, as it is written. */
  onTask?: (line: GradeLine) => void;
  /** Called once the session exists, before the first run; returns a detach (printers). */
  onSession?: (s: EvalSession) => () => void;
  /** Progress lines about preparation (venvs, node envs, the GPU probe). */
  say?: (line: string) => void;
}

export interface EvalDeps {
  session?: EvalSession;
  /** uv's path; default findUv. */
  uv?: string | null;
  /** Runs uv, pnpm, node and the GPU probe (never git or the graders); tests record it. */
  run?: Runner;
  tools?: NodeTools;
  probeGpu?: typeof defaultProbeGpu;
  gradeRepo?: typeof defaultGradeRepo;
  storeDir?: string;
  browsersDir?: string;
  now?: () => Date;
  onInterrupt?: (fn: () => void) => () => void;
}

export interface EvalResult {
  id: string;
  out: string;
  lines: GradeLine[];
  capped: boolean;
  /** Ctrl-C was pressed. */
  interrupted: boolean;
  /** A second Ctrl-C: the eval stopped at once. */
  aborted: boolean;
  cost_usd: number;
  gpu_backend: Backend | null;
  engineExit: AppEvents["engine.exit"] | undefined;
  /** D-257: the account kind (ACCOUNT) a graded run ended with, which stopped the eval; null when none did. */
  account_stop: string | null;
}

/**
 * D-257: infra kinds that say the provider account can't go on (out of credit, a rejected key, no key): every later
 * call would fail the same way, so the eval stops at the first, as the cost cap does. None of them is transient.
 */
export const ACCOUNT = ["no_credit", "auth", "no_key"];

const ACCOUNT_WHY: Record<string, string> = {
  no_credit: "the account is out of credit",
  auth: "the key was rejected",
  no_key: "no key is saved",
};

const ACCOUNT_FIX: Record<string, string> = {
  no_credit: "Add credit, then run again.",
  auth: "Fix the key in /providers, then run again.",
  no_key: "Add a key in /providers, then run again.",
};

/** What an account kind stopped (D-257): `the provider says <why> (<kind>): <what>`, and with `fix` what to do. */
export const accountStopMessage = (kind: string, what: string, fix = false): string =>
  `the provider says ${ACCOUNT_WHY[kind] ?? kind} (${kind}): ${what}${fix ? `. ${ACCOUNT_FIX[kind] ?? "Fix the account, then run again."}` : ""}`;

const DENY = async () => ({ allow: false, remember_for_run: false });

/** The run log record of one run, or null. */
function readRecord(logDir: string, runId: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(join(logDir, "runs.jsonl"), "utf8");
  } catch {
    return null;
  }
  for (const chunk of text.split("\n")) {
    if (!chunk.includes(runId)) continue;
    try {
      const r = JSON.parse(chunk);
      if (r?.run_id === runId) return r;
    } catch {
      // torn
    }
  }
  return null;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * One task held in memory rather than in an eval set (v1 step 9, `/tune`): a user's own question or repo task,
 * run as it was asked, with nothing to grade.
 */
export interface InlineTask {
  /** The run's tag (`tune:<id>:<stage>` for `/tune`, D-231); it also names the run in the result. */
  tag: string;
  mode: "read" | "repo";
  question?: string;
  /** Read mode: absolute input paths. */
  inputs?: string[];
  task?: string;
  testHint?: string;
  /**
   * Repo mode: makes the folder the run works in (a `/tune` work copy), just before run.start. `after` runs once
   * the run has finished (null: it never started, or the engine exited) and before `remove`, which always runs.
   */
  workCopy?: () => Promise<InlineCopy>;
}

export interface InlineCopy {
  repoPath: string;
  after?: (f: RunFinishedParams | null) => Promise<void>;
  remove(): Promise<void>;
}

/**
 * runEval over in-memory tasks (v1 step 9): run one after another on the given session, never graded and never in
 * the ledger. `out` gets eval.json only; each run's record is in `logDir`'s runs.jsonl, so /runs lists it.
 */
export interface InlineEvalOptions {
  home: string;
  inline: InlineTask[];
  root: ModelRef;
  sub?: ModelRef;
  profile: string;
  callFormat?: string;
  out: string;
  /** Where the runs' runs.jsonl goes; default `out`. */
  logDir?: string;
  /** null: no cap of the eval's own. */
  maxUsd: number | null;
  /** Default: `inline-<YYYYMMDD-HHMMSS>`. */
  id?: string;
  /** The runs' batch; default the id. */
  batch?: string;
  /** The permission mode every run gets (the user's next-run mode for `/tune`). */
  permissionMode: string;
  /** Default false: nothing asks, and anything that would is denied (D-15). */
  interactive?: boolean;
  /** The session's bus also carries other runs (the interactive app's): the cap and the cost count only this eval's runs. */
  sharedBus?: boolean;
  /** Called with each run's id as soon as it starts; returns an untrack (an outer cap, such as `/tune`'s). */
  track?: (runId: string) => () => void;
  /** Extra eval.json keys. */
  meta?: Record<string, unknown>;
  say?: (line: string) => void;
  /** Each run's result, as it ends. */
  onRun?: (r: InlineRun) => void;
}

export interface InlineRun {
  tag: string;
  run_id: string | null;
  /** The run's run.finished; null when it never started or the engine exited first. */
  finished: RunFinishedParams | null;
  /** Its run-log record, read from `logDir`; null when missing. */
  record: Record<string, unknown> | null;
  /** null, the engine's kind, "capped" (cancelled by the cap), an account kind that stopped an earlier run, or "host_bug". */
  infra_kind: string | null;
  submitted: boolean;
  cost_usd: number;
  /** Why it failed to prepare or start, or null. */
  error: string | null;
}

export interface InlineResult {
  id: string;
  out: string;
  runs: InlineRun[];
  capped: boolean;
  /** D-257: the account kind a run ended with, which stopped the rest; null when none did. */
  account_stop: string | null;
  cost_usd: number;
  engineExit: AppEvents["engine.exit"] | undefined;
}

/** Runs in-memory tasks (InlineEvalOptions), one after another; never graded. */
export function runEval(o: InlineEvalOptions, deps?: EvalDeps): Promise<InlineResult>;
/** Runs and grades `tasks`. Throws GpuMissing or ProbeError before anything is spent. */
export function runEval(o: EvalOptions, deps?: EvalDeps): Promise<EvalResult>;
export function runEval(o: EvalOptions | InlineEvalOptions, deps: EvalDeps = {}): Promise<EvalResult | InlineResult> {
  return "inline" in o ? runInline(o, deps) : runSet(o, deps);
}

async function runInline(o: InlineEvalOptions, deps: EvalDeps): Promise<InlineResult> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const id = o.id ?? `inline-${stampOf(started)}`;
  const out = resolve(o.out);
  const logDir = resolve(o.logDir ?? out);
  const say = o.say ?? (() => {});
  mkdirSync(out, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const session: EvalSession = deps.session ?? (await Session.open({ home: o.home, approvals: DENY }));
  const watcher = new RunWatcher(session.bus);
  const batch = o.batch ?? id;
  const evalJson: Record<string, unknown> = {
    id,
    inline: true,
    tags: o.inline.map((t) => t.tag),
    root: o.root,
    sub: o.sub ?? null,
    profile: o.profile,
    call_format: o.callFormat ?? null,
    batch,
    permission_mode: o.permissionMode,
    interactive: o.interactive ?? false,
    harness_version: APP_VERSION,
    cap: o.maxUsd,
    capped: false,
    account_stop: null,
    started: started.toISOString(),
    finished: null,
    ...o.meta,
  };
  writeJson(join(out, "eval.json"), evalJson);
  const cancel = (runId: string) => void session.cancel(runId).catch(() => {});
  const cap = new CostCap(session.bus, o.maxUsd, cancel, () => say(`the cost passed the cap ($${o.maxUsd}): the running run is cancelled`), {
    trackedOnly: o.sharedBus ?? false,
  });
  const runs: InlineRun[] = [];
  let accountStop: string | null = null;
  const blank = (t: InlineTask, infra: string | null, error: string | null = null): InlineRun => ({
    tag: t.tag,
    run_id: null,
    finished: null,
    record: null,
    infra_kind: infra,
    submitted: false,
    cost_usd: 0,
    error,
  });
  const push = (r: InlineRun) => {
    runs.push(r);
    o.onRun?.(r);
  };
  const runOne = async (t: InlineTask): Promise<void> => {
    const shared = {
      root: o.root,
      ...(o.sub !== undefined ? { sub: o.sub } : {}),
      profile: o.profile,
      ...(o.callFormat !== undefined ? { callFormat: o.callFormat } : {}),
      permissionMode: o.permissionMode,
      interactive: o.interactive ?? false,
      conversation: false,
      batch,
      logDir,
      tag: t.tag,
    };
    let copy: InlineCopy | undefined;
    let f: RunFinishedParams | null = null;
    try {
      let request: StartRun;
      if (t.mode === "read") {
        request = { ...shared, mode: "read", ...(t.question !== undefined ? { question: t.question } : {}), inputs: t.inputs ?? [] };
      } else {
        try {
          copy = await t.workCopy?.();
        } catch (err) {
          return push(blank(t, "host_bug", `the work copy could not be made: ${message(err)}`));
        }
        request = {
          ...shared,
          mode: "repo",
          ...(t.task !== undefined ? { task: t.task } : {}),
          ...(copy ? { repoPath: copy.repoPath } : {}),
          ...(t.testHint !== undefined ? { testHint: t.testHint } : {}),
        };
      }
      let runId: string;
      try {
        ({ run_id: runId } = await session.start(request));
      } catch (err) {
        return push(blank(t, watcher.exit ? "other" : "host_bug", `run.start failed: ${message(err)}`));
      }
      cap.track(runId);
      const untrack = o.track?.(runId) ?? (() => {});
      try {
        f = await watcher.finished(runId);
      } finally {
        untrack();
        cap.untrack(runId);
      }
      if (f === null) return push({ ...blank(t, "other", "the engine exited before the run finished"), run_id: runId });
      let infra = f.infra_error === null ? null : (f.infra_kind ?? "other");
      if (infra === "cancelled" && cap.capped) infra = "capped";
      push({ tag: t.tag, run_id: runId, finished: f, record: readRecord(logDir, runId), infra_kind: infra, submitted: f.submitted, cost_usd: f.cost_usd, error: null });
      if (infra !== null && ACCOUNT.includes(infra) && accountStop === null) {
        accountStop = infra;
        say(accountStopMessage(infra, "no later run starts"));
      }
    } finally {
      if (copy !== undefined) {
        try {
          await copy.after?.(f);
        } finally {
          await copy.remove();
        }
      }
    }
  };
  try {
    for (const t of o.inline) {
      if (cap.capped || accountStop !== null || watcher.exit) push(blank(t, watcher.exit ? "other" : cap.capped ? "capped" : accountStop));
      else await runOne(t);
    }
  } finally {
    watcher.dispose();
    cap.dispose();
    if (deps.session === undefined) await session.close().catch(() => {});
    writeJson(join(out, "eval.json"), { ...evalJson, capped: cap.capped, account_stop: accountStop, cost_usd: Math.round(cap.total * 1e6) / 1e6, finished: now().toISOString() });
  }
  return { id, out, runs, capped: cap.capped, account_stop: accountStop, cost_usd: Math.round(cap.total * 1e6) / 1e6, engineExit: watcher.exit };
}

async function runSet(o: EvalOptions, deps: EvalDeps = {}): Promise<EvalResult> {
  const now = deps.now ?? (() => new Date());
  const id = o.id ?? evalId(o.set, o.split, now());
  const out = resolve(o.out);
  const logDir = resolve(o.logDir ?? out);
  const say = o.say ?? (() => {});
  const run = deps.run;
  mkdirSync(out, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const envFail = new Map<string, EnvError>(); // "venv:<key>" or "node:<key>" or "gpu" -> why
  const venvs = new Map<string, Venv>();

  // -- preparation: every environment before the first run --
  const venvKeys = [...new Set(o.tasks.flatMap((t) => (t.kind === "repo" && t.venv !== undefined ? [t.venv] : [])))];
  const uv = deps.uv === undefined ? findUv({ home: o.home }) : deps.uv;
  for (const key of venvKeys) {
    if (uv === null) {
      envFail.set(`venv:${key}`, new EnvError("uv was not found (looked in <home>/bin, beside rlmh and on PATH); install it from https://docs.astral.sh/uv/"));
      continue;
    }
    try {
      say(`preparing venv ${key}`);
      venvs.set(key, await ensureVenv(o.set, key, { home: o.home, uv, ...(run ? { run } : {}) }));
    } catch (err) {
      envFail.set(`venv:${key}`, err instanceof EnvError ? err : new EnvError(message(err)));
    }
  }
  let backend: Backend | null = null;
  const kernels = o.tasks.filter(needsGpu) as RepoTask[];
  // the probe runs under the first kernel venv that was built; kernel tasks whose venv failed are host_bug anyway
  const probeTask = kernels.find((t) => venvs.has(t.venv!));
  if (probeTask !== undefined && o.gpu !== "none") {
    const venv = venvs.get(probeTask.venv!)!;
    {
      const shimDir = join(evalDir(o.home), "work", `${id}.gpu-shim`);
      let probe;
      try {
        const shim = extractShim(o.set, probeTask, shimDir);
        probe = await (deps.probeGpu ?? defaultProbeGpu)(venv, shim, { ...(o.gpu !== undefined ? { backend: o.gpu } : {}), ...(run ? { run } : {}) });
      } finally {
        removeQuietly(shimDir);
      }
      if (probe.devices === 0 || probe.backend === "none") throw new GpuMissing(kernels.map((t) => t.id), probe.backend);
      backend = probe.backend;
      say(`GPU: backend=${backend} devices=${probe.devices}`);
    }
  }
  const webKeys = [...new Set(o.tasks.flatMap((t) => (t.kind === "repo" && t.node_env !== undefined ? [t.node_env] : [])))];
  let tools: NodeTools | undefined;
  if (webKeys.length > 0) {
    tools = deps.tools ?? (await findNodeTools(process.env, run));
    for (const key of webKeys) {
      const problem = nodeToolsProblem(tools, o.set.nodeEnvs.get(key)!);
      if (problem !== null) {
        envFail.set(`node:${key}`, new EnvError(problem));
        continue;
      }
      try {
        say(`preparing node env ${key}`);
        await ensureNodeEnv(o.set, key, { home: o.home, tools: tools as Extract<NodeTools, { ok: true }>, ...nodeDirs(deps), ...(run ? { run } : {}) });
      } catch (err) {
        envFail.set(`node:${key}`, err instanceof EnvError ? err : new EnvError(message(err)));
      }
    }
  }

  // -- the session --
  const browsersDir = browsersDirOf({ home: o.home, ...(deps.browsersDir !== undefined ? { browsersDir: deps.browsersDir } : {}) });
  const session: EvalSession =
    deps.session ??
    (await Session.open({ home: o.home, ...(o.verbose ? { verbose: true } : {}), approvals: DENY, env: evalEngineEnv(o.home, { backend, browsersDir }) }));
  const watcher = new RunWatcher(session.bus);
  const detach = o.onSession?.(session) ?? (() => {});
  const started = now();
  const evalJson: Record<string, unknown> = {
    id,
    set: o.set.manifest.name,
    set_dir: o.set.dir,
    tasks_sha256: o.set.manifest.tasks_sha256,
    grades_sha256: o.set.manifest.grades_sha256,
    split: o.split,
    tasks: o.tasks.map((t) => t.id),
    root: o.root,
    sub: o.sub ?? null,
    profile: o.profile,
    call_format: o.callFormat ?? null,
    jobs: o.jobs,
    harness_version: APP_VERSION,
    cap: o.maxUsd,
    capped: false,
    account_stop: null,
    rerun_of: null,
    gpu_backend: backend,
    started: started.toISOString(),
    finished: null,
    ...o.meta,
  };
  writeJson(join(out, "eval.json"), evalJson);

  // -- the pool --
  const lines: GradeLine[] = [];
  const running = new Set<string>();
  let stopping = false;
  let interrupts = 0;
  let accountStop: string | null = null;
  let abort!: () => void;
  const aborted = new Promise<"abort">((r) => (abort = () => r("abort")));
  const cancel = (runId: string) => void session.cancel(runId).catch(() => {});
  const cap = new CostCap(session.bus, o.maxUsd, cancel, () => {
    stopping = true;
    say(`the cost passed --max-usd ($${o.maxUsd}): no new task starts, and the running ones are cancelled`);
  });
  const stopForAccount = (kind: string) => {
    if (accountStop !== null) return;
    accountStop = kind;
    stopping = true;
    say(accountStopMessage(kind, "no new task starts, and the running ones are cancelled"));
    for (const r of running) cancel(r);
  };
  const offInterrupt = (deps.onInterrupt ?? defaultOnInterrupt)(() => {
    interrupts += 1;
    stopping = true;
    if (interrupts === 1) {
      say("cancelling the running runs; press Ctrl-C again to quit at once");
      for (const r of running) cancel(r);
    } else {
      abort();
    }
  });
  const workRoot = join(evalDir(o.home), "work", id);
  let closed = false; // after a second Ctrl-C the output is final: a grading still going writes nothing
  const write = (line: GradeLine) => {
    if (closed) return;
    lines.push(line);
    appendFileSync(join(out, "grades.jsonl"), `${JSON.stringify(line)}\n`);
    o.onTask?.(line);
  };
  const blank = (t: EvalTask, infra: string | null, extra: Partial<GradeLine> = {}): GradeLine => ({
    id: t.id,
    track: t.track,
    kind: t.kind,
    size: t.size,
    split: t.split,
    run_id: null,
    submitted: false,
    infra_kind: infra,
    pass: false,
    score: 0,
    f2p_share: t.kind === "repo" ? 0 : null,
    test_tamper: false,
    leak_suspect: false,
    turns: 0,
    subcalls: 0,
    compactions: 0,
    cost_usd: 0,
    cache_hit: null,
    input_tokens: 0,
    cache_read_tokens: 0,
    wall_s: 0,
    grade_error: null,
    env_log: null,
    ...extra,
  });
  const shared = {
    root: o.root,
    ...(o.sub !== undefined ? { sub: o.sub } : {}),
    profile: o.profile,
    ...(o.callFormat !== undefined ? { callFormat: o.callFormat } : {}),
    interactive: false,
    batch: id,
    logDir,
  };
  let browserChecked = false;

  const runOne = async (t: EvalTask): Promise<void> => {
    const grade = o.set.grades.get(t.id)!;
    const failKey = t.kind === "repo" ? (t.venv !== undefined ? `venv:${t.venv}` : `node:${t.node_env}`) : null;
    const pre = failKey === null ? undefined : envFail.get(failKey);
    if (pre !== undefined) return write(blank(t, "host_bug", { grade_error: pre.message, env_log: pre.log }));
    const dir = join(workRoot, t.id);
    const venv = t.kind === "repo" && t.venv !== undefined ? venvs.get(t.venv) : undefined;
    const srcVenv = venv !== undefined && o.set.venvs.get((t as RepoTask).venv!)!.import_root === "src";
    let base = "";
    try {
      let request: StartRun;
      if (t.kind === "read") {
        request = { ...shared, mode: "read", question: t.question, inputs: t.input.map((p) => join(o.set.dir, p)), permissionMode: "accept-edits", tag: t.id };
      } else {
        try {
          base = await makeWorkCopy(o.set, t, dir);
          if (t.track === "web") {
            const ready = tools as Extract<NodeTools, { ok: true }>;
            await installNodeModules(dir, { home: o.home, tools: ready, ...nodeDirs(deps), ...(run ? { run } : {}) });
            const version = o.set.nodeEnvs.get(t.node_env!)!.playwright;
            if (!browserChecked && !browserReady(version, { home: o.home, browsersDir })) {
              say(`installing Chromium for Playwright ${version}`);
              await ensureBrowser(version, { home: o.home, tools: ready, copy: dir, ...nodeDirs(deps), ...(run ? { run } : {}) });
            }
            browserChecked = true;
          }
        } catch (err) {
          const e = err instanceof EnvError ? err : new EnvError(message(err));
          return write(blank(t, "host_bug", { grade_error: e.message, env_log: e.log }));
        }
        if (srcVenv) writeSrcPth(venv!, dir);
        const pnpm = tools?.ok ? tools.pnpm : undefined;
        request = {
          ...shared,
          mode: "repo",
          task: t.task,
          repoPath: dir,
          testHint: fillHint(t.test_hint, { ...(venv ? { python: venv.python } : {}), ...(pnpm ? { pnpm } : {}) }),
          permissionMode: o.set.manifest.permission_mode,
          tag: t.id,
        };
      }
      if (stopping) return write(blank(t, notStarted()));
      let runId: string;
      try {
        ({ run_id: runId } = await session.start(request));
      } catch (err) {
        if (watcher.exit) stopping = true;
        return write(blank(t, watcher.exit ? "other" : "host_bug", { grade_error: `run.start failed: ${message(err)}` }));
      }
      running.add(runId);
      cap.track(runId);
      if (stopping) cancel(runId);
      const f = await Promise.race([watcher.finished(runId), aborted]);
      running.delete(runId);
      cap.untrack(runId);
      if (f === "abort") return;
      if (f === null) {
        stopping = true;
        return write(blank(t, "other", { run_id: runId, grade_error: "the engine exited before the run finished" }));
      }
      const line = await Promise.race([gradeOne(t, grade, f, { dir, base, venv, cappedNow: cap.capped }), aborted]);
      if (line === "abort") return;
      // a first Ctrl-C reaches the test runner too (Windows shares the console), so a failure then is no verdict
      write(interrupts > 0 && line.infra_kind === null && !line.pass ? { ...line, infra_kind: "cancelled" } : line);
      if (line.infra_kind !== null && ACCOUNT.includes(line.infra_kind)) stopForAccount(line.infra_kind);
    } finally {
      if (srcVenv) removeSrcPth(venv!);
      if (t.kind === "repo" && !o.keep) removeQuietly(dir);
    }
  };
  /** The kind of a task that never started: the engine died (transient, D-197), the cap tripped, the account stopped
   *  the eval (its kind, D-257), or Ctrl-C. */
  const notStarted = () => (watcher.exit ? "other" : cap.capped ? "capped" : (accountStop ?? "cancelled"));

  const gradeOne = async (t: EvalTask, grade: AnswerGrade | TestsGrade, f: RunFinishedParams, w: { dir: string; base: string; venv: Venv | undefined; cappedNow: boolean }): Promise<GradeLine> => {
    const record = readRecord(logDir, f.run_id);
    const input = f.usage.root.input_tokens + f.usage.sub.input_tokens;
    const reads = f.usage.root.cache_read_tokens + f.usage.sub.cache_read_tokens;
    let infra = f.infra_error === null ? null : (f.infra_kind ?? "other");
    if (infra === "cancelled" && w.cappedNow) infra = "capped";
    else if (infra === "cancelled" && accountStop !== null && interrupts === 0) infra = accountStop; // cancelled by the stop
    const line = blank(t, infra, {
      run_id: f.run_id,
      submitted: f.submitted,
      turns: f.turns,
      subcalls: f.subcalls,
      compactions: Array.isArray(record?.compactions) ? record.compactions.length : 0,
      cost_usd: f.cost_usd,
      cache_hit: input > 0 ? reads / input : null,
      input_tokens: input,
      cache_read_tokens: reads,
      wall_s: f.wall_s,
    });
    if (infra !== null) return line;
    if (grade.grader === "answer") {
      const s = f.answer === null ? { score: 0 } : scoreAnswer(f.answer, grade.gold, grade.grading);
      return { ...line, score: s.score, pass: readPassed(s.score, grade) };
    }
    const repoTask = t as RepoTask;
    let g;
    try {
      g = await (deps.gradeRepo ?? defaultGradeRepo)(repoTask, grade, {
        dir: w.dir,
        base: w.base,
        set: o.set,
        logDir: join(out, "grade-logs", t.id),
        ...(w.venv ? { python: w.venv.python } : {}),
        ...(tools?.ok ? { pnpm: tools.pnpm } : {}),
        browsersDir,
        ...(backend ? { env: { RLMH_GPU_BACKEND: backend } } : {}),
      });
    } catch (err) {
      // git failing in the copy (a deleted .git, a stale lock), a broken hidden tar: unresolved, and said why
      return { ...line, grade_error: `grading failed: ${message(err)}` };
    }
    return {
      ...line,
      pass: g.resolved,
      score: g.resolved ? 1 : 0,
      f2p_share: g.f2p_share,
      test_tamper: g.test_tamper,
      grade_error: g.grade_error,
      leak_suspect: leakSuspect(record?.messages, { setDir: o.set.dir, grade }),
    };
  };

  // which tasks can't run beside each other: web tasks, kernel tasks, and tasks on one src-layout venv
  const groupsOf = (t: EvalTask): string[] => {
    if (t.kind !== "repo") return [];
    if (t.track === "web") return ["web"];
    const g = t.track === "kernel" ? ["kernel"] : [];
    if (t.venv !== undefined && o.set.venvs.get(t.venv)?.import_root === "src") g.push(`venv:${t.venv}`);
    return g;
  };
  const queue = [...o.tasks];
  const busy = new Set<string>();
  const wakers: (() => void)[] = [];
  const wake = () => {
    for (const w of wakers.splice(0)) w();
  };
  const takeNext = (): EvalTask | undefined => {
    const at = queue.findIndex((t) => groupsOf(t).every((g) => !busy.has(g)));
    if (at < 0) return undefined;
    const [t] = queue.splice(at, 1);
    for (const g of groupsOf(t!)) busy.add(g);
    return t;
  };
  const worker = async (): Promise<void> => {
    while (!stopping && queue.length > 0) {
      const t = takeNext();
      if (t === undefined) {
        await new Promise<void>((r) => wakers.push(r));
        continue;
      }
      try {
        await runOne(t);
      } catch (err) {
        // anything runOne didn't expect stops this task only
        write(blank(t, "host_bug", { grade_error: `the eval failed on this task: ${message(err)}` }));
      } finally {
        for (const g of groupsOf(t)) busy.delete(g);
        wake();
      }
    }
    wake();
  };

  let wasAborted = false;
  try {
    const done = await Promise.race([Promise.all(Array.from({ length: Math.max(1, Math.min(o.jobs, o.tasks.length)) }, worker)), aborted]);
    wasAborted = done === "abort";
    if (!wasAborted) for (const t of queue.splice(0)) write(blank(t, notStarted())); // never started
  } finally {
    // -- after the last grade, even when capped, interrupted or failed: what was spent is always in the ledger --
    closed = true;
    if (wasAborted) killChildren(); // test runners and installs still going
    detach();
    offInterrupt();
    watcher.dispose();
    cap.dispose();
    if (deps.session === undefined) await session.close().catch(() => {});
    if (!o.keep) removeQuietly(workRoot);
    if (o.ledger !== false) {
      appendLedger(o.home, {
        date: now().toISOString(),
        what: "eval",
        set: o.set.manifest.name,
        split: o.split,
        root: `${o.root.provider}/${o.root.model}`,
        profile: o.profile,
        runs: lines.filter((l) => l.run_id !== null).length,
        cost_usd: Math.round(cap.total * 1e6) / 1e6,
        out,
      });
    }
    writeJson(join(out, "eval.json"), { ...evalJson, capped: cap.capped, account_stop: accountStop, cost_usd: Math.round(cap.total * 1e6) / 1e6, finished: now().toISOString() });
    writeReports(out);
  }
  const cost = Math.round(cap.total * 1e6) / 1e6;
  return { id, out, lines, capped: cap.capped, interrupted: interrupts > 0, aborted: wasAborted, cost_usd: cost, gpu_backend: backend, engineExit: watcher.exit, account_stop: accountStop };
}

/** report.json and report.md from readGrades(out). */
export function writeReports(out: string): void {
  const report = buildReport(readGrades(out));
  writeJson(join(out, "report.json"), report);
  writeFileSync(join(out, "report.md"), renderReport(report));
}

function nodeDirs(deps: EvalDeps): { storeDir?: string; browsersDir?: string } {
  return { ...(deps.storeDir !== undefined ? { storeDir: deps.storeDir } : {}), ...(deps.browsersDir !== undefined ? { browsersDir: deps.browsersDir } : {}) };
}
