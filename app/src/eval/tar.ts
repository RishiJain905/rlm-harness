// KV cache: none
// A small ustar reader for eval set tars (D-188), so a work copy has the same bytes on every OS:
// Windows tar.exe (bsdtar) and Git Bash's GNU tar differ on modes and long names, and GNU tar reads
// `C:\…` as a remote host. Regular files and folders only, with pax `path` records and GNU `L` long
// names; links and every other type are refused, as are paths that could land outside the copy.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface TarEntry {
  /** The entry's path, `/`-separated, with no trailing slash. */
  path: string;
  type: "file" | "dir";
  /** The permission bits from the header. */
  mode: number;
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A NUL-terminated header field. */
function field(h: Uint8Array, at: number, len: number): Uint8Array {
  const end = h.subarray(at, at + len).indexOf(0);
  return h.subarray(at, end < 0 ? at + len : at + end);
}

function text(bytes: Uint8Array, what: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`tar: ${what} is not UTF-8`);
  }
}

/** An octal number field, or GNU's base-256 form when the high bit is set. */
function number(h: Uint8Array, at: number, len: number): number {
  if (h[at]! & 0x80) {
    let n = h[at]! & 0x7f;
    for (let i = at + 1; i < at + len; i++) n = n * 256 + h[i]!;
    return n;
  }
  const s = new TextDecoder().decode(field(h, at, len)).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`tar: a header number is not octal (${JSON.stringify(s)})`);
  return parseInt(s, 8);
}

function checksumOk(h: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return number(h, 148, 8) === sum;
}

/** pax `len key=value\n` records. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = parseInt(new TextDecoder().decode(data.subarray(at, space)), 10);
    if (!Number.isFinite(len) || len <= 0 || at + len > data.length) throw new Error("tar: a pax record is malformed");
    const record = text(data.subarray(space + 1, at + len - 1), "a pax record");
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return out;
}

const WINDOWS_BAD = /[<>:"|?*\u0000-\u001f]/;
/** Windows device names: `CON`, `NUL.txt` and the like open the device, not a file, whatever the folder (SR-4). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** The entry's path as `/` parts, or throws: no absolute path, drive letter, `..`, or a name Windows can't hold. */
export function safePath(raw: string): string {
  const name = raw.replace(/\/+$/, "");
  if (name === "" || name === ".") throw new Error(`tar: an entry has an empty name`);
  if (/^[\\/]/.test(name)) throw new Error(`tar: ${JSON.stringify(raw)} is an absolute path`);
  if (/^[A-Za-z]:/.test(name)) throw new Error(`tar: ${JSON.stringify(raw)} names a drive`);
  const parts = name.split(/[\\/]/).filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`tar: ${JSON.stringify(raw)} has a .. part`);
  for (const p of parts) {
    if (WINDOWS_BAD.test(p) || /[. ]$/.test(p)) throw new Error(`tar: ${JSON.stringify(raw)} has a name that some OSes can't hold`);
    if (WINDOWS_DEVICE.test(p)) throw new Error(`tar: ${JSON.stringify(raw)} has a name that is a device on Windows`);
  }
  return parts.join("/");
}

/** Reads every entry; a `.tar.gz` (gzip magic) is gunzipped first. Throws on anything it refuses. */
export function readTar(input: Uint8Array): TarEntry[] {
  const bytes = input[0] === 0x1f && input[1] === 0x8b ? new Uint8Array(Bun.gunzipSync(input as Uint8Array<ArrayBuffer>)) : input;
  const entries: TarEntry[] = [];
  const folded = new Map<string, TarEntry>();
  const prefixes = new Map<string, string>(); // folded parent folder -> its spelling
  let at = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (at + BLOCK <= bytes.length) {
    const h = bytes.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break; // the end blocks
    if (!checksumOk(h)) throw new Error(`tar: a header checksum is wrong at byte ${at}`);
    const size = number(h, 124, 12);
    const type = String.fromCharCode(h[156]!);
    const dataStart = at + BLOCK;
    if (dataStart + size > bytes.length) throw new Error("tar: an entry runs past the end of the archive");
    const data = bytes.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    const magic = new TextDecoder().decode(h.subarray(257, 263));
    let name = text(field(h, 0, 100), "an entry name");
    if (magic === "ustar\u0000") {
      const prefix = text(field(h, 345, 155), "an entry name");
      if (prefix !== "") name = `${prefix}/${name}`;
    }
    if (type === "x") {
      const path = paxRecords(data).get("path");
      if (path !== undefined) paxPath = path;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = text(field(data, 0, data.length), "a long name");
      continue;
    }
    if (paxPath !== null) name = paxPath;
    else if (longName !== null) name = longName;
    paxPath = null;
    longName = null;
    if (type !== "0" && type !== "\u0000" && type !== "5") {
      const what = type === "1" ? "a hard link" : type === "2" ? "a symlink" : `of type ${JSON.stringify(type)}`;
      throw new Error(`tar: ${JSON.stringify(name)} is ${what}; only files and folders are allowed`);
    }
    const path = safePath(name);
    const entry: TarEntry = { path, type: type === "5" ? "dir" : "file", mode: number(h, 100, 8) & 0o7777, data };
    // every parent folder too: `A/x` and `a/y` are one folder on Windows and macOS, two on Linux
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const seen = prefixes.get(prefix.normalize("NFC").toLowerCase());
      if (seen !== undefined && seen !== prefix) throw new Error(`tar: ${JSON.stringify(seen)} and ${JSON.stringify(prefix)} are the same folder on a case-insensitive disk`);
      prefixes.set(prefix.normalize("NFC").toLowerCase(), prefix);
    }
    const key = path.normalize("NFC").toLowerCase();
    const before = folded.get(key);
    if (before !== undefined && !(before.type === "dir" && entry.type === "dir" && before.path === path)) {
      throw new Error(`tar: ${JSON.stringify(before.path)} and ${JSON.stringify(path)} are the same path on a case-insensitive disk`);
    }
    folded.set(key, entry);
    entries.push(entry);
  }
  return entries;
}

/** Writes every entry under `dest` byte for byte (CRLF kept), with the executable bit on POSIX. Returns the entries. */
export function extractTar(input: Uint8Array, dest: string): TarEntry[] {
  const entries = readTar(input);
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  for (const e of entries) {
    const target = join(root, ...e.path.split("/"));
    if (!target.startsWith(root + sep)) throw new Error(`tar: ${JSON.stringify(e.path)} lands outside ${root}`);
    if (e.type === "dir") {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, e.data);
    if (process.platform !== "win32") chmodSync(target, e.mode & 0o111 ? 0o755 : 0o644);
  }
  return entries;
}
