// KV cache: none
// session.ts: the buildRunParams table (pure), a protocol mismatch refused, and runs on the real
// engine (source checkout) with the scripted fake provider. RLMH_HOME is a temp folder throughout.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProtocolMismatch } from "../src/engine.ts";
import type { ApprovalParams, ApprovalResult, ModelRef, RunFinishedParams } from "../src/protocol.ts";
import { buildRunParams, Session, thinkingOf, UsageError, type StartRun } from "../src/session.ts";
import { defaultSettings, setSetting, type Settings } from "../src/settings.ts";
import { rig, type Rig } from "./gateway/helpers.ts";

const REAL = 120_000;
const FAKE: ModelRef = { provider: "fake", model: "scripted", thinking: null };

function settingsWith(values: Record<string, string>): Settings {
  let s = defaultSettings();
  for (const [k, v] of Object.entries(values)) s = setSetting(s, k, v);
  return s;
}

describe("buildRunParams", () => {
  let gw: Rig;
  beforeAll(async () => {
    gw = await rig();
  });
  afterAll(() => gw.cleanup());
  const build = (r: StartRun, values: Record<string, string> = {}) =>
    buildRunParams(r, { settings: settingsWith(values), resolveCallFormat: (ref, s) => gw.gateway.resolveCallFormat(ref, s) });
  const readRun: StartRun = { mode: "read", question: "Q?", inputs: ["a.txt", "/abs/b.txt"], interactive: false };

  test("defaults come from settings", () => {
    expect(build(readRun, { "root.model": "fake/scripted" })).toEqual({
      mode: "read",
      question: "Q?",
      inputs: [resolve("a.txt"), resolve("/abs/b.txt")],
      profile: "default",
      root: FAKE,
      sub: FAKE,
      permission_mode: "accept-edits", // S-27
      call_format: "native", // auto: fake/scripted is an API model with tool calls
      interactive: false,
    });
  });

  test("settings other than the defaults", () => {
    const p = build(readRun, {
      "root.model": "fake/scripted",
      "sub.model": "openai/gpt-x",
      "root.thinking": "high",
      "sub.thinking": "low",
      profile: "training-v4",
      "permissions.mode": "bypass",
      call_format: "fenced",
    });
    expect(p.root).toEqual({ provider: "fake", model: "scripted", thinking: "high" });
    expect(p.sub).toEqual({ provider: "openai", model: "gpt-x", thinking: "low" });
    expect(p.profile).toBe("training-v4");
    expect(p.permission_mode).toBe("bypass");
    expect(p.call_format).toBe("fenced");
  });

  test("overrides win over settings", () => {
    const root = { provider: "anthropic", model: "claude-x", thinking: "medium" as const };
    const sub = { provider: "fake", model: "scripted", thinking: null };
    const p = build(
      { ...readRun, root, sub, profile: "mine", permissionMode: "default", callFormat: "fenced", interactive: true, tag: "t1", batch: "b1", logDir: "out" },
      { "root.model": "openai/gpt-x", "permissions.mode": "bypass" },
    );
    expect(p).toMatchObject({ root, sub, profile: "mine", permission_mode: "default", call_format: "fenced", interactive: true, tag: "t1", batch: "b1", log_dir: resolve("out") });
  });

  test("default thinking is null; an empty sub.model is the root's model with the sub thinking", () => {
    expect(thinkingOf(settingsWith({}), "root")).toBeNull();
    expect(thinkingOf(settingsWith({ "sub.thinking": "low" }), "sub")).toBe("low");
    const p = build(readRun, { "root.model": "fake/scripted", "root.thinking": "high" });
    expect(p.root.thinking).toBe("high");
    expect(p.sub).toEqual({ provider: "fake", model: "scripted", thinking: null });
    const q = build({ ...readRun, root: { provider: "local", model: "qwen", thinking: "off" } }, { "sub.thinking": "medium" });
    expect(q.sub).toEqual({ provider: "local", model: "qwen", thinking: "medium" });
  });

  test("auto is native for fake/scripted and fenced for local", () => {
    expect(build(readRun, { "root.model": "fake/scripted" }).call_format).toBe("native");
    expect(build(readRun, { "root.model": "local/qwen" }).call_format).toBe("fenced");
    expect(build({ ...readRun, callFormat: "native" }, { "root.model": "local/qwen" }).call_format).toBe("native");
  });

  test("repo mode; relative paths become absolute", () => {
    const p = build({ mode: "repo", task: "Fix it", repoPath: "repo", testHint: "make test", interactive: false }, { "root.model": "fake/scripted" });
    expect(p).toMatchObject({ mode: "repo", task: "Fix it", repo_path: resolve("repo"), test_hint: "make test" });
    expect(p.question).toBeUndefined();
    expect(p.inputs).toBeUndefined();
  });

  test("no root model is a UsageError naming --root and rlmh config set root.model", () => {
    let caught: unknown;
    try {
      build(readRun);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toContain("--root");
    expect((caught as Error).message).toContain("rlmh config set root.model");
  });

  test("bad enums are UsageErrors", () => {
    expect(() => build({ ...readRun, root: FAKE, permissionMode: "yolo" })).toThrow(UsageError);
    expect(() => build({ ...readRun, root: FAKE, callFormat: "xml" })).toThrow(UsageError);
  });
});

/** process.env changes for one block; Session.open and the gateway read process.env. */
function withEnv(values: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test(
  "a protocol mismatch is refused and the engine is killed",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rlmh-mismatch-"));
    const marker = join(dir, "stdin-closed");
    const engine = join(dir, "engine.js");
    writeFileSync(
      engine,
      [
        "const decoder = new TextDecoder(); let buf = '';",
        "for await (const chunk of Bun.stdin.stream()) {",
        "  buf += decoder.decode(chunk, { stream: true }); let nl;",
        "  while ((nl = buf.indexOf('\\n')) >= 0) {",
        "    const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);",
        "    const info = { version: '0.1.0', protocol: 2, python: '3.12.0', contract: null, contract_hash: null, training_hash: null, profiles: [] };",
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: info }) + '\\n');",
        "  }",
        "}",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`,
      ].join("\n"),
    );
    const restore = withEnv({ RLMH_ENGINE: `"${process.execPath}" "${engine}"` });
    try {
      let caught: unknown;
      try {
        await Session.open({ home: join(dir, "home"), approvals: async () => ({ allow: false, remember_for_run: false }) });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProtocolMismatch);
      expect((caught as Error).message).toBe("engine speaks protocol 2, this rlmh speaks 1");
      expect(existsSync(marker)).toBe(true); // the engine was told to go before open gave up
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  REAL,
);

describe("with the real engine and the fake provider", () => {
  let dir: string;
  let session: Session;
  let restore: () => void;
  let approvals: (p: ApprovalParams) => Promise<ApprovalResult>;
  const events: { method: string; params: any }[] = [];
  const exits: { code: number }[] = [];
  let question: string;

  function script(s: object): void {
    const file = join(dir, `script-${events.length}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(s));
    process.env.RLMH_FAKE_SCRIPT = file;
  }

  function finished(runId: string): Promise<RunFinishedParams> {
    return new Promise((resolve) => {
      const check = () => {
        const f = events.find((e) => e.method === "run.finished" && e.params.run_id === runId);
        if (f) {
          off();
          resolve(f.params);
        }
      };
      const off = session.bus.on("engine.event", () => queueMicrotask(check));
      check();
    });
  }

  const readRun = (over: Partial<StartRun> = {}): StartRun => ({ mode: "read", question: "Q?", inputs: [question], root: FAKE, interactive: false, ...over });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "rlmh-session-"));
    question = join(dir, "q.txt");
    writeFileSync(question, "some context\n");
    restore = withEnv({ RLMH_ENGINE: undefined, RLMH_FAKE_SCRIPT: undefined });
    session = await Session.open({ home: join(dir, "home"), approvals: (p) => approvals(p) });
    session.bus.on("engine.event", (e) => events.push(e));
    session.bus.on("engine.exit", (e) => exits.push(e));
  }, REAL);

  afterAll(async () => {
    await session.close();
    restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test(
    "a read run, run.started to run.finished on the bus",
    async () => {
      expect((await session.info()).protocol).toBe(1);
      script({ root: [{ text: "", tool_call: { code: "submit('42')" } }] });
      const { run_id, log_path } = await session.start(readRun());
      expect(run_id).toMatch(/^r_[0-9a-f]{12}$/);
      expect(log_path).toBe(join(dir, "home", "runs", "interactive", "runs.jsonl"));
      const f = await finished(run_id);
      expect(f.answer).toBe("42");
      expect(f.infra_error).toBeNull();
      const mine = events.filter((e) => e.params.run_id === run_id).map((e) => e.method);
      expect(mine[0]).toBe("run.started");
      expect(mine[mine.length - 1]).toBe("run.finished");
      expect(mine).toContain("run.reply");
      expect(mine).toContain("run.cell");
    },
    REAL,
  );

  test(
    "approvals get the network request, answered no",
    async () => {
      const asked: ApprovalParams[] = [];
      approvals = async (p) => {
        asked.push(p);
        return { allow: false, remember_for_run: false };
      };
      script({
        root: [{ text: "", tool_call: { code: "fetch('http://127.0.0.1:9/')" } }, { text: "", tool_call: { code: "submit('done')" } }],
      });
      const { run_id } = await session.start(readRun({ permissionMode: "default", interactive: true }));
      const f = await finished(run_id);
      expect(f.infra_error).toBeNull();
      expect(asked.length).toBe(1);
      expect(asked[0]).toMatchObject({ run_id, kind: "network", turn: 1 });
      const perm = events.find((e) => e.method === "run.permission" && e.params.run_id === run_id);
      expect(perm?.params).toMatchObject({ kind: "network", allowed: false, asked: true });
      const cell = events.find((e) => e.method === "run.cell" && e.params.run_id === run_id && e.params.turn === 1);
      expect(cell?.params.error).toContain("PermissionError");
    },
    REAL,
  );

  test(
    "cancel mid-run: infra_error cancelled, and the gateway saw model.cancel",
    async () => {
      script({ root: [{ text: "x".repeat(400) }], chunk_chars: 1, delay_ms: 50 });
      const cancelled: string[] = [];
      const real = session.gateway.cancelRun.bind(session.gateway);
      session.gateway.cancelRun = (id: string) => {
        cancelled.push(id);
        real(id);
      };
      let callStarted!: () => void;
      const inCall = new Promise<void>((resolve) => (callStarted = resolve));
      const off = session.bus.on("call.start", () => callStarted());
      try {
        const { run_id } = await session.start(readRun());
        await inCall;
        await session.cancel(run_id); // returns once run.finished was sent
        const f = await finished(run_id);
        expect(f.infra_error).toBe("cancelled");
        expect(f.infra_kind).toBe("cancelled");
        expect(cancelled).toContain(run_id);
        await session.cancel(run_id); // a finished run: -32010, swallowed
      } finally {
        off();
        session.gateway.cancelRun = real;
      }
    },
    REAL,
  );

  test(
    "vars, then close() ends the engine, twice over",
    async () => {
      script({ root: [{ text: "", tool_call: { code: "x = 'abc'" } }, { text: "", tool_call: { code: "submit(x)" } }] });
      const { run_id } = await session.start(readRun());
      await finished(run_id);
      expect(await session.vars(run_id).catch((e) => e.code)).toBe(-32010); // the run is over
      expect(exits).toEqual([]);
      await session.close();
      await session.close();
      expect(exits.length).toBe(1);
    },
    REAL,
  );
});
