// KV cache: none
// `rlmh tune` end to end: the real engine from source and the scripted fake provider, on the fixture set with
// --gpu none (no kernel task). A failing --from makes round 1 accepted; a passing one makes it rejected;
// --continue adds round 2; the gate's agent and nudge are kept only with --gated; the estimate spends nothing;
// and the pre-flight and engine.info checks exit 2.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { GRADE_MARKERS } from "../../src/tune/evidence.ts";
import { buildFixtureSet, editSet } from "../eval/fixture.ts";
import { jsonLines, REAL, rlmh, temp, type Temp } from "./helpers.ts";

const LONG = 600_000;
const FAKE = ["--root", "fake/scripted", "--sub", "fake/scripted"];
const OFFLINE = { UV_OFFLINE: "1" };
const SCRIPTS = resolve(import.meta.dir, "..", "fixtures", "tune");
const STAGE = join(SCRIPTS, "stage-script.json");
const FAIL = join(SCRIPTS, "fail-script.json");
const GATED = join(SCRIPTS, "gated-script.json");
const HELD_OUT = ["fx-research-R-01", "fx-python-S-02", "fx-web-S-01"];

let t: Temp;
let set: string;
let home: string;
let failFrom: string;
let passFrom: string;

const tuneArgs = (from: string, name: string, out: string, extra: string[] = []) => ["tune", set, ...FAKE, "--base", "default", "--name", name, "--from", from, "--probe", "1", "--rounds", "1", "--gpu", "none", "--out", out, ...extra];
const ledger = () => readFileSync(join(home, "eval", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

beforeAll(async () => {
  t = temp("rlmh-tune-");
  set = buildFixtureSet(t.dir);
  home = t.home;
  failFrom = join(t.dir, "from-fail");
  passFrom = join(t.dir, "from-pass");
  for (const [out, script] of [[failFrom, FAIL], [passFrom, STAGE]] as const) {
    const r = await rlmh(["eval", set, "--split", "tune", "--gpu", "none", "--go", "--out", out, ...FAKE], { home, script, env: OFFLINE });
    if (r.code !== 0) throw new Error(`the --from eval failed: ${r.stderr}`);
  }
}, LONG);
afterAll(() => t.cleanup());

describe("rlmh tune --go", () => {
  test(
    "an accepted round: final/ is the INV candidate, <NAME> installed, one library entry and one tune ledger line; --continue adds round 2",
    async () => {
      const out = join(t.dir, "out-accepted");
      const before = ledger().length;
      const r = await rlmh([...tuneArgs(failFrom, "tuned", out), "--go", "--json"], { home, script: STAGE, env: OFFLINE });
      expect(r.stderr).not.toMatch(/the tune failed/);
      expect(r.code).toBe(0);
      const lines = jsonLines(r.stdout);
      const finished = lines.find((l) => l.type === "tune.finished");
      expect(finished).toMatchObject({ stopped: null, accepted_rounds: [1], cost_usd: 0 });
      expect(lines.filter((l) => l.type === "tune.stage").map((l) => [l.stage, l.decision])).toEqual([["inv", "EDIT"], ["dom", "KEEP_BASE"], ["compose", "ADOPT"], ["reflect", "RECORD"]]);
      const j = JSON.parse(readFileSync(join(out, "tune.json"), "utf8"));
      expect(j.rounds[0]).toMatchObject({ result: "accepted", accept: { accepted: true } });
      expect(j.rounds[0].stages.inv.changed).toEqual(["read.max_turns", "guidance", "scripts/fixture_tool.py", "skills/fixture-recipe/SKILL.md"]);
      const inv = join(out, "rounds", "1", "profiles", "tuned-r1-inv-a1");
      for (const f of ["profile.toml", "guidance.md", "skills/fixture-recipe/SKILL.md", "scripts/fixture_tool.py"]) {
        expect(readFileSync(join(out, "final", f), "utf8")).toBe(readFileSync(join(inv, f), "utf8"));
      }
      expect(readdirSync(join(home, "profiles")).filter((n) => n.startsWith("tuned"))).toEqual(["tuned"]);
      const entries = readdirSync(join(out, "library", "read", "entries"));
      expect(entries).toHaveLength(1);
      expect(readFileSync(join(out, "library", "read", "INDEX.md"), "utf8")).toContain("a question that counts lines of a long input");
      expect(ledger().slice(before).map((l) => l.what)).toEqual(["tune"]);
      for (const f of walk(join(out, "rounds", "1")).filter((p) => relative(out, p).replace(/\\/g, "/").includes("/evidence-"))) {
        const body = readFileSync(f, "utf8");
        for (const m of GRADE_MARKERS) expect(body, f).not.toContain(m);
        for (const id of HELD_OUT) expect(body, f).not.toContain(id);
      }

      const again = await rlmh(["tune", set, ...FAKE, "--base", "default", "--name", "tuned", "--continue", out, "--rounds", "2", "--gpu", "none", "--go", "--json"], { home, script: STAGE, env: OFFLINE });
      expect(again.stderr).not.toMatch(/the tune failed|Usage:/);
      expect(again.code).toBe(0);
      const k = JSON.parse(readFileSync(join(out, "tune.json"), "utf8"));
      expect(k.rounds).toHaveLength(2);
      expect(k.rounds[1].incumbent).toBe("tuned-r1");
      expect(readdirSync(join(home, "profiles")).filter((n) => n.startsWith("tuned"))).toEqual(["tuned"]);
    },
    LONG,
  );

  test(
    "from a passing --from the round is rejected: final/ is the base and nothing is installed",
    async () => {
      const out = join(t.dir, "out-rejected");
      const r = await rlmh([...tuneArgs(passFrom, "noluck", out), "--go"], { home, script: STAGE, env: OFFLINE });
      expect(r.code).toBe(0);
      const j = JSON.parse(readFileSync(join(out, "tune.json"), "utf8"));
      expect(j.rounds[0]).toMatchObject({ result: "rejected", accept: { accepted: false, reason: "passes" } });
      expect(existsSync(join(home, "profiles", "noluck"))).toBe(false);
      expect(readFileSync(join(out, "final", "guidance.md"), "utf8")).not.toContain("fixture-recipe");
    },
    LONG,
  );

  test(
    "the gate: --gated keeps the agent and the nudge; without it the INV edit falls back and the round has no candidates",
    async () => {
      const out = join(t.dir, "out-gated");
      const r = await rlmh([...tuneArgs(failFrom, "gatedone", out), "--gated", "--go", "--json"], { home, script: GATED, env: OFFLINE });
      expect(r.code).toBe(0);
      const j = JSON.parse(readFileSync(join(out, "tune.json"), "utf8"));
      expect(j.gated).toBe(true);
      expect(j.rounds[0].result).toBe("accepted");
      expect(existsSync(join(out, "final", "agents", "fixture-reader", "AGENT.md"))).toBe(true);
      expect(existsSync(join(out, "final", "nudges.toml"))).toBe(true);

      const plain = join(t.dir, "out-ungated");
      const u = await rlmh([...tuneArgs(failFrom, "ungated", plain), "--go", "--json"], { home, script: GATED, env: OFFLINE });
      expect(u.code).toBe(0);
      const k = JSON.parse(readFileSync(join(plain, "tune.json"), "utf8"));
      expect(k.gated).toBe(false);
      expect(k.rounds[0]).toMatchObject({ result: "no_candidates", stages: { inv: { attempts: 2, fell_back: true }, dom: { decision: "KEEP_BASE" } } });
    },
    LONG,
  );
});

describe("rlmh tune without --go, and its refusals", () => {
  test(
    "the estimate prints every stage, writes nothing and spends nothing",
    async () => {
      const out = join(t.dir, "out-estimate");
      const before = ledger().length;
      const r = await rlmh(tuneArgs(failFrom, "estimated", out), { home, script: STAGE, env: OFFLINE });
      expect(r.code).toBe(0);
      for (const s of ["inv session", "dom session", "probe inv", "compose session", "accept (tune split)", "reflect session"]) expect(r.stdout).toContain(s);
      expect(r.stdout).toContain("estimate: $0.00");
      expect(r.stdout).toContain("Nothing was run and nothing was spent");
      expect(existsSync(out)).toBe(false);
      expect(ledger()).toHaveLength(before);
    },
    REAL,
  );

  test(
    "exit 2: --base training-v4, --name default, another set's --from, another profile_hash, a non-empty --out",
    async () => {
      const no = async (args: string[], want: string) => {
        const r = await rlmh(args, { home, script: STAGE, env: OFFLINE });
        expect(r.stderr).toContain(want);
        expect(r.code).toBe(2);
      };
      await no(["tune", set, ...FAKE, "--base", "training-v4", "--name", "x1", "--from", failFrom, "--gpu", "none", "--probe", "1"], "never a tuning base");
      await no(["tune", set, ...FAKE, "--base", "default", "--name", "default", "--from", failFrom, "--gpu", "none", "--probe", "1"], "built-in");
      const other = join(t.dir, "other-set");
      cpSync(set, other, { recursive: true });
      editSet(other, (tasks) => void (tasks[0].question = `${tasks[0].question} (changed)`));
      await no(["tune", other, ...FAKE, "--base", "default", "--name", "x2", "--from", failFrom, "--gpu", "none", "--probe", "1"], "ran another set");
      const hashed = join(t.dir, "from-other-hash");
      cpSync(failFrom, hashed, { recursive: true });
      const meta = JSON.parse(readFileSync(join(hashed, "eval.json"), "utf8"));
      writeFileSync(join(hashed, "eval.json"), JSON.stringify({ ...meta, profile_hash: "0".repeat(64) }));
      await no(["tune", set, ...FAKE, "--base", "default", "--name", "x3", "--from", hashed, "--gpu", "none", "--probe", "1"], "profile_hash differs");
      const full = join(t.dir, "full-out");
      mkdirSync(full, { recursive: true });
      writeFileSync(join(full, "x"), "");
      await no(["tune", set, ...FAKE, "--base", "default", "--name", "x4", "--from", failFrom, "--gpu", "none", "--probe", "1", "--out", full], "is not empty");
      await no(["tune", set, ...FAKE, "--base", "default", "--name", "x5", "--from", failFrom, "--gpu", "none", "--probe", "9"], "more than the");
    },
    LONG,
  );
});
