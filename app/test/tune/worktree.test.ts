// KV cache: none
// worktree.ts against real git in temp repos (v1 step 9, task 3): snapshots that leave the user's repo as it
// was, worktrees and copies of them, diffs, hooks and filters that never run, the copy's skip list and limits,
// leftovers, and runTest. Needs git on PATH.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tuneDir } from "../../src/paths.ts";
import { pruneStale, runTest, snapshot, SNAPSHOT_MESSAGE, workCopy, type Snapshot } from "../../src/tune/worktree.ts";
import { temp, type Temp } from "../cli/helpers.ts";

const SLOW = 60_000;
const temps: Temp[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) t.cleanup();
});

function scratch(): Temp {
  const t = temp("rlmh-worktree-");
  temps.push(t);
  return t;
}

/** git in a test repo: no optional locks, so `git status` never rewrites the index it is checking. */
function g(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "tester",
      GIT_AUTHOR_EMAIL: "tester@example.com",
      GIT_COMMITTER_NAME: "tester",
      GIT_COMMITTER_EMAIL: "tester@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function write(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A repo with LF line endings and no signing; `commit` makes one first commit. */
function repo(t: Temp, opts: { commit?: boolean } = {}): string {
  const dir = join(t.dir, "proj");
  mkdirSync(dir, { recursive: true });
  g(dir, "-c", "init.defaultBranch=main", "init", "-q");
  g(dir, "config", "core.autocrlf", "false");
  g(dir, "config", "commit.gpgsign", "false");
  if (opts.commit ?? true) {
    write(join(dir, "a.txt"), "one\n");
    write(join(dir, ".gitignore"), "ignored.txt\n");
    write(join(dir, "pkg", "b.txt"), "bee\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "first");
  }
  return dir;
}

function asSnap(s: Snapshot | { refused: string }): Snapshot {
  if ("refused" in s) throw new Error(`refused: ${s.refused}`);
  return s;
}

const files = (dir: string, commit: string) => g(dir, "ls-tree", "-r", "--name-only", commit).trim().split("\n").sort();

describe("snapshot in git", () => {
  test("holds an uncommitted change and an untracked file, and not an ignored file", async () => {
    const t = scratch();
    const dir = repo(t);
    write(join(dir, "a.txt"), "two\n");
    write(join(dir, "new.txt"), "new\n");
    write(join(dir, "ignored.txt"), "secret\n");
    const snap = asSnap(await snapshot(dir, join(t.dir, "snap"), { home: t.home }));
    expect(snap.kind).toBe("commit");
    expect(snap.sub).toBe("");
    const commit = snap.commit!;
    expect(files(dir, commit)).toEqual([".gitignore", "a.txt", "new.txt", "pkg/b.txt"]);
    expect(g(dir, "show", `${commit}:a.txt`)).toBe("two\n");
    expect(g(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s|%P", commit).trim()).toBe(
      `rlmh <rlmh@localhost>|rlmh <rlmh@localhost>|${SNAPSHOT_MESSAGE}|${g(dir, "rev-parse", "HEAD").trim()}`,
    );
    // the temporary index is gone; the snapshot folder holds only its work.json
    expect(readdirSync(join(tuneDir(t.home), "work"))).toEqual([]);
    expect(readdirSync(snap.dir)).toEqual(["work.json"]);
    await snap.remove();
    expect(existsSync(snap.dir)).toBe(false);
  }, SLOW);

  test("leaves status, the index's bytes, HEAD, refs and the reflog as they were", async () => {
    const t = scratch();
    const dir = repo(t);
    write(join(dir, "a.txt"), "two\n");
    write(join(dir, "pkg", "b.txt"), "staged\n");
    g(dir, "add", "pkg/b.txt");
    write(join(dir, "new.txt"), "new\n");
    const state = () => ({
      status: g(dir, "status", "--porcelain"),
      index: readFileSync(join(dir, ".git", "index")).toString("hex"),
      head: readFileSync(join(dir, ".git", "HEAD"), "utf8") + g(dir, "rev-parse", "HEAD"),
      refs: g(dir, "for-each-ref"),
      reflog: g(dir, "reflog", "show", "--all") + readFileSync(join(dir, ".git", "logs", "HEAD"), "utf8"),
    });
    const before = state();
    const snap = asSnap(await snapshot(dir, join(t.dir, "snap"), { home: t.home }));
    expect(state()).toEqual(before);
    expect(g(dir, "show", `${snap.commit}:pkg/b.txt`)).toBe("staged\n");
  }, SLOW);

  test("a repo with no commit gives a snapshot with no parent", async () => {
    const t = scratch();
    const dir = repo(t, { commit: false });
    write(join(dir, "x.txt"), "x\n");
    const snap = asSnap(await snapshot(dir, join(t.dir, "snap"), { home: t.home }));
    expect(g(dir, "rev-list", "--parents", "-n", "1", snap.commit!).trim()).toBe(snap.commit!);
    expect(files(dir, snap.commit!)).toEqual(["x.txt"]);
    expect(() => g(dir, "rev-parse", "--verify", "-q", "HEAD")).toThrow();
  }, SLOW);

  test("a folder below the top keeps its subfolder", async () => {
    const t = scratch();
    const dir = repo(t);
    const snap = asSnap(await snapshot(join(dir, "pkg"), join(t.dir, "snap"), { home: t.home }));
    expect(snap.sub).toBe("pkg");
    // git prints the long path; a Windows tmpdir() can be an 8.3 short one (C:\Users\RUNNER~1\...).
    expect(snap.top).toBe(realpathSync.native(dir));
    const work = await workCopy(snap, join(t.dir, "work"));
    expect(work.cwd).toBe(join(work.path, "pkg"));
    expect(readFileSync(join(work.cwd, "b.txt"), "utf8")).toBe("bee\n");
    await work.remove();
  }, SLOW);

  test("a folder git ignores is refused, and leaves nothing", async () => {
    const t = scratch();
    const dir = repo(t);
    write(join(dir, ".gitignore"), "ignored.txt\nout/\n");
    write(join(dir, "out", "x.txt"), "x\n");
    const dest = join(t.dir, "snap");
    const r = await snapshot(join(dir, "out"), dest, { home: t.home });
    expect("refused" in r && r.refused).toContain("ignored by git");
    expect(existsSync(dest)).toBe(false);
  }, SLOW);
});

describe("workCopy", () => {
  test("a worktree from the snapshot has the uncommitted change; remove() leaves the worktree list as it was", async () => {
    const t = scratch();
    const dir = repo(t);
    write(join(dir, "a.txt"), "two\n");
    write(join(dir, "new.txt"), "new\n");
    const list = g(dir, "worktree", "list", "--porcelain");
    const snap = asSnap(await snapshot(dir, join(t.dir, "snap"), { home: t.home }));
    const work = await workCopy(snap, join(t.dir, "work"));
    expect(work.kind).toBe("worktree");
    expect(work.applied).toBe(false);
    expect(readFileSync(join(work.path, "a.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(work.path, "new.txt"), "utf8")).toBe("new\n");
    expect(g(dir, "worktree", "list", "--porcelain")).not.toBe(list);
    // the user's folder is untouched by the worktree
    expect(g(dir, "status", "--porcelain")).toBe(" M a.txt\n?? new.txt\n");
    await work.remove();
    expect(g(dir, "worktree", "list", "--porcelain")).toBe(list);
    expect(existsSync(work.dir)).toBe(false);
  }, SLOW);

  test("a post-checkout hook and clean and smudge filters never run", async () => {
    const t = scratch();
    const dir = repo(t);
    const marks = join(t.dir, "marks").replace(/\\/g, "/");
    mkdirSync(marks);
    const hook = write(join(dir, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho hook > "${marks}/post-checkout"\n`);
    write(join(dir, ".git", "hooks", "post-index-change"), `#!/bin/sh\necho hook > "${marks}/post-index-change"\n`);
    if (process.platform !== "win32") {
      Bun.spawnSync(["chmod", "+x", hook, join(dir, ".git", "hooks", "post-index-change")]);
    }
    g(dir, "config", "filter.mark.clean", `sh -c 'echo clean > "${marks}/clean"; cat'`);
    g(dir, "config", "filter.mark.smudge", `sh -c 'echo smudge > "${marks}/smudge"; cat'`);
    write(join(dir, ".gitattributes"), "*.txt filter=mark\n");
    write(join(dir, "a.txt"), "two\n");
    const snap = asSnap(await snapshot(dir, join(t.dir, "snap"), { home: t.home }));
    const work = await workCopy(snap, join(t.dir, "work"), "");
    expect(readFileSync(join(work.path, "a.txt"), "utf8")).toBe("two\n");
    await work.remove();
    expect(readdirSync(marks)).toEqual([]);
    // the same hook and filters do run for git itself, so the check above means something
    g(dir, "worktree", "add", "--detach", "-q", join(t.dir, "plain"), snap.commit!);
    expect(readdirSync(marks)).toEqual(expect.arrayContaining(["post-checkout", "smudge"]));
    g(dir, "worktree", "remove", "--force", join(t.dir, "plain"));
  }, SLOW);

  test("a diff applies, also below the top; one that doesn't apply gives applied: false", async () => {
    const t = scratch();
    const dir = repo(t);
    const snap = asSnap(await snapshot(dir, join(t.dir, "snap"), { home: t.home }));
    const good = [
      "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-one", "+three",
      "diff --git a/c.txt b/c.txt", "new file mode 100644", "--- /dev/null", "+++ b/c.txt", "@@ -0,0 +1 @@", "+sea", "",
    ].join("\n");
    const work = await workCopy(snap, join(t.dir, "w1"), good);
    expect(work.applied).toBe(true);
    expect(readFileSync(join(work.path, "a.txt"), "utf8")).toBe("three\n");
    expect(readFileSync(join(work.path, "c.txt"), "utf8")).toBe("sea\n");
    await work.remove();

    const bad = ["diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-not there", "+three", ""].join("\n");
    const work2 = await workCopy(snap, join(t.dir, "w2"), bad);
    expect(work2.applied).toBe(false);
    expect(readFileSync(join(work2.path, "a.txt"), "utf8")).toBe("one\n");
    await work2.remove();

    // a diff recorded in pkg/ is relative to pkg/
    const subSnap = asSnap(await snapshot(join(dir, "pkg"), join(t.dir, "snap2"), { home: t.home }));
    const subDiff = ["diff --git a/b.txt b/b.txt", "--- a/b.txt", "+++ b/b.txt", "@@ -1 +1 @@", "-bee", "+wasp", ""].join("\n");
    const work3 = await workCopy(subSnap, join(t.dir, "w3"), subDiff);
    expect(work3.applied).toBe(true);
    expect(readFileSync(join(work3.cwd, "b.txt"), "utf8")).toBe("wasp\n");
    await work3.remove();
    expect(g(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
  }, SLOW);
});

describe("snapshot outside git", () => {
  function plainFolder(t: Temp): string {
    const dir = join(t.dir, "plain");
    write(join(dir, "main.py"), "print(1)\n");
    write(join(dir, "src", "lib.py"), "x = 1\n");
    for (const skip of ["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", "dist", "build", "target"]) {
      write(join(dir, skip, "junk.txt"), "junk\n");
    }
    write(join(dir, "src", "__pycache__", "lib.pyc"), "junk\n");
    write(join(dir, "src", "node_modules", "dep.js"), "junk\n");
    return dir;
  }

  test("is a copy without the skip list, links not followed, and a work copy is a copy of it", async () => {
    const t = scratch();
    const dir = plainFolder(t);
    const outside = join(t.dir, "outside");
    write(join(outside, "secret.txt"), "secret\n");
    let linked = true;
    try {
      symlinkSync(outside, join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false;
    }
    const snap = asSnap(await snapshot(dir, join(t.home, "tune", "snapshots", "s1"), { home: t.home }));
    expect(snap.kind).toBe("copy");
    expect(snap.sub).toBe("");
    const copy = snap.path!;
    expect(readdirSync(copy).filter((n) => n !== "link").sort()).toEqual(["main.py", "src"]);
    expect(readdirSync(join(copy, "src")).sort()).toEqual(["lib.py"]);
    if (linked && existsSync(join(copy, "link"))) expect(lstatSync(join(copy, "link")).isSymbolicLink()).toBe(true);

    const diff = ["diff --git a/main.py b/main.py", "--- a/main.py", "+++ b/main.py", "@@ -1 +1 @@", "-print(1)", "+print(2)", ""].join("\n");
    const work = await workCopy(snap, join(t.home, "tune", "work", "t_1", "probe"), diff);
    expect(work.kind).toBe("copy");
    expect(work.applied).toBe(true);
    expect(readFileSync(join(work.path, "main.py"), "utf8")).toBe("print(2)\n");
    expect(readFileSync(join(copy, "main.py"), "utf8")).toBe("print(1)\n");
    expect(readFileSync(join(dir, "main.py"), "utf8")).toBe("print(1)\n");
    await work.remove();
    expect(existsSync(work.dir)).toBe(false);
    await snap.remove();
    expect(existsSync(snap.dir)).toBe(false);
  }, SLOW);

  test("is refused above a lowered limit, before anything is copied", async () => {
    const t = scratch();
    const dir = plainFolder(t);
    const dest = join(t.dir, "snap");
    const byFiles = await snapshot(dir, dest, { home: t.home, maxFiles: 1 });
    expect("refused" in byFiles && byFiles.refused).toContain("more than 1 files");
    expect(existsSync(dest)).toBe(false);
    const byBytes = await snapshot(dir, dest, { home: t.home, maxBytes: 10 });
    expect("refused" in byBytes && byBytes.refused).toContain("more than 10 bytes");
    expect(existsSync(dest)).toBe(false);
    // the skipped folders don't count
    expect("refused" in (await snapshot(dir, dest, { home: t.home, maxFiles: 2 }))).toBe(false);
  }, SLOW);
});

describe("pruneStale", () => {
  test("removes a leftover worktree and a leftover copy, and leaves a live other process's alone", async () => {
    const t = scratch();
    const dir = repo(t);
    const plain = join(t.dir, "plain");
    write(join(plain, "f.txt"), "f\n");
    const list = g(dir, "worktree", "list", "--porcelain");
    const tune = tuneDir(t.home);
    const snapA = asSnap(await snapshot(dir, join(tune, "snapshots", "a"), { home: t.home }));
    const snapB = asSnap(await snapshot(plain, join(tune, "snapshots", "b"), { home: t.home }));
    const workA = await workCopy(snapA, join(tune, "work", "t_1", "probe-inv"));
    const workB = await workCopy(snapB, join(tune, "work", "t_1", "probe-dom"));
    expect(g(dir, "worktree", "list", "--porcelain")).not.toBe(list);
    // A pid that has exited: pid 1 is alive on macOS and Linux (EPERM counts as alive).
    const gone = Bun.spawnSync({ cmd: [process.execPath, "-e", "0"] }).pid;
    write(join(tune, "work", `index-${gone}-abcdef`), "stale index");

    const sleeper = Bun.spawn({ cmd: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], stdout: "ignore", stderr: "ignore" });
    try {
      const live = join(tune, "work", "t_2", "probe-inv");
      write(join(live, "work.json"), JSON.stringify({ folder: plain, kind: "copy", pid: sleeper.pid }));

      const removed = await pruneStale(t.home);
      expect(removed.sort()).toEqual([snapA.dir, snapB.dir, workA.dir, workB.dir].sort());
      expect(g(dir, "worktree", "list", "--porcelain")).toBe(list);
      expect(existsSync(workA.path)).toBe(false);
      expect(existsSync(join(tune, "work", "t_1"))).toBe(false);
      expect(existsSync(join(tune, "work", `index-${gone}-abcdef`))).toBe(false);
      expect(existsSync(join(live, "work.json"))).toBe(true);
      expect(readFileSync(join(plain, "f.txt"), "utf8")).toBe("f\n");
    } finally {
      sleeper.kill();
    }
  }, SLOW);

  test("does nothing without a tune folder", async () => {
    const t = scratch();
    expect(await pruneStale(t.home)).toEqual([]);
    expect(existsSync(tuneDir(t.home))).toBe(false);
  });
});

describe("runTest", () => {
  const bun = `"${process.execPath}"`;

  test("returns the exit code and writes the output to the log", async () => {
    const t = scratch();
    const pass = t.file("pass.js", "console.log('all good'); console.error('on stderr');\n");
    const fail = t.file("fail.js", "console.log('one failed'); process.exit(1);\n");
    const log = join(t.home, "tune", "t_1", "tests", "ref.log");
    const ok = await runTest(`${bun} "${pass}"`, t.dir, { log });
    expect(ok.exit).toBe(0);
    expect(ok.timedOut).toBe(false);
    expect(ok.seconds).toBeGreaterThanOrEqual(0);
    expect(readFileSync(log, "utf8")).toContain("all good");
    expect(readFileSync(log, "utf8")).toContain("on stderr");
    const bad = await runTest(`${bun} "${fail}"`, t.dir, { log });
    expect(bad).toMatchObject({ exit: 1, timedOut: false });
    expect(readFileSync(log, "utf8")).toBe("one failed\n");
  }, SLOW);

  test("runs in the given folder, with no shell", async () => {
    const t = scratch();
    const script = t.file("cwd.js", "console.log(process.cwd()); console.log(process.argv.slice(2).join('|'));\n");
    const work = join(t.dir, "work");
    mkdirSync(work);
    const log = join(t.dir, "cwd.log");
    const r = await runTest(`${bun} "${script}" 'a b' $HOME;echo`, work, { log });
    expect(r.exit).toBe(0);
    expect(readFileSync(log, "utf8").split(/\r?\n/).slice(0, 2)).toEqual([work, "a b|$HOME;echo"]);
  }, SLOW);

  test("honours the timeout", async () => {
    const t = scratch();
    const script = t.file("hang.js", "console.log('started'); setTimeout(() => {}, 120000);\n");
    const log = join(t.dir, "hang.log");
    const r = await runTest(`${bun} "${script}"`, t.dir, { log, timeoutS: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.exit).not.toBe(0);
    expect(r.seconds).toBeGreaterThanOrEqual(0.9);
    expect(r.seconds).toBeLessThan(30);
  }, SLOW);

  test("gets no *_KEY variable", async () => {
    const t = scratch();
    const script = t.file("env.js", "for (const k of Object.keys(process.env).sort()) console.log(k);\n");
    const log = join(t.dir, "env.log");
    process.env.RLMH_WORKTREE_TEST_KEY = "sk-FAKE-worktree";
    process.env.RLMH_WORKTREE_TEST_PLAIN = "plain";
    try {
      const r = await runTest(`${bun} "${script}"`, t.dir, { log });
      expect(r.exit).toBe(0);
    } finally {
      delete process.env.RLMH_WORKTREE_TEST_KEY;
      delete process.env.RLMH_WORKTREE_TEST_PLAIN;
    }
    const names = readFileSync(log, "utf8").split(/\r?\n/).filter((n) => n !== "");
    expect(names).toContain("RLMH_WORKTREE_TEST_PLAIN");
    expect(names.filter((n) => /_KEY$/i.test(n))).toEqual([]);
  }, SLOW);

  test("a command that can't start gives 127", async () => {
    const t = scratch();
    const log = join(t.dir, "missing.log");
    const r = await runTest("rlmh-no-such-command-anywhere --x", t.dir, { log });
    expect(r).toMatchObject({ exit: 127, timedOut: false });
    expect(readFileSync(log, "utf8")).toContain("could not start");
  });

  test.if(process.platform === "win32")("a .cmd file goes through cmd.exe on Windows", async () => {
    const t = scratch();
    const dir = join(t.dir, "with space");
    mkdirSync(dir);
    const script = join(dir, "check.cmd");
    writeFileSync(script, "@echo off\r\necho from cmd %~1\r\nexit /b 3\r\n");
    const log = join(t.dir, "cmd.log");
    const r = await runTest(`"${script}" arg`, t.dir, { log });
    expect(r.exit).toBe(3);
    expect(readFileSync(log, "utf8")).toContain("from cmd arg");
  }, SLOW);
});
