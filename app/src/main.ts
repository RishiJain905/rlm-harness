#!/usr/bin/env bun
// KV cache: none
// rlmh: argv dispatch (architecture §10). Exit 0 is success, 1 a runtime failure, 2 a usage error,
// 130 Ctrl-C (D-40, D-50).

import { batchCommand } from "./cli/batch.ts";
import { configCommand } from "./cli/config.ts";
import { runCommand, type CliIO } from "./cli/run.ts";
import { fetchInfo, findEngine, startEngine, type EngineProcess } from "./engine.ts";
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
  rlmh config      list, get KEY, or set KEY VALUE in settings.toml
  rlmh info        start the engine and print its info as JSON
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

export async function main(argv: string[]): Promise<number> {
  const verbose = argv.includes("--verbose");
  const args = argv.filter((a) => a !== "--verbose");
  if (args.length === 0) return interactive();
  const [command, ...rest] = args;
  // run, batch and config parse their own flags, --verbose included, so a value like `--question --verbose` survives
  const at = argv.indexOf(command!);
  const own = [...(argv.slice(0, at).includes("--verbose") ? ["--verbose"] : []), ...argv.slice(at + 1)];
  if (command === "run") return runCommand(own, processIO());
  if (command === "batch") return batchCommand(own, processIO());
  if (command === "config") return configCommand(own, processIO());
  if (command === "--version" && rest.length === 0) {
    await out(`rlmh ${APP_VERSION}\n`);
    return 0;
  }
  if (command === "--help" && rest.length === 0) {
    await out(USAGE);
    return 0;
  }
  if (command === "info" && rest.length === 0) return info(verbose);
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
