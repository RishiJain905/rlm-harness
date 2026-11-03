// KV cache: none; the interface never touches the bytes sent to the model.
// The open conversation of the interactive app (v1 step 4, v1 architecture §5): what a run started
// with `conversation: true` was started with, and `continues`, D-178's rules for whether the next
// question is a follow-up in it (`run.say`) or starts a fresh run.

import type { ModelRef } from "../protocol.ts";

export interface Conversation {
  runId: string;
  mode: "read" | "repo";
  /** A read conversation's input files as run.started gave them; [] for repo. */
  files: string[];
  /** The folder the app ran in (deps.cwd). */
  folder: string;
  /** `refKey` of the root and sub models the run was started with. */
  root: string;
  sub: string;
  profile: string;
  permissionMode: string;
  /** The last prompt that finished: 0 after the first question, k after follow-up k. */
  promptIndex: number;
  /** True while the engine waits for run.say: set by run.finished {open}, cleared by run.closed. */
  open: boolean;
}

/** A model as `continues` compares it: provider, model and thinking, so a thinking change is a model change too. */
export function refKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}${ref.thinking === null ? "" : ` (thinking ${ref.thinking})`}`;
}

/** A path as `continues` compares it: `/` only, and on win32 without case, as parseQuestion dedupes inputs. */
function pathKey(path: string): string {
  const p = path.replaceAll("\\", "/");
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a.map(pathKey));
  const y = new Set(b.map(pathKey));
  return x.size === y.size && [...x].every((p) => y.has(p));
}

/**
 * D-178: true when the next question continues `conv`. `q.mentions` are the question's `@` mentions as absolute paths
 * (mentionPaths), `q.choice` its Shift+Tab mode, and `now` what a fresh run would start with (`permissionMode` is
 * nextMode). The `conversation.follow_ups` setting is the caller's check (rule 2).
 *  1. root, sub, profile and permission mode equal the conversation's;
 *  2. the conversation is open;
 *  3. `auto`: no mentions continues any conversation; mentions continue a read conversation on exactly its files;
 *  4. `repo`: only a repo conversation in the same folder;
 *  5. `read`: only a read conversation, with no mentions or exactly its files.
 */
export function continues(
  conv: Conversation,
  q: { mentions: string[]; choice: "auto" | "repo" | "read" },
  now: { root: string; sub: string; profile: string; permissionMode: string; folder?: string },
): boolean {
  if (conv.root !== now.root || conv.sub !== now.sub || conv.profile !== now.profile || conv.permissionMode !== now.permissionMode) return false;
  if (!conv.open) return false;
  switch (q.choice) {
    case "auto":
      return q.mentions.length === 0 || (conv.mode === "read" && sameFiles(q.mentions, conv.files));
    case "repo":
      return conv.mode === "repo" && (now.folder === undefined || pathKey(now.folder) === pathKey(conv.folder));
    case "read":
      return conv.mode === "read" && (q.mentions.length === 0 || sameFiles(q.mentions, conv.files));
  }
}
