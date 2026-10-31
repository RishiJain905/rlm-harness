// KV cache: none; the interface never touches the bytes sent to the model.
// The run logs for /runs: one summary and one byte range per line of every `<runsDir>/*/runs.jsonl`,
// newest first, and a read of one record by its range. The files are streamed, because a log holds
// every run's messages and can be large.

import { createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Mirrors the engine's `runlog.FORMAT_VERSION`; a record with another number is still listed. */
export const RUN_LOG_FORMAT = 1;

const MAX_RUNS = 200;
const PRUNE_AT = 2000; // keeps the working list small while a huge log streams past

export interface RunSummary {
  /** Absolute path of the runs.jsonl. */
  file: string;
  /** Byte offset of the line. */
  offset: number;
  /** Byte length of the line, without the newline. */
  length: number;
  runId: string;
  batch: string;
  format: number;
  /** Unix seconds (`started_at`), 0 when missing. */
  startedAt: number;
  mode: string;
  /** `provider/model`, or "" when missing. */
  root: string;
  costUsd: number;
  /** Length of the record's `turns`. */
  turns: number;
  /** The question (read mode) or the task (repo mode), "" when missing. */
  text: string;
  infraKind: string | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0; // the engine writes NaN as "nan"
}

function rootOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v !== "object" || v === null) return "";
  const { provider, model } = v as { provider?: unknown; model?: unknown };
  return typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : "";
}

/** Lenient: a record from another format version, or missing fields, still gets a summary. */
function summarize(record: Record<string, unknown>, file: string, offset: number, length: number): RunSummary {
  return {
    file,
    offset,
    length,
    runId: str(record.run_id),
    batch: str(record.batch),
    format: num(record.format),
    startedAt: num(record.started_at),
    mode: str(record.mode),
    root: rootOf(record.root),
    costUsd: num(record.cost_usd),
    turns: Array.isArray(record.turns) ? record.turns.length : 0,
    text: typeof record.question === "string" ? record.question : str(record.task),
    infraKind: typeof record.infra_kind === "string" ? record.infra_kind : null,
  };
}

function newestFirst(a: RunSummary, b: RunSummary): number {
  if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return b.offset - a.offset;
}

/** Calls `onLine` with each `\n`-separated line and its byte offset; a last line without `\n` is passed too. */
async function eachLine(file: string, onLine: (line: Buffer, offset: number) => void): Promise<void> {
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let lineStart = 0;
  for await (const chunk of createReadStream(file)) {
    const buf = chunk as Buffer;
    let from = 0;
    for (let nl = buf.indexOf(0x0a, from); nl >= 0; nl = buf.indexOf(0x0a, from)) {
      const piece = buf.subarray(from, nl);
      const line = pendingLength > 0 ? Buffer.concat([...pending, piece]) : piece;
      onLine(line, lineStart);
      lineStart += line.length + 1;
      pending = [];
      pendingLength = 0;
      from = nl + 1;
    }
    if (from < buf.length) {
      pending.push(buf.subarray(from));
      pendingLength += buf.length - from;
    }
  }
  if (pendingLength > 0) onLine(Buffer.concat(pending), lineStart);
}

/** The newest 200 runs of every `<runsDir>/*\/runs.jsonl`. A line that is not a JSON object (a torn one) is skipped. */
export async function listRuns(runsDir: string): Promise<RunSummary[]> {
  let folders: string[];
  try {
    folders = (await readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
  } catch {
    return [];
  }
  folders.sort();
  let found: RunSummary[] = [];
  for (const folder of folders) {
    const file = join(runsDir, folder, "runs.jsonl");
    try {
      await eachLine(file, (line, offset) => {
        if (line.length === 0) return;
        let record: unknown;
        try {
          record = JSON.parse(line.toString("utf8"));
        } catch {
          return; // torn, or not ours
        }
        if (typeof record !== "object" || record === null || Array.isArray(record)) return;
        found.push(summarize(record as Record<string, unknown>, file, offset, line.length));
        if (found.length >= PRUNE_AT) found = found.sort(newestFirst).slice(0, MAX_RUNS);
      });
    } catch {
      // no runs.jsonl in this folder, or it vanished or cannot be read
    }
  }
  return found.sort(newestFirst).slice(0, MAX_RUNS);
}

/** The record at `summary`'s byte range. Throws if the file changed since `listRuns`. */
export async function readRun(summary: RunSummary): Promise<object> {
  const { file, offset, length } = summary;
  const handle = await open(file, "r");
  let record: unknown;
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    if (bytesRead !== length) throw new Error("the file is shorter than when it was listed");
    record = JSON.parse(buf.toString("utf8"));
    if (typeof record !== "object" || record === null) throw new Error("the line is not a JSON object");
  } catch (err) {
    throw new Error(`cannot read the run record at byte ${offset} of ${file}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await handle.close();
  }
  return record as object;
}
