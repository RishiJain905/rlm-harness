// KV cache: none
// Finds and starts the Python engine (architecture §7.1, D-18) and checks its protocol (D-36).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Link } from "./link.ts";
import { engineDir } from "./paths.ts";
import type { EngineInfo } from "./protocol.ts";
import { APP_VERSION, PROTOCOL_VERSION } from "./version.ts";

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

/** `<home>/engine/<version>/.installed.json`, written last by `rlmh setup` (architecture §9). */
export interface Installed {
  app_version: string;
  bundle_sha256: string;
  python: string;
  python_version: string;
  installed_at: string;
}

export class EngineNotFound extends Error {
  /** True when `rlmh setup` already printed why, so the caller adds nothing. */
  readonly reported: boolean;
  constructor(message: string, opts: { reported?: boolean } = {}) {
    super(message);
    this.name = "EngineNotFound";
    this.reported = opts.reported ?? false;
  }
}

export class ProtocolMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolMismatch";
  }
}

/**
 * Names of variables that could hold a key; neither the engine nor the worker ever sees them (D-29).
 * HEADERS catches OPENAI_CUSTOM_HEADERS and ANTHROPIC_CUSTOM_HEADERS, which the SDKs read and which
 * carry whole header lines, authorization included.
 */
const KEY_LIKE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|HEADERS/i;
/** Git's environment config goes as a whole: KEY_LIKE matches its key names, git refuses a partial set, and its values can hold credentials (D-62). */
const GIT_ENV_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i;
const STDERR_RING = 200;
/** The longest stderr line kept, in characters; the rest of a longer line is dropped (a line is buffered up to this, never more). */
export const STDERR_LINE_MAX = 16 * 1024;
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

/** The given env minus key-like names and git's env config. */
export function stripKeys(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !KEY_LIKE.test(name) && !GIT_ENV_CONFIG.test(name)) out[name] = value;
  }
  return out;
}

/** The env every engine command carries: key-like names stripped, RLMH_HOME set, UTF-8 and unbuffered. */
export function engineEnv(home: string, given: Record<string, string | undefined>): Record<string, string> {
  return { ...stripKeys(given), RLMH_HOME: home, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };
}

/**
 * D-18: RLMH_ENGINE, then a source checkout, then the installed engine (step 10).
 * `sourceDir` replaces import.meta.dir, for tests.
 */
export function findEngine(opts: { home: string; env?: Record<string, string | undefined>; sourceDir?: string }): EngineCommand {
  const given = opts.env ?? process.env;
  const env = engineEnv(opts.home, given);
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
  const installed = installedEngine(opts.home, env);
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

/** The marker in an engine folder, or null when it is missing or unreadable. */
export function readInstalled(dir: string): Installed | null {
  try {
    const marker = JSON.parse(readFileSync(join(dir, ".installed.json"), "utf8"));
    return typeof marker?.python === "string" && marker.python !== "" ? (marker as Installed) : null;
  } catch {
    return null;
  }
}

/**
 * Item 3: this version's installed engine, when its marker parses and both its Python and
 * rlm_engine/__main__.py exist. -E ignores PYTHON* variables, so -X utf8 decides UTF-8 mode (D-42);
 * there is no -I, so -m finds the package through the cwd.
 */
export function installedEngine(home: string, env: Record<string, string>): EngineCommand | null {
  const dir = engineDir(APP_VERSION, home);
  const marker = readInstalled(dir);
  if (marker === null || !existsSync(marker.python) || !existsSync(join(dir, "rlm_engine", "__main__.py"))) return null;
  return { cmd: [marker.python, "-E", "-s", "-X", "utf8", "-m", "rlm_engine", "serve"], cwd: dir, env };
}

/**
 * Start the engine with all three stdio piped. Its env is cmd.env merged over process.env, key-like names stripped again.
 * On POSIX it starts as the leader of its own session and process group, so a forced stop reaches a launcher's
 * children too (uv, a wrapper script) and not just the launcher; Windows uses taskkill /T. `killGraceMs` is how
 * long kill() waits for the engine to leave after closing its stdin.
 */
export function startEngine(cmd: EngineCommand, opts: { onStderr?: (line: string) => void; killGraceMs?: number } = {}): EngineProcess {
  const group = process.platform !== "win32";
  const proc = Bun.spawn({
    cmd: cmd.cmd,
    cwd: cmd.cwd,
    env: stripKeys({ ...process.env, ...cmd.env }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: group, // POSIX: setsid(), so the pid is also the process group id
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
    if (group) killGroup(proc.pid); // whatever the launcher left in its group
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
      const timer = setTimeout(() => killTree(proc, group), opts.killGraceMs ?? KILL_GRACE_MS);
      void exited.then(() => clearTimeout(timer));
    },
  };
}

/** Forced stop. POSIX: SIGKILL to the engine's whole process group. Windows: the launcher and its tree (uv.exe, then python.exe). */
function killTree(proc: { pid: number; kill(): void }, group: boolean): void {
  if (process.platform === "win32") {
    Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  if (group) killGroup(proc.pid);
  try {
    proc.kill();
  } catch {
    // already gone
  }
}

/** SIGKILL to process group `pgid` (a negative pid). No group left is no error. */
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ESRCH: nothing is left in the group
  }
}

/**
 * Calls `onLine` for each line of `stream` (LF or CRLF). A line is held in memory only up to `maxLine`
 * characters: a longer one is cut there with a marker and the rest of it is skipped to its newline, so
 * the engine's stderr can never grow the buffer without bound.
 */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, maxLine = STDERR_LINE_MAX): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  let skipping = false; // inside the rest of a line that was cut
  const cut = (): string => {
    let kept = buf.slice(0, maxLine);
    if (/[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1); // not half a surrogate pair
    return `${kept} [line cut at ${maxLine} characters]`;
  };
  const feed = (text: string): void => {
    let start = 0;
    while (start < text.length) {
      const nl = text.indexOf("\n", start);
      const end = nl < 0 ? text.length : nl;
      if (!skipping) {
        buf += text.slice(start, end);
        if (buf.length > maxLine) {
          onLine(cut());
          buf = "";
          skipping = true;
        }
      }
      if (nl < 0) return;
      if (skipping) skipping = false;
      else onLine(buf.replace(/\r$/, ""));
      buf = "";
      start = nl + 1;
    }
  };
  for await (const chunk of stream) feed(decoder.decode(chunk, { stream: true }));
  feed(decoder.decode());
  if (buf && !skipping) onLine(buf.replace(/\r$/, ""));
}

/** engine.info, refusing an engine that speaks another protocol (D-36). */
export async function fetchInfo(link: Link): Promise<EngineInfo> {
  const info = await link.request<EngineInfo>("engine.info", {});
  if (info.protocol !== PROTOCOL_VERSION) {
    throw new ProtocolMismatch(`engine speaks protocol ${info.protocol}, this rlmh speaks ${PROTOCOL_VERSION}`);
  }
  return info;
}
