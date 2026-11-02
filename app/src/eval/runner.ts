// KV cache: none
// runEval (D-192): the one entry point that runs and grades an eval, for `rlmh eval`, `rlmh tune`
// (step 6) and `/tune` (step 9). It prepares every environment before the first run, probes the GPU
// only when a selected task needs one (D-223), then runs a pool on one Session as `rlmh batch` does:
// nobody is asked anything, and every grade line is written as soon as its run is graded. A CostCap
// stops it at `maxUsd` of billed cost (D-193).

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  makeWorkCopy,
  nodeToolsProblem,
  probeGpu as defaultProbeGpu,
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
export class CostCap {
  total = 0;
  capped = false;
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly off: () => void;

  constructor(
    bus: Bus<AppEvents>,
    private readonly maxUsd: number | null,
    private readonly cancel: (runId: string) => void,
  ) {
    this.off = bus.on("call.end", (c) => {
      this.total += c.usage.cost_usd;
      if (!this.capped && this.maxUsd !== null && this.total > this.maxUsd) {
        this.capped = true;
        for (const id of this.running) this.cancelOnce(id);
      }
    });
  }

  track(runId: string): void {
    this.running.add(runId);
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

/** `<manifest.name>-<split>-<YYYYMMDD-HHMMSS>`, in local time (D-192). It is also the batch name and the work folder. */
export function evalId(set: EvalSet, split: string, now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${set.manifest.name.replace(/[^A-Za-z0-9._-]/g, "_")}-${split}-${stamp}`;
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
}

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

/** Runs and grades `tasks`. Throws GpuMissing or ProbeError before anything is spent. */
export async function runEval(o: EvalOptions, deps: EvalDeps = {}): Promise<EvalResult> {
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
  if (kernels.length > 0 && o.gpu !== "none") {
    const venv = venvs.get(kernels[0]!.venv!);
    if (venv !== undefined) {
      const shimDir = join(evalDir(o.home), "work", `${id}.gpu-shim`);
      let probe;
      try {
        const shim = extractShim(o.set, kernels[0]!, shimDir);
        probe = await (deps.probeGpu ?? defaultProbeGpu)(venv, shim, { ...(o.gpu !== undefined ? { backend: o.gpu } : {}), ...(run ? { run } : {}) });
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
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
  let abort!: () => void;
  const aborted = new Promise<"abort">((r) => (abort = () => r("abort")));
  const cancel = (runId: string) => void session.cancel(runId).catch(() => {});
  const cap = new CostCap(session.bus, o.maxUsd, cancel);
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
  const write = (line: GradeLine) => {
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
      if (stopping) return write(blank(t, cap.capped ? "capped" : "cancelled"));
      let runId: string;
      try {
        ({ run_id: runId } = await session.start(request));
      } catch (err) {
        if (watcher.exit) stopping = true;
        return write(blank(t, "host_bug", { grade_error: `run.start failed: ${message(err)}` }));
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
      write(await gradeOne(t, grade, f, { dir, base, venv, cappedNow: cap.capped }));
    } finally {
      if (srcVenv) removeSrcPth(venv!);
      if (t.kind === "repo" && !o.keep) rmSync(dir, { recursive: true, force: true });
    }
  };

  const gradeOne = async (t: EvalTask, grade: AnswerGrade | TestsGrade, f: RunFinishedParams, w: { dir: string; base: string; venv: Venv | undefined; cappedNow: boolean }): Promise<GradeLine> => {
    const record = readRecord(logDir, f.run_id);
    const input = f.usage.root.input_tokens + f.usage.sub.input_tokens;
    const reads = f.usage.root.cache_read_tokens + f.usage.sub.cache_read_tokens;
    let infra = f.infra_error === null ? null : (f.infra_kind ?? "other");
    if (infra === "cancelled" && w.cappedNow) infra = "capped";
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
    const g = await (deps.gradeRepo ?? defaultGradeRepo)(repoTask, grade, {
      dir: w.dir,
      base: w.base,
      set: o.set,
      logDir: join(out, "grade-logs", t.id),
      ...(w.venv ? { python: w.venv.python } : {}),
      ...(tools?.ok ? { pnpm: tools.pnpm } : {}),
      browsersDir,
      ...(backend ? { env: { RLMH_GPU_BACKEND: backend } } : {}),
    });
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
    if (!wasAborted) for (const t of queue.splice(0)) write(blank(t, cap.capped ? "capped" : "cancelled")); // never started
  } finally {
    detach();
    offInterrupt();
    watcher.dispose();
    cap.dispose();
    if (deps.session === undefined) await session.close();
    if (!o.keep) rmSync(workRoot, { recursive: true, force: true });
  }

  // -- after the last grade, even when capped or interrupted --
  const cost = Math.round(cap.total * 1e6) / 1e6;
  if (o.ledger !== false) {
    appendLedger(o.home, {
      date: now().toISOString(),
      what: "eval",
      set: o.set.manifest.name,
      split: o.split,
      root: `${o.root.provider}/${o.root.model}`,
      profile: o.profile,
      runs: lines.filter((l) => l.run_id !== null).length,
      cost_usd: cost,
      out,
    });
  }
  writeJson(join(out, "eval.json"), { ...evalJson, capped: cap.capped, cost_usd: cost, finished: now().toISOString() });
  writeReports(out);
  return { id, out, lines, capped: cap.capped, interrupted: interrupts > 0, aborted: wasAborted, cost_usd: cost, gpu_backend: backend, engineExit: watcher.exit };
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
