// KV cache: none
// The fixture eval set `harness-eval-fixture` (v1 step 2): its text files and plain source trees live in
// test/fixtures/evalset/, and buildFixtureSet packs the trees into tars with a test-only ustar writer and
// writes manifest.json with the real hashes, so no binary is committed. A file whose name ends in `.in`
// is packed without that suffix, so `bun test` never mistakes a Playwright spec for one of its own.

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "evalset");
export const FIXTURE_NAME = "harness-eval-fixture";
export const TASK_IDS = ["fx-search-R-01", "fx-research-R-01", "fx-python-S-01", "fx-python-S-02", "fx-kernel-S-01", "fx-web-S-01"];

export interface TarInput {
  path: string;
  data?: Uint8Array | string;
  /** Default 0o644 (files) or 0o755 (folders). */
  mode?: number;
  /** "0" file (default), "5" folder, "2" symlink, or any other type flag. */
  type?: string;
  linkname?: string;
}

const enc = new TextEncoder();
const bytesOf = (d: Uint8Array | string | undefined) => (d === undefined ? new Uint8Array() : typeof d === "string" ? enc.encode(d) : d);

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function header(name: Uint8Array, size: number, mode: number, type: string, linkname = ""): Uint8Array {
  const h = new Uint8Array(512);
  h.set(name.subarray(0, 100), 0);
  h.set(enc.encode(octal(mode, 8)), 100);
  h.set(enc.encode(octal(0, 8)), 108);
  h.set(enc.encode(octal(0, 8)), 116);
  h.set(enc.encode(octal(size, 12)), 124);
  h.set(enc.encode(octal(0, 12)), 136);
  h.set(enc.encode("        "), 148);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode(linkname).subarray(0, 100), 157);
  h.set(enc.encode("ustar\u000000"), 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return h;
}

const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

/** A ustar archive; names over 100 bytes go through pax `x` records or GNU `L` entries. */
export function writeTar(entries: TarInput[], o: { longNames?: "pax" | "gnu" } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (h: Uint8Array, data: Uint8Array) => parts.push(h, data, pad(data.length));
  for (const e of entries) {
    const type = e.type ?? "0";
    const data = type === "0" ? bytesOf(e.data) : new Uint8Array();
    const name = enc.encode(e.path + (type === "5" && !e.path.endsWith("/") ? "/" : ""));
    if (name.length > 100) {
      if ((o.longNames ?? "pax") === "pax") {
        const body = ` path=${new TextDecoder().decode(name)}\n`;
        let len = body.length;
        while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
        const record = enc.encode(`${len}${body}`);
        push(header(enc.encode("PaxHeader"), record.length, 0o644, "x"), record);
      } else {
        const long = new Uint8Array([...name, 0]);
        push(header(enc.encode("././@LongLink"), long.length, 0o644, "L"), long);
      }
    }
    push(header(name, data.length, e.mode ?? (type === "5" ? 0o755 : 0o644), type, e.linkname), data);
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Every file under `dir`, as tar entries with `/` paths, sorted. */
function treeEntries(dir: string): TarInput[] {
  const out: TarInput[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).replace(/\\/g, "/").replace(/\.in$/, ""), data: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(dir);
  return out;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface FixtureOpts {
  /** The manifest's kernel_validated_on; default ["hip"]. */
  kernelValidatedOn?: string[];
}

/** Builds the fixture set in `<tmp>/harness-eval-fixture/` and returns that folder. */
export function buildFixtureSet(tmp: string, o: FixtureOpts = {}): string {
  const dir = join(tmp, FIXTURE_NAME);
  mkdirSync(join(dir, "repos"), { recursive: true });
  mkdirSync(join(dir, "hidden"), { recursive: true });
  for (const name of ["ctx", "venvs", "nodeenvs"]) cpSync(join(FIXTURE, name), join(dir, name), { recursive: true });
  const tasksBytes = new Uint8Array(readFileSync(join(FIXTURE, "tasks.jsonl")));
  const gradesBytes = new Uint8Array(readFileSync(join(FIXTURE, "grades.jsonl")));
  writeFileSync(join(dir, "tasks.jsonl"), tasksBytes);
  writeFileSync(join(dir, "grades.jsonl"), gradesBytes);
  const shim = treeEntries(join(FIXTURE, "gpu")); // gpu.py and gpu_compat.h at the kernel task's root
  for (const id of readdirSync(join(FIXTURE, "src"))) {
    const entries = [...treeEntries(join(FIXTURE, "src", id)), ...(id.startsWith("fx-kernel-") ? shim : [])].sort((a, b) => (a.path < b.path ? -1 : 1));
    writeFileSync(join(dir, "repos", `${id}.tar`), writeTar(entries));
  }
  for (const id of readdirSync(join(FIXTURE, "hidden-src"))) {
    writeFileSync(join(dir, "hidden", `${id}.tar.gz`), Bun.gzipSync(writeTar(treeEntries(join(FIXTURE, "hidden-src", id))) as Uint8Array<ArrayBuffer>));
  }
  const counts: Record<string, number> = {};
  for (const line of new TextDecoder().decode(tasksBytes).split("\n")) {
    if (line.trim() === "") continue;
    const t = JSON.parse(line);
    const key = `${t.split}/${t.track}/${t.size}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const manifest = {
    format: 1,
    name: FIXTURE_NAME,
    created: "2026-11-02T00:00:00Z",
    builder: { repo: "RishiJain905/rlm-harness", commit: "fixture", dirty: false },
    permission_mode: "bypass",
    validated: true,
    kernel_validated_on: o.kernelValidatedOn ?? ["hip"],
    counts: Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]])),
    tasks_sha256: sha256(tasksBytes),
    grades_sha256: sha256(gradesBytes),
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  return dir;
}

/** Rewrites a set's tasks.jsonl and grades.jsonl through `edit`, and the manifest's hashes with them (for tests that need a changed set). */
export function editSet(dir: string, edit: (tasks: any[], grades: any[]) => void, o: { rehash?: boolean } = {}): void {
  const read = (name: string) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  const tasks = read("tasks.jsonl");
  const grades = read("grades.jsonl");
  edit(tasks, grades);
  const t = enc.encode(tasks.map((x) => `${JSON.stringify(x)}\n`).join(""));
  const g = enc.encode(grades.map((x) => `${JSON.stringify(x)}\n`).join(""));
  writeFileSync(join(dir, "tasks.jsonl"), t);
  writeFileSync(join(dir, "grades.jsonl"), g);
  if (o.rehash ?? true) {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.tasks_sha256 = sha256(t);
    m.grades_sha256 = sha256(g);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, 1)}\n`);
  }
}
