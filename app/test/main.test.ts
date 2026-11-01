// KV cache: none
// main.ts: run and batch check their arguments and inputs before the engine check, which on a fresh
// installed binary would offer to download Python. A source checkout always finds its engine, so the
// order can't be seen from outside; main() takes the engine check as a dependency, and a spy stands in.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIO } from "../src/cli/run.ts";
import { main } from "../src/main.ts";
import { rlmh } from "./cli/helpers.ts";

// built at load, because the test tables below are built at load too
const dir = realpathSync(mkdtempSync(join(tmpdir(), "rlmh-main-")));
const input = join(dir, "in.txt");
const repo = join(dir, "repo");
const tasks = join(dir, "tasks.jsonl");
writeFileSync(input, "text\n");
mkdirSync(repo);
writeFileSync(tasks, `${JSON.stringify({ id: "a", question: "Q?", input: "in.txt" })}\n`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A CliIO that keeps what is written, and an engine check that counts its calls and gives `answer`. */
function rig(answer: number | null = null) {
  const err: string[] = [];
  const out: string[] = [];
  const io: CliIO = {
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    stdin: process.stdin,
    isTTY: false,
    home: join(dir, "home"),
  };
  const calls = { engineReady: 0 };
  const engineReady = async () => {
    calls.engineReady += 1;
    return answer;
  };
  return { io, deps: { io, engineReady }, calls, stderr: () => err.join(""), stdout: () => out.join("") };
}

const FAKE = ["--root", "fake/scripted"];

describe("run: usage and inputs are checked before the engine check", () => {
  const bad: [string, string[], string][] = [
    ["no arguments", ["run"], "--question"],
    ["an unknown flag", ["run", "--nope"], "nope"],
    ["--input without --question", ["run", "--input", input, ...FAKE], "--input needs --question"],
    ["a missing input file", ["run", "--question", "Q?", "--input", join(dir, "missing.txt"), ...FAKE], "no such input file"],
    ["a folder given as an input", ["run", "--question", "Q?", "--input", dir, ...FAKE], "no such input file"],
    ["a missing repo folder", ["run", "--task", "T", "--repo", join(dir, "nowhere"), ...FAKE], "the repo path is not a folder"],
    ["a bad enum", ["run", "--question", "Q?", "--input", input, ...FAKE, "--call-format", "xml"], "call format"],
    ["no root model", ["run", "--question", "Q?", "--input", input], "rlmh config set root.model"],
  ];
  for (const [name, args, says] of bad) {
    test(name, async () => {
      const r = rig();
      expect(await main(args, r.deps)).toBe(2);
      expect(r.stderr()).toContain(says);
      expect(r.calls.engineReady).toBe(0);
    });
  }

  test("valid arguments reach the engine check once, and its refusal stops the command", async () => {
    for (const args of [
      ["run", "--question", "Q?", "--input", input, ...FAKE],
      ["run", "--task", "T", "--repo", repo, ...FAKE],
    ]) {
      const r = rig(1);
      expect(await main(args, r.deps)).toBe(1);
      expect(r.calls.engineReady).toBe(1);
      expect(r.stderr()).toBe(""); // preflight said nothing: it only speaks when it refuses
    }
  });
});

describe("batch: the tasks file is checked before the engine check", () => {
  test("a missing tasks file, a bad line, a missing input, a bad --jobs and a bad flag", async () => {
    const badLine = join(dir, "bad-line.jsonl");
    writeFileSync(badLine, "{not json\n");
    const noInput = join(dir, "no-input.jsonl");
    writeFileSync(noInput, `${JSON.stringify({ id: "m", question: "Q?", input: "missing.txt" })}\n`);
    const cases: [string[], string][] = [
      [["batch", join(dir, "missing.jsonl"), ...FAKE], "can't read"],
      [["batch"], "name a tasks file"],
      [["batch", badLine, ...FAKE], "not valid JSON"],
      [["batch", noInput, ...FAKE], "input file not found"],
      [["batch", tasks, "--jobs", "0", ...FAKE], "--jobs"],
      [["batch", tasks, ...FAKE, "--call-format", "xml"], "call format"],
      [["batch", tasks], "rlmh config set root.model"],
    ];
    for (const [args, says] of cases) {
      const r = rig();
      expect([args.slice(1).join(" "), await main(args, r.deps)]).toEqual([args.slice(1).join(" "), 2]);
      expect(r.stderr()).toContain(says);
      expect(r.calls.engineReady).toBe(0);
    }
  });

  test("a good tasks file reaches the engine check once", async () => {
    const r = rig(1);
    expect(await main(["batch", tasks, ...FAKE], r.deps)).toBe(1);
    expect(r.calls.engineReady).toBe(1);
    expect(r.stderr()).toBe("");
    // the default-mode warning belongs to the command, not to the preflight that runs before it
    const repoTasks = join(dir, "repo-tasks.jsonl");
    writeFileSync(repoTasks, `${JSON.stringify({ id: "r", task: "T", repo: "repo" })}\n`);
    const w = rig(1);
    expect(await main(["batch", repoTasks, "--permission-mode", "default", ...FAKE], w.deps)).toBe(1);
    expect(w.stderr()).toBe("");
  });
});

test("the other commands do not touch the engine check", async () => {
  const r = rig();
  expect(await main(["config", "list"], r.deps)).toBe(0);
  expect(r.stdout()).toContain("root.model");
  expect(await main(["nonsense"], r.deps)).toBe(2);
  expect(r.calls.engineReady).toBe(0);
});

describe("update", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const INSTALLER = "echo fake installer\n";
  /** Seams for a compiled rlmh installed in `home`, with github.com faked: latest is `latest`, and the installer is recorded. */
  function seams(home: string, latest: string) {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const execPath = join(bin, process.platform === "win32" ? "rlmh.exe" : "rlmh");
    writeFileSync(execPath, "binary");
    const ran: { argv: string[]; env: Record<string, string> }[] = [];
    const base = "https://github.com/RishiJain905/rlm-harness";
    const update = {
      compiled: true,
      execPath,
      appVersion: "0.1.0",
      env: { PATH: "/bin" },
      tmpRoot: dir,
      fetch: async (url: string) => {
        if (url === `${base}/releases/latest`) return new Response(null, { status: 302, headers: { location: `${base}/releases/tag/v${latest}` } });
        if (url.endsWith("/SHA256SUMS")) return new Response(`${sha(INSTALLER)}  ${process.platform === "win32" ? "install.ps1" : "install.sh"}\n`);
        return new Response(INSTALLER);
      },
      run: async (argv: string[], env: Record<string, string>) => (ran.push({ argv, env }), 0),
    };
    return { update, ran };
  }

  test("from a source checkout (which is how these tests run) it refuses with exit 2", async () => {
    const r = rig();
    expect(await main(["update"], r.deps)).toBe(2);
    expect(r.stderr()).toBe("This rlmh runs from a source checkout; update it with git pull.\n");
    expect(r.calls.engineReady).toBe(0); // update never needs the engine
  });

  test("bad flags are a usage error; --check, --yes and -y reach runUpdate", async () => {
    const bad = rig();
    expect(await main(["update", "--bogus"], bad.deps)).toBe(2);
    expect(bad.stderr()).toContain("Usage: rlmh update");
    expect(await main(["update", "extra"], bad.deps)).toBe(2);

    const check = rig();
    const s = seams(check.io.home, "0.1.1");
    expect(await main(["update", "--check"], { ...check.deps, update: s.update })).toBe(0);
    expect(check.stdout()).toBe('rlmh 0.1.0 is installed; the latest version is 0.1.1. Run "rlmh update" to update.\n');
    expect(s.ran).toEqual([]);

    for (const flag of ["--yes", "-y"]) {
      const go = rig();
      const t = seams(go.io.home, "0.1.1");
      expect(await main(["update", flag], { ...go.deps, update: t.update })).toBe(0);
      expect(t.ran).toHaveLength(1);
      expect(t.ran[0]!.env.RLMH_VERSION).toBe("0.1.1");
      expect(go.stdout()).toContain("rlmh updated to 0.1.1.");
    }

    const without = rig(); // no --yes and no terminal under test
    const u = seams(without.io.home, "0.1.1");
    expect(await main(["update"], { ...without.deps, update: { ...u.update, interactive: false } })).toBe(2);
    expect(u.ran).toEqual([]);
  });

  test("rlmh --help lists update, and a source run of `rlmh update` says so", async () => {
    const home = join(dir, "cli-home");
    const help = await rlmh(["--help"], { home });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("rlmh update");
    expect(help.stdout).toMatch(/rlmh update .*--check/);
    const update = await rlmh(["update"], { home });
    expect(update.code).toBe(2);
    expect(update.stderr).toContain("This rlmh runs from a source checkout; update it with git pull.");
    expect(update.stdout).toBe("");
  });
});
