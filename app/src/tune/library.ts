// KV cache: none
// The experience library (v1 architecture §7.7, D-175), after harness2's core/library.py at 6868817
// (`Library.add` L106, `rebuild_index` L154): one entry folder per lesson, with the harness it came from,
// and an INDEX.md of cue lines rebuilt from the folders on disk. The reflector writes it; editor and
// composer sessions read it through their evidence; ordinary runs never do.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GRADE_MARKERS } from "./evidence.ts";
import type { EditRow, LibraryEntry } from "./sessions.ts";

export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cell = (s: string) => oneLine(s).replace(/\|/g, "\\|");

/** EXPERIENCE.md: the lesson, its evidence and confidence, then the edits as a table. */
export function experienceText(id: string, entry: LibraryEntry, edits: EditRow[]): string {
  return [
    `# ${id}`,
    "",
    `cue: ${oneLine(entry.cue)}`,
    "",
    `lesson: ${oneLine(entry.lesson)}`,
    "",
    `evidence: ${oneLine(entry.evidence)}`,
    "",
    `confidence: ${entry.confidence}`,
    "",
    "## Edits",
    "",
    "| component | candidates | change | observed | verdict |",
    "|---|---|---|---|---|",
    ...edits.map((e) => `| ${cell(e.component)} | ${cell(e.candidates)} | ${cell(e.change)} | ${cell(e.observed)} | ${e.verdict} |`),
    "",
  ].join("\n");
}

/** The cue of an entry folder's EXPERIENCE.md, or null. */
function cueOf(file: string): string | null {
  try {
    const m = /^cue: (.*)$/m.exec(readFileSync(file, "utf8"));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Rebuilds `<root>/<domain>/INDEX.md` from the entry folders on disk, sorted by id. */
export function rebuildIndex(root: string, domain: string): void {
  const dir = join(root, domain);
  const entries = join(dir, "entries");
  const ids = existsSync(entries) ? readdirSync(entries).filter((id) => existsSync(join(entries, id, "EXPERIENCE.md"))).sort() : [];
  const lines = ids.flatMap((id) => {
    const cue = cueOf(join(entries, id, "EXPERIENCE.md"));
    return cue === null ? [] : [`- ${cue} -> entries/${id}/EXPERIENCE.md`];
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INDEX.md"), `# ${domain} library\n\n${lines.length > 0 ? lines.join("\n") : "(no entries yet)"}\n`);
}

/**
 * Writes one entry, `<root>/<domain>/entries/<id>/` (EXPERIENCE.md and harness/ with the composed profile.toml and
 * guidance.md), then rebuilds the index. NO_ENTRY writes nothing. A grade marker anywhere throws.
 */
export function addEntry(root: string, domain: string, id: string, entry: LibraryEntry | "NO_ENTRY", edits: EditRow[], harness: string): boolean {
  if (entry === "NO_ENTRY") return false;
  const text = experienceText(id, entry, edits);
  const files: [string, string][] = [
    ["EXPERIENCE.md", text],
    ["harness/profile.toml", readFileSync(join(harness, "profile.toml"), "utf8")],
    ["harness/guidance.md", readFileSync(join(harness, "guidance.md"), "utf8")],
    ...(existsSync(join(harness, "system.md")) ? ([["harness/system.md", readFileSync(join(harness, "system.md"), "utf8")]] as [string, string][]) : []),
  ];
  for (const [name, body] of files) {
    const m = GRADE_MARKERS.find((x) => body.includes(x) || name.includes(x));
    if (m !== undefined) throw new LibraryError(`library entry ${id}: ${name} contains ${JSON.stringify(m)}, which only a grader's output holds`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new LibraryError(`library entry id ${JSON.stringify(id)} is not a plain name`);
  const dir = join(root, domain, "entries", id);
  if (existsSync(dir)) throw new LibraryError(`library entry ${id} already exists`);
  mkdirSync(join(dir, "harness"), { recursive: true });
  for (const [name, body] of files) writeFileSync(join(dir, ...name.split("/")), body);
  for (const extra of ["skills", "scripts"]) if (existsSync(join(harness, extra))) cpSync(join(harness, extra), join(dir, "harness", extra), { recursive: true });
  rebuildIndex(root, domain);
  return true;
}

/**
 * `/tune`'s library domain for a user's task (architecture §7.7, v1 step 9): `read`, or `repo-<slug>` where the
 * slug is the repo folder's name in lower case, each run of other characters a `-`, at most 48 characters
 * (`repo-folder` when nothing is left). Its root is `libraryDir(home)`.
 */
export function userDomain(task: { mode: "read" | "repo"; folder?: string }): string {
  if (task.mode === "read") return "read";
  const name = basename((task.folder ?? "").replace(/[\\/]+$/, ""));
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `repo-${slug === "" ? "folder" : slug}`;
}

export { copyLibrary } from "./evidence.ts";
