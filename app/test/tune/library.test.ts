// KV cache: none
// library.ts: NO_ENTRY writes nothing, an entry writes its files and its INDEX line, a deleted entry
// drops out of a rebuilt index, and a grade marker throws.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addEntry, rebuildIndex } from "../../src/tune/library.ts";
import { temp } from "../cli/helpers.ts";

const t = temp("rlmh-lib-");
afterAll(() => t.cleanup());

const harness = (() => {
  const dir = join(t.dir, "composed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.toml"), "[read]\nmax_turns = 60\n");
  writeFileSync(join(dir, "guidance.md"), "Scan first.\n");
  return dir;
})();
const ENTRY = { cue: "a question whose answer takes two hops", lesson: "in guidance.md, scan each hop worded as asked", evidence: "row 1: guidance helped", confidence: "medium" as const };
const EDITS = [{ component: "guidance.md", candidates: "inv", change: "a scan rule", observed: "the inv run scanned twice", verdict: "helped" as const }];

describe("the library", () => {
  test("NO_ENTRY writes nothing", () => {
    const root = join(t.dir, "lib-none");
    expect(addEntry(root, "read", "t1-r1", "NO_ENTRY", EDITS, harness)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  test("an entry writes EXPERIENCE.md, its harness and an INDEX line; deleting it and rebuilding drops the line", () => {
    const root = join(t.dir, "lib");
    expect(addEntry(root, "read", "t1-r1", ENTRY, EDITS, harness)).toBe(true);
    expect(addEntry(root, "read", "t1-r2", { ...ENTRY, cue: "a list question" }, [], harness)).toBe(true);
    const exp = readFileSync(join(root, "read", "entries", "t1-r1", "EXPERIENCE.md"), "utf8");
    expect(exp).toContain("cue: a question whose answer takes two hops");
    expect(exp).toContain("| guidance.md | inv | a scan rule | the inv run scanned twice | helped |");
    expect(readFileSync(join(root, "read", "entries", "t1-r1", "harness", "guidance.md"), "utf8")).toBe("Scan first.\n");
    const index = readFileSync(join(root, "read", "INDEX.md"), "utf8");
    expect(index).toContain("- a question whose answer takes two hops -> entries/t1-r1/EXPERIENCE.md\n- a list question -> entries/t1-r2/EXPERIENCE.md");
    rmSync(join(root, "read", "entries", "t1-r1"), { recursive: true });
    rebuildIndex(root, "read");
    expect(readFileSync(join(root, "read", "INDEX.md"), "utf8")).not.toContain("t1-r1");
  });

  test("a grade marker anywhere throws", () => {
    const root = join(t.dir, "lib-marked");
    expect(() => addEntry(root, "repo", "t2-r1", { ...ENTRY, evidence: "the f2p_share rose" }, EDITS, harness)).toThrow("f2p_share");
    expect(existsSync(join(root, "repo", "entries", "t2-r1"))).toBe(false);
  });
});
