// KV cache: none
// evidence.ts: each stage's layout, a trajectoryText snapshot, the read guard on grades and hidden tests,
// withheld runs (a hidden test path, the set path written with \), all withheld throws, and no held-out id
// from an all-split eval output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSet, type EvalSet } from "../../src/eval/set.ts";
import { EvidenceLeak, guardRead, readRecords, scanTree, trajectoryText, WITHHELD, writeEvidence, type EvidenceSpec } from "../../src/tune/evidence.ts";
import { secretsOf } from "../../src/tune/offline.ts";
import { temp } from "../cli/helpers.ts";
import { buildFixtureSet } from "../eval/fixture.ts";

const t = temp("rlmh-evid-");
let set: EvalSet;
let harness: string;
beforeAll(() => {
  set = loadSet(buildFixtureSet(t.dir));
  harness = join(t.dir, "harness");
  mkdirSync(join(harness, "skills", "fixture-recipe"), { recursive: true });
  mkdirSync(join(harness, "scripts"), { recursive: true });
  writeFileSync(join(harness, "profile.toml"), "[read]\nmax_turns = 50\n");
  writeFileSync(join(harness, "guidance.md"), "When counting lines, call skill(\"fixture-recipe\").\n");
  writeFileSync(join(harness, "skills", "fixture-recipe", "SKILL.md"), "---\nname: fixture-recipe\ndescription: count\n---\nuse scripts/fixture_tool.py\n");
  writeFileSync(join(harness, "scripts", "fixture_tool.py"), "def count(s):\n    return len(s.splitlines())\n");
});
afterAll(() => t.cleanup());

/** A hand-made run record, as runs.jsonl holds one. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "r_1",
    tag: "fx-search-R-01",
    mode: "read",
    submitted: true,
    answer: 5,
    infra_kind: null,
    turns: [
      { turn: 1, reply: "Count the lines.", reasoning: "SECRET REASONING", code: "n = len(context.splitlines())\nprint(n)", stdout: "5\n", error: null },
      { turn: 2, reply: "", code: "submit(n)", stdout: "", error: null },
    ],
    subcalls: [{ subcall_id: 1, origin: { turn: 1, line: 1 }, prompt: "x".repeat(42), output: "five lines", error: null }],
    children: [],
    compactions: [],
    ...over,
  };
}

const spec = (dir: string, over: Partial<EvidenceSpec> = {}): EvidenceSpec => ({
  stage: "inv",
  round: 1,
  attempt: 1,
  harnessDir: harness,
  systemPrompt: "You are a Recursive Language Model.",
  tasks: set.tasks,
  setDir: set.dir,
  runs: [
    { taskId: "fx-search-R-01", label: "ref", record: record() },
    { taskId: "fx-python-S-01", label: "ref", record: record({ tag: "fx-python-S-01", mode: "repo", diff: "--- a/calc.py\n+++ b/calc.py\n" }) },
  ],
  secrets: secretsOf(set),
  ...over,
  ...(dir ? {} : {}),
});

describe("trajectoryText", () => {
  test("a hand-made record, reasoning left out, sub-calls under their turn", () => {
    const text = trajectoryText(record());
    expect(text).not.toContain("SECRET REASONING");
    expect(text).toContain("- sub-call 1: 42 prompt chars, ok: five lines");
    expect(text).toMatchSnapshot();
  });
});

describe("writeEvidence", () => {
  test("the editor's layout, with the harness's skills and scripts", () => {
    const dir = join(t.dir, "ev-inv");
    const r = writeEvidence(dir, spec(dir));
    const rel = r.files.map((f) => f.slice(dir.length + 1).replace(/\\/g, "/"));
    expect(rel).toEqual([
      "harness/guidance.md",
      "harness/profile.toml",
      "harness/scripts/fixture_tool.py",
      "harness/skills/fixture-recipe/SKILL.md",
      "harness/system_prompt.md",
      "history.md",
      "stage.md",
      "tasks/fx-python-S-01/ref/deliverable.md",
      "tasks/fx-python-S-01/ref/trajectory.md",
      "tasks/fx-python-S-01/task.md",
      "tasks/fx-search-R-01/ref/deliverable.md",
      "tasks/fx-search-R-01/ref/trajectory.md",
      "tasks/fx-search-R-01/task.md",
    ]);
    expect(readFileSync(join(dir, "stage.md"), "utf8")).toBe("stage: inv\nround: 1\nattempt: 1\n");
    const task = readFileSync(join(dir, "tasks", "fx-search-R-01", "task.md"), "utf8");
    expect(task).toContain("- log.txt: ");
    expect(task).not.toContain("worker ready"); // the input's contents are never shown
    const repo = readFileSync(join(dir, "tasks", "fx-python-S-01", "task.md"), "utf8");
    expect(repo).toContain("{python} -m pytest");
    expect(repo).toMatch(/\d+ files/);
    expect(readFileSync(join(dir, "tasks", "fx-search-R-01", "ref", "deliverable.md"), "utf8")).toBe("5\n");
  });

  test("the composer's and reflector's extra folders", () => {
    const dir = join(t.dir, "ev-compose");
    const r = writeEvidence(dir, {
      ...spec(dir),
      stage: "compose",
      candidates: [
        { label: "inv", diff: "diff --git a b\n+x\n", notes: ["added a skill"] },
        { label: "dom", diff: "", notes: [] },
      ],
      composedDiff: "",
      history: "## Round 1\n- kept -> x -> y\n",
    });
    const rel = r.files.map((f) => f.slice(dir.length + 1).replace(/\\/g, "/"));
    for (const f of ["candidates/inv/diff.md", "candidates/inv/notes.md", "candidates/dom/diff.md", "candidates/composed/diff.md"]) expect(rel).toContain(f);
    expect(readFileSync(join(dir, "candidates", "inv", "notes.md"), "utf8")).toBe("- added a skill\n");
    expect(readFileSync(join(dir, "history.md"), "utf8")).toContain("kept -> x -> y");
  });

  test("a run naming a hidden test path, or the set path written with \\, is withheld; the rest stay", () => {
    const dir = join(t.dir, "ev-withheld");
    const backslashed = set.dir.replace(/\//g, "\\");
    const r = writeEvidence(dir, {
      ...spec(dir),
      runs: [
        { taskId: "fx-search-R-01", label: "ref", record: record() },
        { taskId: "fx-python-S-01", label: "ref", record: record({ tag: "fx-python-S-01", turns: [{ turn: 1, code: "open('tests/test_fix.py')", stdout: "" }] }) },
        { taskId: "fx-python-S-02", label: "ref", record: record({ tag: "fx-python-S-02", turns: [{ turn: 1, code: "print(1)", stdout: `${backslashed}\\ctx\n` }] }) },
      ],
    });
    expect(r.withheld.map((w) => w.taskId).sort()).toEqual(["fx-python-S-01", "fx-python-S-02"]);
    expect(readFileSync(join(dir, "tasks", "fx-python-S-01", "ref", "trajectory.md"), "utf8")).toBe(`${WITHHELD}\n`);
    expect(readFileSync(join(dir, "tasks", "fx-search-R-01", "ref", "trajectory.md"), "utf8")).toContain("## Turn 1");
  });

  test("a p2p test the repository already has is not a leak (D-253)", () => {
    const dir = join(t.dir, "ev-p2p");
    const r = writeEvidence(dir, { ...spec(dir), runs: [{ taskId: "fx-python-S-01", label: "ref", record: record({ tag: "fx-python-S-01", turns: [{ turn: 1, code: "shell('pytest -v')", stdout: "tests/test_basic.py::test_mul PASSED\n" }] }) }] });
    expect(r.withheld).toEqual([]);
  });

  test("every run withheld throws; a record with gold throws; a marker in a file name throws from scanTree", () => {
    const dir = join(t.dir, "ev-all");
    expect(() => writeEvidence(dir, { ...spec(dir), runs: [{ taskId: "fx-search-R-01", label: "ref", record: record({ turns: [{ turn: 1, code: "", stdout: "tests/test_fix.py::test_add\n" }] }) }] })).toThrow(EvidenceLeak);
    expect(() => writeEvidence(join(t.dir, "ev-gold"), { ...spec(dir), runs: [{ taskId: "fx-search-R-01", label: "ref", record: record({ gold: 5 }) }] })).toThrow("gold");
    const bad = join(t.dir, "marked");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "f2p_share.md"), "x");
    expect(() => scanTree(bad)).toThrow(EvidenceLeak);
    const inBody = join(t.dir, "marked-body");
    mkdirSync(inBody, { recursive: true });
    writeFileSync(join(inBody, "x.md"), "<testsuites>");
    expect(() => scanTree(inBody)).toThrow(EvidenceLeak);
  });
});

describe("the read guard", () => {
  test("grades.jsonl, grade-logs/ and the set's hidden/ are never read", () => {
    expect(() => guardRead(join(t.dir, "out", "grades.jsonl"))).toThrow(EvidenceLeak);
    expect(() => guardRead(join(t.dir, "out", "grade-logs", "x"))).toThrow(EvidenceLeak);
    expect(() => guardRead(join(set.dir, "hidden", "fx-python-S-01.tar.gz"), set.dir)).toThrow(EvidenceLeak);
    expect(() => guardRead(join(set.dir, "tasks.jsonl"), set.dir)).not.toThrow();
  });

  test("from an all-split output only the tune ids are read, and a rerun line replaces its original", () => {
    const out = join(t.dir, "all-out");
    mkdirSync(join(out, "rerun"), { recursive: true });
    const lines = set.tasks.map((x) => JSON.stringify(record({ tag: x.id, run_id: `r_${x.id}` }))).join("\n");
    writeFileSync(join(out, "runs.jsonl"), `${lines}\n`);
    writeFileSync(join(out, "rerun", "runs.jsonl"), `${JSON.stringify(record({ tag: "fx-search-R-01", run_id: "r_again" }))}\n`);
    const tuneIds = new Set(set.tasks.filter((x) => x.split === "tune").map((x) => x.id));
    const recs = readRecords(out, tuneIds);
    expect([...recs.keys()].sort()).toEqual([...tuneIds].sort());
    expect(recs.get("fx-search-R-01")!.run_id).toBe("r_again");
    const dir = join(t.dir, "ev-tune-only");
    writeEvidence(dir, { ...spec(dir), runs: [...recs].map(([taskId, r]) => ({ taskId, label: "ref", record: r })) });
    for (const held of set.tasks.filter((x) => x.split === "heldout")) expect(existsSync(join(dir, "tasks", held.id))).toBe(false);
    const all = JSON.stringify(readFileSync(join(dir, "history.md"), "utf8"));
    expect(all).not.toContain("heldout");
  });
});
