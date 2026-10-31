// KV cache: none
// engine.ts: discovery, the child env, and the real engine through `uv run` (120 s each,
// because a first `uv run` may fetch Python). RLMH_HOME is a temp folder throughout.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineNotFound, ProtocolMismatch, fetchInfo, findEngine, splitCommand, startEngine, type EngineProcess } from "../src/engine.ts";
import { RpcError } from "../src/link.ts";
import type { ModelCompleteParams, ModelCompleteResult } from "../src/protocol.ts";
import { APP_VERSION } from "../src/version.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const REAL = 120_000;
/** S-14: the engine's copy of prompt v4 and its `training-v4` profile both hash to this. */
const TRAINING_HASH = "a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "rlmh-engine-"));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The source-checkout engine, whatever RLMH_ENGINE the test runner has. */
function realEngine(extra: Record<string, string> = {}, onStderr?: (line: string) => void): EngineProcess {
  return startEngine(findEngine({ home, env: { ...process.env, RLMH_ENGINE: undefined, ...extra } }), { onStderr });
}

function result(text: string): ModelCompleteResult {
  return {
    text,
    tool_call: null,
    reasoning: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 },
    finish_reason: "stop",
    served_model: "roundtrip",
    seconds: 0,
  };
}

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (err) {
    return err as RpcError;
  }
  throw new Error("expected a rejection");
}

async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A fake engine for `process.execPath -e`: answers each request with an engine.info result
 * speaking `protocol`, and exits right after its first answer when `exitAfter` is set. One line
 * with no double quotes or backslashes, so Windows argv quoting can't mangle it.
 */
function fakeEngine(protocol: number, exitAfter: boolean): string {
  return [
    "const NL = String.fromCharCode(10); const decoder = new TextDecoder(); let buf = '';",
    "for await (const chunk of Bun.stdin.stream()) {",
    "  buf += decoder.decode(chunk, { stream: true }); let nl;",
    "  while ((nl = buf.indexOf(NL)) >= 0) {",
    "    const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);",
    `    const info = { version: '0.1.0', protocol: ${protocol}, python: '3.12.0', contract: null, contract_hash: null, training_hash: null, profiles: [] };`,
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: info }) + NL);",
    exitAfter ? "    process.exit(0);" : "",
    "  }",
    "}",
  ].join(" ");
}

test("split_command", () => {
  expect(splitCommand(`uv run "a b" 'c d' e`)).toEqual(["uv", "run", "a b", "c d", "e"]);
  expect(splitCommand(`"C:\\Program Files\\Python\\python.exe" -X utf8 -m rlm_engine serve`)).toEqual([
    "C:\\Program Files\\Python\\python.exe",
    "-X",
    "utf8",
    "-m",
    "rlm_engine",
    "serve",
  ]);
  expect(splitCommand(`say 'it"s'`)).toEqual(["say", 'it"s']);
  expect(splitCommand(`a "" b`)).toEqual(["a", "", "b"]);
  expect(splitCommand("")).toEqual([]);
  expect(splitCommand("   ")).toEqual([]);
  expect(() => splitCommand(`uv "run`)).toThrow(/RLMH_ENGINE/);
  expect(() => splitCommand(`uv 'run`)).toThrow(/RLMH_ENGINE/);
});

test("discovery_order", () => {
  const override = findEngine({ home, env: { PATH: "/bin", RLMH_ENGINE: 'python -X utf8 -m rlm_engine serve' } });
  expect(override.cmd).toEqual(["python", "-X", "utf8", "-m", "rlm_engine", "serve"]);
  expect(override.cwd).toBe(process.cwd());

  const checkout = findEngine({ home, env: { PATH: "/bin", RLMH_ENGINE: "" } });
  expect(checkout.cmd).toEqual(["uv", "run", "--project", join(ROOT, "engine"), "python", "-X", "utf8", "-m", "rlm_engine", "serve"]);
  expect(checkout.cwd).toBe(ROOT);

  for (const sourceDir of ["/$bunfs/root", "B:\\~BUN\\root", join(home, "app", "src")]) {
    let caught: unknown;
    try {
      findEngine({ home, env: { PATH: "/bin" }, sourceDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineNotFound);
    expect((caught as Error).message).toContain("RLMH_ENGINE");
    expect((caught as Error).message).toContain("rlmh setup");
  }
});

test("child_env", () => {
  const cmd = findEngine({
    home,
    env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-FAKE", github_token: "FAKE", MY_SECRET: "FAKE", RLMH_HOME: "/elsewhere" },
  });
  for (const name of ["OPENAI_API_KEY", "github_token", "MY_SECRET"]) expect(cmd.env[name]).toBeUndefined();
  expect(cmd.env.PATH).toBe("/usr/bin");
  expect(cmd.env.RLMH_HOME).toBe(home);
  expect(cmd.env.PYTHONUTF8).toBe("1");
  expect(cmd.env.PYTHONUNBUFFERED).toBe("1");
});

test(
  "real_engine_info",
  async () => {
    const engine = realEngine();
    const info = await fetchInfo(engine.link);
    expect(info.version).toBe(APP_VERSION);
    expect(info.protocol).toBe(1);
    expect(info.python).toMatch(/^3\.12\./);
    expect(info.contract).toBe("v4");
    expect(info.contract_hash).toBe(TRAINING_HASH);
    expect(info.training_hash).toBe(TRAINING_HASH);
    expect(info.profiles.map((p) => [p.name, p.source])).toEqual([
      ["default", "builtin"],
      ["training-v4", "builtin"],
    ]);
    expect(info.profiles[1]?.prompt_hash).toBe(TRAINING_HASH);
    engine.kill();
    expect(await within(engine.exited, 10_000)).toBe(0);
  },
  REAL,
);

describe("real engine with RLMH_DEBUG=1", () => {
  let engine: EngineProcess;
  let complete: (p: ModelCompleteParams) => Promise<ModelCompleteResult>;

  beforeAll(() => {
    engine = realEngine({ RLMH_DEBUG: "1" });
    engine.link.handle("model.complete", (p) => complete(p));
  });
  afterAll(async () => {
    engine.kill();
    await engine.exited;
  });

  test(
    "real_engine_roundtrip",
    async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let arrived!: () => void;
      const first = new Promise<void>((resolve) => (arrived = resolve));
      complete = async (p) => {
        arrived();
        await gate;
        await Bun.sleep(Math.random() * 20);
        return result(p.messages[0]!.content.replace("ping", "pong"));
      };
      const roundtrip = engine.link.request<{ texts: string[] }>("debug.roundtrip", { count: 20 });
      await first;
      expect((await fetchInfo(engine.link)).protocol).toBe(1); // answered while 20 calls are held
      release();
      expect((await roundtrip).texts).toEqual(Array.from({ length: 20 }, (_, i) => `pong ${i}`));
    },
    REAL,
  );

  test(
    "model_error_passthrough",
    async () => {
      const data = { kind: "rate_limit", provider: "debug", model: "roundtrip", status: 429, message: "slow down" };
      complete = async (p) => {
        if (p.messages[0]!.content === "ping 1") throw new RpcError(-32001, "slow down", data);
        return result("pong");
      };
      const err = await rejection(engine.link.request("debug.roundtrip", { count: 3 }));
      expect(err).toBeInstanceOf(RpcError);
      expect(err.code).toBe(-32001);
      expect((err.data as { kind: string }).kind).toBe("rate_limit");
    },
    REAL,
  );

  test(
    "versions_agree",
    async () => {
      const pkg = await Bun.file(join(ROOT, "app", "package.json")).json();
      const pyproject = Bun.TOML.parse(await Bun.file(join(ROOT, "engine", "pyproject.toml")).text()) as { project: { version: string } };
      expect(pkg.version).toBe(APP_VERSION);
      expect(pyproject.project.version).toBe(APP_VERSION);
      expect((await fetchInfo(engine.link)).version).toBe(APP_VERSION);
    },
    REAL,
  );
});

test(
  "stderr_and_exit",
  async () => {
    const lines: string[] = [];
    const engine = realEngine({ RLMH_DEBUG: "1" }, (line) => lines.push(line));
    let arrived!: () => void;
    const held = new Promise<void>((resolve) => (arrived = resolve));
    engine.link.handle("model.complete", () => {
      arrived();
      return new Promise(() => {}); // never answered
    });
    const pending = engine.link.request("debug.roundtrip", { count: 1 });
    await held;
    for (let i = 0; i < 500 && !lines.some((l) => l.includes("serving")); i++) await Bun.sleep(10);
    expect(lines.some((l) => l.includes("rlm_engine") && l.includes("serving"))).toBe(true);
    expect(engine.stderrTail().some((l) => l.includes("serving"))).toBe(true);
    engine.kill();
    expect((await rejection(pending)).code).toBe(-32800);
    expect(await within(engine.exited, 10_000)).toBe(0);
  },
  REAL,
);

test(
  "protocol_mismatch",
  async () => {
    const engine = startEngine({ cmd: [process.execPath, "-e", fakeEngine(2, false)], cwd: process.cwd(), env: {} });
    let caught: unknown;
    try {
      await fetchInfo(engine.link);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProtocolMismatch);
    expect((caught as Error).message).toBe("engine speaks protocol 2, this rlmh speaks 1");
    engine.kill();
    await within(engine.exited, 10_000);
  },
  REAL,
);

test(
  "answer_before_exit",
  async () => {
    // an engine that answers and exits at once: its last answer must still arrive
    for (let i = 0; i < 5; i++) {
      const engine = startEngine({ cmd: [process.execPath, "-e", fakeEngine(1, true)], cwd: process.cwd(), env: {} });
      expect((await fetchInfo(engine.link)).protocol).toBe(1);
      expect(await within(engine.exited, 10_000)).toBe(0);
    }
  },
  REAL,
);
