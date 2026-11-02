// KV cache: none
// The read grader against training's own outputs: reward-vectors.json was written by running rlm_rl/reward.py at
// RLM commit 705ebcf over its inputs (task 4); nothing in it is typed by hand.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leakSuspect, readPassed } from "../../src/eval/graders.ts";
import { GradingError, checkGrading, scoreAnswer } from "../../src/eval/reward.ts";

interface Vector {
  name: string;
  type: string;
  answer: unknown;
  gold: unknown;
  grading: Record<string, unknown>;
  score?: number;
  exact?: boolean;
  components?: Record<string, number>;
  f1?: number;
  error?: string;
}

interface Check {
  grading: unknown;
  gold: unknown;
  problems: string[];
}

const FILE = join(import.meta.dir, "reward-vectors.json");
const DATA = JSON.parse(readFileSync(FILE, "utf8")) as {
  source: { repo: string; commit: string; file: string; command: string };
  vectors: Vector[];
  checks: Check[];
};

/** What Python would print for the error the port threw: check_grading's ValueError is our GradingError. */
function pythonError(err: unknown): string {
  if (err instanceof GradingError) return `ValueError: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

describe("reward-vectors.json", () => {
  test("names training's file and commit, as reward.ts's header does", () => {
    expect(DATA.source).toMatchObject({ repo: "RishiJain905/rlm", commit: "705ebcf", file: "rlm_rl/reward.py" });
    expect(DATA.source.command).toContain("705ebcf");
    const header = readFileSync(join(import.meta.dir, "..", "..", "src", "eval", "reward.ts"), "utf8")
      .split("\n").slice(0, 3).join("\n");
    expect(header.startsWith("// KV cache: none\n")).toBe(true);
    expect(header).toContain("rlm_rl/reward.py");
    expect(header).toContain(`commit ${DATA.source.commit}`);
  });

  test("covers every answer type, text most of all", () => {
    const counts = new Map<string, number>();
    for (const v of DATA.vectors) counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
    for (const type of ["int", "float", "count", "entity", "list", "text"]) expect(counts.get(type) ?? 0).toBeGreaterThan(0);
    expect(counts.get("text")!).toBeGreaterThanOrEqual(30);
    expect(DATA.vectors.length).toBeGreaterThanOrEqual(90);
  });
});

describe("scoreAnswer", () => {
  for (const v of DATA.vectors) {
    test(`${v.type}: ${v.name}`, () => {
      if (v.error !== undefined) {
        let thrown: unknown;
        try {
          scoreAnswer(v.answer, v.gold, v.grading);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeDefined();
        expect(pythonError(thrown)).toBe(v.error);
        return;
      }
      const got = scoreAnswer(v.answer, v.gold, v.grading);
      expect(got.score).toBeCloseTo(v.score!, 4);
      expect(got.exact).toBe(v.exact!);
      if (v.f1 !== undefined) expect(got.f1).toBeCloseTo(v.f1, 4);
      else expect(got.f1).toBeUndefined();
      expect(Object.keys(got.components).sort()).toEqual(Object.keys(v.components!).sort());
      for (const [key, want] of Object.entries(v.components!)) expect(got.components[key]).toBeCloseTo(want, 4);
    });
  }
});

describe("checkGrading", () => {
  for (const c of DATA.checks) {
    const verdict = c.problems.length ? "refuses" : "accepts";
    test(`${verdict} ${JSON.stringify(c.grading)} with gold ${JSON.stringify(c.gold)}`, () => {
      expect(checkGrading(c.grading, c.gold)).toEqual(c.problems);
    });
  }

  test("a grading that is not an object is one problem", () => {
    expect(checkGrading(null, "x")).toHaveLength(1);
    expect(checkGrading(["text"], "x")).toHaveLength(1);
  });

  test("scoreAnswer throws what checkGrading reports", () => {
    expect(() => scoreAnswer("x", "x", { type: "edit" })).toThrow(GradingError);
    expect(() => scoreAnswer("x", "x", { type: "edit" })).toThrow(checkGrading({ type: "edit" }, "x")[0]!);
  });
});

describe("readPassed", () => {
  test("a 0.8 list score passes with pass_score 0.8 and fails without (D-170, D-224)", () => {
    expect(readPassed(0.8, { pass_score: 0.8 })).toBe(true);
    expect(readPassed(0.8, {})).toBe(false);
    expect(readPassed(0.79, { pass_score: 0.8 })).toBe(false);
    expect(readPassed(1, {})).toBe(true);
  });
});

describe("leakSuspect", () => {
  const grade = { id: "x", grader: "tests" as const, runner: "pytest" as const, hidden: "hidden/x.tar.gz", f2p: ["tests/test_fix.py::TestX::test_add_negative[1]"], p2p: [], files: [], timeout_s: 1 };
  test("the set's path (either separator), hidden/, or an f2p function name", () => {
    const setDir = process.platform === "win32" ? "D:\\RLM-data\\set" : "/data/set";
    expect(leakSuspect([{ role: "user", content: "fix it" }], { setDir, grade })).toBe(false);
    expect(leakSuspect([{ role: "assistant", content: `open('${setDir.replace(/\\/g, "/")}/grades.jsonl')` }], { setDir, grade })).toBe(true);
    expect(leakSuspect([{ role: "assistant", content: `ls ${setDir}` }], { setDir, grade })).toBe(true);
    expect(leakSuspect([{ role: "tool", content: "see hidden/x.tar.gz" }], { setDir, grade })).toBe(true);
    expect(leakSuspect([{ role: "assistant", content: "run test_add_negative" }], { setDir, grade })).toBe(true);
    const web = { ...grade, runner: "playwright" as const, f2p: ["task-1.spec.js::short", "task-2.spec.js::the heading shows the greeting"] };
    expect(leakSuspect([{ role: "assistant", content: "short" }], { setDir, grade: web })).toBe(false);
    expect(leakSuspect([{ role: "assistant", content: "The heading shows the greeting" }], { setDir, grade: web })).toBe(process.platform === "win32" || process.platform === "darwin");
  });
});
