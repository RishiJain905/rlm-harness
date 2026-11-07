// KV cache: none
// candidate.ts: editToml keeps comments and order, writeCandidate copies and edits a profile folder and
// refuses paths off the surface, diffProfiles shows a change, and install/uninstall touch only the tune's own.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CandidateError, diffProfiles, editToml, installProfile, uninstallProfiles, writeCandidate } from "../../src/tune/candidate.ts";
import { temp } from "../cli/helpers.ts";

const t = temp("rlmh-cand-");
afterAll(() => t.cleanup());

const TOML = `# a profile
contract = "v4"   # frozen

[read]
max_turns = 50            # D-152
max_subcalls = 100

[repo]
max_turns = 150
`;

function baseProfile(dir: string): string {
  mkdirSync(join(dir, "skills", "old-one"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "profile.toml"), TOML);
  writeFileSync(join(dir, "guidance.md"), "Use old-one.\n");
  writeFileSync(join(dir, "skills", "old-one", "SKILL.md"), "---\nname: old-one\ndescription: old\n---\ntext\n");
  writeFileSync(join(dir, "scripts", "helper.py"), "X = 1\n");
  return dir;
}

describe("editToml", () => {
  test("replaces a value and keeps the comment, inserts a missing key, appends a missing table", () => {
    const out = editToml(TOML, { "read.max_turns": 60, "read.submit_check": 0.5, "rlm.max_runs": 4, "repo.pace_nudge": true, "root.temperature": 0.25 });
    expect(out).toContain("max_turns = 60  # D-152");
    expect(out).toContain('contract = "v4"   # frozen'); // untouched bytes
    const lines = out.split("\n");
    expect(lines.indexOf("submit_check = 0.5")).toBe(lines.indexOf("max_subcalls = 100") + 1);
    expect(out).toContain("[repo]\nmax_turns = 150\npace_nudge = true\n");
    expect(out).toContain("\n[rlm]\nmax_runs = 4\n");
    expect(out).toContain("\n[root]\ntemperature = 0.25\n");
    expect(out.startsWith("# a profile\n")).toBe(true);
  });

  test("values are TOML: integers, floats with a dot, JSON-quoted strings", () => {
    const out = editToml("[repo]\nsubcall_thinking = \"low\"\n", { "repo.subcall_thinking": "high", "repo.max_turns": 1e2 });
    expect(out).toBe('[repo]\nsubcall_thinking = "high"\nmax_turns = 100\n');
    expect(() => editToml(TOML, { nope: 1 })).toThrow(CandidateError);
  });
});

describe("writeCandidate", () => {
  test("copies skills and scripts, applies files, writes LF bytes", () => {
    const base = baseProfile(join(t.dir, "base"));
    const dir = join(t.dir, "cand");
    writeCandidate(dir, base, {
      guidance: "Use new-one and old-one.\r\n",
      toml: { "read.max_turns": 60 },
      files: { "skills/new-one/SKILL.md": "---\nname: new-one\ndescription: new\n---\nhi\r\n", "scripts/helper.py": "X = 2\n", "scripts/gone.py": null },
    });
    expect(readFileSync(join(dir, "guidance.md"), "utf8")).toBe("Use new-one and old-one.\n");
    expect(readFileSync(join(dir, "skills", "old-one", "SKILL.md"), "utf8")).toContain("name: old-one");
    expect(readFileSync(join(dir, "skills", "new-one", "SKILL.md"), "utf8")).toBe("---\nname: new-one\ndescription: new\n---\nhi\n");
    expect(readFileSync(join(dir, "scripts", "helper.py"), "utf8")).toBe("X = 2\n");
    expect(readFileSync(join(dir, "profile.toml"), "utf8")).toContain("max_turns = 60  # D-152");
    for (const f of ["guidance.md", "profile.toml"]) expect(readFileSync(join(dir, f)).includes(13)).toBe(false);

    const removed = join(t.dir, "cand-removed");
    writeCandidate(removed, base, { guidance: null, toml: {}, files: { "scripts/helper.py": null, "skills/old-one/SKILL.md": null } });
    expect(existsSync(join(removed, "scripts"))).toBe(false);
    expect(existsSync(join(removed, "skills"))).toBe(false);
    expect(readFileSync(join(removed, "guidance.md"), "utf8")).toBe("Use old-one.\n");
  });

  test("refuses paths off the surface before writing anything", () => {
    const base = baseProfile(join(t.dir, "base2"));
    const bad = (files: Record<string, string | null>, want: string) => {
      const dir = join(t.dir, `bad-${Math.random().toString(36).slice(2)}`);
      expect(() => writeCandidate(dir, base, { guidance: null, toml: {}, files })).toThrow(want);
      expect(existsSync(dir)).toBe(false);
    };
    bad({ "../x": "x" }, "..");
    bad({ "/etc/x": "x" }, "absolute");
    bad({ "skills\\a\\SKILL.md": "x" }, "use /");
    bad({ "profile.toml": "x" }, "through toml");
    bad({ "agents/reader/AGENT.md": "x" }, "need --gated");
    bad({ "notes.txt": "x" }, "only skills/");
    const gated = join(t.dir, "gated");
    writeCandidate(gated, base, { guidance: null, toml: {}, files: { "agents/reader/AGENT.md": "---\nname: reader\n---\nx\n", "nudges.toml": "" } }, { gated: true });
    expect(existsSync(join(gated, "agents", "reader", "AGENT.md"))).toBe(true);
  });
});

describe("system.md (D-256)", () => {
  test("a rlmh-1 base's system.md is copied, or replaced by edit.system; a v4 base refuses one", () => {
    const base = baseProfile(join(t.dir, "base-sys"));
    writeFileSync(join(base, "system.md"), "You are a model.\n");
    const kept = join(t.dir, "sys-kept");
    writeCandidate(kept, base, { guidance: null, system: null, toml: {} });
    expect(readFileSync(join(kept, "system.md"), "utf8")).toBe("You are a model.\n");
    const changed = join(t.dir, "sys-changed");
    writeCandidate(changed, base, { guidance: null, system: "You are a careful model.\r\n", toml: {} });
    expect(readFileSync(join(changed, "system.md"), "utf8")).toBe("You are a careful model.\n");
    const v4 = baseProfile(join(t.dir, "base-v4"));
    const refused = join(t.dir, "sys-refused");
    expect(() => writeCandidate(refused, v4, { guidance: null, system: "x", toml: {} })).toThrow("prompt v4");
    expect(existsSync(refused)).toBe(false);
    expect(() => writeCandidate(join(t.dir, "sys-files"), base, { guidance: null, toml: {}, files: { "system.md": "x" } })).toThrow("through system");
  });
});

describe("diffProfiles, install and uninstall", () => {
  test("the diff shows a change and a new skill; '' when equal", async () => {
    const base = baseProfile(join(t.dir, "base3"));
    const dir = join(t.dir, "cand3");
    writeCandidate(dir, base, { guidance: "Use old-one and fresh.\n", toml: {}, files: { "skills/fresh/SKILL.md": "---\nname: fresh\ndescription: f\n---\nx\n" } });
    const diff = await diffProfiles(base, dir);
    expect(diff).toContain("+Use old-one and fresh.");
    expect(diff).toContain("skills/fresh/SKILL.md");
    const same = join(t.dir, "same3");
    writeCandidate(same, base, { guidance: null, toml: {} });
    expect(await diffProfiles(base, same)).toBe("");
  });

  test("installProfile copies the subfolders and refuses an existing one; uninstall leaves others", () => {
    const home = join(t.dir, "home");
    const base = baseProfile(join(t.dir, "base4"));
    installProfile(home, base, "mine-r1-inv");
    expect(existsSync(join(home, "profiles", "mine-r1-inv", "skills", "old-one", "SKILL.md"))).toBe(true);
    expect(() => installProfile(home, base, "mine-r1-inv")).toThrow("already exists");
    mkdirSync(join(home, "profiles", "users-own"), { recursive: true });
    uninstallProfiles(home, ["mine-r1-inv"]);
    expect(existsSync(join(home, "profiles", "mine-r1-inv"))).toBe(false);
    expect(existsSync(join(home, "profiles", "users-own"))).toBe(true);
  });

  test("SR-6: a name that is not one plain folder name (from a tune.json) is refused by install and uninstall", () => {
    const home = join(t.dir, "home6");
    const base = baseProfile(join(t.dir, "base6"));
    mkdirSync(join(home, "profiles", "users-own"), { recursive: true });
    writeFileSync(join(home, "settings.toml"), "profile = \"default\"\n");
    for (const name of ["..", "../x", "a/b", ".hidden", "", "x".repeat(57)]) {
      expect(() => installProfile(home, base, name), name).toThrow("not a profile name");
      expect(() => uninstallProfiles(home, [name]), name).toThrow("not a profile name");
    }
    expect(existsSync(join(home, "profiles", "users-own"))).toBe(true);
    expect(existsSync(join(home, "settings.toml"))).toBe(true);
  });
});
