// KV cache: none; a test.
// `continues` (v1 step 4, D-178) as a table: rules 1 to 5, each case a conversation, a question and the next run's models.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { continues, refKey, type Conversation } from "../../src/interface/conversation.ts";

const DIR = join(process.platform === "win32" ? "C:\\" : "/", "work");
const A = join(DIR, "a.txt");
const B = join(DIR, "b.txt");

const ROOT = refKey({ provider: "fake", model: "scripted", thinking: null });
const NOW = { root: ROOT, sub: ROOT, profile: "default", permissionMode: "accept-edits", folder: DIR };

/** A read conversation on a.txt, as run.started reports it (`/` separators), open between prompts. */
function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    runId: "r_000000000001",
    mode: "read",
    files: [A.replaceAll("\\", "/")],
    folder: DIR,
    root: ROOT,
    sub: ROOT,
    profile: "default",
    permissionMode: "accept-edits",
    promptIndex: 0,
    open: true,
    ...over,
  };
}

const repoConv = (over: Partial<Conversation> = {}) => conv({ mode: "repo", files: [], ...over });

type Row = [name: string, c: Conversation, mentions: string[], choice: "auto" | "repo" | "read", now: Partial<typeof NOW>, expected: boolean];

const ROWS: Row[] = [
  // rule 1: the same models, profile and permission mode
  ["1: all the same", conv(), [], "auto", {}, true],
  ["1: another root", conv(), [], "auto", { root: "fake/other" }, false],
  ["1: the root's thinking changed", conv(), [], "auto", { root: refKey({ provider: "fake", model: "scripted", thinking: "low" }) }, false],
  ["1: another sub", conv(), [], "auto", { sub: "openai/gpt-x" }, false],
  ["1: another profile", conv(), [], "auto", { profile: "training-v4" }, false],
  ["1: another permission mode (nextMode)", conv(), [], "auto", { permissionMode: "bypass" }, false],
  // rule 2: open
  ["2: closed", conv({ open: false }), [], "auto", {}, false],
  ["2: closed, repo", repoConv({ open: false }), [], "repo", {}, false],
  // rule 3: auto
  ["3: auto, no mentions, read conversation", conv(), [], "auto", {}, true],
  ["3: auto, no mentions, repo conversation", repoConv(), [], "auto", {}, true],
  ["3: auto, the same file", conv(), [A], "auto", {}, true],
  ["3: auto, the same file twice", conv(), [A, A], "auto", {}, true],
  ["3: auto, another file", conv(), [B], "auto", {}, false],
  ["3: auto, one more file", conv(), [A, B], "auto", {}, false],
  ["3: auto, fewer files", conv({ files: [A, B] }), [A], "auto", {}, false],
  ["3: auto, the same files in another order", conv({ files: [A, B] }), [B, A], "auto", {}, true],
  ["3: auto, mentions in a repo conversation", repoConv(), [A], "auto", {}, false],
  // rule 4: repo
  ["4: repo, repo conversation", repoConv(), [], "repo", {}, true],
  ["4: repo, repo conversation, a file named", repoConv(), [A], "repo", {}, true],
  ["4: repo, read conversation", conv(), [], "repo", {}, false],
  ["4: repo, another folder", repoConv(), [], "repo", { folder: join(DIR, "sub") }, false],
  // rule 5: read
  ["5: read, no mentions", conv(), [], "read", {}, true],
  ["5: read, the same file", conv(), [A], "read", {}, true],
  ["5: read, another file", conv(), [B], "read", {}, false],
  ["5: read, repo conversation", repoConv(), [], "read", {}, false],
];

describe("continues", () => {
  for (const [name, c, mentions, choice, now, expected] of ROWS) {
    test(name, () => {
      expect(continues(c, { mentions, choice }, { ...NOW, ...now })).toBe(expected);
    });
  }

  test("paths compare with / and, on win32, without case", () => {
    const upper = process.platform === "win32" ? A.toUpperCase() : A;
    expect(continues(conv(), { mentions: [upper], choice: "auto" }, NOW)).toBe(true);
  });

  test("refKey: provider/model, and the thinking when it is set", () => {
    expect(refKey({ provider: "fake", model: "scripted", thinking: null })).toBe("fake/scripted");
    expect(refKey({ provider: "openrouter", model: "x/y@ep", thinking: "high" })).toBe("openrouter/x/y@ep (thinking high)");
  });
});
