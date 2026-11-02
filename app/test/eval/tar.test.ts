// KV cache: none
// The ustar reader (D-188): bytes and modes kept, long names, and every entry it must refuse.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTar, readTar } from "../../src/eval/tar.ts";
import { writeTar } from "./fixture.ts";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rlmh-tar-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ODD = new Uint8Array([0x61, 0x0d, 0x0a, 0x00, 0x62, 0x0a]); // CRLF, a NUL byte, LF

test("a round trip keeps bytes, UTF-8 names and the executable bit", () => {
  const tar = writeTar([
    { path: "dir", type: "5" },
    { path: "dir/odd.bin", data: ODD },
    { path: "dir/naïve-文字.txt", data: "ünïcödé\r\n" },
    { path: "run.sh", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
  ]);
  const dest = join(tmp, "round");
  const entries = extractTar(tar, dest);
  expect(entries.map((e) => e.path)).toEqual(["dir", "dir/odd.bin", "dir/naïve-文字.txt", "run.sh"]);
  expect(new Uint8Array(readFileSync(join(dest, "dir", "odd.bin")))).toEqual(ODD);
  expect(readFileSync(join(dest, "dir", "naïve-文字.txt"), "utf8")).toBe("ünïcödé\r\n");
  if (process.platform !== "win32") {
    expect(statSync(join(dest, "run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(dest, "dir", "odd.bin")).mode & 0o111).toBe(0);
  }
  expect(entries.find((e) => e.path === "run.sh")!.mode & 0o111).not.toBe(0);
});

test("a 150-character name works through pax and through GNU L", () => {
  const long = `${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(24)}.txt`;
  expect(long.length).toBe(150);
  for (const how of ["pax", "gnu"] as const) {
    const entries = readTar(writeTar([{ path: long, data: "x" }], { longNames: how }));
    expect(entries.map((e) => e.path)).toEqual([long]);
  }
});

test("it refuses ../x, /etc/x, C:x, a symlink and two names that differ only in case", () => {
  expect(() => readTar(writeTar([{ path: "../x", data: "" }]))).toThrow(".. part");
  expect(() => readTar(writeTar([{ path: "/etc/x", data: "" }]))).toThrow("absolute path");
  expect(() => readTar(writeTar([{ path: "C:x", data: "" }]))).toThrow("names a drive");
  expect(() => readTar(writeTar([{ path: "link", type: "2", linkname: "/etc/passwd" }]))).toThrow("is a symlink");
  expect(() => readTar(writeTar([{ path: "hard", type: "1", linkname: "a" }]))).toThrow("is a hard link");
  expect(() => readTar(writeTar([{ path: "Readme.md", data: "" }, { path: "README.md", data: "" }]))).toThrow("case-insensitive");
  expect(() => readTar(writeTar([{ path: "A/x.py", data: "" }, { path: "a/y.py", data: "" }]))).toThrow("same folder on a case-insensitive disk");
});

test("a .tar.gz round trip works", () => {
  const gz = Bun.gzipSync(writeTar([{ path: "a/b.txt", data: ODD }]) as Uint8Array<ArrayBuffer>);
  const entries = extractTar(new Uint8Array(gz), join(tmp, "gz"));
  expect(entries.map((e) => [e.path, e.type])).toEqual([["a/b.txt", "file"]]);
  expect(new Uint8Array(readFileSync(join(tmp, "gz", "a", "b.txt")))).toEqual(ODD);
});
