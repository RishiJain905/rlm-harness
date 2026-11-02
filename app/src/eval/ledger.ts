// KV cache: none
// `<home>/eval/ledger.jsonl` (v1 architecture §6.5, D-179): one line per `--go` of `rlmh eval` or
// `rlmh tune`, so the running total stays in sight of S-44's $30 cap.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evalDir } from "../paths.ts";

export const LEDGER_CAP_USD = 30;

export interface LedgerLine {
  date: string;
  what: "eval" | "tune";
  set: string;
  split: string;
  root: string;
  profile: string;
  runs: number;
  cost_usd: number;
  out: string;
}

export const ledgerPath = (home: string): string => join(evalDir(home), "ledger.jsonl");

/** One line, written with a single append. */
export function appendLedger(home: string, line: LedgerLine): void {
  mkdirSync(evalDir(home), { recursive: true });
  appendFileSync(ledgerPath(home), `${JSON.stringify(line)}\n`);
}

/** Every readable line, in order; torn or non-object lines are skipped, as RunLog.records skips them. */
export function readLedger(home: string): LedgerLine[] {
  let text: string;
  try {
    text = readFileSync(ledgerPath(home), "utf8");
  } catch {
    return [];
  }
  const out: LedgerLine[] = [];
  for (const chunk of text.split("\n")) {
    if (chunk.trim() === "") continue;
    try {
      const v = JSON.parse(chunk);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) out.push(v as LedgerLine);
    } catch {
      // a torn line
    }
  }
  return out;
}
