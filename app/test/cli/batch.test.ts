// KV cache: none
// `rlmh batch` end to end: the real engine from source and the scripted fake provider, as a child
// process run from a folder other than the tasks file's. Plus the pre-flight checks and the batch name.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { batchName, canonicalRoot, checkTasks, rootsOverlap } from "../../src/cli/batch.ts";
import { jsonLines, REAL, rlmh, temp, type Temp } from "./helpers.ts";

let t: Temp;
let tasksDir: string;
let elsewhere: string;
let repo: string;
const FAKE = ["--root", "fake/scripted", "--sub", "fake/scripted"];
const SUBMIT = { root: [{ text: "", tool_call: { code: "submit('42')" } }] };

function tasksFile(name: string, lines: (object | string)[]): string {
  const file = join(tasksDir, name);
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

const THREE = [
  { id: "a", question: "What is in a?", input: "data/a.txt", extra: "ignored" },
  { id: "b", question: "What is in b and c?", input: ["data/b.txt", "data/c.txt"] },
  { id: "fix", task: "Fix the bug.", repo: "repo", test_hint: "make test" },
];

beforeAll(() => {
  t = temp("rlmh-batch-");
  tasksDir = join(t.dir, "tasks");
  elsewhere = join(t.dir, "elsewhere");
  repo = join(tasksDir, "repo");
  mkdirSync(join(tasksDir, "data"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  for (const name of ["a", "b", "c"]) writeFileSync(join(tasksDir, "data", `${name}.txt`), `file ${name}\n`);
  writeFileSync(join(repo, "main.py"), "print('hi')\n");
});
afterAll(() => t.cleanup());

function records(path: string): any[] {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));
}

test(
  "three tasks, --jobs 2, --out, --json, from another folder",
  async () => {
    const file = tasksFile("three.jsonl", THREE);
    const home = join(t.dir, "home-three");
    const r = await rlmh(["batch", file, "--jobs", "2", "--out", "out", "--json", ...FAKE], { home, script: t.script(SUBMIT), cwd: elsewhere });
    expect(r.code).toBe(0);
    const events = jsonLines(r.stdout);
    expect(events[events.length - 1]).toEqual({ type: "batch.finished", runs: 3, failed: 0, cost_usd: 0 });
    expect(events.filter((e) => e.type === "batch.finished").length).toBe(1);
    const started = events.filter((e) => e.type === "run.started");
    expect(started.map((e) => e.tag).sort()).toEqual(["a", "b", "fix"]);
    const byTag = Object.fromEntries(started.map((e) => [e.tag, e]));
    // relative paths resolve against the tasks file's folder, not the cwd
    expect(byTag.a.input.files).toEqual([join(tasksDir, "data", "a.txt").replaceAll("\\", "/")]);
    expect(byTag.b.input.files.length).toBe(2);
    expect(byTag.fix.mode).toBe("repo");
    expect(byTag.fix.workspace).toBe(repo);
    expect(byTag.a.log_path).toBe(join(elsewhere, "out", "runs.jsonl"));

    const recs = records(join(elsewhere, "out", "runs.jsonl"));
    expect(recs.length).toBe(3);
    expect(recs.map((x) => x.tag).sort()).toEqual(["a", "b", "fix"]);
    expect(new Set(recs.map((x) => x.run_id)).size).toBe(3);
    expect(recs.every((x) => x.answer === "42" && x.infra_error === null)).toBe(true);
    expect(recs.every((x) => !("extra" in x))).toBe(true);
    expect(existsSync(join(home, "runs"))).toBe(false); // --out wins over the home's runs folder
  },
  REAL,
);

describe("the pool", () => {
  const slow = { root: [{ text: "thinking..", tool_call: { code: "submit('42')" } }], chunk_chars: 1, delay_ms: 60 };
  const reads = [1, 2, 3].map((n) => ({ id: `q${n}`, question: "Q?", input: "data/a.txt" }));

  test(
    "--jobs 3: every run starts before the first one finishes",
    async () => {
      const file = tasksFile("pool3.jsonl", reads);
      const r = await rlmh(["batch", file, "--jobs", "3", "--json", ...FAKE], { home: join(t.dir, "home-pool3"), script: t.script(slow) });
      expect(r.code).toBe(0);
      const types = jsonLines(r.stdout).map((e) => e.type);
      const lastStart = types.lastIndexOf("run.started");
      const firstFinish = types.indexOf("run.finished");
      expect(types.filter((x) => x === "run.started").length).toBe(3);
      expect(lastStart).toBeLessThan(firstFinish);
    },
    REAL,
  );

  test(
    "--jobs 1: runs do not overlap",
    async () => {
      const file = tasksFile("pool1.jsonl", reads);
      const r = await rlmh(["batch", file, "--json", ...FAKE], { home: join(t.dir, "home-pool1"), script: t.script(slow) });
      expect(r.code).toBe(0);
      const order = jsonLines(r.stdout)
        .filter((e) => e.type === "run.started" || e.type === "run.finished")
        .map((e) => `${e.type === "run.started" ? "start" : "end"} ${e.tag}`);
      expect(order).toEqual(["start q1", "end q1", "start q2", "end q2", "start q3", "end q3"]);
    },
    REAL,
  );
});

describe("repo tasks on one folder (a run edits the folder itself)", () => {
  const slow = { root: [{ text: "thinking..", tool_call: { code: "submit('42')" } }], chunk_chars: 1, delay_ms: 60 };

  test("rootsOverlap: the same folder, or one inside the other, and nothing else", () => {
    const base = join(sep, "work", "repos");
    expect(rootsOverlap(join(base, "app"), join(base, "app"))).toBe(true);
    expect(rootsOverlap(join(base, "app"), join(base, "app", "pkg"))).toBe(true);
    expect(rootsOverlap(join(base, "app", "pkg"), join(base, "app"))).toBe(true);
    expect(rootsOverlap(join(base, "app"), join(base, "app2"))).toBe(false); // a shared name prefix is not a shared folder
    expect(rootsOverlap(join(base, "app"), join(base, "lib"))).toBe(false);
    expect(rootsOverlap(join(sep), join(base, "app"))).toBe(true); // the filesystem root holds everything
    if (process.platform === "win32" || process.platform === "darwin") expect(rootsOverlap(join(base, "App"), join(base, "app"))).toBe(true);
    else expect(rootsOverlap(join(base, "App"), join(base, "app"))).toBe(false);
  });

  test("canonicalRoot follows spellings, and checkTasks records it for repo tasks only", () => {
    const file = join(tasksDir, "canon.jsonl");
    const text = [
      JSON.stringify({ id: "plain", task: "T", repo: "repo" }),
      JSON.stringify({ id: "dots", task: "T", repo: "./repo/../repo/" }),
      JSON.stringify({ id: "read", question: "Q?", input: "data/a.txt" }),
    ].join("\n");
    const { tasks, problems } = checkTasks(text, file);
    expect(problems).toEqual([]);
    expect(tasks.map((x) => x.root)).toEqual([canonicalRoot(repo), canonicalRoot(repo), undefined]);
    expect(rootsOverlap(tasks[0]!.root!, tasks[1]!.root!)).toBe(true);
    expect(canonicalRoot(join(t.dir, "no", "such", "folder"))).toBe(join(t.dir, "no", "such", "folder")); // not there: as given
    if (process.platform !== "win32") {
      const alias = join(t.dir, "repo-alias");
      if (!existsSync(alias)) symlinkSync(repo, alias);
      expect(canonicalRoot(alias)).toBe(canonicalRoot(repo));
      expect(rootsOverlap(canonicalRoot(alias), canonicalRoot(repo))).toBe(true);
    }
  });

  test(
    "--jobs 3: two tasks on one folder (spelled two ways) and one inside it run one after the other; a read task runs beside them",
    async () => {
      mkdirSync(join(repo, "pkg"), { recursive: true });
      const file = tasksFile("same-repo.jsonl", [
        { id: "fix1", task: "Fix it.", repo: "repo" },
        { id: "fix2", task: "Fix it again.", repo: "./repo/../repo" },
        { id: "fix3", task: "Fix the package.", repo: "repo/pkg" },
        { id: "q", question: "Q?", input: "data/a.txt" },
      ]);
      const r = await rlmh(["batch", file, "--jobs", "3", "--permission-mode", "accept-edits", "--json", ...FAKE], {
        home: join(t.dir, "home-same-repo"),
        script: t.script(slow),
      });
      expect({ code: r.code, stderr: r.stderr.slice(-1500) }).toMatchObject({ code: 0 });
      const events = jsonLines(r.stdout).filter((e) => e.type === "run.started" || e.type === "run.finished");
      const at = (type: string, tag: string) => events.findIndex((e) => e.type === type && e.tag === tag);
      for (const tag of ["fix1", "fix2", "fix3", "q"]) {
        expect(at("run.started", tag)).toBeGreaterThanOrEqual(0);
        expect(at("run.finished", tag)).toBeGreaterThan(at("run.started", tag));
      }
      // the three repo runs never overlap: each starts after the one before it finished (file order)
      expect(at("run.started", "fix2")).toBeGreaterThan(at("run.finished", "fix1"));
      expect(at("run.started", "fix3")).toBeGreaterThan(at("run.finished", "fix2"));
      // the read task was not held up behind them
      expect(at("run.started", "q")).toBeLessThan(at("run.finished", "fix1"));
    },
    REAL,
  );

  test(
    "different folders still run together",
    async () => {
      const other = join(tasksDir, "repo2");
      mkdirSync(other, { recursive: true });
      const file = tasksFile("two-repos.jsonl", [
        { id: "one", task: "Fix it.", repo: "repo" },
        { id: "two", task: "Fix it.", repo: "repo2" },
      ]);
      const r = await rlmh(["batch", file, "--jobs", "2", "--permission-mode", "accept-edits", "--json", ...FAKE], {
        home: join(t.dir, "home-two-repos"),
        script: t.script(slow),
      });
      expect(r.code).toBe(0);
      const types = jsonLines(r.stdout).map((e) => e.type);
      expect(types.lastIndexOf("run.started")).toBeLessThan(types.indexOf("run.finished"));
    },
    REAL,
  );
});

test(
  "a failed root call: failed 1, exit 1",
  async () => {
    const file = tasksFile("fail.jsonl", [{ id: "only", question: "Q?", input: "data/a.txt" }]);
    const script = t.script({ ...SUBMIT, errors: [{ role: "root", at: 1, kind: "server", status: 500 }] });
    const r = await rlmh(["batch", file, "--json", ...FAKE], { home: join(t.dir, "home-fail"), script });
    expect(r.code).toBe(1);
    const events = jsonLines(r.stdout);
    expect(events[events.length - 1]).toEqual({ type: "batch.finished", runs: 1, failed: 1, cost_usd: 0 });
    expect(events.find((e) => e.type === "run.finished").infra_kind).toBe("server");
  },
  REAL,
);

test(
  "plain mode, the default log folder, and the default-mode warning for a repo task",
  async () => {
    const file = tasksFile("my tasks!.jsonl", [THREE[0]!, THREE[2]!]);
    const home = join(t.dir, "home-plain");
    const r = await rlmh(["batch", file, "--permission-mode", "default", ...FAKE], { home, script: t.script(SUBMIT) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("--permission-mode accept-edits");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBe(3);
    expect(lines.slice(0, 2).sort()).toEqual([expect.stringMatching(/^a  submitted  1  0  \$0\.0000  /), expect.stringMatching(/^fix  submitted  1  0  \$0\.0000  /)]);
    expect(lines[2]).toMatch(/^total  2 runs  0 failed  \$0\.0000  /);
    const folders = readdirSync(join(home, "runs"));
    expect(folders.length).toBe(1);
    expect(folders[0]).toMatch(/^my_tasks_-\d{8}-\d{6}$/);
    expect(records(join(home, "runs", folders[0]!, "runs.jsonl")).map((x) => x.batch)).toEqual([folders[0], folders[0]]);
  },
  REAL,
);

describe("pre-flight: exit 2 before any engine starts", () => {
  const cases: [string, (object | string)[], string][] = [
    ["a bad JSON line", [THREE[0]!, "{not json"], "not valid JSON"],
    ["a duplicate id", [THREE[0]!, { ...THREE[1]!, id: "a" }], "already used"],
    ["a missing input", [{ id: "m", question: "Q?", input: "data/missing.txt" }], "input file not found"],
  ];
  for (const [name, lines, says] of cases) {
    test(name, async () => {
      const file = tasksFile("bad.jsonl", lines);
      const home = join(t.dir, `home-bad-${name.replaceAll(" ", "-")}`);
      const r = await rlmh(["batch", file, ...FAKE], { home, script: t.script(SUBMIT) });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(says);
      expect(r.stdout).toBe("");
      expect(existsSync(join(home, "runs"))).toBe(false);
    });
  }

  test("flags", async () => {
    const file = tasksFile("ok.jsonl", [THREE[0]!]);
    const home = join(t.dir, "home-flags");
    for (const args of [["batch"], ["batch", file, "--jobs", "0", ...FAKE], ["batch", file], ["batch", file, ...FAKE, "--call-format", "xml"]]) {
      const r = await rlmh(args, { home });
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 2]);
    }
    expect(existsSync(join(home, "runs"))).toBe(false);
  });
});

test("checkTasks and batchName", () => {
  const file = join(tasksDir, "unit.jsonl");
  const text = [
    JSON.stringify({ id: 7, question: "Q?", input: "data/a.txt" }),
    "",
    JSON.stringify({ id: "r", task: "T", repo: "repo" }),
    JSON.stringify({ id: "x", question: "Q?", input: "data/a.txt", task: "T" }),
    JSON.stringify({ id: "y", task: "T", repo: "data/a.txt" }),
    JSON.stringify({ question: "Q?", input: "data/a.txt" }),
    JSON.stringify([1]),
  ].join("\r\n");
  const { tasks, problems } = checkTasks(text, file);
  expect(tasks.map((x) => x.id)).toEqual(["7", "r"]);
  expect(tasks[0]!.run.inputs).toEqual([join(tasksDir, "data", "a.txt")]);
  expect(tasks[1]!.run).toEqual({ mode: "repo", task: "T", repoPath: repo });
  expect(problems.length).toBe(4);
  expect(problems[0]).toStartWith(`${file}:4: `);
  expect(problems[1]).toContain("repo folder not found");
  expect(batchName("/x/my tasks.v2.jsonl", new Date(2026, 9, 31, 8, 5, 9))).toBe("my_tasks.v2-20261031-080509");
  expect(batchName("/x/.hidden.jsonl", new Date(2026, 0, 2, 3, 4, 5))).toBe("_hidden-20260102-030405");
});
