// KV cache: none
// `rlmh batch TASKS.jsonl` (architecture §7.8, D-26, D-28, D-40): every task is checked before the
// engine starts, then a pool of `--jobs` workers shares one Session. Nobody is asked anything
// (interactive: false, D-15). Exit 0 (no infra_error), 1 (some run had one), 2 (usage), 130 (Ctrl-C).

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRunParams, Session, UsageError, type StartRun } from "../session.ts";
import { loadSettings, type Settings } from "../settings.ts";
import { attachJson, attachPlain, jsonLine } from "./print.ts";
import { message, modelFlags, onInterrupt, openFailed, RunWatcher, type CliIO } from "./run.ts";

const BATCH_OPTIONS = {
  jobs: { type: "string" },
  out: { type: "string" },
  json: { type: "boolean" },
  root: { type: "string" },
  sub: { type: "string" },
  profile: { type: "string" },
  "permission-mode": { type: "string" },
  "call-format": { type: "string" },
  verbose: { type: "boolean" },
} as const;

export const BATCH_USAGE = `Usage: rlmh batch TASKS.jsonl [--jobs N] [--out DIR] [--json]
                  [--root P/M] [--sub P/M] [--profile NAME] [--permission-mode M] [--call-format F] [--verbose]
`;

/** One checked line of the tasks file; paths are absolute. Unknown keys are dropped here. */
interface Task {
  id: string;
  run: Pick<StartRun, "mode" | "question" | "inputs" | "task" | "repoPath" | "testHint">;
}

interface Outcome {
  id: string;
  status: string;
  turns: number;
  subcalls: number;
  cost: number;
  seconds: number;
  failed: boolean;
}

function usage(io: CliIO, text: string): number {
  io.stderr.write(`rlmh batch: ${text}\n${BATCH_USAGE}`);
  return 2;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** D-28: `{id, question, input}` or `{id, task, repo, test_hint?}`, paths relative to the tasks file. */
export function checkTasks(text: string, file: string): { tasks: Task[]; problems: string[] } {
  const base = dirname(resolve(file));
  const tasks: Task[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const where = `${file}:${i + 1}`;
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      problems.push(`${where}: not valid JSON (${message(err)})`);
      return;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      problems.push(`${where}: a task is a JSON object`);
      return;
    }
    const o = obj as Record<string, unknown>;
    const bad = (text: string) => problems.push(`${where}: ${text}`);
    let id: string;
    if (typeof o.id === "string" && o.id !== "") id = o.id;
    else if (Number.isInteger(o.id)) id = String(o.id);
    else return void bad('"id" must be a non-empty string');
    const before = seen.get(id);
    if (before !== undefined) return void bad(`id ${JSON.stringify(id)} is already used on line ${before}`);
    seen.set(id, i + 1);

    const isRead = "question" in o || "input" in o;
    const isRepo = "task" in o || "repo" in o || "test_hint" in o;
    if (isRead && isRepo) return void bad('use "question" and "input" (read mode) or "task" and "repo" (repo mode), not both');
    if (!isRead && !isRepo) return void bad('needs "question" and "input" (read mode), or "task" and "repo" (repo mode)');
    if (isRead) {
      if (typeof o.question !== "string") return void bad('"question" must be a string');
      const given = typeof o.input === "string" ? [o.input] : o.input;
      if (!Array.isArray(given) || given.length === 0 || !given.every((f) => typeof f === "string" && f !== "")) {
        return void bad('"input" must be a path or a non-empty list of paths');
      }
      const inputs = (given as string[]).map((f) => resolve(base, f));
      const missing = inputs.filter((f) => !isFile(f));
      if (missing.length > 0) return void bad(`input file not found: ${missing.join(", ")}`);
      tasks.push({ id, run: { mode: "read", question: o.question, inputs } });
    } else {
      if (typeof o.task !== "string") return void bad('"task" must be a string');
      if (typeof o.repo !== "string" || o.repo === "") return void bad('"repo" must be a folder path');
      if (o.test_hint !== undefined && typeof o.test_hint !== "string") return void bad('"test_hint" must be a string');
      const repoPath = resolve(base, o.repo);
      if (!isDir(repoPath)) return void bad(`repo folder not found: ${repoPath}`);
      tasks.push({ id, run: { mode: "repo", task: o.task, repoPath, ...(typeof o.test_hint === "string" ? { testHint: o.test_hint } : {}) } });
    }
  });
  if (tasks.length === 0 && problems.length === 0) problems.push(`${file}: no tasks`);
  return { tasks, problems };
}

/** D-26: `<stem with [^A-Za-z0-9._-] replaced by _>-<YYYYMMDD-HHMMSS>`, in local time. */
export function batchName(file: string, now: Date = new Date()): string {
  const stem = basename(file, extname(file)).replace(/[^A-Za-z0-9._-]/g, "_");
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  // a leading "." would be refused by the engine's batch-name rule
  return `${stem.replace(/^\./, "_")}-${stamp}`;
}

function outcomeLine(o: Outcome): string {
  return `${o.id}  ${o.status}  ${o.turns}  ${o.subcalls}  $${o.cost.toFixed(4)}  ${o.seconds.toFixed(1)}\n`;
}

export async function batchCommand(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: BATCH_OPTIONS, strict: true, allowPositionals: true });
  } catch (err) {
    return usage(io, message(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return usage(io, positionals.length === 0 ? "name a tasks file" : "give exactly one tasks file");
  const file = positionals[0]!;
  const jobsText = values.jobs ?? "1";
  if (!/^\d+$/.test(jobsText) || Number(jobsText) < 1) return usage(io, `--jobs must be a whole number, 1 or more (got ${JSON.stringify(jobsText)})`);
  const jobs = Number(jobsText);

  // -- pre-flight: nothing starts and nothing is spent until every task checks out --
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return usage(io, `can't read ${file}: ${message(err)}`);
  }
  const { tasks, problems } = checkTasks(text.replace(/^\uFEFF/, ""), file);
  if (problems.length > 0) {
    io.stderr.write(problems.map((p) => `rlmh batch: ${p}\n`).join(""));
    return 2;
  }
  let settings: Settings;
  try {
    settings = loadSettings(io.home);
  } catch (err) {
    io.stderr.write(`rlmh: ${message(err)}\n`);
    return 1;
  }
  const batch = batchName(file);
  const logDir = values.out === undefined ? undefined : resolve(values.out);
  let shared: Omit<StartRun, "mode">;
  try {
    shared = {
      ...modelFlags(values, settings),
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
      ...(values["permission-mode"] !== undefined ? { permissionMode: values["permission-mode"] } : {}),
      ...(values["call-format"] !== undefined ? { callFormat: values["call-format"] } : {}),
      interactive: false,
      batch,
      ...(logDir !== undefined ? { logDir } : {}),
    };
    for (const t of tasks) buildRunParams({ ...shared, ...t.run }, { settings, resolveCallFormat: () => "fenced" });
  } catch (err) {
    if (err instanceof UsageError) return usage(io, err.message);
    throw err;
  }
  if ((shared.permissionMode ?? settings.permissions.mode) === "default" && tasks.some((t) => t.run.mode === "repo")) {
    io.stderr.write(
      "rlmh batch: warning: the permission mode is default and no one can answer a prompt, so every edit will be denied; " +
        "pass --permission-mode accept-edits to let workspace edits through\n",
    );
  }
  if (logDir !== undefined) mkdirSync(logDir, { recursive: true });

  // -- the runs --
  let session: Session;
  try {
    session = await Session.open({ home: io.home, ...(values.verbose ? { verbose: true } : {}), approvals: async () => ({ allow: false, remember_for_run: false }) });
  } catch (err) {
    return openFailed(io, err);
  }
  const watcher = new RunWatcher(session.bus);
  const detach = values.json ? attachJson(session.bus, io.stdout) : attachPlain(session.bus, io.stderr);
  const running = new Set<string>();
  const outcomes: Outcome[] = [];
  let next = 0;
  let stopping = false;
  let interrupts = 0;
  let abort!: () => void;
  const aborted = new Promise<"abort">((resolve) => (abort = () => resolve("abort")));
  const cancel = (id: string) => void session.cancel(id).catch(() => {});
  const offInterrupt = onInterrupt(() => {
    interrupts += 1;
    stopping = true;
    if (interrupts === 1) {
      io.stderr.write("rlmh: cancelling the running runs; press Ctrl-C again to quit at once\n");
      for (const id of running) cancel(id);
    } else {
      abort();
    }
  });
  const record = (o: Outcome) => {
    outcomes.push(o);
    if (!values.json) io.stdout.write(outcomeLine(o));
  };

  const runOne = async (task: Task): Promise<void> => {
    let runId: string;
    try {
      ({ run_id: runId } = await session.start({ ...shared, ...task.run, tag: task.id }));
    } catch (err) {
      io.stderr.write(`rlmh batch: task ${task.id}: ${message(err)}\n`);
      record({ id: task.id, status: "start-error", turns: 0, subcalls: 0, cost: 0, seconds: 0, failed: true });
      if (watcher.exit) stopping = true;
      return;
    }
    running.add(runId);
    if (stopping) cancel(runId);
    const f = await Promise.race([watcher.finished(runId), aborted]);
    running.delete(runId);
    if (f === "abort") return;
    if (f === null) {
      stopping = true;
      record({ id: task.id, status: "engine-exit", turns: 0, subcalls: 0, cost: 0, seconds: 0, failed: true });
      return;
    }
    const status = f.infra_error !== null ? `infra:${f.infra_kind ?? "error"}` : f.submitted ? "submitted" : "no-answer";
    record({ id: task.id, status, turns: f.turns, subcalls: f.subcalls, cost: f.cost_usd, seconds: f.wall_s, failed: f.infra_error !== null });
  };
  const worker = async (): Promise<void> => {
    while (!stopping && next < tasks.length) await runOne(tasks[next++]!);
  };

  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker)), aborted]);
  } finally {
    detach();
    offInterrupt();
    watcher.dispose();
    await session.close();
  }

  if (watcher.exit && outcomes.some((o) => o.status === "engine-exit" || o.status === "start-error")) {
    io.stderr.write(`rlmh: the engine exited (exit code ${watcher.exit.code})\n${watcher.exit.stderr.map((l) => `${l}\n`).join("")}`);
  }
  const failed = outcomes.filter((o) => o.failed).length;
  const cost = Math.round(outcomes.reduce((sum, o) => sum + o.cost, 0) * 1e6) / 1e6;
  if (values.json) {
    io.stdout.write(jsonLine("batch.finished", { runs: outcomes.length, failed, cost_usd: cost }));
  } else {
    const seconds = outcomes.reduce((sum, o) => sum + o.seconds, 0);
    io.stdout.write(`total  ${outcomes.length} runs  ${failed} failed  $${cost.toFixed(4)}  ${seconds.toFixed(1)}\n`);
  }
  if (interrupts > 0) return 130;
  return failed > 0 ? 1 : 0;
}
