// KV cache: none
// `rlmh run` (architecture §7.8): one run from a terminal or a script. Plain mode puts progress on
// stderr and only the answer on stdout; `--json` puts the event lines on stdout and everything else
// on stderr. Exit 0, 1 (infra_error, or the engine died), 2 (usage) or 130 (Ctrl-C) (D-50).

import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import type { Bus } from "../bus.ts";
import type { AppEvents } from "../gateway/gateway.ts";
import { parseModelRef } from "../gateway/providers.ts";
import { RpcError } from "../link.ts";
import { ErrorCode, type ApprovalParams, type ApprovalResult, type ModelRef, type RunFinishedParams } from "../protocol.ts";
import { buildRunParams, EngineStartError, Session, thinkingOf, UsageError, type StartRun } from "../session.ts";
import { loadSettings, type Settings } from "../settings.ts";
import { attachJson, attachPlain, type LineSink } from "./print.ts";

export interface CliIO {
  stdout: LineSink;
  stderr: LineSink;
  stdin: NodeJS.ReadableStream;
  /** stdin and stderr are both terminals: someone can answer a prompt. */
  isTTY: boolean;
  home: string;
}

export type Approver = ((p: ApprovalParams) => Promise<ApprovalResult>) & {
  /** Ctrl-C: deny the prompt on screen. False when none is. */
  interrupt(): boolean;
  /** Stop reading stdin; later prompts are denied. */
  close(): void;
};

const DENY: ApprovalResult = { allow: false, remember_for_run: false };
const ENGINE_EXIT_WAIT_MS = 2_000;

/** Codes from run.start that mean the user asked for something wrong. */
const USAGE_CODES: readonly number[] = [ErrorCode.UNKNOWN_PROFILE, ErrorCode.BAD_INPUT, ErrorCode.INVALID_PARAMS];

const RUN_OPTIONS = {
  question: { type: "string" },
  input: { type: "string", multiple: true },
  task: { type: "string" },
  repo: { type: "string" },
  "test-hint": { type: "string" },
  root: { type: "string" },
  sub: { type: "string" },
  profile: { type: "string" },
  "permission-mode": { type: "string" },
  "call-format": { type: "string" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
} as const;

export const RUN_USAGE = `Usage: rlmh run (--question Q --input FILE... | --task T --repo DIR [--test-hint CMD])
                [--root P/M] [--sub P/M] [--profile NAME] [--permission-mode M] [--call-format F] [--json] [--verbose]
`;

/**
 * Asks on the terminal, one prompt at a time (D-15). `y` allows, `a` allows for the run, and
 * anything else, EOF or Ctrl-C denies. Without a TTY it denies without asking.
 */
export function createTtyApprover(io: CliIO): Approver {
  let rl: Interface | undefined;
  let ended = false;
  const lines: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const wake = (line: string | null) => {
    const w = waiting;
    waiting = undefined;
    w?.(line);
  };
  const reader = () => {
    if (rl || ended) return;
    rl = createInterface({ input: io.stdin, terminal: false, crlfDelay: Infinity });
    rl.on("line", (line) => (waiting ? wake(line) : lines.push(line)));
    rl.on("close", () => {
      ended = true;
      wake(null);
    });
  };
  const nextLine = (): Promise<string | null> => {
    if (lines.length > 0) return Promise.resolve(lines.shift()!);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => (waiting = resolve));
  };
  const ask = async (p: ApprovalParams): Promise<ApprovalResult> => {
    const where = p.inside_workspace ? "inside" : "outside";
    io.stderr.write(`[permission] ${p.kind}: ${p.detail} (${where} the workspace)\nAllow? [y]es / [a]llow for this run / [N]o: `);
    reader();
    const line = await nextLine();
    if (line === null) io.stderr.write("\n");
    const answer = (line ?? "").trim().toLowerCase();
    if (answer === "y" || answer === "yes") return { allow: true, remember_for_run: false };
    if (answer === "a") return { allow: true, remember_for_run: true };
    return DENY;
  };

  const approver = ((p: ApprovalParams): Promise<ApprovalResult> => {
    if (!io.isTTY) return Promise.resolve(DENY);
    const answer = queue.then(() => ask(p));
    queue = answer.catch(() => {});
    return answer;
  }) as Approver;
  approver.interrupt = () => {
    if (!waiting) return false;
    io.stderr.write("\n");
    wake(null);
    return true;
  };
  approver.close = () => {
    ended = true;
    wake(null);
    if (rl) {
      rl.close();
      io.stdin.pause();
    }
  };
  return approver;
}

/** Keeps every run.finished by run_id from the moment it is made, so a finish that beats the start result is kept. */
export class RunWatcher {
  /** Set once the engine has exited. */
  exit: AppEvents["engine.exit"] | undefined;
  readonly exited: Promise<AppEvents["engine.exit"]>;
  private readonly done = new Map<string, RunFinishedParams>();
  private readonly waiters = new Map<string, (p: RunFinishedParams | null) => void>();
  private readonly offs: (() => void)[];

  constructor(bus: Bus<AppEvents>) {
    let onExit!: (e: AppEvents["engine.exit"]) => void;
    this.exited = new Promise((resolve) => (onExit = resolve));
    this.offs = [
      bus.on("engine.event", (e) => {
        if (e.method !== "run.finished") return;
        const p = e.params as RunFinishedParams;
        this.done.set(p.run_id, p);
        this.waiters.get(p.run_id)?.(p);
      }),
      bus.on("engine.exit", (e) => {
        this.exit = e;
        onExit(e);
        for (const w of [...this.waiters.values()]) w(null);
      }),
    ];
  }

  /** The run's run.finished, or null when the engine exits first. */
  finished(runId: string): Promise<RunFinishedParams | null> {
    const f = this.done.get(runId);
    if (f) return Promise.resolve(f);
    if (this.exit) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.set(runId, (p) => {
        this.waiters.delete(runId);
        resolve(p);
      });
    });
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}

/** Ctrl-C handling for a command; returns the remover. */
export function onInterrupt(fn: () => void): () => void {
  process.on("SIGINT", fn);
  return () => {
    process.off("SIGINT", fn);
  };
}

/** `--root` and `--sub`, each with its role's thinking setting. Throws UsageError. */
export function modelFlags(values: { root?: string; sub?: string }, settings: Settings): { root?: ModelRef; sub?: ModelRef } {
  const out: { root?: ModelRef; sub?: ModelRef } = {};
  for (const role of ["root", "sub"] as const) {
    const v = values[role];
    if (v === undefined) continue;
    try {
      out[role] = parseModelRef(v, thinkingOf(settings, role));
    } catch (err) {
      throw new UsageError(`--${role}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The engine's last stderr lines after a one-line message. */
export function engineDied(io: CliIO, text: string, stderr: string[]): void {
  io.stderr.write(`rlmh: ${text}\n${stderr.map((l) => `${l}\n`).join("")}`);
}

/** Session.open's failures: one line, plus the engine's stderr when it has some. */
export function openFailed(io: CliIO, err: unknown): number {
  engineDied(io, message(err), err instanceof EngineStartError ? err.stderr : []);
  return 1;
}

async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function usage(io: CliIO, text: string): number {
  io.stderr.write(`rlmh run: ${text}\n${RUN_USAGE}`);
  return 2;
}

export async function runCommand(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: RUN_OPTIONS, strict: true, allowPositionals: false });
  } catch (err) {
    return usage(io, message(err));
  }
  const { values } = parsed;
  const read = values.question !== undefined || values.input !== undefined;
  const repo = values.task !== undefined || values.repo !== undefined || values["test-hint"] !== undefined;
  if (read && repo) return usage(io, "use --question and --input (read mode) or --task and --repo (repo mode), not both");
  if (!read && !repo) return usage(io, "give --question Q --input FILE (read mode), or --task T --repo DIR (repo mode)");
  if (read && values.question === undefined) return usage(io, "--input needs --question");
  if (read && (values.input ?? []).length === 0) return usage(io, "--question needs at least one --input FILE");
  if (repo && values.task === undefined) return usage(io, "--repo needs --task");
  if (repo && values.repo === undefined) return usage(io, "--task needs --repo DIR");

  let settings: Settings;
  try {
    settings = loadSettings(io.home);
  } catch (err) {
    io.stderr.write(`rlmh: ${message(err)}\n`);
    return 1;
  }
  let request: StartRun;
  try {
    request = {
      mode: read ? "read" : "repo",
      ...(read ? { question: values.question, inputs: values.input } : { task: values.task, repoPath: values.repo }),
      ...(values["test-hint"] !== undefined ? { testHint: values["test-hint"] } : {}),
      ...modelFlags(values, settings),
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
      ...(values["permission-mode"] !== undefined ? { permissionMode: values["permission-mode"] } : {}),
      ...(values["call-format"] !== undefined ? { callFormat: values["call-format"] } : {}),
      interactive: io.isTTY,
      batch: "cli",
    };
    // every usage error before the engine starts; Session.start resolves the real call format
    buildRunParams(request, { settings, resolveCallFormat: () => "fenced" });
  } catch (err) {
    if (err instanceof UsageError) return usage(io, err.message);
    throw err;
  }

  const approvals = createTtyApprover(io);
  let session: Session;
  try {
    session = await Session.open({ home: io.home, ...(values.verbose ? { verbose: true } : {}), approvals });
  } catch (err) {
    approvals.close();
    return openFailed(io, err);
  }

  const watcher = new RunWatcher(session.bus);
  const detach = values.json ? attachJson(session.bus, io.stdout) : attachPlain(session.bus, io.stderr);
  let runId: string | undefined;
  let interrupts = 0;
  let abort!: () => void;
  const aborted = new Promise<"abort">((resolve) => (abort = () => resolve("abort")));
  const cancel = (id: string) => void session.cancel(id).catch(() => {});
  const offInterrupt = onInterrupt(() => {
    if (approvals.interrupt()) return; // Ctrl-C at a prompt denies it
    interrupts += 1;
    if (interrupts === 1) {
      io.stderr.write("rlmh: cancelling the run; press Ctrl-C again to quit at once\n");
      if (runId !== undefined) cancel(runId);
    } else {
      abort();
    }
  });

  try {
    let started: { run_id: string; log_path: string } | "abort";
    try {
      started = await Promise.race([session.start(request), aborted]);
    } catch (err) {
      if (err instanceof UsageError) return usage(io, err.message);
      if (err instanceof RpcError && USAGE_CODES.includes(err.code)) {
        io.stderr.write(`rlmh run: ${err.message}\n`);
        return 2;
      }
      if (err instanceof RpcError && err.code === ErrorCode.CANCELLED) {
        const exit = await within(watcher.exited, ENGINE_EXIT_WAIT_MS);
        if (exit) {
          engineDied(io, `the engine exited (exit code ${exit.code}) before the run started`, exit.stderr);
          return interrupts > 0 ? 130 : 1;
        }
      }
      io.stderr.write(`rlmh: ${message(err)}\n`);
      return 1;
    }
    if (started === "abort") return 130;
    runId = started.run_id;
    if (interrupts > 0) cancel(runId);

    const finished = await Promise.race([watcher.finished(runId), aborted]);
    if (finished === "abort") return 130;
    if (finished === null) {
      if (interrupts > 0) return 130;
      const exit = watcher.exit!;
      engineDied(io, `the engine exited (exit code ${exit.code}) before the run finished`, exit.stderr);
      return 1;
    }
    detach(); // run.finished is the last --json line
    if (!values.json && finished.answer !== null && finished.answer !== undefined) {
      const { answer } = finished;
      io.stdout.write(`${typeof answer === "string" ? answer : JSON.stringify(answer)}\n`);
    }
    if (interrupts > 0) return 130;
    return finished.infra_error === null ? 0 : 1;
  } finally {
    detach();
    offInterrupt();
    watcher.dispose();
    approvals.close();
    await session.close();
  }
}
