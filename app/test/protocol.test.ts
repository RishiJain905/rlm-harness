// KV cache: none
// protocol/examples.json against architecture §3 to §6.2 (D-02). The required names and the
// field tables live here, apart from the file, so a wrong example can't bless itself.
// engine/tests/test_protocol.py holds the same lists; change both with any wire change.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MAX_LINE_BYTES, classify } from "../src/link.ts";
import { ErrorCode } from "../src/protocol.ts";
import { PROTOCOL_VERSION } from "../src/version.ts";

interface Example {
  name: string;
  direction: string;
  kind: string;
  message: any;
}

const FILE = await Bun.file(join(import.meta.dir, "..", "..", "protocol", "examples.json")).json();
const EXAMPLES: Example[] = FILE.examples;

const ERROR_CODES: Record<string, number> = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  MODEL_ERROR: -32001,
  UNKNOWN_RUN: -32010,
  UNKNOWN_PROFILE: -32011,
  BAD_INPUT: -32012,
  CANCELLED: -32800,
};

const REQUIRED = [
  "engine.info:request",
  "engine.info:result",
  "run.cancel:request",
  "run.cancel:result",
  "run.vars:request",
  "run.vars:result",
  "debug.roundtrip:request",
  "debug.roundtrip:result",
  "run.start:request:read",
  "run.start:request:repo",
  "run.start:result",
  "model.complete:request:root",
  "model.complete:request:sub",
  "model.complete:result",
  "approval.request:request",
  "approval.request:result",
  "run.start:error:UNKNOWN_PROFILE",
  "run.start:error:BAD_INPUT",
  "run.cancel:error:UNKNOWN_RUN",
  "model.complete:error:MODEL_ERROR",
  "rpc:error:PARSE_ERROR",
  "rpc:error:INVALID_REQUEST",
  "rpc:error:METHOD_NOT_FOUND",
  "rpc:error:INVALID_PARAMS",
  "rpc:error:INTERNAL_ERROR",
  "rpc:error:CANCELLED",
  "run.started:notification",
  "run.reply:notification",
  "run.cell:notification",
  "run.subcall:notification",
  "run.permission:notification",
  "run.budget:notification",
  "run.finished:notification",
  "model.cancel:notification",
];

/** Who sends each §5 method. */
const METHODS: Record<string, string> = {
  "engine.info": "app->engine",
  "run.start": "app->engine",
  "run.cancel": "app->engine",
  "run.vars": "app->engine",
  "debug.roundtrip": "app->engine",
  "model.complete": "engine->app",
  "approval.request": "engine->app",
  "run.started": "engine->app",
  "run.reply": "engine->app",
  "run.cell": "engine->app",
  "run.subcall": "engine->app",
  "run.permission": "engine->app",
  "run.budget": "engine->app",
  "run.finished": "engine->app",
  "model.cancel": "engine->app",
};

/** §6.2, key for key. */
const PYTHON_TOOL = {
  name: "python",
  description:
    "Run one cell of Python in the persistent REPL. Variables persist between calls. The result is what the cell printed, followed by your remaining turns and sub-calls.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "The Python code to run." } },
    required: ["code"],
    additionalProperties: false,
  },
};

// -- a small type language for §4 and §5 --

type Spec =
  | "str"
  | "int"
  | "num"
  | "bool"
  | "object"
  | "message"
  | { nullable: Spec }
  | { list: Spec }
  | { oneOf: readonly string[] }
  | { required: Record<string, Spec>; optional: Record<string, Spec> };

const obj = (required: Record<string, Spec>, optional: Record<string, Spec> = {}): Spec => ({ required, optional });
const nullable = (spec: Spec): Spec => ({ nullable: spec });
const listOf = (spec: Spec): Spec => ({ list: spec });
const oneOf = (...values: string[]): Spec => ({ oneOf: values });

const THINKING = oneOf("off", "low", "medium", "high");
const FINISH_REASON = oneOf("stop", "length", "tool_call", "content_filter", "other");
const PERMISSION_MODE = oneOf("default", "accept-edits", "bypass");
const CALL_FORMAT = oneOf("fenced", "native");
const APPROVAL_KIND = oneOf("write", "shell", "network");
const MODEL_REF = obj({ provider: "str", model: "str", thinking: nullable(THINKING) });
const TOOL_CALL = obj({ id: "str", name: "str", arguments: "object" });
const TOOL_DEF = obj({ name: "str", description: "str", parameters: "object" });
const USAGE = obj({
  input_tokens: "int",
  output_tokens: "int",
  cache_read_tokens: "int",
  cache_write_tokens: "int",
  reasoning_tokens: "int",
  cost_usd: "num",
});
const MODEL_ERROR_DATA = obj({
  kind: oneOf("auth", "no_key", "bad_request", "rate_limit", "server", "timeout", "network", "context_window", "unknown_model", "cancelled", "other"),
  provider: "str",
  model: "str",
  status: nullable("int"),
  message: "str",
});
const ORIGIN = obj({ turn: "int", line: nullable("int") });
const BATCH = obj({ id: "str", index: "int", size: "int" });
const MESSAGES: Record<string, Spec> = {
  system: obj({ role: oneOf("system"), content: "str" }),
  user: obj({ role: oneOf("user"), content: "str" }),
  assistant: obj({ role: oneOf("assistant"), content: "str" }, { tool_call: TOOL_CALL }),
  tool: obj({ role: oneOf("tool"), tool_call_id: "str", content: "str" }),
};

/** params (requests, notifications) or result, per "<method>:<kind>". */
const FIELDS: Record<string, Spec> = {
  "engine.info:request": obj({}),
  "engine.info:result": obj({
    version: "str",
    protocol: "int",
    python: "str",
    contract: nullable("str"),
    contract_hash: nullable("str"),
    training_hash: nullable("str"),
    profiles: listOf(obj({ name: "str", source: oneOf("builtin", "user"), prompt_hash: "str", profile_hash: "str" })),
  }),
  "run.start:request": obj(
    { mode: oneOf("read", "repo"), profile: "str", root: MODEL_REF, sub: MODEL_REF, permission_mode: PERMISSION_MODE, call_format: CALL_FORMAT },
    {
      question: "str",
      inputs: listOf("str"),
      task: "str",
      repo_path: "str",
      test_hint: "str",
      language: "str",
      n_files: "int",
      context: "str",
      interactive: "bool",
      tag: "str",
      batch: "str",
      log_dir: "str",
    },
  ),
  "run.start:result": obj({ run_id: "str", log_path: "str" }),
  "run.cancel:request": obj({ run_id: "str" }),
  "run.cancel:result": obj({}),
  "run.vars:request": obj({ run_id: "str" }),
  "run.vars:result": obj({ vars: listOf(obj({ name: "str", type: "str", len: nullable("int"), chars: "int" })) }),
  "debug.roundtrip:request": obj({ count: "int" }),
  "debug.roundtrip:result": obj({ texts: listOf("str") }),
  "model.complete:request": obj(
    {
      run_id: "str",
      role: oneOf("root", "sub"),
      model: MODEL_REF,
      messages: listOf("message"),
      tools: listOf(TOOL_DEF),
      max_tokens: "int",
      temperature: "num",
      thinking: THINKING,
      turn: "int",
    },
    { subcall_id: "int", origin: ORIGIN, batch: BATCH },
  ),
  "model.complete:result": obj({
    text: "str",
    tool_call: nullable(TOOL_CALL),
    reasoning: nullable("str"),
    usage: USAGE,
    finish_reason: FINISH_REASON,
    served_model: "str",
    seconds: "num",
  }),
  "approval.request:request": obj({ run_id: "str", kind: APPROVAL_KIND, detail: "str", turn: "int", inside_workspace: "bool" }),
  "approval.request:result": obj({ allow: "bool", remember_for_run: "bool" }),
  "run.started:notification": obj({
    run_id: "str",
    tag: nullable("str"),
    mode: oneOf("read", "repo"),
    profile: "str",
    prompt_hash: "str",
    profile_hash: "str",
    contract_hash: "str",
    call_format: CALL_FORMAT,
    root: MODEL_REF,
    sub: MODEL_REF,
    permission_mode: PERMISSION_MODE,
    workspace: "str",
    input: obj({ chars: "int", lines: "int", sha256: "str", files: listOf("str") }),
    limits: obj({
      max_turns: "int",
      max_subcalls: "int",
      root_max_tokens: "int",
      output_max_chars: "int",
      cell_timeout_s: "num",
      subcall_max_chars: "int",
      subcall_max_tokens: "int",
    }),
    log_path: "str",
  }),
  "run.reply:notification": obj({
    run_id: "str",
    turn: "int",
    text: "str",
    tool_call: nullable(TOOL_CALL),
    reasoning: nullable("str"),
    finish_reason: FINISH_REASON,
    usage: USAGE,
    seconds: "num",
  }),
  "run.cell:notification": obj({
    run_id: "str",
    turn: "int",
    code: nullable("str"),
    output: "str",
    error: nullable("str"),
    observation: nullable("str"),
    seconds: "num",
    restarted: "bool",
    crash: nullable("str"),
    repo_changed: nullable("bool"),
  }),
  "run.subcall:notification": obj({
    run_id: "str",
    subcall_id: nullable("int"),
    origin: ORIGIN,
    batch: BATCH,
    prompt_chars: "int",
    status: oneOf("sent", "done", "error", "rejected"),
    error: nullable("str"),
    seconds: nullable("num"),
  }),
  "run.permission:notification": obj({
    run_id: "str",
    turn: "int",
    kind: APPROVAL_KIND,
    detail: "str",
    allowed: "bool",
    asked: "bool",
    remembered: "bool",
  }),
  "run.budget:notification": obj({ run_id: "str", turns_left: "int", subcalls_left: "int" }),
  "run.finished:notification": obj({
    run_id: "str",
    tag: nullable("str"),
    answer: nullable("str"),
    submitted: "bool",
    answer_valid: "bool",
    turns: "int",
    subcalls: "int",
    usage: obj({ root: USAGE, sub: USAGE }),
    cost_usd: "num",
    infra_error: nullable("str"),
    infra_kind: nullable("str"),
    wall_s: "num",
    log_path: "str",
  }),
  "model.cancel:notification": obj({ run_id: "str" }),
};

const ERROR_OBJECT = obj({ code: "int", message: "str" }, { data: "object" });

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Throws when `value` doesn't match `spec`; `path` names the field. */
function check(value: unknown, spec: Spec, path: string): void {
  const fail = (what: string) => {
    throw new Error(`${path}: ${what}: ${JSON.stringify(value)}`);
  };
  if (spec === "str") typeof value === "string" || fail("not a string");
  else if (spec === "int") Number.isInteger(value) || fail("not an integer");
  else if (spec === "num") typeof value === "number" || fail("not a number");
  else if (spec === "bool") typeof value === "boolean" || fail("not a bool");
  else if (spec === "object") isPlain(value) || fail("not an object");
  else if (spec === "message") {
    if (!isPlain(value) || typeof value.role !== "string" || !(value.role in MESSAGES)) fail("not a Message");
    check(value, MESSAGES[(value as { role: string }).role]!, path);
  } else if ("nullable" in spec) {
    if (value !== null) check(value, spec.nullable, path);
  } else if ("list" in spec) {
    if (!Array.isArray(value)) fail("not a list");
    (value as unknown[]).forEach((item, i) => check(item, spec.list, `${path}[${i}]`));
  } else if ("oneOf" in spec) {
    spec.oneOf.includes(value as string) || fail(`not one of ${spec.oneOf.join(", ")}`);
  } else {
    if (!isPlain(value)) fail("not an object");
    const v = value as Record<string, unknown>;
    const missing = Object.keys(spec.required).filter((k) => !(k in v));
    const extra = Object.keys(v).filter((k) => !(k in spec.required) && !(k in spec.optional));
    if (missing.length) fail(`missing ${missing.join(", ")}`);
    if (extra.length) fail(`unexpected ${extra.join(", ")}`);
    for (const [k, item] of Object.entries(v)) check(item, spec.required[k] ?? spec.optional[k]!, `${path}.${k}`);
  }
}

const byName = new Map(EXAMPLES.map((ex) => [ex.name, ex]));
const methodOf = (ex: Example) => ex.name.split(":")[0]!;

describe("protocol examples", () => {
  test("file_shape", () => {
    expect(FILE.protocol).toBe(1);
    expect(FILE.protocol).toBe(PROTOCOL_VERSION);
    expect(Object.keys(FILE).sort()).toEqual(["examples", "protocol"]);
    expect(byName.size).toBe(EXAMPLES.length); // unique names
    for (const ex of EXAMPLES) {
      expect(Object.keys(ex).sort()).toEqual(["direction", "kind", "message", "name"]);
      const parts = ex.name.split(":");
      expect([2, 3]).toContain(parts.length);
      expect(parts[1]).toBe(ex.kind);
      expect(["request", "result", "error", "notification"]).toContain(ex.kind);
      expect(["app->engine", "engine->app"]).toContain(ex.direction);
    }
  });

  test("coverage", () => {
    for (const name of REQUIRED) expect(byName.has(name)).toBe(true);
    for (const ex of EXAMPLES) {
      const method = methodOf(ex);
      expect(method in METHODS || method === "rpc").toBe(true);
      if (ex.kind === "request" || ex.kind === "notification") {
        expect(ex.message.method).toBe(method);
        expect(ex.direction).toBe(METHODS[method]!);
      }
      if (method === "rpc") expect(ex.kind).toBe("error");
    }
    const errors = new Map(EXAMPLES.filter((ex) => ex.kind === "error").map((ex) => [ex.name.split(":")[2]!, ex]));
    for (const name of errors.keys()) expect(name in ERROR_CODES).toBe(true);
    for (const [name, code] of Object.entries(ERROR_CODES)) {
      expect(errors.has(name)).toBe(true);
      expect(errors.get(name)!.message.error.code).toBe(code);
    }
  });

  test("classify", () => {
    for (const ex of EXAMPLES) {
      const { message: msg, kind, direction } = ex;
      expect(classify(msg)).toBe(kind as ReturnType<typeof classify>);
      expect(msg.jsonrpc).toBe("2.0");
      if (kind === "notification") {
        expect("id" in msg).toBe(false);
        continue;
      }
      const appId = Number.isInteger(msg.id) && msg.id >= 1;
      const engineId = typeof msg.id === "string" && /^e[1-9][0-9]*$/.test(msg.id);
      if (kind === "request") expect(direction === "app->engine" ? appId : engineId).toBe(true);
      else expect(msg.id === null || (direction === "app->engine" ? engineId : appId)).toBe(true);
    }
  });

  test("pairing", () => {
    const requests = EXAMPLES.filter((ex) => ex.kind === "request");
    for (const ex of EXAMPLES) {
      if ((ex.kind !== "result" && ex.kind !== "error") || methodOf(ex) === "rpc") continue;
      const match = requests.filter((r) => methodOf(r) === methodOf(ex) && r.message.id === ex.message.id && r.direction !== ex.direction);
      expect(match.length).toBeGreaterThan(0);
    }
  });

  test("round_trip", () => {
    for (const ex of EXAMPLES) {
      const line = JSON.stringify(ex.message);
      expect(line.includes("\n")).toBe(false);
      expect(JSON.parse(line)).toEqual(ex.message);
    }
  });

  test("fields", () => {
    for (const ex of EXAMPLES) {
      const { message: msg, kind, name } = ex;
      if (kind === "error") {
        check(msg.error, ERROR_OBJECT, `${name}.error`);
        if (name.endsWith(":MODEL_ERROR")) check(msg.error.data, MODEL_ERROR_DATA, `${name}.error.data`);
        continue;
      }
      const spec = FIELDS[`${methodOf(ex)}:${kind}`];
      expect(spec).toBeDefined();
      check(kind === "result" ? msg.result : msg.params, spec!, name);
    }
    const read = byName.get("run.start:request:read")!.message.params;
    const repo = byName.get("run.start:request:repo")!.message.params;
    expect(read.mode === "read" && read.question && read.inputs.length >= 1).toBeTruthy();
    expect(repo.mode === "repo" && repo.task && repo.repo_path).toBeTruthy();
    const root = byName.get("model.complete:request:root")!.message.params;
    const sub = byName.get("model.complete:request:sub")!.message.params;
    expect(root.role).toBe("root");
    for (const k of ["subcall_id", "origin", "batch"]) {
      expect(k in root).toBe(false);
      expect(k in sub).toBe(true);
    }
    expect(root.messages.map((m: { role: string }) => m.role).sort()).toEqual(["assistant", "system", "tool", "user"]);
    expect(sub.role).toBe("sub");
    expect(sub.tools).toEqual([]);
    expect(sub.messages.map((m: { role: string }) => m.role)).toEqual(["user"]);
  });

  test("check rejects bad shapes", () => {
    // guards the checker itself: a missing key, an extra key and a bad enum all fail
    expect(() => check({ provider: "p", model: "m" }, MODEL_REF, "ref")).toThrow(/missing thinking/);
    expect(() => check({ provider: "p", model: "m", thinking: null, x: 1 }, MODEL_REF, "ref")).toThrow(/unexpected x/);
    expect(() => check({ provider: "p", model: "m", thinking: "max" }, MODEL_REF, "ref")).toThrow(/not one of/);
    expect(() => check({ role: "robot", content: "" }, "message", "m")).toThrow(/not a Message/);
  });

  test("python_tool", () => {
    const tools = byName.get("model.complete:request:root")!.message.params.tools;
    expect(tools[0]).toEqual(PYTHON_TOOL);
    expect(Object.keys(tools[0])).toEqual(Object.keys(PYTHON_TOOL));
  });

  test("constants", () => {
    expect({ ...ErrorCode } as Record<string, number>).toEqual(ERROR_CODES);
    expect(MAX_LINE_BYTES).toBe(32 * 1024 * 1024);
  });
});
