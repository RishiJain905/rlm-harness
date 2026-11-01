// KV cache: none
// engine.ts: discovery, the child env, and the real engine through `uv run` (120 s each,
// because a first `uv run` may fetch Python). RLMH_HOME is a temp folder throughout.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EngineNotFound,
  ProtocolMismatch,
  STDERR_LINE_MAX,
  fetchInfo,
  findEngine,
  readLines,
  splitCommand,
  startEngine,
  stripKeys,
  type EngineProcess,
} from "../src/engine.ts";
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
    env: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-FAKE",
      github_token: "FAKE",
      MY_SECRET: "FAKE",
      OPENAI_CUSTOM_HEADERS: "Authorization: Bearer FAKE",
      ANTHROPIC_CUSTOM_HEADERS: "x-api-key: FAKE",
      x_extra_headers: "FAKE",
      RLMH_HOME: "/elsewhere",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "FAKE",
      GIT_CONFIG_GLOBAL: "/etc/gitconfig-test",
    },
  });
  // git's env config goes as a whole (D-62): a partial set makes git refuse to run
  for (const name of [
    "OPENAI_API_KEY",
    "github_token",
    "MY_SECRET",
    "OPENAI_CUSTOM_HEADERS", // the SDKs merge these into every request, so they can hold an authorization line
    "ANTHROPIC_CUSTOM_HEADERS",
    "x_extra_headers",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ])
    expect(cmd.env[name]).toBeUndefined();
  expect(cmd.env.GIT_CONFIG_GLOBAL).toBe("/etc/gitconfig-test");
  expect(cmd.env.PATH).toBe("/usr/bin");
  expect(cmd.env.RLMH_HOME).toBe(home);
  expect(cmd.env.PYTHONUTF8).toBe("1");
  expect(cmd.env.PYTHONUNBUFFERED).toBe("1");
});

test("strip_keys_header_variables", () => {
  const out = stripKeys({ OPENAI_CUSTOM_HEADERS: "a", ANTHROPIC_CUSTOM_HEADERS: "b", custom_headers: "c", HEADER: "kept", PATH: "/bin", UNSET: undefined });
  expect(out).toEqual({ HEADER: "kept", PATH: "/bin" });
});

/** A fake engine that answers every request with the names of the variables in its environment. */
function envEngine(): string {
  return [
    "const NL = String.fromCharCode(10); const decoder = new TextDecoder(); let buf = '';",
    "for await (const chunk of Bun.stdin.stream()) {",
    "  buf += decoder.decode(chunk, { stream: true }); let nl;",
    "  while ((nl = buf.indexOf(NL)) >= 0) {",
    "    const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: Object.keys(process.env) }) + NL);",
    "  }",
    "}",
  ].join(" ");
}

test(
  "start_engine_strips_header_variables_from_the_process_env",
  async () => {
    // the second hop: startEngine merges process.env under cmd.env and strips again, so nothing a caller forgot gets through
    const planted = { OPENAI_CUSTOM_HEADERS: "Authorization: Bearer FAKE", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: FAKE", RLMH_TEST_PLAIN: "kept" };
    Object.assign(process.env, planted);
    try {
      const engine = startEngine({ cmd: [process.execPath, "-e", envEngine()], cwd: process.cwd(), env: { RLMH_TEST_EXTRA_HEADERS: "FAKE" } });
      const names = await engine.link.request<string[]>("env", {});
      engine.kill();
      await within(engine.exited, 10_000);
      expect(names).toContain("RLMH_TEST_PLAIN");
      for (const name of ["OPENAI_CUSTOM_HEADERS", "ANTHROPIC_CUSTOM_HEADERS", "RLMH_TEST_EXTRA_HEADERS"]) expect(names).not.toContain(name);
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name];
    }
  },
  REAL,
);

describe("readLines", () => {
  const encoder = new TextEncoder();
  const streamOf = (...chunks: (string | Uint8Array)[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        c.close();
      },
    });
  async function linesOf(...chunks: (string | Uint8Array)[]): Promise<string[]> {
    const out: string[] = [];
    await readLines(streamOf(...chunks), (l) => out.push(l));
    return out;
  }

  test("lines_split_across_chunks_and_crlf", async () => {
    expect(await linesOf("one\r\ntw", "o\nthr", "ee")).toEqual(["one", "two", "three"]);
    expect(await linesOf("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(await linesOf("")).toEqual([]);
    const bytes = encoder.encode("café 😀\n");
    const cut = bytes.indexOf(0xf0) + 2; // inside the emoji
    expect(await linesOf(bytes.slice(0, cut), bytes.slice(cut))).toEqual(["café 😀"]);
  });

  test("a_line_is_held_to_its_cap", async () => {
    // 20 MiB with no newline, in 64 KiB chunks, then a normal line: only the cap is ever kept
    const out: string[] = [];
    const chunk = encoder.encode("x".repeat(64 * 1024));
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        if (pulled <= 320) c.enqueue(chunk);
        else {
          c.enqueue(encoder.encode("\nnext line\n"));
          c.close();
        }
      },
    });
    await readLines(source, (l) => out.push(l));
    expect(out).toHaveLength(2);
    expect(out[0]!.length).toBeLessThan(STDERR_LINE_MAX + 100);
    expect(out[0]!.startsWith("x".repeat(STDERR_LINE_MAX))).toBe(true);
    expect(out[0]).toContain(`[line cut at ${STDERR_LINE_MAX} characters]`);
    expect(out[1]).toBe("next line");
  });

  test("a_cut_line_skips_to_its_newline_even_across_chunks", async () => {
    const out: string[] = [];
    await readLines(streamOf("a".repeat(30), "b".repeat(30), "tail of the long line\nkept\n"), (l) => out.push(l), 40);
    expect(out).toEqual([`${"a".repeat(30)}${"b".repeat(10)} [line cut at 40 characters]`, "kept"]);
    // an unterminated oversized line at EOF is cut once and not repeated
    const eof: string[] = [];
    await readLines(streamOf("c".repeat(100)), (l) => eof.push(l), 40);
    expect(eof).toEqual([`${"c".repeat(40)} [line cut at 40 characters]`]);
  });

  test("a_cut_never_leaves_half_a_surrogate_pair", async () => {
    const out: string[] = [];
    await readLines(streamOf("😀".repeat(10)), (l) => out.push(l), 5); // 5 units: two emoji and half of a third
    expect(out).toEqual([`${"😀".repeat(2)} [line cut at 5 characters]`]);
  });

  test("a_line_of_exactly_the_cap_is_kept_whole", async () => {
    expect(await linesOf("y".repeat(STDERR_LINE_MAX), "\n")).toEqual(["y".repeat(STDERR_LINE_MAX)]);
  });
});

describe.skipIf(process.platform === "win32")("forced cleanup on POSIX (process groups)", () => {
  const alive = (pid: number): boolean => {
    // a killed process can stay a zombie until its parent reaps it: that is dead too
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
    return stat !== "" && !stat.startsWith("Z");
  };
  const waitFor = async (fn: () => boolean, ms = 5000): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (fn()) return true;
    return fn();
  };
  async function childPid(file: string): Promise<number> {
    expect(await waitFor(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"))).toBe(true);
    return Number(readFileSync(file, "utf8").trim());
  }

  test("an unresponsive launcher's child dies with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rlmh-group-"));
    const pidFile = join(dir, "child.pid");
    // a launcher that ignores TERM and a closed stdin, and a child it never forwards anything to
    const script = `trap '' TERM HUP INT; sleep 600 & echo $! > '${pidFile}'; wait`;
    const engine = startEngine({ cmd: ["sh", "-c", script], cwd: dir, env: { PATH: process.env.PATH ?? "" } }, { killGraceMs: 200 });
    let pid = 0;
    try {
      pid = await childPid(pidFile);
      expect(alive(pid)).toBe(true);
      engine.kill();
      await within(engine.exited, 10_000);
      expect(await waitFor(() => !alive(pid))).toBe(true);
    } finally {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("what a launcher that already exited left behind is swept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rlmh-group-"));
    const pidFile = join(dir, "child.pid");
    const engine = startEngine({ cmd: ["sh", "-c", `sleep 600 & echo $! > '${pidFile}'`], cwd: dir, env: { PATH: process.env.PATH ?? "" } });
    let pid = 0;
    try {
      pid = await childPid(pidFile);
      expect(await within(engine.exited, 10_000)).toBe(0); // the launcher left at once
      expect(await waitFor(() => !alive(pid))).toBe(true);
    } finally {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/** Writes <home>/engine/<APP_VERSION>/ with a marker naming `python`, and __main__.py unless `main` is false. */
function installAt(h: string, python: string, main = true): string {
  const dir = join(h, "engine", APP_VERSION);
  mkdirSync(join(dir, "rlm_engine"), { recursive: true });
  if (main) writeFileSync(join(dir, "rlm_engine", "__main__.py"), "");
  const marker = { app_version: APP_VERSION, bundle_sha256: "0", python, python_version: "3.12.0", installed_at: "" };
  writeFileSync(join(dir, ".installed.json"), JSON.stringify(marker));
  return dir;
}

describe("installed engine (step 10)", () => {
  const compiled = "/$bunfs/root"; // a compiled binary's folder: no source checkout

  test("installed_mode_command", () => {
    const h = mkdtempSync(join(tmpdir(), "rlmh-installed-"));
    try {
      const dir = installAt(h, process.execPath);
      const cmd = findEngine({ home: h, env: { PATH: "/bin" }, sourceDir: compiled });
      expect(cmd.cmd).toEqual([process.execPath, "-E", "-s", "-X", "utf8", "-m", "rlm_engine", "serve"]);
      expect(cmd.cwd).toBe(dir);
      expect(cmd.env.RLMH_HOME).toBe(h);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("installed_mode_incomplete", () => {
    for (const [python, main] of [[join(tmpdir(), "no-such-python"), true], [process.execPath, false]] as const) {
      const h = mkdtempSync(join(tmpdir(), "rlmh-installed-"));
      try {
        installAt(h, python, main);
        expect(() => findEngine({ home: h, env: { PATH: "/bin" }, sourceDir: compiled })).toThrow(EngineNotFound);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    }
    const broken = mkdtempSync(join(tmpdir(), "rlmh-installed-"));
    try {
      mkdirSync(join(broken, "engine", APP_VERSION), { recursive: true });
      writeFileSync(join(broken, "engine", APP_VERSION, ".installed.json"), "{not json");
      expect(() => findEngine({ home: broken, env: { PATH: "/bin" }, sourceDir: compiled })).toThrow(EngineNotFound);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test("installed_mode_order", () => {
    const h = mkdtempSync(join(tmpdir(), "rlmh-installed-"));
    try {
      installAt(h, process.execPath);
      expect(findEngine({ home: h, env: { PATH: "/bin", RLMH_ENGINE: "my-engine serve" }, sourceDir: compiled }).cmd).toEqual([
        "my-engine",
        "serve",
      ]);
      // from source the checkout wins
      expect(findEngine({ home: h, env: { PATH: "/bin" } }).cmd[0]).toBe("uv");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
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
