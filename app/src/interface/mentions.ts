// KV cache: none; the interface never touches the bytes sent to the model.
// What a typed question means (6c): `@path` mentions make a read-mode run over those files, no
// mention makes a repo-mode run on the folder. Also the `@path` completion for the prompt box.

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StartRun } from "../session.ts";

/** What `parseQuestion` needs from the file system; tests pass a fake. `other` is anything that exists and is neither a file nor a folder. */
export interface FileProbe {
  stat(path: string): "file" | "dir" | "other" | "missing";
}

const nodeProbe: FileProbe = {
  stat(path) {
    try {
      const s = statSync(path, { throwIfNoEntry: false });
      if (!s) return "missing";
      return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
    } catch {
      return "missing"; // ENOTDIR, EACCES and the like: the run could not read it either
    }
  },
};

// `a@b.com` is no mention: the `@` must start the text or follow whitespace (6c).
const MENTION = /(^|\s)@("[^"]+"|\S+)/g;
const QUOTED = /^"[^"]+"$/;

export type ParsedQuestion = { ok: true; run: StartRun } | { ok: false; error: string };

/**
 * Pure apart from `fs` (which defaults to node's `statSync`). Paths resolve against `cwd`. `\` means
 * `/` except on win32, where node:path takes both and `C:\temp\a.txt` is a path. The `question`
 * carries each mention's path as typed with every `\` written as `/` (D-17), quotes and `@` dropped.
 * `inputs` are absolute and deduplicated in order. The first mention that is not a file stops it.
 */
export function parseQuestion(text: string, cwd: string, fs: FileProbe = nodeProbe): ParsedQuestion {
  const mentions = [...text.matchAll(MENTION)];
  if (mentions.length === 0) {
    return { ok: true, run: { mode: "repo", task: text, repoPath: cwd, interactive: true } };
  }
  const win32 = process.platform === "win32";
  const inputs: string[] = [];
  const seen = new Set<string>();
  let question = "";
  let last = 0;
  for (const m of mentions) {
    const lead = m[1] as string;
    const token = m[2] as string;
    const typed = QUOTED.test(token) ? token.slice(1, -1) : token;
    const absolute = resolve(cwd, win32 ? typed : typed.replaceAll("\\", "/"));
    const kind = fs.stat(absolute);
    if (kind === "missing") return { ok: false, error: `@${token}: no such file` };
    if (kind !== "file") return { ok: false, error: `@${token}: not a file` };
    const key = win32 ? absolute.toLowerCase() : absolute;
    if (!seen.has(key)) {
      seen.add(key);
      inputs.push(absolute);
    }
    const start = (m.index ?? 0) + lead.length;
    question += text.slice(last, start) + typed.replaceAll("\\", "/");
    last = (m.index ?? 0) + m[0].length;
  }
  question += text.slice(last);
  return { ok: true, run: { mode: "read", question, inputs, interactive: true } };
}

const MAX_COMPLETIONS = 50;

/**
 * Candidates for what follows `@`. `prefix` is the text typed after the `@`, possibly starting with
 * `"`. Each candidate replaces all of it: the folder part as typed, then an entry name that starts
 * with the typed basename (case-sensitive; dot-entries only if the basename starts with a dot),
 * with `/` after a folder. A candidate that needs quotes (the user typed one, or the path holds
 * whitespace) starts with `"`, and a file also gets the closing `"`. Sorted, at most 50. Unreadable
 * or missing folders give `[]`; it never throws.
 */
export function completePath(prefix: string, cwd: string): string[] {
  try {
    const quoted = prefix.startsWith('"');
    const typed = quoted ? prefix.slice(1) : prefix;
    let cut = typed.lastIndexOf("/");
    if (process.platform === "win32") cut = Math.max(cut, typed.lastIndexOf("\\"));
    const folder = typed.slice(0, cut + 1);
    const base = typed.slice(cut + 1);
    const dir = resolve(cwd, folder);
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(base) && (base.startsWith(".") || !e.name.startsWith(".")))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_COMPLETIONS);
    return entries.map((e) => {
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, e.name)).isDirectory();
        } catch {
          // a broken link is a file as far as completion goes
        }
      }
      const path = folder + e.name + (isDir ? "/" : "");
      if (!quoted && !/\s/.test(path)) return path;
      return isDir ? `"${path}` : `"${path}"`;
    });
  } catch {
    return [];
  }
}
