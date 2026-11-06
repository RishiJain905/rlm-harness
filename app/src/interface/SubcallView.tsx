// KV cache: none; the interface never touches the bytes sent to the model.
// The full view of one sub-call: status, model, the cell line that issued it, tokens, cost and
// time, then the prompt, the reasoning (when there is any) and the answer, which follows the
// stream until the user scrolls. Esc or q closes; Left/Right step to the previous or next row.
// An rlm() child (D-160) shows its task, its turns' replies, its cells and its answer instead.

import { useInput } from "ink";
import { useState } from "react";
import { formatCost, formatDuration, formatTokens, wrapText } from "./format.ts";
import { Lines } from "./Lines.tsx";
import { issuedBy, type Block, type ChildInfo, type SubcallRow } from "./store.ts";
import { rowSeconds, rowTokens, statusColor, statusWord } from "./SubcallPanel.tsx";
import { paint, span, useTheme, type Line, type Theme } from "./theme.ts";

export { issuedBy };

export function subcallViewLines(row: SubcallRow, block: Block | undefined, cellCode: Record<number, string>, now: number, width: number, theme: Theme): Line[] {
  const lines: Line[] = [];
  const wrap = (text: string, style: Omit<Line[number], "text"> = {}) => {
    for (const l of wrapText(text, width)) lines.push([span(l, style)]);
  };
  const c = row.child;
  const id = c ? `rlm${c.id} child run` : row.subcallId === null ? "refused request" : `Sub-call #${String(row.subcallId).padStart(2, "0")}`;
  const where = c ? `  depth ${c.depth}, tools ${c.tools || "?"}` : block ? `  batch ${block.id}, call ${row.index + 1} of ${block.size}` : "";
  lines.push([span(`${id}  `, { bold: true }), span(statusWord(row), { bold: true, color: statusColor(theme, row.status) }), span(where, { dim: true })]);
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
  if (c) wrap(`turn ${c.turn}/${c.maxTurns}`);
  const section = (title: string) => {
    lines.push([]);
    lines.push([span(`${title} `, { bold: true }), span(theme.rule.repeat(Math.max(0, width - title.length - 1)), { dim: true })]);
  };
  if (c) {
    childSections(row, c, wrap, section, lines, width, theme);
    return lines;
  }
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

/** A child's task, reasoning, replies (each turn after its turn line), cells and answer. */
function childSections(
  row: SubcallRow,
  c: ChildInfo,
  wrap: (text: string, style?: Omit<Line[number], "text">) => void,
  section: (title: string) => void,
  lines: Line[],
  width: number,
  theme: Theme,
): void {
  section("Task");
  wrap(c.task || row.prompt || "(not known yet)", { dim: !(c.task || row.prompt) });
  if (row.reasoning) {
    section("Reasoning");
    wrap(row.reasoning, { dim: true });
  }
  section("Replies");
  if (row.text) wrap(row.text);
  else wrap("(waiting)", { dim: true });
  section("Cells");
  if (c.cells.length === 0) wrap("(none yet)", { dim: true });
  const gutter = `${theme.bar} `;
  for (const cell of c.cells) {
    lines.push([span(`turn ${cell.turn}`, { bold: true })]);
    if (cell.code !== null) for (const l of wrapText(cell.code, Math.max(1, width - gutter.length))) lines.push([span(gutter, { dim: true }), span(l, { color: paint(theme, "cyan") })]);
    if (cell.output) wrap(cell.output);
    if (cell.error) wrap(cell.error, { color: paint(theme, "red") });
  }
  section("Answer");
  if (c.done && row.status !== "error") wrap(c.answer === null || c.answer === undefined ? "(no answer)" : typeof c.answer === "string" ? c.answer : JSON.stringify(c.answer), { dim: c.answer === null || c.answer === undefined });
  if (row.error) wrap(row.error, { color: paint(theme, "red") });
  if (!c.done && !row.error) wrap("(waiting)", { dim: true });
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
