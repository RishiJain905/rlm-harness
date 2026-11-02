#!/usr/bin/env bun
// KV cache: none
// rlmh: argv dispatch (architecture §10). Exit 0 is success, 1 a runtime failure, 2 a usage error,
// 130 Ctrl-C (D-40, D-50).

import { parseArgs } from "node:util";
import { batchCommand, preflightBatch } from "./cli/batch.ts";
import { configCommand } from "./cli/config.ts";
import { evalCommand, preflightEval } from "./cli/eval.ts";
import { preflightRun, runCommand, type CliIO } from "./cli/run.ts";
import { ensureEngine, runSetup } from "./cli/setup.ts";
import { isCompiledBinary, runUpdate, sweepOldBinaries, type UpdateOptions } from "./cli/update.ts";
import { EngineNotFound, fetchInfo, findEngine, startEngine, type EngineProcess } from "./engine.ts";
import { RpcError } from "./link.ts";
import { home } from "./paths.ts";
import type { Session as SessionType } from "./session.ts";
import { ErrorCode } from "./protocol.ts";
import { APP_VERSION, PROTOCOL_VERSION } from "./version.ts";

const INFO_TIMEOUT_MS = 120_000; // a first `uv run` may fetch Python
const EXIT_WAIT_MS = 3_000;

const USAGE = `Usage: rlmh [command] [options]

Commands:
  rlmh             open the interactive app
  rlmh run         one run: --question Q --input FILE..., or --task T --repo DIR [--test-hint CMD]
  rlmh batch       every task in a TASKS.jsonl file: rlmh batch TASKS.jsonl [--jobs N] [--out DIR]
  rlmh eval        run an eval set and grade it: rlmh eval SET [--split S] [--only IDS] [--go] [--max-usd X]
  rlmh eval report OUT      rebuild report.json and report.md of an eval output
  rlmh eval compare A B     pair two eval outputs task by task
  rlmh eval ledger          what every --go has spent, against the $30 cap
  rlmh config      list, get KEY, or set KEY VALUE in settings.toml
  rlmh info        start the engine and print its info as JSON
  rlmh setup       install Python 3.12 (through uv, after asking) and the engine: [--yes|-y] [--force]
  rlmh update      replace an installed rlmh with the latest release: [--check] [--version X] [--yes|-y]
  rlmh --version   print the version
  rlmh --help      show this help

Options for run and batch:
  --root P/M             root model, such as anthropic/claude-sonnet-5 (default: root.model)
  --sub P/M              sub-call model (default: sub.model, else the root model)
  --profile NAME         prompt profile (default: profile)
  --permission-mode M    default, accept-edits or bypass (default: permissions.mode)
  --call-format F        auto, fenced or native (default: call_format)
  --json                 one JSON object per line on stdout, everything else on stderr

Options:
  --verbose        show the engine's stderr
`;

async function out(text: string): Promise<void> {
  await Bun.write(Bun.stdout, text);
}

async function err(text: string): Promise<void> {
  await Bun.write(Bun.stderr, text);
}

/** Waits for `p` at most `ms`; the timer never outlives it, so it can't hold the process open. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The engine check before info, run, batch and the interactive app (step 10): plain text on stderr,
 * before Ink starts. Returns an exit code when the command must not run.
 */
async function engineReady(): Promise<number | null> {
  try {
    await ensureEngine({
      home: home(),
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      out: (line) => void process.stderr.write(`${line}\n`),
    });
    return null;
  } catch (e) {
    if (!(e instanceof EngineNotFound)) throw e;
    if (!e.reported) await err(`rlmh: ${e.message}\n`);
    return 1;
  }
}

const UPDATE_OPTIONS = { version: { type: "string" }, yes: { type: "boolean", short: "y" }, check: { type: "boolean" } } as const;

async function update(args: string[], io: CliIO, seams: Partial<UpdateOptions> = {}): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args, options: UPDATE_OPTIONS, strict: true, allowPositionals: false }));
  } catch (e) {
    io.stderr.write(`rlmh update: ${e instanceof Error ? e.message : String(e)}\nUsage: rlmh update [--check] [--version X] [--yes|-y]\n`);
    return 2;
  }
  return runUpdate({
    home: io.home,
    ...(values.version !== undefined ? { version: values.version } : {}),
    yes: values.yes === true,
    check: values.check === true,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (line) => void io.stdout.write(`${line}\n`),
    err: (line) => void io.stderr.write(`${line}\n`),
    ...seams,
  });
}

async function setup(args: string[]): Promise<number> {
  const unknown = args.find((a) => !["--yes", "-y", "--force"].includes(a));
  if (unknown !== undefined) {
    await err(`rlmh: unknown argument "${unknown}" for setup. Try "rlmh --help".\n`);
    return 2;
  }
  return runSetup({
    home: home(),
    yes: args.includes("--yes") || args.includes("-y"),
    force: args.includes("--force"),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
}

/** The real process streams, for run, batch and config. */
function processIO(): CliIO {
  return {
    stdout: { write: (chunk) => void process.stdout.write(chunk) },
    stderr: { write: (chunk) => void process.stderr.write(chunk) },
    stdin: process.stdin,
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    home: home(),
  };
}

/** Replaceable parts of main, for tests. */
export interface MainDeps {
  /** The engine check that may offer to install Python; run and batch call it only after their arguments and inputs check out. */
  engineReady?: () => Promise<number | null>;
  /** The streams and home of run, batch, config and update. */
  io?: CliIO;
  /** Seams of `rlmh update` (network, installer, platform), for tests. */
  update?: Partial<UpdateOptions>;
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  // an installed Windows rlmh: what the last update left beside the running binary (rlmh.exe.old) goes now, if nothing holds it
  if (process.platform === "win32" && isCompiledBinary()) sweepOldBinaries(process.execPath);
  const verbose = argv.includes("--verbose");
  const args = argv.filter((a) => a !== "--verbose");
  if (args.length === 0) return interactive();
  const [command, ...rest] = args;
  // run, batch and config parse their own flags, --verbose included, so a value like `--question --verbose` survives
  const at = argv.indexOf(command!);
  const own = [...(argv.slice(0, at).includes("--verbose") ? ["--verbose"] : []), ...argv.slice(at + 1)];
  const io = deps.io ?? processIO();
  if (command === "run" || command === "batch") {
    // everything that can be wrong with the arguments or the inputs is said before setup offers to download anything
    const refused = command === "run" ? preflightRun(own, io) : preflightBatch(own, io);
    if (refused !== null) return refused;
    const stop = await (deps.engineReady ?? engineReady)();
    if (stop !== null) return stop;
    return command === "run" ? runCommand(own, io) : batchCommand(own, io);
  }
  if (command === "eval") {
    // as for batch: the set, the selection and the models are checked before setup may offer a download;
    // report, compare and ledger start no engine
    const refused = await preflightEval(own, io);
    if (refused !== null) return refused;
    const sub = own.find((a) => !a.startsWith("-"));
    if (sub !== "report" && sub !== "compare" && sub !== "ledger") {
      const stop = await (deps.engineReady ?? engineReady)();
      if (stop !== null) return stop;
    }
    return evalCommand(own, io);
  }
  if (command === "config") return configCommand(own, io);
  if (command === "setup") return setup(own.filter((a) => a !== "--verbose"));
  if (command === "update") return update(own.filter((a) => a !== "--verbose"), io, deps.update);
  if (command === "--version" && rest.length === 0) {
    await out(`rlmh ${APP_VERSION}\n`);
    return 0;
  }
  if (command === "--help" && rest.length === 0) {
    await out(USAGE);
    return 0;
  }
  if (command === "info" && rest.length === 0) return (await engineReady()) ?? info(verbose);
  const what = ["--version", "--help", "info"].includes(command!) ? `argument "${rest[0]}"` : `command "${command}"`;
  await err(`rlmh: unknown ${what}. Try "rlmh --help".\n`);
  return 2;
}

async function interactive(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // D-50. On Windows, Git Bash's default window (mintty) is not a console, so stdin is a pipe there.
    const mintty = process.platform === "win32" ? " Use Windows Terminal or PowerShell, or `winpty rlmh`." : "";
    await err(`rlmh needs an interactive terminal; use \`rlmh run\` for scripts.${mintty}\n`);
    return 1;
  }
  const stop = await engineReady();
  if (stop !== null) return stop;
  const { ApprovalQueue } = await import("./interface/approvals.ts");
  const { Session } = await import("./session.ts");
  const queue = new ApprovalQueue();
  let session: SessionType;
  try {
    // verbose stays off: engine stderr would be written over the screen; the engine-exit panel shows its tail
    session = await Session.open({ home: home(), verbose: false, approvals: (p) => queue.ask(p) });
  } catch (e) {
    const tail = e instanceof Error && "stderr" in e && Array.isArray(e.stderr) ? (e.stderr as string[]) : [];
    await err(`rlmh: ${e instanceof Error ? e.message : String(e)}\n${tail.map((line) => `${line}\n`).join("")}`);
    return 1;
  }
  let last: { run_id: string; log_path: string } | undefined;
  session.bus.on("engine.event", (e) => {
    if (e.method === "run.started" || e.method === "run.finished") last = { run_id: e.params.run_id, log_path: e.params.log_path };
  });
  const { runApp } = await import("./interface/App.tsx");
  await runApp({ session, keys: session.keys, catalog: session.catalog, approvals: queue, home: home(), cwd: process.cwd() });
  queue.denyAll();
  await session.close();
  if (last) await out(`Last run: ${last.run_id}  ${last.log_path}\n`);
  return 0;
}

async function info(verbose: boolean): Promise<number> {
  let engine: EngineProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    engine = startEngine(findEngine({ home: home() }), {
      onStderr: verbose ? (line) => process.stderr.write(`${line}\n`) : undefined,
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the engine did not answer engine.info within ${INFO_TIMEOUT_MS / 1000} s`)), INFO_TIMEOUT_MS);
    });
    const engineInfo = await Promise.race([fetchInfo(engine.link), timeout]);
    await out(`${JSON.stringify({ app: { version: APP_VERSION, protocol: PROTOCOL_VERSION }, engine: engineInfo }, null, 2)}\n`);
    return 0;
  } catch (e) {
    // EngineNotFound, ProtocolMismatch, a spawn failure or the timeout: one line, then the engine's stderr
    let message = e instanceof Error ? e.message : String(e);
    if (e instanceof RpcError && e.code === ErrorCode.CANCELLED && engine) {
      message = `the engine exited before answering (exit code ${await engine.exited})`;
    }
    const tail = engine ? engine.stderrTail() : [];
    await err(`rlmh: ${message}\n${tail.map((line) => `${line}\n`).join("")}`);
    return 1;
  } finally {
    clearTimeout(timer);
    if (engine) {
      engine.kill();
      await within(engine.exited, EXIT_WAIT_MS);
    }
  }
}

if (import.meta.main) {
  // Set the code and let the process end, so nothing written to a pipe is cut short (Windows can
  // truncate it on process.exit). On a terminal nothing can be lost, and exiting at once also ends
  // a TTY stdin that Ink or a prompt left open.
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  if (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) process.exit(code);
}
