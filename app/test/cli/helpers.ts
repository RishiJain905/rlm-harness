// KV cache: none
// Shared setup for the CLI tests: a temp home, a fake-provider script (§7.5), a clean child env with
// no key-like variables, and `rlmh(...)`, which runs `process.execPath src/main.ts …` and collects
// its exit code and output. The engine is the source checkout's (`uv run --project engine …`).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const APP = resolve(import.meta.dir, "..", "..");
export const MAIN = join(APP, "src", "main.ts");
/** A first `uv run` may fetch Python. */
export const REAL = 120_000;

const KEY_LIKE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

export interface Temp {
  dir: string;
  home: string;
  file(name: string, text: string): string;
  script(script: object): string;
  cleanup(): void;
}

export function temp(prefix = "rlmh-cli-"): Temp {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const home = join(dir, "home");
  return {
    dir,
    home,
    file(name, text) {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    },
    script(script) {
      return this.file("script.json", JSON.stringify(script));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** process.env without key-like names or rlmh's own variables, plus `extra`. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || KEY_LIKE.test(name) || name.startsWith("RLMH_")) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs rlmh from source with piped stdio (so no TTY) and waits for it to exit on its own. */
export async function rlmh(args: string[], opts: { home: string; script?: string; cwd?: string; env?: Record<string, string> }): Promise<Ran> {
  const proc = Bun.spawn({
    cmd: [process.execPath, MAIN, ...args],
    cwd: opts.cwd ?? APP,
    env: cleanEnv({ RLMH_HOME: opts.home, ...(opts.script ? { RLMH_FAKE_SCRIPT: opts.script } : {}), ...opts.env }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** Every stdout line parsed; throws on a line that is not JSON. */
export function jsonLines(stdout: string): any[] {
  const lines = stdout.split("\n");
  if (lines.pop() !== "") throw new Error("stdout does not end with a newline");
  return lines.map((l) => JSON.parse(l));
}

/** §5.3 params plus run_id, by event; and the gateway.call line (§7.8). */
export const EVENT_KEYS: Record<string, string[]> = {
  "run.started": ["run_id", "tag", "mode", "profile", "prompt_hash", "profile_hash", "contract_hash", "call_format", "root", "sub", "permission_mode", "workspace", "input", "limits", "log_path"],
  "run.reply": ["run_id", "turn", "text", "tool_call", "reasoning", "finish_reason", "usage", "seconds"],
  "run.cell": ["run_id", "turn", "code", "output", "error", "observation", "seconds", "restarted", "crash", "repo_changed"],
  "run.subcall": ["run_id", "subcall_id", "origin", "batch", "prompt_chars", "status", "error", "seconds"],
  "run.permission": ["run_id", "turn", "kind", "detail", "allowed", "asked", "remembered"],
  "run.budget": ["run_id", "turns_left", "subcalls_left"],
  "run.finished": ["run_id", "tag", "answer", "submitted", "answer_valid", "turns", "subcalls", "usage", "cost_usd", "infra_error", "infra_kind", "wall_s", "log_path"],
  "gateway.call": ["run_id", "role", "subcall_id", "model", "usage", "seconds", "error"],
};

/** The run-log record's top-level keys (§7.8), read mode. The engine's `runlog.RECORD_KEYS` can't be imported here. */
export const RECORD_KEYS = [
  "format", "run_id", "tag", "batch", "harness_version", "protocol", "contract", "contract_hash", "prompt_hash", "profile",
  "profile_hash", "mode", "call_format", "root", "sub", "permission_mode", "limits", "started_at", "wall_s", "question",
  "input", "workspace", "base_tree", "messages", "turns", "subcalls", "fetches", "permissions", "submitted", "answer",
  "answer_valid", "usage", "cost_usd", "cache", "timeouts", "crashes", "restarts", "diff", "infra_error", "infra_kind",
  "host_traceback",
];

export function sorted(keys: Iterable<string>): string[] {
  return [...keys].sort();
}

export function lastRecord(path: string): Promise<any> {
  return Bun.file(path)
    .text()
    .then((t) => JSON.parse(t.trimEnd().split("\n").pop()!));
}
