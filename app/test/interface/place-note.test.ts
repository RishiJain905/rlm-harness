// KV cache: none
// approvals.ts placeNote and touchesGitDir (SR-2): a write the engine marks outside the workspace because it
// touches .git is named as such in the prompt's head line; every other outside write keeps the old note.
// Pure, no Ink: it runs without node_modules.

import { expect, test } from "bun:test";
import type { ApprovalParams } from "../../src/protocol.ts";
import { placeNote, touchesGitDir } from "../../src/interface/approvals.ts";

const params = (kind: ApprovalParams["kind"], detail: string, inside: boolean): ApprovalParams => ({ run_id: "r_1", kind, detail, turn: 3, inside_workspace: inside });

test("touchesGitDir sees a .git segment in either side of a rename, on both separators, in any case", () => {
  expect(touchesGitDir("/w/repo/.git/hooks/pre-commit")).toBe(true);
  expect(touchesGitDir("C:\\w\\repo\\.GIT\\config")).toBe(true);
  expect(touchesGitDir("/w/repo/a.py -> /w/repo/.git/hooks/x")).toBe(true);
  expect(touchesGitDir("/w/repo/.gitignore")).toBe(false);
  expect(touchesGitDir("/w/repo/src/gitstuff/notes.git.txt")).toBe(false);
  expect(touchesGitDir("/w/repo/a.py -> /w/repo/b.py")).toBe(false);
});

test("placeNote names .git writes, keeps 'outside the workspace' for the rest, and nothing for inside writes", () => {
  expect(placeNote(params("write", "/w/repo/.git/config", false))).toBe("in the repository's .git folder");
  expect(placeNote(params("write", "/etc/hosts", false))).toBe("outside the workspace");
  expect(placeNote(params("write", "/w/repo/a.py", true))).toBeNull();
  expect(placeNote(params("network", "example.com", false))).toBe("outside the workspace");
  expect(placeNote(params("shell", "ls", true))).toBeNull();
});
