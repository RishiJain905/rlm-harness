// KV cache: none
// sessions.ts: parseSubmission's shapes and refusals, then runSession with the real engine on fake/scripted:
// a frozen-key edit then a valid one gives attempts 2 and the rejection header; two bad attempts fall back.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunWatcher } from "../../src/cli/run.ts";
import { Session } from "../../src/session.ts";
import { writeEvidence } from "../../src/tune/evidence.ts";
import { parseSubmission, runSession } from "../../src/tune/sessions.ts";
import { REAL, temp } from "../cli/helpers.ts";

const editor = { decision: "EDIT", notes: ["why"], guidance: "x\n", toml: { "read.max_turns": 60 } };

describe("parseSubmission", () => {
  test("each shape, with and without files", () => {
    expect(parseSubmission("inv", JSON.stringify(editor))).toMatchObject({ ok: true, value: { decision: "EDIT", files: {} } });
    expect(parseSubmission("inv", JSON.stringify({ ...editor, files: { "skills/a/SKILL.md": "x", "scripts/b.py": null } })).ok).toBe(true);
    expect(parseSubmission("dom", JSON.stringify({ ...editor, toml: {} })).ok).toBe(true);
    expect(parseSubmission("inv", JSON.stringify({ ...editor, system: "You are a model.\n" }))).toMatchObject({ ok: true, value: { system: "You are a model.\n" } });
    expect(parseSubmission("inv", JSON.stringify(editor))).toMatchObject({ ok: true, value: { system: null } });
    expect(parseSubmission("compose", JSON.stringify({ decision: "ADOPT", adopt: "inv", notes: [], guidance: null, toml: {}, files: {} }))).toMatchObject({ ok: true, value: { adopt: "inv" } });
    expect(parseSubmission("compose", JSON.stringify({ decision: "MERGE", adopt: null, notes: ["kept -> x -> y"], guidance: "g\n", toml: {} })).ok).toBe(true);
    expect(parseSubmission("reflect", JSON.stringify({ domain: "read", entry: "NO_ENTRY", edits: [] })).ok).toBe(true);
    expect(parseSubmission("reflect", JSON.stringify({ domain: "repo", entry: { cue: "c", lesson: "l", evidence: "e", confidence: "low" }, edits: [{ component: "guidance.md", candidates: "inv", change: "c", observed: "o", verdict: "no observed effect" }] })).ok).toBe(true);
  });

  const bad = (stage: "inv" | "dom" | "compose" | "reflect", answer: unknown, want: string) => {
    const r = parseSubmission(stage, answer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain(want);
  };

  test("refusals", () => {
    bad("inv", "{'decision': 'EDIT', 'notes': [], 'guidance': None}", "json.dumps");
    bad("inv", { decision: "EDIT" }, "as a string");
    bad("dom", JSON.stringify(editor), "toml must be {}");
    bad("compose", JSON.stringify({ decision: "ADOPT", adopt: null, notes: [], guidance: null, toml: {} }), 'ADOPT needs adopt');
    bad("reflect", JSON.stringify({ domain: "read", entry: "NO_ENTRY", edits: [{ component: "g", candidates: "inv", change: "c", observed: "o", verdict: "great" }] }), "verdict");
    bad("inv", JSON.stringify({ ...editor, notes: ["the f2p_share went up"] }), "f2p_share");
    bad("inv", JSON.stringify({ ...editor, files: { "skills/a/SKILL.md": 3 } }), "the file's text or null");
    bad("inv", JSON.stringify({ ...editor, files: { "../x": "y" } }), "..");
    bad("inv", JSON.stringify({ ...editor, system: 3 }), "system must be");
  });
});

// -- with the real engine --

const t = temp("rlmh-sess-");
afterAll(() => t.cleanup());
let session: Session;
let harness: string;

/** One root entry per session: its code submits the edit for the attempt in stage.md. */
function script(first: object, second: object): string {
  const code =
    "import json, re\nm = re.search(r'attempt: (\\d)', context)\n" +
    `edits = {'1': ${JSON.stringify(JSON.stringify(first))}, '2': ${JSON.stringify(JSON.stringify(second))}}\n` +
    "submit(edits[m.group(1)])\n";
  return t.file(`script-${Math.random().toString(36).slice(2)}.json`, JSON.stringify({ root: [{ text: "", tool_call: { code } }] }));
}

beforeAll(async () => {
  harness = join(t.dir, "base");
  mkdirSync(harness, { recursive: true });
  // the built-in default's own files, as engine.info names them
  const probe = await Session.open({ home: t.home, approvals: async () => ({ allow: false, remember_for_run: false }) });
  const info = await probe.info();
  await probe.close();
  const def = info.profiles.find((p) => p.name === "default")!;
  for (const f of ["profile.toml", "guidance.md", "system.md"]) writeFileSync(join(harness, f), readFileSync(join(def.path, f)));
}, REAL);

async function stage(scriptPath: string, label: string) {
  process.env.RLMH_FAKE_SCRIPT = scriptPath;
  session = await Session.open({ home: t.home, approvals: async () => ({ allow: false, remember_for_run: false }) });
  const watcher = new RunWatcher(session.bus);
  try {
    return await runSession({
      session,
      watcher,
      stage: "inv",
      round: 1,
      root: { provider: "fake", model: "scripted", thinking: null },
      sub: { provider: "fake", model: "scripted", thinking: null },
      tag: `tune:test:r1-inv`,
      logDir: join(t.dir, `sessions-${label}`),
      evidence: (attempt) =>
        writeEvidence(join(t.dir, `ev-${label}`), { stage: "inv", round: 1, attempt, harnessDir: harness, systemPrompt: "SYS", tasks: [], setDir: t.dir, runs: [], secrets: { setDir: join(t.dir, "no-set"), hiddenPaths: [], testIds: [] } }),
      incumbent: { dir: harness, name: "default" },
      candidateDir: join(t.dir, `cand-${label}`),
    });
  } finally {
    watcher.dispose();
    await session.close();
    delete process.env.RLMH_FAKE_SCRIPT;
  }
}

describe("runSession on the real engine", () => {
  test(
    "a frozen-key edit, then a valid one: attempts 2, and the second question carries the rejection",
    async () => {
      const frozen = { decision: "EDIT", notes: ["n"], guidance: null, toml: { "read.root_max_tokens": 4096 }, files: {} };
      const valid = { decision: "EDIT", notes: ["n"], guidance: null, toml: { "read.max_turns": 60 }, files: {} };
      const r = await stage(script(frozen, valid), "retry");
      expect(r.attempts).toBe(2);
      expect(r.fell_back).toBe(false);
      expect(r.decision).toBe("EDIT");
      expect(r.errors.join("\n")).toContain("frozen");
      expect(r.candidate!.check.changed).toEqual(["read.max_turns"]);
      const records = readFileSync(join(t.dir, "sessions-retry", "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(records).toHaveLength(2);
      expect(records[1].question).toContain("# YOUR PREVIOUS ATTEMPT WAS REJECTED");
      expect(records[0].question).not.toContain("REJECTED");
      expect(records.every((x: { profile: string }) => x.profile === "default")).toBe(true);
    },
    REAL * 2,
  );

  test(
    "two bad attempts fall back to the base",
    async () => {
      const r = await stage(script({ decision: "EDIT" }, { decision: "MAYBE" }), "fallback");
      expect(r).toMatchObject({ attempts: 2, fell_back: true, decision: "KEEP_BASE" });
      expect(r.errors.length).toBeGreaterThanOrEqual(2);
    },
    REAL * 2,
  );
});
