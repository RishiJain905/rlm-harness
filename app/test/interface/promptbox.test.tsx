// KV cache: none; the interface never touches the bytes sent to the model.
// The prompt box. `parseQuestion` and `completePath` (mentions.ts) are plain functions and run on
// real temp folders; the PromptBox screen tests (typing, history, the slash menu, Tab) are appended
// below the marker.

import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { graphemeSpans, nextGrapheme, prevGrapheme, snapToGrapheme } from "../../src/interface/format.ts";
import { completePath, listFiles, mentionText, mentionToken, parseQuestion, rankFiles, type FileProbe } from "../../src/interface/mentions.ts";
import { createFakeApp, type FakeApp } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";

setDefaultTimeout(20_000);

const WIN32 = process.platform === "win32";

let cwd: string;

beforeEach(() => {
  // the real path: on macOS tmpdir() is under /var, a symlink to /private/var
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "rlmh-mentions-")));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function touch(...parts: string[]): string {
  const path = join(cwd, ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  return path;
}

function folder(...parts: string[]): string {
  const path = join(cwd, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("parseQuestion", () => {
  test("no mention is repo mode on the folder, with the text as the task", () => {
    const text = "  Fix the failing test in parser.py  ";
    const r = parseQuestion(text, cwd);
    expect(r).toEqual({ ok: true, run: { mode: "repo", task: text, repoPath: cwd, interactive: true } });
  });

  test("a run never carries models, a profile or a permission mode", () => {
    touch("a.txt");
    for (const text of ["do it", "read @a.txt"]) {
      const r = parseQuestion(text, cwd);
      if (!r.ok) throw new Error(r.error);
      for (const key of ["root", "sub", "profile", "permissionMode", "callFormat", "tag", "batch", "logDir"]) {
        expect(key in r.run).toBe(false);
      }
      expect(r.run.interactive).toBe(true);
    }
  });

  test("one mention is read mode: the @ is dropped and inputs hold the absolute path", () => {
    const a = touch("a.txt");
    const r = parseQuestion("Summarize @a.txt", cwd);
    expect(r).toEqual({ ok: true, run: { mode: "read", question: "Summarize a.txt", inputs: [a], interactive: true } });
  });

  test("a mention at the very start of the text counts", () => {
    const a = touch("a.txt");
    const r = parseQuestion("@a.txt what is this?", cwd);
    expect(r).toEqual({ ok: true, run: { mode: "read", question: "a.txt what is this?", inputs: [a], interactive: true } });
  });

  test("a quoted path may hold spaces; the quotes are dropped", () => {
    const f = touch("my dir", "a b.txt");
    const r = parseQuestion('Summarize @"my dir/a b.txt" now', cwd);
    expect(r).toEqual({ ok: true, run: { mode: "read", question: "Summarize my dir/a b.txt now", inputs: [f], interactive: true } });
  });

  test("backslashes and slashes both work, and the question is written with /", () => {
    const sub = touch("sub", "a.txt");
    const quoted = touch("my dir", "a b.txt");
    const r1 = parseQuestion("see @sub\\a.txt and @sub/a.txt", cwd);
    expect(r1).toEqual({ ok: true, run: { mode: "read", question: "see sub/a.txt and sub/a.txt", inputs: [sub], interactive: true } });
    const r2 = parseQuestion('Summarize @"my dir\\a b.txt" now', cwd);
    expect(r2).toEqual({ ok: true, run: { mode: "read", question: "Summarize my dir/a b.txt now", inputs: [quoted], interactive: true } });
  });

  test("two files give two inputs in order", () => {
    const a = touch("a.txt");
    const b = touch("b.txt");
    const r = parseQuestion("Compare @b.txt with @a.txt please", cwd);
    expect(r).toEqual({ ok: true, run: { mode: "read", question: "Compare b.txt with a.txt please", inputs: [b, a], interactive: true } });
  });

  test("the same file under different spellings is one input; the question keeps every spelling", () => {
    const a = touch("a.txt");
    touch("sub", "x.txt");
    const r = parseQuestion(`@a.txt @./a.txt @sub/../a.txt and @"${a}"`, cwd);
    if (!r.ok) throw new Error(r.error);
    expect(r.run.inputs).toEqual([a]);
    expect(r.run.question).toBe(`a.txt ./a.txt sub/../a.txt and ${a.replaceAll("\\", "/")}`);
  });

  test("inputs are absolute whatever was typed", () => {
    touch("sub", "a.txt");
    const r = parseQuestion("@sub/a.txt @./sub/../sub/a.txt", cwd);
    if (!r.ok) throw new Error(r.error);
    expect(r.run.inputs?.length).toBe(1);
    for (const p of r.run.inputs ?? []) expect(isAbsolute(p)).toBe(true);
    expect(r.run.inputs?.[0]).toBe(resolve(cwd, "sub", "a.txt"));
  });

  test("paths resolve against the cwd given", () => {
    const a = touch("deep", "er", "a.txt");
    const r = parseQuestion("@a.txt", join(cwd, "deep", "er"));
    if (!r.ok) throw new Error(r.error);
    expect(r.run.inputs).toEqual([a]);
  });

  test("a missing file starts nothing and the error names the token as typed", () => {
    touch("a.txt");
    expect(parseQuestion("Summarize @missing.txt please", cwd)).toEqual({ ok: false, error: "@missing.txt: no such file" });
    expect(parseQuestion('Summarize @"no such.txt"', cwd)).toEqual({ ok: false, error: '@"no such.txt": no such file' });
  });

  test("the first failing mention is the one reported", () => {
    touch("a.txt");
    expect(parseQuestion("@a.txt @nope.txt @nope2.txt", cwd)).toEqual({ ok: false, error: "@nope.txt: no such file" });
  });

  test("a folder is refused", () => {
    folder("somedir");
    expect(parseQuestion("Summarize @somedir", cwd)).toEqual({ ok: false, error: "@somedir: not a file" });
    expect(parseQuestion("Summarize @somedir/", cwd)).toEqual({ ok: false, error: "@somedir/: not a file" });
  });

  test("punctuation after a path belongs to the token", () => {
    touch("a.txt");
    expect(parseQuestion("What is in @a.txt?", cwd)).toEqual({ ok: false, error: "@a.txt?: no such file" });
  });

  test("an unclosed quote is a token of its own", () => {
    expect(parseQuestion('read @"abc', cwd)).toEqual({ ok: false, error: '@"abc: no such file' });
  });

  test("an address like a@b.com is not a mention", () => {
    for (const text of ["mail a@b.com", "a@b.com", "write to a@b.com about @", "x@y"]) {
      expect(parseQuestion(text, cwd)).toEqual({ ok: true, run: { mode: "repo", task: text, repoPath: cwd, interactive: true } });
    }
  });

  test("a real mention next to an address still counts", () => {
    const a = touch("a.txt");
    const r = parseQuestion("mail a@b.com the summary of @a.txt", cwd);
    expect(r).toEqual({ ok: true, run: { mode: "read", question: "mail a@b.com the summary of a.txt", inputs: [a], interactive: true } });
  });

  test("whitespace around a mention is kept", () => {
    const a = touch("a.txt");
    const r = parseQuestion("one\n@a.txt\ttwo  @a.txt", cwd);
    if (!r.ok) throw new Error(r.error);
    expect(r.run.question).toBe("one\na.txt\ttwo  a.txt");
    expect(r.run.inputs).toEqual([a]);
  });

  describe("with a fake file system", () => {
    const probe = (files: string[], dirs: string[] = [], others: string[] = []): FileProbe & { seen: string[] } => ({
      seen: [],
      stat(path) {
        this.seen.push(path);
        return files.includes(path) ? "file" : dirs.includes(path) ? "dir" : others.includes(path) ? "other" : "missing";
      },
    });

    test("it asks the probe about the resolved absolute path", () => {
      const base = resolve("/work/project");
      const fs = probe([resolve(base, "x.txt"), resolve(base, "sub", "y.txt")]);
      const r = parseQuestion("@x.txt @sub/y.txt", base, fs);
      expect(r).toEqual({
        ok: true,
        run: { mode: "read", question: "x.txt sub/y.txt", inputs: [resolve(base, "x.txt"), resolve(base, "sub", "y.txt")], interactive: true },
      });
      expect(fs.seen).toEqual([resolve(base, "x.txt"), resolve(base, "sub", "y.txt")]);
    });

    test("something that exists but is not a file is refused", () => {
      const base = resolve("/work/project");
      const fs = probe([], [resolve(base, "d")], [resolve(base, "pipe")]);
      expect(parseQuestion("@d", base, fs)).toEqual({ ok: false, error: "@d: not a file" });
      expect(parseQuestion("@pipe", base, fs)).toEqual({ ok: false, error: "@pipe: not a file" });
      expect(parseQuestion("@gone", base, fs)).toEqual({ ok: false, error: "@gone: no such file" });
    });

    test("no probe call is made when there is no mention", () => {
      const fs = probe([]);
      parseQuestion("just a task", "/work", fs);
      expect(fs.seen).toEqual([]);
    });
  });

  describe("Windows paths", () => {
    test.skipIf(!WIN32)("a drive letter with backslashes or slashes resolves", () => {
      const file = "C:\\temp\\a.txt";
      const fs: FileProbe = { stat: (p) => (p.toLowerCase() === file.toLowerCase() ? "file" : "missing") };
      const r1 = parseQuestion("read @C:\\temp\\a.txt now", "D:\\work", fs);
      expect(r1).toEqual({ ok: true, run: { mode: "read", question: "read C:/temp/a.txt now", inputs: [file], interactive: true } });
      const r2 = parseQuestion("read @C:/temp/a.txt now", "D:\\work", fs);
      expect(r2).toEqual({ ok: true, run: { mode: "read", question: "read C:/temp/a.txt now", inputs: [file], interactive: true } });
    });

    test.skipIf(!WIN32)("a quoted drive path with spaces resolves", () => {
      const file = "C:\\Program Files\\a.txt";
      const fs: FileProbe = { stat: (p) => (p.toLowerCase() === file.toLowerCase() ? "file" : "missing") };
      const r = parseQuestion('read @"C:\\Program Files\\a.txt" now', "D:\\work", fs);
      expect(r).toEqual({ ok: true, run: { mode: "read", question: "read C:/Program Files/a.txt now", inputs: [file], interactive: true } });
    });

    test.skipIf(!WIN32)("the same file in a different case is one input", () => {
      const file = "C:\\temp\\a.txt";
      const fs: FileProbe = { stat: (p) => (p.toLowerCase() === file.toLowerCase() ? "file" : "missing") };
      const r = parseQuestion("@C:\\temp\\a.txt @c:/TEMP/A.txt", "D:\\work", fs);
      if (!r.ok) throw new Error(r.error);
      expect(r.run.inputs?.length).toBe(1);
    });

    test.skipIf(WIN32)("off Windows, a backslash is a separator too, so sub\\a.txt is sub/a.txt", () => {
      const f = touch("sub", "a.txt");
      const r = parseQuestion("@sub\\a.txt", cwd);
      if (!r.ok) throw new Error(r.error);
      expect(r.run.inputs).toEqual([f]);
      expect(r.run.question).toBe("sub/a.txt");
    });
  });
});

describe("completePath", () => {
  beforeEach(() => {
    touch("alpha.txt");
    touch("alpine", "inner.md");
    folder("alpine", "deep");
    touch("beta.txt");
    touch(".hidden");
    folder(".git");
    touch("my dir", "a b.txt");
  });

  test("an empty prefix lists the folder: dot-entries hidden, folders end with /, sorted", () => {
    expect(completePath("", cwd)).toEqual(["alpha.txt", "alpine/", "beta.txt", '"my dir/']);
  });

  test("the typed start filters, and the match is case-sensitive", () => {
    expect(completePath("al", cwd)).toEqual(["alpha.txt", "alpine/"]);
    expect(completePath("alph", cwd)).toEqual(["alpha.txt"]);
    expect(completePath("alpha.txt", cwd)).toEqual(["alpha.txt"]);
    expect(completePath("AL", cwd)).toEqual([]);
    expect(completePath("zzz", cwd)).toEqual([]);
  });

  test("a basename that starts with a dot shows dot-entries", () => {
    expect(completePath(".", cwd)).toEqual([".git/", ".hidden"]);
    expect(completePath(".h", cwd)).toEqual([".hidden"]);
  });

  test("a nested relative prefix stays relative", () => {
    expect(completePath("alpine/", cwd)).toEqual(["alpine/deep/", "alpine/inner.md"]);
    expect(completePath("alpine/i", cwd)).toEqual(["alpine/inner.md"]);
    expect(completePath("./al", cwd)).toEqual(["./alpha.txt", "./alpine/"]);
    expect(completePath("alpine/../be", cwd)).toEqual(["alpine/../beta.txt"]);
  });

  test("a folder part going up or starting at the root is kept as typed", () => {
    const here = cwd.replaceAll("\\", "/");
    const name = here.slice(here.lastIndexOf("/") + 1);
    expect(completePath(`../${name}/be`, cwd)).toEqual([`../${name}/beta.txt`]);
    expect(completePath(`${here}/be`, resolve("/"))).toEqual([`${here}/beta.txt`]);
  });

  test("a missing folder, or a file used as a folder, gives []", () => {
    expect(completePath("nope/x", cwd)).toEqual([]);
    expect(completePath("beta.txt/", cwd)).toEqual([]);
    expect(completePath("alpine/deep/more/", cwd)).toEqual([]);
    expect(completePath("x", join(cwd, "does-not-exist"))).toEqual([]);
  });

  test("a leading quote is accepted and kept; a path with whitespace is quoted, and a file is closed", () => {
    expect(completePath('"my', cwd)).toEqual(['"my dir/']);
    expect(completePath('"my dir/', cwd)).toEqual(['"my dir/a b.txt"']);
    expect(completePath("my dir/", cwd)).toEqual(['"my dir/a b.txt"']);
    expect(completePath('"alp', cwd)).toEqual(['"alpha.txt"', '"alpine/']);
  });

  test("a candidate round-trips through parseQuestion", () => {
    const [candidate] = completePath('"my dir/', cwd);
    expect(candidate).toBe('"my dir/a b.txt"');
    const r = parseQuestion(`read @${candidate}`, cwd);
    if (!r.ok) throw new Error(r.error);
    expect(r.run.inputs).toEqual([join(cwd, "my dir", "a b.txt")]);
  });

  test("at most 50 candidates, in sorted order", () => {
    for (let i = 0; i < 60; i++) touch("many", `f${String(i).padStart(2, "0")}.txt`);
    const found = completePath("many/", cwd);
    expect(found.length).toBe(50);
    expect(found[0]).toBe("many/f00.txt");
    expect(found[49]).toBe("many/f49.txt");
    expect([...found].sort()).toEqual(found);
  });

  test.skipIf(WIN32)("a link to a folder ends with /", () => {
    symlinkSync(join(cwd, "alpine"), join(cwd, "link-to-alpine"));
    symlinkSync(join(cwd, "gone"), join(cwd, "link-to-nothing"));
    expect(completePath("link", cwd)).toEqual(["link-to-alpine/", "link-to-nothing"]);
  });

  test("it never throws", () => {
    for (const prefix of ["", "\0", '"', "/", "//", "a".repeat(5000), "\\\\?\\", "C:", "~"]) {
      expect(() => completePath(prefix, cwd)).not.toThrow();
    }
  });
});

describe("parseQuestion with a mode choice (D-156)", () => {
  test("repo: mentions are checked and named in the task; the run works on the folder", () => {
    touch("spec-01.md");
    expect(parseQuestion("Read @spec-01.md and do it", cwd, undefined, "repo")).toEqual({
      ok: true,
      run: { mode: "repo", task: "Read spec-01.md and do it", repoPath: cwd, interactive: true },
    });
    expect(parseQuestion("Fix it", cwd, undefined, "repo")).toEqual({ ok: true, run: { mode: "repo", task: "Fix it", repoPath: cwd, interactive: true } });
    expect(parseQuestion("Read @nope.md", cwd, undefined, "repo")).toEqual({ ok: false, error: "@nope.md: no such file" });
  });

  test("repo: each mention is named by the file it checked, never by a spelling the worker would map elsewhere", () => {
    touch("my dir", "a b.md");
    touch("sub", "x.md");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "rlmh-outside-")));
    try {
      writeFileSync(join(outside, "spec.md"), "x");
      const r = parseQuestion(`Do @"my dir/a b.md", @./sub/../sub/x.md and @${join(outside, "spec.md")}`, cwd, undefined, "repo");
      if (!r.ok) throw new Error(r.error);
      expect(r.run.task).toBe(`Do "my dir/a b.md", sub/x.md and ${join(outside, "spec.md").replaceAll("\\", "/")}`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("read: a mention reads as in auto; no mention is refused", () => {
    const a = touch("a.txt");
    expect(parseQuestion("Summarize @a.txt", cwd, undefined, "read")).toEqual({ ok: true, run: { mode: "read", question: "Summarize a.txt", inputs: [a], interactive: true } });
    expect(parseQuestion("What is here?", cwd, undefined, "read")).toEqual({ ok: false, error: "Read mode needs @file mentions. Shift+Tab changes the mode." });
  });
});

describe("mentionToken and mentionText", () => {
  test("only an @ at the end of the line, at the start or after whitespace, is a token", () => {
    expect(mentionToken("@")).toEqual({ start: 0, typed: "" });
    expect(mentionToken("Read @src/ma")).toEqual({ start: 5, typed: "src/ma" });
    expect(mentionToken('Read @"my di')).toEqual({ start: 5, typed: '"my di' });
    expect(mentionToken("Read @a.txt now")).toBeNull();
    expect(mentionToken("Read @a.txt ")).toBeNull();
    expect(mentionToken("mail a@b.com")).toBeNull();
  });

  test("a path with whitespace is quoted, and reads back whole", () => {
    expect(mentionText("src/a.ts")).toBe("src/a.ts");
    expect(mentionText("my dir/a b.txt")).toBe('"my dir/a b.txt"');
    const f = touch("my dir", "a b.txt");
    expect(parseQuestion(`Read @${mentionText("my dir/a b.txt")}`, cwd)).toMatchObject({ ok: true, run: { inputs: [f] } });
  });
});

describe("rankFiles", () => {
  const files = ["README.md", "app/src/main.ts", "app/src/interface/PromptBox.tsx", "app/test/interface/promptbox.test.tsx", "docs/prompt.md", "engine/rlm_engine/loop.py"];

  test("an empty token lists the shallowest files first", () => {
    expect(rankFiles("", files).slice(0, 3)).toEqual(["README.md", "docs/prompt.md", "app/src/main.ts"]);
  });

  test("a file name that starts with the token beats one that only holds it, case-insensitively", () => {
    expect(rankFiles("prompt", files)).toEqual(["docs/prompt.md", "app/src/interface/PromptBox.tsx", "app/test/interface/promptbox.test.tsx"]);
  });

  test("a path part matches, and so do the characters in order", () => {
    // the two that hold "app/src" first; app/test/interface/… holds its characters in order, so it comes last
    expect(rankFiles("app/src", files)).toEqual(["app/src/main.ts", "app/src/interface/PromptBox.tsx", "app/test/interface/promptbox.test.tsx"]);
    expect(rankFiles("rlmloop", files)).toEqual(["engine/rlm_engine/loop.py"]);
    expect(rankFiles("zzz", files)).toEqual([]);
  });

  test("the whole path comes first; quotes are dropped", () => {
    expect(rankFiles("app/src/main.ts", [...files, "app/src/main.ts.bak"])[0]).toBe("app/src/main.ts");
    expect(rankFiles('"docs/prompt.md"', files)[0]).toBe("docs/prompt.md");
  });

  test("at most 50", () => {
    expect(rankFiles("", Array.from({ length: 80 }, (_, i) => `f${i}.txt`))).toHaveLength(50);
  });

  test.if(WIN32)("on Windows a backslash means /", () => {
    expect(rankFiles("app\\src\\main", files)[0]).toBe("app/src/main.ts");
  });
});

describe("listFiles", () => {
  test("outside git: a walk, shallow first, without dot-entries or node_modules", () => {
    touch("b.txt");
    touch("sub", "a.txt");
    touch(".hidden", "x.txt");
    touch(".env");
    touch("node_modules", "pkg", "index.js");
    expect(listFiles(cwd)).toEqual(["b.txt", "sub/a.txt"]);
  });

  test("the list is kept for 10 s, then read again", () => {
    touch("a.txt");
    const t = 1_000_000_000;
    expect(listFiles(cwd, t)).toEqual(["a.txt"]);
    touch("b.txt");
    expect(listFiles(cwd, t + 5_000)).toEqual(["a.txt"]);
    expect(listFiles(cwd, t + 10_000).sort()).toEqual(["a.txt", "b.txt"]); // a folder's entries come in the system's order
  });

  test.if(Bun.which("git") !== null)("in a git work tree: git's list, so ignored files stay out and dot-files tracked in it show", () => {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
    git("init", "-q");
    writeFileSync(join(cwd, ".gitignore"), "build/\n");
    touch("src", "a.ts");
    touch("build", "out.js");
    touch(".github", "ci.yml");
    expect(listFiles(cwd).sort()).toEqual([".github/ci.yml", ".gitignore", "src/a.ts"]);
  });

  test("a missing folder gives [], it never throws", () => {
    expect(listFiles(join(cwd, "nope"))).toEqual([]);
  });

  // writing 20,050 files took from 6 s to 26 s on CI's Windows runners, so it gets a minute
  test("a folder with more files than the cap stops at the cap", () => {
    const big = folder("big");
    for (let i = 0; i < 20_050; i++) writeFileSync(join(big, `f${i}`), "");
    expect(listFiles(cwd).length).toBeLessThanOrEqual(20_000);
  }, 60_000);
});

describe("grapheme cursor helpers", () => {
  const FAMILY = `👨${String.fromCharCode(0x200d)}👩${String.fromCharCode(0x200d)}👧`; // 8 UTF-16 units, one character
  const ACCENT = `e${String.fromCharCode(0x301)}`; // 2 units, one character

  test("prev, next and snap move between whole characters", () => {
    const text = `a😀${FAMILY}${ACCENT}b`;
    const starts = graphemeSpans(text).map((s) => s.start);
    expect(graphemeSpans(text).map((s) => s.text)).toEqual(["a", "😀", FAMILY, ACCENT, "b"]);
    expect(starts).toEqual([0, 1, 3, 11, 13]);
    // forwards through every boundary, then the end
    let at = 0;
    const seen = [at];
    while (at < text.length) seen.push((at = nextGrapheme(text, at)));
    expect(seen).toEqual([...starts, text.length]);
    // and backwards
    const back = [at];
    while (at > 0) back.push((at = prevGrapheme(text, at)));
    expect(back).toEqual([...seen].reverse());
    // an offset inside a character: snap goes to its start, prev too, next goes past its end
    expect(snapToGrapheme(text, 2)).toBe(1);
    expect(snapToGrapheme(text, 7)).toBe(3);
    expect(prevGrapheme(text, 2)).toBe(1);
    expect(nextGrapheme(text, 2)).toBe(3);
    expect(snapToGrapheme(text, 99)).toBe(text.length);
    expect(prevGrapheme(text, 0)).toBe(0);
    expect(nextGrapheme(text, text.length)).toBe(text.length);
    expect(prevGrapheme("", 0)).toBe(0);
    expect(nextGrapheme("", 0)).toBe(0);
  });
});

// ---- screen tests: the PromptBox component (typing, history, slash menu, Tab) are appended below this line ----

describe("PromptBox", () => {
  let app: FakeApp | undefined;
  let m: Mounted | undefined;
  afterEach(async () => {
    m?.unmount();
    await app?.dispose();
    app = m = undefined;
  });

  async function open(): Promise<Mounted> {
    app = await createFakeApp({ scenario: "simpleRead" });
    m = mount(app.deps);
    await m.waitForText("idle");
    return m;
  }
  /** The prompt line's text, between "> " and the right border. */
  const promptLine = (screen: string) => {
    const line = screen.split("\n").find((l) => /^[│|] > /.test(l)) ?? "";
    return line.slice(4, -1).trimEnd();
  };

  test("typing, Left/Right, both backspaces and Ctrl+U", async () => {
    const m = await open();
    await m.type("helo");
    await m.press(KEYS.left);
    await m.type("l");
    await m.waitFor(() => promptLine(m.screen()) === "hello");
    await m.press(KEYS.right);
    await m.press(KEYS.backspace);
    await m.waitFor(() => promptLine(m.screen()) === "hell");
    await m.press(KEYS.ctrlH);
    await m.waitFor(() => promptLine(m.screen()) === "hel");
    await m.press(KEYS.ctrlU);
    await m.waitFor(() => promptLine(m.screen()).includes("Ask a question"));
  });

  test("Left, Right and Backspace move by whole characters: an emoji, a ZWJ family, a letter and its accent", async () => {
    const m = await open();
    await m.type("hi😀");
    await m.waitFor(() => promptLine(m.screen()) === "hi😀");
    await m.press(KEYS.backspace);
    await m.waitFor(() => promptLine(m.screen()) === "hi"); // not half of a surrogate pair left behind
    await m.press(KEYS.ctrlU);
    await m.waitFor(() => promptLine(m.screen()).includes("Ask a question"));

    await m.type("a😀b");
    await m.press(KEYS.left);
    await m.press(KEYS.left); // over the emoji in one step
    await m.type("X");
    await m.waitFor(() => promptLine(m.screen()) === "aX😀b");
    await m.press(KEYS.right); // and back over it in one step
    await m.type("Y");
    await m.waitFor(() => promptLine(m.screen()) === "aX😀Yb");
    await m.press(KEYS.backspace);
    await m.press(KEYS.backspace);
    await m.waitFor(() => promptLine(m.screen()) === "aXb");
    await m.press(String.fromCharCode(5)); // Ctrl+E: to the end, so Ctrl+U takes everything
    await m.press(KEYS.ctrlU);
    await m.waitFor(() => promptLine(m.screen()).includes("Ask a question"));

    // a family is five code points typed one at a time, and one character to delete
    await m.type("x👨‍👩‍👧");
    await m.waitFor(() => promptLine(m.screen()).startsWith("x👨"));
    await m.press(KEYS.backspace);
    await m.waitFor(() => promptLine(m.screen()) === "x");
    // a letter and its combining accent likewise
    await m.type(`e${String.fromCharCode(0x301)}`);
    await m.press(KEYS.left);
    await m.type("-");
    await m.waitFor(() => promptLine(m.screen()) === `x-e${String.fromCharCode(0x301)}`);
    await m.press(KEYS.right);
    await m.press(KEYS.backspace);
    await m.waitFor(() => promptLine(m.screen()) === "x-");
  });

  test("control characters are ignored, and a pasted chunk with a newline does not submit", async () => {
    const m = await open();
    await m.press(KEYS.ctrlV);
    await m.press("first line\nsecond line");
    await m.waitFor(() => promptLine(m.screen()) === "first line second line");
    await m.press("\u001B[200~pasted\r\nlines\u001B[201~");
    await m.waitFor(() => promptLine(m.screen()) === "first line second linepasted lines");
    expect(app!.startCalls).toHaveLength(0);
  });

  test("history with Up and Down, this session only", async () => {
    const m = await open();
    await m.type("/help");
    await m.press(KEYS.enter);
    await m.waitForText("── /help");
    await m.press(KEYS.esc);
    await m.type("/runs");
    await m.press(KEYS.enter);
    await m.waitForText("── /runs");
    await m.press(KEYS.esc);
    await m.type("draft");
    await m.press(KEYS.up);
    await m.waitFor(() => promptLine(m.screen()) === "/runs");
    await m.press(KEYS.up);
    await m.waitFor(() => promptLine(m.screen()) === "/help");
    await m.press(KEYS.down);
    await m.waitFor(() => promptLine(m.screen()) === "/runs");
    await m.press(KEYS.down);
    await m.waitFor(() => promptLine(m.screen()) === "draft");
  });

  test("/ opens the menu, filtered as you type, and Tab completes", async () => {
    const m = await open();
    await m.type("/");
    const all = await m.waitForText("/providers");
    for (const name of ["/model", "/settings", "/permissions", "/context", "/runs", "/help", "/clear", "/quit"]) expect(all).toContain(name);
    await m.type("pe");
    await m.waitFor(() => !m.screen().includes("/providers") && m.screen().includes("/permissions"));
    await m.press(KEYS.tab);
    await m.waitFor(() => promptLine(m.screen()) === "/permissions");
    await m.press(KEYS.enter);
    await m.waitForText("── /permissions");
  });

  test("@ opens the file menu, filtered as you type, and Tab takes the pick", async () => {
    const m = await open();
    mkdirSync(join(app!.deps.cwd, "notes"));
    writeFileSync(join(app!.deps.cwd, "notes", "todo list.md"), "x");
    await m.type("Read @");
    await m.waitForText("  @notes/todo list.md");
    await m.type("todo");
    await m.waitFor(() => m.screen().includes("  @notes/todo list.md") && !m.screen().includes("  @a.txt"));
    await m.press(KEYS.tab);
    await m.waitFor(() => promptLine(m.screen()) === 'Read @"notes/todo list.md"');
    expect(m.screen()).not.toContain("  @notes/todo list.md"); // the space after the pick closed the menu
    await m.type("and @a");
    await m.press(KEYS.enter); // Enter takes the pick too
    await m.waitFor(() => promptLine(m.screen()) === 'Read @"notes/todo list.md" and @a.txt');
    expect(app!.startCalls).toHaveLength(0);
    await m.press(KEYS.enter);
    await m.waitFor(() => app!.startCalls.length === 1);
    expect(app!.startCalls[0]!.inputs).toEqual([join(app!.deps.cwd, "notes", "todo list.md"), join(app!.deps.cwd, "a.txt")]);
  });

  test("in the file menu Up and Down move the pick, and a mention that already names a file submits", async () => {
    const m = await open();
    for (const name of ["one.md", "two.md"]) writeFileSync(join(app!.deps.cwd, name), "x");
    await m.type("Read @.md");
    await m.waitForText("  @two.md");
    await m.press(KEYS.down);
    await m.press(KEYS.tab);
    await m.waitFor(() => promptLine(m.screen()) === "Read @two.md");
    await m.press(KEYS.backspace); // back into the mention: the menu opens on two.md, which it names, so Enter submits
    await m.waitForText("  @two.md");
    await m.press(KEYS.enter);
    await m.waitFor(() => app!.startCalls.length === 1);
    expect(app!.startCalls[0]!.inputs).toEqual([join(app!.deps.cwd, "two.md")]);
  });

  test("Enter keeps a mention that already names a file, though the menu's first pick is another", async () => {
    const m = await open();
    writeFileSync(join(app!.deps.cwd, ".notes.md"), "x"); // a dot-file: not in the menu's list
    writeFileSync(join(app!.deps.cwd, "my.notes.md"), "x");
    await m.type("Read @.notes.md");
    await m.waitForText("  @my.notes.md");
    await m.press(KEYS.enter);
    await m.waitFor(() => app!.startCalls.length === 1);
    expect(app!.startCalls[0]!.inputs).toEqual([join(app!.deps.cwd, ".notes.md")]);
  });

  test("Esc's close lasts only until the text changes, even back to the same text", async () => {
    const m = await open();
    await m.type("Read @a");
    await m.waitForText("  @a.txt");
    await m.press(KEYS.esc);
    await m.waitFor(() => !m.screen().includes("  @a.txt"));
    await m.type(".");
    await m.waitForText("  @a.txt");
    await m.press(KEYS.backspace); // back to "Read @a": open, not closed again
    await m.waitFor(() => promptLine(m.screen()) === "Read @a");
    await Bun.sleep(100);
    expect(m.screen()).toContain("  @a.txt");
  });

  test("Esc closes the file menu and keeps the text; typing opens it again; a second Esc clears", async () => {
    const m = await open();
    await m.type("Read @a");
    await m.waitForText("  @a.txt");
    await m.press(KEYS.esc);
    await m.waitFor(() => !m.screen().includes("  @a.txt"));
    expect(promptLine(m.screen())).toBe("Read @a");
    await m.type(".");
    await m.waitForText("  @a.txt");
    await m.press(KEYS.esc);
    await m.waitFor(() => !m.screen().includes("  @a.txt"));
    await m.press(KEYS.esc);
    await m.waitFor(() => promptLine(m.screen()).includes("Ask a question"));
  });
});
