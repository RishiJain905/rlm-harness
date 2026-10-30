// KV cache: none
// Finds and starts the Python engine (architecture §7.1, D-18) and checks its protocol (D-36).

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Link } from "./link.ts";
import type { EngineInfo } from "./protocol.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export interface EngineCommand {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface EngineProcess {
  link: Link;
  exited: Promise<number>;
  stderrTail(n?: number): string[];
  kill(): void;
}

export class EngineNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineNotFound";
  }
}

export class ProtocolMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolMismatch";
  }
}

/** Names of variables that could hold a key; neither the engine nor the worker ever sees them (D-29). */
const KEY_LIKE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
const STDERR_RING = 200;
const KILL_GRACE_MS = 2000;
const STDOUT_GRACE_MS = 1000;

/** Split a command line on whitespace. "…" and '…' group; backslashes are plain characters. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote !== null) throw new Error(`RLMH_ENGINE has an unbalanced ${quote} quote: ${line}`);
  if (inWord) out.push(word);
  return out;
}

/** The given env minus key-like names. */
function stripKeys(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !KEY_LIKE.test(name)) out[name] = value;
  }
  return out;
}

/**
 * D-18: RLMH_ENGINE, then a source checkout, then the installed engine (step 10).
 * `sourceDir` replaces import.meta.dir, for tests.
 */
export function findEngine(opts: { home: string; env?: Record<string, string | undefined>; sourceDir?: string }): EngineCommand {
  const given = opts.env ?? process.env;
  const env = { ...stripKeys(given), RLMH_HOME: opts.home, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };
  const override = given.RLMH_ENGINE ?? "";
  if (override.trim() !== "") {
    let cmd = splitCommand(override);
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd[0]!)) cmd = ["cmd", "/c", ...cmd];
    return { cmd, cwd: process.cwd(), env };
  }
  const root = sourceRoot(opts.sourceDir ?? import.meta.dir);
  if (root !== null) {
    return {
      cmd: ["uv", "run", "--project", join(root, "engine"), "python", "-X", "utf8", "-m", "rlm_engine", "serve"],
      cwd: root,
      env,
    };
  }
  const installed = findInstalledEngine(opts.home);
  if (installed !== null) return installed;
  throw new EngineNotFound(
    "no engine found: set RLMH_ENGINE to an engine command, or run `rlmh setup` to install one",
  );
}

/** The checkout root when running from source: two levels above app/src, holding engine/pyproject.toml. */
function sourceRoot(dir: string): string | null {
  if (dir.includes("$bunfs") || dir.includes("~BUN")) return null; // a compiled binary's virtual folder
  const root = resolve(dir, "..", "..");
  return existsSync(join(root, "engine", "pyproject.toml")) ? root : null;
}

// step 10: read <home>/engine/<version>/.installed.json and return its command.
function findInstalledEngine(_home: string): EngineCommand | null {
  return null;
}

/** Start the engine with all three stdio piped. Its env is cmd.env merged over process.env, key-like names stripped again. */
export function startEngine(cmd: EngineCommand, opts: { onStderr?: (line: string) => void } = {}): EngineProcess {
  const proc = Bun.spawn({
    cmd: cmd.cmd,
    cwd: cmd.cwd,
    env: stripKeys({ ...process.env, ...cmd.env }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const link = new Link(proc.stdout, {
    write: async (chunk) => {
      proc.stdin.write(chunk);
      await proc.stdin.flush();
    },
  });
  const tail: string[] = [];
  readLines(proc.stderr, (line) => {
    tail.push(line);
    if (tail.length > STDERR_RING) tail.shift();
    opts.onStderr?.(line);
  }).catch(() => {});
  const exited = proc.exited.then(async (code) => {
    // stdout may still hold the engine's last answer: let the link read to EOF first
    await Promise.race([link.closed, Bun.sleep(STDOUT_GRACE_MS)]);
    link.close();
    return code;
  });
  let killing = false;
  return {
    link,
    exited,
    stderrTail: (n = 50) => tail.slice(-n),
    kill() {
      if (killing) return;
      killing = true;
      try {
        Promise.resolve(proc.stdin.end()).catch(() => {}); // the engine's normal way out
      } catch {
        // already closed
      }
      const timer = setTimeout(() => killTree(proc), KILL_GRACE_MS);
      void exited.then(() => clearTimeout(timer));
    },
  };
}

function killTree(proc: { pid: number; kill(): void }): void {
  if (process.platform === "win32") {
    // uv.exe then python.exe: kill the whole tree
    Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  } else {
    proc.kill();
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) onLine(buf.replace(/\r$/, ""));
}

/** engine.info, refusing an engine that speaks another protocol (D-36). */
export async function fetchInfo(link: Link): Promise<EngineInfo> {
  const info = await link.request<EngineInfo>("engine.info", {});
  if (info.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolMismatch(`engine speaks protocol ${info.protocol}, this rlmh speaks ${PROTOCOL_VERSION}`);
  }
  return info;
}
