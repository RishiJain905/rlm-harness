// KV cache: none; the interface never touches the bytes sent to the model.
// runs.ts against temp run folders: the summaries, the byte ranges (the records hold non-ASCII text,
// so offsets are bytes), the torn last line, unknown formats, the newest-200 cut and `readRun`; and a
// conversation's records (v1 step 4) in /runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRow } from "../../src/interface/commands/runs.tsx";
import { READABLE_FORMATS, RUN_LOG_FORMAT, listRuns, readRun, upgradeRecord, type RunSummary } from "../../src/interface/runs.ts";
import { viewFromRecord } from "../../src/interface/store.ts";
import { createFakeApp } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";

let runsDir: string;

beforeEach(() => {
  runsDir = join(realpathSync(mkdtempSync(join(tmpdir(), "rlmh-runs-"))), "runs");
});

afterEach(() => {
  rmSync(join(runsDir, ".."), { recursive: true, force: true });
});

type Rec = Record<string, unknown>;

/** A minimal run-log record with the fields the summary reads (architecture §7.8). */
function rec(over: Rec = {}): Rec {
  return {
    format: RUN_LOG_FORMAT,
    run_id: "r_000000000001",
    tag: null,
    batch: "interactive",
    mode: "read",
    root: { provider: "deepseek", model: "deepseek-chat", thinking: null },
    sub: { provider: "deepseek", model: "deepseek-chat", thinking: null },
    started_at: 1_000,
    wall_s: 4.5,
    question: "What is in the file?",
    messages: [],
    turns: [{ turn: 1 }, { turn: 2 }],
    subcalls: [],
    answer: "42",
    cost_usd: 0.0123,
    infra_error: null,
    infra_kind: null,
    ...over,
  };
}

const line = (r: unknown): string => JSON.stringify(r);

/** Writes `<runsDir>/<folder>/runs.jsonl` from lines (each ends with \n) and an optional unterminated tail. */
function log(folder: string, lines: unknown[], tail = ""): string {
  const dir = join(runsDir, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "runs.jsonl");
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : line(l)) + "\n").join("") + tail);
  return file;
}

const ids = (runs: RunSummary[]): string[] => runs.map((r) => r.runId);

describe("listRuns", () => {
  const r1 = rec({ run_id: "r1", started_at: 100, question: "first question" });
  const r2 = rec({ run_id: "r2", started_at: 300, question: "Qu'est-ce qu'un été en 日本? résumé é", cost_usd: 0.5, turns: [{}, {}, {}] });
  const r3 = rec({ run_id: "r3", started_at: 200, mode: "repo", question: undefined, task: "fix the parser", infra_kind: "cancelled", infra_error: "cancelled: x" });
  const r4 = rec({ run_id: "r4", started_at: 400, batch: "cli", question: "from the cli" });
  const torn = '{"format":1,"run_id":"torn","started_at":999,"mode":"re';

  function standard(): { interactive: string; cli: string } {
    return { interactive: log("interactive", [r1, r2, r3], torn), cli: log("cli", [r4]) };
  }

  test("lists every folder's runs, newest first, and skips the torn last line", async () => {
    standard();
    const runs = await listRuns(runsDir);
    expect(ids(runs)).toEqual(["r4", "r2", "r3", "r1"]);
  });

  test("a summary carries the fields the list shows", async () => {
    const { interactive, cli } = standard();
    const runs = await listRuns(runsDir);
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
    expect(byId.r2).toMatchObject({
      file: interactive,
      runId: "r2",
      batch: "interactive",
      format: RUN_LOG_FORMAT,
      startedAt: 300,
      mode: "read",
      root: "deepseek/deepseek-chat",
      costUsd: 0.5,
      turns: 3,
      text: "Qu'est-ce qu'un été en 日本? résumé é",
      infraKind: null,
    });
    expect(byId.r3).toMatchObject({ mode: "repo", text: "fix the parser", infraKind: "cancelled", turns: 2 });
    expect(byId.r4).toMatchObject({ file: cli, batch: "cli", text: "from the cli", costUsd: 0.0123 });
  });

  test("offsets are bytes: each range is exactly its line, after non-ASCII text", async () => {
    const { interactive } = standard();
    const runs = (await listRuns(runsDir)).filter((r) => r.file === interactive);
    const bytes = Buffer.from(
      [r1, r2, r3].map((r) => line(r) + "\n").join("") + torn,
      "utf8",
    );
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
    const len = (r: Rec): number => Buffer.byteLength(line(r));
    expect(byId.r1?.offset).toBe(0);
    expect(byId.r1?.length).toBe(len(r1));
    expect(byId.r2?.offset).toBe(len(r1) + 1);
    expect(byId.r2?.length).toBe(len(r2));
    expect(byId.r3?.offset).toBe(len(r1) + 1 + len(r2) + 1);
    expect(byId.r3?.length).toBe(len(r3));
    // the question has multi-byte characters, so a character count would put r3 somewhere else
    expect(line(r2).length).toBeLessThan(len(r2));
    for (const r of runs) {
      expect(JSON.parse(bytes.subarray(r.offset, r.offset + r.length).toString("utf8")).run_id).toBe(r.runId);
    }
  });

  test("readRun gives back the record at the range", async () => {
    standard();
    const runs = await listRuns(runsDir);
    expect(runs.length).toBe(4);
    const originals: Record<string, Rec> = { r1, r2, r3, r4 };
    for (const r of runs) {
      const got = await readRun(r);
      expect(got).toEqual(JSON.parse(line(originals[r.runId]))); // undefined fields are not in the file
    }
  });

  test("a missing runsDir gives []", async () => {
    expect(await listRuns(join(runsDir, "nope"))).toEqual([]);
  });

  test("an empty runsDir, folders without a log, loose files and deeper folders give nothing", async () => {
    mkdirSync(join(runsDir, "empty"), { recursive: true });
    mkdirSync(join(runsDir, "nested", "deeper"), { recursive: true });
    writeFileSync(join(runsDir, "notes.txt"), "x");
    writeFileSync(join(runsDir, "runs.jsonl"), line(rec({ run_id: "top-level" })) + "\n");
    writeFileSync(join(runsDir, "nested", "deeper", "runs.jsonl"), line(rec({ run_id: "too-deep" })) + "\n");
    expect(await listRuns(runsDir)).toEqual([]);
  });

  test("an empty log file gives nothing", async () => {
    log("interactive", []);
    expect(await listRuns(runsDir)).toEqual([]);
  });

  test("format 1 and format 2 are both readable; a format 1 record gets format 2's four keys (v1 step 3)", async () => {
    expect(READABLE_FORMATS).toEqual([1, 2]);
    expect(RUN_LOG_FORMAT).toBe(2);
    const v2 = { window: { context_window: 1_000_000, max_output: 0 }, compactions: [{ turn: 3 }], prompt_index: 0, conversation: false };
    log("interactive", [rec({ run_id: "one", format: 1, started_at: 5 }), rec({ run_id: "two", format: 2, started_at: 6, ...v2 })]);
    const runs = await listRuns(runsDir);
    expect(runs.map((r) => [r.runId, r.format])).toEqual([["two", 2], ["one", 1]]);
    expect(await readRun(runs[1]!)).toEqual({ ...JSON.parse(line(rec({ run_id: "one", format: 1, started_at: 5 }))), window: null, compactions: [], prompt_index: 0, conversation: false });
    expect(await readRun(runs[0]!)).toEqual(JSON.parse(line(rec({ run_id: "two", format: 2, started_at: 6, ...v2 }))));
    // only format 1 is filled in; another number comes back as written
    expect(upgradeRecord({ format: 99, run_id: "x" })).toEqual({ format: 99, run_id: "x" });
  });

  test("a record with another format version is listed with that version", async () => {
    log("interactive", [rec({ run_id: "old", format: 99, started_at: 5 }), rec({ run_id: "now", started_at: 6 })]);
    const runs = await listRuns(runsDir);
    expect(ids(runs)).toEqual(["now", "old"]);
    expect(runs[1]?.format).toBe(99);
    expect(runs[0]?.format).toBe(RUN_LOG_FORMAT);
    expect((await readRun(runs[1] as RunSummary)) as Rec).toMatchObject({ run_id: "old", format: 99 });
  });

  test("missing and odd fields get defaults and never throw", async () => {
    log("interactive", [
      { format: 99, run_id: "bare" },
      {},
      { run_id: "odd", started_at: "soon", cost_usd: "nan", turns: "many", root: { provider: "x" }, mode: 7, question: 5, infra_kind: 3, format: "one" },
      { run_id: "strroot", started_at: 1, root: "p/m" },
    ]);
    const runs = await listRuns(runsDir);
    expect(runs.length).toBe(4);
    const byId = Object.fromEntries(runs.map((r) => [r.runId, r]));
    expect(byId.bare).toMatchObject({ format: 99, startedAt: 0, mode: "", root: "", costUsd: 0, turns: 0, text: "", infraKind: null, batch: "" });
    expect(byId[""]).toMatchObject({ format: 0, startedAt: 0 });
    expect(byId.odd).toMatchObject({ format: 0, startedAt: 0, costUsd: 0, turns: 0, root: "", mode: "", text: "", infraKind: null });
    expect(byId.strroot).toMatchObject({ root: "p/m", startedAt: 1 });
  });

  test("a bad line in the middle is skipped and the lines after it keep correct ranges", async () => {
    const file = log("interactive", [
      rec({ run_id: "a", started_at: 1, question: "é" }),
      "not json at all",
      "",
      "[1,2,3]",
      "42",
      "null",
      '{"run_id":"half',
      rec({ run_id: "b", started_at: 2, question: "日本" }),
    ]);
    const runs = await listRuns(runsDir);
    expect(ids(runs)).toEqual(["b", "a"]);
    expect(runs[0]?.file).toBe(file);
    expect(await readRun(runs[0] as RunSummary)).toMatchObject({ run_id: "b", question: "日本" });
    expect(await readRun(runs[1] as RunSummary)).toMatchObject({ run_id: "a", question: "é" });
  });

  test("a complete last line without a newline is listed, a half one is not", async () => {
    log("whole", [rec({ run_id: "w1", started_at: 1 })], line(rec({ run_id: "w2", started_at: 2 })));
    log("half", [rec({ run_id: "h1", started_at: 3 })], line(rec({ run_id: "h2" })).slice(0, 40));
    const runs = await listRuns(runsDir);
    expect(ids(runs)).toEqual(["h1", "w2", "w1"]);
    expect(await readRun(runs[1] as RunSummary)).toMatchObject({ run_id: "w2" });
  });

  test("CRLF line ends work", async () => {
    const dir = join(runsDir, "crlf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "runs.jsonl"), line(rec({ run_id: "c1", started_at: 1 })) + "\r\n" + line(rec({ run_id: "c2", started_at: 2 })) + "\r\n");
    const runs = await listRuns(runsDir);
    expect(ids(runs)).toEqual(["c2", "c1"]);
    expect(await readRun(runs[0] as RunSummary)).toMatchObject({ run_id: "c2" });
  });

  test("equal start times: the later line is first", async () => {
    log("interactive", [rec({ run_id: "x", started_at: 7 }), rec({ run_id: "y", started_at: 7 }), rec({ run_id: "z", started_at: 7 })]);
    expect(ids(await listRuns(runsDir))).toEqual(["z", "y", "x"]);
  });

  test("a record bigger than a read chunk, full of multi-byte characters, is read whole", async () => {
    const big = "é日".repeat(150_000); // 750 KB, far over the stream's chunk size
    const file = log("interactive", [
      rec({ run_id: "before", started_at: 1 }),
      rec({ run_id: "big", started_at: 2, question: big }),
      rec({ run_id: "after", started_at: 3 }),
    ]);
    const runs = await listRuns(runsDir);
    expect(ids(runs)).toEqual(["after", "big", "before"]);
    const bigRun = runs[1] as RunSummary;
    expect(bigRun.file).toBe(file);
    expect(bigRun.text).toBe(big);
    expect(bigRun.length).toBe(Buffer.byteLength(line(rec({ run_id: "big", started_at: 2, question: big }))));
    expect(((await readRun(bigRun)) as Rec).question).toBe(big);
    expect(await readRun(runs[0] as RunSummary)).toMatchObject({ run_id: "after" });
  });

  test("250 records give the newest 200", async () => {
    const records: Rec[] = [];
    for (let i = 1; i <= 250; i++) records.push(rec({ run_id: `r${i}`, started_at: i }));
    log("interactive", records);
    const runs = await listRuns(runsDir);
    expect(runs.length).toBe(200);
    expect(runs[0]?.runId).toBe("r250");
    expect(runs[199]?.runId).toBe("r51");
    expect(runs.map((r) => r.startedAt)).toEqual(Array.from({ length: 200 }, (_, i) => 250 - i));
  });

  test("the cut also holds across folders and a long log, in any file order", async () => {
    const n = 2500; // over the point where the list is pruned while it streams
    const all: Rec[] = [];
    for (let i = 0; i < n; i++) all.push(rec({ run_id: `r${i}`, started_at: (i * 7919) % n })); // a shuffle: 7919 is prime
    log("a", all.slice(0, 1500));
    log("b", all.slice(1500));
    const runs = await listRuns(runsDir);
    expect(runs.length).toBe(200);
    expect(runs.map((r) => r.startedAt)).toEqual(Array.from({ length: 200 }, (_, i) => n - 1 - i));
    for (const r of runs.slice(0, 5)) expect((await readRun(r)) as Rec).toMatchObject({ run_id: r.runId });
  });

  test("a log of several MB is read in full and cut to 200", async () => {
    // 3000 records of about 1 KB each
    const filler = "x".repeat(1000);
    const records: Rec[] = [];
    for (let i = 0; i < 3000; i++) records.push(rec({ run_id: `r${i}`, started_at: i, question: `${i} ${filler}` }));
    log("interactive", records);
    const runs = await listRuns(runsDir);
    expect(runs.length).toBe(200);
    expect(runs[0]?.runId).toBe("r2999");
  });
});

describe("readRun", () => {
  test("it fails with a message that names the file when the log changed under the range", async () => {
    const file = log("interactive", [rec({ run_id: "a", started_at: 1 }), rec({ run_id: "b", started_at: 2 })]);
    const runs = await listRuns(runsDir);
    truncateSync(file, 10);
    await expect(readRun(runs[0] as RunSummary)).rejects.toThrow(file);
  });

  test("it fails when the file is gone", async () => {
    const file = log("interactive", [rec({ run_id: "a" })]);
    const runs = await listRuns(runsDir);
    rmSync(file);
    await expect(readRun(runs[0] as RunSummary)).rejects.toThrow();
  });

  test("it reads only its range: a neighbour line is untouched", async () => {
    log("interactive", [rec({ run_id: "a", started_at: 1, question: "é".repeat(100) }), rec({ run_id: "b", started_at: 2 })]);
    const runs = await listRuns(runsDir);
    const got = (await readRun(runs[1] as RunSummary)) as Rec;
    expect(got.run_id).toBe("a");
    expect(got.question).toBe("é".repeat(100));
  });
});

describe("a conversation's records (v1 step 4)", () => {
  /** Prompt 0 and follow-up 1 of one conversation: the same run_id, each with its own question and turns. */
  function conversation(): { first: Rec; second: Rec } {
    const first = rec({ run_id: "r_conv", started_at: 10, question: "What is in a.txt?", prompt_index: 0, conversation: true, turns: [{ turn: 1, reply: "first reply", code: "submit('hello')", stdout: "", error: null }] });
    const second = rec({
      run_id: "r_conv",
      started_at: 20,
      question: "And how long is it?",
      prompt_index: 1,
      conversation: true,
      answer: "6",
      turns: [{ turn: 1, reply: "second reply", code: "submit(len(context))", stdout: "", error: null }],
    });
    return { first, second };
  }

  test("/runs lists both records, the second with follow-up 1: before its question", async () => {
    const { first, second } = conversation();
    log("interactive", [first, second]);
    const runs = await listRuns(runsDir);
    expect(runs.map((r) => [r.runId, r.promptIndex])).toEqual([["r_conv", 1], ["r_conv", 0]]);
    expect(runRow(runs[0]!, "…")).toContain("  follow-up 1: And how long is it?");
    expect(runRow(runs[1]!, "…")).toContain("  What is in a.txt?");
    expect(runRow(runs[1]!, "…")).not.toContain("follow-up");
  });

  test("on the /runs screen", { timeout: 20_000 }, async () => {
    const app = await createFakeApp({ scenario: "simpleRead" });
    let m: Mounted | undefined;
    try {
      const { first, second } = conversation();
      const dir = join(app.deps.home, "runs", "interactive");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "runs.jsonl"), `${line(first)}\n${line(second)}\n`);
      m = mount(app.deps);
      await m.waitForText("idle");
      await m.type("/runs");
      await m.press(KEYS.enter);
      const s = await m.waitForText("follow-up 1: And how long"); // the 40-column question cell cuts the rest
      expect(s).toContain("What is in a.txt?");
      // Enter replays the follow-up's own prompt: its question and its turns only
      await m.press(KEYS.enter);
      const replay = await m.waitForText("(read-only)");
      expect(replay).toContain("And how long is it?");
      expect(replay).toContain("(follow-up 1)");
      expect(replay).toContain("second reply");
      expect(replay).not.toContain("first reply");
    } finally {
      m?.unmount();
      await app.dispose();
    }
  });

  test("viewFromRecord shows the record's prompt only", () => {
    const { second } = conversation();
    const view = viewFromRecord(second);
    expect(view.prompt).toBe(1);
    expect(view.entries[0]).toEqual({ kind: "question", text: "And how long is it?", detail: "follow-up 1" });
    expect(view.entries.filter((e) => e.kind === "reply").map((e) => (e.kind === "reply" ? e.text : ""))).toEqual(["second reply"]);
  });
});
