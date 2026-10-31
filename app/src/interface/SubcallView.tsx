// KV cache: none; the interface never touches the bytes sent to the model.
// The full view of one sub-call: status, model, the cell line that issued it, tokens, cost and
// time, then the prompt, the reasoning (when there is any) and the answer, which follows the
// stream until the user scrolls. Esc or q closes; Left/Right step to the previous or next row.

import { useInput } from "ink";
import { useState } from "react";
import { formatCost, formatDuration, formatTokens, wrapText } from "./format.ts";
import { Lines } from "./Lines.tsx";
import type { Block, SubcallRow } from "./store.ts";
import { rowSeconds, rowTokens, statusColor } from "./SubcallPanel.tsx";
import { paint, span, useTheme, type Line, type Theme } from "./theme.ts";

const WORDS: Record<SubcallRow["status"], string> = { queued: "queued", streaming: "streaming", done: "done", error: "err", rejected: "rej" };

/** "Issued by turn T, line L: <that line of the cell>", once the cell's code is known. */
export function issuedBy(row: SubcallRow, cellCode: Record<number, string>): string {
  const { turn, line } = row.origin;
  if (line === null) return `Issued by turn ${turn}, line unknown`;
  const text = cellCode[turn]?.split("\n")[line - 1]?.trim();
  return `Issued by turn ${turn}, line ${line}${text ? `: ${text}` : ""}`;
}

export function subcallViewLines(row: SubcallRow, block: Block | undefined, cellCode: Record<number, string>, now: number, width: number, theme: Theme): Line[] {
  const lines: Line[] = [];
  const wrap = (text: string, style: Omit<Line[number], "text"> = {}) => {
    for (const l of wrapText(text, width)) lines.push([span(l, style)]);
  };
  const id = row.subcallId === null ? "refused request" : `Sub-call #${String(row.subcallId).padStart(2, "0")}`;
  const where = block ? `  batch ${block.id}, call ${row.index + 1} of ${block.size}` : "";
  lines.push([span(`${id}  `, { bold: true }), span(WORDS[row.status], { bold: true, color: statusColor(theme, row.status) }), span(where, { dim: true })]);
  wrap(`model ${row.model ? `${row.model.provider}/${row.model.model}` : "--"}`);
  wrap(issuedBy(row, cellCode));
  if (row.status !== "rejected") {
    const u = row.usage;
    const t = rowTokens(row);
    const s = rowSeconds(row, now);
    const tokens = u
      ? `tokens in ${formatTokens(u.input_tokens)} (cached ${formatTokens(u.cache_read_tokens)})  out ${formatTokens(u.output_tokens)}  reasoning ${formatTokens(u.reasoning_tokens)}`
      : `tokens in ${t.input}  out ${t.output}`;
    wrap(`${tokens}  cost ${u ? formatCost(u.cost_usd) : "--"}  time ${s === null ? "--" : formatDuration(s)}`);
  }
  const section = (title: string) => {
    lines.push([]);
    lines.push([span(`${title} `, { bold: true }), span(theme.rule.repeat(Math.max(0, width - title.length - 1)), { dim: true })]);
  };
  section("Prompt");
  wrap(row.prompt || (row.status === "rejected" ? `(${row.promptChars} characters, not sent)` : "(not sent yet)"), { dim: !row.prompt });
  if (row.reasoning) {
    section("Reasoning");
    wrap(row.reasoning, { dim: true });
  }
  section(row.status === "rejected" ? "Refused" : "Answer");
  if (row.text) wrap(row.text);
  if (row.error) wrap(row.error, { color: paint(theme, row.status === "rejected" ? "yellow" : "red") });
  if (!row.text && !row.error) wrap(row.status === "done" ? "(empty answer)" : "(waiting)", { dim: true });
  return lines;
}

export function SubcallView(props: {
  row: SubcallRow;
  block: Block | undefined;
  cellCode: Record<number, string>;
  now: number;
  width: number;
  height: number;
  active: boolean;
  onClose(): void;
  onStep(dir: -1 | 1): void;
}) {
  const theme = useTheme();
  // null follows the stream (the tail); a number is a scroll position the user chose. The parent
  // keys this component by row, so stepping to another row starts it again.
  const [top, setTop] = useState<number | null>(null);
  const body = Math.max(1, props.height - 1);
  const lines = subcallViewLines(props.row, props.block, props.cellCode, props.now, props.width, theme);
  const max = Math.max(0, lines.length - body);
  const at = top === null ? max : Math.min(top, max);
  useInput(
    (input, key) => {
      if (key.escape || input === "q") props.onClose();
      else if (key.leftArrow) props.onStep(-1);
      else if (key.rightArrow) props.onStep(1);
      else if (key.upArrow) setTop(Math.max(0, at - 1));
      else if (key.downArrow) setTop(Math.min(max, at + 1));
      else if (key.pageUp) setTop(Math.max(0, at - body + 1));
      else if (key.pageDown) setTop(Math.min(max, at + body - 1));
      else if (key.end) setTop(null);
    },
    { isActive: props.active },
  );
  const footer: Line = [span("Esc or q closes  Up/Down scroll  Left/Right previous/next", { dim: true })];
  return <Lines lines={[...lines.slice(at, at + body), ...Array.from({ length: Math.max(0, body - (lines.length - at)) }, (): Line => []), footer]} height={props.height} width={props.width} />;
}
