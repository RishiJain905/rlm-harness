// KV cache: none
// loadSet's checks on the fixture set and on broken copies of it, all reported in one call, and
// selectTasks' split, only and stratified sample.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSet, SetError, selectTasks, stratum } from "../../src/eval/set.ts";
import { buildFixtureSet, editSet, TASK_IDS } from "./fixture.ts";

let tmp: string;
let n = 0;
const fresh = () => buildFixtureSet(join(tmp, `s${n++}`));

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rlmh-set-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("loadSet", () => {
  test("the fixture loads: six tasks across the five tracks", () => {
    const set = loadSet(fresh());
    expect(set.tasks.map((t) => t.id)).toEqual(TASK_IDS);
    expect(new Set(set.tasks.map((t) => t.track))).toEqual(new Set(["python", "web", "kernel", "research", "search"]));
    expect([...set.venvs.keys()]).toEqual(["fx", "fx-kernel", "fx-src"]);
    expect(set.nodeEnvs.get("fx-web")).toEqual({ node: "22", pnpm: "10.34.7", playwright: "1.57.0" });
    expect(set.manifest.permission_mode).toBe("bypass");
  });

  test("text grading with aliases loads", () => {
    const g = loadSet(fresh()).grades.get("fx-research-R-01")!;
    expect(g.grader).toBe("answer");
    expect(g.grader === "answer" && g.grading).toEqual({ type: "text", aliases: ["Augusta Ada King"], blind: null, ignore: ["who"] });
  });

  test("every problem is reported in one call", () => {
    const dir = fresh();
    editSet(dir, (tasks, grades) => {
      const t = (id: string) => tasks.find((x) => x.id === id);
      const g = (id: string) => grades.find((x) => x.id === id);
      tasks.push({ ...t("fx-search-R-01") }); // a duplicate id
      tasks.push({ ...t("fx-python-S-01"), id: "fx-python-S-09" }); // a task without a grade
      t("fx-search-R-01").input = ["../outside.txt"]; // a path with ..
      g("fx-research-R-01").pass_score = 0;
      t("fx-python-S-02").size = "R"; // kind repo with size R
      t("fx-web-S-01").kind = "read"; // track web with kind read
      t("fx-python-S-01").venv = "nope"; // a missing venv file
      g("fx-web-S-01").runner = "pytest"; // pytest on a web task
      delete t("fx-kernel-S-01").requires; // a kernel task without requires
    });
    const err = (() => {
      try {
        loadSet(dir);
      } catch (e) {
        return e as SetError;
      }
      throw new Error("loadSet accepted a broken set");
    })();
    expect(err).toBeInstanceOf(SetError);
    const all = err.problems.join("\n");
    for (const want of [
      "task fx-search-R-01: the id is used twice",
      "task fx-python-S-09: it has no grade",
      'task fx-search-R-01: input "../outside.txt" has a .. part',
      "grade fx-research-R-01: pass_score must be a number above 0 and at most 1",
      "task fx-python-S-02: a repo task's size is S, M, L",
      "task fx-web-S-01: track web has kind repo",
      "venvs/nope.json is missing",
      "grade fx-web-S-01: a web task's runner is playwright",
      'task fx-kernel-S-01: a kernel task must carry requires: ["gpu"]',
    ]) {
      expect(all).toContain(want);
    }
  });

  test("a changed byte, a missing node env, two playwright pins and requires: [cuda] are reported together", () => {
    const dir = fresh();
    appendFileSync(join(dir, "tasks.jsonl"), "\n"); // the hash no longer matches
    unlinkSync(join(dir, "nodeenvs", "fx-web.json"));
    const err = (() => {
      try {
        loadSet(dir);
      } catch (e) {
        return e as SetError;
      }
      throw new Error("accepted");
    })();
    expect(err.problems).toContain("tasks.jsonl: its sha256 doesn't match manifest.json's tasks_sha256");
    expect(err.problems).toContain("nodeenvs/fx-web.json is missing");

    const two = fresh();
    writeFileSync(join(two, "nodeenvs", "fx-web2.json"), JSON.stringify({ node: "22", pnpm: "10.34.7", playwright: "1.58.0" }));
    editSet(two, (tasks, grades) => {
      tasks.push({ ...tasks.find((x) => x.id === "fx-web-S-01"), id: "fx-web-S-02", node_env: "fx-web2" });
      grades.push({ ...grades.find((x) => x.id === "fx-web-S-01"), id: "fx-web-S-02", hidden: "hidden/fx-web-S-01.tar.gz" });
      tasks.find((x) => x.id === "fx-kernel-S-01").requires = ["cuda"];
    });
    const err2 = (() => {
      try {
        loadSet(two);
      } catch (e) {
        return e as SetError;
      }
      throw new Error("accepted");
    })();
    const all = err2.problems.join("\n");
    expect(all).toContain("every node env must pin the same playwright (found 1.57.0, 1.58.0)");
    expect(all).toContain('requires must be a list whose only value is "gpu"');
  });

  test("an unvalidated set is refused", () => {
    const dir = fresh();
    const m = JSON.parse(require("node:fs").readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, validated: false }));
    expect(() => loadSet(dir)).toThrow("validated is not true");
  });
});

describe("selectTasks", () => {
  test("--split and --only", () => {
    const set = loadSet(fresh());
    expect(selectTasks(set, { split: "tune" }).map((t) => t.id)).toEqual(["fx-search-R-01", "fx-python-S-01", "fx-kernel-S-01"]);
    expect(selectTasks(set, { split: "heldout" }).map((t) => t.id)).toEqual(["fx-research-R-01", "fx-python-S-02", "fx-web-S-01"]);
    expect(selectTasks(set, { only: ["fx-web-S-01", "fx-search-R-01"] }).map((t) => t.id)).toEqual(["fx-search-R-01", "fx-web-S-01"]);
    expect(selectTasks(set, { skipGpu: true }).map((t) => t.id)).not.toContain("fx-kernel-S-01");
    expect(() => selectTasks(set, { only: ["fx-nope-S-01"] })).toThrow("--only names tasks the set doesn't have");
  });

  test("--sample 3 --seed a twice gives the same three ids, from three strata, in file order", () => {
    const set = loadSet(fresh());
    const a = selectTasks(set, { sample: 3, seed: "a" });
    const b = selectTasks(set, { sample: 3, seed: "a" });
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
    expect(a.length).toBe(3);
    expect(new Set(a.map(stratum)).size).toBe(3);
    expect(a.map((t) => t.id)).toEqual(set.tasks.filter((t) => a.includes(t)).map((t) => t.id));
    expect(() => selectTasks(set, { sample: 3 })).toThrow("--sample needs --seed");
  });
});
