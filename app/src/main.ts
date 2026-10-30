#!/usr/bin/env bun
// KV cache: none
// rlmh: argv dispatch (architecture §10). Exit 0 is success, 1 a runtime failure, 2 a usage error (D-40).

import { fetchInfo, findEngine, startEngine, type EngineProcess } from "./engine.ts";
import { RpcError } from "./link.ts";
import { home } from "./paths.ts";
import { ErrorCode } from "./protocol.ts";
import { APP_VERSION, PROTOCOL_VERSION } from "./version.ts";

const INFO_TIMEOUT_MS = 120_000; // a first `uv run` may fetch Python
const EXIT_WAIT_MS = 3_000;

const USAGE = `Usage: rlmh [command] [options]

Commands:
  rlmh             open the interactive app
  rlmh info        start the engine and print its info as JSON
  rlmh --version   print the version
  rlmh --help      show this help

Options:
  --verbose        show the engine's stderr
`;

async function out(text: string): Promise<void> {
  await Bun.write(Bun.stdout, text);
}

async function err(text: string): Promise<void> {
  await Bun.write(Bun.stderr, text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv: string[]): Promise<number> {
  const verbose = argv.includes("--verbose");
  const args = argv.filter((a) => a !== "--verbose");
  if (args.length === 0) return interactive();
  const [command, ...rest] = args;
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
    await err(`rlmh: the interactive app needs a terminal. Try "rlmh --help".\n`);
    return 1;
  }
  const { runApp } = await import("./interface/App.tsx");
  await runApp();
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
      await Promise.race([engine.exited, sleep(EXIT_WAIT_MS)]);
    }
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
